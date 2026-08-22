import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  inferShape, interpretValue, interpretTree, renderCollectionSummary, summarizeCollection,
} from '../src/debug/values.ts';
import {
  decodeBytes, decodeRegisters, renderDecodedMemory,
} from '../src/debug/memory-decode.ts';
import { analyseConcurrency, classifyStack } from '../src/debug/concurrency.ts';
import type { DebugStop, DebugVariable } from '../src/core/debug-model.ts';

/**
 * Tests for the language-agnostic value, memory and concurrency layers.
 *
 * These interpret *formatted strings and raw bytes*, which means the only way to know they work is
 * to feed them what real runtimes actually produce. So the value tests are a tour of how eleven
 * languages print the same handful of ideas, the memory tests build real byte layouts, and the
 * concurrency tests use stack shapes taken from how each runtime names its own primitives.
 *
 * The negative assertions carry as much weight as the positive ones. An interpreter that labels
 * everything a collection is worse than one that labels nothing, because a confident wrong kind
 * propagates into the analysis, the briefing and the search.
 */

describe('interpreting values from any language', () => {
  it('recognizes absence however a runtime spells it', () => {
    for (const value of ['null', 'nil', 'None', 'undefined', 'nullptr', 'Nothing', '<null>', '()']) {
      assert.equal(interpretValue(value).kind, 'empty', `${value} should be empty`);
    }
  });

  it('does not mistake a string containing a keyword for the keyword', () => {
    // The single most likely way to be confidently wrong here.
    assert.equal(interpretValue("'null'").kind, 'string');
    assert.equal(interpretValue('"None found"').kind, 'string');
    assert.equal(interpretValue('nullable_field').kind, 'opaque');
  });

  it('trusts the type over the formatting when they disagree', () => {
    // A Python string that happens to contain brackets. The type is the debugger stating a fact;
    // the value is the debugger's formatting of it.
    const interpreted = interpretValue('[1, 2, 3]', 'str');
    assert.equal(interpreted.kind, 'string');
    assert.equal(interpreted.confidence, 'certain');
  });

  it('tells an ordered container from a keyed one by its separators', () => {
    assert.equal(interpretValue('[1, 2, 3]').kind, 'collection');
    assert.equal(interpretValue('{1, 2, 3}').kind, 'collection');       // A set: braces, no keys.
    assert.equal(interpretValue("{'a': 1, 'b': 2}").kind, 'map');       // Python dict.
    assert.equal(interpretValue('{a => 1, b => 2}').kind, 'map');       // Ruby / PHP.
    assert.equal(interpretValue('map[foo:1 bar:2]', 'map[string]int').kind, 'map');
  });

  it('counts elements without being fooled by nesting or quotes', () => {
    // Depth tracking and quote tracking: a naive comma count reports five and four.
    assert.equal(interpretValue('[1, [2, 3], 4]').size, 3);
    assert.equal(interpretValue('["a, b", "c"]').size, 2);
  });

  it('reads containers from the type when the value gives nothing away', () => {
    for (const [value, type] of [
      ['<Vec of 3>', 'Vec<String>'],
      ['ArrayList@1a2b', 'java.util.ArrayList'],
      ['0x00 len=4', '[]byte'],
      ['{...}', 'HashMap<String, i32>'],
    ] as Array<[string, string]>) {
      const kind = interpretValue(value, type).kind;
      assert.ok(['collection', 'map', 'binary'].includes(kind), `${type} gave ${kind}`);
    }
  });

  it('unwraps the wrappers functional languages carry absence and failure in', () => {
    assert.equal(interpretValue('Some(42)').kind, 'optional');
    assert.equal(interpretValue('Some(42)').inner, '42');
    assert.equal(interpretValue('None').kind, 'empty');
    assert.equal(interpretValue('Ok("done")').kind, 'optional');

    // A Result in its failed state is a failure sitting in a variable, and that is the single most
    // important thing about it -- reporting it as an opaque object would throw that away.
    const error = interpretValue('Err(ConnectionRefused)');
    assert.equal(error.kind, 'error');
    assert.equal(error.inner, 'ConnectionRefused');
  });

  it('marks a future that has not resolved as not being the data yet', () => {
    const pending = interpretValue('Promise { <pending> }');
    assert.equal(pending.kind, 'future');
    assert.equal(pending.incomplete, true);

    assert.equal(interpretValue('Promise { <rejected> }').kind, 'error');
    assert.equal(interpretValue('<generator object gen at 0x7f>').kind, 'lazy');
    assert.equal(interpretValue('<generator object gen at 0x7f>').incomplete, true);
  });

  it('distinguishes a pointer from a null pointer', () => {
    const pointer = interpretValue('0x7ffd4a2b1000', 'Node *');
    assert.equal(pointer.kind, 'pointer');
    assert.equal(pointer.address, '0x7ffd4a2b1000');

    // A null pointer is an absence wearing a pointer's clothes, and the distinction is what a
    // reader is actually asking about.
    assert.equal(interpretValue('0x0', 'Node *').kind, 'empty');
  });

  it('notices a repr the debugger already truncated', () => {
    const cut = interpretValue("'aaaaaaaaaaaaaaaaaaaa...'");
    assert.equal(cut.kind, 'string');
    // A reader treating a truncated repr as the whole string will draw a wrong conclusion about
    // its contents.
    assert.equal(cut.incomplete, true);
  });

  it('reads numbers in every base and boolean in every spelling', () => {
    for (const value of ['42', '-1', '3.14', '1e-9', '0xff', '0b1010', '0o755', '1_000_000']) {
      assert.equal(interpretValue(value).kind, 'scalar', value);
    }
    for (const value of ['true', 'False', '#t', 'yes']) {
      assert.equal(interpretValue(value).kind, 'scalar', value);
    }
  });

  it('says why it reached every interpretation', () => {
    // An interpretation a reader cannot check is an assertion, not an analysis.
    for (const value of ['null', '[1,2]', '0xdeadbeef', 'Err(x)', "'text'", 'mystery']) {
      assert.ok(interpretValue(value).because, `${value} gave no reason`);
    }
  });

  it('never discards the debugger\'s own string', () => {
    const raw = '<CustomThing at 0x1 with 5 items>';
    assert.equal(interpretValue(raw).raw, raw);
  });

  it('admits when nothing matched instead of guessing', () => {
    const opaque = interpretValue('§±¬ unusual ¬±§');
    assert.equal(opaque.kind, 'opaque');
    assert.equal(opaque.confidence, 'guess');
  });
});

