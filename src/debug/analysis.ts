import type {
  DebugScope, DebugSessionRecord, DebugStackFrame, DebugStop, DebugVariable,
} from '../core/debug-model.ts';
import { adapterById, explainNoMemory, isUserCode } from './registry.ts';
import { currentLine, type FrameSource } from './source-context.ts';
import { analyseConcurrency, type ConcurrencyReport } from './concurrency.ts';
import { interpretValue } from './values.ts';

/**
 * Turning a captured stop into observations worth acting on.
 *
 * ## What this is, and firmly what it is not
 *
 * This does **not** diagnose bugs. It cannot: knowing that `user` is `None` at the line that
 * dereferences it does not tell you whether the bug is the dereference, the lookup that returned
 * nothing, or the caller that passed the wrong id. Producing a confident "the bug is X" from that
 * would be guessing dressed up as analysis, and a wrong diagnosis costs more time than no
 * diagnosis, because it directs attention away from the real cause.
 *
 * What it does is **surface the specific facts in a capture that are usually relevant and easy to
 * miss**, each one attributed to the evidence that produced it. A stack of forty frames with three
 * of the user's own; a variable holding an error value at the line that uses it; the same
 * breakpoint hit for the four-hundredth time; a breakpoint that never bound; a value that changed
 * between two stops when the code between them should not have touched it. These are things a
 * developer notices by scanning, and an assistant notices only if someone points at them.
 *
 * ## Why it matters for the AI surface specifically
 *
 * A model handed a raw debug record spends its attention finding the interesting parts, and it has
 * a limited amount of that. Handing it the interesting parts *and* the raw record spends the
 * attention on the actual question. Every finding carries its evidence, so a model that disagrees
 * with a finding can check it — which is the property that makes this an aid rather than a source
 * of confident errors.
 *
 * Severity is about **how likely this is to be what you are looking for**, never about how bad the
 * program's state is. A `high` finding is one that is almost always worth reading first.
 */

export type FindingSeverity = 'high' | 'medium' | 'low' | 'info';

export interface Finding {
  /** A stable identifier, so consumers can filter or suppress by kind. */
  kind: string;
  severity: FindingSeverity;
  /** One sentence, stating the fact rather than a conclusion. */
  summary: string;
  /** What in the capture produced this. Always populated: an unattributed finding is an opinion. */
  evidence: string[];
  /** Where in the program, when the finding has a location. */
  file?: string;
  line?: number;
  /** A question worth asking next, when there is an obvious one. */
  nextStep?: string;
}

export interface AnalysisResult {
  findings: Finding[];
  /** A one-paragraph statement of what the program is doing, for a reader who wants only that. */
  headline: string;
  /** Frames that are the user's own code, in stack order — usually the useful three of forty. */
  userFrames: DebugStackFrame[];
  /** How many frames were classified as runtime or library. */
  runtimeFrameCount: number;
  /** Values that look like an absence or an error, with where they are. */
  suspiciousValues: Array<{ path: string; value: string; reason: string }>;
  /** Thread grouping and contention, when the stop had more than one thread. */
  concurrency?: ConcurrencyReport;
}

/**
 * Values that mean "nothing here", across the languages this might see.
 *
 * Matched exactly rather than by substring: a string whose *contents* are the word `null` is not a
 * null reference, and treating it as one would produce a finding about a value that is working
 * perfectly. The list spans ecosystems deliberately — the whole point of a protocol-level tool is
 * that it does not know or care which language it is looking at.
 */
const EMPTY_VALUES = new Set([
  'null', 'nil', 'None', 'undefined', 'NULL', 'nullptr', '(null)', 'void',
  '<null>', 'Nothing', 'Unit', 'NULL POINTER', '0x0', 'nan', 'NaN',
]);

