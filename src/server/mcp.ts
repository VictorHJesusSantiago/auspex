import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import type { Adapter, CaptureOptions } from '../core/adapter.ts';
import type { Snapshot } from '../core/model.ts';
import { capture, defaultAdapters, summarize, SCHEMA_VERSION } from '../core/snapshot.ts';
import { fitToBudget, estimateTokens } from '../core/budget.ts';
import { Redactor } from '../core/redact.ts';
import { extractOutline } from '../languages/outline.ts';
import { readTextFile } from '../platform/files.ts';
import { readGitState } from '../vcs/git.ts';
import { readSession } from '../core/debug-store.ts';
import type { DebugSessionRecord, DebugStop, DebugVariable } from '../core/debug-model.ts';
import { analyseSession } from '../debug/analysis.ts';
import { journalPath, readStops, summarizeJournal } from '../debug/journal.ts';
import { findLaunchConfigurations, recommendAdapters, wiringFor } from '../debug/launch-config.ts';
import { readStopSource } from '../debug/source-context.ts';
import { debugReport } from '../ai/debug-report.ts';
import { analyseConcurrency, renderConcurrency } from '../debug/concurrency.ts';
import { decodeMemory } from '../debug/memory-decode.ts';
import { queryJournal, queryRecord, trajectory, trajectoryFromJournal } from '../debug/query.ts';
import { inferShape, interpretValue, renderCollectionSummary, summarizeCollection } from '../debug/values.ts';
import { adapterById } from '../debug/registry.ts';

/**
 * A Model Context Protocol server.
 *
 * **This is the primary way an AI plugs into Auspex, and MCP is the right protocol for it.** It is
 * an open specification with implementations across the major assistants, it is transport-agnostic
 * (this server speaks the stdio transport, which is what desktop clients launch), and — the part
 * that matters most here — it is *pull-based*. The assistant asks for what it needs when it needs
 * it, rather than being handed a fixed blob at the start of a conversation. A developer's editor
 * state changes every few seconds; a snapshot pasted into a prompt is stale before the first reply.
 *
 * The protocol itself is JSON-RPC 2.0 with a small set of methods, implemented directly here rather
 * than through an SDK. That is consistent with the rest of the project having no dependencies, and
 * the protocol is small enough that the implementation is shorter than the integration would be.
 *
 * **Assistants that do not speak MCP** are served by `server/http.ts`, which exposes the same
 * capabilities as plain JSON endpoints with an OpenAPI description — which is what GPT and Gemini
 * function-calling want. Neither is privileged; they are two doors into the same house.
 */

const PROTOCOL_VERSION = '2024-11-05';

/** A JSON-RPC request or notification. */
interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** One MCP tool: a name, a description, and a JSON Schema for its arguments. */
interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface McpServerOptions {
  adapters?: Adapter[];
  captureOptions?: CaptureOptions;
  redact?: boolean;
  /** Where to write diagnostics. Never stdout: that is the protocol channel. */
  log?: (message: string) => void;
}

/**
 * The server.
 *
 * Kept as a class with an injectable adapter list so tests can drive it against fixtures rather
 * than against whatever happens to be running on the machine.
 */
export class McpServer {
  private adapters: Adapter[] | undefined;
  private readonly options: McpServerOptions;
  private readonly log: (message: string) => void;
  private cached: { snapshot: Snapshot; at: number } | undefined;

  /**
   * How long a capture is reused.
   *
   * An assistant routinely calls three or four tools in one turn, and re-scanning the disk for each
   * would make a single question take ten seconds. Two seconds is short enough that nothing
   * observable goes stale within one turn and long enough to collapse a burst into one scan.
   */
  cacheMs = 2000;

  constructor(options: McpServerOptions = {}) {
    this.options = options;
    // stderr, deliberately and non-negotiably: stdout carries the protocol, and one stray log line
    // written there corrupts the stream and disconnects the client.
    this.log = options.log ?? ((message) => process.stderr.write(`${message}\n`));
  }

