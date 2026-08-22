import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type {
  DebugScope, DebugSessionRecord, DebugStop, DebugVariable,
} from '../core/debug-model.ts';
import type { JournalEntry } from './journal.ts';
import { interpretValue, type ValueKind } from './values.ts';

/**
 * Searching a whole debug session, across every stop it ever made.
 *
 * ## The capability an IDE does not have
 *
 * Every debugger shows you the present. Step, and the previous state is gone — the variables pane
 * repaints, the stack redraws, and the value that was there a moment ago exists only in whatever
 * you managed to write down. The questions people actually have while debugging are mostly
 * historical:
 *
 * - *"When did `retries` become 5?"*
 * - *"Was `user` ever non-null in this session?"*
 * - *"Show me every stop where the connection was closed."*
 * - *"Which iteration was the first one with an empty list?"*
 *
 * No IDE answers any of those. They cannot, because they keep no history — and the reason they
 * keep none is that a debugger is built to drive a program, while Auspex is built to *record* one.
 * Having the journal already, the search is the cheap part, and it turns a session into something
 * you can interrogate rather than only watch.
 *
 * ## Two sources, deliberately
 *
 * A query runs against the in-memory record (fast, recent, bounded) or a journal file (complete,
 * streamed, unbounded). The same query shape works on both, so a caller does not have to know
 * which they have — and the result says which it read, because "no match in the last twenty stops"
 * and "no match in the whole session" are very different answers.
 */

export interface VariableQuery {
  /** Match on the variable's name. Substring, case-insensitive. */
  name?: string;
  /** Match on the variable's value. Substring, case-insensitive. */
  value?: string;
  /** Match on the declared type. */
  type?: string;
  /** Match on the interpreted kind — every collection, every null, every error. */
  kind?: ValueKind;
  /** Restrict to a scope by name. */
  scope?: string;
  /** Restrict to a frame by function name. */
  frame?: string;
  /** Restrict to a range of stop indices. */
  fromStop?: number;
  toStop?: number;
  /** How deep into variable trees to search. */
  maxDepth?: number;
  limit?: number;
}

export interface QueryMatch {
  stopIndex: number;
  at: string;
  /** The reason the program stopped, for context. */
  reason?: string;
  frame: string;
  file?: string;
  line?: number;
  scope: string;
  /** Dotted path within the scope. */
  path: string;
  name: string;
  value: string;
  type?: string;
  kind: ValueKind;
}

export interface QueryResult {
  matches: QueryMatch[];
  /** How many stops were searched. */
  stopsSearched: number;
  /** Which source answered. */
  source: 'record' | 'journal';
  /** True when the search hit its limit and stopped early. */
  truncated: boolean;
  /** Stated when the source cannot answer for the whole session. */
  caveat?: string;
}

/** Searches the stops held in a live record. */
export function queryRecord(record: DebugSessionRecord, query: VariableQuery): QueryResult {
  const stops = [...record.stops, ...(record.currentStop ? [record.currentStop] : [])];
  const result = searchStops(stops, query);

  return {
    ...result,
    source: 'record',
    // The record is a bounded ring. A search that reported "not found" without saying it only
    // looked at the recent stops would be answering a different question than the one asked.
    caveat: record.totals.stops > stops.length
      ? `the live record holds ${stops.length} of ${record.totals.stops} stop(s); ` +
        'search the journal for the whole session'
      : undefined,
  };
}

/**
 * Searches a journal, streamed.
 *
 * Line by line so a journal larger than memory is searchable, which is the case the journal exists
 * for. The cheap `includes` test before the parse matters more than it looks: parsing every stop of
 * a large journal to reject most of them is the difference between a search that feels instant and
 * one that does not.
 */
export async function queryJournal(path: string, query: VariableQuery): Promise<QueryResult> {
  const matches: QueryMatch[] = [];
  const limit = query.limit ?? 100;
  let stopsSearched = 0;
  let truncated = false;

  const reader = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });

  for await (const line of reader) {
    if (!line.includes('"kind":"stop"')) continue;

    // A name or value filter can be rejected against the raw line before parsing it. This is safe
    // because a JSON-encoded field cannot match a substring the line does not contain.
    if (query.name && !line.toLowerCase().includes(query.name.toLowerCase())) continue;
    if (query.value && !line.toLowerCase().includes(query.value.toLowerCase())) continue;

    let entry: JournalEntry;
    try {
      entry = JSON.parse(line) as JournalEntry;
    } catch {
      continue;
    }
    if (entry.kind !== 'stop') continue;

    stopsSearched++;
    const found = searchStops([entry.stop], { ...query, limit: limit - matches.length });
    matches.push(...found.matches);

    if (matches.length >= limit) {
      truncated = true;
      break;
    }
  }

  reader.close();
  return { matches, stopsSearched, source: 'journal', truncated };
}

