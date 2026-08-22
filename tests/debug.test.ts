import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DebugRecorder, buildDiff, flattenStop, readCapabilities, toHexDump, toPrintable } from '../src/adapters/debug.ts';
import { MessageFramer, frame, ProtocolStore, wireDeepDap } from '../src/adapters/protocols.ts';
import { renderDebugSession, renderDiff, renderStop } from '../src/cli/debug-format.ts';
import { readFile, unlink } from 'node:fs/promises';
import { listSessions, publishSession, readSession } from '../src/core/debug-store.ts';
import { Redactor } from '../src/core/redact.ts';
import { McpServer, callTool } from '../src/server/mcp.ts';
import type { DebugStop } from '../src/core/debug-model.ts';

/**
 * Tests for deep debug capture.
 *
 * The centrepiece is a **scripted fake debug adapter**: a small object that answers DAP requests
 * the way a real adapter would, including a variable graph with a genuine cycle in it. Testing the
 * recorder against a mock that returns whatever it is asked for would prove only that the code
 * runs; testing it against something that behaves like `debugpy` — answering `variables` with
 * references that lead back to themselves, refusing requests it does not implement, taking a
 * measurable moment to reply — is what catches the failures that matter.
 *
 * The properties being checked are the ones the design rests on, and each is checked by observing
 * behaviour rather than by restating the implementation:
 *
 * - the recorder's own responses never reach the editor;
 * - its sequence numbers never collide with the editor's;
 * - a cyclic object graph terminates, and says where it was cut;
 * - what changed between two stops is reported correctly, including what did not change;
 * - an adapter that refuses a request degrades the capture instead of breaking it.
 */

// ---------------------------------------------------------------------------------------------
// A scripted debug adapter
// ---------------------------------------------------------------------------------------------

interface FakeOptions {
  /** Commands the adapter refuses, as a real one refuses what it does not implement. */
  unsupported?: Set<string>;
  /** Capabilities to advertise. */
  capabilities?: Record<string, unknown>;
  /** Make the variable graph cyclic. */
  cyclic?: boolean;
}

/**
 * A debug adapter that answers like a real one.
 *
 * Threads, a three-frame stack, two scopes and a nested object whose child points back at its
 * parent. `readMemory` returns real bytes for the one variable that carries an address.
 */
class FakeAdapter {
  readonly sent: Array<Record<string, unknown>> = [];
  private readonly options: FakeOptions;
  private onMessage: (message: Record<string, unknown>) => void = () => {};
  private counter = 0;

  constructor(options: FakeOptions = {}) {
    this.options = options;
  }

  /** Where the recorder's requests arrive. */
  receive(message: Record<string, unknown>): void {
    this.sent.push(message);
    const command = String(message.command);
    const args = (message.arguments ?? {}) as Record<string, unknown>;

    if (this.options.unsupported?.has(command)) {
      this.emit({
        seq: ++this.counter, type: 'response', request_seq: message.seq,
        success: false, command, message: `unsupported request '${command}'`,
      });
      return;
    }

    this.emit({
      seq: ++this.counter, type: 'response', request_seq: message.seq, success: true, command,
      body: this.body(command, args),
    });
  }

  onSend(handler: (message: Record<string, unknown>) => void): void {
    this.onMessage = handler;
  }

  /** Emits an unsolicited event, the way a stop or a line of output arrives. */
  event(event: string, body: Record<string, unknown>): void {
    this.emit({ seq: ++this.counter, type: 'event', event, body });
  }

  private emit(message: Record<string, unknown>): void {
    this.onMessage(message);
  }

