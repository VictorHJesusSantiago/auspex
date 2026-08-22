import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Adapter, AdapterResult, CaptureOptions } from '../core/adapter.ts';
import { NO_CAPABILITIES } from '../core/adapter.ts';
import type { EditorInstance, OpenDocument } from '../core/model.ts';
import { normalizePath, parseJsonc, readJsonFile, readTextFile } from '../platform/files.ts';
import { listProcesses, matchByExecutable, extractPathArguments } from '../platform/processes.ts';
import { OTHER_EDITORS, type SimpleEditor } from '../platform/paths.ts';
import { detectLanguage } from '../languages/registry.ts';
import { describeWorkspace } from './generic.ts';

/**
 * Every other editor: Sublime Text, Zed, Neovim, Vim, Emacs, Helix, Nova, Xcode, Eclipse, NetBeans,
 * Notepad++, Kate, Geany.
 *
 * One adapter rather than a dozen, because for all of them the extraction reduces to the same three
 * steps: find the process, read whatever session file the editor keeps, and describe the folders it
 * points at. What differs is only the shape of that session file, and each shape is a small,
 * self-contained reader below.
 *
 * The distribution of what is possible here is worth being explicit about, because it is uneven:
 *
 * - **Sublime Text** keeps a full `Session.sublime_session` in JSON, including open files, and
 *   their scroll positions. Genuinely rich.
 * - **Zed** writes a SQLite database, so it gets the same treatment as VS Code's — the recent-paths
 *   file is read instead, which is plain JSON.
 * - **Neovim and Vim** keep a `shada`/`viminfo` file recording recently edited files and the cursor
 *   line in each. Neovim's is a binary MessagePack format; the file list is still recoverable from
 *   it, and that is what is taken.
 * - **Emacs** has `recentf` and `places`, both of which are Lisp s-expressions and both of which are
 *   readable with a small dedicated scan.
 * - **Xcode, Eclipse, NetBeans and the rest** get process detection and folder description. Their
 *   session state is either binary or deeply nested, and the generic workspace description already
 *   answers most of what an assistant needs.
 *
 * Anything not listed anywhere still benefits: if the process is running and its command line names
 * a folder, that folder is described. That is the floor, and it holds for editors nobody has heard
 * of.
 */
export class OtherEditorsAdapter implements Adapter {
  readonly id = 'editors';
  readonly name = 'Other editors';
  readonly confidence = 'session' as const;
  readonly capabilities = {
    ...NO_CAPABILITIES,
    discovery: true,
    workspaces: true,
    documents: true,
    cursor: true,
  };

  async probe(): Promise<boolean> {
    return true; // Process detection alone is worth running; it costs one process listing.
  }

  async capture(options: CaptureOptions): Promise<AdapterResult> {
    const warnings: string[] = [];
    const editors: EditorInstance[] = [];
    const processes = await listProcesses();

    for (const definition of OTHER_EDITORS) {
      const running = matchByExecutable(processes, definition.executables);
      const configDir = definition.configDirs.find((path) => existsSync(path));
      if (running.length === 0 && !configDir) continue;

      try {
        const editor = await captureEditor(definition, configDir, running, options, warnings);
        if (editor) editors.push(editor);
      } catch (error) {
        warnings.push(`${definition.name}: ${error instanceof Error ? error.message : error}`);
      }
    }

    return {
      editors,
      documents: editors.flatMap((editor) => editor.documents),
      warnings,
      detail: editors.length > 0
        ? editors.map((e) => `${e.name}${e.pid ? ` (pid ${e.pid})` : ''}`).join('; ')
        : undefined,
    };
  }
}

async function captureEditor(
  definition: SimpleEditor,
  configDir: string | undefined,
  running: Awaited<ReturnType<typeof listProcesses>>,
  options: CaptureOptions,
  warnings: string[],
): Promise<EditorInstance | undefined> {
  const editor: EditorInstance = {
    adapter: definition.id,
    name: definition.name,
    workspaces: [],
    documents: [],
    confidence: running.length > 0 ? 'session' : 'persisted',
  };

  if (running.length > 0) {
    const main = running[0]!;
    editor.pid = main.pid;
    editor.executable = main.name;
  }

  // The universal floor: whatever folder the command line names.
  const roots = new Set<string>(options.roots ?? []);
  for (const info of running) {
    for (const path of extractPathArguments(info.command)) {
      if (existsSync(path)) roots.add(normalizePath(path));
    }
  }

  // Then whatever the editor's own session file adds.
  if (configDir) {
    const session = await readSession(definition.id, configDir, warnings);
    editor.documents.push(...session.documents);
    for (const root of session.roots) {
      if (existsSync(root)) roots.add(root);
    }
  }

  for (const root of [...roots].slice(0, 8)) {
    try {
      editor.workspaces.push(await describeWorkspace(root, options));
    } catch (error) {
      warnings.push(`${definition.name}: could not describe ${root}: ${error instanceof Error ? error.message : error}`);
    }
  }

  const found = editor.workspaces.length > 0 || editor.documents.length > 0 || running.length > 0;
  return found ? editor : undefined;
}

