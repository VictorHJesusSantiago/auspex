import { createServer, type Server, type Socket } from 'node:net';
import type { Adapter, AdapterResult, CaptureOptions } from '../core/adapter.ts';
import { NO_CAPABILITIES } from '../core/adapter.ts';
import type {
  Breakpoint, DebugState, Diagnostic, DiagnosticSeverity, DocumentSymbol, StackFrame, SymbolKind, Variable,
} from '../core/model.ts';
import { normalizePath } from '../platform/files.ts';
import { DebugRecorder, debugRecorder } from './debug.ts';

/**
 * Language Server Protocol and Debug Adapter Protocol capture.
 *
 * **This is the most genuinely universal mechanism in Auspex, and it is worth saying why.** Every
 * per-editor adapter is an exercise in reverse-engineering one program's private files, and each
 * one covers one editor. LSP and DAP are the opposite: they are published protocols that *every*
 * modern editor speaks, for *every* language that has a server. VS Code, Neovim, Helix, Emacs,
 * Sublime, Zed, Kate, Eclipse and the JetBrains IDEs all drive language servers over LSP, and all
 * drive debuggers over DAP.
 *
 * So a proxy sitting between the editor and the server sees the real thing: exact diagnostics from
 * the actual compiler, exact symbols from the actual parse tree, the real call stack of the real
 * paused process. No heuristics, no file formats, no per-editor code — and it works for a language
 * this tool has never heard of, provided that language has a server.
 *
 * **How it is used.** The proxy is inserted by pointing the editor's server command at Auspex
 * instead of at the server, with the real server as an argument:
 *
 * ```
 * auspex proxy --lsp -- typescript-language-server --stdio
 * auspex proxy --dap -- node /path/to/debug-adapter.js
 * ```
 *
 * Auspex passes every byte through untouched in both directions — it is genuinely transparent, and
 * a bug here would break the user's editor, which is why it copies rather than rewrites — while
 * keeping a copy of the notifications worth remembering.
 *
 * **The stated cost**: this requires the user to reconfigure their editor once. That is a real
 * imposition, and it is the price of exactness. The disk adapters need no setup and give a fuzzier
 * answer; this needs a line of configuration and gives the compiler's own answer.
 */

// ---------------------------------------------------------------------------------------------
// The wire format, shared by both protocols
// ---------------------------------------------------------------------------------------------

/** One decoded message, plus the exact bytes it came from. */
export interface FramedMessage {
  message: Record<string, unknown>;
  raw: Buffer;
}

/**
 * A complete frame, whether or not its body was valid JSON.
 *
 * The distinction matters only in one place, and it matters absolutely there: the deep DAP proxy
 * decodes before forwarding, so it must be handed *every* frame including ones it cannot parse.
 * Dropping an unparseable frame would make the proxy non-transparent, which is the one thing it may
 * never be.
 */
export interface RawFrame {
  raw: Buffer;
  message?: Record<string, unknown>;
}

/**
 * Incrementally decodes the `Content-Length` framing both protocols use.
 *
 * A streaming decoder rather than a per-chunk parse, because TCP and pipes split writes wherever
 * they like: a single JSON-RPC message routinely arrives as three chunks, and two messages
 * routinely arrive as one. Anything that assumed one chunk equals one message would work in testing
 * and fail under load, which is the worst kind of bug to have in a transparent proxy.
 */
export class MessageFramer {
  private buffer = Buffer.alloc(0);

  /** Feeds bytes in, returning every complete message they completed. */
  push(chunk: Buffer): FramedMessage[] {
    const frames: FramedMessage[] = [];
    for (const frame of this.pushRaw(chunk)) {
      if (frame.message) frames.push({ message: frame.message, raw: frame.raw });
    }
    return frames;
  }