  /** Runs the stdio transport until the input stream closes. */
  async serveStdio(): Promise<void> {
    const input = createInterface({ input: process.stdin, terminal: false });
    this.log(`auspex mcp server ready (schema ${SCHEMA_VERSION})`);

    for await (const line of input) {
      if (!line.trim()) continue;

      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        this.send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
        continue;
      }

      const response = await this.handle(message);
      if (response) this.send(response);
    }
  }

  /** Handles one message, returning a response or undefined for a notification. */
  async handle(message: JsonRpcMessage): Promise<JsonRpcMessage | undefined> {
    const { id, method, params } = message;

    // A notification has no id and expects no reply. `initialized` is the common one.
    const isNotification = id === undefined || id === null;

    try {
      switch (method) {
        case 'initialize':
          return this.reply(id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {
              tools: { listChanged: false },
              resources: { subscribe: false, listChanged: false },
            },
            serverInfo: { name: 'auspex', version: SCHEMA_VERSION },
          });

        case 'initialized':
        case 'notifications/initialized':
          return undefined;

        case 'tools/list':
          return this.reply(id, {
            tools: this.tools().map(({ name, description, inputSchema }) => ({
              name, description, inputSchema,
            })),
          });

        case 'tools/call': {
          const name = String(params?.name ?? '');
          const tool = this.tools().find((candidate) => candidate.name === name);
          if (!tool) {
            return this.fail(id, -32602, `unknown tool '${name}'`);
          }
          const args = (params?.arguments ?? {}) as Record<string, unknown>;
          const result = await tool.handler(args);

          // MCP returns tool output as content blocks. JSON is serialized into a text block, which
          // is what every client renders and what a model reads best.
          return this.reply(id, {
            content: [{
              type: 'text',
              text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
            }],
          });
        }

        case 'resources/list':
          return this.reply(id, { resources: await this.resources() });

        case 'resources/read': {
          const uri = String(params?.uri ?? '');
          const contents = await this.readResource(uri);
          if (!contents) return this.fail(id, -32602, `unknown resource '${uri}'`);
          return this.reply(id, { contents: [contents] });
        }

        case 'ping':
          return this.reply(id, {});

        default:
          if (isNotification) return undefined;
          return this.fail(id, -32601, `method not found: ${method}`);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.log(`error handling ${method}: ${detail}`);
      return isNotification ? undefined : this.fail(id, -32603, detail);
    }
  }

  // -- Tools ------------------------------------------------------------------------------------

  /**
   * The tool set.
   *
   * Chosen to match the questions an assistant actually has, rather than mirroring the data model.
   * `get_context` answers "what is happening"; `get_file` answers "show me that"; `search` answers
   * "where is that"; `get_diagnostics` answers "what is broken". A tool per model type would be
   * tidier and far less useful.
   */
  private tools(): ToolDefinition[] {
    return [
      {
        name: 'get_context',
        description:
          'The current state of the developer environment: which editors are open, which projects, ' +
          'which files are being edited, what is broken, and what version control says. This is the ' +
          'first thing to call to understand what the user is working on.',
        inputSchema: {
          type: 'object',
          properties: {
            maxTokens: {
              type: 'number',
              description: 'Budget for the response. The snapshot is reduced by a documented priority order to fit.',
              default: 8000,
            },
            includeTree: { type: 'boolean', description: 'Include project file trees.', default: true },
            includeDiff: { type: 'boolean', description: 'Include the git working-tree diff.', default: false },
            root: { type: 'string', description: 'Restrict to one workspace path.' },
          },
        },
        handler: async (args) => {
          const snapshot = await this.snapshot({
            includeTree: args.includeTree !== false,
            includeDiff: args.includeDiff === true,
            roots: typeof args.root === 'string' ? [args.root] : undefined,
          });
          const maxTokens = Number(args.maxTokens) || 8000;
          const { snapshot: fitted, estimatedTokens, dropped } = fitToBudget(snapshot, { maxTokens });
          return { ...fitted, _budget: { estimatedTokens, maxTokens, dropped } };
        },
      },
      {
        name: 'get_open_files',
        description:
          'Just the files currently open in the editor, most relevant first, with the active one ' +
          'marked and the caret position where it is known. Much smaller than get_context.',
        inputSchema: {
          type: 'object',
          properties: {
            includeText: { type: 'boolean', description: 'Include file contents.', default: false },
            limit: { type: 'number', default: 20 },
          },
        },
        handler: async (args) => {
          const snapshot = await this.snapshot({ includeTree: false, includeVcs: false });
          const limit = Number(args.limit) || 20;
          const documents = snapshot.documents.slice(0, limit);

          if (args.includeText === true) {
            const redactor = new Redactor(this.options.redact !== false);
            for (const document of documents) {
              if (document.text) continue;
              if (redactor.isSensitiveFile(document.path)) {
                redactor.noteSkipped(document.path);
                continue;
              }
              const text = await readTextFile(document.path, 256 * 1024);
              if (text) document.text = redactor.redact(text);
            }
          }
          return { documents, total: snapshot.documents.length };
        },
      },
      {
        name: 'get_diagnostics',
        description:
          'Errors and warnings currently reported by compilers and linters, worst first. Empty when ' +
          'no language server or editor plugin is connected — which is itself worth knowing.',
        inputSchema: {
          type: 'object',
          properties: {
            severity: { type: 'string', enum: ['error', 'warning', 'information', 'hint'] },
            file: { type: 'string', description: 'Restrict to one file.' },
            limit: { type: 'number', default: 50 },
          },
        },
        handler: async (args) => {
          const snapshot = await this.snapshot({ includeTree: false, includeVcs: false });
          let diagnostics = snapshot.diagnostics;

          if (typeof args.severity === 'string') {
            diagnostics = diagnostics.filter((d) => d.severity === args.severity);
          }
          if (typeof args.file === 'string') {
            const needle = args.file.replace(/\\/g, '/');
            diagnostics = diagnostics.filter((d) => d.file.includes(needle));
          }
          return {
            diagnostics: diagnostics.slice(0, Number(args.limit) || 50),
            total: diagnostics.length,
            sources: snapshot.provenance
              .filter((report) => report.status === 'ok')
              .map((report) => report.adapter),
          };
        },
      },
      {
        name: 'get_file',
        description:
          'Read one file, with an optional structural outline. Works for any language, markup, ' +
          'stylesheet or data format. Secrets are redacted and files that exist only to hold ' +
          'credentials are refused by name.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path to the file.' },
            outline: { type: 'boolean', description: 'Include a symbol outline instead of the full text.', default: false },
            maxBytes: { type: 'number', default: 262144 },
          },
          required: ['path'],
        },
        handler: async (args) => {
          const path = String(args.path ?? '');
          const redactor = new Redactor(this.options.redact !== false);

          if (redactor.isSensitiveFile(path)) {
            return {
              path,
              refused: true,
              reason: 'this file exists to hold credentials; its names may be listed but its values are not served',
            };
          }
          const text = await readTextFile(path, Number(args.maxBytes) || 262144);
          if (text === undefined) {
            return { path, error: 'not readable as text, too large, or does not exist' };
          }

          if (args.outline === true) {
            const outline = extractOutline(path, text);
            return { path, outline: outline.symbols, source: outline.source, note: outline.note };
          }
          return {
            path,
            text: redactor.redact(text),
            lines: text.split('\n').length,
            redactions: redactor.report(),
          };
        },
      },
      {
        name: 'search',
        description:
          'Find text across the open workspaces. Returns matching lines with their file and line ' +
          'number. Use this rather than guessing at paths.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            regex: { type: 'boolean', default: false },
            caseSensitive: { type: 'boolean', default: false },
            limit: { type: 'number', default: 50 },
          },
          required: ['query'],
        },
        handler: async (args) => this.search(args),
      },
      {
        name: 'get_git_status',
        description:
          'Version-control state for a workspace: branch, upstream divergence, changed files, ' +
          'recent commits, and whether a rebase or merge is in progress.',
        inputSchema: {
          type: 'object',
          properties: {
            root: { type: 'string', description: 'Workspace path. Defaults to the first open one.' },
            includeDiff: { type: 'boolean', default: false },
          },
        },
        handler: async (args) => {
          let root = typeof args.root === 'string' ? args.root : undefined;
          if (!root) {
            const snapshot = await this.snapshot({ includeTree: false, includeVcs: false });
            root = snapshot.workspaces[0]?.root ?? process.cwd();
          }
          const state = await readGitState(root, { includeDiff: args.includeDiff === true });
          const redactor = new Redactor(this.options.redact !== false);
          return redactor.redactValue(state);
        },
      },
      {
        name: 'get_debug_briefing',
        description:
          'A prose briefing on the paused program: why it stopped, where, the source at that ' +
          'line, the values in scope, what changed since the last stop, and observations worth ' +
          'checking. START HERE for any question about a running or crashed program — it is a ' +
          'fraction of the size of get_debug_session and usually answers the question on its own. ' +
          'Use the structured tools afterwards for a specific value it did not include.',
        inputSchema: {
          type: 'object',
          properties: {
            session: { type: 'string', description: 'Session id. Defaults to the most recent.' },
            maxTokens: { type: 'number', default: 6000, description: 'Reduce it to fit a budget.' },
            includeMemory: { type: 'boolean', default: false },
          },
        },
        handler: async (args) => {
          const record = await readSession(typeof args.session === 'string' ? args.session : undefined);
          if (!record) return wiringHelp();

          // Read from disk at report time rather than at capture time: the file may have been
          // edited since the program stopped, and what the reader will be asked to change is what
          // is on disk now.
          const sources = record.currentStop
            ? await readStopSource(record.currentStop, {
              redactor: new Redactor(this.options.redact !== false),
            })
            : {};

          return debugReport(record, {
            sources,
            maxTokens: typeof args.maxTokens === 'number' ? args.maxTokens : 6000,
            includeMemory: args.includeMemory === true,
          });
        },
      },
      {
        name: 'get_debug_analysis',
        description:
          'Observations about the current stop, each carrying the evidence that produced it: a ' +
          'null value used on the executing line, breakpoints that never bound, recursion, a stop ' +
          'repeated inside a loop, frames that are runtime rather than user code. These are FACTS ' +
          'WITH EVIDENCE, not diagnoses — check any of them before acting on it.',
        inputSchema: {
          type: 'object',
          properties: {
            session: { type: 'string' },
            minSeverity: { type: 'string', enum: ['high', 'medium', 'low', 'info'], default: 'low' },
          },
        },
        handler: async (args) => {
          const record = await readSession(typeof args.session === 'string' ? args.session : undefined);
          if (!record) return wiringHelp();

          const sources = record.currentStop ? await readStopSource(record.currentStop) : {};
          const analysis = analyseSession(record, { sources });

          const rank = { high: 0, medium: 1, low: 2, info: 3 };
          const floor = rank[(typeof args.minSeverity === 'string' ? args.minSeverity : 'low') as keyof typeof rank] ?? 2;

          return {
            headline: analysis.headline,
            findings: analysis.findings.filter((finding) => rank[finding.severity] <= floor),
            userFrames: analysis.userFrames.map((frame) =>
              `${frame.name} (${frame.file ?? '?'}:${frame.line ?? '?'})`),
            runtimeFrameCount: analysis.runtimeFrameCount,
            note: 'Observations with evidence, not conclusions. Verify before acting.',
          };
        },
      },
      {
        name: 'get_debug_history',
        description:
          'Earlier stops from the session journal, including ones the live record has already ' +
          'evicted. Use this when the question is about what happened BEFORE a failure, or to ' +
          'compare a working iteration against a failing one. Needs the proxy to have been run ' +
          'with --journal.',
        inputSchema: {
          type: 'object',
          properties: {
            session: { type: 'string' },
            from: { type: 'number', default: 1, description: 'First stop index.' },
            to: { type: 'number' },
            limit: { type: 'number', default: 10 },
          },
        },
        handler: async (args) => {
          const session = typeof args.session === 'string' ? args.session : undefined;
          const record = await readSession(session);
          const path = journalPath(session ?? record?.sessionId ?? 'proxy');
          const summary = await summarizeJournal(path).catch(() => undefined);

          if (!summary || summary.bytes === 0) {
            return {
              stops: [],
              note:
                'No journal for this session. The live record keeps only recent stops; to keep ' +
                'the whole history, run the proxy with `--journal`.',
            };
          }
          const stops = await readStops(path, {
            from: typeof args.from === 'number' ? args.from : 1,
            to: typeof args.to === 'number' ? args.to : undefined,
            limit: typeof args.limit === 'number' ? args.limit : 10,
          });
          return {
            summary,
            stops: stops.map((stop) => ({
              index: stop.index,
              at: stop.at,
              reason: stop.reason,
              exception: stop.exception
                ? { type: stop.exception.typeName, message: stop.exception.message }
                : undefined,
              // Summarized rather than returned whole: ten full stops would be enormous, and the
              // caller can ask for one index at a time once they know which matters.
              top: Object.values(stop.stacks)[0]?.slice(0, 3)
                .map((frame) => `${frame.name} (${frame.file ?? '?'}:${frame.line ?? '?'})`),
            })),
          };
        },
      },
      {
        name: 'get_debug_wiring',
        description:
          'How to capture a debug session for this project: the launch configurations it already ' +
          'defines, the debug adapter each implies, and the exact command that puts Auspex in ' +
          'between. Call this whenever a debug tool reports no session — it turns "not ' +
          'configured" into something the user can run.',
        inputSchema: {
          type: 'object',
          properties: {
            root: { type: 'string', description: 'Workspace path. Defaults to the first open one.' },
          },
        },
        handler: async (args) => {
          let root = typeof args.root === 'string' ? args.root : undefined;
          let languages: string[] = [];

          if (!root) {
            const snapshot = await this.snapshot({ includeTree: true, includeVcs: false });
            root = snapshot.workspaces[0]?.root ?? process.cwd();
            languages = Object.keys(snapshot.workspaces[0]?.languages ?? {});
          }

          const configurations = await findLaunchConfigurations(root);
          return {
            root,
            configurations: configurations.map((configuration) => ({
              name: configuration.name,
              type: configuration.type,
              request: configuration.request,
              source: configuration.source,
              adapter: configuration.adapter?.name,
              notes: configuration.adapter?.notes,
              wiring: wiringFor(configuration),
            })),
            recommendations: configurations.length === 0
              ? recommendAdapters(languages).map((item) => ({
                language: item.language,
                adapters: item.adapters.map((adapter) => ({
                  name: adapter.name,
                  command: adapter.command
                    ? `${adapter.command.program} ${adapter.command.args.join(' ')}`
                    : undefined,
                  install: adapter.command?.install,
                  extension: adapter.extensionHint,
                })),
              }))
              : undefined,
            note: configurations.length === 0
              ? 'This project defines no launch configuration; the recommendations are by language.'
              : undefined,
          };
        },
      },
      {
        name: 'search_debug_history',
        description:
          'Search EVERY captured stop, not just the current one — by variable name, by value, by ' +
          'type, or by interpreted kind (every null in any language\'s spelling, every error ' +
          'value, every empty collection). No IDE debugger can answer historical questions like ' +
          '"was user ever non-null" or "which iteration first had an empty list"; this can, ' +
          'because the session was recorded rather than only watched.',
        inputSchema: {
          type: 'object',
          properties: {
            session: { type: 'string' },
            name: { type: 'string', description: 'Substring of the variable name.' },
            value: { type: 'string', description: 'Substring of the value.' },
            type: { type: 'string', description: 'Substring of the declared type.' },
            kind: {
              type: 'string',
              enum: ['empty', 'error', 'collection', 'map', 'string', 'scalar', 'pointer',
                'future', 'lazy', 'function', 'binary', 'object', 'optional', 'opaque'],
              description: 'Interpreted kind, which works across languages: `empty` matches null, nil, None, undefined, nullptr and Nothing alike.',
            },
            scope: { type: 'string' },
            frame: { type: 'string', description: 'Restrict to frames whose function name matches.' },
            fromStop: { type: 'number' },
            toStop: { type: 'number' },
            limit: { type: 'number', default: 50 },
          },
        },
        handler: async (args) => {
          const query = {
            name: asText(args.name), value: asText(args.value), type: asText(args.type),
            kind: asText(args.kind) as never, scope: asText(args.scope), frame: asText(args.frame),
            fromStop: typeof args.fromStop === 'number' ? args.fromStop : undefined,
            toStop: typeof args.toStop === 'number' ? args.toStop : undefined,
            limit: typeof args.limit === 'number' ? args.limit : 50,
          };
          if (!query.name && !query.value && !query.type && !query.kind) {
            return { matches: [], note: 'give at least one of name, value, type or kind' };
          }

          const session = asText(args.session);
          const record = await readSession(session);
          const path = journalPath(session ?? record?.sessionId ?? 'proxy');
          const journal = await summarizeJournal(path).catch(() => undefined);

          // The journal covers the whole session; the record is a bounded ring. Preferring the
          // journal is what makes "never" mean never rather than "not in the last twenty stops".
          if (journal && journal.bytes > 0) return queryJournal(path, query);
          if (!record) return noSession();
          return queryRecord(record, query);
        },
      },
      {
        name: 'trace_debug_variable',
        description:
          'One variable\'s entire history through the session: every value it held, in order, ' +
          'with the stop and line where each change happened. "retries was 0, 0, 1, 2, 3 and then ' +
          'the exception" is a description of a bug, and no debugger can produce it — you would ' +
          'have to write the values down while stepping. Use this for any question about how a ' +
          'value got to be what it is.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Variable name, or a dotted path like request.user.id.' },
            session: { type: 'string' },
          },
          required: ['path'],
        },
        handler: async (args) => {
          const variablePath = asText(args.path);
          if (!variablePath) return { note: 'a variable path is required' };

          const session = asText(args.session);
          const record = await readSession(session);
          const path = journalPath(session ?? record?.sessionId ?? 'proxy');
          const journal = await summarizeJournal(path).catch(() => undefined);

          if (journal && journal.bytes > 0) return trajectoryFromJournal(path, variablePath);
          if (!record) return noSession();

          const history = trajectory(
            [...record.stops, ...(record.currentStop ? [record.currentStop] : [])],
            variablePath,
          );
          return {
            ...history,
            note: record.totals.stops > record.stops.length + 1
              ? `read from the live record, which holds ${record.stops.length + 1} of ` +
                `${record.totals.stops} stop(s); run the proxy with --journal for the whole session`
              : undefined,
          };
        },
      },
      {
        name: 'get_debug_threads',
        description:
          'Threads grouped by what each is doing — running user code, blocked on a lock, waiting ' +
          'on I/O, parked in a pool — rather than as a flat list. A Go server has thousands of ' +
          'goroutines and a thread pool has forty identical stacks; this turns that into a handful ' +
          'of meaningful groups and names the threads in your own code. Also reports the ' +
          'structural signature of a deadlock, as a possibility with the evidence, never a claim.',
        inputSchema: {
          type: 'object',
          properties: { session: { type: 'string' } },
        },
        handler: async (args) => {
          const record = await readSession(asText(args.session));
          if (!record?.currentStop) return noSession();

          const report = analyseConcurrency(record.currentStop, {
            adapter: record.adapterType ? adapterById(record.adapterType) : undefined,
          });
          return {
            ...report,
            rendered: renderConcurrency(report).join('\n'),
          };
        },
      },
      {
        name: 'explain_debug_values',
        description:
          'What the values in a frame actually ARE, beyond the string the debugger printed: the ' +
          'kind (collection, map, pointer, null, error, unresolved future, lazy sequence) in any ' +
          'language, an inferred structural shape for dynamically typed values, and a statistical ' +
          'summary for large collections instead of the first hundred elements. Use this when a ' +
          'value looks opaque or when a collection is too big to read.',
        inputSchema: {
          type: 'object',
          properties: {
            session: { type: 'string' },
            frameId: { type: 'number', description: 'Defaults to the top frame.' },
            name: { type: 'string', description: 'Only this variable.' },
          },
        },
        handler: async (args) => {
          const record = await readSession(asText(args.session));
          const stop = record?.currentStop;
          if (!stop) return noSession();

          const frameId = typeof args.frameId === 'number'
            ? args.frameId
            : Number(Object.keys(stop.frames)[0]);
          const wanted = asText(args.name)?.toLowerCase();

          return {
            frameId,
            scopes: (stop.frames[frameId] ?? []).map((scope) => ({
              name: scope.name,
              skipped: scope.skipped,
              variables: scope.variables
                .filter((variable) => !wanted || variable.name.toLowerCase().includes(wanted))
                .map((variable) => {
                  const interpreted = interpretValue(variable.value, variable.type);
                  const declared = variable.indexedVariables ?? interpreted.size ?? 0;

                  return {
                    name: variable.name,
                    value: variable.value,
                    declaredType: variable.type,
                    kind: interpreted.kind,
                    confidence: interpreted.confidence,
                    because: interpreted.because,
                    size: interpreted.size,
                    unresolved: interpreted.incomplete,
                    // Only computed where it says something: a shape for an untyped value, a
                    // summary for a collection too large to read.
                    shape: !variable.type && variable.children?.length
                      ? inferShape(variable).shape
                      : undefined,
                    summary: (interpreted.kind === 'collection' || interpreted.kind === 'map') && declared > 6
                      ? renderCollectionSummary(summarizeCollection(variable, declared))
                      : undefined,
                  };
                }),
            })),
          };
        },
      },
      {
        name: 'decode_debug_memory',
        description:
          'Reads captured memory EVERY plausible way at once — C string, UTF-16, length-prefixed, ' +
          'integer arrays at each width, floats, pointer tables — and reports which readings are ' +
          'self-consistent, with a score and the reason. Also recognizes debug fill patterns: ' +
          '0xCDCDCDCD is uninitialized heap and 0xDDDDDDDD is memory that was already freed, ' +
          'which means the bug is a use-after-free and is already found.',
        inputSchema: {
          type: 'object',
          properties: {
            session: { type: 'string' },
            reference: { type: 'string', description: 'One memory reference. Defaults to all captured.' },
            endianness: { type: 'string', enum: ['little', 'big'] },
            pointerSize: { type: 'number', enum: [4, 8] },
          },
        },
        handler: async (args) => {
          const record = await readSession(asText(args.session));
          if (!record) return noSession();

          const dumps = record.currentStop?.memory ?? [];
          const reference = asText(args.reference);
          const selected = reference ? dumps.filter((dump) => dump.reference === reference) : dumps;

          if (selected.length === 0) {
            return {
              blocks: [],
              note: dumps.length === 0
                ? 'no memory was captured at this stop'
                : `no captured block has the reference ${reference}`,
            };
          }
          return {
            blocks: selected.map((dump) => decodeMemory(dump, {
              endianness: args.endianness === 'big' ? 'big' : 'little',
              pointerSize: args.pointerSize === 4 ? 4 : 8,
            })),
            note: 'Scores are self-consistency, not truth. Several readings can be plausible at once.',
          };
        },
      },
      {
        name: 'get_debug_session',
        description:
          'The live debug session in full: why it stopped, every thread, the call stack, every ' +
          'scope and variable of the stopped frame, the exception, loaded modules, breakpoints ' +
          'and program output. Call this before reasoning about a paused program — a stack trace ' +
          'pasted into chat is a summary, this is the state.',
        inputSchema: {
          type: 'object',
          properties: {
            session: { type: 'string', description: 'Session id. Defaults to the most recent.' },
            includeTimeline: { type: 'boolean', default: false,
              description: 'Include every protocol message that crossed the wire.' },
            includeMemory: { type: 'boolean', default: false,
              description: 'Include raw memory dumps behind variables that have an address.' },
            maxDepth: { type: 'number', default: 3,
              description: 'How deep to include variable trees. Lower this if the reply is large.' },
          },
        },
        handler: async (args) => {
          const record = await readSession(typeof args.session === 'string' ? args.session : undefined);
          if (!record) return noSession();

          return shapeSession(record, {
            timeline: args.includeTimeline === true,
            memory: args.includeMemory === true,
            depth: typeof args.maxDepth === 'number' ? args.maxDepth : 3,
          });
        },
      },
      {
        name: 'get_debug_variables',
        description:
          'Variables at the paused program, optionally filtered by name. Use this instead of ' +
          'get_debug_session when you already know which value you are chasing — it returns the ' +
          'full tree for the matches rather than a truncated view of everything.',
        inputSchema: {
          type: 'object',
          properties: {
            session: { type: 'string' },
            frameId: { type: 'number', description: 'Defaults to the top frame.' },
            scope: { type: 'string', description: 'Scope name, e.g. Locals. Defaults to all.' },
            name: { type: 'string', description: 'Substring match on the variable name.' },
            maxDepth: { type: 'number', default: 6 },
          },
        },
        handler: async (args) => {
          const record = await readSession(typeof args.session === 'string' ? args.session : undefined);
          if (!record?.currentStop) return noSession();

          const stop = record.currentStop;
          const frameId = typeof args.frameId === 'number'
            ? args.frameId
            : Number(Object.keys(stop.frames)[0]);
          const scopes = stop.frames[frameId] ?? [];
          const wanted = typeof args.name === 'string' ? args.name.toLowerCase() : undefined;
          const depth = typeof args.maxDepth === 'number' ? args.maxDepth : 6;

          return {
            stop: stop.index,
            frameId,
            scopes: scopes
              .filter((scope) => typeof args.scope !== 'string' || scope.name === args.scope)
              .map((scope) => ({
                name: scope.name,
                skipped: scope.skipped,
                variables: (wanted
                  ? filterVariables(scope.variables, wanted)
                  : scope.variables).map((variable) => trimVariable(variable, depth)),
              })),
          };
        },
      },
      {
        name: 'get_debug_changes',
        description:
          'What changed between the last two times the program stopped: which frames it entered ' +
          'and left, and which variables were added, removed or took a new value. This is the ' +
          'question a stepping developer is actually asking, and neither snapshot alone answers it.',
        inputSchema: {
          type: 'object',
          properties: {
            session: { type: 'string' },
            count: { type: 'number', default: 1, description: 'How many recent comparisons.' },
          },
        },
        handler: async (args) => {
          const record = await readSession(typeof args.session === 'string' ? args.session : undefined);
          if (!record) return noSession();

          const count = typeof args.count === 'number' ? Math.max(1, args.count) : 1;
          if (record.diffs.length === 0) {
            return {
              diffs: [],
              note: record.totals.stops < 2
                ? 'the program has stopped fewer than twice; there is nothing to compare yet'
                : 'no comparisons recorded',
            };
          }
          return { diffs: record.diffs.slice(-count) };
        },
      },
      {
        name: 'get_debug_timeline',
        description:
          'Every Debug Adapter Protocol message that crossed the wire, in order, with direction, ' +
          'size and round-trip timing. Use it to see what the editor asked for and what the ' +
          'debugger answered — including the requests Auspex issued itself, marked as probes.',
        inputSchema: {
          type: 'object',
          properties: {
            session: { type: 'string' },
            limit: { type: 'number', default: 100 },
            direction: { type: 'string', enum: ['in', 'out', 'probe'] },
            name: { type: 'string', description: 'Filter by command or event name.' },
          },
        },
        handler: async (args) => {
          const record = await readSession(typeof args.session === 'string' ? args.session : undefined);
          if (!record) return noSession();

          const limit = typeof args.limit === 'number' ? args.limit : 100;
          let entries = record.timeline;
          if (typeof args.direction === 'string') {
            entries = entries.filter((entry) => entry.direction === args.direction);
          }
          if (typeof args.name === 'string') {
            const wanted = args.name.toLowerCase();
            entries = entries.filter((entry) => entry.name.toLowerCase().includes(wanted));
          }
          return {
            totals: record.totals,
            // The ring buffer is bounded, so say when the beginning is already gone rather than
            // letting a reader assume it is looking at the whole session.
            truncated: record.timeline.length >= 2000
              ? 'the timeline is a bounded ring; earlier messages have been evicted'
              : undefined,
            entries: entries.slice(-limit),
          };
        },
      },
      {
        name: 'read_debug_memory',
        description:
          'Raw memory captured behind variables that carry an address, as hex and printable text. ' +
          'Only native adapters (lldb, gdb, cppdbg) report addresses; managed runtimes do not.',
        inputSchema: {
          type: 'object',
          properties: {
            session: { type: 'string' },
            reference: { type: 'string', description: 'Memory reference. Defaults to all captured.' },
          },
        },
        handler: async (args) => {
          const record = await readSession(typeof args.session === 'string' ? args.session : undefined);
          if (!record) return noSession();

          const dumps = record.currentStop?.memory ?? [];
          if (dumps.length === 0) {
            return {
              dumps: [],
              note: record.capabilities?.supportsReadMemory
                ? 'no variable at this stop carried a memory address'
                : 'this debug adapter does not support reading memory',
            };
          }
          return {
            dumps: typeof args.reference === 'string'
              ? dumps.filter((dump) => dump.reference === args.reference)
              : dumps,
          };
        },
      },
      {
        name: 'list_editors',
        description:
          'Which editors and IDEs are running, what each can report, and how current that ' +
          'information is. Call this when a question about the environment comes back thin.',
        inputSchema: { type: 'object', properties: {} },
        handler: async () => {
          const snapshot = await this.snapshot({ includeTree: false, includeVcs: false });
          return {
            editors: snapshot.editors.map((editor) => ({
              name: editor.name,
              adapter: editor.adapter,
              version: editor.version,
              pid: editor.pid,
              confidence: editor.confidence,
              workspaces: editor.workspaces.map((workspace) => workspace.root),
              documentCount: editor.documents.length,
            })),
            provenance: snapshot.provenance,
            summary: summarize(snapshot),
          };
        },
      },
    ];
  }

  // -- Resources --------------------------------------------------------------------------------

  /**
   * MCP resources: things an assistant can read by URI rather than call as a function.
   *
   * The open files are exposed this way as well as through a tool, because the two access patterns
   * suit different clients — some surface resources to the user as attachable context, which is
   * exactly the right affordance for "the file I am looking at".
   */
  private async resources(): Promise<Array<Record<string, unknown>>> {
    const snapshot = await this.snapshot({ includeTree: false, includeVcs: false });

    return [
      {
        uri: 'auspex://context',
        name: 'Development context',
        description: summarize(snapshot),
        mimeType: 'application/json',
      },
      ...snapshot.documents.slice(0, 20).map((document) => ({
        uri: `auspex://file/${encodeURIComponent(document.path)}`,
        name: document.path.split('/').pop() ?? document.path,
        description: `${document.languageId}${document.active ? ' (active)' : ''}${document.dirty ? ' (unsaved)' : ''}`,
        mimeType: 'text/plain',
      })),
    ];
  }

  private async readResource(uri: string): Promise<Record<string, unknown> | undefined> {
    if (uri === 'auspex://context') {
      const snapshot = await this.snapshot({});
      return { uri, mimeType: 'application/json', text: JSON.stringify(snapshot, null, 2) };
    }
    if (uri.startsWith('auspex://file/')) {
      const path = decodeURIComponent(uri.slice('auspex://file/'.length));
      const redactor = new Redactor(this.options.redact !== false);
      if (redactor.isSensitiveFile(path)) {
        return { uri, mimeType: 'text/plain', text: '[refused: this file holds credentials]' };
      }
      const text = await readTextFile(path, 512 * 1024);
      return text === undefined
        ? undefined
        : { uri, mimeType: 'text/plain', text: redactor.redact(text) };
    }
    return undefined;
  }

  // -- Internals --------------------------------------------------------------------------------

  /** Captures, reusing a recent snapshot when the options match the cached one. */
  private async snapshot(overrides: CaptureOptions): Promise<Snapshot> {
    const now = Date.now();
    // The cache is keyed on nothing but time, deliberately: the option variations between tool
    // calls in one turn are minor (tree on or off), and a stale-by-two-seconds tree is a far better
    // trade than four disk scans per question.
    if (this.cached && now - this.cached.at < this.cacheMs && !overrides.includeDiff) {
      return structuredClone(this.cached.snapshot);
    }

    this.adapters ??= this.options.adapters ?? await defaultAdapters();
    const snapshot = await capture(
      this.adapters,
      { ...this.options.captureOptions, ...overrides },
      new Redactor(this.options.redact !== false),
    );

    if (!overrides.includeDiff) this.cached = { snapshot, at: now };
    return snapshot;
  }

  /**
   * Searches the open workspaces.
   *
   * Implemented in-process rather than by shelling out to ripgrep: a dependency on an external
   * binary would be exactly the kind of thing that works on the author's machine and not on the
   * user's. It is slower, and the file budget below is what keeps that from mattering.
   */
  private async search(args: Record<string, unknown>): Promise<unknown> {
    const query = String(args.query ?? '');
    if (!query) return { matches: [], error: 'query is required' };

    const limit = Number(args.limit) || 50;
    const snapshot = await this.snapshot({ includeTree: true, includeVcs: false, maxFiles: 6000 });

    const pattern = args.regex === true
      ? new RegExp(query, args.caseSensitive === true ? 'g' : 'gi')
      : undefined;
    const needle = args.caseSensitive === true ? query : query.toLowerCase();

    const matches: Array<{ file: string; line: number; text: string }> = [];
    const redactor = new Redactor(this.options.redact !== false);

    const files: string[] = [];
    for (const workspace of snapshot.workspaces) {
      collectFiles(workspace.tree, files);
    }

    for (const file of files.slice(0, 4000)) {
      if (matches.length >= limit) break;
      if (redactor.isSensitiveFile(file)) continue;

      const text = await readTextFile(file, 1024 * 1024);
      if (!text) continue;

      const lines = text.split('\n');
      for (let i = 0; i < lines.length && matches.length < limit; i++) {
        const line = lines[i]!;
        const hit = pattern
          ? pattern.test(line)
          : (args.caseSensitive === true ? line : line.toLowerCase()).includes(needle);
        if (pattern) pattern.lastIndex = 0;

        if (hit) {
          matches.push({ file, line: i + 1, text: redactor.redact(line.trim().slice(0, 300)) });
        }
      }
    }
    return { matches, searched: Math.min(files.length, 4000), truncated: matches.length >= limit };
  }

  private reply(id: JsonRpcMessage['id'], result: unknown): JsonRpcMessage {
    return { jsonrpc: '2.0', id: id ?? null, result };
  }

  private fail(id: JsonRpcMessage['id'], code: number, message: string): JsonRpcMessage {
    return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
  }

  private send(message: JsonRpcMessage): void {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  }
}