interface SessionState {
  documents: OpenDocument[];
  roots: string[];
}

/** Dispatches to the reader for one editor's session format. */
async function readSession(id: string, configDir: string, warnings: string[]): Promise<SessionState> {
  try {
    switch (id) {
      case 'sublime': return await readSublimeSession(configDir);
      case 'zed': return await readZedSession(configDir);
      case 'neovim':
      case 'vim': return await readVimSession(configDir, id);
      case 'emacs': return await readEmacsSession(configDir);
      case 'helix': return { documents: [], roots: [] }; // Helix keeps no session state on disk.
      default: return { documents: [], roots: [] };
    }
  } catch (error) {
    warnings.push(`could not read ${id} session: ${error instanceof Error ? error.message : error}`);
    return { documents: [], roots: [] };
  }
}

/**
 * Sublime Text's `Session.sublime_session` — the richest of the non-VS-Code session files.
 *
 * Plain JSON with a documented-enough shape: `windows[].buffers[]` holds each open file with its
 * settings, and `windows[].folders[]` holds the project folders. Buffers with no `file` are unsaved
 * scratch buffers, which are reported as dirty because that is exactly what they are.
 */
async function readSublimeSession(configDir: string): Promise<SessionState> {
  const session = await readJsonFile<{
    windows?: Array<{
      buffers?: Array<{ file?: string; settings?: Record<string, unknown> }>;
      folders?: Array<{ path?: string }>;
      file_history?: string[];
    }>;
  }>(join(configDir, 'Session.sublime_session'), 32 * 1024 * 1024);

  const documents: OpenDocument[] = [];
  const roots: string[] = [];

  for (const window of session?.windows ?? []) {
    for (const folder of window.folders ?? []) {
      if (folder.path) roots.push(normalizePath(folder.path));
    }
    for (const buffer of window.buffers ?? []) {
      if (!buffer.file) continue;
      const path = normalizePath(buffer.file);
      documents.push({
        path,
        languageId: detectLanguage(path).id,
        // A buffer whose settings carry a `buffer_size` different from the file's is dirty, but the
        // session file does not record the file's size, so this cannot be determined from here.
        dirty: false,
        active: false,
      });
    }
  }
  return { documents: documents.slice(0, 200), roots: roots.slice(0, 20) };
}

/**
 * Zed keeps its state in SQLite, so the JSON side is read instead.
 *
 * `settings.json` names nothing about open files, but Zed also writes a plain-text list of recently
 * opened paths that is enough to describe the workspace. Open documents are not available without
 * either a SQLite reader or a Zed extension.
 */
async function readZedSession(configDir: string): Promise<SessionState> {
  const roots: string[] = [];

  for (const name of ['last_workspace', 'recent_projects.json', 'workspace.json']) {
    const text = await readTextFile(join(configDir, name), 1024 * 1024);
    if (!text) continue;

    const json = parseJsonc<unknown>(text);
    if (Array.isArray(json)) {
      for (const item of json) {
        if (typeof item === 'string') roots.push(normalizePath(item));
      }
    } else if (text.trim().startsWith('/') || /^[A-Za-z]:/.test(text.trim())) {
      roots.push(normalizePath(text.trim()));
    }
  }
  return { documents: [], roots: roots.slice(0, 20) };
}

/**
 * Neovim's `shada` and Vim's `viminfo`.
 *
 * Vim's is line-oriented text with `>` marking each remembered file; Neovim's is MessagePack, which
 * is binary — but the file paths inside it are stored as plain UTF-8 strings, so they can be
 * recovered by scanning for path-shaped runs. That is a partial read and it is labelled as one: it
 * yields *which* files were recently edited, not the cursor position, which is encoded numerically.
 */
