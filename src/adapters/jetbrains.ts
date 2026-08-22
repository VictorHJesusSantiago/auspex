import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { Adapter, AdapterResult, CaptureOptions } from '../core/adapter.ts';
import { NO_CAPABILITIES } from '../core/adapter.ts';
import type { Breakpoint, EditorInstance, OpenDocument } from '../core/model.ts';
import { normalizePath, readTextFile } from '../platform/files.ts';
import { listProcesses, matchByExecutable, extractPathArguments } from '../platform/processes.ts';
import { JETBRAINS_PRODUCTS, jetBrainsConfigRoot, type JetBrainsProduct } from '../platform/paths.ts';
import { detectLanguage } from '../languages/registry.ts';
import { describeWorkspace } from './generic.ts';

/**
 * The JetBrains adapter — IntelliJ IDEA, WebStorm, PyCharm, Rider, GoLand, CLion, PhpStorm,
 * RubyMine, DataGrip, RustRover, Android Studio and the rest.
 *
 * As with the VS Code family, one adapter covers the whole product line because they are all the
 * same platform with a different name: every one of them writes the same XML into the same
 * directory layout, differing only in the product folder's name and its year-versioned suffix.
 *
 * **Why this adapter can do something the VS Code one cannot.** JetBrains stores its per-project
 * state as plain XML inside the project itself, in `.idea/workspace.xml`. That file records the
 * open editor tabs, the caret line and column in each, the selected run configuration and the
 * breakpoints — all of it readable, all of it documented by its own schema. So this adapter reports
 * cursor positions from disk, which the VS Code adapter genuinely cannot.
 *
 * The catch, and it is the reason the confidence is `session` rather than `live`: the IDE writes
 * that file when it feels like it — on a save, on a focus change, on exit — so the caret position
 * can be minutes stale. It is reported as what it is.
 */
export class JetBrainsAdapter implements Adapter {
  readonly id = 'jetbrains';
  readonly name = 'JetBrains IDEs';
  readonly confidence = 'session' as const;
  readonly capabilities = {
    ...NO_CAPABILITIES,
    discovery: true,
    workspaces: true,
    documents: true,
    cursor: true,
    debug: true,
    settings: true,
  };

  async probe(): Promise<boolean> {
    return existsSync(jetBrainsConfigRoot());
  }

