import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyseSession } from '../src/debug/analysis.ts';
import { adapterById, explainNoMemory, isUserCode } from '../src/debug/registry.ts';
import { currentLine, readFrameSource, renderSource } from '../src/debug/source-context.ts';
import type {
  DebugScope, DebugSessionRecord, DebugStop, DebugVariable,
} from '../src/core/debug-model.ts';

/**
 * Tests for the analysis layer.
 *
 * The thing worth testing here is **judgement**, not plumbing. An analyser that fires on everything
 * is noise and an analyser that fires on nothing is decoration; both pass a test that only checks
 * "a finding was produced". So most of these assert the *absence* of a finding as carefully as the
 * presence of one — that a variable named `null` in its value but not on the executing line does
 * not raise an alarm, that an empty collection alone is not a finding, that a two-frame stack is
 * not recursion.
 */

function variable(name: string, value: string, children?: DebugVariable[]): DebugVariable {
  return { name, value, ...(children ? { children } : {}) };
}

function scope(name: string, variables: DebugVariable[], extra: Partial<DebugScope> = {}): DebugScope {
  return { name, variables, ...extra };
}

function session(overrides: Partial<DebugSessionRecord> = {}): DebugSessionRecord {
  const stop: DebugStop = {
    index: 1,
    at: new Date().toISOString(),
    reason: 'breakpoint',
    threadId: 1,
    threads: [{ id: 1, name: 'main', stopped: true }],
    stacks: {
      1: [
        { id: 10, name: 'handle', file: '/app/src/handler.py', line: 42 },
        { id: 11, name: 'dispatch', file: '/usr/lib/python3.11/site-packages/flask/app.py', line: 9 },
      ],
    },
    frames: { 10: [scope('Locals', [variable('user', 'None'), variable('count', '3')])] },
    captureMs: 5,
    ...overrides.currentStop,
  };

  return {
    sessionId: 'test',
    adapterType: 'debugpy',
    startedAt: new Date().toISOString(),
    status: 'paused',
    currentStop: stop,
    stops: [], diffs: [], breakpoints: [], modules: [], loadedSources: [],
    evaluations: [], output: [], timeline: [],
    totals: {
      requests: 0, responses: 0, events: 0, probes: 0, failedResponses: 0,
      bytesIn: 0, bytesOut: 0, stops: 1,
    },
    warnings: [],
    ...overrides,
  };
}

const kinds = (result: { findings: Array<{ kind: string }> }) => result.findings.map((f) => f.kind);

describe('classifying user code against runtime', () => {
  it('separates a project\'s own frames from its dependencies', () => {
    const python = adapterById('debugpy');

    assert.equal(isUserCode('/app/src/handler.py', python), true);
    assert.equal(isUserCode('/usr/lib/python3.11/site-packages/flask/app.py', python), false);
    assert.equal(isUserCode('/usr/lib/python3.11/threading.py', python), false);
  });

  it('treats a frame with no path as runtime, and an unknown path as the user\'s', () => {
    // Being wrong generously shows one extra frame; being wrong strictly hides the line the bug is
    // on. Only one of those is recoverable, which is what fixes the direction of this default.
    assert.equal(isUserCode(undefined), false);
    assert.equal(isUserCode('/some/unknown/project/file.rb'), true);
  });

  it('recognizes package directories even for an adapter it has never heard of', () => {
    assert.equal(isUserCode('/work/node_modules/express/lib/router.js'), false);
    assert.equal(isUserCode('/home/me/go/pkg/mod/github.com/x/y.go'), false);
    assert.equal(isUserCode('/work/src/main.go'), true);
  });

  it('distinguishes the three reasons memory can be empty', () => {
    assert.match(explainNoMemory('debugpy', true), /no variable at this stop carried an address/);
    assert.match(explainNoMemory('debugpy', false), /does not expose memory addresses/);
    assert.match(explainNoMemory('mystery-adapter', undefined), /did not advertise support/);
  });
});