  private body(command: string, args: Record<string, unknown>): Record<string, unknown> {
    switch (command) {
      case 'threads':
        return {
          threads: [{ id: 1, name: 'MainThread' }, { id: 2, name: 'Worker' }],
        };

      case 'stackTrace': {
        const threadId = Number(args.threadId);
        if (threadId === 2) {
          return {
            stackFrames: [{ id: 200, name: 'worker_loop', line: 5, source: { path: '/app/worker.py' } }],
            totalFrames: 1,
          };
        }
        return {
          stackFrames: [
            { id: 100, name: 'handle_request', line: 42, column: 4, source: { path: '/app/server.py' }, instructionPointerReference: '0x1000' },
            { id: 101, name: 'dispatch', line: 17, source: { path: '/app/router.py' } },
            { id: 102, name: '<module>', line: 1, presentationHint: 'subtle' },
          ],
          totalFrames: 3,
        };
      }

      case 'scopes':
        return Number(args.frameId) === 100
          ? {
            scopes: [
              { name: 'Locals', variablesReference: 1000, namedVariables: 3 },
              { name: 'Globals', variablesReference: 2000, expensive: true },
            ],
          }
          : { scopes: [{ name: 'Locals', variablesReference: 1100 }] };

      case 'variables': {
        const reference = Number(args.variablesReference);
        if (reference === 1000) {
          return {
            variables: [
              { name: 'request', value: '<Request>', type: 'Request', variablesReference: 1001, memoryReference: '0x7ffd00' },
              { name: 'retries', value: '3', type: 'int', variablesReference: 0 },
              { name: 'token', value: 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', type: 'str', variablesReference: 0 },
            ],
          };
        }
        if (reference === 1001) {
          return {
            variables: [
              { name: 'path', value: "'/v1/messages'", type: 'str', variablesReference: 0 },
              // The back-pointer: `request.owner` is the frame's own locals again.
              { name: 'owner', value: '<Locals>', variablesReference: this.options.cyclic ? 1000 : 0 },
            ],
          };
        }
        if (reference === 1100) {
          return { variables: [{ name: 'route', value: "'messages'", type: 'str', variablesReference: 0 }] };
        }
        return { variables: [] };
      }

      case 'readMemory':
        return {
          address: '0x7ffd00',
          data: Buffer.from('GET /v1/messages HTTP/1.1').toString('base64'),
        };

      case 'modules':
        return { modules: [{ id: 1, name: 'server.py', path: '/app/server.py', symbolStatus: 'loaded' }] };

      case 'exceptionInfo':
        return {
          exceptionId: 'ValueError',
          breakMode: 'unhandled',
          details: { typeName: 'ValueError', message: 'bad payload', stackTrace: 'line 42\nline 17' },
        };

      default:
        return {};
    }
  }
}

/** Runs a recorder against a fake adapter, returning both plus what reached the "editor". */
function harness(options: FakeOptions = {}) {
  const adapter = new FakeAdapter(options);
  const recorder = new DebugRecorder('test', { probeTimeoutMs: 500 });
  const toEditor: Array<Record<string, unknown>> = [];

  adapter.onSend((message) => {
    if (recorder.observe(message, 'out')) return;   // Swallowed: one of ours.
    toEditor.push(message);
  });
  recorder.attach({ send: (message) => adapter.receive(message) });

  // The adapter's declared capabilities arrive the way they really do: in the `initialize`
  // response, which is what gates every optional probe.
  recorder.observe({
    type: 'response', request_seq: 1, success: true, command: 'initialize',
    body: options.capabilities ?? {
      supportsReadMemoryRequest: true,
      supportsExceptionInfoRequest: true,
      supportsModulesRequest: true,
    },
  }, 'out');

  return { adapter, recorder, toEditor };
}

/** Lets the recorder's promise chain drain. Each probe is a microtask round trip. */
async function settle(times = 40): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 5));
}

// ---------------------------------------------------------------------------------------------