describe('inferring shape from dynamically typed values', () => {
  const child = (name: string, value: string, type?: string): DebugVariable => ({ name, value, type });

  it('recovers a record shape a dynamic language never declared', () => {
    const variable: DebugVariable = {
      name: 'user',
      value: '{...}',
      children: [child('id', '7'), child('name', "'ada'"), child('admin', 'true')],
    };
    const shape = inferShape(variable).shape;

    assert.match(shape, /id: number/);
    assert.match(shape, /name: string/);
    assert.match(shape, /admin: boolean/);
  });

  it('detects an array and whether its elements agree', () => {
    const homogeneous: DebugVariable = {
      name: 'ids', value: '[…]',
      children: [child('0', '1'), child('1', '2'), child('2', '3')],
    };
    assert.equal(inferShape(homogeneous).shape, 'number[]');
    assert.equal(inferShape(homogeneous).heterogeneous, false);

    const mixed: DebugVariable = {
      name: 'stuff', value: '[…]',
      children: [child('0', '1'), child('1', "'two'"), child('2', 'null')],
    };
    // A heterogeneous list is a fact worth surfacing: in most codebases it is a bug.
    assert.equal(inferShape(mixed).heterogeneous, true);
  });

  it('agrees with the declared type when there is one', () => {
    assert.equal(inferShape(child('n', '5', 'int')).shape, 'int');
  });
});

