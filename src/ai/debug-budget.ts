import type {
  DebugScope, DebugSessionRecord, DebugStop, DebugVariable,
} from '../core/debug-model.ts';
import { estimateTokens } from '../core/budget.ts';

/**
 * Fitting a debug session into a context budget.
 *
 * A captured stop is the largest thing Auspex produces. A single frame of a Java or .NET program
 * routinely carries several hundred variables once expanded, and a fifty-frame stack across five
 * threads can serialize to well over a million tokens. Nothing consumes that, so something has to
 * decide what to drop — and the whole question is whether that decision is *principled* or
 * arbitrary.
 *
 * `core/budget.ts` answers this for a snapshot with a documented ladder. This is the same idea for
 * a debug record, and it needs its own because the priorities are completely different. In a
 * snapshot, the open file matters most. In a debug record, **the stopped frame's own values matter
 * most**, and the fiftieth frame of a stack matters barely at all — but the *shape* of that stack
 * still matters, so frames are collapsed to names rather than deleted.
 *
 * ## The ladder
 *
 * Applied in order, each step re-measured, stopping as soon as the record fits. Every step is
 * reported, so a reader is never silently shown a partial program state.
 *
 *  1. Wire timeline (the totals survive, which is what it is usually read for)
 *  2. Memory dumps beyond the first
 *  3. Disassembly
 *  4. Loaded sources and modules beyond the first ten
 *  5. Stop history: previous stops, keeping the current one and the last diff
 *  6. Non-stopped threads' stacks, collapsed to counts
 *  7. Program output, to the last twenty lines
 *  8. Variable trees, one level at a time, deepest first
 *  9. Scopes beyond the first two of each frame
 * 10. Frames beyond the top ten, collapsed to `name (file:line)`
 * 11. Variables beyond the first twenty per scope
 * 12. Everything but the current stop's top frame, its values, and the headline facts
 *
 * Step 12 is the irreducible core: **why it stopped, where, and what the values are there.** If
 * that alone exceeds the budget, the result says so rather than cutting into it — a truncated
 * variable list presented as complete is how a reader draws a confident wrong conclusion, and a
 * budget is never a good enough reason to cause that.
 */

export interface DebugBudgetOptions {
  maxTokens: number;
  /** Keep the wire timeline if it fits. Off by default: it is rarely what a question is about. */
  includeTimeline?: boolean;
  /** Keep memory dumps if they fit. */
  includeMemory?: boolean;
}

export interface DebugBudgetResult {
  record: DebugSessionRecord;
  estimatedTokens: number;
  /** What was removed, in the order it was removed. */
  dropped: string[];
  /** True when the irreducible core still does not fit. */
  overBudget: boolean;
}

