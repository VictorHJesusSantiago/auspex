import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DebugJournal, JOURNAL_VERSION, readStops, replayJournal, summarizeJournal } from '../src/debug/journal.ts';
import { findLaunchConfigurations, recommendAdapters, wiringFor } from '../src/debug/launch-config.ts';
import { fitDebugToBudget, measureDebugRecord, minimalStop } from '../src/ai/debug-budget.ts';
import { debugReport, debugSizeReport, debugSummary } from '../src/ai/debug-report.ts';
import { anthropicDebugTools, DEBUG_TOOL_SPECS, geminiDebugTools, openAiDebugTools } from '../src/ai/debug-tools.ts';
import { estimateTokens } from '../src/core/budget.ts';
import { Redactor } from '../src/core/redact.ts';
import type { DebugScope, DebugSessionRecord, DebugStop, DebugVariable } from '../src/core/debug-model.ts';

/**
 * Tests for the durability and AI-facing layers.
 *
 * Two properties carry most of the weight here, and neither is checked by a test that only asserts
 * a function returned something:
 *
 * - **The journal must survive a process that died mid-write**, because that is exactly when it is
 *   most valuable. So there is a test that truncates a journal in the middle of a line.
 * - **The budget ladder must never silently misrepresent a program's state.** A record cut down to
 *   fit has to say what was cut, and when the irreducible core still does not fit it has to say
 *   that too rather than cutting into it.
 */

// ---------------------------------------------------------------------------------------------

function bigVariable(name: string, depth: number, breadth: number): DebugVariable {
  if (depth === 0) return { name, value: 'leaf value that takes up a reasonable amount of room' };
  return {
    name,
    value: '<object>',
    children: Array.from({ length: breadth }, (_, i) => bigVariable(`${name}_${i}`, depth - 1, breadth)),
  };
}

function stop(overrides: Partial<DebugStop> = {}): DebugStop {
  return {
    index: 1,
    at: new Date().toISOString(),
    reason: 'breakpoint',
    threadId: 1,
    threads: [{ id: 1, name: 'main', stopped: true }],
    stacks: { 1: [{ id: 10, name: 'handle', file: '/app/handler.py', line: 42 }] },
    frames: { 10: [{ name: 'Locals', variables: [{ name: 'x', value: '1' }] } as DebugScope] },
    captureMs: 4,
    ...overrides,
  };
}