/** The shared search, over any list of stops. */
function searchStops(
  stops: DebugStop[],
  query: VariableQuery,
): { matches: QueryMatch[]; stopsSearched: number; truncated: boolean } {
  const matches: QueryMatch[] = [];
  const limit = query.limit ?? 100;
  const maxDepth = query.maxDepth ?? 4;
  let stopsSearched = 0;

  for (const stop of stops) {
    if (query.fromStop !== undefined && stop.index < query.fromStop) continue;
    if (query.toStop !== undefined && stop.index > query.toStop) continue;
    stopsSearched++;

    // Frame identity is in the stacks; the values are keyed by frame id. Joining them here is what
    // lets a match report which function it was in rather than an opaque number.
    const framesById = new Map<number, { name: string; file?: string; line?: number }>();
    for (const frames of Object.values(stop.stacks)) {
      for (const frame of frames) framesById.set(frame.id, frame);
    }

    for (const [frameIdText, scopes] of Object.entries(stop.frames)) {
      const frameId = Number(frameIdText);
      const frame = framesById.get(frameId);

      if (query.frame && !(frame?.name ?? '').toLowerCase().includes(query.frame.toLowerCase())) continue;

      for (const scope of scopes) {
        if (query.scope && scope.name !== query.scope) continue;

        walk(scope, scope.variables, '', 0);

        function walk(owner: DebugScope, variables: DebugVariable[], prefix: string, depth: number): void {
          if (depth > maxDepth || matches.length >= limit) return;

          for (const variable of variables) {
            const path = prefix ? `${prefix}.${variable.name}` : variable.name;

            if (variableMatches(variable, query)) {
              matches.push({
                stopIndex: stop.index,
                at: stop.at,
                reason: stop.reason,
                frame: frame?.name ?? `frame ${frameId}`,
                file: frame?.file,
                line: frame?.line,
                scope: owner.name,
                path,
                name: variable.name,
                value: variable.value,
                type: variable.type,
                kind: interpretValue(variable.value, variable.type).kind,
              });
              if (matches.length >= limit) return;
            }
            if (variable.children) walk(owner, variable.children, path, depth + 1);
          }
        }
      }
    }
  }
  return { matches, stopsSearched, truncated: matches.length >= limit };
}

function variableMatches(variable: DebugVariable, query: VariableQuery): boolean {
  if (query.name && !variable.name.toLowerCase().includes(query.name.toLowerCase())) return false;
  if (query.value && !variable.value.toLowerCase().includes(query.value.toLowerCase())) return false;
  if (query.type && !(variable.type ?? '').toLowerCase().includes(query.type.toLowerCase())) return false;

  if (query.kind && interpretValue(variable.value, variable.type).kind !== query.kind) return false;

  // A query with no criteria at all matches nothing rather than everything: returning the entire
  // session because someone forgot a filter is a worse failure than returning nothing.
  return Boolean(query.name || query.value || query.type || query.kind);
}

// ---------------------------------------------------------------------------------------------
// Trajectory
// ---------------------------------------------------------------------------------------------

export interface Trajectory {
  path: string;
  /** Every distinct value the variable held, in order, with where it changed. */
  points: Array<{
    stopIndex: number;
    at: string;
    value: string;
    frame: string;
    file?: string;
    line?: number;
    /** True when this differs from the previous point. */
    changed: boolean;
  }>;
  /** How many stops the variable was present in. */
  seenIn: number;
  /** How many times it took a new value. */
  changes: number;
  /** Stops where it existed at all, for spotting when it came into and went out of scope. */
  firstSeen?: number;
  lastSeen?: number;
  /** Values it held, most frequent first. */
  distinct: Array<{ value: string; count: number }>;
}

/**
 * One variable's history through a session.
 *
 * The single most useful thing here, and the reason the journal is worth its disk. "`retries` was
 * 0, 0, 0, 1, 1, 2, 2, 3 and then the exception" is a description of a bug, and it is not
 * obtainable from any debugger by any amount of stepping — you would have to write the values down
 * as you went, which is exactly the manual labour this replaces.
 *
 * Consecutive identical values are collapsed to a single point with `changed: false`, because a
 * variable that held `0` for four hundred stops should read as one line, not four hundred.
 */