  /** As {@link push}, but also returns frames whose body would not parse. */
  pushRaw(chunk: Buffer): RawFrame[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: RawFrame[] = [];

    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) break;

      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        // A header with no length is unrecoverable: there is no way to know where it ends. Drop it
        // and resynchronize rather than stalling forever on a stream that will never complete.
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }

      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (this.buffer.length < start + length) break; // Body not fully arrived yet.

      const body = this.buffer.subarray(start, start + length);
      const raw = this.buffer.subarray(0, start + length);
      this.buffer = this.buffer.subarray(start + length);

      try {
        messages.push({ message: JSON.parse(body.toString('utf8')) as Record<string, unknown>, raw });
      } catch {
        // Malformed JSON from a server is its problem, not ours -- but the bytes still have to
        // reach the other side, so the frame is returned with no decoded message rather than
        // dropped.
        messages.push({ raw });
      }
    }
    return messages;
  }

  /** Bytes buffered but not yet forming a complete message — for diagnostics. */
  get pending(): number {
    return this.buffer.length;
  }
}

/** Encodes a message with the framing both protocols expect. */
export function frame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

// ---------------------------------------------------------------------------------------------
// The shared capture store
// ---------------------------------------------------------------------------------------------

/**
 * Everything the proxies have observed, held in memory and served to captures.
 *
 * A single shared store rather than one per proxy, so that a user running a TypeScript server, a
 * Rust server and a debug adapter at once gets one merged picture — which is what they actually
 * have, and what an assistant needs.
 */
export class ProtocolStore {
  private readonly diagnosticsByFile = new Map<string, Diagnostic[]>();
  private readonly symbolsByFile = new Map<string, DocumentSymbol[]>();
  private debug: DebugState | undefined;
  private readonly outputLines: string[] = [];
  private lastActivity = 0;
  readonly servers = new Set<string>();

  get isActive(): boolean {
    // Five minutes: long enough to survive a quiet period of reading code, short enough that a
    // long-dead server's diagnostics are not reported as current.
    return Date.now() - this.lastActivity < 5 * 60_000;
  }

  get lastActivityAt(): number {
    return this.lastActivity;
  }

  touch(server?: string): void {
    this.lastActivity = Date.now();
    if (server) this.servers.add(server);
  }

  setDiagnostics(file: string, diagnostics: Diagnostic[]): void {
    this.touch();
    // An empty publish means "this file is now clean" and must delete rather than store nothing,
    // or a fixed error would be reported forever.
    if (diagnostics.length === 0) this.diagnosticsByFile.delete(file);
    else this.diagnosticsByFile.set(file, diagnostics);
  }

  setSymbols(file: string, symbols: DocumentSymbol[]): void {
    this.touch();
    this.symbolsByFile.set(file, symbols);
  }

  setDebug(state: DebugState | undefined): void {
    this.touch();
    this.debug = state;
  }

  appendOutput(line: string): void {
    this.touch();
    this.outputLines.push(line);
    // A debuggee that logs in a loop must not grow this without bound.
    if (this.outputLines.length > 500) this.outputLines.splice(0, this.outputLines.length - 500);
  }

  allDiagnostics(): Diagnostic[] {
    return [...this.diagnosticsByFile.values()].flat();
  }

  allSymbols(): Record<string, DocumentSymbol[]> {
    return Object.fromEntries(this.symbolsByFile);
  }

  debugState(): DebugState | undefined {
    if (!this.debug) return undefined;
    return this.outputLines.length > 0 ? { ...this.debug, output: [...this.outputLines] } : this.debug;
  }

  clear(): void {
    this.diagnosticsByFile.clear();
    this.symbolsByFile.clear();
    this.debug = undefined;
    this.outputLines.length = 0;
  }
}

/** The process-wide store the proxies write to and the adapter reads from. */
export const protocolStore = new ProtocolStore();

// ---------------------------------------------------------------------------------------------
// LSP
// ---------------------------------------------------------------------------------------------