/** Applies the ladder. Never mutates the input. */
export function fitDebugToBudget(
  original: DebugSessionRecord,
  options: DebugBudgetOptions,
): DebugBudgetResult {
  const record = structuredClone(original) as DebugSessionRecord;
  const dropped: string[] = [];
  const { maxTokens } = options;

  const fits = () => estimateTokens(record) <= maxTokens;

  if (!options.includeTimeline && record.timeline.length > 0) {
    dropped.push(`wire timeline (${record.timeline.length} entries; totals kept)`);
    record.timeline = [];
  }
  if (fits()) return done(record, dropped, maxTokens);

  if (record.currentStop?.memory && !options.includeMemory) {
    const count = record.currentStop.memory.length;
    if (count > 1) {
      record.currentStop.memory = record.currentStop.memory.slice(0, 1);
      dropped.push(`${count - 1} memory dump(s)`);
    }
  }
  if (fits()) return done(record, dropped, maxTokens);

  if (record.currentStop?.disassembly?.length) {
    dropped.push(`disassembly (${record.currentStop.disassembly.length} instructions)`);
    record.currentStop.disassembly = undefined;
  }
  if (fits()) return done(record, dropped, maxTokens);

  if (record.loadedSources.length > 0) {
    dropped.push(`loaded sources (${record.loadedSources.length})`);
    record.loadedSources = [];
  }
  if (record.modules.length > 10) {
    dropped.push(`${record.modules.length - 10} module(s)`);
    record.modules = record.modules.slice(0, 10);
  }
  if (fits()) return done(record, dropped, maxTokens);

  if (record.stops.length > 0) {
    dropped.push(`${record.stops.length} previous stop(s); the most recent comparison is kept`);
    record.stops = [];
    record.diffs = record.diffs.slice(-1);
  }
  if (fits()) return done(record, dropped, maxTokens);

  const stop = record.currentStop;
  if (stop) {
    const stoppedId = stop.threadId ?? Number(Object.keys(stop.stacks)[0]);
    let collapsed = 0;
    for (const key of Object.keys(stop.stacks)) {
      const id = Number(key);
      if (id === stoppedId) continue;
      collapsed += stop.stacks[id]?.length ?? 0;
      delete stop.stacks[id];
    }
    if (collapsed > 0) dropped.push(`${collapsed} frame(s) from threads that were not stopped`);
  }
  if (fits()) return done(record, dropped, maxTokens);

  if (record.output.length > 20) {
    dropped.push(`${record.output.length - 20} output line(s)`);
    record.output = record.output.slice(-20);
  }
  if (record.evaluations.length > 5) {
    dropped.push(`${record.evaluations.length - 5} evaluation(s)`);
    record.evaluations = record.evaluations.slice(-5);
  }
  if (fits()) return done(record, dropped, maxTokens);

  // -- Variable depth, deepest first. Four passes, because four is the capture depth.
  for (let depth = 4; depth >= 1; depth--) {
    if (!stop) break;
    let cut = 0;
    for (const scopes of Object.values(stop.frames)) {
      for (const scope of scopes) cut += trimDepth(scope.variables, depth);
    }
    if (cut > 0) dropped.push(`${cut} variable(s) below depth ${depth}`);
    if (fits()) return done(record, dropped, maxTokens);
  }

  if (stop) {
    let cut = 0;
    for (const [frameId, scopes] of Object.entries(stop.frames)) {
      if (scopes.length > 2) {
        cut += scopes.length - 2;
        stop.frames[Number(frameId)] = scopes.slice(0, 2);
      }
    }
    if (cut > 0) dropped.push(`${cut} scope(s) beyond the first two per frame`);
  }
  if (fits()) return done(record, dropped, maxTokens);

  if (stop) {
    const stoppedId = stop.threadId ?? Number(Object.keys(stop.stacks)[0]);
    const frames = stop.stacks[stoppedId] ?? [];
    if (frames.length > 10) {
      // Collapsed, not deleted: the shape of a stack is information even when its details are not,
      // and a reader who cannot see that there were forty frames will misjudge what they are
      // looking at.
      stop.stacks[stoppedId] = frames.slice(0, 10).concat(frames.slice(10).map((frame) => ({
        id: frame.id, name: frame.name, file: frame.file, line: frame.line,
      })));
      for (const frame of frames.slice(10)) delete stop.frames[frame.id];
      dropped.push(`values for ${frames.length - 10} frame(s) below the top ten; the frames remain`);
    }
  }
  if (fits()) return done(record, dropped, maxTokens);

  if (stop) {
    let cut = 0;
    for (const scopes of Object.values(stop.frames)) {
      for (const scope of scopes) {
        if (scope.variables.length > 20) {
          cut += scope.variables.length - 20;
          scope.variables = scope.variables.slice(0, 20);
          scope.skipped = `${scope.skipped ? `${scope.skipped}; ` : ''}truncated to 20 of ${cut + 20} for the context budget`;
        }
      }
    }
    if (cut > 0) dropped.push(`${cut} variable(s) beyond the first twenty per scope`);
  }
  if (fits()) return done(record, dropped, maxTokens);

  // -- The irreducible core.
  if (stop) {
    const stoppedId = stop.threadId ?? Number(Object.keys(stop.stacks)[0]);
    const frames = stop.stacks[stoppedId] ?? [];
    const top = frames[0];

    record.breakpoints = record.breakpoints.filter((breakpoint) => breakpoint.verified === false);
    record.modules = [];
    record.output = record.output.slice(-5);
    record.evaluations = [];
    stop.memory = undefined;

    if (top) {
      for (const frame of frames.slice(1)) delete stop.frames[frame.id];
      dropped.push('everything but the stopped frame, its values, and why it stopped');
    }
  }

  return done(record, dropped, maxTokens);
}