  async capture(options: CaptureOptions): Promise<AdapterResult> {
    const warnings: string[] = [];
    const editors: EditorInstance[] = [];
    const processes = await listProcesses();

    let configDirs: string[] = [];
    try {
      configDirs = (await readdir(jetBrainsConfigRoot(), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch (error) {
      warnings.push(`could not list JetBrains config: ${error instanceof Error ? error.message : error}`);
    }

    for (const product of JETBRAINS_PRODUCTS) {
      // Directories are named `<Prefix><Year>.<Release>`, newest last alphabetically.
      const matching = configDirs.filter((name) => name.startsWith(product.prefix)).sort();
      const running = matchByExecutable(processes, product.executables);
      if (matching.length === 0 && running.length === 0) continue;

      try {
        const editor = await captureProduct(product, matching, running, options, warnings);
        if (editor) editors.push(editor);
      } catch (error) {
        warnings.push(`${product.name}: ${error instanceof Error ? error.message : error}`);
      }
    }

    return {
      editors,
      documents: editors.flatMap((editor) => editor.documents),
      warnings,
      detail: editors.length > 0
        ? editors.map((e) => `${e.name} (${e.workspaces.length} project(s), ${e.documents.length} tab(s))`).join('; ')
        : undefined,
    };
  }
}

async function captureProduct(
  product: JetBrainsProduct,
  configDirs: string[],
  running: Awaited<ReturnType<typeof listProcesses>>,
  options: CaptureOptions,
  warnings: string[],
): Promise<EditorInstance | undefined> {
  const editor: EditorInstance = {
    adapter: product.id,
    name: product.name,
    workspaces: [],
    documents: [],
    confidence: 'session',
  };

  const newest = configDirs[configDirs.length - 1];
  if (newest) editor.version = newest.slice(product.prefix.length) || undefined;

  if (running.length > 0) {
    const pids = new Set(running.map((info) => info.pid));
    const main = running.find((info) => !info.ppid || !pids.has(info.ppid)) ?? running[0]!;
    editor.pid = main.pid;
    editor.executable = main.name;
  }

  // -- Which projects are open. Three sources, in order of currency.
  const roots = new Set<string>(options.roots ?? []);

  for (const info of running) {
    for (const path of extractPathArguments(info.command)) {
      if (existsSync(join(path, '.idea'))) roots.add(normalizePath(path));
    }
  }
  if (newest) {
    for (const path of await readRecentProjects(join(jetBrainsConfigRoot(), newest))) {
      if (existsSync(join(path, '.idea'))) roots.add(path);
    }
  }

  const breakpoints: Breakpoint[] = [];

  for (const root of [...roots].slice(0, 10)) {
    try {
      const workspace = await describeWorkspace(root, options);
      editor.workspaces.push(workspace);

      const state = await readWorkspaceXml(join(root, '.idea', 'workspace.xml'), root);
      editor.documents.push(...state.documents);
      breakpoints.push(...state.breakpoints);

      if (state.runConfigurations.length > 0) {
        (workspace.manifests ??= []).push({
          kind: 'jetbrains',
          file: join(root, '.idea'),
          name: 'run configurations',
          scripts: Object.fromEntries(state.runConfigurations.map((c) => [c.name, c.type])),
        });
      }
    } catch (error) {
      warnings.push(`${product.name}: could not read ${root}: ${error instanceof Error ? error.message : error}`);
    }
  }

  if (breakpoints.length > 0) {
    editor.debug = { active: false, status: 'terminated', breakpoints };
  }

  const foundAnything = editor.workspaces.length > 0 || running.length > 0;
  return foundAnything ? editor : undefined;
}

/**
 * Reads the recent-projects list from `options/recentProjects.xml`.
 *
 * Paths there are stored with `$USER_HOME$` standing in for the home directory, which is JetBrains'
 * way of making a config file portable between machines. Expanding it is required, not cosmetic: an
 * unexpanded path matches nothing on disk.
 */
export async function readRecentProjects(configDir: string): Promise<string[]> {
  const candidates = [
    join(configDir, 'options', 'recentProjects.xml'),
    join(configDir, 'options', 'recentProjectDirectories.xml'),
  ];

  for (const path of candidates) {
    const xml = await readTextFile(path, 4 * 1024 * 1024);
    if (!xml) continue;

    const paths: string[] = [];
    for (const match of xml.matchAll(/<entry\s+key="([^"]+)"/g)) {
      const expanded = match[1]!.replace(/\$USER_HOME\$/g, homedir().replace(/\\/g, '/'));
      paths.push(normalizePath(expanded));
    }
    if (paths.length > 0) return paths.slice(0, 30);
  }
  return [];
}

export interface WorkspaceXmlState {
  documents: OpenDocument[];
  breakpoints: Breakpoint[];
  runConfigurations: Array<{ name: string; type: string }>;
}

/**
 * Parses `.idea/workspace.xml`, which is where JetBrains records what the user is actually doing.
 *
 * Parsed with targeted regular expressions rather than a full XML parser, and that is a considered
 * choice rather than laziness: the file is large (megabytes on a big project), most of it is
 * irrelevant, and the three elements that matter have a stable, simple shape. A general parser
 * would cost a dependency and a full DOM to reach four attributes.
 *
 * The three elements:
 * - `<file pinned=... >` inside `<component name="FileEditorManager">` — one per open tab, with a
 *   nested `<state line=... column=... />` giving the caret. This is the part no other on-disk
 *   source in any editor gives away.
 * - `<line-breakpoint>` inside the breakpoint manager — file, line, enabled, condition.
 * - `<configuration name=... type=... >` — the run/debug configurations, which say how the project
 *   is meant to be started.
 */
export async function readWorkspaceXml(path: string, root: string): Promise<WorkspaceXmlState> {
  const state: WorkspaceXmlState = { documents: [], breakpoints: [], runConfigurations: [] };
  const xml = await readTextFile(path, 32 * 1024 * 1024);
  if (!xml) return state;

  // -- Open tabs. `<file>` elements carry the URL; `<state>` inside carries the caret.
  const editorSection = section(xml, 'FileEditorManager') ?? xml;
  for (const match of editorSection.matchAll(/<file\b([^>]*)>([\s\S]*?)<\/file>/g)) {
    const attributes = match[1] ?? '';
    const body = match[2] ?? '';

    // The URL lives on the nested `<entry file="...">`, not on `<file>` itself. Both spellings are
    // accepted because older IDE versions wrote a `<url>` element instead, and a connector that
    // broke on a five-year-old project file would not be worth much.
    const url = attribute(body, 'file')
      ?? /<url>([^<]+)<\/url>/.exec(body)?.[1]
      ?? attribute(attributes, 'url');
    if (!url) continue;

    const filePath = expandProjectPath(url, root);
    if (!filePath) continue;

    const document: OpenDocument = {
      path: filePath,
      languageId: detectLanguage(filePath).id,
      dirty: false,
      active: /\bcurrent-in-tab="true"/.test(attributes) || /\bcurrent="true"/.test(attributes),
    };

    // The caret sits on a `<caret line=".." column=".." />` element inside the provider's state.
    // JetBrains counts lines from zero here, matching the LSP convention, so no adjustment is
    // needed -- worth stating, because the IDE's own status bar counts from one.
    const caret = /<caret([^>]*)>/.exec(body)?.[1] ?? body;
    const line = Number(attribute(caret, 'line'));
    const column = Number(attribute(caret, 'column'));
    if (Number.isFinite(line) && line >= 0) {
      document.cursor = { line, character: Number.isFinite(column) ? column : 0 };
    }
    state.documents.push(document);
  }

  // -- Breakpoints.
  for (const match of xml.matchAll(/<line-breakpoint\b([^>]*)>([\s\S]*?)<\/line-breakpoint>/g)) {
    const attributes = match[1] ?? '';
    const body = match[2] ?? '';
    const url = /<url>([^<]+)<\/url>/.exec(body)?.[1] ?? attribute(body, 'url');
    if (!url) continue;

    const filePath = expandProjectPath(url, root);
    if (!filePath) continue;

    const line = Number(/<line>(\d+)<\/line>/.exec(body)?.[1] ?? attribute(body, 'line'));
    const condition = /<condition[^>]*expression="([^"]*)"/.exec(body)?.[1];

    state.breakpoints.push({
      file: filePath,
      line: Number.isFinite(line) ? line : 0,
      enabled: !/\benabled="false"/.test(attributes),
      condition: condition || undefined,
    });
  }

