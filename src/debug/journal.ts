import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import type { DebugEvent, DebugSessionRecord, DebugStop } from '../core/debug-model.ts';
import type { Redactor } from '../core/redact.ts';
import { sessionDirectory } from '../core/debug-store.ts';

/**
 * An append-only record of a debug session, written as it happens.
 *
 * ## Why this exists alongside the published snapshot
 *
 * `core/debug-store.ts` publishes the *current* state of a session, overwriting it each time. That
 * is the right shape for "what is the program doing now", and it is the wrong shape for two
 * questions that come up constantly:
 *
 * - **"What happened before it crashed?"** The published record holds a bounded ring of recent
 *   stops. A program that stopped four hundred times before failing has lost the first three
 *   hundred and eighty by the time anyone looks.
 * - **"Can I look at yesterday's session?"** The published file is overwritten by the next run of
 *   the same session name, and nothing survives a machine restart.
 *
 * A journal answers both by never rewriting anything. Each line is one event, appended and flushed;
 * a process killed mid-session leaves a journal that is complete up to the moment it died, which is
 * exactly when the record is most valuable.
 *
 * ## Why newline-delimited JSON
 *
 * Because the alternative is a single JSON document, and a single JSON document cannot be appended
 * to — every write would rewrite the file, which for a long session is quadratic and for a crashed
 * process leaves a truncated document that will not parse at all. NDJSON degrades to exactly one
 * lost line, always the last one, and is readable with `tail` and `grep`, which matters more than
 * it sounds when someone is debugging the debugger.
 *
 * ## What is written
 *
 * Stops in full, and wire events in summary. Full payloads are never journalled: a stepping session
 * produces megabytes of protocol traffic per minute, most of it repeated, and the timeline entries
 * already carry direction, size and timing — which is what the traffic is actually read for.
 */

/** One line of a journal. */
export type JournalEntry =
  | { kind: 'session'; at: string; session: SessionHeader }
  | { kind: 'stop'; at: string; stop: DebugStop }
  | { kind: 'event'; at: string; event: DebugEvent }
  | { kind: 'output'; at: string; category: string; text: string }
  | { kind: 'end'; at: string; status: string; totals: DebugSessionRecord['totals'] };

export interface SessionHeader {
  sessionId: string;
  adapterType?: string;
  startMethod?: string;
  name?: string;
  startedAt: string;
  /** The schema of the journal itself, so a future reader knows what it is holding. */
  journalVersion: string;
}

export const JOURNAL_VERSION = '1';

export interface JournalOptions {
  /** Where to write. Defaults to the shared session directory. */
  path?: string;
  redactor?: Redactor;
  /** Whether to journal wire events as well as stops. */
  includeEvents?: boolean;
  /** Stop journalling past this size, rather than filling a disk. */
  maxBytes?: number;
}

/**
 * Writes a journal for one session.
 *
 * Every method is fire-and-forget from the caller's point of view and swallows its own errors. A
 * journal is a convenience; a proxy that broke someone's debug session because a disk was full
 * would be trading something valuable for something optional.
 */
export class DebugJournal {
  readonly path: string;
  private readonly options: JournalOptions;
  private bytes = 0;
  private stopped = false;
  /** Serializes writes, so appends cannot interleave and produce a corrupt line. */
  private queue: Promise<void> = Promise.resolve();

  constructor(sessionId: string, options: JournalOptions = {}) {
    this.options = options;
    this.path = options.path ?? journalPath(sessionId);
  }

  /** Writes the header. Call once, before anything else. */
  async begin(header: Omit<SessionHeader, 'journalVersion'>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true }).catch(() => {});
    this.write({
      kind: 'session',
      at: new Date().toISOString(),
      session: { ...header, journalVersion: JOURNAL_VERSION },
    });
  }

  /** Records a completed stop, in full. */
  stop(stop: DebugStop): void {
    this.write({ kind: 'stop', at: new Date().toISOString(), stop });
  }

  /** Records one wire event, in summary. */
  event(event: DebugEvent): void {
    if (this.options.includeEvents === false) return;
    this.write({ kind: 'event', at: new Date().toISOString(), event });
  }

  output(category: string, text: string): void {
    this.write({ kind: 'output', at: new Date().toISOString(), category, text });
  }

  /** Closes the journal with the session's final totals. */
  end(status: string, totals: DebugSessionRecord['totals']): void {
    this.write({ kind: 'end', at: new Date().toISOString(), status, totals });
    this.stopped = true;
  }

  /** Resolves when everything queued has been written. */
  async flush(): Promise<void> {
    await this.queue;
  }

  private write(entry: JournalEntry): void {
    if (this.stopped && entry.kind !== 'end') return;

    const payload = this.options.redactor ? this.options.redactor.redactValue(entry) : entry;
    let line: string;
    try {
      line = `${JSON.stringify(payload)}\n`;
    } catch {
      return;       // A value that will not serialize is not worth failing a session over.
    }

    const max = this.options.maxBytes ?? 256 * 1024 * 1024;
    if (this.bytes + line.length > max) {
      if (!this.stopped) {
        this.stopped = true;
        // Said once, in the journal itself, so a reader of the file knows why it ends.
        this.queue = this.queue.then(() =>
          appendFile(this.path, `${JSON.stringify({
            kind: 'end', at: new Date().toISOString(), status: 'journal-size-limit',
            totals: { note: `stopped after ${max} bytes` },
          })}\n`, 'utf8').catch(() => {}));
      }
      return;
    }
    this.bytes += line.length;
    this.queue = this.queue.then(() => appendFile(this.path, line, 'utf8').catch(() => {}));
  }
}

/** Where a session's journal lives. */
export function journalPath(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64) || 'session';
  return join(sessionDirectory(), `auspex-journal-${safe}.ndjson`);
}