/** Flattens a file tree into paths. */
function collectFiles(node: Snapshot['workspaces'][number]['tree'], out: string[]): void {
  if (!node) return;
  if (node.type === 'file') {
    out.push(node.path);
    return;
  }
  for (const child of node.children ?? []) collectFiles(child, out);
}

/**
 * The configuration snippet a user pastes into their assistant to connect.
 *
 * Provided as a function rather than as documentation prose because the paths differ per machine,
 * and a config a user has to hand-edit is a config a user gets wrong.
 */
export function mcpClientConfig(entryPoint: string): string {
  return JSON.stringify({
    mcpServers: {
      auspex: {
        command: process.execPath,
        args: [entryPoint, 'mcp'],
      },
    },
  }, null, 2);
}

/** Exported for tests: a round trip through the handler without any transport. */
export async function callTool(
  server: McpServer,
  name: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const response = await server.handle({
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args },
  });
  const result = response?.result as { content?: Array<{ text?: string }> } | undefined;
  const text = result?.content?.[0]?.text;
  if (text === undefined) return response?.error ?? undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Reads a file relative to the package, for the GUI and the config helper. */
export async function readPackageFile(relativePath: string): Promise<string> {
  const url = new URL(`../../${relativePath}`, import.meta.url);
  return readFile(url, 'utf8');
}

