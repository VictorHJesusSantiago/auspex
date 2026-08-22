import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Adapter, AdapterResult, CaptureOptions } from '../core/adapter.ts';
import { NO_CAPABILITIES } from '../core/adapter.ts';
import type { EditorInstance, OpenDocument, Workspace } from '../core/model.ts';
import { normalizePath, readJsonFile, readTextFile } from '../platform/files.ts';
import { listProcesses, matchByExecutable, extractPathArguments } from '../platform/processes.ts';
import { VSCODE_VARIANTS, vsCodeUserDataRoots, type VsCodeVariant } from '../platform/paths.ts';
import { detectLanguage } from '../languages/registry.ts';
import { describeWorkspace } from './generic.ts';

/**
 * The VS Code family adapter — VS Code, Insiders, VSCodium, Cursor, Windsurf, Trae, Positron.
 *
 * One adapter covers all of them because they are all the same program with a different folder
 * name: every fork inherited the storage layout unchanged, so the only per-product difference is a
 * string in `platform/paths.ts`. Enumerating them as data rather than as code is what makes
 * supporting the next fork a one-line change.
 *
 * **Where the state actually lives**, which is most of what this adapter knows:
 *
 * - `User/globalStorage/state.vscdb` — a SQLite database holding the window state, including which
 *   editors are open in which group. This is the richest source and the awkward one; see
 *   {@link readStateDatabase} for how it is read without a SQLite dependency.
 * - `User/globalStorage/storage.json` — the list of recently opened folders and workspaces. Plain
 *   JSON, always present, and the most reliable statement of what the user works on.
 * - `User/settings.json`, `keybindings.json` — JSONC, and full of comments in any real install,
 *   which is why the JSONC-tolerant reader exists.
 * - `User/workspaceStorage/<hash>/workspace.json` — one directory per workspace ever opened, each
 *   naming the folder it belongs to.
 * - `<workspace>/.vscode/{settings,launch,tasks,extensions}.json` — per-project configuration,
 *   which says how the project is meant to be run and debugged.
 *
 * **The honest limit**: none of this includes the caret position or unsaved buffer contents. VS
 * Code keeps those in memory and in an opaque backup format, and the supported way to read them is
 * an extension running inside the editor — which is why `extensions/vscode` exists and why this
 * adapter reports `session` rather than `live` confidence.
 */
export class VsCodeAdapter implements Adapter {
  readonly id = 'vscode';
  readonly name = 'VS Code family';
  readonly confidence = 'session' as const;
  readonly capabilities = {
    ...NO_CAPABILITIES,
    discovery: true,
    workspaces: true,
    documents: true,
    extensions: true,
    settings: true,
  };

  async probe(): Promise<boolean> {
    for (const variant of VSCODE_VARIANTS) {
      for (const root of vsCodeUserDataRoots(variant)) {
        if (existsSync(root)) return true;
      }
    }
    return false;
  }

  async capture(options: CaptureOptions): Promise<AdapterResult> {
    const warnings: string[] = [];
    const editors: EditorInstance[] = [];
    const processes = await listProcesses();

    for (const variant of VSCODE_VARIANTS) {
      const root = vsCodeUserDataRoots(variant).find((candidate) => existsSync(candidate));
      if (!root) continue;

      try {
        const editor = await captureVariant(variant, root, processes, options, warnings);
        if (editor) editors.push(editor);
      } catch (error) {
        warnings.push(`${variant.name}: ${error instanceof Error ? error.message : error}`);
      }
    }

    return {
      editors,
      documents: editors.flatMap((editor) => editor.documents),
      warnings,
      detail: editors.length > 0
        ? editors.map((e) => `${e.name} (${e.workspaces.length} workspace(s), ${e.documents.length} document(s))`).join('; ')
        : undefined,
    };
  }
}