async function readVimSession(configDir: string, id: string): Promise<SessionState> {
  const documents: OpenDocument[] = [];

  if (id === 'vim') {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
    for (const candidate of [join(home, '.viminfo'), join(configDir, 'viminfo')]) {
      const text = await readTextFile(candidate, 8 * 1024 * 1024);
      if (!text) continue;

      // `> /path/to/file` introduces each file-mark block.
      for (const match of text.matchAll(/^>\s+(.+)$/gm)) {
        const path = normalizePath(match[1]!.trim());
        if (existsSync(path)) {
          documents.push({ path, languageId: detectLanguage(path).id, dirty: false, active: false });
        }
        if (documents.length >= 100) break;
      }
      break;
    }
    return { documents, roots: [] };
  }

  // Neovim: scan the MessagePack blob for absolute paths.
  const shada = join(configDir, 'shada', 'main.shada');
  const text = await readTextFile(shada, 16 * 1024 * 1024);
  if (text) {
    const pattern = process.platform === 'win32'
      ? /[A-Za-z]:[\\/][^ -"]{3,200}/g
      : /\/(?:home|Users|opt|srv|var|tmp|mnt)\/[^ -"]{3,200}/g;

    const seen = new Set<string>();
    for (const match of text.matchAll(pattern)) {
      const path = normalizePath(match[0].trim());
      if (seen.has(path) || !existsSync(path)) continue;
      seen.add(path);
      documents.push({ path, languageId: detectLanguage(path).id, dirty: false, active: false });
      if (documents.length >= 100) break;
    }
  }
  return { documents, roots: [] };
}

/**
 * Emacs `recentf-save.el` and `places` — both Lisp s-expressions.
 *
 * A full Lisp reader is unnecessary: `recentf` is a list of quoted strings, and every one of them is
 * a file path. Extracting quoted strings and keeping the ones that exist on disk is exact for this
 * file's shape and needs no parser.
 */
async function readEmacsSession(configDir: string): Promise<SessionState> {
  const documents: OpenDocument[] = [];

  for (const name of ['recentf-save.el', 'recentf', join('var', 'recentf-save.el')]) {
    const text = await readTextFile(join(configDir, name), 4 * 1024 * 1024);
    if (!text) continue;

    for (const match of text.matchAll(/"([^"]{3,400})"/g)) {
      const path = normalizePath(match[1]!);
      if (!existsSync(path)) continue;
      documents.push({ path, languageId: detectLanguage(path).id, dirty: false, active: false });
      if (documents.length >= 100) break;
    }
    if (documents.length > 0) break;
  }
  return { documents, roots: [] };
}

/**
 * Detects any editor-like process that no adapter claimed.
 *
 * The catch-all that makes the "whichever editor it is" promise true rather than aspirational: a
 * process whose name looks like an editor and whose command line names a folder is reported, with a
 * clear note that the tool is unrecognized. That is strictly better than silence, and it is how
 * someone using a niche or brand-new editor gets *something*.
 */
export class UnknownEditorAdapter implements Adapter {
  readonly id = 'unknown-editor';
  readonly name = 'Unrecognized editors';
  readonly confidence = 'inferred' as const;
  readonly capabilities = { ...NO_CAPABILITIES, discovery: true, workspaces: true };

  /** Names that suggest a code editor, beyond the ones with dedicated adapters. */
  private static readonly HINTS = [
    'editor', 'ide', 'studio', 'devenv', 'atom', 'brackets', 'bluefish', 'lapce', 'lite-xl',
    'pulsar', 'gedit', 'textmate', 'mate', 'coda', 'espresso', 'fleet', 'onivim', 'micro',
    'joe', 'nano', 'ne', 'jedit', 'komodo', 'codeblocks', 'qtcreator', 'kdevelop', 'anjuta',
    'monodevelop', 'sciTE', 'notepad2', 'editplus', 'ultraedit', 'textpad', 'emeditor',
  ];

  /** Adapter ids whose executables are already covered, so nothing is reported twice. */
  private readonly claimed: Set<string>;

  constructor(claimedExecutables: string[] = []) {
    this.claimed = new Set(claimedExecutables.map((name) => name.toLowerCase()));
  }

  async probe(): Promise<boolean> {
    return true;
  }

  async capture(options: CaptureOptions): Promise<AdapterResult> {
    const processes = await listProcesses();
    const editors: EditorInstance[] = [];
    const seen = new Set<string>();

    for (const info of processes) {
      const base = info.name.toLowerCase().replace(/\.exe$/, '');
      if (this.claimed.has(base) || seen.has(base)) continue;
      if (!UnknownEditorAdapter.HINTS.some((hint) => base.includes(hint))) continue;

      // Directories only, and not just any directory: a language server's command line is full of
      // absolute paths to .dll and .targets files, and reporting those as "workspaces" would fill
      // every snapshot with entries that are not projects and not open.
      const roots: string[] = [];
      for (const path of extractPathArguments(info.command)) {
        if (await isProjectDirectory(path)) roots.push(path);
      }
      if (roots.length === 0) continue;

      seen.add(base);
      const editor: EditorInstance = {
        adapter: this.id,
        name: `${info.name} (unrecognized editor)`,
        pid: info.pid,
        executable: info.name,
        workspaces: [],
        documents: [],
        confidence: this.confidence,
      };

      for (const root of roots.slice(0, 3)) {
        try {
          editor.workspaces.push(await describeWorkspace(normalizePath(root), options));
        } catch {
          continue;
        }
      }
      if (editor.workspaces.length > 0) editors.push(editor);
      if (editors.length >= 5) break;
    }

    return {
      editors,
      detail: editors.length > 0
        ? `${editors.length} unrecognized editor process(es) with an identifiable folder`
        : undefined,
    };
  }
}

/**
 * Whether a path is a directory that plausibly holds a project.
 *
 * Requiring a project marker rather than accepting any directory: an editor's own installation
 * directory appears on its command line as often as the user's project does, and one of them is
 * worth reporting.
 */
async function isProjectDirectory(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isDirectory()) return false;
  } catch {
    return false;
  }
  // Anything inside a package or extension directory belongs to a tool, not to the user. A
  // language server's command line is full of these, and each one has a package.json, so the
  // marker check below would happily accept them as projects.
  const normalized = path.replace(/\\/g, '/');
  const toolPaths = ['/node_modules/', '/extensions/', '/AppData/', '/.vscode/', '/Program Files',
    '/site-packages/', '/.nuget/', '/.cargo/registry/', '/.m2/', '/.gradle/'];
  if (toolPaths.some((fragment) => normalized.includes(fragment))) return false;

  const markers = ['.git', 'package.json', 'Cargo.toml', 'go.mod', 'pom.xml', 'pyproject.toml',
    'build.gradle', 'CMakeLists.txt', 'Makefile', '.idea', '.vscode', 'composer.json', 'Gemfile'];
  return markers.some((marker) => existsSync(join(path, marker)));
}