export interface JournalSummary {
  path: string;
  header?: SessionHeader;
  stops: number;
  events: number;
  outputLines: number;
  bytes: number;
  /** The final entry, when the session ended cleanly. */
  ended?: { at: string; status: string };
  /** Lines that would not parse. Reported rather than hidden. */
  corruptLines: number;
}

/**
 * Reads a journal without loading it into memory.
 *
 * Streamed line by line, because a long session's journal can be hundreds of megabytes and the
 * whole reason for the format is that it never has to be held whole. A line that will not parse is
 * counted and skipped — the expected case is exactly one, at the end, from a process that was
 * killed mid-write.
 */
export async function summarizeJournal(path: string): Promise<JournalSummary> {
  const summary: JournalSummary = {
    path, stops: 0, events: 0, outputLines: 0, bytes: 0, corruptLines: 0,
  };
  summary.bytes = await stat(path).then((info) => info.size).catch(() => 0);
  if (summary.bytes === 0) return summary;

  const reader = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });

  for await (const line of reader) {
    if (!line.trim()) continue;
    let entry: JournalEntry;
    try {
      entry = JSON.parse(line) as JournalEntry;
    } catch {
      summary.corruptLines++;
      continue;
    }
    switch (entry.kind) {
      case 'session': summary.header = entry.session; break;
      case 'stop': summary.stops++; break;
      case 'event': summary.events++; break;
      case 'output': summary.outputLines++; break;
      case 'end': summary.ended = { at: entry.at, status: entry.status }; break;
    }
  }
  return summary;
}

/**
 * Reads selected stops back out of a journal.
 *
 * Takes a range rather than everything, because the whole point of the journal is that it holds
 * more than fits in memory. `from` and `to` are stop indices as they appear in the record, counting
 * from one.
 */
export async function readStops(
  path: string,
  range: { from?: number; to?: number; limit?: number } = {},
): Promise<DebugStop[]> {
  const { from = 1, to = Number.MAX_SAFE_INTEGER, limit = 50 } = range;
  const stops: DebugStop[] = [];

  const reader = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });

  for await (const line of reader) {
    if (!line.includes('"kind":"stop"')) continue;     // Cheap pre-filter before the parse.
    let entry: JournalEntry;
    try {
      entry = JSON.parse(line) as JournalEntry;
    } catch {
      continue;
    }
    if (entry.kind !== 'stop') continue;
    if (entry.stop.index < from || entry.stop.index > to) continue;

    stops.push(entry.stop);
    if (stops.length >= limit) break;
  }
  return stops;
}

/**
 * Rebuilds a session record from a journal.
 *
 * Not a perfect reconstruction and does not pretend to be: wire events were journalled in summary,
 * so the replayed timeline holds what the original timeline held after its ring evicted the rest.
 * What *is* exact is the stops — every one of them, including the ones the live record had already
 * dropped, which is the reason to replay in the first place.
 */
export async function replayJournal(
  path: string,
  options: { maxStops?: number } = {},
): Promise<DebugSessionRecord | undefined> {
  const maxStops = options.maxStops ?? 200;

  const text = await readFile(path, 'utf8').catch(() => undefined);
  if (text === undefined) return undefined;

  const record: DebugSessionRecord = {
    sessionId: 'replay',
    startedAt: new Date().toISOString(),
    status: 'terminated',
    stops: [], diffs: [], breakpoints: [], modules: [], loadedSources: [],
    evaluations: [], output: [], timeline: [],
    totals: {
      requests: 0, responses: 0, events: 0, probes: 0, failedResponses: 0,
      bytesIn: 0, bytesOut: 0, stops: 0,
    },
    warnings: [],
  };

  let corrupt = 0;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry: JournalEntry;
    try {
      entry = JSON.parse(line) as JournalEntry;
    } catch {
      corrupt++;
      continue;
    }

    switch (entry.kind) {
      case 'session':
        record.sessionId = entry.session.sessionId;
        record.adapterType = entry.session.adapterType;
        record.startMethod = entry.session.startMethod;
        record.name = entry.session.name;
        record.startedAt = entry.session.startedAt;
        if (entry.session.journalVersion !== JOURNAL_VERSION) {
          record.warnings.push(
            `journal version ${entry.session.journalVersion} was written by a different version of ` +
            `Auspex (this one writes ${JOURNAL_VERSION}); some fields may be missing`);
        }
        break;

      case 'stop':
        if (record.currentStop) record.stops.push(record.currentStop);
        record.currentStop = entry.stop;
        record.totals.stops++;
        while (record.stops.length > maxStops) record.stops.shift();
        break;

      case 'event':
        record.timeline.push(entry.event);
        if (record.timeline.length > 2000) record.timeline.shift();
        break;

      case 'output':
        record.output.push({ at: entry.at, category: entry.category, text: entry.text });
        if (record.output.length > 2000) record.output.shift();
        break;

      case 'end':
        record.endedAt = entry.at;
        if (entry.totals && typeof entry.totals === 'object') {
          record.totals = { ...record.totals, ...entry.totals };
        }
        if (entry.status === 'journal-size-limit') {
          record.warnings.push('the journal hit its size limit; the session continued past this point');
        }
        break;
    }
  }

  if (corrupt > 0) {
    // Nearly always exactly one, at the end, from a process killed mid-write. Saying so is the
    // difference between a reader trusting the record and a reader wondering.
    record.warnings.push(
      `${corrupt} journal line(s) would not parse and were skipped` +
      (corrupt === 1 ? ' — this is the expected result of a process ending mid-write' : ''));
  }
  if (!record.endedAt) {
    record.warnings.push('the journal has no end entry: the session was still running, or the process was killed');
  }
  return record;
}
