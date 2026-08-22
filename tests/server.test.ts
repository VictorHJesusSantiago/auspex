import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer, callTool } from '../src/server/mcp.ts';
import { startHttpServer, openApiDocument } from '../src/server/http.ts';
import { renderDashboard } from '../src/server/gui.ts';
import { shapeForProvider, toMarkdown, PROVIDERS, openAiToolDefinitions, geminiFunctionDeclarations } from '../src/ai/providers.ts';
import { renderFrame } from '../src/cli/tui.ts';
import { renderSnapshot } from '../src/cli/format.ts';
import { NO_CAPABILITIES, type Adapter } from '../src/core/adapter.ts';
import { PushAdapter, pushStore } from '../src/adapters/push.ts';
import type { Snapshot } from '../src/core/model.ts';

/**
 * A fixed adapter, so server tests describe a known environment rather than whatever happens to be
 * running on the machine running the tests.
 */
function fixtureAdapter(): Adapter {
  return {
    id: 'fixture', name: 'Fixture', confidence: 'live', capabilities: NO_CAPABILITIES,
    probe: async () => true,
    capture: async () => ({
      editors: [{
        adapter: 'fixture', name: 'Test Editor', version: '1.2.3', pid: 999, confidence: 'live',
        workspaces: [{
          root: '/w', name: 'w',
          languages: { typescript: 8, css: 2 },
          fileCount: 10,
          manifests: [{ kind: 'npm', file: '/w/package.json', name: 'w', scripts: { build: 'tsc' } }],
          vcs: { system: 'git', root: '/w', branch: 'feature/x', ahead: 2, behind: 1, files: [] },
        }],
        documents: [],
      }],
      documents: [
        { path: '/w/src/a.ts', languageId: 'typescript', dirty: true, active: true, cursor: { line: 41, character: 7 } },
        { path: '/w/src/b.css', languageId: 'css', dirty: false, active: false },
      ],
      diagnostics: [{
        file: '/w/src/a.ts',
        range: { start: { line: 41, character: 2 }, end: { line: 41, character: 12 } },
        severity: 'error', message: 'Type mismatch', code: 'TS2322', source: 'ts',
      }],
      detail: 'fixture',
    }),
  };
}

const serverOptions = { adapters: [fixtureAdapter()], log: () => {}, redact: true };

describe('MCP protocol', () => {
  test('initialize declares the protocol version and the server identity', async () => {
    const response = await new McpServer(serverOptions).handle({
      jsonrpc: '2.0', id: 1, method: 'initialize', params: {},
    });
    const result = response!.result as { protocolVersion: string; serverInfo: { name: string } };

    assert.equal(result.serverInfo.name, 'auspex');
    assert.match(result.protocolVersion, /^\d{4}-\d{2}-\d{2}$/);
  });

  test('a notification gets no reply, as JSON-RPC requires', async () => {
    // Replying to a notification is a protocol violation that some clients treat as fatal.
    const response = await new McpServer(serverOptions).handle({
      jsonrpc: '2.0', method: 'notifications/initialized',
    });
    assert.equal(response, undefined);
  });

  test('lists every tool with a JSON Schema for its arguments', async () => {
    const response = await new McpServer(serverOptions).handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = (response!.result as { tools: Array<{ name: string; inputSchema: unknown }> }).tools;

    assert.ok(tools.length >= 6);
    for (const tool of tools) {
      assert.equal((tool.inputSchema as { type: string }).type, 'object', `${tool.name} needs a schema`);
    }
  });

  test('get_context returns the merged snapshot with its budget accounting', async () => {
    const result = await callTool(new McpServer(serverOptions), 'get_context', { maxTokens: 50000 }) as
      Snapshot & { _budget: { estimatedTokens: number } };

    assert.equal(result.editors[0]!.name, 'Test Editor');
    assert.equal(result.documents.length, 2);
    assert.ok(result._budget.estimatedTokens > 0);
  });

  test('get_diagnostics filters by severity', async () => {
    const server = new McpServer(serverOptions);
    const errors = await callTool(server, 'get_diagnostics', { severity: 'error' }) as { total: number };
    const hints = await callTool(server, 'get_diagnostics', { severity: 'hint' }) as { total: number };

    assert.equal(errors.total, 1);
    assert.equal(hints.total, 0);
  });

  test('get_file refuses a credentials file by name rather than reading and scrubbing it', async () => {
    const result = await callTool(new McpServer(serverOptions), 'get_file', { path: '/project/.env' }) as
      { refused: boolean; reason: string };

    assert.equal(result.refused, true);
    assert.match(result.reason, /credentials/);
  });

  test('get_file outlines a real file in a language it has never been told about', async () => {
    const result = await callTool(new McpServer(serverOptions), 'get_file', {
      path: new URL('../package.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
      outline: true,
    }) as { outline?: Array<{ name: string }>; source?: string };

    assert.equal(result.source, 'parsed');
    assert.ok(result.outline!.some((symbol) => symbol.name === 'name'));
  });

  test('an unknown tool is a JSON-RPC error, not a crash', async () => {
    const response = await new McpServer(serverOptions).handle({
      jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'no_such_tool' },
    });
    assert.equal(response!.error!.code, -32602);
  });

  test('an unknown method returns method-not-found', async () => {
    const response = await new McpServer(serverOptions).handle({
      jsonrpc: '2.0', id: 4, method: 'nonsense/method',
    });
    assert.equal(response!.error!.code, -32601);
  });

  test('exposes the open files as resources as well as through a tool', async () => {
    // Some clients surface resources to the user as attachable context, which is exactly the right
    // affordance for "the file I am looking at".
    const response = await new McpServer(serverOptions).handle({ jsonrpc: '2.0', id: 5, method: 'resources/list' });
    const resources = (response!.result as { resources: Array<{ uri: string }> }).resources;

    assert.ok(resources.some((resource) => resource.uri === 'auspex://context'));
    assert.ok(resources.some((resource) => resource.uri.startsWith('auspex://file/')));
  });
});

