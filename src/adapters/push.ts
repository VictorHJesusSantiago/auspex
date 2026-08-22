import type { Adapter, AdapterResult, CaptureOptions } from '../core/adapter.ts';
import { NO_CAPABILITIES } from '../core/adapter.ts';
import type {
  DebugState, Diagnostic, EditorInstance, OpenDocument, TerminalCapture, Workspace,
} from '../core/model.ts';
import { normalizePath } from '../platform/files.ts';
import { detectLanguage } from '../languages/registry.ts';

/**
 * The ingest endpoint: live state pushed *from inside* an editor by a plugin.
 *
 * This is the highest-fidelity path in Auspex and the only one that can answer the questions that
 * matter most. Where the caret is, what is selected, which lines are scrolled into view, what an
 * unsaved buffer actually contains, what the terminal just printed — none of that exists anywhere
 * on disk. It exists only in the editor's memory, and the only way to read it is to be inside the
 * editor.
 *
 * So the arrangement is inverted here: instead of Auspex reaching into the editor, a small plugin
 * in the editor posts to Auspex. `extensions/vscode` is a complete working example in about a
 * hundred lines, and the same shape works for a JetBrains plugin, a Neovim Lua module, an Emacs
 * hook or a Sublime command — anything that can make an HTTP request.
 *
 * **The payload is deliberately forgiving.** A plugin author should be able to send what their
 * editor makes easy and omit the rest, and get proportionate value. Every field is optional, unknown
 * fields are ignored rather than rejected, and paths may be file URIs or plain paths in either slash
 * direction. The alternative — a strict schema — would mean every plugin has to be complete before
 * it is useful, which is how integration points die.
 *
 * **Staleness is tracked, not assumed.** A plugin that stops posting (the editor closed, the
 * machine slept) leaves its last state behind; that state ages out rather than being served forever
 * as though it were current.
 */

/** What a plugin posts. Every field optional — see this module's own docs. */
export interface PushPayload {
  /** Identifies the editor: `vscode`, `intellij`, `neovim`. Free-form; used for display. */
  editor?: string;
  /** Product name for display. */
  name?: string;
  version?: string;
  pid?: number;
  /** Open folders. Strings or objects; strings are the common case. */
  workspaces?: Array<string | { root: string; name?: string }>;
  documents?: Array<{
    path?: string;
    uri?: string;
    languageId?: string;
    dirty?: boolean;
    active?: boolean;
    group?: number;
    cursor?: { line: number; character: number };
    selections?: Array<{ start: { line: number; character: number }; end: { line: number; character: number } }>;
    visibleRange?: { start: { line: number; character: number }; end: { line: number; character: number } };
    text?: string;
  }>;
  diagnostics?: Array<{
    path?: string;
    uri?: string;
    line?: number;
    character?: number;
    endLine?: number;
    endCharacter?: number;
    severity?: string | number;
    message?: string;
    code?: string;
    source?: string;
  }>;
  debug?: Partial<DebugState>;
  /**
   * A complete debug session, from an editor plugin that can see the debug protocol.
   *
   * Distinct from `debug`, which is the small summary shape a snapshot carries. This is the whole
   * record, and it exists because a plugin sitting inside the editor — the VS Code debug adapter
   * tracker, for instance — sees every DAP message without any proxy at all, which removes the
   * hardest setup step in the entire tool.
   *
   * `captureMethod` is the field that keeps this honest: a tracker sees exactly what the editor
   * asked for, so a variable nobody expanded is *absent* rather than empty. Anything reading this
   * has to be able to tell that apart from a proxy's exhaustive capture, and this is how.
   */
  debugSession?: Record<string, unknown> & {
    sessionId?: string;
    captureMethod?: 'vscode-tracker' | 'proxy' | string;
    captureNote?: string;
  };
  terminals?: Array<{ name?: string; kind?: string; cwd?: string; command?: string; lines?: string[]; exitCode?: number }>;
  /** Anything else the plugin wants to attach. Passed through to `settings`. */
  settings?: Record<string, unknown>;
}

/** One editor's most recent push, with when it arrived. */
interface PushRecord {
  receivedAt: number;
  editor: EditorInstance;
  diagnostics: Diagnostic[];
  terminals: TerminalCapture[];
}

/**
 * Holds the most recent push from each editor.
 *
 * Keyed by editor id plus pid, so two windows of the same editor are tracked separately rather than
 * overwriting each other — which is the normal case for anyone with two projects open.
 */
export class PushStore {
  private readonly records = new Map<string, PushRecord>();

  /** How long a push stays current. Beyond this it is dropped rather than served as live. */
  staleAfterMs = 60_000;

  /** Accepts a payload, normalizing it into the model. Returns the key it was stored under. */
  ingest(payload: PushPayload): string {
    const editorId = payload.editor ?? 'unknown';
    const key = `${editorId}:${payload.pid ?? 0}`;

    const editor: EditorInstance = {
      adapter: 'push',
      name: payload.name ?? editorId,
      version: payload.version,
      pid: payload.pid,
      workspaces: normalizeWorkspaces(payload.workspaces),
      documents: normalizeDocuments(payload.documents),
      confidence: 'live',
    };
    if (payload.settings) editor.settings = payload.settings;
    if (payload.debug) {
      editor.debug = {
        active: payload.debug.active ?? true,
        status: payload.debug.status ?? 'running',
        ...payload.debug,
      };
    }

    this.records.set(key, {
      receivedAt: Date.now(),
      editor,
      diagnostics: normalizeDiagnostics(payload.diagnostics),
      terminals: normalizeTerminals(payload.terminals),
    });
    return key;
  }

