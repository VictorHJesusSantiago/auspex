import type { DebugSessionRecord, DebugStackFrame, DebugVariable } from '../core/debug-model.ts';
import type { AnalysisResult, Finding } from '../debug/analysis.ts';
import { analyseSession } from '../debug/analysis.ts';
import { isUserCode, adapterById } from '../debug/registry.ts';
import { renderSource, type FrameSource } from '../debug/source-context.ts';
import { renderConcurrency } from '../debug/concurrency.ts';
import { decodeMemory } from '../debug/memory-decode.ts';
import { inferShape, interpretValue, renderCollectionSummary, summarizeCollection } from '../debug/values.ts';
import { fitDebugToBudget, measureDebugRecord, minimalStop } from './debug-budget.ts';

/**
 * A debug session written for a model to read.
 *
 * ## Why a prose briefing rather than the JSON
 *
 * Because the JSON is the wrong shape for the job, and being right about that saves both tokens
 * and mistakes. A debug record is a *graph*: threads containing frames containing scopes containing
 * variables containing variables. Serialized, that graph spends most of its size on structural
 * punctuation and repeated keys, and it forces a reader to hold the nesting in mind while
 * navigating it. The same information as ordered prose with a source excerpt is smaller, and —
 * more importantly — it puts the facts in the order the question is usually asked in.
 *
 * The JSON tools remain, and they are the right thing when a model knows what it is looking for
 * (`get_debug_variables` with a name beats reading a briefing). This is for the opening move:
 * "something is wrong, here is the program, what do you make of it".
 *
 * ## What it deliberately does
 *
 * - **Leads with the conclusion-shaped facts**, then the evidence. A model that stops reading
 *   halfway still has the useful part.
 * - **Shows the source.** A stack trace without the failing line makes a reader guess at what the
 *   code does; three lines of context usually removes the guess entirely.
 * - **Separates the user's code from the runtime**, because thirty frames of framework are noise
 *   in every case where they are not the entire answer.
 * - **States what is missing.** Every capture is bounded somewhere, and a reader who does not know
 *   where the bound is will treat an absence as a fact.
 *
 * ## What it deliberately does not do
 *
 * It does not diagnose. The findings it carries are observations with evidence attached — see
 * `debug/analysis.ts` for why that line is drawn where it is. A briefing that opened with "the bug
 * is on line 42" would be guessing, and would direct attention away from the real cause exactly
 * when attention is most expensive.
 */

export interface DebugReportOptions {
  /** Source windows by frame id. */
  sources?: Record<number, FrameSource>;
  /** Fit the underlying record to a token budget before writing. */
  maxTokens?: number;
  /** Include the wire timeline. */
  includeTimeline?: boolean;
  /** Include raw memory. */
  includeMemory?: boolean;
  /** How many variables per scope. */
  variablesPerScope?: number;
  /** Pre-computed analysis, when the caller already ran it. */
  analysis?: AnalysisResult;
}