describe('summarizing a collection instead of listing it', () => {
  const numbers: DebugVariable = {
    name: 'values',
    value: '[…]',
    indexedVariables: 50000,
    children: Array.from({ length: 200 }, (_, i) => ({
      name: String(i),
      value: String(i % 2 === 0 ? i : -i),
      type: 'int',
    })),
  };

  it('describes fifty thousand numbers in one line', () => {
    const summary = summarizeCollection(numbers, 50000);

    assert.equal(summary.count, 50000);
    assert.equal(summary.sampled, true, 'it must say the statistics come from a sample');
    assert.equal(summary.homogeneous, true);
    assert.ok(summary.numeric);
    assert.ok(summary.numeric.negative > 0);

    const rendered = renderCollectionSummary(summary);
    assert.match(rendered, /50,000 entries/);
    assert.match(rendered, /negative/);
    assert.match(rendered, /sampled, not exhaustive/);
  });

  it('samples from the middle and end, not just the head', () => {
    // A list that goes wrong usually goes wrong away from its head, which is exactly what a
    // hundred-element prefix hides.
    const summary = summarizeCollection(numbers, 50000);
    const indices = summary.examples.map((example) => Number(example.split(' ')[0]));

    assert.ok(indices.some((index) => index > 90), `only saw ${indices.join(',')}`);
    assert.ok(indices.some((index) => index < 5));
  });

  it('reports string statistics for a collection of strings', () => {
    const strings: DebugVariable = {
      name: 'names', value: '[…]',
      children: [
        { name: '0', value: "''" }, { name: '1', value: "'ada'" },
        { name: '2', value: "'ada'" }, { name: '3', value: "'grace'" },
      ],
    };
    const summary = summarizeCollection(strings);

    assert.equal(summary.strings?.empty, 1);
    assert.equal(summary.strings?.distinct, 3);
  });

  it('counts nulls hiding inside a collection', () => {
    const withNulls: DebugVariable = {
      name: 'rows', value: '[…]',
      children: [
        { name: '0', value: '1' }, { name: '1', value: 'null' },
        { name: '2', value: 'None' }, { name: '3', value: '4' },
      ],
    };
    assert.equal(summarizeCollection(withNulls).empties, 2);
  });

  it('walks a whole tree, keying by path', () => {
    const interpreted = interpretTree([
      { name: 'a', value: 'null' },
      { name: 'b', value: '{…}', children: [{ name: 'c', value: '[1,2]' }] },
    ]);
    assert.equal(interpreted.get('a')?.kind, 'empty');
    assert.equal(interpreted.get('b.c')?.kind, 'collection');
  });
});

describe('reading raw memory', () => {
  it('finds a NUL-terminated C string and scores it highly', () => {
    const bytes = Buffer.concat([Buffer.from('GET /index.html', 'ascii'), Buffer.from([0, 0, 0, 0])]);
    const decoded = decodeBytes(bytes);
    const reading = decoded.readings.find((item) => item.as.includes('C string'))!;

    assert.ok(reading, 'a C string reading should be present');
    assert.match(reading.value, /GET \/index\.html/);
    assert.ok(reading.plausibility > 0.9);
    assert.match(reading.because, /NUL-terminated/);
  });

  it('finds a UTF-16 string, which the ASCII scan alone would chop up', () => {
    const bytes = Buffer.concat([Buffer.from('Hello', 'utf16le'), Buffer.from([0, 0])]);
    const decoded = decodeBytes(bytes);

    assert.ok(decoded.readings.some((reading) => reading.as.includes('UTF-16')));
    assert.ok(decoded.strings.some((found) => found.encoding === 'utf16' && found.text === 'Hello'));
  });

  it('recognizes a length prefix only when it agrees with the data', () => {
    const text = Buffer.from('hello world', 'ascii');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(text.length, 0);

    const good = decodeBytes(Buffer.concat([header, text]));
    assert.ok(good.readings.some((reading) => reading.as.includes('length prefix')));

    // A header claiming a length the data does not support is not a length prefix, and firing here
    // would make the reading meaningless.
    const wrong = Buffer.alloc(4);
    wrong.writeUInt32LE(9999, 0);
    const bad = decodeBytes(Buffer.concat([wrong, text]));
    assert.ok(!bad.readings.some((reading) => reading.as.includes('length prefix')));
  });

  it('names the debug fill patterns that are already an answer', () => {
    const freed = decodeBytes(Buffer.alloc(64, 0xdd));
    // Someone staring at this hex dump wondering why their struct is nonsense has, in this case,
    // already found their bug -- and will not find it if nothing says so.
    assert.match(freed.fillPattern ?? '', /freed heap memory/);
    assert.match(freed.fillPattern ?? '', /use-after-free/);

    assert.match(decodeBytes(Buffer.alloc(64, 0xcd)).fillPattern ?? '', /uninitialized heap/);
    assert.match(decodeBytes(Buffer.alloc(64, 0xfd)).fillPattern ?? '', /overrun/);
  });

  it('reports zeroed memory as such', () => {
    const decoded = decodeBytes(Buffer.alloc(32));
    assert.equal(decoded.allZero, true);
    assert.equal(decoded.readings[0]?.as, 'zeroed memory');
  });

  it('spots a table of pointers by range and alignment together', () => {
    const bytes = Buffer.alloc(32);
    for (let index = 0; index < 4; index++) {
      bytes.writeBigUInt64LE(BigInt(0x7ffd_0000_1000 + index * 0x40), index * 8);
    }
    const decoded = decodeBytes(bytes);

    assert.ok(decoded.readings.some((reading) => reading.as.includes('pointers')));
    assert.equal(decoded.words?.every((word) => word.looksLikePointer), true);
  });

  it('does not call small integers pointers', () => {
    const bytes = Buffer.alloc(32);
    for (let index = 0; index < 4; index++) bytes.writeBigUInt64LE(BigInt(index), index * 8);

    // Small values are far more likely to be counts, and a pointer reading here would send someone
    // dereferencing an integer.
    assert.equal(decodeBytes(bytes).words?.some((word) => word.looksLikePointer), false);
  });

  it('rejects a 64-bit value with the top bits set as an address', () => {
    const bytes = Buffer.alloc(8);
    // Current hardware implements 48 address bits, so a value above that is an integer or a tagged
    // value, never a live pointer.
    bytes.writeBigUInt64LE(0xffff_ffff_ffff_fff0n, 0);
    assert.equal(decodeBytes(bytes).words?.[0]?.looksLikePointer, false);
  });

  it('reads an integer array when the values look like data', () => {
    const bytes = Buffer.alloc(16);
    for (let index = 0; index < 4; index++) bytes.writeUInt32LE(index * 10, index * 4);

    assert.ok(decodeBytes(bytes).readings.some((reading) => reading.as.includes('32-bit unsigned')));
  });

  it('renders a decoded block with its scores and reasons', () => {
    const decoded = decodeBytes(Buffer.concat([Buffer.from('hello', 'ascii'), Buffer.from([0])]));
    const rendered = renderDecodedMemory(decoded).join('\n');

    assert.match(rendered, /%\]/);
    assert.match(rendered, /hello/);
  });
});