export { estimateTokens };


// ---------------------------------------------------------------------------------------------
// Debug shaping
// ---------------------------------------------------------------------------------------------

/**
 * The same answer every debug tool gives when nothing has been captured.
 *
 * It says how to fix it, because "no debug session" with no further help is the kind of dead end
 * that makes a tool look broken when it is merely unconfigured.
 */
function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function noSession(): Record<string, unknown> {
  return {
    session: null,
    note:
      'No debug session has been captured. Auspex captures one by sitting between the editor and ' +
      'its debug adapter: run `auspex proxy --dap --deep -- <debug adapter command>` and point ' +
      'the editor at that instead of at the adapter.',
    nextTool: 'get_debug_wiring',
  };
}

/**
 * The same, for the tools that return prose.
 *
 * Points at `get_debug_wiring` rather than restating the generic instruction, because the generic
 * instruction is the part the user already could not act on — the whole difficulty is finding out
 * what their editor runs, and that is what the other tool answers.
 */
function wiringHelp(): string {
  return [
    'No debug session has been captured.',
    '',
    'Auspex captures one by sitting between the editor and its debug adapter:',
    '',
    '    auspex proxy --dap --deep -- <the debug adapter command your editor would run>',
    '',
    'If you do not know what that command is — which is usual, because editors launch adapters',
    'out of extension directories — call the `get_debug_wiring` tool. It reads this project\'s',
    'launch configurations and returns the exact command for each.',
  ].join('\n');
}