async function captureVariant(
  variant: VsCodeVariant,
  userDataRoot: string,
  processes: Awaited<ReturnType<typeof listProcesses>>,
  options: CaptureOptions,
  warnings: string[],
): Promise<EditorInstance | undefined> {
  const running = matchByExecutable(processes, variant.executables);

  const editor: EditorInstance = {
    adapter: variant.id,
    name: variant.name,
    workspaces: [],
    documents: [],
    confidence: 'session',
  };

  if (running.length > 0) {
    // The main process is the one with no parent among the matched set; helper and renderer
    // processes all descend from it, and reporting six PIDs for one window would be noise.
    const pids = new Set(running.map((info) => info.pid));
    const main = running.find((info) => !info.ppid || !pids.has(info.ppid)) ?? running[0]!;
    editor.pid = main.pid;
    editor.executable = main.name;
  }

  editor.version = await readVersion(userDataRoot);

  // -- Which folders are open. Two independent sources, deliberately combined.
  const roots = new Set<string>(options.roots ?? []);

  // The command line is the most current statement there is: fixed at launch, never stale.
  for (const info of running) {
    for (const path of extractPathArguments(info.command)) {
      if (await isDirectory(path)) roots.add(normalizePath(path));
    }
  }

  // The recent list covers windows restored from a previous session, which have no folder argument
  // on their command line at all -- the common case for someone who just reopens their editor.
  const recent = await readRecentlyOpened(userDataRoot);
  if (running.length > 0) {
    for (const path of recent.slice(0, 8)) {
      // Directories only. The recent list mixes folders with individual files, and describing a
      // single .js file as a "workspace" would put a meaningless entry in every snapshot.
      if (await isDirectory(path)) roots.add(path);
    }
  }

  for (const root of roots) {
    try {
      const workspace = await describeWorkspace(root, options);
      await attachWorkspaceSettings(workspace, warnings);
      editor.workspaces.push(workspace);
    } catch (error) {
      warnings.push(`${variant.name}: could not describe ${root}: ${error instanceof Error ? error.message : error}`);
    }
  }

  // -- Which documents are open.
  const documents = await readOpenDocuments(userDataRoot, warnings);
  editor.documents = documents;

  // -- Settings and extensions.
  const settings = await readJsonFile<Record<string, unknown>>(join(userDataRoot, 'User', 'settings.json'));
  if (settings) editor.settings = pickInterestingSettings(settings);

  const extensions = await readExtensions(variant, warnings);
  if (extensions.length > 0) editor.extensions = extensions;

  const foundAnything = editor.workspaces.length > 0 || editor.documents.length > 0 ||
    running.length > 0 || Boolean(editor.settings);
  return foundAnything ? editor : undefined;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Reads the product version from the installation's `product.json`, when it can be located. */
async function readVersion(userDataRoot: string): Promise<string | undefined> {
  // The user-data root has no version in it; the machine-id file's sibling `storage.json` sometimes
  // records the last version that wrote it, which is close enough for reporting.
  const storage = await readJsonFile<Record<string, unknown>>(
    join(userDataRoot, 'User', 'globalStorage', 'storage.json'),
  );
  const lastKnown = storage?.['lastKnownMenubarData'] as { version?: unknown } | undefined;
  return typeof lastKnown?.version === 'string' ? lastKnown.version : undefined;
}

/**
 * Reads the recently-opened folder list.
 *
 * The key has moved between versions (`backupWorkspaces`, then `windowsState`, then
 * `profileAssociations`), so every known shape is tried rather than assuming the current one — a
 * connector that broke on every editor update would not be worth running.
 */
export async function readRecentlyOpened(userDataRoot: string): Promise<string[]> {
  const paths: string[] = [];
  const seen = new Set<string>();

  const add = (value: unknown) => {
    if (typeof value !== 'string') return;
    const path = normalizePath(value);
    if (!path || seen.has(path)) return;
    seen.add(path);
    paths.push(path);
  };

  const storage = await readJsonFile<Record<string, unknown>>(
    join(userDataRoot, 'User', 'globalStorage', 'storage.json'),
  );
  if (storage) {
    // Walk the whole document for anything that looks like a folder URI. Structure-agnostic on
    // purpose: it survives the key renames rather than tracking them.
    collectFolderUris(storage, add, 0);
  }

  // `workspaceStorage/<hash>/workspace.json` names one folder each, and is the most stable of the
  // three locations because its shape has not changed.
  const workspaceStorage = join(userDataRoot, 'User', 'workspaceStorage');
  try {
    const entries = await readdir(workspaceStorage, { withFileTypes: true });
    // Newest first, so the most recently used workspaces lead.
    const dated = await Promise.all(entries.filter((e) => e.isDirectory()).map(async (entry) => {
      const path = join(workspaceStorage, entry.name);
      try {
        return { path, mtime: (await stat(path)).mtimeMs };
      } catch {
        return { path, mtime: 0 };
      }
    }));
    dated.sort((a, b) => b.mtime - a.mtime);

    for (const { path } of dated.slice(0, 40)) {
      const meta = await readJsonFile<{ folder?: string; workspace?: string; configuration?: { path?: string } }>(
        join(path, 'workspace.json'),
      );
      if (meta?.folder) add(meta.folder);
      if (meta?.workspace) add(meta.workspace);
      if (meta?.configuration?.path) add(meta.configuration.path);
    }
  } catch {
    // No workspace storage: a fresh installation, or a portable one. The storage.json pass stands.
  }

  return paths;
}

/** Recursively finds `file://` folder URIs anywhere in a JSON document. */
function collectFolderUris(value: unknown, add: (value: unknown) => void, depth: number): void {
  if (depth > 8 || !value || typeof value !== 'object') return;

  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string' && item.startsWith('file://') &&
        /folder|workspace|path|uri/i.test(key)) {
      add(item);
    } else {
      collectFolderUris(item, add, depth + 1);
    }
  }
}