describe('decoding registers', () => {
  it('names the architectural roles a reader is actually looking for', () => {
    const decoded = decodeRegisters([
      { name: 'rip', value: '0x00007ff6a12b3c40' },
      { name: 'rsp', value: '0x000000c0000a5f00' },
      { name: 'rax', value: '0xffffffffffffffff' },
      { name: 'r11', value: '0x2a' },
    ]);

    assert.match(decoded[0]!.role ?? '', /instruction pointer/);
    assert.match(decoded[1]!.role ?? '', /stack pointer/);
    assert.equal(decoded[0]!.looksLikePointer, true);
    // A count that went below zero prints as 0xFFFFFFFFFFFFFFFF, and nobody recognizes that as -1
    // by eye -- which is exactly the bug it usually is.
    assert.equal(decoded[2]!.signed, '-1');
    assert.equal(decoded[3]!.signed, '42');
  });
});

describe('grouping threads by what they are doing', () => {
  const frame = (name: string, file?: string) => ({ id: Math.random(), name, file, line: 1 });

  it('classifies the primitives every runtime shares', () => {
    assert.equal(classifyStack([frame('epoll_wait'), frame('poll')]), 'waiting-io');
    assert.equal(classifyStack([frame('pthread_mutex_lock')]), 'waiting-lock');
    assert.equal(classifyStack([frame('pthread_cond_wait')]), 'waiting-condition');
    assert.equal(classifyStack([frame('Thread.sleep')]), 'sleeping');
    assert.equal(classifyStack([frame('gopark'), frame('runtime.selectgo')]), 'parked');
    assert.equal(classifyStack([frame('handleRequest', '/app/server.go')]), 'running-user-code');
  });

  it('collapses a thread pool into one group', () => {
    const workers = Array.from({ length: 40 }, (_, i) => ({ id: i + 10, name: `worker-${i}` }));
    const stacks: Record<number, ReturnType<typeof frame>[]> = {};
    for (const worker of workers) {
      stacks[worker.id] = [frame('LockSupport.park'), frame('ThreadPoolExecutor.getTask')];
    }
    stacks[1] = [frame('handleRequest', '/app/Server.java'), frame('run')];

    const stop: DebugStop = {
      index: 1, at: '', threadId: 1,
      threads: [{ id: 1, name: 'main', stopped: true }, ...workers],
      stacks, frames: {}, captureMs: 1,
    };

    const report = analyseConcurrency(stop);

    // Forty rows become one, and the one thread doing something is first.
    assert.equal(report.threadCount, 41);
    assert.equal(report.groups.length, 2);
    assert.equal(report.groups[0]?.containsStopped, true);
    assert.equal(report.groups[1]?.threads.length, 20, 'group membership is capped for display');
    // The cap is a presentation decision and must not reach the statistics: the pool really has
    // forty threads parked, whatever the display shows.
    assert.equal(report.groups[1]?.totalThreads, 40);
    assert.equal(report.activity.parked, 40);
    assert.equal(report.interesting[0]?.frame, 'handleRequest');
  });

  it('reports the shape of a deadlock as possible, never as fact', () => {
    const stop: DebugStop = {
      index: 1, at: '',
      threads: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }],
      stacks: {
        1: [frame('pthread_mutex_lock'), frame('transfer', '/app/bank.c')],
        2: [frame('pthread_mutex_lock'), frame('transfer', '/app/bank.c')],
      },
      frames: {}, captureMs: 1,
    };

    const report = analyseConcurrency(stop);
    assert.ok(report.contention);
    assert.match(report.contention.reason, /shape of a deadlock/);
    // The protocol genuinely cannot settle this, so the next step has to be named rather than
    // implied -- otherwise a reader acts drastically on a guess.
    assert.match(report.contention.howToConfirm, /jstack|SIGQUIT|py-spy|WinDbg/);
  });

  it('does not cry deadlock when something is still running', () => {
    const stop: DebugStop = {
      index: 1, at: '', threadId: 1,
      threads: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }],
      stacks: {
        1: [frame('handleRequest', '/app/main.c')],
        2: [frame('pthread_mutex_lock')],
      },
      frames: {}, captureMs: 1,
    };
    assert.equal(analyseConcurrency(stop).contention, undefined);
  });

  it('says how many threads had no captured stack', () => {
    const stop: DebugStop = {
      index: 1, at: '', threadId: 1,
      threads: Array.from({ length: 600 }, (_, i) => ({ id: i, name: `t${i}` })),
      stacks: { 0: [frame('main', '/app/main.go')] },
      frames: {}, captureMs: 1,
    };

    // A report covering one of six hundred threads that did not say so would be read as covering
    // the program.
    assert.match(analyseConcurrency(stop).caveats[0] ?? '', /599 of 600 thread\(s\) had no captured stack/);
  });
});