function session(overrides: Partial<DebugSessionRecord> = {}): DebugSessionRecord {
  return {
    sessionId: 'budget',
    adapterType: 'debugpy',
    startedAt: new Date().toISOString(),
    status: 'paused',
    currentStop: stop(),
    stops: [], diffs: [], breakpoints: [], modules: [], loadedSources: [],
    evaluations: [], output: [], timeline: [],
    totals: {
      requests: 4, responses: 4, events: 2, probes: 6, failedResponses: 0,
      bytesIn: 100, bytesOut: 200, stops: 1,
    },
    warnings: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------

describe('the debug journal', () => {
  it('records a session and reads it back', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'auspex-journal-'));
    const path = join(directory, 'session.ndjson');
    const journal = new DebugJournal('test', { path });

    await journal.begin({ sessionId: 'test', adapterType: 'debugpy', startedAt: new Date().toISOString() });
    journal.stop(stop({ index: 1 }));
    journal.stop(stop({ index: 2, reason: 'step' }));
    journal.output('stdout', 'listening');
    journal.end('terminated', session().totals);
    await journal.flush();

    const summary = await summarizeJournal(path);
    assert.equal(summary.stops, 2);
    assert.equal(summary.outputLines, 1);
    assert.equal(summary.header?.adapterType, 'debugpy');
    assert.equal(summary.header?.journalVersion, JOURNAL_VERSION);
    assert.equal(summary.ended?.status, 'terminated');
    assert.equal(summary.corruptLines, 0);
  });

  it('keeps every stop, including ones the live record would have evicted', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'auspex-journal-'));
    const path = join(directory, 'many.ndjson');
    const journal = new DebugJournal('many', { path });

    await journal.begin({ sessionId: 'many', startedAt: new Date().toISOString() });
    for (let index = 1; index <= 120; index++) journal.stop(stop({ index }));
    await journal.flush();

    // The live recorder keeps twenty. The whole reason the journal exists is that a program which
    // stopped 120 times before failing has lost the interesting ones by then.
    assert.equal((await summarizeJournal(path)).stops, 120);

    const middle = await readStops(path, { from: 50, to: 55 });
    assert.deepEqual(middle.map((item) => item.index), [50, 51, 52, 53, 54, 55]);
  });

  it('survives a process killed mid-write, losing exactly the last line', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'auspex-journal-'));
    const path = join(directory, 'killed.ndjson');
    const journal = new DebugJournal('killed', { path });

    await journal.begin({ sessionId: 'killed', startedAt: new Date().toISOString() });
    journal.stop(stop({ index: 1 }));
    journal.stop(stop({ index: 2 }));
    await journal.flush();

    // Truncate mid-line, which is what a killed process leaves behind.
    const text = await readFile(path, 'utf8');
    await writeFile(path, `${text}{"kind":"stop","at":"2026`, 'utf8');

    const summary = await summarizeJournal(path);
    assert.equal(summary.stops, 2, 'the complete lines must still be readable');
    assert.equal(summary.corruptLines, 1);

    const replayed = (await replayJournal(path))!;
    assert.equal(replayed.totals.stops, 2);
    assert.ok(replayed.warnings.some((warning) => /would not parse/.test(warning)));
    assert.ok(replayed.warnings.some((warning) => /expected result of a process ending mid-write/.test(warning)));
  });

  it('says when a session was still running rather than implying it ended', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'auspex-journal-'));
    const path = join(directory, 'open.ndjson');
    const journal = new DebugJournal('open', { path });

    await journal.begin({ sessionId: 'open', startedAt: new Date().toISOString() });
    journal.stop(stop());
    await journal.flush();

    const replayed = (await replayJournal(path))!;
    assert.ok(replayed.warnings.some((warning) => /no end entry/.test(warning)));
  });

  it('stops at its size limit and records that it did', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'auspex-journal-'));
    const path = join(directory, 'capped.ndjson');
    const journal = new DebugJournal('capped', { path, maxBytes: 3000 });

    await journal.begin({ sessionId: 'capped', startedAt: new Date().toISOString() });
    for (let index = 1; index <= 200; index++) journal.stop(stop({ index }));
    await journal.flush();

    const replayed = (await replayJournal(path))!;
    assert.ok(replayed.totals.stops < 200, 'it should have stopped writing');
    // Silently truncating would make the journal lie about the session's length; saying so in the
    // file itself means the record explains its own shape.
    assert.ok(replayed.warnings.some((warning) => /size limit/.test(warning)));
  });

  it('redacts what it writes to disk', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'auspex-journal-'));
    const path = join(directory, 'secret.ndjson');
    const journal = new DebugJournal('secret', { path, redactor: new Redactor(true) });

    await journal.begin({ sessionId: 'secret', startedAt: new Date().toISOString() });
    journal.stop(stop({
      frames: {
        10: [{
          name: 'Locals',
          variables: [{ name: 'token', value: 'sk-ant-api03-' + 'B'.repeat(90) }],
        } as DebugScope],
      },
    }));
    await journal.flush();

    const text = await readFile(path, 'utf8');
    assert.ok(!text.includes('sk-ant-api03-BBBB'), 'a secret reached the journal in the clear');
    assert.match(text, /\[redacted:/);
  });

  it('never throws when the journal cannot be written', async () => {
    // A directory that does not exist and will not be created: the journal must degrade silently
    // rather than take a debug session down with it.
    const journal = new DebugJournal('nowhere', { path: join(tmpdir(), 'auspex-no-such-dir-x', 'a.ndjson') });
    journal.stop(stop());
    journal.end('terminated', session().totals);
    await journal.flush();      // Resolves rather than rejecting; that is the whole assertion.
  });

  it('reports an absent journal as empty rather than failing', async () => {
    const summary = await summarizeJournal(join(tmpdir(), 'auspex-definitely-missing.ndjson'));
    assert.equal(summary.bytes, 0);
    assert.equal(summary.stops, 0);
  });
});