describe('deep debug capture', () => {
  it('gathers the whole program state from a single stopped event', async () => {
    const { recorder, adapter } = harness();

    adapter.event('stopped', { reason: 'breakpoint', threadId: 1, allThreadsStopped: true });
    await settle();

    const stop = recorder.session.currentStop;
    assert.ok(stop, 'a stop should have been captured');

    // Threads: both, with the stopped one marked.
    assert.equal(stop.threads.length, 2);
    assert.equal(stop.threads.find((thread) => thread.id === 1)?.stopped, true);

    // Stacks: the stopped thread in full, and the other thread walked too.
    assert.equal(stop.stacks[1]?.length, 3);
    assert.equal(stop.stacks[2]?.length, 1);
    assert.equal(stop.stacks[1]?.[0]?.name, 'handle_request');
    assert.equal(stop.stacks[1]?.[0]?.line, 42);

    // Scopes for the frames of the stopped thread. Nobody asked for any of this; the editor's UI
    // sent no request at all. That is the entire point of the active recorder.
    const topScopes = stop.frames[100];
    assert.ok(topScopes);
    assert.deepEqual(topScopes.map((scope) => scope.name), ['Locals', 'Globals']);

    const locals = topScopes[0]!;
    assert.deepEqual(locals.variables.map((variable) => variable.name), ['request', 'retries', 'token']);

    // And expanded: `request.path` was never requested by any editor.
    const request = locals.variables[0]!;
    assert.equal(request.children?.[0]?.name, 'path');
    assert.equal(request.memoryReference, '0x7ffd00');
  });

  it('honours an expensive scope rather than fetching it', async () => {
    const { recorder, adapter } = harness();
    adapter.event('stopped', { reason: 'breakpoint', threadId: 1 });
    await settle();

    const globals = recorder.session.currentStop!.frames[100]![1]!;
    assert.equal(globals.name, 'Globals');
    assert.equal(globals.variables.length, 0);
    assert.match(globals.skipped ?? '', /expensive/);
    // And no request for it was ever sent, which is the behaviour rather than the label.
    const asked = adapter.sent.filter((message) =>
      message.command === 'variables' &&
      (message.arguments as Record<string, unknown>).variablesReference === 2000);
    assert.equal(asked.length, 0);
  });

  it('terminates on a cyclic object graph and says where it cut', async () => {
    const { recorder, adapter } = harness({ cyclic: true });
    adapter.event('stopped', { reason: 'breakpoint', threadId: 1 });
    await settle();

    const request = recorder.session.currentStop!.frames[100]![0]!.variables[0]!;
    const owner = request.children!.find((child) => child.name === 'owner')!;

    // `owner` points back at the frame's own locals. Depth alone would not have stopped this:
    // the graph is finite in nodes and infinite in paths.
    assert.equal(owner.truncated, 'circular reference');
    assert.equal(owner.children, undefined);
  });

  it('captures raw memory behind a variable that has an address', async () => {
    const { recorder, adapter } = harness();
    adapter.event('stopped', { reason: 'breakpoint', threadId: 1 });
    await settle();

    const dump = recorder.session.currentStop!.memory?.[0];
    assert.ok(dump, 'memory should have been read');
    assert.equal(dump.reference, '0x7ffd00');
    assert.equal(dump.text, 'GET /v1/messages HTTP/1.1');
    assert.match(dump.hex, /^00000000 {2}47 45 54/);
  });

  it('does not read memory when the adapter says it cannot', async () => {
    const { recorder, adapter } = harness({ capabilities: {} });
    adapter.event('stopped', { reason: 'breakpoint', threadId: 1 });
    await settle();

    assert.equal(recorder.session.currentStop!.memory, undefined);
    assert.equal(adapter.sent.filter((message) => message.command === 'readMemory').length, 0);
  });

  it('captures exception detail when that is why it stopped', async () => {
    const { recorder, adapter } = harness();
    adapter.event('stopped', { reason: 'exception', threadId: 1, text: 'ValueError' });
    await settle();

    const exception = recorder.session.currentStop!.exception;
    assert.equal(exception?.typeName, 'ValueError');
    assert.equal(exception?.message, 'bad payload');
    assert.equal(exception?.breakMode, 'unhandled');
  });

  it('degrades rather than failing when the adapter refuses a request', async () => {
    const { recorder, adapter } = harness({ unsupported: new Set(['modules', 'readMemory']) });
    adapter.event('stopped', { reason: 'breakpoint', threadId: 1 });
    await settle();

    // The refused requests produced nothing; everything else still arrived.
    assert.equal(recorder.session.modules.length, 0);
    assert.equal(recorder.session.currentStop!.stacks[1]?.length, 3);
    assert.ok(recorder.session.currentStop!.frames[100]!.length > 0);
  });

  it('never lets its own responses reach the editor', async () => {
    const { recorder, adapter, toEditor } = harness();

    adapter.event('stopped', { reason: 'breakpoint', threadId: 1 });
    await settle();

    // Dozens of requests were issued and answered. The editor saw the `stopped` event and nothing
    // else -- no response to a request it never made.
    assert.ok(adapter.sent.length > 5, 'the recorder should have probed');
    assert.deepEqual(toEditor.map((message) => message.event ?? message.command), ['stopped']);
    assert.equal(recorder.session.totals.probes, adapter.sent.length);
  });

  it('numbers its requests out of the editor\'s reach', async () => {
    const { adapter } = harness();
    adapter.event('stopped', { reason: 'breakpoint', threadId: 1 });
    await settle();

    // Every probe seq is astronomically above anything an editor counting from 1 will reach.
    for (const message of adapter.sent) {
      assert.ok(Number(message.seq) >= 1_000_000_000, `seq ${message.seq} is in the editor's range`);
    }
  });

  it('reports what changed between two stops, and what did not', async () => {
    const { recorder, adapter } = harness();

    adapter.event('stopped', { reason: 'breakpoint', threadId: 1 });
    await settle();
    adapter.event('continued', { threadId: 1 });
    adapter.event('stopped', { reason: 'step', threadId: 1 });
    await settle();

    const diff = recorder.session.diffs.at(-1);
    assert.ok(diff, 'a comparison should have been produced');
    assert.equal(diff.fromStop, 1);
    assert.equal(diff.toStop, 2);
    // The fake returns the same values both times, so the meaningful assertion is that everything
    // is reported as *held* -- an implementation that compared object identity would report every
    // variable as changed here, which is the failure this catches.
    assert.equal(diff.changed.length, 0);
    assert.equal(diff.added.length, 0);
    assert.ok(diff.unchangedCount > 0);
  });

  it('tracks the state machine and the wire totals', async () => {
    const { recorder, adapter } = harness();

    assert.equal(recorder.session.status, 'initializing');
    adapter.event('stopped', { reason: 'breakpoint', threadId: 1 });
    await settle();
    assert.equal(recorder.session.status, 'paused');

    adapter.event('continued', { threadId: 1 });
    assert.equal(recorder.session.status, 'running');

    adapter.event('output', { category: 'stderr', output: 'boom\nsecond line\n' });
    adapter.event('terminated', {});

    assert.equal(recorder.session.status, 'terminated');
    assert.ok(recorder.session.endedAt);
    assert.deepEqual(recorder.session.output.map((line) => line.text), ['boom', 'second line']);
    assert.equal(recorder.session.output[0]!.category, 'stderr');
    assert.ok(recorder.session.timeline.length > 10);
    assert.ok(recorder.session.totals.events >= 4);
  });

  it('records both halves of a breakpoint: what was asked and what bound', () => {
    const { recorder } = harness();

    recorder.observe({
      type: 'request', seq: 5, command: 'setBreakpoints',
      arguments: {
        source: { path: '/app/server.py' },
        breakpoints: [{ line: 42, condition: 'retries > 2' }, { line: 99 }],
      },
    }, 'in');
    recorder.observe({
      type: 'response', request_seq: 5, success: true, command: 'setBreakpoints',
      arguments: {
        source: { path: '/app/server.py' },
        breakpoints: [{ line: 42, condition: 'retries > 2' }, { line: 99 }],
      },
      body: {
        breakpoints: [
          { id: 1, verified: true, line: 42, source: { path: '/app/server.py' } },
          { id: 2, verified: false, line: 99, message: 'no code at this line' },
        ],
      },
    }, 'out');

    const [bound, unbound] = recorder.session.breakpoints;
    // The condition came from the request; the verification came from the response. Either half
    // alone is misleading.
    assert.equal(bound?.condition, 'retries > 2');
    assert.equal(bound?.verified, true);
    assert.equal(unbound?.verified, false);
    assert.equal(unbound?.message, 'no code at this line');
  });

  it('replaces a file\'s breakpoints rather than accumulating them', () => {
    const { recorder } = harness();
    const set = (lines: number[]) => {
      const args = { source: { path: '/app/a.py' }, breakpoints: lines.map((line) => ({ line })) };
      recorder.observe({ type: 'request', seq: 1, command: 'setBreakpoints', arguments: args }, 'in');
      recorder.observe({
        type: 'response', request_seq: 1, success: true, command: 'setBreakpoints', arguments: args,
        body: { breakpoints: lines.map((line, index) => ({ id: index, verified: true, line })) },
      }, 'out');
    };

    set([10, 20]);
    set([10]);       // The user removed one. DAP says so by sending the whole new set.

    assert.deepEqual(recorder.session.breakpoints.map((item) => item.line), [10]);
  });

  it('observes the user\'s own evaluations without issuing any', () => {
    const { recorder, adapter } = harness();

    recorder.observe({
      type: 'response', request_seq: 9, success: true, command: 'evaluate',
      arguments: { expression: 'retries * 2', context: 'watch', frameId: 100 },
      body: { result: '6', type: 'int' },
    }, 'out');

    assert.equal(recorder.session.evaluations[0]?.expression, 'retries * 2');
    assert.equal(recorder.session.evaluations[0]?.result, '6');
    // The recorder never evaluates anything itself: an injected expression can run arbitrary code
    // with side effects in most languages, and reading state must not change it.
    assert.equal(adapter.sent.filter((message) => message.command === 'evaluate').length, 0);
  });

  it('keeps the launch configuration', () => {
    const { recorder } = harness();
    recorder.observe({
      type: 'request', seq: 2, command: 'launch',
      arguments: { name: 'Run server', type: 'debugpy', program: '/app/server.py' },
    }, 'in');

    assert.equal(recorder.session.startMethod, 'launch');
    assert.equal(recorder.session.adapterType, 'debugpy');
    assert.equal(recorder.session.name, 'Run server');
  });

  it('bounds the timeline rather than growing without limit', () => {
    const recorder = new DebugRecorder('bounded', { timeline: 10 });
    for (let i = 0; i < 50; i++) {
      recorder.observe({ type: 'event', event: 'output', body: { output: `line ${i}` } }, 'out');
    }
    assert.equal(recorder.session.timeline.length, 10);
    // The counters survive the eviction, so a reader is not told the session was ten messages long.
    assert.equal(recorder.session.totals.events, 50);
  });

  it('summarizes into the compact snapshot shape', async () => {
    const { recorder, adapter } = harness();
    adapter.event('stopped', { reason: 'breakpoint', threadId: 1 });
    await settle();

    const state = recorder.toDebugState()!;
    assert.equal(state.status, 'paused');
    assert.equal(state.stoppedReason, 'breakpoint');
    assert.equal(state.stack?.[0]?.name, 'handle_request');
    assert.deepEqual(Object.keys(state.scopes ?? {}), ['Locals', 'Globals']);
  });
});