/** Renders the briefing. */
export function debugReport(record: DebugSessionRecord, options: DebugReportOptions = {}): string {
  const budgeted = options.maxTokens
    ? fitDebugToBudget(record, {
      maxTokens: options.maxTokens,
      includeTimeline: options.includeTimeline,
      includeMemory: options.includeMemory,
    })
    : undefined;

  const session = budgeted?.record ?? record;
  const analysis = options.analysis ?? analyseSession(session, { sources: options.sources });
  const lines: string[] = [];

  lines.push('# Debug session');
  lines.push('');
  lines.push(analysis.headline);
  lines.push('');

  // -- What is worth reading first ---------------------------------------------------------------

  const notable = analysis.findings.filter((finding) => finding.severity !== 'info');
  if (notable.length > 0) {
    lines.push('## Worth reading first');
    lines.push('');
    lines.push('*Observations with their evidence, not diagnoses. Check any of them against the detail below.*');
    lines.push('');
    for (const finding of notable.slice(0, 8)) lines.push(...renderFinding(finding));
    lines.push('');
  }

  const stop = session.currentStop;
  if (!stop) {
    lines.push('## State');
    lines.push('');
    lines.push(session.status === 'terminated'
      ? 'The session has ended and no stop was captured.'
      : 'The program is running. Nothing is captured until it stops.');
    lines.push('');
    lines.push(...renderBreakpoints(session));
    return lines.join('\n').trimEnd();
  }

  // -- Where it is --------------------------------------------------------------------------------

  const adapter = session.adapterType ? adapterById(session.adapterType) : undefined;
  const threadId = stop.threadId ?? Number(Object.keys(stop.stacks)[0]);
  const frames = stop.stacks[threadId] ?? [];

  lines.push('## Where it stopped');
  lines.push('');

  if (stop.exception) {
    lines.push(`**${stop.exception.typeName ?? stop.exception.exceptionId}**` +
      (stop.exception.message ? ` — ${stop.exception.message}` : ''));
    if (stop.exception.breakMode) lines.push(`Break mode: \`${stop.exception.breakMode}\``);
    let inner = stop.exception.innerException;
    while (inner) {
      lines.push(`Caused by **${inner.typeName ?? inner.exceptionId}**${inner.message ? ` — ${inner.message}` : ''}`);
      inner = inner.innerException;
    }
    lines.push('');
  }

  lines.push('```');
  for (const [index, frame] of frames.slice(0, 20).entries()) {
    const mine = isUserCode(frame.file, adapter);
    // The marker is the whole point of this list: it is what turns forty frames into three.
    const marker = mine ? '►' : ' ';
    const where = frame.file ? `${frame.file}:${frame.line ?? '?'}` : frame.sourceName ?? '<no source>';
    lines.push(`${marker} #${String(index).padEnd(2)} ${frame.name}  —  ${where}`);
  }
  if (frames.length > 20) lines.push(`  … ${frames.length - 20} more frame(s)`);
  lines.push('```');
  lines.push('');
  if (analysis.runtimeFrameCount > 0) {
    lines.push(`\`►\` marks this project's own code — ${analysis.userFrames.length} of ${frames.length} frames.`);
    lines.push('');
  }

  // -- The source ----------------------------------------------------------------------------------

  const focus = analysis.userFrames[0] ?? frames[0];
  const source = focus ? options.sources?.[focus.id] : undefined;

  if (focus && source) {
    lines.push(`## Source at \`${focus.name}\``);
    lines.push('');
    lines.push('```');
    lines.push(...renderSource(source));
    lines.push('```');
    if (source.unavailable) lines.push(`*${source.unavailable}*`);
    lines.push('');
  }

  // -- The values ------------------------------------------------------------------------------------

  if (focus) {
    lines.push(`## Values in \`${focus.name}\``);
    lines.push('');
    const scopes = stop.frames[focus.id] ?? [];

    if (scopes.length === 0) {
      lines.push('*No scopes were captured for this frame.*');
    }
    for (const scope of scopes) {
      lines.push(`**${scope.name}**${scope.skipped ? ` — not captured: ${scope.skipped}` : ''}`);
      if (scope.skipped) { lines.push(''); continue; }

      lines.push('');
      lines.push('```');
      const limit = options.variablesPerScope ?? 30;
      for (const variable of scope.variables.slice(0, limit)) {
        lines.push(...renderVariable(variable, ''));
      }
      if (scope.variables.length > limit) {
        lines.push(`… ${scope.variables.length - limit} more`);
      }
      lines.push('```');
      lines.push('');
    }
  }

  // -- Threads ---------------------------------------------------------------------------------

  if (analysis.concurrency && analysis.concurrency.threadCount > 1) {
    lines.push('## Threads');
    lines.push('');
    lines.push('```');
    lines.push(...renderConcurrency(analysis.concurrency));
    lines.push('```');
    lines.push('');
  }

  // -- What changed -------------------------------------------------------------------------------

  const diff = session.diffs[session.diffs.length - 1];
  if (diff) {
    lines.push(`## Changed since stop #${diff.fromStop}`);
    lines.push('');
    if (diff.framesEntered.length > 0) lines.push(`Entered: ${diff.framesEntered.slice(0, 10).map(code).join(', ')}`);
    if (diff.framesLeft.length > 0) lines.push(`Left: ${diff.framesLeft.slice(0, 10).map(code).join(', ')}`);
    if (diff.changed.length + diff.added.length + diff.removed.length === 0) {
      lines.push('');
      lines.push(`No value changed across ${diff.unchangedCount} captured value(s) in ${diff.elapsedMs}ms.`);
    } else {
      lines.push('');
      lines.push('```');
      for (const delta of diff.changed.slice(0, 20)) {
        lines.push(`~ ${delta.scope}/${delta.path}: ${delta.before} → ${delta.after}`);
      }
      for (const delta of diff.added.slice(0, 10)) lines.push(`+ ${delta.scope}/${delta.path} = ${delta.after}`);
      for (const delta of diff.removed.slice(0, 10)) lines.push(`- ${delta.scope}/${delta.path}`);
      lines.push('```');
      lines.push(`${diff.unchangedCount} value(s) unchanged.`);
    }
    lines.push('');
  }

  // -- Output ---------------------------------------------------------------------------------------

  if (session.output.length > 0) {
    lines.push('## Program output');
    lines.push('');
    lines.push('```');
    for (const line of session.output.slice(-25)) {
      lines.push(line.category === 'stdout' ? line.text : `[${line.category}] ${line.text}`);
    }
    lines.push('```');
    lines.push('');
  }

  lines.push(...renderBreakpoints(session));

  // -- Memory ------------------------------------------------------------------------------------------

  if (options.includeMemory && stop.memory?.length) {
    lines.push('## Memory');
    lines.push('');
    lines.push('*Each block is read every plausible way. The percentages are self-consistency, not truth.*');
    lines.push('');

    for (const dump of stop.memory) {
      const decoded = decodeMemory(dump);
      lines.push(`\`${dump.reference}\`${dump.address ? ` at ${dump.address}` : ''} — ${dump.byteCount} bytes`);

      if (decoded.fillPattern) lines.push(`> **${decoded.fillPattern}**`);

      lines.push('');
      lines.push('```');
      for (const reading of decoded.readings.slice(0, 4)) {
        lines.push(`[${String(Math.round(reading.plausibility * 100)).padStart(3)}%] ${reading.as}`);
        lines.push(`        ${clip(reading.value, 100)}`);
        lines.push(`        ${reading.because}`);
      }
      lines.push('');
      lines.push(dump.hex);
      lines.push('```');
      lines.push('');
    }
  }

  // -- What is not here -----------------------------------------------------------------------------------

  lines.push('## Limits of this capture');
  lines.push('');
  const limits: string[] = [];

  if (stop.incomplete?.length) limits.push(...stop.incomplete);
  if (budgeted && budgeted.dropped.length > 0) {
    limits.push(`reduced to fit ~${options.maxTokens} tokens; dropped: ${budgeted.dropped.join('; ')}`);
  }
  if (budgeted?.overBudget) {
    limits.push(
      '**the irreducible core still exceeds the budget** — what is above is the stopped frame and ' +
      'its values, and it could not be made smaller without misrepresenting it');
  }
  if (session.warnings.length > 0) limits.push(...session.warnings);
  if (!stop.memory?.length) {
    const known = session.adapterType ? adapterById(session.adapterType) : undefined;
    if (known && !known.expected.memory) limits.push(`${known.name} does not expose memory addresses`);
  }
  const truncated = countTruncated(session);
  if (truncated > 0) limits.push(`${truncated} variable(s) were not expanded (depth, cycle or budget)`);

  if (limits.length === 0) {
    lines.push('Nothing was dropped from this capture.');
  } else {
    for (const limit of limits) lines.push(`- ${limit}`);
  }
  lines.push('');

  lines.push('---');
  lines.push(
    `*${session.adapterType ?? 'unknown adapter'} · ${session.totals.stops} stop(s) · ` +
    `${session.totals.probes} probe(s) · captured by Auspex, read-only: nothing in the program was modified.*`,
  );

  return lines.join('\n').trimEnd();
}

