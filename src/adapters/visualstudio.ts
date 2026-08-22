import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Adapter, AdapterResult, CaptureOptions } from '../core/adapter.ts';
import { NO_CAPABILITIES } from '../core/adapter.ts';
import type { EditorInstance, ProjectManifest } from '../core/model.ts';
import { normalizePath, readTextFile } from '../platform/files.ts';
import { listProcesses, matchByExecutable, extractPathArguments } from '../platform/processes.ts';
import { visualStudioRoots } from '../platform/paths.ts';
import { describeWorkspace } from './generic.ts';

/**
 * Visual Studio (the Windows IDE, not VS Code).
 *
 * **The hard part, stated plainly.** Visual Studio's per-solution user state lives in a `.suo` file,
 * which is an OLE Compound File — a small filesystem-in-a-file, holding binary streams whose
 * internal formats are undocumented and version-specific. Parsing it properly means implementing
 * the compound-file container *and* reverse-engineering the streams inside, and the payoff would be
 * the open-document list. That is not a good trade for this project, and pretending otherwise by
 * scraping strings out of it would produce plausible-looking garbage.
 *
 * So this adapter is deliberately scoped to what it can read correctly:
 *
 * - **Solutions and projects.** `.sln` is a documented text format, and `.csproj`/`.vbproj`/
 *   `.fsproj`/`.vcxproj` are XML. Together they give the project graph, the target frameworks and
 *   every package reference — which is most of what an assistant needs to understand a .NET
 *   codebase.
 * - **Which solution is open**, from the running process's command line and from the recent-list
 *   that ships in the per-version private registry file.
 * - **Launch settings** from `Properties/launchSettings.json`, which says how the project runs.
 *
 * For live state — open documents, the caret, the debugger — the right answer is a Visual Studio
 * extension pushing to the ingest endpoint, exactly as the VS Code extension does. See
 * `docs/ADAPTERS.md`.
 */
export class VisualStudioAdapter implements Adapter {
  readonly id = 'visualstudio';
  readonly name = 'Visual Studio';
  readonly confidence = 'persisted' as const;
  readonly capabilities = { ...NO_CAPABILITIES, discovery: true, workspaces: true };

  async probe(): Promise<boolean> {
    if (process.platform !== 'win32') return false;
    return visualStudioRoots().some((root) => existsSync(root));
  }

  async capture(options: CaptureOptions): Promise<AdapterResult> {
    const warnings: string[] = [];
    const processes = await listProcesses();
    const running = matchByExecutable(processes, ['devenv']);

    const editor: EditorInstance = {
      adapter: this.id,
      name: 'Visual Studio',
      workspaces: [],
      documents: [],
      confidence: this.confidence,
    };

    if (running.length > 0) {
      const main = running[0]!;
      editor.pid = main.pid;
      editor.executable = main.name;
    }

    const roots = new Set<string>(options.roots ?? []);
    const solutions: string[] = [];

    // The command line names the solution directly when one was opened by double-clicking it,
    // which is how Visual Studio is normally started.
    for (const info of running) {
      for (const path of extractPathArguments(info.command)) {
        if (/\.slnx?$/i.test(path) && existsSync(path)) {
          solutions.push(normalizePath(path));
          roots.add(normalizePath(dirname(path)));
        }
      }
    }

    editor.version = await detectVersion();

    for (const root of [...roots].slice(0, 8)) {
      try {
        const workspace = await describeWorkspace(root, options);

        for (const solution of solutions.filter((path) => path.startsWith(root))) {
          const manifest = await readSolution(solution);
          if (manifest) (workspace.manifests ??= []).push(manifest);
        }
        const launch = await readLaunchSettings(root);
        if (launch) (workspace.manifests ??= []).push(launch);

        editor.workspaces.push(workspace);
      } catch (error) {
        warnings.push(`Visual Studio: could not read ${root}: ${error instanceof Error ? error.message : error}`);
      }
    }

    if (running.length > 0 && solutions.length === 0) {
      warnings.push(
        'Visual Studio is running but no solution path was on its command line; ' +
        'open-document state lives in a .suo compound file that this adapter deliberately does not parse',
      );
    }

    const found = editor.workspaces.length > 0 || running.length > 0;
    return {
      editors: found ? [editor] : [],
      warnings,
      detail: found
        ? `${editor.workspaces.length} solution folder(s)${running.length ? `, ${running.length} devenv process(es)` : ''}`
        : undefined,
    };
  }
}

