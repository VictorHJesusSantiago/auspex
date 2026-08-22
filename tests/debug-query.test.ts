import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { queryJournal, queryRecord, renderMatches, renderTrajectory, trajectory, trajectoryFromJournal } from '../src/debug/query.ts';
import { DebugJournal } from '../src/debug/journal.ts';
import { compareBundles, createBundle, readBundle, writeBundle } from '../src/debug/bundle.ts';
import { Redactor } from '../src/core/redact.ts';
import type { DebugScope, DebugSessionRecord, DebugStop } from '../src/core/debug-model.ts';

/**
 * Tests for searching a session and for portable bundles.
 *
 * The capability being tested is the one no IDE has — asking a *historical* question of a debug
 * session — so the tests are shaped around historical questions: when did this change, was it ever
 * something else, which iteration was the first bad one. The properties that matter are that a
 * negative answer is honest about its scope (a bounded record cannot say "never") and that a
 * variable holding steady for four hundred stops reads as one line rather than four hundred.
 */

function stopAt(index: number, values: Record<string, string>, frame = 'handle'): DebugStop {
  return {
    index,
    at: new Date(1_700_000_000_000 + index * 1000).toISOString(),
    reason: index === 1 ? 'breakpoint' : 'step',
    threadId: 1,
    threads: [{ id: 1, name: 'main', stopped: true }],
    stacks: { 1: [{ id: 10, name: frame, file: '/app/handler.py', line: 40 + index }] },
    frames: {
      10: [{
        name: 'Locals',
        variables: Object.entries(values).map(([name, value]) => ({ name, value })),
      } as DebugScope],
    },
    captureMs: 2,
  };
}

function recordWith(stops: DebugStop[], totalStops = stops.length): DebugSessionRecord {
  return {
    sessionId: 'query',
    adapterType: 'debugpy',
    startedAt: new Date().toISOString(),
    status: 'paused',
    currentStop: stops.at(-1),
    stops: stops.slice(0, -1),
    diffs: [], breakpoints: [], modules: [], loadedSources: [],
    evaluations: [], output: [], timeline: [],
    totals: {
      requests: 0, responses: 0, events: 0, probes: 0, failedResponses: 0,
      bytesIn: 0, bytesOut: 0, stops: totalStops,
    },
    warnings: [],
  };
}

describe('searching every captured stop', () => {
  const stops = [
    stopAt(1, { user: 'None', retries: '0' }),
    stopAt(2, { user: 'None', retries: '1' }),
    stopAt(3, { user: '<User id=7>', retries: '1' }),
  ];

  it('finds a variable by name across the session', () => {
    const result = queryRecord(recordWith(stops), { name: 'retries' });

    assert.equal(result.matches.length, 3);
    assert.deepEqual(result.matches.map((match) => match.stopIndex), [1, 2, 3]);
    assert.equal(result.source, 'record');
  });

  it('finds every null in any language\'s spelling, by kind', () => {
    const result = queryRecord(recordWith(stops), { kind: 'empty' });

    // A search by kind is what makes this language-agnostic: the query never mentions `None`.
    assert.equal(result.matches.length, 2);
    assert.ok(result.matches.every((match) => match.name === 'user'));
  });

  it('answers "when did this stop being null" by what it does not match', () => {
    const nulls = queryRecord(recordWith(stops), { name: 'user', kind: 'empty' });
    assert.deepEqual(nulls.matches.map((match) => match.stopIndex), [1, 2]);
    // Stop 3 is where it became something, which is the answer to the question.
  });

  it('restricts to a range of stops', () => {
    const result = queryRecord(recordWith(stops), { name: 'retries', fromStop: 2, toStop: 3 });
    assert.deepEqual(result.matches.map((match) => match.stopIndex), [2, 3]);
  });

  it('reports the frame and line of every match, not just the value', () => {
    const [match] = queryRecord(recordWith(stops), { name: 'user' }).matches;
    assert.equal(match?.frame, 'handle');
    assert.equal(match?.file, '/app/handler.py');
    assert.equal(match?.scope, 'Locals');
  });

  it('says when the record it searched cannot cover the whole session', () => {
    // A bounded ring answering "no match" without saying so would be answering a different
    // question than the one asked -- "never" versus "not in the last twenty stops".
    const result = queryRecord(recordWith(stops, 400), { name: 'nothing-like-this' });

    assert.equal(result.matches.length, 0);
    assert.match(result.caveat ?? '', /3 of 400 stop\(s\)/);
    assert.match(result.caveat ?? '', /journal/);
  });

  it('matches nothing rather than everything when given no criteria', () => {
    // Returning an entire session because someone forgot a filter is a worse failure than
    // returning nothing.
    assert.equal(queryRecord(recordWith(stops), {}).matches.length, 0);
  });

  it('searches a journal without loading it, and covers stops the record dropped', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'auspex-query-'));
    const path = join(directory, 'long.ndjson');
    const journal = new DebugJournal('long', { path });

    await journal.begin({ sessionId: 'long', startedAt: new Date().toISOString() });
    for (let index = 1; index <= 300; index++) {
      journal.stop(stopAt(index, { retries: String(Math.floor(index / 100)) }));
    }
    await journal.flush();

    const result = await queryJournal(path, { name: 'retries', value: '2', limit: 500 });

    assert.equal(result.source, 'journal');
    // Stops 200 through 299 — a hundred of them, every one of which the twenty-stop live record
    // lost long ago.
    assert.equal(result.matches.length, 100);
    assert.equal(result.matches[0]?.stopIndex, 200);
  });

  it('renders a helpful empty answer', () => {
    const rendered = renderMatches(queryRecord(recordWith(stops, 400), { name: 'zzz' })).join('\n');
    assert.match(rendered, /no match across 3 stop\(s\)/);
    assert.match(rendered, /journal/);
  });
});