describe('the deep proxy wiring', () => {
  it('forwards everything except the responses to its own probes', async () => {
    const store = new ProtocolStore();
    const recorder = new DebugRecorder('wire', { probeTimeoutMs: 200 });
    const adapter = new FakeAdapter();

    const toEditor: Buffer[] = [];
    const framer = new MessageFramer();

    // The adapter's side of the wire: bytes the recorder sends are framed and decoded back out.
    const wiring = wireDeepDap(recorder, (bytes) => {
      for (const { message } of framer.push(bytes)) adapter.receive(message);
    }, store);

    adapter.onSend((message) => {
      if (wiring.fromAdapter(message)) toEditor.push(frame(message));
    });

    // Capabilities, then a stop.
    adapter.receive({ seq: 1, type: 'request', command: 'initialize' });
    adapter.event('stopped', { reason: 'breakpoint', threadId: 1 });
    await settle();

    const seen = toEditor
      .flatMap((bytes) => new MessageFramer().push(bytes))
      .map(({ message }) => message.event ?? message.command);

    // The editor saw the initialize response (which it asked for, via the fake) and the stop.
    // It did not see any of the recorder's dozens of probe responses.
    assert.ok(seen.includes('stopped'));
    assert.ok(!seen.includes('variables'), 'a probe response leaked to the editor');
    assert.ok(!seen.includes('stackTrace'), 'a probe response leaked to the editor');

    // And the store received the compact state, which is what an ordinary capture reads.
    assert.equal(store.debugState()?.status, 'paused');
  });

  it('forwards a frame it cannot decode rather than dropping it', () => {
    const framer = new MessageFramer();
    const bad = Buffer.from('Content-Length: 5\r\n\r\n{ nope', 'ascii');

    // `push` skips it, because a caller that forwards bytes separately does not want it twice.
    assert.equal(framer.push(bad.subarray(0, 24)).length, 0);

    const framer2 = new MessageFramer();
    const frames = framer2.pushRaw(Buffer.from('Content-Length: 5\r\n\r\n{ nop', 'ascii'));
    // `pushRaw` returns it with no message, so the deep proxy -- which forwards per frame -- still
    // passes the bytes through. A dropped frame would make the proxy non-transparent.
    assert.equal(frames.length, 1);
    assert.equal(frames[0]!.message, undefined);
    assert.ok(frames[0]!.raw.length > 0);
  });
});

