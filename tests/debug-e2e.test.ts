import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DebugRecorder } from '../src/adapters/debug.ts';
import { MessageFramer, frame, ProtocolStore, wireDeepDap } from '../src/adapters/protocols.ts';
import { publishSession, readSession } from '../src/core/debug-store.ts';

/**
 * End to end, against a debug adapter running as a real process on real pipes.
 *
 * Every framing test in this project passed while `auspex proxy` hung forever on a real language
 * server, because none of them owned the event loop or crossed a process boundary. That is the
 * precedent for insisting on this one: an in-process double proves the logic, a spawned process
 * proves the plumbing.
 */

const ADAPTER = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-dap-adapter.mjs');

describe('deep capture against a real adapter process', () => {
  it('drives a whole session over pipes and publishes it', async () => {
    const child = spawn(process.execPath, [ADAPTER], { stdio: ['pipe', 'pipe', 'inherit'] });
    const recorder = new DebugRecorder(`e2e-${process.pid}`, { probeTimeoutMs: 2000 });
    const store = new ProtocolStore();

    const toEditor: Array<Record<string, unknown>> = [];
    const fromAdapter = new MessageFramer();

    const wiring = wireDeepDap(recorder, (bytes) => child.stdin!.write(bytes), store);

    child.stdout!.on('data', (chunk: Buffer) => {
      for (const { raw, message } of fromAdapter.pushRaw(chunk)) {
        assert.ok(raw.length > 0);
        if (message && wiring.fromAdapter(message)) toEditor.push(message);
      }
    });

    // Play the editor: initialize, then launch.
    const editorSend = (message: Record<string, unknown>) => {
      wiring.fromEditor(message);
      child.stdin!.write(frame(message));
    };
    editorSend({ seq: 1, type: 'request', command: 'initialize', arguments: { adapterID: 'fake' } });
    editorSend({ seq: 2, type: 'request', command: 'launch', arguments: { type: 'fake', name: 'E2E' } });

    // Wait for the stop to be captured, rather than sleeping a guessed interval.
    const deadline = Date.now() + 8000;
    while (!recorder.session.currentStop && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const stop = recorder.session.currentStop;
    assert.ok(stop, 'the stop should have been captured over real pipes');
    assert.equal(stop.reason, 'breakpoint');
    assert.equal(stop.stacks[1]?.[0]?.name, 'main');
    assert.equal(stop.frames[7]?.[0]?.variables[0]?.name, 'answer');
    assert.equal(recorder.session.adapterType, 'fake');
    assert.equal(recorder.session.startMethod, 'launch');

    // The editor saw its two responses and the two events, and none of the recorder's probes.
    const seen = toEditor.map((message) => message.event ?? message.command);
    assert.deepEqual(seen, ['initialize', 'initialized', 'launch', 'stopped']);

    // The published record is what another process would read.
    const path = await publishSession(recorder.session);
    try {
      const back = await readSession(recorder.session.sessionId);
      assert.equal(back?.currentStop?.frames[7]?.[0]?.variables[0]?.value, '42');
    } finally {
      await unlink(path).catch(() => {});
    }

    // And the adapter exits when told to, rather than being killed -- the shutdown path matters.
    editorSend({ seq: 3, type: 'request', command: 'disconnect', arguments: {} });
    const code = await new Promise<number>((resolve) => child.on('exit', (value) => resolve(value ?? -1)));
    assert.equal(code, 0);
  });
});