function done(record: DebugSessionRecord, dropped: string[], maxTokens: number): DebugBudgetResult {
  const estimatedTokens = estimateTokens(record);
  return {
    record,
    estimatedTokens,
    dropped,
    // Stated rather than hidden. The alternative is cutting into the one thing the reader needs,
    // and a partial program state presented as whole is worse than an honest overflow.
    overBudget: estimatedTokens > maxTokens,
  };
}

/** Removes children below a depth. Returns how many variables were removed. */
function trimDepth(variables: DebugVariable[], depth: number, current = 1): number {
  let removed = 0;

  for (const variable of variables) {
    if (!variable.children) continue;

    if (current >= depth) {
      removed += count(variable.children);
      variable.truncated = variable.truncated ?? `${variable.children.length} child(ren) dropped for the context budget`;
      variable.children = undefined;
    } else {
      removed += trimDepth(variable.children, depth, current + 1);
    }
  }
  return removed;
}

function count(variables: DebugVariable[]): number {
  let total = variables.length;
  for (const variable of variables) if (variable.children) total += count(variable.children);
  return total;
}

/**
 * How large a record is, and where the size is.
 *
 * Reported before any reduction so a caller can decide whether to reduce at all, and so a user
 * asking "why is this so big" gets an answer with a number attached rather than a shrug.
 */
export function measureDebugRecord(record: DebugSessionRecord): {
  total: number;
  breakdown: Array<{ part: string; tokens: number }>;
} {
  const stop = record.currentStop;
  const variableTokens = stop
    ? Object.values(stop.frames).reduce((sum, scopes) =>
      sum + scopes.reduce((inner: number, scope: DebugScope) => inner + estimateTokens(scope.variables), 0), 0)
    : 0;

  const breakdown = [
    { part: 'variables', tokens: variableTokens },
    { part: 'stacks', tokens: stop ? estimateTokens(stop.stacks) : 0 },
    { part: 'timeline', tokens: estimateTokens(record.timeline) },
    { part: 'previous stops', tokens: estimateTokens(record.stops) },
    { part: 'memory', tokens: estimateTokens(stop?.memory ?? []) },
    { part: 'output', tokens: estimateTokens(record.output) },
    { part: 'modules', tokens: estimateTokens(record.modules) },
    { part: 'breakpoints', tokens: estimateTokens(record.breakpoints) },
  ].filter((item) => item.tokens > 0).sort((a, b) => b.tokens - a.tokens);

  return { total: estimateTokens(record), breakdown };
}

/** A stop reduced to the smallest form still worth reading, for a very tight budget. */
export function minimalStop(stop: DebugStop, adapterType?: string): Record<string, unknown> {
  const stoppedId = stop.threadId ?? Number(Object.keys(stop.stacks)[0]);
  const frames = stop.stacks[stoppedId] ?? [];
  const top = frames[0];

  return {
    reason: stop.reason,
    exception: stop.exception
      ? { type: stop.exception.typeName, message: stop.exception.message }
      : undefined,
    at: top ? `${top.file ?? top.sourceName ?? '?'}:${top.line ?? '?'} in ${top.name}` : undefined,
    adapter: adapterType,
    stack: frames.slice(0, 8).map((frame) => `${frame.name} (${frame.file ?? '?'}:${frame.line ?? '?'})`),
    values: top
      ? (stop.frames[top.id] ?? []).flatMap((scope) =>
        scope.variables.slice(0, 15).map((variable) =>
          `${scope.name}.${variable.name} = ${variable.value.slice(0, 60)}`))
      : [],
  };
}