/** LSP severity numbers to the model's names. Defined by the specification, so this is exact. */
const LSP_SEVERITY: Record<number, DiagnosticSeverity> = {
  1: 'error', 2: 'warning', 3: 'information', 4: 'hint',
};

/** LSP symbol-kind numbers to names. Also from the specification. */
const LSP_SYMBOL_KIND: Record<number, SymbolKind> = {
  1: 'file', 2: 'module', 3: 'namespace', 4: 'package', 5: 'class', 6: 'method', 7: 'property',
  8: 'field', 9: 'constructor', 10: 'enum', 11: 'interface', 12: 'function', 13: 'variable',
  14: 'constant', 23: 'struct', 24: 'event', 25: 'operator', 26: 'typeParameter',
};

/**
 * Interprets one LSP message, recording anything worth keeping.
 *
 * Only notifications flowing *from* the server are interesting: those are the ones carrying the
 * server's own conclusions. Requests from the editor are forwarded and ignored.
 */
export function observeLspMessage(message: Record<string, unknown>, store: ProtocolStore): void {
  const method = typeof message.method === 'string' ? message.method : undefined;

  if (method === 'textDocument/publishDiagnostics') {
    const params = message.params as { uri?: string; diagnostics?: unknown[] } | undefined;
    if (!params?.uri) return;

    const file = normalizePath(params.uri);
    const diagnostics: Diagnostic[] = [];

    for (const item of params.diagnostics ?? []) {
      const record = item as Record<string, unknown>;
      const range = record.range as { start?: unknown; end?: unknown } | undefined;
      if (!range?.start) continue;

      diagnostics.push({
        file,
        range: {
          start: position(range.start),
          end: position(range.end ?? range.start),
        },
        severity: LSP_SEVERITY[Number(record.severity)] ?? 'information',
        message: String(record.message ?? ''),
        code: record.code !== undefined ? String(record.code) : undefined,
        source: typeof record.source === 'string' ? record.source : undefined,
      });
    }
    store.setDiagnostics(file, diagnostics);
    return;
  }

  if (method === 'window/logMessage' || method === 'window/showMessage') {
    const params = message.params as { message?: string } | undefined;
    if (params?.message) store.appendOutput(`[lsp] ${params.message}`);
    return;
  }

  // A response to a documentSymbol request carries the server's real parse tree, which is exactly
  // what the heuristic outliner cannot produce.
  if (message.result && Array.isArray(message.result)) {
    const symbols = convertLspSymbols(message.result as unknown[]);
    if (symbols.length > 0) store.setSymbols('__last_symbol_request__', symbols);
  }
}

/** Converts LSP `DocumentSymbol[]` or `SymbolInformation[]` into the model's shape. */
export function convertLspSymbols(items: unknown[]): DocumentSymbol[] {
  const symbols: DocumentSymbol[] = [];

  for (const item of items) {
    const record = item as Record<string, unknown>;
    if (typeof record.name !== 'string') continue;

    // `DocumentSymbol` has `range`; the older `SymbolInformation` nests it under `location`.
    const location = record.location as { range?: unknown } | undefined;
    const range = (record.range ?? location?.range) as { start?: unknown; end?: unknown } | undefined;
    if (!range?.start) continue;

    const symbol: DocumentSymbol = {
      name: record.name,
      kind: LSP_SYMBOL_KIND[Number(record.kind)] ?? 'variable',
      range: { start: position(range.start), end: position(range.end ?? range.start) },
      detail: typeof record.detail === 'string' ? record.detail : undefined,
    };
    if (Array.isArray(record.children)) {
      const children = convertLspSymbols(record.children);
      if (children.length > 0) symbol.children = children;
    }
    symbols.push(symbol);
  }
  return symbols;
}

function position(value: unknown): { line: number; character: number } {
  const record = (value ?? {}) as Record<string, unknown>;
  return {
    line: Number(record.line) || 0,
    character: Number(record.character) || 0,
  };
}