/** Finds the newest installed version from the private-registry directory names. */
async function detectVersion(): Promise<string | undefined> {
  for (const root of visualStudioRoots()) {
    try {
      const entries = await readdir(root, { withFileTypes: true });
      // Directories are named like `17.0_abcdef12`; the leading number is the version.
      const versions = entries
        .filter((entry) => entry.isDirectory() && /^\d+\.\d+/.test(entry.name))
        .map((entry) => entry.name.split('_')[0]!)
        .sort((a, b) => Number(b) - Number(a));
      if (versions[0]) return versions[0];
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * Parses a `.sln` or `.slnx` file into a manifest listing its projects.
 *
 * Two formats, because Microsoft introduced `.slnx` (plain XML) as a replacement for the old
 * custom text format and both are in active use — a tool that handled only one would miss half of
 * the .NET solutions in existence right now.
 */
export async function readSolution(path: string): Promise<ProjectManifest | undefined> {
  const text = await readTextFile(path, 8 * 1024 * 1024);
  if (!text) return undefined;

  const manifest: ProjectManifest = {
    kind: path.endsWith('x') ? 'dotnet-solution-xml' : 'dotnet-solution',
    file: path,
    name: path.split('/').pop(),
  };

  const projects: Record<string, string> = {};

  if (path.toLowerCase().endsWith('.slnx')) {
    // `<Project Path="src/Thing/Thing.csproj" />`
    for (const match of text.matchAll(/<Project\s+Path="([^"]+)"/g)) {
      const projectPath = match[1]!;
      projects[projectPath.split(/[\\/]/).pop() ?? projectPath] = projectPath;
    }
  } else {
    // `Project("{GUID}") = "Name", "relative\path.csproj", "{GUID}"`
    for (const match of text.matchAll(/^Project\("\{[^}]+\}"\)\s*=\s*"([^"]+)",\s*"([^"]+)"/gm)) {
      projects[match[1]!] = match[2]!;
    }
  }

  if (Object.keys(projects).length > 0) manifest.dependencies = projects;
  return manifest;
}

/**
 * Reads `Properties/launchSettings.json`, which declares how a project is started under F5.
 *
 * Worth reading because it names the profiles, the URLs and the environment variables a project
 * expects — exactly the questions an assistant is asked when something will not start. Values are
 * left to the redactor rather than filtered here, since `ASPNETCORE_ENVIRONMENT=Development` is
 * useful and a connection string in the same block is not.
 */
async function readLaunchSettings(root: string): Promise<ProjectManifest | undefined> {
  const candidates = [join(root, 'Properties', 'launchSettings.json')];

  try {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        candidates.push(join(root, entry.name, 'Properties', 'launchSettings.json'));
      }
    }
  } catch {
    // Unreadable root; the direct candidate still stands.
  }

  for (const path of candidates.slice(0, 30)) {
    const text = await readTextFile(path);
    if (!text) continue;

    try {
      const json = JSON.parse(text) as { profiles?: Record<string, Record<string, unknown>> };
      const profiles = json.profiles ?? {};
      const scripts: Record<string, string> = {};

      for (const [name, profile] of Object.entries(profiles)) {
        const parts = [profile.commandName, profile.applicationUrl].filter(Boolean);
        scripts[name] = parts.join(' ') || 'launch profile';
      }
      if (Object.keys(scripts).length > 0) {
        return { kind: 'dotnet-launch', file: path, name: 'launchSettings.json', scripts };
      }
    } catch {
      continue;
    }
  }
  return undefined;
}