describe('debug helpers', () => {
  it('renders a hex dump with offsets and printable text', () => {
    const bytes = Buffer.from('hello\x00world, this is a longer buffer', 'utf8');
    const dump = toHexDump(bytes);
    const lines = dump.split('\n');

    assert.equal(lines[0]!.slice(0, 8), '00000000');
    assert.equal(lines[1]!.slice(0, 8), '00000010');
    // The NUL is not printable and shows as a dot rather than vanishing or breaking alignment.
    assert.match(lines[0]!, /hello\.world/);
    assert.equal(toPrintable(Buffer.from([0x00, 0x41, 0xff])), '.A.');
  });

  it('reads capabilities as flags rather than as truthiness', () => {
    const capabilities = readCapabilities({
      supportsReadMemoryRequest: true,
      supportsDisassembleRequest: 'yes',      // Not `true`; must not be read as enabled.
    });
    assert.equal(capabilities.supportsReadMemory, true);
    assert.equal(capabilities.supportsDisassemble, false);
  });

  it('flattens and diffs a stop by path', () => {
    const stop = (value: string, extra?: string): DebugStop => ({
      index: 1, at: new Date().toISOString(), threads: [], stacks: {},
      frames: {
        100: [{
          name: 'Locals',
          variables: [
            { name: 'total', value },
            { name: 'obj', value: '<X>', children: extra ? [{ name: 'inner', value: extra }] : [] },
          ],
        }],
      },
      captureMs: 1,
    });

    const before = flattenStop(stop('1'));
    const after = flattenStop(stop('2', 'new'));

    assert.equal(before.get('Locals/total'), '1');
    assert.equal(after.get('Locals/obj.inner'), 'new');

    const diff = buildDiff(stop('1'), stop('2', 'new'), before, after, ['a', 'b'], ['b', 'c']);

    assert.deepEqual(diff.changed.map((delta) => delta.path), ['total']);
    assert.equal(diff.changed[0]!.before, '1');
    assert.equal(diff.changed[0]!.after, '2');
    assert.deepEqual(diff.added.map((delta) => delta.path), ['obj.inner']);
    assert.deepEqual(diff.framesEntered, ['c']);
    assert.deepEqual(diff.framesLeft, ['a']);
    assert.equal(diff.unchangedCount, 1);           // `obj` itself held its value.
  });
});