// ---------------------------------------------------------------------------------------------
// DAP
// ---------------------------------------------------------------------------------------------

/**
 * Interprets one DAP message.
 *
 * The state machine is small and worth stating: a `stopped` event means the program is paused and
 * a stack is now available; `stackTrace`, `scopes` and `variables` responses fill that in;
 * `continued` clears it; `terminated` or `exited` ends the session. Everything else is forwarded
 * and ignored.
 */
export function observeDapMessage(message: Record<string, unknown>, store: ProtocolStore): void {
  const type = message.type;

  if (type === 'event') {
    const event = String(message.event ?? '');
    const body = (message.body ?? {}) as Record<string, unknown>;

    switch (event) {
      case 'stopped':
        store.setDebug({
          active: true,
          status: 'paused',
          stoppedReason: typeof body.reason === 'string' ? body.reason : undefined,
          threadId: Number(body.threadId) || undefined,
        });
        break;
      case 'continued':
        store.setDebug({ active: true, status: 'running' });
        break;
      case 'terminated':
      case 'exited':
        store.setDebug({ active: false, status: 'terminated' });
        break;
      case 'output': {
        const text = typeof body.output === 'string' ? body.output : '';
        for (const line of text.split('\n')) {
          if (line.trim()) store.appendOutput(line.replace(/\r$/, ''));
        }
        break;
      }
      default:
        store.touch();
    }
    return;
  }

  if (type === 'response') {
    const command = String(message.command ?? '');
    const body = (message.body ?? {}) as Record<string, unknown>;
    const current = store.debugState();

    if (command === 'stackTrace' && Array.isArray(body.stackFrames)) {
      const stack: StackFrame[] = [];
      for (const item of body.stackFrames.slice(0, 40)) {
        const record = item as Record<string, unknown>;
        const source = record.source as { path?: string } | undefined;
        stack.push({
          id: Number(record.id) || 0,
          name: String(record.name ?? ''),
          file: source?.path ? normalizePath(source.path) : undefined,
          line: Number(record.line) || undefined,
          column: Number(record.column) || undefined,
        });
      }
      store.setDebug({ ...(current ?? { active: true, status: 'paused' }), stack });
      return;
    }

    if (command === 'variables' && Array.isArray(body.variables)) {
      const variables: Variable[] = [];
      for (const item of body.variables.slice(0, 200)) {
        const record = item as Record<string, unknown>;
        variables.push({
          name: String(record.name ?? ''),
          value: String(record.value ?? ''),
          type: typeof record.type === 'string' ? record.type : undefined,
          expandable: Number(record.variablesReference) > 0,
        });
      }
      const scopes = { ...(current?.scopes ?? {}), Locals: variables };
      store.setDebug({ ...(current ?? { active: true, status: 'paused' }), scopes });
      return;
    }

    if (command === 'setBreakpoints' && Array.isArray(body.breakpoints)) {
      const breakpoints: Breakpoint[] = [];
      for (const item of body.breakpoints) {
        const record = item as Record<string, unknown>;
        const source = record.source as { path?: string } | undefined;
        breakpoints.push({
          file: source?.path ? normalizePath(source.path) : '',
          line: Number(record.line) || 0,
          enabled: true,
          verified: record.verified === true,
        });
      }
      const merged = [...(current?.breakpoints ?? []), ...breakpoints];
      store.setDebug({ ...(current ?? { active: true, status: 'running' }), breakpoints: merged });
      return;
    }
    store.touch();
  }
}

// ---------------------------------------------------------------------------------------------
// The proxy
// ---------------------------------------------------------------------------------------------

export type ProtocolKind = 'lsp' | 'dap';