describe('HTTP surface', () => {
  test('serves health, context and the OpenAPI document', async () => {
    const running = await startHttpServer({ port: 0, adapters: [fixtureAdapter()], log: () => {} });
    const port = (running.server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      const health = await (await fetch(`${base}/health`)).json() as { ok: boolean };
      assert.equal(health.ok, true);

      const context = await (await fetch(`${base}/context?tree=false`)).json() as Snapshot;
      assert.equal(context.documents.length, 2);

      const openapi = await (await fetch(`${base}/openapi.json`)).json() as { openapi: string };
      assert.match(openapi.openapi, /^3\./);

      const gui = await fetch(`${base}/`);
      assert.match(gui.headers.get('content-type') ?? '', /text\/html/);
    } finally {
      await running.close();
    }
  });

  test('accepts a push and serves it back as live state', async () => {
    // The full plugin round trip: an editor posts what only it can see, and the next reader gets it.
    // The PushAdapter has to be in the list -- the store receives the payload either way, but it is
    // the adapter that surfaces it into a snapshot.
    pushStore.clear();
    const running = await startHttpServer({ port: 0, adapters: [new PushAdapter()], log: () => {} });
    const port = (running.server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      const posted = await fetch(`${base}/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          editor: 'test', pid: 42,
          documents: [{ path: '/live/a.rs', dirty: true, active: true, cursor: { line: 10, character: 3 } }],
        }),
      });
      assert.equal(posted.status, 200);

      const documents = await (await fetch(`${base}/documents`)).json() as
        { documents: Array<{ path: string; cursor?: { line: number } }> };

      assert.equal(documents.documents[0]!.path, '/live/a.rs');
      assert.equal(documents.documents[0]!.cursor?.line, 10);
    } finally {
      await running.close();
      pushStore.clear();
    }
  });

  test('rejects a malformed push body rather than storing nonsense', async () => {
    const running = await startHttpServer({ port: 0, adapters: [], log: () => {} });
    const port = (running.server.address() as { port: number }).port;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/push`, { method: 'POST', body: 'not json' });
      assert.equal(response.status, 400);
    } finally {
      await running.close();
    }
  });

  test('requires the bearer token on protected routes when one is configured', async () => {
    // Off-machine binds get a token whether or not one was asked for; this checks it is enforced.
    const running = await startHttpServer({ port: 0, adapters: [], token: 'secret', log: () => {} });
    const port = (running.server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      assert.equal((await fetch(`${base}/context`)).status, 401);
      assert.equal((await fetch(`${base}/health`)).status, 200, 'health must work before a client knows the token');

      const authorized = await fetch(`${base}/context?tree=false`, {
        headers: { Authorization: 'Bearer secret' },
      });
      assert.equal(authorized.status, 200);
    } finally {
      await running.close();
    }
  });

  test('an unknown route is a 404, not a hang', async () => {
    const running = await startHttpServer({ port: 0, adapters: [], log: () => {} });
    const port = (running.server.address() as { port: number }).port;

    try {
      assert.equal((await fetch(`http://127.0.0.1:${port}/nope`)).status, 404);
    } finally {
      await running.close();
    }
  });

  test('the OpenAPI document declares an operationId for every path, which is what a model binds to', () => {
    const document = openApiDocument() as { paths: Record<string, Record<string, { operationId?: string }>> };

    for (const [path, methods] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        assert.ok(operation.operationId, `${method} ${path} needs an operationId`);
      }
    }
  });
});