/**
 * Reads the open-editor list out of the `state.vscdb` databases.
 *
 * **This is the one genuinely hard piece of the adapter**, and the choice is worth explaining.
 * `state.vscdb` is a real SQLite database. Reading it properly means either a native SQLite binding
 * (a compiled dependency, on a tool whose whole premise is having none) or reimplementing SQLite's
 * file format (a large project, to read one table).
 *
 * The third option, taken here: the values in `ItemTable` are JSON stored as text, and SQLite
 * stores text payloads uncompressed and contiguously. So the file is read as bytes and the JSON is
 * extracted from it directly. That is a genuine hack and it is labelled as one -- it depends on a
 * storage detail rather than on an interface, and a value large enough for SQLite to spill across
 * overflow pages comes back truncated. Truncated values are detected and discarded rather than
 * half-parsed.
 *
 * It is nonetheless the right trade: it is read-only, it cannot corrupt anything, it fails closed
 * (finding nothing rather than something wrong), and the alternative is not offering the data at
 * all. Where exactness matters, the extension in `extensions/vscode` pushes the same information
 * from inside the editor, where it is simply an API call.
 *
 * **Which database.** The open-editor layout is *per workspace*, under
 * `User/workspaceStorage/<hash>/state.vscdb`; the global database holds only machine-wide state.
 * Both are scanned, newest workspace first, because the newest is the window the user is in.
 */
export interface EditorPartEntry {
  path: string;
  group: number;
  active: boolean;
}

export async function readEditorState(userDataRoot: string): Promise<EditorPartEntry[]> {
  const databases = await listStateDatabases(userDataRoot);
  const entries: EditorPartEntry[] = [];
  const seen = new Set<string>();

  for (const database of databases.slice(0, 12)) {
    const text = await readDatabaseText(database);
    if (!text) continue;

    // The authoritative source: the serialized editor grid, which knows groups and active tabs.
    for (const grid of extractValuesAfter(text, 'editorpart.state":')) {
      for (const entry of walkEditorGrid(grid)) {
        if (seen.has(entry.path)) continue;
        seen.add(entry.path);
        entries.push(entry);
      }
    }

    // A fallback for databases whose grid value spilled to an overflow page and came back
    // unparseable: the raw resource URIs are still in the bytes, and knowing a file is open
    // without knowing its group beats knowing nothing.
    for (const match of text.matchAll(/"resource":"(file:\/\/[^"]{1,400})"/g)) {
      const raw = match[1]!;
      // A truncated value stops mid-path; a complete one ends in a filename character.
      if (!/[\w)\]]$/.test(raw)) continue;
      const path = safeDecodePath(raw);
      if (!path || seen.has(path)) continue;
      // Git's own scratch files pass through the editor constantly and are never what a user means
      // by "the file I have open".
      if (/[/\\]\.git[/\\]/.test(path)) continue;
      seen.add(path);
      entries.push({ path, group: 0, active: false });
    }
  }
  return entries;
}

