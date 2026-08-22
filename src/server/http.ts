import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Adapter, CaptureOptions } from '../core/adapter.ts';
import type { Snapshot } from '../core/model.ts';
import { capture, defaultAdapters, summarize, SCHEMA_VERSION } from '../core/snapshot.ts';
import { fitToBudget } from '../core/budget.ts';
import { Redactor } from '../core/redact.ts';
import { extractOutline } from '../languages/outline.ts';
import { readTextFile } from '../platform/files.ts';
import { readGitState } from '../vcs/git.ts';
import { listSessions, publishSession, readSession } from '../core/debug-store.ts';
import type { DebugSessionRecord, DebugVariable } from '../core/debug-model.ts';
import { analyseSession } from '../debug/analysis.ts';
import { journalPath, readStops, summarizeJournal } from '../debug/journal.ts';
import { findLaunchConfigurations, recommendAdapters, wiringFor } from '../debug/launch-config.ts';
import { readStopSource } from '../debug/source-context.ts';
import { analyseConcurrency } from '../debug/concurrency.ts';
import { decodeMemory } from '../debug/memory-decode.ts';
import { queryJournal, queryRecord, trajectory, trajectoryFromJournal } from '../debug/query.ts';
import { interpretValue, inferShape, renderCollectionSummary, summarizeCollection } from '../debug/values.ts';
import { adapterById } from '../debug/registry.ts';
import { debugReport, debugSizeReport } from '../ai/debug-report.ts';
import { anthropicDebugTools, geminiDebugTools, openAiDebugTools } from '../ai/debug-tools.ts';
import { pushStore, type PushPayload } from '../adapters/push.ts';
import { renderDashboard } from './gui.ts';

/**
 * The HTTP surface: plain JSON for assistants that do not speak MCP, an ingest endpoint for editor
 * plugins, a server-sent-events stream for live consumers, and the GUI.
 *
 * **Why this exists alongside the MCP server.** MCP is the better protocol and the preferred door,
 * but it is not the only one in use: GPT and Gemini function-calling want an HTTP endpoint with a
 * schema, a shell script wants `curl`, and a plugin inside an editor wants to POST. Serving the
 * same capabilities over both is a few hundred lines and removes the question "does my assistant
 * support this".
 *
 * **Bound to loopback by default, and that is a security decision rather than a default.** This
 * server hands out source code, configuration and version-control state. Binding it to `0.0.0.0`
 * on a laptop that ever joins a coffee-shop network would publish a developer's entire working
 * context to that network. Listening on `127.0.0.1` means a process on the machine must already be
 * running to reach it; binding wider requires an explicit flag and prints a warning.
 *
 * A bearer token can be required on top of that, and is when the bind address is not loopback.
 */

export interface HttpServerOptions {
  port?: number;
  /** Interface to bind. Loopback unless deliberately widened. */
  host?: string;
  adapters?: Adapter[];
  captureOptions?: CaptureOptions;
  redact?: boolean;
  /** Shared secret required in `Authorization: Bearer <token>`. Generated when binding non-local. */
  token?: string;
  /** Allow requests from browser origins. Needed by the GUI when served from elsewhere. */
  cors?: boolean;
  log?: (message: string) => void;
}

export interface RunningServer {
  server: Server;
  url: string;
  token?: string;
  close: () => Promise<void>;
}

