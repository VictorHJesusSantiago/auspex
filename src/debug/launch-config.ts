import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseJsonc, normalizePath, readTextFile } from '../platform/files.ts';
import { adapterById, adaptersForLanguage, type KnownAdapter } from './registry.ts';

/**
 * Finding out how a project is actually debugged, and turning that into a proxy command.
 *
 * Deep capture requires the user to put Auspex between their editor and its debug adapter. That is
 * a one-line change, and it is the single hardest step in the whole tool — not because it is
 * complicated, but because **the user usually does not know what their editor runs.** VS Code
 * launches adapters out of extension directories with generated arguments; the command never
 * appears anywhere a person would look. Telling someone to "point the editor at Auspex instead of
 * the adapter" without saying what the adapter *is* is close to useless advice.
 *
 * So this module reads the launch configurations a project already has — `.vscode/launch.json`,
 * JetBrains run configurations, `.idea/workspace.xml` — works out which adapter each one implies,
 * and produces the exact configuration to paste back. What it cannot determine, it says so about
 * explicitly rather than emitting a plausible command that will not work.
 */

export interface LaunchConfiguration {
  /** The configuration's own name, as it appears in the editor's run menu. */
  name: string;
  /** The DAP adapter type: `debugpy`, `node`, `coreclr`, `go`, `lldb`. */
  type: string;
  /** `launch` or `attach`. */
  request: string;
  /** Where this was read from. */
  source: string;
  /** The editor family it belongs to. */
  editor: 'vscode' | 'jetbrains' | 'unknown';
  /** The program or module it runs, when the configuration names one. */
  program?: string;
  cwd?: string;
  args?: string[];
  /** Everything else, verbatim and redacted by the caller. */
  raw: Record<string, unknown>;
  /** What Auspex knows about this adapter, when it recognizes the type. */
  adapter?: KnownAdapter;
}

/** A ready-to-use way of getting Auspex into a debug session. */
export interface WiringInstruction {
  configuration: string;
  /** How confident this is: `exact` when the adapter command is known, `pattern` when it is a shape. */
  confidence: 'exact' | 'pattern' | 'manual';
  /** The shell command that runs the proxy, when one can be given. */
  command?: string;
  /** A launch.json fragment that routes the editor through Auspex, when the adapter supports it. */
  snippet?: string;
  /** Why this is the answer, or why there is not a better one. */
  explanation: string;
}

/**
 * Reads every launch configuration a workspace defines.
 *
 * Never throws: a project with no configurations, an unreadable file or malformed JSON all produce
 * an empty list, because "I could not find how you debug this" is a fine answer and a crash is not.
 */
export async function findLaunchConfigurations(root: string): Promise<LaunchConfiguration[]> {
  const found: LaunchConfiguration[] = [];

  found.push(...await readVsCodeLaunch(root));
  found.push(...await readJetBrainsRunConfigurations(root));

  return found;
}

/**
 * `.vscode/launch.json`, which is JSON with comments and trailing commas.
 *
 * Parsed through the project's existing JSONC reader rather than `JSON.parse`, because the file
 * VS Code generates for a new project contains comments by default — a strict parse would fail on
 * the single most common case.
 */
async function readVsCodeLaunch(root: string): Promise<LaunchConfiguration[]> {
  const results: LaunchConfiguration[] = [];

  // Both the workspace file and the per-folder one, since a multi-root workspace uses the former.
  for (const relative of ['.vscode/launch.json', 'launch.json']) {
    const path = join(root, relative);
    const text = await readTextFile(path, 512 * 1024);
    if (!text) continue;

    const parsed = parseJsonc<{ configurations?: unknown[]; compounds?: unknown[] }>(text);
    const configurations = Array.isArray(parsed?.configurations) ? parsed.configurations : [];

    for (const item of configurations) {
      const record = item as Record<string, unknown>;
      const type = String(record.type ?? '');
      if (!type) continue;

      results.push({
        name: String(record.name ?? type),
        type,
        request: String(record.request ?? 'launch'),
        source: normalizePath(path),
        editor: 'vscode',
        program: asText(record.program) ?? asText(record.module) ?? asText(record.url),
        cwd: asText(record.cwd),
        args: Array.isArray(record.args) ? record.args.map(String) : undefined,
        raw: record,
        adapter: adapterById(type),
      });
    }
  }
  return results;
}

/**
 * JetBrains run configurations: `.idea/runConfigurations/*.xml` and `.run/*.xml`.
 *
 * JetBrains does not use DAP internally — its debuggers are built in — so these do not name an
 * adapter the way `launch.json` does. They are still worth reading: they say what the project runs
 * and in which language, which is enough to recommend the right adapter, and they are often the
 * only machine-readable statement of how a project is meant to be started.
 */