describe('tracing one variable through a session', () => {
  it('shows the trajectory that describes a bug', () => {
    const stops = [
      stopAt(1, { retries: '0' }), stopAt(2, { retries: '0' }), stopAt(3, { retries: '0' }),
      stopAt(4, { retries: '1' }), stopAt(5, { retries: '1' }),
      stopAt(6, { retries: '2' }), stopAt(7, { retries: '3' }),
    ];

    const history = trajectory(stops, 'retries');

    assert.equal(history.seenIn, 7);
    assert.equal(history.changes, 3);
    // Collapsed: a variable that held 0 for three stops is one line, not three. Without this a
    // four-hundred-stop session would render as four hundred identical rows.
    assert.deepEqual(history.points.map((point) => point.value), ['0', '1', '2', '3']);
    assert.deepEqual(history.points.map((point) => point.stopIndex), [1, 4, 6, 7]);
    assert.equal(history.points[0]?.changed, false);
    assert.equal(history.points[1]?.changed, true);
  });

  it('records where each change happened, not only what it became', () => {
    const history = trajectory([stopAt(1, { x: 'a' }), stopAt(2, { x: 'b' })], 'x');
    assert.equal(history.points[1]?.file, '/app/handler.py');
    assert.equal(history.points[1]?.line, 42);
    assert.equal(history.points[1]?.frame, 'handle');
  });

  it('counts distinct values, most frequent first', () => {
    const stops = [
      stopAt(1, { state: 'idle' }), stopAt(2, { state: 'busy' }),
      stopAt(3, { state: 'idle' }), stopAt(4, { state: 'idle' }),
    ];
    const history = trajectory(stops, 'state');
    assert.deepEqual(history.distinct[0], { value: 'idle', count: 3 });
  });

  it('follows a dotted path into a nested value', () => {
    const nested = (id: string): DebugStop => ({
      ...stopAt(1, {}),
      frames: {
        10: [{
          name: 'Locals',
          variables: [{ name: 'request', value: '<Request>', children: [{ name: 'id', value: id }] }],
        } as DebugScope],
      },
    });
    const history = trajectory([{ ...nested('1'), index: 1 }, { ...nested('2'), index: 2 }], 'request.id');
    assert.deepEqual(history.points.map((point) => point.value), ['1', '2']);
  });

  it('says plainly when the variable was never there', () => {
    const history = trajectory([stopAt(1, { a: '1' })], 'missing');
    assert.equal(history.points.length, 0);
    assert.match(renderTrajectory(history).join('\n'), /never present in any captured stop/);
  });

  it('traces from a journal, streamed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'auspex-trace-'));
    const path = join(directory, 'trace.ndjson');
    const journal = new DebugJournal('trace', { path });

    await journal.begin({ sessionId: 'trace', startedAt: new Date().toISOString() });
    for (let index = 1; index <= 50; index++) {
      journal.stop(stopAt(index, { counter: String(index % 5) }));
    }
    await journal.flush();

    const history = await trajectoryFromJournal(path, 'counter');
    assert.equal(history.seenIn, 50);
    assert.equal(history.distinct.length, 5);
  });
});