  /** Everything not yet stale, with stale entries pruned on the way. */
  current(): PushRecord[] {
    const now = Date.now();
    const live: PushRecord[] = [];

    for (const [key, record] of this.records) {
      // `>=` rather than `>`: a staleness window of zero has to mean "nothing is ever current",
      // which is what a caller setting it to zero is asking for, and which a strict comparison
      // would silently turn into "everything is current forever" within the same millisecond.
      if (now - record.receivedAt >= this.staleAfterMs) this.records.delete(key);
      else live.push(record);
    }
    return live;
  }

  /** How many editors are currently pushing. */
  get size(): number {
    return this.current().length;
  }

  clear(): void {
    this.records.clear();
  }
}

/** The process-wide store the HTTP server writes to and the adapter reads from. */
export const pushStore = new PushStore();

function normalizeWorkspaces(input: PushPayload['workspaces']): Workspace[] {
  const workspaces: Workspace[] = [];

  for (const item of input ?? []) {
    const root = normalizePath(typeof item === 'string' ? item : item.root);
    if (!root) continue;
    workspaces.push({
      root,
      name: typeof item === 'object' && item.name ? item.name : (root.split('/').pop() || root),
    });
  }
  return workspaces;
}

function normalizeDocuments(input: PushPayload['documents']): OpenDocument[] {
  const documents: OpenDocument[] = [];

  for (const item of input ?? []) {
    const raw = item.path ?? item.uri;
    if (!raw) continue;
    const path = normalizePath(raw);

    const document: OpenDocument = {
      path,
      // Trust the editor's own language id when it sends one: it knows about the user's file
      // associations and custom modes, which no extension table can.
      languageId: item.languageId ?? detectLanguage(path).id,
      dirty: item.dirty === true,
      active: item.active === true,
    };
    if (typeof item.group === 'number') document.group = item.group;
    if (item.cursor) document.cursor = item.cursor;
    if (item.selections?.length) document.selections = item.selections;
    if (item.visibleRange) document.visibleRange = item.visibleRange;
    if (typeof item.text === 'string') document.text = item.text;

    documents.push(document);
  }
  return documents;
}

/**
 * Normalizes diagnostics from whatever shape the plugin found convenient.
 *
 * Severity is accepted as either a name or an LSP number, because a VS Code extension has the
 * number to hand and a shell script has the word. Refusing one of them would mean rejecting a
 * perfectly clear message on a technicality.
 */
function normalizeDiagnostics(input: PushPayload['diagnostics']): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const item of input ?? []) {
    const raw = item.path ?? item.uri;
    if (!raw) continue;

    const line = Number(item.line) || 0;
    const character = Number(item.character) || 0;

    diagnostics.push({
      file: normalizePath(raw),
      range: {
        start: { line, character },
        end: {
          line: Number.isFinite(Number(item.endLine)) ? Number(item.endLine) : line,
          character: Number.isFinite(Number(item.endCharacter)) ? Number(item.endCharacter) : character,
        },
      },
      severity: normalizeSeverity(item.severity),
      message: String(item.message ?? ''),
      code: item.code,
      source: item.source,
    });
  }
  return diagnostics;
}

function normalizeSeverity(value: unknown): Diagnostic['severity'] {
  if (typeof value === 'number') {
    return ({ 1: 'error', 2: 'warning', 3: 'information', 4: 'hint' } as const)[value as 1 | 2 | 3 | 4] ?? 'information';
  }
  const text = String(value ?? '').toLowerCase();
  if (text.startsWith('err') || text === 'fatal') return 'error';
  if (text.startsWith('warn')) return 'warning';
  if (text.startsWith('hint')) return 'hint';
  return 'information';
}

function normalizeTerminals(input: PushPayload['terminals']): TerminalCapture[] {
  const terminals: TerminalCapture[] = [];

  for (const item of input ?? []) {
    terminals.push({
      name: item.name ?? 'terminal',
      kind: item.kind ?? 'terminal',
      cwd: item.cwd ? normalizePath(item.cwd) : undefined,
      command: item.command,
      // Capped here rather than at the sender, so a plugin author cannot accidentally flood a
      // snapshot with a build log.
      lines: (item.lines ?? []).slice(-200),
      exitCode: item.exitCode,
    });
  }
  return terminals;
}

/**
 * The adapter that surfaces pushed state.
 *
 * Reports `live` confidence, which it is the only adapter entitled to do for cursors and buffers,
 * and which is why the snapshot merger lets it win over anything read from disk.
 */
export class PushAdapter implements Adapter {
  readonly id = 'push';
  readonly name = 'Editor plugins';
  readonly confidence = 'live' as const;
  readonly capabilities = {
    ...NO_CAPABILITIES,
    workspaces: true,
    documents: true,
    cursor: true,
    dirtyBuffers: true,
    diagnostics: true,
    debug: true,
    terminals: true,
    settings: true,
  };

  private readonly store: PushStore;

  constructor(store: PushStore = pushStore) {
    this.store = store;
  }

  async probe(): Promise<boolean> {
    return this.store.size > 0;
  }

  async capture(_options: CaptureOptions): Promise<AdapterResult> {
    const records = this.store.current();

    return {
      editors: records.map((record) => record.editor),
      documents: records.flatMap((record) => record.editor.documents),
      diagnostics: records.flatMap((record) => record.diagnostics),
      terminals: records.flatMap((record) => record.terminals),
      detail: records.length > 0
        ? records.map((r) => `${r.editor.name} (${Math.round((Date.now() - r.receivedAt) / 1000)}s ago)`).join('; ')
        : undefined,
    };
  }
}