describe('fitting a debug record to a budget', () => {
  it('drops in a documented order and says what it dropped', () => {
    const record = session({
      timeline: Array.from({ length: 500 }, (_, seq) => ({
        seq, at: '', deltaMs: 1, direction: 'in' as const, type: 'request',
        name: 'variables', bytes: 100, summary: 'variables variablesReference=1000',
      })),
      output: Array.from({ length: 200 }, (_, i) => ({ at: '', category: 'stdout', text: `line ${i}` })),
    });

    const result = fitDebugToBudget(record, { maxTokens: 2000 });

    assert.ok(result.estimatedTokens <= 2000, `still ${result.estimatedTokens} tokens`);
    assert.ok(result.dropped.some((item) => item.includes('timeline')));
    assert.ok(result.dropped.length > 0);
    // The totals survive the timeline, because that is what the timeline is usually read for.
    assert.equal(result.record.totals.probes, 6);
  });

  it('does not touch the input', () => {
    const record = session({ output: Array.from({ length: 100 }, () => ({ at: '', category: 'stdout', text: 'x'.repeat(200) })) });
    const before = estimateTokens(record);

    fitDebugToBudget(record, { maxTokens: 100 });
    assert.equal(estimateTokens(record), before);
  });

  it('collapses deep variable trees before it removes frames', () => {
    const record = session({
      currentStop: stop({
        frames: {
          10: [{ name: 'Locals', variables: [bigVariable('root', 4, 4)] } as DebugScope],
        },
      }),
    });

    const result = fitDebugToBudget(record, { maxTokens: 800 });
    assert.ok(result.dropped.some((item) => /below depth/.test(item)));

    // Something must remain of the variable, marked -- a tree that simply ended would read as a
    // leaf, and a reader would conclude the object was empty.
    const root = result.record.currentStop!.frames[10]![0]!.variables[0]!;
    assert.equal(root.name, 'root');
    if (!root.children) assert.match(root.truncated ?? '', /dropped|depth/);
  });

  it('keeps the shape of a long stack even when it drops the values', () => {
    const frames = Array.from({ length: 40 }, (_, i) => ({
      id: i, name: `frame_${i}`, file: '/app/deep.py', line: i,
    }));
    const record = session({
      currentStop: stop({
        stacks: { 1: frames },
        frames: Object.fromEntries(frames.map((frame) => [
          frame.id, [{ name: 'Locals', variables: [bigVariable('v', 3, 3)] } as DebugScope],
        ])),
      }),
    });

    const result = fitDebugToBudget(record, { maxTokens: 1500 });
    const kept = result.record.currentStop!.stacks[1]!;

    // A reader who cannot see there were forty frames will misjudge what they are looking at, so
    // the frames survive as names even when their values do not.
    assert.equal(kept.length, 40);
    assert.ok(Object.keys(result.record.currentStop!.frames).length < 40);
  });

  it('says so when the irreducible core still does not fit', () => {
    const record = session({
      currentStop: stop({
        frames: {
          10: [{
            name: 'Locals',
            variables: Array.from({ length: 20 }, (_, i) => ({
              name: `huge_${i}`,
              value: 'x'.repeat(4000),
            })),
          } as DebugScope],
        },
      }),
    });

    const result = fitDebugToBudget(record, { maxTokens: 200 });

    // Cutting into the stopped frame's own values would be presenting a partial program state as
    // whole, which is how a reader draws a confident wrong conclusion. Overflowing honestly is the
    // better failure.
    assert.equal(result.overBudget, true);
    assert.ok(result.estimatedTokens > 200);
    assert.ok(result.record.currentStop!.frames[10]!.length > 0);
  });

  it('leaves a small record entirely alone', () => {
    const result = fitDebugToBudget(session(), { maxTokens: 100000 });
    assert.deepEqual(result.dropped, []);
    assert.equal(result.overBudget, false);
  });

  it('measures where the size is going', () => {
    const record = session({
      timeline: Array.from({ length: 300 }, (_, seq) => ({
        seq, at: '', deltaMs: 1, direction: 'in' as const, type: 'request', name: 'variables', bytes: 10,
      })),
    });
    const { total, breakdown } = measureDebugRecord(record);

    assert.ok(total > 0);
    assert.equal(breakdown[0]?.part, 'timeline', 'the largest part should be reported first');
  });

  it('reduces a stop to something readable in a few hundred tokens', () => {
    const minimal = minimalStop(stop(), 'debugpy') as Record<string, any>;
    assert.equal(minimal.reason, 'breakpoint');
    assert.match(minimal.at, /handler\.py:42 in handle/);
    assert.ok(estimateTokens(minimal) < 300);
  });
});