describe('portable session bundles', () => {
  const record = recordWith([stopAt(1, { user: 'None', token: `sk-ant-api03-${'C'.repeat(90)}` })]);

  it('carries everything a recipient needs, including a readable summary', async () => {
    const bundle = await createBundle(record, { note: 'crashes on the second request' });

    assert.equal(bundle.bundleVersion, '1');
    assert.equal(bundle.note, 'crashes on the second request');
    assert.ok(bundle.environment.platform);
    assert.ok(bundle.analysis.headline);

    // The summary is what makes a bundle readable by someone who has the file and nothing else.
    assert.match(bundle.summary, /AUSPEX DEBUG BUNDLE/);
    assert.match(bundle.summary, /crashes on the second request/);
    assert.match(bundle.summary, /handle/);
    assert.match(bundle.summary, /nothing in the program was modified/);
  });

  it('warns about what it contains, every time', async () => {
    const bundle = await createBundle(record);
    // A bundle is meant to be shared, so the moment of making one is the moment the person still
    // has the chance to read it first.
    assert.match(bundle.warning, /source code and the state of a running program/);
    assert.match(bundle.warning, /cannot catch application data/);
    assert.match(bundle.summary, /Read it before sharing it/);
  });

  it('redacts before it is written, not on read', async () => {
    const bundle = await createBundle(record, { redactor: new Redactor(true) });
    const serialized = JSON.stringify(bundle);

    assert.ok(!serialized.includes('sk-ant-api03-CCCC'), 'a secret survived into the bundle');
    assert.match(serialized, /\[redacted:/);
  });

  it('round-trips through gzip and is detected by content, not by name', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'auspex-bundle-'));
    const compressed = join(directory, 'session.json.gz');
    const renamed = join(directory, 'session.bin');

    const bundle = await createBundle(record);
    const bytes = await writeBundle(compressed, bundle);
    assert.ok(bytes > 0);

    const back = await readBundle(compressed);
    assert.equal(back.summary, bundle.summary);

    // A bundle renamed without its extension should still open: the gzip magic number is the
    // authority, not the filename.
    await writeBundle(renamed, bundle);
    const plain = await readBundle(renamed);
    assert.equal(plain.bundleVersion, '1');

    await unlink(compressed).catch(() => {});
  });

  it('refuses a file that is not a bundle', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'auspex-bundle-'));
    const path = join(directory, 'not-a-bundle.json');
    await writeBundle(path, { hello: 'world' } as never);

    await assert.rejects(() => readBundle(path), /not an Auspex debug bundle/);
  });

  it('compares the run that worked against the run that did not', async () => {
    const a = await createBundle(recordWith([stopAt(1, { user: '<User id=7>', retries: '0' })]));
    const b = await createBundle(recordWith([stopAt(1, { user: 'None', retries: '3' })]));

    const comparison = compareBundles(a, b);

    assert.equal(comparison.sameLocation, true);
    assert.match(comparison.summary, /same place/);
    assert.equal(comparison.valueDifferences.length, 2);

    const user = comparison.valueDifferences.find((item) => item.path.endsWith('user'))!;
    assert.equal(user.a, '<User id=7>');
    assert.equal(user.b, 'None');
  });

  it('reports different locations rather than pretending to compare values', async () => {
    const a = await createBundle(recordWith([stopAt(1, { x: '1' }, 'alpha')]));
    const b = await createBundle(recordWith([stopAt(2, { x: '1' }, 'beta')]));

    const comparison = compareBundles(a, b);
    assert.equal(comparison.sameLocation, false);
    assert.match(comparison.summary, /Different locations/);
    assert.ok(comparison.stackDifferences.some((line) => line.includes('alpha')));
  });
});