function safeDecodePath(uri: string): string | undefined {
  try {
    return normalizePath(decodeURIComponent(uri));
  } catch {
    return normalizePath(uri);
  }
}

/** Every state database for this variant, newest workspace first. */
async function listStateDatabases(userDataRoot: string): Promise<string[]> {
  const databases: string[] = [];
  const workspaceStorage = join(userDataRoot, 'User', 'workspaceStorage');

  try {
    const entries = await readdir(workspaceStorage, { withFileTypes: true });
    const dated = await Promise.all(
      entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
        const path = join(workspaceStorage, entry.name, 'state.vscdb');
        try {
          return { path, mtime: (await stat(path)).mtimeMs };
        } catch {
          return { path, mtime: -1 };
        }
      }),
    );
    dated.sort((a, b) => b.mtime - a.mtime);
    databases.push(...dated.filter((item) => item.mtime >= 0).map((item) => item.path));
  } catch {
    // No workspace storage yet: a fresh installation.
  }

  databases.push(join(userDataRoot, 'User', 'globalStorage', 'state.vscdb'));
  return databases;
}

async function readDatabaseText(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path);
    if (info.size > 200 * 1024 * 1024) return undefined;
    return (await readFile(path)).toString('utf8');
  } catch {
    return undefined;
  }
}

/** Extracts every balanced JSON value appearing immediately after a key marker. */
function extractValuesAfter(text: string, marker: string): unknown[] {
  const values: unknown[] = [];
  let index = text.indexOf(marker);

  while (index >= 0 && values.length < 20) {
    const start = index + marker.length;
    const json = extractBalancedObject(text, start);
    if (json) {
      try {
        values.push(JSON.parse(json));
      } catch {
        // Truncated by an overflow page. Expected; the URI fallback above covers it.
      }
    }
    index = text.indexOf(marker, start);
  }
  return values;
}

/**
 * Walks a serialized editor grid into flat entries.
 *
 * The grid is a tree of branches and leaves mirroring the user's split layout, and each leaf is one
 * editor group holding an ordered list of tabs plus a most-recently-used order. That structure is
 * exactly what makes this source better than the raw URI list: it says which pane a file is in and
 * which tab is focused, neither of which the URIs alone can tell you.
 */
function walkEditorGrid(node: unknown, group = { index: 0 }, out: EditorPartEntry[] = []): EditorPartEntry[] {
  if (!node || typeof node !== 'object') return out;
  const record = node as Record<string, unknown>;

  if (record.serializedGrid) return walkEditorGrid(record.serializedGrid, group, out);
  if (record.root) return walkEditorGrid(record.root, group, out);

  if (record.type === 'branch' && Array.isArray(record.data)) {
    for (const child of record.data) walkEditorGrid(child, group, out);
    return out;
  }
  if (record.type === 'leaf' && record.data && typeof record.data === 'object') {
    const leaf = record.data as Record<string, unknown>;
    const groupIndex = group.index++;
    const editors = Array.isArray(leaf.editors) ? leaf.editors : [];
    const activeIndex = Array.isArray(leaf.mru) ? Number(leaf.mru[0]) : 0;

    for (let i = 0; i < editors.length; i++) {
      const path = editorResourcePath(editors[i]);
      if (path) out.push({ path, group: groupIndex, active: i === activeIndex });
    }
  }
  return out;
}