describe('analysing a stop', () => {
  it('leads with the exception and follows its chain to the cause', () => {
    const record = session();
    record.currentStop!.reason = 'exception';
    record.currentStop!.exception = {
      exceptionId: 'ValueError',
      typeName: 'ValueError',
      message: 'bad id',
      breakMode: 'unhandled',
      innerException: { exceptionId: 'KeyError', typeName: 'KeyError', message: 'missing' },
    };

    const result = analyseSession(record);
    const finding = result.findings.find((item) => item.kind === 'exception')!;

    assert.equal(finding.severity, 'high');
    assert.match(finding.summary, /ValueError.*bad id/);
    assert.ok(finding.evidence.some((line) => line.includes('KeyError')));
    // The outermost exception is usually a wrapper; saying so is the difference between pointing
    // at the symptom and pointing at the cause.
    assert.match(finding.nextStep ?? '', /innermost/);
  });

  it('says where the user\'s code starts when the top frames are runtime', () => {
    const record = session();
    record.currentStop!.stacks[1] = [
      { id: 1, name: 'inner', file: '/usr/lib/python3.11/site-packages/x.py', line: 1 },
      { id: 2, name: 'wrapper', file: '/usr/lib/python3.11/threading.py', line: 2 },
      { id: 10, name: 'handle', file: '/app/src/handler.py', line: 42 },
    ];

    const result = analyseSession(record);
    const finding = result.findings.find((item) => item.kind === 'user-code-depth')!;

    assert.match(finding.summary, /frame #2 \(handle\)/);
    assert.equal(result.userFrames.length, 1);
    assert.equal(result.runtimeFrameCount, 2);
  });

  it('raises an empty value only when the executing line actually uses it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'auspex-analysis-'));
    const file = join(directory, 'handler.py');
    await writeFile(file, [
      'def handle(request):',
      '    count = 3',
      '    user = lookup(request.id)',
      '    return user.name',
    ].join('\n'), 'utf8');

    const record = session();
    record.currentStop!.stacks[1] = [{ id: 10, name: 'handle', file, line: 4 }];

    const source = await readFrameSource({ id: 10, name: 'handle', file, line: 4 });
    const result = analyseSession(record, { sources: { 10: source! } });

    // `user` is None and line 4 reads `return user.name`. That correlation is the finding.
    const finding = result.findings.find((item) => item.kind === 'empty-value-in-use')!;
    assert.ok(finding, 'the empty value used on the executing line should be raised');
    assert.match(finding.summary, /user is None/);
    // And it says where the value is *used*, not where it went wrong -- a distinction that decides
    // whether a reader looks in the right place.
    assert.match(finding.nextStep ?? '', /not necessarily where it went wrong/);
  });

  it('does not raise an empty value that the executing line never mentions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'auspex-analysis-'));
    const file = join(directory, 'other.py');
    await writeFile(file, 'def handle(request):\n    return 1\n', 'utf8');

    const record = session();
    record.currentStop!.stacks[1] = [{ id: 10, name: 'handle', file, line: 2 }];

    const source = await readFrameSource({ id: 10, name: 'handle', file, line: 2 });
    const result = analyseSession(record, { sources: { 10: source! } });

    // `user` is still None, but nothing on line 2 touches it. Firing here would be the noise that
    // makes an analyser worth ignoring.
    assert.ok(!kinds(result).includes('empty-value-in-use'));
    // It is still recorded as suspicious, for correlation elsewhere.
    assert.ok(result.suspiciousValues.some((item) => item.path === 'user'));
  });

  it('treats an empty collection as weaker evidence than a null', () => {
    const record = session();
    record.currentStop!.frames[10] = [scope('Locals', [variable('items', '[]')])];

    const result = analyseSession(record);
    assert.ok(!kinds(result).includes('empty-value-in-use'));
    assert.equal(result.suspiciousValues[0]?.reason, 'is an empty collection');
  });

  it('does not treat a string containing the word null as a null', () => {
    const record = session();
    record.currentStop!.frames[10] = [scope('Locals', [variable('note', "'null was returned'")])];

    const result = analyseSession(record);
    assert.equal(result.suspiciousValues.length, 0);
  });

  it('finds an error value being carried as data', () => {
    const record = session();
    record.currentStop!.frames[10] = [scope('Locals', [
      variable('result', 'Err(ConnectionRefused)'),
    ])];

    const finding = analyseSession(record).findings.find((item) => item.kind === 'error-value')!;
    assert.match(finding.summary, /Err\(ConnectionRefused\)/);
  });

  it('detects recursion, and escalates when it is deep enough to overflow', () => {
    const record = session();
    const frame = (id: number) => ({ id, name: 'walk', file: '/app/src/tree.py', line: 12 });

    record.currentStop!.stacks[1] = Array.from({ length: 6 }, (_, i) => frame(i));
    assert.equal(analyseSession(record).findings.find((f) => f.kind === 'recursion')?.severity, 'medium');

    record.currentStop!.stacks[1] = Array.from({ length: 30 }, (_, i) => frame(i));
    const deep = analyseSession(record).findings.find((f) => f.kind === 'recursion')!;
    assert.equal(deep.severity, 'high');
    assert.match(deep.nextStep ?? '', /base case/);
  });

  it('does not call an ordinary stack recursive', () => {
    const record = session();
    record.currentStop!.stacks[1] = [
      { id: 1, name: 'a', file: '/app/a.py', line: 1 },
      { id: 2, name: 'b', file: '/app/b.py', line: 1 },
      { id: 3, name: 'c', file: '/app/c.py', line: 1 },
    ];
    assert.ok(!kinds(analyseSession(record)).includes('recursion'));
  });

  it('flags a breakpoint that never bound, which is why it never fired', () => {
    const record = session();
    record.breakpoints = [
      { kind: 'line', file: '/app/src/handler.py', line: 42, verified: true },
      { kind: 'line', file: '/app/src/gone.py', line: 9, verified: false, message: 'no code here' },
    ];

    const finding = analyseSession(record).findings.find((item) => item.kind === 'unverified-breakpoints')!;
    assert.equal(finding.severity, 'high');
    assert.match(finding.evidence[0] ?? '', /gone\.py:9 — no code here/);
    assert.match(finding.nextStep ?? '', /stale build|path mapping|source map/);
  });

  it('points out that two consecutive stops changed nothing', () => {
    const record = session();
    record.diffs = [{
      fromStop: 1, toStop: 2, elapsedMs: 40, framesEntered: [], framesLeft: [],
      changed: [], added: [], removed: [], unchangedCount: 12,
    }];

    const finding = analyseSession(record).findings.find((item) => item.kind === 'no-change')!;
    assert.match(finding.summary, /Nothing changed/);
    assert.match(finding.nextStep ?? '', /branch/);
  });

  it('notices a location being stopped at over and over', () => {
    const record = session();
    const previous = () => structuredClone(record.currentStop!);
    record.stops = [previous(), previous(), previous()];

    const finding = analyseSession(record).findings.find((item) => item.kind === 'repeated-stop')!;
    assert.match(finding.summary, /4 times/);
    assert.match(finding.nextStep ?? '', /condition or a hit count/);
  });

  it('reports a skipped scope rather than presenting it as empty', () => {
    const record = session();
    record.currentStop!.frames[10] = [
      scope('Globals', [], { skipped: 'the adapter marked this scope expensive', expensive: true }),
    ];

    const finding = analyseSession(record).findings.find((item) => item.kind === 'scope-skipped')!;
    assert.match(finding.summary, /Globals scope was not captured/);
  });

  it('says the session is running rather than inventing a stop', () => {
    const record = session();
    record.currentStop = undefined;
    record.status = 'running';

    const result = analyseSession(record);
    assert.deepEqual(kinds(result), ['no-stop']);
    assert.match(result.headline, /running/);
  });

  it('warns when the adapter is failing most of its requests', () => {
    const record = session();
    record.totals.responses = 40;
    record.totals.failedResponses = 15;

    const finding = analyseSession(record).findings.find((item) => item.kind === 'adapter-errors')!;
    assert.match(finding.summary, /38% of this adapter's responses were failures/);
  });

  it('writes a headline that answers the question on its own', () => {
    const record = session();
    const result = analyseSession(record);

    assert.match(result.headline, /debugpy program is stopped \(breakpoint\)/);
    assert.match(result.headline, /handle at \/app\/src\/handler\.py:42/);
    assert.match(result.headline, /2 frame\(s\), 1 of them this project's own/);
  });

  it('ranks findings so the useful one is first', () => {
    const record = session();
    record.currentStop!.reason = 'exception';
    record.currentStop!.exception = { exceptionId: 'E', typeName: 'E', message: 'x' };
    record.currentStop!.incomplete = ['memory reads stopped at the time budget'];

    const result = analyseSession(record);
    assert.equal(result.findings[0]?.severity, 'high');
    assert.equal(result.findings.at(-1)?.kind, 'incomplete-capture');
  });

  it('attaches evidence to every finding', () => {
    const record = session();
    record.currentStop!.reason = 'exception';
    record.currentStop!.exception = { exceptionId: 'E', typeName: 'E', message: 'x' };
    record.breakpoints = [{ kind: 'line', file: '/a.py', line: 1, verified: false }];

    // An unattributed finding is an opinion, and a reader cannot check an opinion. This is the
    // property that makes the whole layer an aid rather than a source of confident errors.
    for (const finding of analyseSession(record).findings) {
      assert.ok(finding.evidence.length > 0, `${finding.kind} has no evidence`);
    }
  });
});

describe('reading source around a frame', () => {
  it('returns a window with the current line marked', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'auspex-source-'));
    const file = join(directory, 'sample.js');
    await writeFile(file, Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n'), 'utf8');

    const source = (await readFrameSource({ id: 1, name: 'f', file, line: 10 }, { radius: 2 }))!;

    assert.deepEqual(source.lines.map((line) => line.number), [8, 9, 10, 11, 12]);
    assert.equal(source.lines.find((line) => line.current)?.text, 'line 10');
    assert.equal(currentLine(source), 'line 10');

    const rendered = renderSource(source);
    assert.ok(rendered.some((line) => line.startsWith('>')));
  });

  it('clamps the window at the start and end of a file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'auspex-source-'));
    const file = join(directory, 'short.js');
    await writeFile(file, 'a\nb\nc\n', 'utf8');

    const first = (await readFrameSource({ id: 1, name: 'f', file, line: 1 }, { radius: 5 }))!;
    assert.deepEqual(first.lines.map((line) => line.number), [1, 2, 3, 4]);
  });

  it('says the running code does not match the file when the line is past its end', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'auspex-source-'));
    const file = join(directory, 'stale.js');
    await writeFile(file, 'one\ntwo\n', 'utf8');

    const source = (await readFrameSource({ id: 1, name: 'f', file, line: 900 }))!;

    // This is diagnostic, not cosmetic: it means every conclusion drawn from reading that file
    // will be wrong, and a reader needs telling.
    assert.equal(source.lines.length, 0);
    assert.match(source.unavailable ?? '', /does not match the file on disk/);
    assert.match(source.unavailable ?? '', /stale build/);
  });

  it('distinguishes a missing file from a frame that has no source at all', async () => {
    const missing = (await readFrameSource({ id: 1, name: 'f', file: '/nope/gone.js', line: 3 }))!;
    assert.match(missing.unavailable ?? '', /not readable/);

    const native = (await readFrameSource({ id: 2, name: 'native_call' }))!;
    assert.match(native.unavailable ?? '', /inside a runtime or generated code/);

    const inMemory = (await readFrameSource({ id: 3, name: 'eval', sourceName: '<eval>' }))!;
    assert.match(inMemory.unavailable ?? '', /in memory rather than on disk/);
  });

  it('reads a file once even when many frames share it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'auspex-source-'));
    const file = join(directory, 'recursive.js');
    await writeFile(file, Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n'), 'utf8');

    const cache = new Map<string, string[] | null>();
    for (const line of [5, 10, 15]) {
      await readFrameSource({ id: line, name: 'walk', file, line }, {}, cache);
    }
    assert.equal(cache.size, 1);
  });
});