describe('the false-deadlock regression', () => {
  const frame = (name: string, file?: string) => ({ id: Math.random(), name, file, line: 1 });

  it('does not report an idle JVM thread pool as blocked on locks', () => {
    // `LockSupport.park` is the JVM's universal parking primitive: an idle pool worker and a
    // genuinely blocked lock both sit in it. Classifying the bare frame as a lock wait made every
    // idle Java application server produce the exact signature of contention — dozens of threads
    // "blocked", none running — which is the single most alarming thing this module can say.
    const workers = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, name: `pool-${i}` }));
    const stacks: Record<number, ReturnType<typeof frame>[]> = {};
    for (const worker of workers) {
      stacks[worker.id] = [
        frame('LockSupport.park'),
        frame('ThreadPoolExecutor.getTask'),
        frame('ThreadPoolExecutor$Worker.run'),
      ];
    }

    const report = analyseConcurrency({
      index: 1, at: '', threads: workers, stacks, frames: {}, captureMs: 1,
    });

    assert.equal(report.activity.parked, 30);
    assert.equal(report.activity['waiting-lock'], undefined);
    assert.equal(report.contention, undefined, 'an idle pool is not contention');
  });

  it('still recognizes a real Java lock wait, which carries the synchronizer frame', () => {
    const threads = [{ id: 1, name: 'a' }, { id: 2, name: 'b' }];
    const stack = [
      frame('LockSupport.park'),
      frame('AbstractQueuedSynchronizer.acquireQueued'),
      frame('ReentrantLock.lock'),
      frame('transfer', '/app/Bank.java'),
    ];

    const report = analyseConcurrency({
      index: 1, at: '', threads, stacks: { 1: stack, 2: stack }, frames: {}, captureMs: 1,
    });

    assert.equal(report.activity['waiting-lock'], 2);
    assert.ok(report.contention, 'a real lock wait should still be reported');
  });
});