/** Reduces a session record to something worth sending, at the requested variable depth. */
function shapeSession(
  record: DebugSessionRecord,
  options: { timeline: boolean; memory: boolean; depth: number },
): Record<string, unknown> {
  const stop = record.currentStop;

  return {
    sessionId: record.sessionId,
    adapterType: record.adapterType,
    startMethod: record.startMethod,
    status: record.status,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    totals: record.totals,
    capabilities: record.capabilities
      ? { ...record.capabilities, raw: undefined }   // The raw block is large and adds nothing here.
      : undefined,
    stop: stop ? shapeStop(stop, options.depth, options.memory) : undefined,
    lastChange: record.diffs[record.diffs.length - 1],
    breakpoints: record.breakpoints,
    modules: record.modules.slice(0, 50),
    output: record.output.slice(-100),
    evaluations: record.evaluations.slice(-20),
    timeline: options.timeline ? record.timeline.slice(-200) : undefined,
    warnings: record.warnings,
  };
}

function shapeStop(stop: DebugStop, depth: number, memory: boolean): Record<string, unknown> {
  const frames: Record<number, unknown> = {};
  for (const [frameId, scopes] of Object.entries(stop.frames)) {
    frames[Number(frameId)] = scopes.map((scope) => ({
      name: scope.name,
      presentationHint: scope.presentationHint,
      skipped: scope.skipped,
      variables: scope.variables.map((variable) => trimVariable(variable, depth)),
    }));
  }

  return {
    index: stop.index,
    at: stop.at,
    reason: stop.reason,
    description: stop.description,
    text: stop.text,
    threadId: stop.threadId,
    allThreadsStopped: stop.allThreadsStopped,
    hitBreakpointIds: stop.hitBreakpointIds,
    threads: stop.threads,
    stacks: stop.stacks,
    frames,
    exception: stop.exception,
    disassembly: stop.disassembly,
    memory: memory ? stop.memory : undefined,
    captureMs: stop.captureMs,
    incomplete: stop.incomplete,
  };
}

/**
 * Cuts a variable tree to a depth, marking where it was cut.
 *
 * The mark is the point. A tree that simply ends looks like a leaf, and an assistant told that
 * `config` is `{}` when it is really forty keys deep will confidently draw the wrong conclusion.
 */
function trimVariable(variable: DebugVariable, depth: number): DebugVariable {
  if (!variable.children || variable.children.length === 0) return variable;
  if (depth <= 0) {
    return {
      ...variable,
      children: undefined,
      truncated: variable.truncated ?? `${variable.children.length} child(ren) not shown at this depth`,
    };
  }
  return { ...variable, children: variable.children.map((child) => trimVariable(child, depth - 1)) };
}

/** Every variable whose name matches, at any depth, keeping the path that leads to it. */
function filterVariables(variables: DebugVariable[], wanted: string): DebugVariable[] {
  const matches: DebugVariable[] = [];

  for (const variable of variables) {
    if (variable.name.toLowerCase().includes(wanted)) {
      matches.push(variable);
      continue;      // A match is returned whole; no need to also search inside it separately.
    }
    if (variable.children) {
      const inner = filterVariables(variable.children, wanted);
      if (inner.length > 0) matches.push({ ...variable, children: inner });
    }
  }
  return matches;
}