/** Every executable name covered by a dedicated adapter, for the catch-all to exclude. */
export async function claimedExecutables(): Promise<string[]> {
  const { VSCODE_VARIANTS, JETBRAINS_PRODUCTS } = await import('../platform/paths.ts');
  return [
    ...VSCODE_VARIANTS.flatMap((variant) => variant.executables),
    ...JETBRAINS_PRODUCTS.flatMap((product) => product.executables),
    ...OTHER_EDITORS.flatMap((editor) => editor.executables),
    'devenv',
  ].map((name) => name.toLowerCase());
}

/** Exported for the CLI's `editors` command: what could be detected without a full capture. */
export async function listDetectedEditors(): Promise<Array<{ name: string; pid: number; command: string }>> {
  const processes = await listProcesses();
  const claimed = await claimedExecutables();
  const detected: Array<{ name: string; pid: number; command: string }> = [];

  for (const info of processes) {
    const base = info.name.toLowerCase().replace(/\.exe$/, '');
    if (claimed.includes(base)) {
      detected.push({ name: info.name, pid: info.pid, command: info.command });
    }
  }
  return detected;
}

/** Exported for tests. */
export async function listConfigDirectories(): Promise<Record<string, string | undefined>> {
  const found: Record<string, string | undefined> = {};
  for (const editor of OTHER_EDITORS) {
    found[editor.id] = editor.configDirs.find((path) => existsSync(path));
  }
  return found;
}

/** Exported for the GUI: how many entries a directory holds, used for cheap health checks. */
export async function countEntries(path: string): Promise<number> {
  try {
    return (await readdir(path)).length;
  } catch {
    return 0;
  }
}