/** Value shapes that indicate a runtime error is already being carried around as data. */
const ERROR_PATTERNS = [
  /^<?(?:[A-Z]\w*)?(?:Error|Exception|Fault|Panic)\b/,
  /^Err\(/,          // Rust.
  /^Failure\(/,      // OCaml, Scala.
  /^\{\s*error:/i,
  /^Traceback\b/,
];

export interface AnalysisOptions {
  /** Source windows by frame id, which let findings quote the failing line. */
  sources?: Record<number, FrameSource>;
  /** How many findings to return. */
  limit?: number;
}

/**
 * Analyses the current stop of a session.
 *
 * Ordered by severity and then by the order the checks run, which is deliberately the order a
 * person would look: why it stopped, where the user's code is, what the values are, what changed,
 * then the mechanical problems with the session itself.
 */
export function analyseSession(
  record: DebugSessionRecord,
  options: AnalysisOptions = {},
): AnalysisResult {
  const findings: Finding[] = [];
  const stop = record.currentStop;
  const adapter = record.adapterType ? adapterById(record.adapterType) : undefined;

  if (!stop) {
    return {
      findings: [{
        kind: 'no-stop',
        severity: 'info',
        summary: record.status === 'terminated'
          ? 'The session ended without a captured stop.'
          : 'The program is running and has not stopped.',
        evidence: [`session status: ${record.status}`, `${record.totals.stops} stop(s) recorded`],
        nextStep: record.breakpoints.some((breakpoint) => breakpoint.verified === false)
          ? 'Some breakpoints never bound — check `get_debug_session` for which.'
          : undefined,
      }],
      headline: record.status === 'terminated'
        ? 'The debug session has ended.'
        : 'The program is running; nothing has been captured yet.',
      userFrames: [],
      runtimeFrameCount: 0,
      suspiciousValues: [],
    };
  }

  const threadId = stop.threadId ?? Number(Object.keys(stop.stacks)[0]);
  const frames = stop.stacks[threadId] ?? [];
  const userFrames = frames.filter((frame) => isUserCode(frame.file, adapter));
  const runtimeFrameCount = frames.length - userFrames.length;

  // -- Why it stopped ---------------------------------------------------------------------------

  if (stop.exception) {
    const chain: string[] = [];
    let inner = stop.exception.innerException;
    while (inner) {
      chain.push(`${inner.typeName ?? inner.exceptionId}: ${inner.message ?? ''}`);
      inner = inner.innerException;
    }

    findings.push({
      kind: 'exception',
      severity: 'high',
      summary: `The program stopped on ${stop.exception.typeName ?? stop.exception.exceptionId}` +
        (stop.exception.message ? `: ${stop.exception.message}` : '') + '.',
      evidence: [
        `break mode: ${stop.exception.breakMode ?? 'unspecified'}`,
        ...(chain.length > 0 ? [`caused by ${chain.join(' ← ')}`] : []),
        ...(stop.exception.stackTrace ? [`exception trace:\n${stop.exception.stackTrace}`] : []),
      ],
      file: userFrames[0]?.file,
      line: userFrames[0]?.line,
      // The chain matters more than the outer exception nearly every time: the outermost is
      // usually a wrapper, and the innermost is what actually went wrong.
      nextStep: chain.length > 0
        ? 'The innermost cause is usually the real failure; the outer exceptions are wrappers.'
        : undefined,
    });
  }

  // -- Where the user's code is -----------------------------------------------------------------

  if (userFrames.length === 0 && frames.length > 0) {
    findings.push({
      kind: 'no-user-frames',
      severity: 'medium',
      summary: `None of the ${frames.length} frames look like this project's own code.`,
      evidence: [
        `top frame: ${frames[0]?.name} (${frames[0]?.file ?? 'no source'})`,
        adapter ? `classified using the runtime paths known for ${adapter.name}` : 'no adapter profile',
      ],
      nextStep:
        'The program is stopped inside a runtime or a library. Step out until a frame in your own ' +
        'source appears, or set the breakpoint at the call site instead.',
    });
  } else if (runtimeFrameCount > 0 && userFrames[0] !== frames[0]) {
    const depth = frames.indexOf(userFrames[0]!);
    findings.push({
      kind: 'user-code-depth',
      severity: 'medium',
      summary: `Your own code starts at frame #${depth} (${userFrames[0]!.name}); the frames above it are runtime.`,
      evidence: frames.slice(0, depth).map((frame) => `#${frames.indexOf(frame)} ${frame.name} — ${frame.file ?? 'no source'}`),
      file: userFrames[0]!.file,
      line: userFrames[0]!.line,
    });
  }

  // -- Recursion ---------------------------------------------------------------------------------

  const repeats = new Map<string, number>();
  for (const frame of frames) repeats.set(frame.name, (repeats.get(frame.name) ?? 0) + 1);
  const recursive = [...repeats.entries()].filter(([, count]) => count >= 5);

  for (const [name, count] of recursive) {
    findings.push({
      kind: 'recursion',
      severity: count >= 20 ? 'high' : 'medium',
      summary: `${name} appears ${count} times in the stack — it is recursing.`,
      evidence: [`${frames.length} frame(s) total`, `${count} of them are ${name}`],
      // A deep recursion that is not obviously terminating is the likeliest single cause of a
      // stack overflow, and it is invisible in a stack view that only shows the top ten frames.
      nextStep: count >= 20
        ? 'Check the base case: this depth is close to where most runtimes overflow.'
        : undefined,
    });
  }

  // -- Values ------------------------------------------------------------------------------------

  const suspicious: AnalysisResult['suspiciousValues'] = [];
  const topFrame = userFrames[0] ?? frames[0];
  const scopes = topFrame ? stop.frames[topFrame.id] ?? [] : [];
  const line = topFrame ? currentLine(options.sources?.[topFrame.id]) : undefined;

  for (const scope of scopes) {
    collectSuspicious(scope, scope.variables, '', suspicious);
  }

  // A value that is empty *and* named on the line the program is stopped at is the single most
  // useful correlation available here: it links a state to the exact code about to use it.
  const onTheLine = line
    ? suspicious.filter((item) => mentions(line, item.path.split('.')[0] ?? ''))
    : [];

  for (const item of onTheLine.slice(0, 5)) {
    findings.push({
      kind: 'empty-value-in-use',
      severity: 'high',
      summary: `${item.path} is ${item.value} and appears on the line being executed.`,
      evidence: [`stopped at ${topFrame?.file}:${topFrame?.line}`, `line reads: ${line}`, item.reason],
      file: topFrame?.file,
      line: topFrame?.line,
      nextStep:
        'This is where it is used, not necessarily where it went wrong. Look at what was supposed ' +
        'to set it — the caller, or the lookup that returned nothing.',
    });
  }

  const errorValues = suspicious.filter((item) => item.reason.startsWith('holds an error'));
  for (const item of errorValues.slice(0, 3)) {
    if (onTheLine.includes(item)) continue;
    findings.push({
      kind: 'error-value',
      severity: 'medium',
      summary: `${item.path} is carrying an error value: ${item.value}`,
      evidence: [item.reason, `in scope of ${topFrame?.name ?? 'the top frame'}`],
      file: topFrame?.file,
      line: topFrame?.line,
    });
  }

  // -- What changed ------------------------------------------------------------------------------

  const diff = record.diffs[record.diffs.length - 1];
  if (diff) {
    if (diff.changed.length === 0 && diff.added.length === 0 && diff.removed.length === 0) {
      findings.push({
        kind: 'no-change',
        severity: 'medium',
        summary: `Nothing changed between stop #${diff.fromStop} and #${diff.toStop}, across ${diff.unchangedCount} value(s).`,
        evidence: [`${diff.elapsedMs}ms elapsed`, 'no variable took a new value'],
        // Two identical stops usually means the code being stepped through is not the code that
        // matters -- an early return, a guard that skipped the body, a loop iteration that did
        // nothing.
        nextStep: 'The code between these two stops had no observable effect. Did it take the branch you expected?',
      });
    } else if (diff.changed.length > 0) {
      findings.push({
        kind: 'changed-values',
        severity: 'info',
        summary: `${diff.changed.length} value(s) changed since the previous stop.`,
        evidence: diff.changed.slice(0, 8).map((delta) =>
          `${delta.scope}/${delta.path}: ${delta.before} → ${delta.after}`),
      });
    }
  }

  // -- Repeated stops -----------------------------------------------------------------------------

  if (record.stops.length >= 3) {
    const here = record.stops.filter((previous) =>
      previous.reason === stop.reason &&
      previous.stacks[threadId]?.[0]?.line === frames[0]?.line &&
      previous.stacks[threadId]?.[0]?.file === frames[0]?.file);

    if (here.length >= 3) {
      findings.push({
        kind: 'repeated-stop',
        severity: 'medium',
        summary: `This location has been stopped at ${here.length + 1} times — it is inside a loop or a hot path.`,
        evidence: [`${frames[0]?.file}:${frames[0]?.line}`, `${record.totals.stops} stop(s) in this session`],
        file: frames[0]?.file,
        line: frames[0]?.line,
        nextStep:
          'Add a condition or a hit count to the breakpoint so it stops on the iteration that ' +
          'matters rather than every one.',
      });
    }
  }

  // -- Problems with the session itself ------------------------------------------------------------

  // A capture that only saw what the editor's UI asked for must say so, prominently. Without this,
  // an absent variable reads as a variable that does not exist -- and that is a conclusion someone
  // will act on.
  const method = (record as unknown as { captureMethod?: string }).captureMethod;
  if (method && method !== 'proxy') {
    findings.push({
      kind: 'partial-capture-method',
      severity: 'medium',
      summary: 'This session was captured passively, so it holds only what the editor requested.',
      evidence: [
        `capture method: ${method}`,
        (record as unknown as { captureNote?: string }).captureNote
          ?? 'scopes nobody opened and variables nobody expanded never crossed the wire',
      ],
      nextStep:
        'A variable missing here may simply never have been requested. For every scope of every ' +
        'frame, run `auspex proxy --dap --deep`.',
    });
  }

  const unverified = record.breakpoints.filter((breakpoint) => breakpoint.verified === false);
  if (unverified.length > 0) {
    findings.push({
      kind: 'unverified-breakpoints',
      severity: 'high',
      summary: `${unverified.length} breakpoint(s) never bound to code and will never fire.`,
      evidence: unverified.slice(0, 6).map((breakpoint) =>
        `${breakpoint.file ?? breakpoint.functionName ?? breakpoint.kind}:${breakpoint.line ?? '?'}` +
        (breakpoint.message ? ` — ${breakpoint.message}` : '')),
      // The most common cause by a wide margin, and the one people lose the most time to.
      nextStep:
        'Usually the debugger is running different code than the file you set it in: a stale build, ' +
        'a path mapping, or a source map pointing elsewhere.',
    });
  }

  for (const scope of scopes) {
    if (scope.skipped) {
      findings.push({
        kind: 'scope-skipped',
        severity: 'low',
        summary: `The ${scope.name} scope was not captured: ${scope.skipped}.`,
        evidence: [`frame ${topFrame?.name ?? '?'}`, `reported ${scope.namedVariables ?? '?'} named value(s)`],
        nextStep: scope.expensive
          ? 'The adapter marked it expensive; ask for it deliberately if you need it.'
          : undefined,
      });
    }
  }

  if (stop.incomplete?.length) {
    findings.push({
      kind: 'incomplete-capture',
      severity: 'low',
      summary: 'Part of this stop was not captured.',
      evidence: stop.incomplete,
      nextStep: 'Raise the capture limits if the missing part matters.',
    });
  }

  if ((stop.memory?.length ?? 0) === 0 && hasMemoryReference(scopes)) {
    findings.push({
      kind: 'memory-unavailable',
      severity: 'info',
      summary: 'Variables carry memory addresses but no memory was read.',
      evidence: [explainNoMemory(record.adapterType, record.capabilities?.supportsReadMemory)],
    });
  }

  const failureRate = record.totals.responses > 0
    ? record.totals.failedResponses / record.totals.responses
    : 0;
  if (failureRate > 0.2 && record.totals.responses > 10) {
    findings.push({
      kind: 'adapter-errors',
      severity: 'medium',
      summary: `${Math.round(failureRate * 100)}% of this adapter's responses were failures.`,
      evidence: [`${record.totals.failedResponses} of ${record.totals.responses}`, ...record.warnings.slice(0, 4)],
      nextStep: 'The adapter is rejecting requests; the capture below may be thinner than it looks.',
    });
  }

  // -- Threads ------------------------------------------------------------------------------------

  const concurrency = stop.threads.length > 1 || Object.keys(stop.stacks).length > 1
    ? analyseConcurrency(stop, { adapter })
    : undefined;

  if (concurrency?.contention) {
    findings.push({
      kind: 'possible-contention',
      severity: 'high',
      summary: `${concurrency.activity['waiting-lock'] ?? concurrency.contention.blockedThreads.length} thread(s) are blocked and none are running.`,
      evidence: [
        concurrency.contention.reason,
        ...concurrency.contention.blockedThreads.slice(0, 6)
          .map((thread) => `${thread.name}#${thread.id} in ${thread.frame}`),
      ],
      nextStep: concurrency.contention.howToConfirm,
    });
  }

  if (concurrency && concurrency.groups.length > 1 && concurrency.threadCount > 4) {
    findings.push({
      kind: 'thread-groups',
      severity: 'info',
      summary: `${concurrency.threadCount} thread(s) fall into ${concurrency.groups.length} group(s) by stack shape.`,
      evidence: concurrency.groups.slice(0, 6)
        .map((group) => `${group.totalThreads}× ${group.name}`),
      nextStep: concurrency.interesting.length > 0
        ? `${concurrency.interesting.length} thread(s) are in this project's own code.`
        : undefined,
    });
  }

  const order: Record<FindingSeverity, number> = { high: 0, medium: 1, low: 2, info: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  return {
    findings: options.limit ? findings.slice(0, options.limit) : findings,
    headline: buildHeadline(record, stop, userFrames, frames, line),
    userFrames,
    runtimeFrameCount,
    suspiciousValues: suspicious,
    concurrency,
  };
}

/** One paragraph a reader can act on without reading anything else. */
function buildHeadline(
  record: DebugSessionRecord,
  stop: DebugStop,
  userFrames: DebugStackFrame[],
  frames: DebugStackFrame[],
  line: string | undefined,
): string {
  const where = userFrames[0] ?? frames[0];
  const parts: string[] = [];

  parts.push(
    `${record.adapterType ? `A ${record.adapterType} program` : 'The program'} is stopped ` +
    `(${stop.reason ?? 'reason unreported'})`,
  );

  if (where) {
    parts.push(
      `in ${where.name}` +
      (where.file ? ` at ${where.file}:${where.line ?? '?'}` : ' (no source location)'),
    );
  }
  if (line) parts.push(`on \`${line}\``);
  if (stop.exception) {
    parts.push(`after ${stop.exception.typeName ?? stop.exception.exceptionId}` +
      (stop.exception.message ? ` — ${stop.exception.message}` : ''));
  }
  if (frames.length > userFrames.length) {
    parts.push(`${frames.length} frame(s), ${userFrames.length} of them this project's own`);
  }
  return `${parts.join(', ')}.`;
}

/** Walks a scope's variables for values that look like an absence or an error. */
function collectSuspicious(
  scope: DebugScope,
  variables: DebugVariable[],
  prefix: string,
  into: AnalysisResult['suspiciousValues'],
  depth = 0,
): void {
  if (depth > 3 || into.length > 200) return;

  for (const variable of variables) {
    const path = prefix ? `${prefix}.${variable.name}` : variable.name;
    const value = variable.value.trim();

    // The universal value interpreter rather than a second set of patterns here: it already knows
    // the conventions of every runtime, including wrappers like `Err(...)` and `None` that a plain
    // word list would miss, and keeping one implementation means one place to be right.
    const interpreted = interpretValue(variable.value, variable.type);

    if (interpreted.kind === 'empty' || EMPTY_VALUES.has(value)) {
      into.push({ path, value, reason: `holds an empty value (${value})` });
    } else if (interpreted.kind === 'error' || ERROR_PATTERNS.some((pattern) => pattern.test(value))) {
      into.push({ path, value: truncate(value), reason: 'holds an error value' });
    } else if ((interpreted.kind === 'collection' || interpreted.kind === 'map') && interpreted.size === 0) {
      // An empty collection is far weaker evidence than a null -- it is often correct -- so it is
      // recorded for correlation with the current line but never raised as a finding on its own.
      into.push({ path, value, reason: 'is an empty collection' });
    } else if (interpreted.incomplete && interpreted.kind === 'future') {
      into.push({ path, value: truncate(value), reason: 'is a future that has not resolved' });
    }

    if (variable.children) collectSuspicious(scope, variable.children, path, into, depth + 1);
  }
}

/** Whether a line of source refers to an identifier, as a whole word. */
function mentions(line: string, identifier: string): boolean {
  if (identifier.length < 2) return false;      // `i` matches everything; it says nothing.
  return new RegExp(`\\b${identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(line);
}

function hasMemoryReference(scopes: DebugScope[]): boolean {
  const walk = (variables: DebugVariable[]): boolean =>
    variables.some((variable) =>
      variable.memoryReference !== undefined || (variable.children ? walk(variable.children) : false));
  return scopes.some((scope) => walk(scope.variables));
}

function truncate(value: string): string {
  return value.length > 120 ? `${value.slice(0, 117)}…` : value;
}