describe('the briefing written for a model', () => {
  it('leads with the headline and separates user code from runtime', () => {
    const record = session({
      currentStop: stop({
        stacks: {
          1: [
            { id: 9, name: 'wrapper', file: '/usr/lib/python3.11/site-packages/flask/app.py', line: 3 },
            { id: 10, name: 'handle', file: '/app/handler.py', line: 42 },
          ],
        },
      }),
    });

    const report = debugReport(record);

    assert.match(report, /^# Debug session/);
    assert.match(report, /is stopped \(breakpoint\)/);
    assert.match(report, /► #1\s+handle/);          // The user's frame is marked.
    assert.match(report, /  #0\s+wrapper/);          // The runtime frame is not.
    assert.match(report, /this project's own code/);
  });

  it('quotes the failing line', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'auspex-report-'));
    const file = join(directory, 'handler.py');
    await writeFile(file, 'def handle():\n    return user.name\n', 'utf8');

    const record = session({
      currentStop: stop({ stacks: { 1: [{ id: 10, name: 'handle', file, line: 2 }] } }),
    });
    const { readStopSource } = await import('../src/debug/source-context.ts');
    const sources = await readStopSource(record.currentStop!);

    const report = debugReport(record, { sources });
    assert.match(report, /return user\.name/);
    assert.match(report, /## Source at/);
  });

  it('always states what is missing from the capture', () => {
    const record = session({
      currentStop: stop({ incomplete: ['memory reads stopped at the time budget'] }),
      warnings: ['probe \'modules\' timed out after 3000ms'],
    });

    const report = debugReport(record);
    assert.match(report, /## Limits of this capture/);
    assert.match(report, /memory reads stopped/);
    assert.match(report, /timed out/);
  });

  it('says plainly when nothing was dropped', () => {
    // No adapter type, so there is no known-limitation note either -- this is the one case where
    // the limits section is genuinely empty, and it must say so rather than being omitted.
    const report = debugReport(session({ adapterType: undefined }));
    assert.match(report, /Nothing was dropped from this capture/);
  });

  it('names a known limitation of the adapter even when nothing was dropped', () => {
    // A debugpy capture with no memory is not a gap in the capture; it is a fact about CPython.
    // Reporting it under the same heading is what stops a reader inferring the wrong thing.
    assert.match(debugReport(session()), /Python \(debugpy\) does not expose memory addresses/);
  });

  it('reports the budget reduction inside the briefing itself', () => {
    const record = session({
      timeline: Array.from({ length: 400 }, (_, seq) => ({
        seq, at: '', deltaMs: 1, direction: 'in' as const, type: 'request', name: 'variables', bytes: 50,
      })),
    });
    const report = debugReport(record, { maxTokens: 1200 });
    assert.match(report, /reduced to fit ~1200 tokens; dropped:/);
  });

  it('states that nothing in the program was modified', () => {
    // The read-only guarantee is the reason this is safe to point at a live process. A briefing
    // that did not say so would leave a reader to assume either way.
    assert.match(debugReport(session()), /read-only: nothing in the program was modified/);
  });

  it('marks its findings as observations rather than conclusions', () => {
    const record = session({
      breakpoints: [{ kind: 'line', file: '/a.py', line: 1, verified: false }],
    });
    const report = debugReport(record);
    assert.match(report, /Observations with their evidence, not diagnoses/);
    assert.match(report, /never bound/);
  });

  it('handles a session with no stop without pretending otherwise', () => {
    const report = debugReport(session({ currentStop: undefined, status: 'running' }));
    assert.match(report, /Nothing is captured until it stops/);
  });

  it('produces a short summary that fits a chat prefix', () => {
    const summary = debugSummary(session());
    assert.match(summary, /Stopped: breakpoint/);
    assert.match(summary, /handler\.py:42/);
    assert.ok(estimateTokens(summary) < 200);
  });

  it('explains where a record\'s size is going', () => {
    const report = debugSizeReport(session());
    assert.match(report, /tokens total/);
    assert.match(report, /estimated at 4 characters per token/);
  });
});

describe('tool definitions for assistants that do not speak MCP', () => {
  it('describes when to use each tool in preference to the others', () => {
    // A model picks a tool from its description alone. A description that says only what a tool
    // returns leaves the choice between `get_debug_briefing` and `get_debug_session` to chance.
    const briefing = DEBUG_TOOL_SPECS.find((spec) => spec.name === 'get_debug_briefing')!;
    assert.match(briefing.description, /START HERE/);

    const full = DEBUG_TOOL_SPECS.find((spec) => spec.name === 'get_debug_session')!;
    assert.match(full.description, /LARGE/);
    assert.match(full.description, /Prefer get_debug_briefing/);
  });

  it('emits valid OpenAI function definitions', () => {
    for (const tool of openAiDebugTools() as Array<Record<string, any>>) {
      assert.equal(tool.type, 'function');
      assert.ok(tool.function.name);
      assert.ok(tool.function.description.length > 60);
      assert.equal(tool.function.parameters.type, 'object');
    }
  });

  it('strips defaults for Gemini, whose schema dialect rejects them', () => {
    const serialized = JSON.stringify(geminiDebugTools());
    assert.ok(!serialized.includes('"default"'), 'Gemini rejects `default` in a schema');
    // And the information is not lost -- every default is described in prose.
    assert.match(DEBUG_TOOL_SPECS[0]!.parameters.properties.session!.description as string, /Defaults to/);
  });

  it('uses input_schema for Anthropic rather than parameters', () => {
    for (const tool of anthropicDebugTools() as Array<Record<string, any>>) {
      assert.ok(tool.input_schema, 'the Messages API expects input_schema');
      assert.equal(tool.parameters, undefined);
    }
  });

  it('maps every tool to a route the HTTP server actually serves', () => {
    for (const spec of DEBUG_TOOL_SPECS) {
      assert.match(spec.route.path, /^\/debug/);
      assert.equal(spec.route.method, 'GET');
    }
  });
});

describe('finding out how a project is debugged', () => {
  it('reads a launch.json that has comments and trailing commas', async () => {
    const root = await mkdtemp(join(tmpdir(), 'auspex-launch-'));
    await mkdir(join(root, '.vscode'), { recursive: true });
    await writeFile(join(root, '.vscode', 'launch.json'), `{
  // The file VS Code generates for a new project contains comments by default,
  // so a strict JSON.parse would fail on the single most common case.
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Run server",
      "type": "debugpy",
      "request": "launch",
      "program": "\${workspaceFolder}/src/server.py",
    },
    {
      "name": "Attach to Go",
      "type": "go",
      "request": "attach"
    }
  ]
}`, 'utf8');

    const configurations = await findLaunchConfigurations(root);

    assert.equal(configurations.length, 2);
    assert.equal(configurations[0]?.name, 'Run server');
    assert.equal(configurations[0]?.adapter?.name, 'Python (debugpy)');
    assert.equal(configurations[1]?.request, 'attach');
  });

  it('reads a JetBrains run configuration and maps it to an adapter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'auspex-launch-'));
    await mkdir(join(root, '.idea', 'runConfigurations'), { recursive: true });
    await writeFile(join(root, '.idea', 'runConfigurations', 'app.xml'),
      '<component name="ProjectRunConfigurationManager">\n' +
      '  <configuration name="Server" type="PythonConfigurationType" factoryName="Python">\n' +
      '    <option name="SCRIPT_NAME" value="$PROJECT_DIR$/src/server.py" />\n' +
      '    <option name="WORKING_DIRECTORY" value="$PROJECT_DIR$" />\n' +
      '  </configuration>\n' +
      '</component>\n', 'utf8');

    const [configuration] = await findLaunchConfigurations(root);

    assert.equal(configuration?.name, 'Server');
    assert.equal(configuration?.editor, 'jetbrains');
    // JetBrains does not speak DAP internally, but its configuration still says which language the
    // project runs -- which is enough to recommend the right adapter.
    assert.equal(configuration?.type, 'debugpy');
    assert.match(configuration?.program ?? '', /server\.py/);
  });

  it('returns nothing rather than failing on a project with no configuration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'auspex-launch-'));
    assert.deepEqual(await findLaunchConfigurations(root), []);
  });

  it('gives an exact command when the adapter is a real program', () => {
    const wiring = wiringFor({
      name: 'Run server', type: 'debugpy', request: 'launch', source: 'x', editor: 'vscode',
      raw: {}, adapter: { id: 'debugpy', name: 'Python (debugpy)', languages: ['python'],
        command: { program: 'python', args: ['-m', 'debugpy.adapter'], install: 'pip install debugpy' },
        expected: { memory: false, disassembly: false, dataBreakpoints: false, stepBack: false, setVariable: true, modules: false },
        runtimePaths: [] },
    });

    assert.equal(wiring.confidence, 'exact');
    assert.equal(wiring.command, 'auspex proxy --dap --deep -- python -m debugpy.adapter');
    assert.match(wiring.explanation, /pip install debugpy/);
  });

  it('refuses to invent a command for an adapter that lives inside an extension', () => {
    const wiring = wiringFor({
      name: 'Launch', type: 'pwa-node', request: 'launch', source: 'x', editor: 'vscode',
      raw: {}, adapter: { id: 'pwa-node', name: 'Node.js (js-debug)', languages: ['javascript'],
        extensionHint: 'ms-vscode.js-debug',
        expected: { memory: false, disassembly: false, dataBreakpoints: false, stepBack: false, setVariable: true, modules: false },
        runtimePaths: [] },
    });

    // A confident-looking command that fails would be blamed on the user. Saying the real reason
    // and offering the socket route is the honest answer.
    assert.equal(wiring.confidence, 'pattern');
    assert.equal(wiring.command, undefined);
    assert.match(wiring.explanation, /varies by extension version/);
    assert.match(wiring.snippet ?? '', /debugServer/);
  });

  it('still says something useful for an adapter it has never heard of', () => {
    const wiring = wiringFor({
      name: 'Custom', type: 'my-own-adapter', request: 'launch', source: 'x', editor: 'unknown', raw: {},
    });
    assert.equal(wiring.confidence, 'manual');
    assert.match(wiring.explanation, /does not mean it will not work/);
    assert.match(wiring.explanation, /protocol-level and adapter-agnostic/);
  });

  it('recommends by language when there is no configuration to read', () => {
    const recommendations = recommendAdapters(['rust', 'python', 'rust']);
    assert.equal(recommendations.length, 2, 'duplicates should collapse');
    assert.ok(recommendations.find((item) => item.language === 'rust')?.adapters
      .some((adapter) => adapter.id === 'lldb'));
  });
});
