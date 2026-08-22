import type {
  DebugScope, DebugSessionRecord, DebugStackFrame, DebugStop, DebugStopDiff, DebugVariable,
} from '../core/debug-model.ts';
import { bold, dim, grey, paint, pad, shortenPath, truncate } from './format.ts';

/**
 * Renders a deep debug session for a terminal.
 *
 * Written as pure functions over the record, with no I/O and no colour decisions that depend on
 * anything but the data, so the whole of it is testable — the same reason the TUI's frame renderer
 * is pure. A formatter that can only be checked by looking at it is a formatter nobody checks.
 *
 * The ordering is the argument: **why it stopped**, then **where** (the stack), then **what the
 * values are** (scopes and variables), then **what changed since last time**, then the raw
 * material — memory, modules, the wire timeline. That is the order a person actually asks the
 * questions in, and an assistant reading top-down gets the same benefit.
 */

export interface DebugRenderOptions {
  /** Include the full variable trees rather than the top level. */
  verbose?: boolean;
  /** Include the message timeline. */
  timeline?: boolean;
  /** Include hex dumps. */
  memory?: boolean;
  /** How many timeline entries to show. */
  timelineLimit?: number;
}

/** The whole session. */
export function renderDebugSession(
  record: DebugSessionRecord,
  options: DebugRenderOptions = {},
): string {
  const lines: string[] = [];

  lines.push(bold(`Debug session ${record.sessionId}`));
  const bits = [
    record.adapterType ?? 'unknown adapter',
    record.startMethod ?? '',
    statusLabel(record.status),
  ].filter(Boolean);
  lines.push(grey(bits.join('  ·  ')));

  const totals = record.totals;
  lines.push(grey(
    `${totals.stops} stop(s)  ${totals.requests} request(s)  ${totals.events} event(s)  ` +
    `${totals.probes} probe(s)  ${formatBytes(totals.bytesIn + totals.bytesOut)} on the wire` +
    (totals.failedResponses > 0 ? `  ${totals.failedResponses} failed` : ''),
  ));
  if (totals.slowestMs !== undefined) {
    lines.push(grey(`slowest round trip: ${totals.slowestCommand} at ${totals.slowestMs}ms`));
  }
  lines.push('');

  if (record.currentStop) {
    lines.push(...renderStop(record.currentStop, options));
    lines.push('');
  } else if (record.status === 'running') {
    lines.push(grey('running; nothing captured yet — the program has not stopped'));
    lines.push('');
  }

  const diff = record.diffs[record.diffs.length - 1];
  if (diff) {
    lines.push(...renderDiff(diff));
    lines.push('');
  }

  if (record.breakpoints.length > 0) {
    lines.push(bold('Breakpoints'));
    for (const breakpoint of record.breakpoints) {
      const where = breakpoint.kind === 'line'
        ? `${shortenPath(breakpoint.file ?? '?')}:${breakpoint.line ?? '?'}`
        : breakpoint.functionName ?? breakpoint.dataId ?? breakpoint.instructionReference ?? breakpoint.kind;
      // An unverified breakpoint never fires, and not knowing that is the most common way a debug
      // session wastes someone's afternoon. It gets the loud colour.
      const mark = breakpoint.verified ? paint('●', 'green') : paint('○', 'yellow');
      const extra = [
        breakpoint.condition ? `if ${breakpoint.condition}` : '',
        breakpoint.hitCondition ? `hits ${breakpoint.hitCondition}` : '',
        breakpoint.logMessage ? `log "${breakpoint.logMessage}"` : '',
        breakpoint.verified ? '' : `unverified${breakpoint.message ? `: ${breakpoint.message}` : ''}`,
      ].filter(Boolean).join('  ');
      lines.push(`  ${mark} ${pad(breakpoint.kind, 12)} ${where}${extra ? grey(`  ${extra}`) : ''}`);
    }
    lines.push('');
  }

  if (record.evaluations.length > 0) {
    lines.push(bold('Expressions the user evaluated'));
    for (const evaluation of record.evaluations.slice(-10)) {
      const value = evaluation.error ? paint(evaluation.error, 'red') : evaluation.result ?? '';
      lines.push(`  ${evaluation.expression} ${grey('=')} ${truncate(value, 80)}`);
    }
    lines.push('');
  }

  if (options.memory && record.currentStop?.memory?.length) {
    lines.push(bold('Memory'));
    for (const dump of record.currentStop.memory) {
      lines.push(grey(`  ${dump.reference}${dump.address ? ` @ ${dump.address}` : ''} — ${dump.byteCount} bytes`));
      for (const line of dump.hex.split('\n')) lines.push(`    ${line}`);
      if (dump.unreadableBytes) lines.push(grey(`    ${dump.unreadableBytes} byte(s) unreadable`));
    }
    lines.push('');
  }

  if (record.modules.length > 0 && options.verbose) {
    lines.push(bold(`Modules (${record.modules.length})`));
    for (const module of record.modules.slice(0, 30)) {
      const symbols = module.symbolStatus ? grey(`  ${module.symbolStatus}`) : '';
      lines.push(`  ${pad(module.name, 32)}${grey(module.version ?? '')}${symbols}`);
    }
    lines.push('');
  }

  if (record.output.length > 0) {
    lines.push(bold('Program output'));
    for (const line of record.output.slice(-20)) {
      const colour = line.category === 'stderr' ? 'red' : line.category === 'important' ? 'yellow' : 'grey';
      lines.push(`  ${paint(pad(line.category, 8), colour as never)} ${truncate(line.text, 100)}`);
    }
    lines.push('');
  }

  if (options.timeline) {
    lines.push(...renderTimeline(record, options.timelineLimit ?? 40));
    lines.push('');
  }

  if (record.warnings.length > 0) {
    lines.push(bold('Warnings'));
    for (const warning of record.warnings) lines.push(`  ${paint('!', 'yellow')} ${warning}`);
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

/** One stop: why, where, and what the values were. */
export function renderStop(stop: DebugStop, options: DebugRenderOptions = {}): string[] {
  const lines: string[] = [];

  const why = [stop.reason ?? 'stopped', stop.description, stop.text].filter(Boolean).join(' — ');
  lines.push(bold(`Stop #${stop.index}: ${why}`));
  lines.push(grey(
    `${stop.at}  ·  captured in ${stop.captureMs}ms` +
    (stop.allThreadsStopped ? '  ·  all threads stopped' : ''),
  ));

  if (stop.exception) {
    lines.push('');
    lines.push(paint(`  ${stop.exception.typeName ?? stop.exception.exceptionId}`, 'red'));
    if (stop.exception.message) lines.push(`  ${stop.exception.message}`);
    if (stop.exception.breakMode) lines.push(grey(`  break mode: ${stop.exception.breakMode}`));
    if (stop.exception.stackTrace) {
      for (const line of stop.exception.stackTrace.split('\n').slice(0, 12)) {
        lines.push(grey(`    ${line.trim()}`));
      }
    }
    let inner = stop.exception.innerException;
    while (inner) {
      lines.push(grey(`  caused by ${inner.typeName ?? inner.exceptionId}: ${inner.message ?? ''}`));
      inner = inner.innerException;
    }
  }

  if (stop.threads.length > 1) {
    lines.push('');
    lines.push(grey(`  ${stop.threads.length} thread(s): ` +
      stop.threads.map((thread) => `${thread.name}${thread.stopped ? '*' : ''}`).slice(0, 8).join(', ')));
  }

  const stoppedId = stop.threadId ?? Number(Object.keys(stop.stacks)[0]);

  for (const [threadIdText, frames] of Object.entries(stop.stacks)) {
    const threadId = Number(threadIdText);
    const thread = stop.threads.find((item) => item.id === threadId);
    const isStopped = threadId === stoppedId;

    lines.push('');
    lines.push(`  ${isStopped ? bold(thread?.name ?? `thread ${threadId}`) : grey(thread?.name ?? `thread ${threadId}`)}`);

    const shown = isStopped || options.verbose ? frames : frames.slice(0, 3);
    for (const [index, frame] of shown.entries()) {
      lines.push(`    ${renderFrame(frame, index)}`);

      const scopes = stop.frames[frame.id];
      if (!scopes || (!isStopped && !options.verbose)) continue;
      for (const scope of scopes) lines.push(...renderScope(scope, options, '      '));
    }
    if (shown.length < frames.length) {
      lines.push(grey(`    … ${frames.length - shown.length} more frame(s)`));
    }
  }

  if (stop.disassembly?.length) {
    lines.push('');
    lines.push(grey('  disassembly'));
    for (const instruction of stop.disassembly) {
      lines.push(grey(`    ${instruction.address}  ${instruction.instruction}`));
    }
  }

  if (stop.incomplete?.length) {
    lines.push('');
    for (const note of stop.incomplete) lines.push(paint(`  incomplete: ${note}`, 'yellow'));
  }
  return lines;
}

function renderFrame(frame: DebugStackFrame, index: number): string {
  const where = frame.file
    ? `${shortenPath(frame.file, 50)}:${frame.line ?? '?'}`
    : frame.sourceName ?? '<no source>';
  const name = frame.presentationHint === 'subtle' || frame.unmapped
    ? dim(frame.name)          // The debugger itself considers these frames noise; so do we.
    : frame.name;
  return `${grey(`#${index}`)} ${pad(name, 40)} ${grey(where)}`;
}

function renderScope(scope: DebugScope, options: DebugRenderOptions, indent: string): string[] {
  const lines: string[] = [];
  const count = scope.skipped ? grey(`(${scope.skipped})`) : grey(`(${scope.variables.length})`);
  lines.push(`${indent}${paint(scope.name, 'cyan')} ${count}`);

  const limit = options.verbose ? scope.variables.length : 12;
  for (const variable of scope.variables.slice(0, limit)) {
    lines.push(...renderVariable(variable, options, `${indent}  `, options.verbose ? 99 : 1));
  }
  if (scope.variables.length > limit) {
    lines.push(`${indent}  ${grey(`… ${scope.variables.length - limit} more`)}`);
  }
  return lines;
}

function renderVariable(
  variable: DebugVariable,
  options: DebugRenderOptions,
  indent: string,
  depth: number,
): string[] {
  const type = variable.type ? grey(`: ${variable.type}`) : '';
  const note = variable.truncated ? grey(`  ⟨${variable.truncated}⟩`) : '';
  const lines = [`${indent}${variable.name}${type} = ${truncate(variable.value, 90)}${note}`];

  if (variable.children && depth > 0) {
    for (const child of variable.children) {
      lines.push(...renderVariable(child, options, `${indent}  `, depth - 1));
    }
  } else if (variable.children) {
    lines.push(`${indent}  ${grey(`… ${variable.children.length} child(ren); use --verbose`)}`);
  }
  return lines;
}

/** What changed between the last two stops — the question a stepping developer is actually asking. */
export function renderDiff(diff: DebugStopDiff): string[] {
  const lines: string[] = [
    bold(`Since stop #${diff.fromStop} (${diff.elapsedMs}ms earlier)`),
  ];

  if (diff.framesEntered.length > 0) {
    lines.push(`  ${paint('entered', 'green')} ${diff.framesEntered.slice(0, 8).join(', ')}`);
  }
  if (diff.framesLeft.length > 0) {
    lines.push(`  ${paint('left', 'red')}    ${diff.framesLeft.slice(0, 8).join(', ')}`);
  }
  for (const delta of diff.changed.slice(0, 25)) {
    lines.push(`  ${paint('~', 'yellow')} ${delta.scope}/${delta.path}: ` +
      `${truncate(delta.before ?? '', 40)} ${grey('→')} ${truncate(delta.after ?? '', 40)}`);
  }
  for (const delta of diff.added.slice(0, 15)) {
    lines.push(`  ${paint('+', 'green')} ${delta.scope}/${delta.path} = ${truncate(delta.after ?? '', 60)}`);
  }
  for (const delta of diff.removed.slice(0, 15)) {
    lines.push(`  ${paint('-', 'red')} ${delta.scope}/${delta.path} ${grey(`was ${truncate(delta.before ?? '', 40)}`)}`);
  }
  if (diff.changed.length === 0 && diff.added.length === 0 && diff.removed.length === 0) {
    lines.push(grey(`  nothing changed; ${diff.unchangedCount} value(s) held`));
  } else {
    lines.push(grey(`  ${diff.unchangedCount} value(s) unchanged`));
  }
  return lines;
}

/** Everything that crossed the wire, most recent last. */
export function renderTimeline(record: DebugSessionRecord, limit: number): string[] {
  const lines = [bold(`Wire timeline (last ${Math.min(limit, record.timeline.length)} of ${record.timeline.length})`)];

  for (const entry of record.timeline.slice(-limit)) {
    const arrow = entry.direction === 'in' ? paint('→', 'blue')
      : entry.direction === 'probe' ? paint('⇢', 'magenta')
      : paint('←', 'green');
    const timing = entry.durationMs !== undefined ? grey(` ${entry.durationMs}ms`) : '';
    const failed = entry.success === false ? paint(' failed', 'red') : '';
    lines.push(
      `  ${grey(pad(`+${entry.deltaMs}ms`, 9))}${arrow} ${pad(entry.type, 9)}${pad(entry.name, 22)}` +
      `${grey(formatBytes(entry.bytes))}${timing}${failed}`,
    );
    if (entry.summary) lines.push(grey(`             ${truncate(entry.summary, 100)}`));
  }
  return lines;
}

function statusLabel(status: DebugSessionRecord['status']): string {
  switch (status) {
    case 'paused': return paint('paused', 'yellow');
    case 'running': return paint('running', 'green');
    case 'terminated': return grey('terminated');
    default: return grey(status);
  }
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value}B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}KB`;
  return `${(value / (1024 * 1024)).toFixed(1)}MB`;
}