/**
 * Extracts one balanced JSON object or array starting at `from`, respecting strings and escapes.
 *
 * String-awareness is the whole difficulty: a brace inside a quoted path (and these values are full
 * of Windows paths) would otherwise unbalance the count and swallow the rest of the file.
 */
function extractBalancedObject(text: string, from: number): string | undefined {
  let start = from;
  while (start < text.length && text[start] !== '{' && text[start] !== '[') {
    if (!/\s/.test(text[start]!)) return undefined;
    start++;
  }
  if (start >= text.length) return undefined;

  const open = text[start]!;
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length && i - start < 8_000_000; i++) {
    const char = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === open) depth++;
    else if (char === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

/** Digs the file path out of one serialized editor entry, whose `value` is itself JSON text. */
function editorResourcePath(editor: unknown): string | undefined {
  if (!editor || typeof editor !== 'object') return undefined;
  const record = editor as Record<string, unknown>;

  let value: unknown = record.value;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== 'object') return undefined;

  const inner = value as Record<string, unknown>;
  const resource = inner.resource ?? inner.resourceJSON ?? inner.uri;
  if (typeof resource === 'string' && resource.startsWith('file://')) {
    return safeDecodePath(resource);
  }
  if (resource && typeof resource === 'object') {
    const parts = resource as Record<string, unknown>;
    if (typeof parts.fsPath === 'string') return normalizePath(parts.fsPath);
    if (typeof parts.path === 'string') return normalizePath(parts.path);
  }
  return undefined;
}

/** Turns the editor state into open-document records, marking dirty ones from the backup index. */
async function readOpenDocuments(userDataRoot: string, warnings: string[]): Promise<OpenDocument[]> {
  let documents: OpenDocument[] = [];

  try {
    for (const entry of await readEditorState(userDataRoot)) {
      documents.push({
        path: entry.path,
        languageId: detectLanguage(entry.path).id,
        dirty: false,
        active: entry.active,
        group: entry.group,
      });
    }
  } catch (error) {
    warnings.push(`could not read VS Code editor state: ${error instanceof Error ? error.message : error}`);
  }

  // Backup files are the one on-disk trace of an *unsaved* buffer, so a document with a backup is
  // known to be dirty even though its contents are not readable from here.
  const dirty = await readBackupPaths(userDataRoot);
  const dirtySet = new Set(dirty);
  documents = documents.map((document) => dirtySet.has(document.path) ? { ...document, dirty: true } : document);

  for (const path of dirty) {
    if (!documents.some((document) => document.path === path)) {
      documents.push({ path, languageId: detectLanguage(path).id, dirty: true, active: false });
    }
  }
  return documents.slice(0, 200);
}

/**
 * Finds files with unsaved changes, by reading the backup index VS Code maintains for crash
 * recovery.
 *
 * Each backup directory corresponds to one window and contains a `<scheme>/` folder per URI scheme,
 * with one file per dirty document whose *first line* is the original resource URI. That header is
 * the only readable part — the rest is an internal format — but it is exactly the part that
 * matters, since knowing *which* files are unsaved is far more useful than not knowing.
 */
async function readBackupPaths(userDataRoot: string): Promise<string[]> {
  const backups = join(userDataRoot, 'Backups');
  const paths: string[] = [];

  try {
    const windows = await readdir(backups, { withFileTypes: true });
    for (const window of windows) {
      if (!window.isDirectory()) continue;
      const schemes = await readdir(join(backups, window.name), { withFileTypes: true });

      for (const scheme of schemes) {
        if (!scheme.isDirectory()) continue;
        const files = await readdir(join(backups, window.name, scheme.name));

        for (const file of files.slice(0, 100)) {
          const text = await readTextFile(join(backups, window.name, scheme.name, file), 64 * 1024);
          const header = text?.split('\n', 1)[0]?.trim();
          if (header && (header.startsWith('file://') || header.startsWith('untitled:'))) {
            paths.push(normalizePath(header));
          }
        }
      }
    }
  } catch {
    // No backups directory means nothing is unsaved, which is the common and unremarkable case.
  }
  return paths;
}