/** Starts the server and resolves once it is listening. */
export async function startHttpServer(options: HttpServerOptions = {}): Promise<RunningServer> {
  const port = options.port ?? 4278;
  const host = options.host ?? '127.0.0.1';
  const log = options.log ?? ((message: string) => process.stderr.write(`${message}\n`));

  const isLocal = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  // A non-loopback bind gets a token whether or not one was asked for. Refusing to serve without
  // authentication off-machine is the only responsible default for a service whose payload is
  // someone's source tree.
  const token = options.token ?? (isLocal ? undefined : randomUUID());

  if (!isLocal) {
    log(`WARNING: binding to ${host}, which is reachable from the network.`);
    log(`         A bearer token is required: ${token}`);
  }

  const adapters = options.adapters ?? await defaultAdapters();
  const clients = new Set<ServerResponse>();

  const server = createServer((request, response) => {
    handleRequest(request, response, { ...options, adapters, token, clients, log })
      .catch((error) => {
        log(`request failed: ${error instanceof Error ? error.message : error}`);
        if (!response.headersSent) sendJson(response, 500, { error: 'internal error' });
      });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  return {
    server,
    url: `http://${host === '::1' ? '[::1]' : host}:${port}`,
    token,
    close: () => new Promise<void>((resolve) => {
      for (const client of clients) client.end();
      server.close(() => resolve());
    }),
  };
}

interface RequestContext extends HttpServerOptions {
  adapters: Adapter[];
  clients: Set<ServerResponse>;
  log: (message: string) => void;
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: RequestContext,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (context.cors || true) {
    // CORS is permitted because the server is loopback-bound and token-protected off-machine; the
    // GUI and any local tool should be able to reach it without a proxy.
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  if (request.method === 'OPTIONS') {
    response.writeHead(204).end();
    return;
  }

  // The GUI and the health check are the only unauthenticated routes: one is a static page, and
  // the other must work before a client knows whether it has the right token.
  const openRoutes = new Set(['/', '/health', '/openapi.json']);
  if (context.token && !openRoutes.has(path)) {
    const header = request.headers.authorization ?? '';
    if (header !== `Bearer ${context.token}`) {
      sendJson(response, 401, { error: 'a bearer token is required' });
      return;
    }
  }

  switch (`${request.method} ${path}`) {
    case 'GET /':
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(renderDashboard());
      return;

    case 'GET /health':
      sendJson(response, 200, {
        ok: true,
        schemaVersion: SCHEMA_VERSION,
        adapters: context.adapters.map((adapter) => adapter.id),
        pushClients: pushStore.size,
      });
      return;

    case 'GET /openapi.json':
      sendJson(response, 200, openApiDocument());
      return;

    case 'GET /context': {
      const snapshot = await runCapture(context, {
        includeTree: url.searchParams.get('tree') !== 'false',
        includeDiff: url.searchParams.get('diff') === 'true',
        roots: url.searchParams.get('root') ? [url.searchParams.get('root')!] : undefined,
      });
      const maxTokens = Number(url.searchParams.get('maxTokens'));
      if (Number.isFinite(maxTokens) && maxTokens > 0) {
        const fitted = fitToBudget(snapshot, { maxTokens });
        sendJson(response, 200, { ...fitted.snapshot, _budget: fitted });
        return;
      }
      sendJson(response, 200, snapshot);
      return;
    }

    case 'GET /editors': {
      const snapshot = await runCapture(context, { includeTree: false, includeVcs: false });
      sendJson(response, 200, {
        editors: snapshot.editors,
        provenance: snapshot.provenance,
        summary: summarize(snapshot),
      });
      return;
    }

    case 'GET /documents': {
      const snapshot = await runCapture(context, { includeTree: false, includeVcs: false });
      sendJson(response, 200, { documents: snapshot.documents, total: snapshot.documents.length });
      return;
    }

    case 'GET /diagnostics': {
      const snapshot = await runCapture(context, { includeTree: false, includeVcs: false });
      const severity = url.searchParams.get('severity');
      const diagnostics = severity
        ? snapshot.diagnostics.filter((item) => item.severity === severity)
        : snapshot.diagnostics;
      sendJson(response, 200, { diagnostics, total: diagnostics.length });
      return;
    }

    case 'GET /file': {
      const target = url.searchParams.get('path');
      if (!target) {
        sendJson(response, 400, { error: 'path is required' });
        return;
      }
      const redactor = new Redactor(context.redact !== false);
      if (redactor.isSensitiveFile(target)) {
        sendJson(response, 200, {
          path: target,
          refused: true,
          reason: 'this file exists to hold credentials',
        });
        return;
      }
      const text = await readTextFile(target, 512 * 1024);
      if (text === undefined) {
        sendJson(response, 404, { path: target, error: 'not readable as text' });
        return;
      }
      if (url.searchParams.get('outline') === 'true') {
        const outline = extractOutline(target, text);
        sendJson(response, 200, { path: target, ...outline });
        return;
      }
      sendJson(response, 200, {
        path: target,
        text: redactor.redact(text),
        redactions: redactor.report(),
      });
      return;
    }

    case 'GET /git': {
      const root = url.searchParams.get('root') ?? process.cwd();
      const state = await readGitState(root, { includeDiff: url.searchParams.get('diff') === 'true' });
      sendJson(response, 200, new Redactor(context.redact !== false).redactValue(state));
      return;
    }

    case 'GET /debug': {
      const record = await readSession(url.searchParams.get('session') ?? undefined);
      if (!record) {
        sendJson(response, 200, {
          session: null,
          note: 'no debug session captured; run `auspex proxy --dap --deep -- <debug adapter>`',
        });
        return;
      }
      // The timeline and the memory dumps are the two things that can make this response enormous,
      // so both are opt-in. Everything else is always included: a caller asking for a debug session
      // wants the stack and the variables, and making those opt-in would be a trap.
      const includeTimeline = url.searchParams.get('timeline') === 'true';
      const includeMemory = url.searchParams.get('memory') === 'true';

      sendJson(response, 200, {
        ...record,
        timeline: includeTimeline ? record.timeline : undefined,
        timelineOmitted: includeTimeline ? undefined : record.timeline.length,
        currentStop: record.currentStop
          ? { ...record.currentStop, memory: includeMemory ? record.currentStop.memory : undefined }
          : undefined,
      });
      return;
    }

    case 'GET /debug/briefing': {
      const record = await readSession(url.searchParams.get('session') ?? undefined);
      if (!record) {
        sendText(response, 200,
          'No debug session captured.\n\n' +
          'Run `auspex proxy --dap --deep -- <debug adapter>` and point the editor at it.\n' +
          'Call /debug/wiring for the exact command for this project.');
        return;
      }
      // Source is read here rather than at capture time: the file may have been edited since the
      // program stopped, and the briefing should quote what is on disk now -- which is what the
      // reader will be asked to change.
      const sources = record.currentStop
        ? await readStopSource(record.currentStop, { redactor: new Redactor(context.redact !== false) })
        : {};
      const maxTokens = Number(url.searchParams.get('maxTokens'));

      sendText(response, 200, debugReport(record, {
        sources,
        maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : undefined,
        includeMemory: url.searchParams.get('includeMemory') === 'true',
      }));
      return;
    }

    case 'GET /debug/analysis': {
      const record = await readSession(url.searchParams.get('session') ?? undefined);
      if (!record) {
        sendJson(response, 200, { findings: [], note: 'no debug session captured' });
        return;
      }
      const sources = record.currentStop ? await readStopSource(record.currentStop) : {};
      const analysis = analyseSession(record, { sources });

      const rank = { high: 0, medium: 1, low: 2, info: 3 };
      const minimum = rank[(url.searchParams.get('minSeverity') ?? 'low') as keyof typeof rank] ?? 2;

      sendJson(response, 200, {
        headline: analysis.headline,
        findings: analysis.findings.filter((finding) => rank[finding.severity] <= minimum),
        userFrames: analysis.userFrames.map((frame) =>
          `${frame.name} (${frame.file ?? '?'}:${frame.line ?? '?'})`),
        runtimeFrameCount: analysis.runtimeFrameCount,
      });
      return;
    }

    case 'GET /debug/variables': {
      const record = await readSession(url.searchParams.get('session') ?? undefined);
      const stop = record?.currentStop;
      if (!stop) {
        sendJson(response, 200, { scopes: [], note: 'no debug session captured' });
        return;
      }
      const frameParam = Number(url.searchParams.get('frameId'));
      const frameId = Number.isFinite(frameParam) && frameParam !== 0
        ? frameParam
        : Number(Object.keys(stop.frames)[0]);
      const wanted = url.searchParams.get('name')?.toLowerCase();
      const scopeName = url.searchParams.get('scope');

      sendJson(response, 200, {
        stop: stop.index,
        frameId,
        scopes: (stop.frames[frameId] ?? [])
          .filter((scope) => !scopeName || scope.name === scopeName)
          .map((scope) => ({
            name: scope.name,
            skipped: scope.skipped,
            variables: wanted ? filterByName(scope.variables, wanted) : scope.variables,
          })),
      });
      return;
    }

    case 'GET /debug/timeline': {
      const record = await readSession(url.searchParams.get('session') ?? undefined);
      if (!record) {
        sendJson(response, 200, { entries: [], note: 'no debug session captured' });
        return;
      }
      const direction = url.searchParams.get('direction');
      const name = url.searchParams.get('name')?.toLowerCase();
      const limit = Number(url.searchParams.get('limit')) || 100;

      let entries = record.timeline;
      if (direction) entries = entries.filter((entry) => entry.direction === direction);
      if (name) entries = entries.filter((entry) => entry.name.toLowerCase().includes(name));

      sendJson(response, 200, { totals: record.totals, entries: entries.slice(-limit) });
      return;
    }

    case 'GET /debug/memory': {
      const record = await readSession(url.searchParams.get('session') ?? undefined);
      const dumps = record?.currentStop?.memory ?? [];
      const reference = url.searchParams.get('reference');

      sendJson(response, 200, {
        dumps: reference ? dumps.filter((dump) => dump.reference === reference) : dumps,
        note: dumps.length === 0 ? 'no memory was captured at this stop' : undefined,
      });
      return;
    }

    case 'GET /debug/history': {
      const session = url.searchParams.get('session');
      const record = await readSession(session ?? undefined);
      const path = journalPath(session ?? record?.sessionId ?? 'proxy');

      const summary = await summarizeJournal(path).catch(() => undefined);
      if (!summary || summary.bytes === 0) {
        sendJson(response, 200, {
          stops: [],
          note: 'no journal for this session; run the proxy with --journal to keep full history',
        });
        return;
      }
      sendJson(response, 200, {
        summary,
        stops: await readStops(path, {
          from: Number(url.searchParams.get('from')) || 1,
          to: Number(url.searchParams.get('to')) || undefined,
          limit: Number(url.searchParams.get('limit')) || 10,
        }),
      });
      return;
    }

    case 'GET /debug/wiring': {
      const root = url.searchParams.get('root')
        ?? (await runCapture(context, { includeTree: false, includeVcs: false })).workspaces[0]?.root
        ?? process.cwd();

      const configurations = await findLaunchConfigurations(root);
      sendJson(response, 200, {
        root,
        configurations: configurations.map((configuration) => ({
          name: configuration.name,
          type: configuration.type,
          request: configuration.request,
          source: configuration.source,
          editor: configuration.editor,
          adapter: configuration.adapter?.name,
          wiring: wiringFor(configuration),
        })),
        // The fallback that keeps this useful on a project with no configuration at all, which is
        // exactly the project whose owner most needs telling what to run.
        recommendations: configurations.length === 0
          ? recommendAdapters(Object.keys(
            (await runCapture(context, { includeTree: true, includeVcs: false }))
              .workspaces[0]?.languages ?? {}))
            .map((item) => ({ language: item.language, adapters: item.adapters.map((a) => a.name) }))
          : undefined,
      });
      return;
    }

    case 'GET /debug/size': {
      const record = await readSession(url.searchParams.get('session') ?? undefined);
      if (!record) {
        sendText(response, 200, 'no debug session captured');
        return;
      }
      sendText(response, 200, debugSizeReport(record));
      return;
    }

    case 'GET /debug/tools': {
      const flavour = url.searchParams.get('provider') ?? 'openai';
      sendJson(response, 200, {
        provider: flavour,
        tools: flavour === 'gemini' ? geminiDebugTools()
          : flavour === 'anthropic' || flavour === 'claude' ? anthropicDebugTools()
          : openAiDebugTools(),
      });
      return;
    }

    case 'GET /debug/threads': {
      const record = await readSession(url.searchParams.get('session') ?? undefined);
      if (!record?.currentStop) {
        sendJson(response, 200, { groups: [], note: 'no debug session captured' });
        return;
      }
      sendJson(response, 200, analyseConcurrency(record.currentStop, {
        adapter: record.adapterType ? adapterById(record.adapterType) : undefined,
      }));
      return;
    }

    case 'GET /debug/search': {
      const query = {
        name: url.searchParams.get('name') ?? undefined,
        value: url.searchParams.get('value') ?? undefined,
        type: url.searchParams.get('type') ?? undefined,
        kind: (url.searchParams.get('kind') ?? undefined) as never,
        scope: url.searchParams.get('scope') ?? undefined,
        frame: url.searchParams.get('frame') ?? undefined,
        limit: Number(url.searchParams.get('limit')) || 50,
      };
      if (!query.name && !query.value && !query.type && !query.kind) {
        sendJson(response, 400, { error: 'give at least one of name, value, type or kind' });
        return;
      }

      const session = url.searchParams.get('session') ?? undefined;
      const record = await readSession(session);
      const path = journalPath(session ?? record?.sessionId ?? 'proxy');
      const journal = await summarizeJournal(path).catch(() => undefined);

      // The journal covers the whole session; the record is a bounded ring. Preferring it is what
      // lets a "no match" answer mean the session, not the last twenty stops.
      if (journal && journal.bytes > 0) {
        sendJson(response, 200, await queryJournal(path, query));
        return;
      }
      sendJson(response, 200, record ? queryRecord(record, query) : { matches: [], note: 'no session' });
      return;
    }

    case 'GET /debug/trace': {
      const variablePath = url.searchParams.get('path');
      if (!variablePath) {
        sendJson(response, 400, { error: 'path is required' });
        return;
      }
      const session = url.searchParams.get('session') ?? undefined;
      const record = await readSession(session);
      const path = journalPath(session ?? record?.sessionId ?? 'proxy');
      const journal = await summarizeJournal(path).catch(() => undefined);

      if (journal && journal.bytes > 0) {
        sendJson(response, 200, await trajectoryFromJournal(path, variablePath));
        return;
      }
      sendJson(response, 200, record
        ? trajectory([...record.stops, ...(record.currentStop ? [record.currentStop] : [])], variablePath)
        : { points: [], note: 'no session' });
      return;
    }

    case 'GET /debug/values': {
      const record = await readSession(url.searchParams.get('session') ?? undefined);
      const stop = record?.currentStop;
      if (!stop) {
        sendJson(response, 200, { scopes: [], note: 'no debug session captured' });
        return;
      }
      const frameParam = Number(url.searchParams.get('frameId'));
      const frameId = Number.isFinite(frameParam) && frameParam !== 0
        ? frameParam
        : Number(Object.keys(stop.frames)[0]);

      sendJson(response, 200, {
        frameId,
        scopes: (stop.frames[frameId] ?? []).map((scope) => ({
          name: scope.name,
          skipped: scope.skipped,
          variables: scope.variables.map((variable) => {
            const interpreted = interpretValue(variable.value, variable.type);
            const declared = variable.indexedVariables ?? interpreted.size ?? 0;
            return {
              name: variable.name,
              value: variable.value,
              declaredType: variable.type,
              kind: interpreted.kind,
              confidence: interpreted.confidence,
              because: interpreted.because,
              unresolved: interpreted.incomplete,
              shape: !variable.type && variable.children?.length ? inferShape(variable).shape : undefined,
              summary: (interpreted.kind === 'collection' || interpreted.kind === 'map') && declared > 6
                ? renderCollectionSummary(summarizeCollection(variable, declared))
                : undefined,
            };
          }),
        })),
      });
      return;
    }

    case 'GET /debug/memory/decode': {
      const record = await readSession(url.searchParams.get('session') ?? undefined);
      const dumps = record?.currentStop?.memory ?? [];
      const reference = url.searchParams.get('reference');
      const selected = reference ? dumps.filter((dump) => dump.reference === reference) : dumps;

      sendJson(response, 200, {
        blocks: selected.map((dump) => decodeMemory(dump, {
          endianness: url.searchParams.get('endianness') === 'big' ? 'big' : 'little',
          pointerSize: url.searchParams.get('pointerSize') === '4' ? 4 : 8,
        })),
        note: selected.length === 0
          ? 'no memory was captured at this stop'
          : 'scores are self-consistency, not truth',
      });
      return;
    }

    case 'GET /debug/sessions':
      sendJson(response, 200, { sessions: await listSessions() });
      return;

    case 'GET /debug/changes': {
      const record = await readSession(url.searchParams.get('session') ?? undefined);
      const count = Number(url.searchParams.get('count')) || 1;
      sendJson(response, 200, { diffs: record?.diffs.slice(-count) ?? [] });
      return;
    }

    case 'GET /events':
      startEventStream(response, context);
      return;

    case 'POST /push': {
      const body = await readBody(request);
      let payload: PushPayload;
      try {
        payload = JSON.parse(body) as PushPayload;
      } catch {
        sendJson(response, 400, { error: 'body must be JSON' });
        return;
      }
      const key = pushStore.ingest(payload);

      // A plugin that can see the debug protocol publishes whole sessions. Persisted the same way
      // the proxy's are, so every reader -- the CLI, the MCP tools, the briefing -- finds them
      // without knowing or caring which mechanism captured them.
      if (payload.debugSession && typeof payload.debugSession === 'object') {
        const session = payload.debugSession as unknown as DebugSessionRecord;
        if (session.sessionId) {
          await publishSession(session, new Redactor(context.redact !== false)).catch(() => {
            // A temp directory that cannot be written must not fail an editor's push.
          });
        }
      }
      broadcast(context.clients, 'push', {
        editor: payload.editor,
        documents: payload.documents?.length ?? 0,
      });
      sendJson(response, 200, { ok: true, key, staleAfterMs: pushStore.staleAfterMs });
      return;
    }

    default:
      sendJson(response, 404, { error: `no route for ${request.method} ${path}` });
  }
}

/** Sends plain text. Used by the briefing, which is prose and should not be JSON-escaped. */
function sendText(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

/** Every variable whose name matches at any depth, keeping the path that leads to it. */
function filterByName(variables: DebugVariable[], wanted: string): DebugVariable[] {
  const matches: DebugVariable[] = [];

  for (const variable of variables) {
    if (variable.name.toLowerCase().includes(wanted)) {
      matches.push(variable);
      continue;
    }
    if (variable.children) {
      const inner = filterByName(variable.children, wanted);
      if (inner.length > 0) matches.push({ ...variable, children: inner });
    }
  }
  return matches;
}

/** Runs a capture with the server's configured defaults. */
async function runCapture(context: RequestContext, overrides: CaptureOptions): Promise<Snapshot> {
  return capture(
    context.adapters,
    { ...context.captureOptions, ...overrides },
    new Redactor(context.redact !== false),
  );
}

/**
 * A server-sent-events stream.
 *
 * SSE rather than WebSockets on purpose: this is a one-directional feed of "something changed",
 * every browser and HTTP client speaks it natively, it survives proxies, and it reconnects by
 * itself. A WebSocket would add a handshake and a framing layer to carry strictly less.
 *
 * The stream carries change *notifications*, not snapshots. A consumer that wants the new state
 * asks for it — which keeps a chatty editor from pushing megabytes down every open stream.
 */
function startEventStream(response: ServerResponse, context: RequestContext): void {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    // Disables buffering in any reverse proxy sitting in front, which would otherwise hold events
    // until a buffer filled and make a live feed arrive in bursts.
    'X-Accel-Buffering': 'no',
  });
  response.write(`event: hello\ndata: ${JSON.stringify({ schemaVersion: SCHEMA_VERSION })}\n\n`);

  context.clients.add(response);

  // A comment line every twenty seconds. Not decoration: an idle connection through a NAT or a
  // proxy is dropped after a minute or so, and this is what keeps it alive.
  const heartbeat = setInterval(() => {
    response.write(': heartbeat\n\n');
  }, 20_000);
  heartbeat.unref?.();

  response.on('close', () => {
    clearInterval(heartbeat);
    context.clients.delete(response);
  });
}

function broadcast(clients: Set<ServerResponse>, event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try {
      client.write(payload);
    } catch {
      clients.delete(client);
    }
  }
}

/** Reads a request body with a size cap, so a runaway plugin cannot exhaust memory. */
async function readBody(request: IncomingMessage, maxBytes = 16 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of request) {
    total += (chunk as Buffer).length;
    if (total > maxBytes) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

/**
 * An OpenAPI description of the endpoints.
 *
 * This is the piece that makes the HTTP surface usable by GPT and Gemini function-calling without a
 * hand-written integration: both accept an OpenAPI document and derive their tool definitions from
 * it. Serving one is the difference between "works with any assistant" and "works with assistants
 * someone wrote a shim for".
 */
export function openApiDocument(): Record<string, unknown> {
  const jsonResponse = (description: string) => ({
    description,
    content: { 'application/json': { schema: { type: 'object' } } },
  });

  return {
    openapi: '3.1.0',
    info: {
      title: 'Auspex',
      version: SCHEMA_VERSION,
      description:
        'Reads the developer\'s live environment -- open editors, projects, files, diagnostics, ' +
        'version control -- from any IDE, and serves it in an editor-agnostic shape.',
    },
    servers: [{ url: '/' }],
    paths: {
      '/context': {
        get: {
          operationId: 'getContext',
          summary: 'The full development context: editors, workspaces, open files, diagnostics, git.',
          parameters: [
            { name: 'maxTokens', in: 'query', schema: { type: 'integer' }, description: 'Reduce the response to fit a context budget.' },
            { name: 'tree', in: 'query', schema: { type: 'boolean' }, description: 'Include file trees.' },
            { name: 'diff', in: 'query', schema: { type: 'boolean' }, description: 'Include the git diff.' },
            { name: 'root', in: 'query', schema: { type: 'string' }, description: 'Restrict to one workspace.' },
          ],
          responses: { 200: jsonResponse('A context snapshot.') },
        },
      },
      '/debug': {
        get: {
          operationId: 'getDebugSession',
          summary: 'The paused program in full: threads, call stacks, scopes, every variable, the exception, breakpoints and output.',
          parameters: [
            { name: 'session', in: 'query', schema: { type: 'string' }, description: 'Session id. Defaults to the most recent.' },
            { name: 'timeline', in: 'query', schema: { type: 'boolean' }, description: 'Include every protocol message that crossed the wire.' },
            { name: 'memory', in: 'query', schema: { type: 'boolean' }, description: 'Include raw memory dumps.' },
          ],
          responses: { 200: jsonResponse('A debug session record, or null when none was captured.') },
        },
      },
      '/debug/briefing': {
        get: {
          operationId: 'getDebugBriefing',
          summary: 'A prose briefing on the paused program, written for a model to read. Start here.',
          parameters: [
            { name: 'session', in: 'query', schema: { type: 'string' } },
            { name: 'maxTokens', in: 'query', schema: { type: 'integer' }, description: 'Reduce it to fit a budget.' },
            { name: 'includeMemory', in: 'query', schema: { type: 'boolean' } },
          ],
          responses: { 200: { description: 'Markdown.', content: { 'text/plain': { schema: { type: 'string' } } } } },
        },
      },
      '/debug/analysis': {
        get: {
          operationId: 'getDebugAnalysis',
          summary: 'Observations about the current stop, each with the evidence that produced it.',
          parameters: [
            { name: 'session', in: 'query', schema: { type: 'string' } },
            { name: 'minSeverity', in: 'query', schema: { type: 'string', enum: ['high', 'medium', 'low', 'info'] } },
          ],
          responses: { 200: jsonResponse('Findings, ranked.') },
        },
      },
      '/debug/variables': {
        get: {
          operationId: 'getDebugVariables',
          summary: 'Variables at the paused program, filtered by name and returned at full depth.',
          parameters: [
            { name: 'session', in: 'query', schema: { type: 'string' } },
            { name: 'name', in: 'query', schema: { type: 'string' }, description: 'Substring of the variable name.' },
            { name: 'scope', in: 'query', schema: { type: 'string' } },
            { name: 'frameId', in: 'query', schema: { type: 'integer' } },
          ],
          responses: { 200: jsonResponse('Scopes and their variables.') },
        },
      },
      '/debug/timeline': {
        get: {
          operationId: 'getDebugTimeline',
          summary: 'Every protocol message that crossed the wire, with direction, size and timing.',
          parameters: [
            { name: 'session', in: 'query', schema: { type: 'string' } },
            { name: 'limit', in: 'query', schema: { type: 'integer' } },
            { name: 'direction', in: 'query', schema: { type: 'string', enum: ['in', 'out', 'probe'] } },
            { name: 'name', in: 'query', schema: { type: 'string' } },
          ],
          responses: { 200: jsonResponse('Timeline entries and session totals.') },
        },
      },
      '/debug/memory': {
        get: {
          operationId: 'readDebugMemory',
          summary: 'Raw memory behind variables that carry an address, as hex and printable text.',
          parameters: [
            { name: 'session', in: 'query', schema: { type: 'string' } },
            { name: 'reference', in: 'query', schema: { type: 'string' } },
          ],
          responses: { 200: jsonResponse('Memory dumps, or a note saying why there are none.') },
        },
      },
      '/debug/history': {
        get: {
          operationId: 'getDebugHistory',
          summary: 'Earlier stops from the session journal, including ones the live record evicted.',
          parameters: [
            { name: 'session', in: 'query', schema: { type: 'string' } },
            { name: 'from', in: 'query', schema: { type: 'integer' } },
            { name: 'to', in: 'query', schema: { type: 'integer' } },
            { name: 'limit', in: 'query', schema: { type: 'integer' } },
          ],
          responses: { 200: jsonResponse('Journal summary and the stops in range.') },
        },
      },
      '/debug/wiring': {
        get: {
          operationId: 'getDebugWiring',
          summary: 'How to capture a debug session for this project: configurations, adapters, and the exact command.',
          parameters: [{ name: 'root', in: 'query', schema: { type: 'string' } }],
          responses: { 200: jsonResponse('Launch configurations with wiring instructions.') },
        },
      },
      '/debug/size': {
        get: {
          operationId: 'getDebugSize',
          summary: 'Where a debug record\'s context size is going.',
          parameters: [{ name: 'session', in: 'query', schema: { type: 'string' } }],
          responses: { 200: { description: 'Text.', content: { 'text/plain': { schema: { type: 'string' } } } } },
        },
      },
      '/debug/tools': {
        get: {
          operationId: 'getDebugToolDefinitions',
          summary: 'Tool definitions for the debug capabilities, in a provider\'s own shape.',
          parameters: [
            { name: 'provider', in: 'query', schema: { type: 'string', enum: ['openai', 'gemini', 'anthropic'] } },
          ],
          responses: { 200: jsonResponse('Tool definitions.') },
        },
      },
      '/debug/threads': {
        get: {
          operationId: 'getDebugThreads',
          summary: 'Threads grouped by what each is doing, with the structural signature of contention.',
          parameters: [{ name: 'session', in: 'query', schema: { type: 'string' } }],
          responses: { 200: jsonResponse('Thread groups and activity.') },
        },
      },
      '/debug/search': {
        get: {
          operationId: 'searchDebugHistory',
          summary: 'Search every captured stop by variable name, value, type or interpreted kind.',
          parameters: [
            { name: 'session', in: 'query', schema: { type: 'string' } },
            { name: 'name', in: 'query', schema: { type: 'string' } },
            { name: 'value', in: 'query', schema: { type: 'string' } },
            { name: 'type', in: 'query', schema: { type: 'string' } },
            { name: 'kind', in: 'query', schema: { type: 'string' }, description: 'empty, error, collection, map, pointer, future, lazy…' },
            { name: 'limit', in: 'query', schema: { type: 'integer' } },
          ],
          responses: { 200: jsonResponse('Matches across the session.') },
        },
      },
      '/debug/trace': {
        get: {
          operationId: 'traceDebugVariable',
          summary: 'One variable\'s whole history: every value it held, and where it changed.',
          parameters: [
            { name: 'path', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'session', in: 'query', schema: { type: 'string' } },
          ],
          responses: { 200: jsonResponse('The variable\'s trajectory.') },
        },
      },
      '/debug/values': {
        get: {
          operationId: 'explainDebugValues',
          summary: 'What the values are beyond the debugger\'s formatting: kind, inferred shape, collection statistics.',
          parameters: [
            { name: 'session', in: 'query', schema: { type: 'string' } },
            { name: 'frameId', in: 'query', schema: { type: 'integer' } },
          ],
          responses: { 200: jsonResponse('Interpreted values.') },
        },
      },
      '/debug/memory/decode': {
        get: {
          operationId: 'decodeDebugMemory',
          summary: 'Captured memory read every plausible way, scored, with debug fill patterns named.',
          parameters: [
            { name: 'session', in: 'query', schema: { type: 'string' } },
            { name: 'reference', in: 'query', schema: { type: 'string' } },
            { name: 'endianness', in: 'query', schema: { type: 'string', enum: ['little', 'big'] } },
            { name: 'pointerSize', in: 'query', schema: { type: 'integer', enum: [4, 8] } },
          ],
          responses: { 200: jsonResponse('Decoded readings.') },
        },
      },
      '/debug/changes': {
        get: {
          operationId: 'getDebugChanges',
          summary: 'What changed between the last two stops: frames entered and left, variables added, removed or altered.',
          parameters: [
            { name: 'session', in: 'query', schema: { type: 'string' } },
            { name: 'count', in: 'query', schema: { type: 'integer' } },
          ],
          responses: { 200: jsonResponse('Comparisons between consecutive stops.') },
        },
      },
      '/debug/sessions': {
        get: {
          operationId: 'listDebugSessions',
          summary: 'Every captured debug session, newest first.',
          responses: { 200: jsonResponse('Session files and when each was last written.') },
        },
      },
      '/editors': {
        get: {
          operationId: 'listEditors',
          summary: 'Which editors are running and how current each source is.',
          responses: { 200: jsonResponse('Editors and adapter provenance.') },
        },
      },
      '/documents': {
        get: {
          operationId: 'listDocuments',
          summary: 'Open files, most relevant first.',
          responses: { 200: jsonResponse('Open documents.') },
        },
      },
      '/diagnostics': {
        get: {
          operationId: 'listDiagnostics',
          summary: 'Compiler and linter problems, worst first.',
          parameters: [{ name: 'severity', in: 'query', schema: { type: 'string', enum: ['error', 'warning', 'information', 'hint'] } }],
          responses: { 200: jsonResponse('Diagnostics.') },
        },
      },
      '/file': {
        get: {
          operationId: 'readFile',
          summary: 'Read one file, or its structural outline. Secrets are redacted.',
          parameters: [
            { name: 'path', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'outline', in: 'query', schema: { type: 'boolean' } },
          ],
          responses: { 200: jsonResponse('File contents or outline.') },
        },
      },
      '/git': {
        get: {
          operationId: 'getGitStatus',
          summary: 'Branch, divergence, changed files and recent commits.',
          parameters: [
            { name: 'root', in: 'query', schema: { type: 'string' } },
            { name: 'diff', in: 'query', schema: { type: 'boolean' } },
          ],
          responses: { 200: jsonResponse('Version-control state.') },
        },
      },
      '/push': {
        post: {
          operationId: 'pushState',
          summary: 'Ingest live state from an editor plugin. Every field is optional.',
          requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
          responses: { 200: jsonResponse('Accepted.') },
        },
      },
      '/events': {
        get: {
          operationId: 'streamEvents',
          summary: 'Server-sent events announcing that state changed.',
          responses: { 200: { description: 'An SSE stream.' } },
        },
      },
    },
  };
}