describe('debug rendering', () => {
  it('renders a session without colour codes swallowing the content', async () => {
    const { recorder, adapter } = harness();
    adapter.event('stopped', { reason: 'breakpoint', threadId: 1 });
    adapter.event('output', { category: 'stdout', output: 'listening on 8080\n' });
    await settle();

    const text = renderDebugSession(recorder.session, { verbose: true, timeline: true, memory: true });

    assert.match(text, /Stop #1: breakpoint/);
    assert.match(text, /handle_request/);
    assert.match(text, /retries/);
    assert.match(text, /listening on 8080/);
    assert.match(text, /GET \/v1\/messages/);       // The hex dump's printable column.
    assert.match(text, /Wire timeline/);
  });

  it('says plainly when nothing changed', () => {
    const lines = renderDiff({
      fromStop: 1, toStop: 2, elapsedMs: 12, framesEntered: [], framesLeft: [],
      changed: [], added: [], removed: [], unchangedCount: 7,
    });
    assert.match(lines.join('\n'), /nothing changed; 7 value\(s\) held/);
  });

  it('marks an unmapped frame rather than pretending it has a location', () => {
    const lines = renderStop({
      index: 1, at: new Date().toISOString(), reason: 'step', threadId: 1,
      threads: [{ id: 1, name: 'main', stopped: true }],
      stacks: { 1: [{ id: 1, name: 'native_call', unmapped: true }] },
      frames: {}, captureMs: 3,
    });
    assert.match(lines.join('\n'), /<no source>/);
  });
});

describe('publishing a session across processes', () => {
  it('round-trips a record and redacts it on the way out', async () => {
    const { recorder, adapter } = harness();
    adapter.event('stopped', { reason: 'breakpoint', threadId: 1 });
    await settle();

    const id = `test-${process.pid}-${Date.now()}`;
    const record = { ...recorder.session, sessionId: id };

    const path = await publishSession(record, new Redactor(true));
    try {
      const back = await readSession(id);
      assert.ok(back, 'the session should be readable from another process');
      assert.equal(back.currentStop?.stacks[1]?.[0]?.name, 'handle_request');

      // The `token` local held a real Anthropic key shape. It must not have reached the temp
      // directory in the clear -- a debug session's variables are the most secret-dense thing on a
      // developer's machine, and this file is world-readable.
      const raw = await readFile(path, 'utf8');
      assert.ok(!raw.includes('sk-ant-api03-AAAA'), 'a secret was written to disk unredacted');
      assert.match(raw, /\[redacted:/);

      assert.ok((await listSessions()).some((entry) => entry.path === path));
    } finally {
      await unlink(path).catch(() => {});
    }
  });

  it('reports no session rather than failing when nothing was published', async () => {
    assert.equal(await readSession('definitely-not-a-real-session-name'), undefined);
  });
});

describe('the debug MCP tools', () => {
  it('tell an assistant how to fix an unconfigured session instead of dead-ending', async () => {
    const server = new McpServer({ adapters: [] });
    const result = await callTool(server, 'get_debug_session', { session: 'no-such-session' }) as
      Record<string, unknown>;

    assert.equal(result.session, null);
    assert.match(String(result.note), /auspex proxy --dap --deep/);
  });

  it('serve the captured stack, variables and changes', async () => {
    const { recorder, adapter } = harness();
    adapter.event('stopped', { reason: 'breakpoint', threadId: 1 });
    await settle();

    const id = `mcp-${process.pid}-${Date.now()}`;
    const path = await publishSession({ ...recorder.session, sessionId: id });
    try {
      const server = new McpServer({ adapters: [] });

      const session = await callTool(server, 'get_debug_session', { session: id }) as
        Record<string, any>;
      assert.equal(session.status, 'paused');
      assert.equal(session.stop.stacks[1][0].name, 'handle_request');
      assert.equal(session.timeline, undefined, 'the timeline should be opt-in');

      // A depth cut must be visible, not silent: an assistant told `request` is childless would
      // confidently draw the wrong conclusion.
      const shallow = await callTool(server, 'get_debug_session', { session: id, maxDepth: 0 }) as
        Record<string, any>;
      const request = shallow.stop.frames[100][0].variables[0];
      assert.equal(request.children, undefined);
      assert.match(String(request.truncated), /not shown at this depth/);

      const filtered = await callTool(server, 'get_debug_variables', { session: id, name: 'retr' }) as
        Record<string, any>;
      assert.deepEqual(
        filtered.scopes[0].variables.map((variable: { name: string }) => variable.name),
        ['retries'],
      );

      const changes = await callTool(server, 'get_debug_changes', { session: id }) as
        Record<string, unknown>;
      assert.match(String(changes.note), /fewer than twice/);

      const timeline = await callTool(server, 'get_debug_timeline', { session: id, direction: 'probe' }) as
        Record<string, any>;
      assert.ok(timeline.entries.length > 0);
      assert.ok(timeline.entries.every((entry: { direction: string }) => entry.direction === 'probe'));
    } finally {
      await unlink(path).catch(() => {});
    }
  });
});