/**
 * The smallest useful form: a few hundred tokens for a tight budget or a chat prefix.
 *
 * Distinct from the ladder's step 12 rather than a call to it, because the shapes serve different
 * readers: the ladder produces a reduced *record* for a tool that expects one, and this produces
 * prose for a reader who has room for a paragraph.
 */
export function debugSummary(record: DebugSessionRecord): string {
  const stop = record.currentStop;
  if (!stop) {
    return record.status === 'terminated'
      ? 'Debug session ended; no stop was captured.'
      : `Debug session ${record.status}; the program has not stopped.`;
  }
  const minimal = minimalStop(stop, record.adapterType) as Record<string, any>;
  const lines = [
    `Stopped: ${minimal.reason}${minimal.exception ? ` (${minimal.exception.type}: ${minimal.exception.message})` : ''}`,
    `At: ${minimal.at ?? 'unknown'}`,
    '',
    'Stack:',
    ...minimal.stack.map((frame: string) => `  ${frame}`),
  ];
  if (minimal.values.length > 0) {
    lines.push('', 'Values:', ...minimal.values.map((value: string) => `  ${value}`));
  }
  return lines.join('\n');
}

/**
 * A size report, for answering "why is this so large".
 *
 * Worth having as its own output because the answer is nearly always a surprise — a single deeply
 * nested object, or a thread nobody was looking at — and knowing which lets a user raise the
 * budget or lower a limit deliberately instead of by trial.
 */