/** How a proxy should behave beyond passing bytes through. */
export interface ProxyOptions {
  /**
   * Turns on deep debug capture: the proxy stops merely watching the session and starts
   * interrogating it. See {@link DebugRecorder} for what that means and why it is safe.
   *
   * Only meaningful for `dap`. Ignored for `lsp`, which has no equivalent — a language server's
   * state is per-document and already flows past unprompted.
   */
  deep?: boolean;
  /** The recorder to fill. Defaults to the process-wide one the adapters read from. */
  recorder?: DebugRecorder;
  store?: ProtocolStore;
}

/**
 * Wires a recorder into a DAP stream, returning the two halves of the proxy's message handling.
 *
 * `fromAdapter` returns false for messages the recorder issued itself and which must therefore be
 * swallowed. That is the single reason the deep path decodes before forwarding rather than after:
 * once a probe response has been written to the editor it cannot be recalled, and an editor that
 * receives a response to a request it never sent is entitled to treat the stream as corrupt.
 */
export function wireDeepDap(
  recorder: DebugRecorder,
  toAdapter: (bytes: Buffer) => void,
  store: ProtocolStore,
): { fromAdapter: (message: Record<string, unknown>) => boolean; fromEditor: (message: Record<string, unknown>) => void } {
  recorder.attach({ send: (message) => toAdapter(frame(message)) });

  const sync = () => {
    const state = recorder.toDebugState();
    if (state) store.setDebug(state);
  };

  return {
    fromAdapter: (message) => {
      const swallow = recorder.observe(message, 'out');
      sync();
      return !swallow;
    },
    fromEditor: (message) => {
      recorder.observe(message, 'in');
      sync();
    },
  };
}

/**
 * A transparent stdio proxy.
 *
 * The contract is absolute: every byte received from one side is written to the other, unchanged
 * and in order, before anything else happens. Observation is a side effect on a *copy* of the
 * decoded message, and an exception while observing must never affect what was forwarded — which is
 * why the forward happens first and the observation is wrapped.
 *
 * That ordering is the whole safety argument for putting this in the middle of someone's editor.
 */
export function createStdioProxy(
  kind: ProtocolKind,
  child: { stdin: NodeJS.WritableStream; stdout: NodeJS.ReadableStream },
  store: ProtocolStore = protocolStore,
  options: ProxyOptions = {},
): () => void {
  const fromServer = new MessageFramer();
  const fromEditor = new MessageFramer();
  const observe = kind === 'lsp' ? observeLspMessage : observeDapMessage;

  const deep = kind === 'dap' && options.deep === true
    ? wireDeepDap(options.recorder ?? debugRecorder, (bytes) => child.stdin.write(bytes), store)
    : undefined;

  const onServerData = (chunk: Buffer) => {
    if (deep) {
      // Decode first, forward per frame, drop our own probe responses. Every other frame -- and
      // every frame we could not decode -- is written out in the order it arrived, so the stream
      // the editor sees is byte-identical to the one it would have seen without us, minus exactly
      // the responses to requests it never made.
      for (const { raw, message } of fromServer.pushRaw(chunk)) {
        let forward = true;
        if (message) {
          try {
            forward = deep.fromAdapter(message);
          } catch {
            forward = true;      // A recorder fault must never cost the editor a message.
          }
        }
        if (forward) process.stdout.write(raw);
      }
      return;
    }

    process.stdout.write(chunk);            // Forward first, always.
    for (const { message } of fromServer.push(chunk)) {
      try {
        observe(message, store);
      } catch {
        // Observation is best-effort by construction; the editor already has its bytes.
      }
    }
  };

  const onEditorData = (chunk: Buffer) => {
    child.stdin.write(chunk);
    for (const { message } of fromEditor.push(chunk)) {
      try {
        if (deep) deep.fromEditor(message);
        else observe(message, store);
      } catch {
        // As above.
      }
    }
  };

  child.stdout.on('data', onServerData);
  process.stdin.on('data', onEditorData);

  // The caller gets a way to detach. Without it, the `process.stdin` listener keeps the event loop
  // alive after the language server exits, and `auspex proxy` hangs forever instead of returning
  // the child's exit code -- which is exactly what happened the first time this was run against a
  // real server process.
  return () => {
    child.stdout.off('data', onServerData);
    process.stdin.off('data', onEditorData);
    process.stdin.pause();
  };
}