export function trajectory(stops: DebugStop[], path: string): Trajectory {
  const points: Trajectory['points'] = [];
  const counts = new Map<string, number>();
  let previous: string | undefined;
  let changes = 0;
  let seenIn = 0;

  const [scopeOrName, ...rest] = path.includes('/') ? path.split('/') : [undefined, ...path.split('/')];
  const wanted = rest.length > 0 && rest[0] ? rest.join('/') : scopeOrName ?? path;
  const scopeFilter = path.includes('/') ? scopeOrName : undefined;

  for (const stop of [...stops].sort((a, b) => a.index - b.index)) {
    const found = findByPath(stop, wanted, scopeFilter);
    if (!found) continue;

    seenIn++;
    counts.set(found.value, (counts.get(found.value) ?? 0) + 1);
    const changed = previous !== found.value;
    if (changed && previous !== undefined) changes++;

    // Collapse runs: a value that held steady is one point, not four hundred.
    if (changed || points.length === 0) {
      points.push({
        stopIndex: stop.index,
        at: stop.at,
        value: found.value,
        frame: found.frame,
        file: found.file,
        line: found.line,
        changed: previous !== undefined,
      });
    }
    previous = found.value;
  }

  const indices = points.map((point) => point.stopIndex);

  return {
    path,
    points,
    seenIn,
    changes,
    firstSeen: indices[0],
    lastSeen: seenIn > 0 ? Math.max(...stops.filter((stop) => findByPath(stop, wanted, scopeFilter)).map((stop) => stop.index)) : undefined,
    distinct: [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20),
  };
}

/** Finds one dotted path within a stop, in any frame. */
function findByPath(
  stop: DebugStop,
  path: string,
  scopeName?: string,
): { value: string; frame: string; file?: string; line?: number } | undefined {
  const framesById = new Map<number, { name: string; file?: string; line?: number }>();
  for (const frames of Object.values(stop.stacks)) {
    for (const frame of frames) framesById.set(frame.id, frame);
  }

  const segments = path.split('.');

  for (const [frameIdText, scopes] of Object.entries(stop.frames)) {
    const frame = framesById.get(Number(frameIdText));

    for (const scope of scopes) {
      if (scopeName && scope.name !== scopeName) continue;

      let current: DebugVariable[] | undefined = scope.variables;
      let found: DebugVariable | undefined;

      for (const segment of segments) {
        found = current?.find((variable) => variable.name === segment);
        if (!found) break;
        current = found.children;
      }

      if (found) {
        return {
          value: found.value,
          frame: frame?.name ?? `frame ${frameIdText}`,
          file: frame?.file,
          line: frame?.line,
        };
      }
    }
  }
  return undefined;
}

/** Builds a trajectory from a journal, streamed. */
export async function trajectoryFromJournal(path: string, variablePath: string): Promise<Trajectory> {
  const stops: DebugStop[] = [];
  const reader = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });

  for await (const line of reader) {
    if (!line.includes('"kind":"stop"')) continue;
    try {
      const entry = JSON.parse(line) as JournalEntry;
      if (entry.kind === 'stop') stops.push(entry.stop);
    } catch {
      // A truncated final line, which the journal format expects.
    }
  }
  reader.close();
  return trajectory(stops, variablePath);
}

/** Renders a trajectory as a compact history. */
export function renderTrajectory(history: Trajectory): string[] {
  if (history.points.length === 0) {
    return [`${history.path}: never present in any captured stop`];
  }

  const lines = [
    `${history.path} — present in ${history.seenIn} stop(s), changed ${history.changes} time(s)`,
    '',
  ];

  for (const point of history.points) {
    const where = point.file ? `${point.file}:${point.line ?? '?'}` : point.frame;
    lines.push(`  #${String(point.stopIndex).padStart(4)}  ${clip(point.value, 60).padEnd(62)} ${where}`);
  }

  if (history.distinct.length > 1) {
    lines.push('');
    lines.push(`  ${history.distinct.length} distinct value(s): ` +
      history.distinct.slice(0, 6).map((item) => `${clip(item.value, 24)}×${item.count}`).join(', '));
  }
  return lines;
}

/** Renders query matches. */
export function renderMatches(result: QueryResult): string[] {
  if (result.matches.length === 0) {
    return [
      `no match across ${result.stopsSearched} stop(s) in the ${result.source}`,
      ...(result.caveat ? [`  ${result.caveat}`] : []),
    ];
  }

  const lines = [`${result.matches.length} match(es) across ${result.stopsSearched} stop(s)`, ''];

  for (const match of result.matches) {
    lines.push(
      `  #${String(match.stopIndex).padStart(4)}  ${match.scope}/${match.path} = ${clip(match.value, 50)}`,
    );
    lines.push(`         ${match.frame} ${match.file ? `${match.file}:${match.line ?? '?'}` : ''}`);
  }

  if (result.truncated) lines.push('', '  stopped at the result limit; narrow the query or raise --limit');
  if (result.caveat) lines.push('', `  ${result.caveat}`);
  return lines;
}

function clip(value: string, width: number): string {
  const single = value.replace(/\s*\n\s*/g, ' ');
  return single.length > width ? `${single.slice(0, width - 1)}…` : single;
}