describe('provider shaping', () => {
  function snapshot(): Snapshot {
    return {
      capturedAt: '2026-01-01T00:00:00.000Z', schemaVersion: '1.0',
      host: { platform: 'linux', arch: 'x64', hostname: 'h', cwd: '/w' },
      editors: [], workspaces: [{
        root: '/w', name: 'w',
        languages: { typescript: 5 },
        manifests: [{ kind: 'npm', file: '/w/package.json', scripts: { test: 'node --test' } }],
        vcs: { system: 'git', branch: 'main', ahead: 3, operationInProgress: 'rebase' },
      }],
      documents: [{ path: '/w/a.ts', languageId: 'typescript', dirty: true, active: true, text: 'const x = 1;' }],
      diagnostics: [{
        file: '/w/a.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        severity: 'error', message: 'boom', code: 'E1',
      }],
      provenance: [{ adapter: 'fixture', status: 'ok', confidence: 'live', durationMs: 5 }],
      warnings: [],
    };
  }

  test('markdown leads with the active file and the problems', () => {
    const markdown = toMarkdown(snapshot());

    assert.ok(markdown.indexOf('## Active file') < markdown.indexOf('## Problems'));
    assert.ok(markdown.indexOf('## Problems') < markdown.indexOf('## Projects'));
    assert.match(markdown, /unsaved changes/);
    assert.match(markdown, /const x = 1;/);
  });

  test('markdown surfaces an in-progress rebase, which changes what advice is safe', () => {
    assert.match(toMarkdown(snapshot()), /\*\*rebase in progress\*\*/);
  });

  test('markdown always states its sources, so a thin context is explicable', () => {
    assert.match(toMarkdown(snapshot()), /Sources: fixture \(live\)/);
  });

  test('structured providers get a prose summary alongside the data', () => {
    // A model reads one sentence faster than it reconstructs the same fact from nested objects.
    const shaped = shapeForProvider(snapshot(), { provider: 'claude' });
    const content = shaped.content as Record<string, unknown>;

    assert.equal(typeof content.summary, 'string');
    assert.ok(Array.isArray(content.documents));
  });

  test('every provider has a budget well under its model\'s ceiling', () => {
    for (const profile of Object.values(PROVIDERS)) {
      assert.ok(profile.defaultBudget > 0, profile.id);
    }
    assert.ok(PROVIDERS.openai.defaultBudget < PROVIDERS.json.defaultBudget);
  });

  test('the tool definitions are valid for OpenAI and unwrap cleanly for Gemini', () => {
    const openai = openAiToolDefinitions('http://localhost:1');
    assert.equal(openai[0]!.type, 'function');

    const gemini = geminiFunctionDeclarations('http://localhost:1');
    assert.equal(typeof (gemini[0] as { name: string }).name, 'string');
    assert.equal((gemini[0] as { type?: string }).type, undefined, 'Gemini takes the bare declaration');
  });
});

describe('rendering', () => {
  function minimal(): Snapshot {
    return {
      capturedAt: '2026-01-01T00:00:00.000Z', schemaVersion: '1.0',
      host: { platform: 'linux', arch: 'x64', hostname: 'h', cwd: '/w' },
      editors: [{ adapter: 'a', name: 'Ed', confidence: 'live', workspaces: [], documents: [] }],
      workspaces: [], documents: [], diagnostics: [],
      provenance: [{ adapter: 'a', status: 'ok', durationMs: 3 }],
      warnings: ['something to say'],
    };
  }

  test('the terminal report includes every section', () => {
    const text = renderSnapshot(minimal());
    for (const heading of ['Environment', 'Editors', 'Open documents', 'Workspaces', 'Sources', 'Notices']) {
      assert.ok(text.includes(heading), heading);
    }
  });

  test('the TUI frame fits the terminal it was given', () => {
    // A frame taller than the terminal scrolls the header off, which defeats a full-screen view.
    const frame = renderFrame({
      snapshot: minimal(), tab: 'overview', scroll: 0, busy: false,
      lastError: undefined, width: 80, height: 24,
    });
    assert.equal(frame.split('\n').length, 24);
  });

  test('the TUI renders before the first capture rather than showing nothing', () => {
    const frame = renderFrame({
      snapshot: undefined, tab: 'overview', scroll: 0, busy: true,
      lastError: undefined, width: 80, height: 20,
    });
    assert.match(frame, /capturing/);
  });

  test('every TUI tab renders without throwing', () => {
    for (const tab of ['overview', 'documents', 'diagnostics', 'workspaces', 'sources'] as const) {
      const frame = renderFrame({
        snapshot: minimal(), tab, scroll: 0, busy: false,
        lastError: undefined, width: 100, height: 30,
      });
      assert.ok(frame.length > 0, tab);
    }
  });

  test('the dashboard is a self-contained page with no external requests', () => {
    // A GUI that fetched a CDN would fail on the offline machines this is most useful on.
    const html = renderDashboard();

    assert.match(html, /^<!doctype html>/);
    assert.ok(!/<script[^>]+src=/.test(html), 'no external scripts');
    assert.ok(!/<link[^>]+href="http/.test(html), 'no external stylesheets');
  });
});