/**
 * A TCP variant, for editors that speak these protocols over a socket rather than over stdio.
 *
 * Same contract, same ordering. Returns the server so a caller can close it.
 */
export function createSocketProxy(
  kind: ProtocolKind,
  listenPort: number,
  target: { host: string; port: number },
  store: ProtocolStore = protocolStore,
  options: ProxyOptions = {},
): Server {
  const observe = kind === 'lsp' ? observeLspMessage : observeDapMessage;

  const server = createServer((clientSocket: Socket) => {
    const upstream = new (require('node:net').Socket)() as Socket;
    const fromServer = new MessageFramer();
    const fromClient = new MessageFramer();

    // Per connection, because a socket-based adapter is one debug session and the recorder's
    // sequence numbers, pending probes and stop history all belong to that session.
    const deep = kind === 'dap' && options.deep === true
      ? wireDeepDap(options.recorder ?? debugRecorder, (bytes) => upstream.write(bytes), store)
      : undefined;

    upstream.connect(target.port, target.host);

    clientSocket.on('data', (chunk: Buffer) => {
      upstream.write(chunk);
      for (const { message } of fromClient.push(chunk)) {
        try {
          if (deep) deep.fromEditor(message);
          else observe(message, store);
        } catch { /* best effort */ }
      }
    });
    upstream.on('data', (chunk: Buffer) => {
      if (deep) {
        for (const { raw, message } of fromServer.pushRaw(chunk)) {
          let forward = true;
          if (message) {
            try { forward = deep.fromAdapter(message); } catch { forward = true; }
          }
          if (forward) clientSocket.write(raw);
        }
        return;
      }
      clientSocket.write(chunk);
      for (const { message } of fromServer.push(chunk)) {
        try { observe(message, store); } catch { /* best effort */ }
      }
    });

    const close = () => {
      clientSocket.destroy();
      upstream.destroy();
    };
    clientSocket.on('error', close);
    clientSocket.on('close', close);
    upstream.on('error', close);
    upstream.on('close', close);
  });

  server.listen(listenPort);
  return server;
}

/**
 * The adapter that surfaces whatever the proxies have seen.
 *
 * It contributes no editors and no workspaces — it does not know or care which editor is upstream.
 * What it contributes is diagnostics and debug state, at `live` confidence, because they came from
 * the tool that computed them rather than from a file someone wrote earlier.
 */
export class ProtocolAdapter implements Adapter {
  readonly id = 'protocol';
  readonly name = 'LSP / DAP';
  readonly confidence = 'live' as const;
  readonly capabilities = { ...NO_CAPABILITIES, diagnostics: true, debug: true };

  private readonly store: ProtocolStore;

  constructor(store: ProtocolStore = protocolStore) {
    this.store = store;
  }

  async probe(): Promise<boolean> {
    return this.store.isActive;
  }

  async capture(_options: CaptureOptions): Promise<AdapterResult> {
    const diagnostics = this.store.allDiagnostics();
    const debug = this.store.debugState();

    const editors = debug
      ? [{
          adapter: this.id,
          name: `Debug session${debug.adapterType ? ` (${debug.adapterType})` : ''}`,
          workspaces: [],
          documents: [],
          debug,
          confidence: this.confidence,
        }]
      : [];

    const servers = [...this.store.servers];
    return {
      editors,
      diagnostics,
      warnings: [],
      detail: `${diagnostics.length} diagnostic(s)` +
        (debug ? `, debug ${debug.status}` : '') +
        (servers.length ? `, from ${servers.join(', ')}` : ''),
    };
  }
}