export function debugSizeReport(record: DebugSessionRecord): string {
  const { total, breakdown } = measureDebugRecord(record);
  const lines = [`~${total.toLocaleString()} tokens total (estimated at 4 characters per token)`, ''];

  for (const item of breakdown) {
    const share = Math.round((item.tokens / Math.max(1, total)) * 100);
    lines.push(`  ${item.part.padEnd(16)} ~${String(item.tokens).padStart(8)}  ${'█'.repeat(Math.max(1, Math.round(share / 3)))} ${share}%`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------

function renderFinding(finding: Finding): string[] {
  const badge = { high: '🔴', medium: '🟡', low: '⚪', info: 'ℹ️' }[finding.severity];
  const lines = [`- ${badge} **${finding.summary}**`];

  for (const evidence of finding.evidence.slice(0, 4)) {
    // Multi-line evidence (an exception trace) is indented as a block so it stays readable.
    if (evidence.includes('\n')) {
      lines.push('  ```');
      for (const line of evidence.split('\n').slice(0, 12)) lines.push(`  ${line}`);
      lines.push('  ```');
    } else {
      lines.push(`  - ${evidence}`);
    }
  }
  if (finding.nextStep) lines.push(`  - → ${finding.nextStep}`);
  return lines;
}

/**
 * Renders one variable, adding what the debugger's string does not say.
 *
 * Three enrichments, each earning its space:
 *
 * - A **statistical summary** replaces the listing for a large collection. Thirty of fifty thousand
 *   integers tells a reader almost nothing; "50,000 ints, range 0–4,999, 12 negative" tells them
 *   what they were going to ask.
 * - An **inferred shape** for a value whose type the debugger did not report, which is every value
 *   in a dynamically typed language.
 * - A **note on an unresolved value** — a pending future, a lazy sequence — because a reader who
 *   takes `<generator>` for data will be confused by everything downstream of it.
 */
function renderVariable(variable: DebugVariable, indent: string): string[] {
  const type = variable.type ? `: ${variable.type}` : '';
  const note = variable.truncated ? `   ⟨${variable.truncated}⟩` : '';
  const lines = [`${indent}${variable.name}${type} = ${clip(variable.value)}${note}`];

  const interpreted = interpretValue(variable.value, variable.type);

  // Large collections are described rather than listed.
  const declared = variable.indexedVariables ?? interpreted.size ?? 0;
  if ((interpreted.kind === 'collection' || interpreted.kind === 'map') && declared > 12) {
    const summary = summarizeCollection(variable, declared);
    lines.push(`${indent}  → ${renderCollectionSummary(summary)}`);
    for (const example of summary.examples.slice(0, 4)) lines.push(`${indent}    ${example}`);
    return lines;
  }

  // A shape for anything the debugger did not type, which is the whole of a dynamic language.
  if (!variable.type && variable.children && variable.children.length > 2) {
    lines.push(`${indent}  → shape ${inferShape(variable).shape}`);
  }

  if (interpreted.incomplete && interpreted.kind !== 'string') {
    lines.push(`${indent}  → ${interpreted.because} — this is not the data yet`);
  }

  for (const child of variable.children ?? []) {
    lines.push(...renderVariable(child, `${indent}  `));
  }
  return lines;
}

function renderBreakpoints(record: DebugSessionRecord): string[] {
  if (record.breakpoints.length === 0) return [];
  const lines = ['## Breakpoints', ''];

  for (const breakpoint of record.breakpoints.slice(0, 25)) {
    const where = breakpoint.kind === 'line'
      ? `${breakpoint.file ?? '?'}:${breakpoint.line ?? '?'}`
      : breakpoint.functionName ?? breakpoint.dataId ?? breakpoint.instructionReference ?? breakpoint.kind;
    const state = breakpoint.verified === false
      ? ` — **never bound**${breakpoint.message ? `: ${breakpoint.message}` : ''}`
      : '';
    const conditions = [
      breakpoint.condition ? `if \`${breakpoint.condition}\`` : '',
      breakpoint.hitCondition ? `hits \`${breakpoint.hitCondition}\`` : '',
    ].filter(Boolean).join(', ');

    lines.push(`- \`${where}\`${conditions ? ` (${conditions})` : ''}${state}`);
  }
  lines.push('');
  return lines;
}

function countTruncated(record: DebugSessionRecord): number {
  let total = 0;
  const walk = (variables: DebugVariable[]) => {
    for (const variable of variables) {
      if (variable.truncated) total++;
      if (variable.children) walk(variable.children);
    }
  };
  for (const scopes of Object.values(record.currentStop?.frames ?? {})) {
    for (const scope of scopes) walk(scope.variables);
  }
  return total;
}

function clip(value: string, width = 120): string {
  const single = value.replace(/\s*\n\s*/g, ' ⏎ ');
  return single.length > width ? `${single.slice(0, width - 1)}…` : single;
}

function code(value: string): string {
  return `\`${value}\``;
}

/** Re-exported so callers can annotate a report with the frame it focused on. */
export function focusFrame(record: DebugSessionRecord): DebugStackFrame | undefined {
  const stop = record.currentStop;
  if (!stop) return undefined;
  const adapter = record.adapterType ? adapterById(record.adapterType) : undefined;
  const frames = stop.stacks[stop.threadId ?? Number(Object.keys(stop.stacks)[0])] ?? [];
  return frames.find((frame) => isUserCode(frame.file, adapter)) ?? frames[0];
}