async function readJetBrainsRunConfigurations(root: string): Promise<LaunchConfiguration[]> {
  const results: LaunchConfiguration[] = [];

  for (const directory of ['.idea/runConfigurations', '.run']) {
    let names: string[];
    try {
      names = await readdir(join(root, directory));
    } catch {
      continue;
    }

    for (const name of names) {
      if (!name.endsWith('.xml')) continue;
      const path = join(root, directory, name);
      const text = await readTextFile(path, 256 * 1024);
      if (!text) continue;

      const configuration = /<configuration\b([^>]*)>/.exec(text);
      if (!configuration) continue;

      const attributes = configuration[1] ?? '';
      const typeAttribute = /type="([^"]+)"/.exec(attributes)?.[1] ?? '';

      results.push({
        name: /name="([^"]+)"/.exec(attributes)?.[1] ?? name.replace(/\.xml$/, ''),
        // JetBrains type names are its own vocabulary (`PythonConfigurationType`, `Application`),
        // mapped to a DAP adapter where the mapping is unambiguous and left alone where it is not.
        type: jetBrainsTypeToAdapter(typeAttribute),
        request: 'launch',
        source: normalizePath(path),
        editor: 'jetbrains',
        program: /name="SCRIPT_NAME" value="([^"]+)"/.exec(text)?.[1]
          ?? /name="MAIN_CLASS_NAME" value="([^"]+)"/.exec(text)?.[1],
        cwd: /name="WORKING_DIRECTORY" value="([^"]+)"/.exec(text)?.[1],
        raw: { jetbrainsType: typeAttribute },
        adapter: adapterById(jetBrainsTypeToAdapter(typeAttribute)),
      });
    }
  }
  return results;
}

/** Maps JetBrains' own configuration types onto DAP adapter ids where the mapping is certain. */
function jetBrainsTypeToAdapter(type: string): string {
  const table: Record<string, string> = {
    PythonConfigurationType: 'debugpy',
    'Python.Tests.pytest': 'debugpy',
    NodeJSConfigurationType: 'node',
    'js.build_tools.npm': 'node',
    Application: 'java',
    SpringBootApplicationConfigurationType: 'java',
    JUnit: 'java',
    GoApplicationRunConfiguration: 'go',
    'CMake Application': 'cppdbg',
    CargoCommandRunConfiguration: 'lldb',
    DotNetProject: 'coreclr',
    PhpLocalRunConfigurationType: 'php',
    RubyRunConfigurationType: 'ruby_lsp',
  };
  return table[type] ?? type;
}

/**
 * Turns a configuration into instructions for wiring Auspex in.
 *
 * The honesty here matters more than the coverage. Three outcomes, and each is labelled:
 *
 * - **exact** — the adapter runs as a real command (`dlv dap`, `python -m debugpy.adapter`), so the
 *   proxy invocation is copy-and-paste and will work.
 * - **pattern** — the adapter lives inside an editor extension with generated arguments. Auspex can
 *   say which extension and what to look for, but not the literal command, because it genuinely
 *   varies by version and platform.
 * - **manual** — an unrecognized adapter. What to do is stated in general terms.
 *
 * Emitting a confident-looking command for the `pattern` case would be worse than useless: it would
 * fail in a way the user would reasonably blame on themselves.
 */
export function wiringFor(
  configuration: LaunchConfiguration,
  auspexCommand = 'auspex',
): WiringInstruction {
  const adapter = configuration.adapter;

  if (adapter?.command) {
    const parts = [adapter.command.program, ...adapter.command.args].join(' ');
    return {
      configuration: configuration.name,
      confidence: 'exact',
      command: `${auspexCommand} proxy --dap --deep -- ${parts}`,
      explanation:
        `${adapter.name} runs as a real command, so Auspex can wrap it directly. Start the proxy ` +
        `with this, then point the "${configuration.name}" configuration at the proxy's stdio ` +
        `instead of launching the adapter itself.` +
        (adapter.command.install ? ` If the adapter is missing: ${adapter.command.install}` : ''),
    };
  }

  if (adapter?.extensionHint) {
    return {
      configuration: configuration.name,
      confidence: 'pattern',
      snippet: JSON.stringify({
        name: `${configuration.name} (through Auspex)`,
        type: configuration.type,
        request: configuration.request,
        debugServer: 4711,
      }, null, 2),
      explanation:
        `${adapter.name} is shipped inside the "${adapter.extensionHint}" extension and is started ` +
        'with generated arguments, so there is no fixed command to wrap. Use the socket proxy ' +
        'instead: run `' + auspexCommand + ' proxy --dap --deep --port 4711 --target <adapter port>` ' +
        'and add `"debugServer": 4711` to the configuration, which tells the editor to speak to a ' +
        'port rather than spawn the adapter. The exact adapter command varies by extension version ' +
        'and platform, which is why one is not printed here.',
    };
  }

  return {
    configuration: configuration.name,
    confidence: 'manual',
    explanation:
      `The adapter type "${configuration.type}" is not one Auspex recognizes, which does not mean ` +
      'it will not work — deep capture is protocol-level and adapter-agnostic. Find the command ' +
      'your editor runs for this configuration and put `' + auspexCommand + ' proxy --dap --deep --` ' +
      'in front of it.',
  };
}

/**
 * Recommends how to debug a project that has no launch configuration at all.
 *
 * The common case for a new project, and the one where a tool that only reads existing config has
 * nothing to say. Recommending by language is a weaker answer than reading a real configuration,
 * and it is labelled as such, but it is far better than silence.
 */
export function recommendAdapters(languageIds: string[]): Array<{ language: string; adapters: KnownAdapter[] }> {
  const seen = new Set<string>();
  const recommendations: Array<{ language: string; adapters: KnownAdapter[] }> = [];

  for (const language of languageIds) {
    if (seen.has(language)) continue;
    seen.add(language);

    const adapters = adaptersForLanguage(language);
    if (adapters.length > 0) recommendations.push({ language, adapters });
  }
  return recommendations;
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