/** Reads a workspace's `.vscode` configuration, which says how the project is run and debugged. */
async function attachWorkspaceSettings(workspace: Workspace, warnings: string[]): Promise<void> {
  const vscodeDir = join(workspace.root, '.vscode');
  if (!existsSync(vscodeDir)) return;

  const launch = await readJsonFile<{ configurations?: Array<Record<string, unknown>> }>(join(vscodeDir, 'launch.json'));
  const tasks = await readJsonFile<{ tasks?: Array<Record<string, unknown>> }>(join(vscodeDir, 'tasks.json'));

  const scripts: Record<string, string> = {};
  for (const configuration of launch?.configurations ?? []) {
    const name = typeof configuration.name === 'string' ? configuration.name : undefined;
    if (name) scripts[`debug: ${name}`] = String(configuration.type ?? 'launch');
  }
  for (const task of tasks?.tasks ?? []) {
    const label = typeof task.label === 'string' ? task.label : undefined;
    if (label) scripts[`task: ${label}`] = String(task.command ?? task.type ?? '');
  }

  if (Object.keys(scripts).length > 0) {
    (workspace.manifests ??= []).push({
      kind: 'vscode',
      file: vscodeDir,
      name: '.vscode configuration',
      scripts,
    });
  }
  void warnings;
}

/**
 * Keeps only the settings that change how code is written or built.
 *
 * A real `settings.json` is hundreds of keys, most of them about colours and animations. Shipping
 * all of it to an AI is noise that costs context; shipping the formatter, the indentation and the
 * language overrides is what stops it suggesting four-space indentation in a two-space project.
 */
function pickInterestingSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const interesting: Record<string, unknown> = {};
  const patterns = [
    /^editor\.(tabSize|insertSpaces|detectIndentation|defaultFormatter|formatOnSave|rulers|wordWrap)$/,
    /^files\.(encoding|eol|trimTrailingWhitespace|insertFinalNewline|exclude|associations)$/,
    /^\[[^\]]+\]$/,             // Language-specific overrides, which are exactly the important ones.
    /^(typescript|javascript|python|go|rust|java|csharp|php|ruby)\./,
    /^eslint\.|^prettier\.|^black\.|^ruff\.|^gopls\.|^rust-analyzer\./,
    /^terminal\.integrated\.(defaultProfile|shell)/,
  ];

  for (const [key, value] of Object.entries(settings)) {
    if (patterns.some((pattern) => pattern.test(key))) interesting[key] = value;
  }
  return interesting;
}

/** Lists installed extensions from the extensions directory. */
async function readExtensions(
  variant: VsCodeVariant,
  warnings: string[],
): Promise<NonNullable<EditorInstance['extensions']>> {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  const candidates = [
    join(home, `.${variant.dir.toLowerCase().replace(/\s+-\s+/g, '-').replace(/\s+/g, '-')}`, 'extensions'),
    join(home, '.vscode', 'extensions'),
    join(home, '.vscode-insiders', 'extensions'),
    join(home, '.vscode-oss', 'extensions'),
    join(home, '.cursor', 'extensions'),
    join(home, '.windsurf', 'extensions'),
  ];

  for (const directory of candidates) {
    if (!existsSync(directory)) continue;
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      const extensions: NonNullable<EditorInstance['extensions']> = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        // Directory names are `publisher.name-version`, which already carries everything needed;
        // reading each package.json would mean hundreds of file reads for the same information.
        const match = /^(.+?)-(\d+\.\d+\.\d+.*)$/.exec(entry.name);
        extensions.push({
          id: match?.[1] ?? entry.name,
          version: match?.[2],
          enabled: true,
        });
        if (extensions.length >= 300) break;
      }
      if (extensions.length > 0) return extensions;
    } catch (error) {
      warnings.push(`could not list extensions in ${directory}: ${error instanceof Error ? error.message : error}`);
    }
  }
  return [];
}

/** Exported for tests: the basename of a variant's extension directory guess. */
export function extensionDirectoryName(variant: VsCodeVariant): string {
  return basename(variant.dir);
}