  // -- Run configurations.
  for (const match of xml.matchAll(/<configuration\b([^>]*)/g)) {
    const attributes = match[1] ?? '';
    const name = attribute(attributes, 'name');
    const type = attribute(attributes, 'type');
    if (name && type) state.runConfigurations.push({ name, type });
    if (state.runConfigurations.length >= 40) break;
  }

  return state;
}

/** Extracts one `<component name="X">...</component>` body. */
function section(xml: string, componentName: string): string | undefined {
  const pattern = new RegExp(
    `<component\\s+name="${componentName}"[^>]*>([\\s\\S]*?)</component>`,
  );
  return pattern.exec(xml)?.[1];
}

/** Reads an attribute value out of an attribute string or an element body. */
function attribute(text: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(text)?.[1];
}

/**
 * Expands a JetBrains project URL to an absolute path.
 *
 * URLs look like `file://$PROJECT_DIR$/src/Main.java`, where `$PROJECT_DIR$` is the macro the IDE
 * uses so the file can be committed and still work on someone else's machine. Anything using a
 * macro this function does not know is skipped rather than guessed at, since a wrong path is worse
 * than a missing one.
 */
export function expandProjectPath(url: string, root: string): string | undefined {
  let path = url.replace(/^(file|jar):\/\//, '');
  if (path.includes('$PROJECT_DIR$')) {
    path = path.replace(/\$PROJECT_DIR\$/g, root);
  } else if (path.includes('$USER_HOME$')) {
    path = path.replace(/\$USER_HOME\$/g, homedir());
  } else if (path.includes('$')) {
    return undefined;
  }
  // A jar URL points inside an archive, which is not a file the user can be editing.
  if (path.includes('!/')) return undefined;
  return normalizePath(resolve(path));
}

/** Exported for tests: whether a directory looks like a JetBrains project. */
export async function isJetBrainsProject(root: string): Promise<boolean> {
  try {
    return (await stat(join(root, '.idea'))).isDirectory();
  } catch {
    return false;
  }
}

/** Exported for display: the product name a config directory belongs to. */
export function productForConfigDir(name: string): string | undefined {
  const product = JETBRAINS_PRODUCTS.find((candidate) => name.startsWith(candidate.prefix));
  return product ? `${product.name} ${name.slice(product.prefix.length)}`.trim() : basename(name);
}
