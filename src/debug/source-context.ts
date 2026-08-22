import type { DebugStackFrame, DebugStop } from '../core/debug-model.ts';
import type { Redactor } from '../core/redact.ts';
import { readTextFile } from '../platform/files.ts';

/**
 * The source code around each stack frame.
 *
 * A stack trace names a file and a line. That is enough for a human with the project open in front
 * of them and close to useless for anything else — an assistant told the program is at
 * `router.py:17` cannot see what is on line 17, and will either guess or ask. Attaching the actual
 * lines turns "where it is" into "what it is doing", and it is the single highest-value enrichment
 * in the whole debug capture for the amount of code it takes.
 *
 * Three design decisions worth stating:
 *
 * **Read from disk, not from the debugger.** DAP has a `source` request for content the adapter
 * holds in memory, but for ordinary files the disk copy is what the developer is editing and what
 * their assistant will be asked to change. When they differ — a stale build, an unsaved buffer —
 * that difference is itself worth knowing, and the reader marks it rather than papering over it.
 *
 * **Cached per capture, not globally.** The same file appears in many frames of a recursive stack,
 * so a cache is necessary; a *persistent* cache would serve stale lines after an edit, which in a
 * debugging context is actively misleading. The cache lives as long as one enrichment pass.
 *
 * **Redacted like everything else.** Source lines can contain a hard-coded credential. There is no
 * exemption for "it is only a few lines of context".
 */

export interface SourceLine {
  number: number;
  text: string;
  /** True for the line the frame is actually stopped on. */
  current?: boolean;
}

export interface FrameSource {
  file: string;
  /** The lines around the frame, in order. */
  lines: SourceLine[];
  /** Why there is no source, when there is none. */
  unavailable?: string;
}

export interface SourceContextOptions {
  /** Lines before and after the frame's own line. */
  radius?: number;
  /** How many frames to enrich, from the top down. */
  maxFrames?: number;
  /** Largest file to read. */
  maxBytes?: number;
  redactor?: Redactor;
}

const DEFAULTS = { radius: 6, maxFrames: 8, maxBytes: 2 * 1024 * 1024 };

/**
 * Reads the source around one frame.
 *
 * Every failure mode produces an `unavailable` reason rather than an absence: a frame with no path,
 * a file that no longer exists, a file too large to read, and a line number past the end of the
 * file are four genuinely different situations, and the last one in particular is diagnostic — it
 * means the debugger's line numbers do not match the file on disk, which is usually a stale build
 * and is exactly the kind of thing a developer needs told.
 */
export async function readFrameSource(
  frame: DebugStackFrame,
  options: SourceContextOptions = {},
  cache?: Map<string, string[] | null>,
): Promise<FrameSource | undefined> {
  const { radius, maxBytes } = { ...DEFAULTS, ...options };

  if (!frame.file) {
    return {
      file: frame.sourceName ?? '<no source>',
      lines: [],
      unavailable: frame.sourceName
        ? 'the debugger holds this source in memory rather than on disk'
        : 'this frame has no source location — it is inside a runtime or generated code',
    };
  }
  if (frame.line === undefined) {
    return { file: frame.file, lines: [], unavailable: 'the frame has no line number' };
  }

  let lines = cache?.get(frame.file);

  if (lines === undefined) {
    const text = await readTextFile(frame.file, maxBytes);
    lines = text === undefined ? null : text.split(/\r?\n/);
    cache?.set(frame.file, lines);
  }

  if (lines === null) {
    return {
      file: frame.file,
      lines: [],
      unavailable: 'the file is not readable — it may have moved, or be inside a package archive',
    };
  }

  if (frame.line > lines.length) {
    return {
      file: frame.file,
      lines: [],
      // Worth saying loudly. A line number past the end of the file means the running code is not
      // the code on disk, and every conclusion drawn from reading that file will be wrong.
      unavailable:
        `the debugger reports line ${frame.line} but the file has only ${lines.length} — the ` +
        'running code does not match the file on disk (a stale build, or a source map pointing ' +
        'at the wrong file)',
    };
  }

  const first = Math.max(1, frame.line - radius);
  const last = Math.min(lines.length, frame.line + radius);
  const window: SourceLine[] = [];

  for (let number = first; number <= last; number++) {
    const text = lines[number - 1] ?? '';
    window.push({
      number,
      text: options.redactor ? options.redactor.redact(text) : text,
      current: number === frame.line ? true : undefined,
    });
  }

  return { file: frame.file, lines: window };
}

/**
 * Enriches a whole stop, returning source keyed by frame id.
 *
 * Only the stopped thread's frames, and only the top few: a fifty-frame stack with thirteen lines
 * of source each is six hundred lines of text, most of it framework code nobody asked about. The
 * cap is what keeps this enrichment worth its size.
 */
export async function readStopSource(
  stop: DebugStop,
  options: SourceContextOptions = {},
): Promise<Record<number, FrameSource>> {
  const { maxFrames } = { ...DEFAULTS, ...options };
  const cache = new Map<string, string[] | null>();
  const sources: Record<number, FrameSource> = {};

  const threadId = stop.threadId ?? Number(Object.keys(stop.stacks)[0]);
  const frames = stop.stacks[threadId] ?? [];

  for (const frame of frames.slice(0, maxFrames)) {
    const source = await readFrameSource(frame, options, cache);
    if (source) sources[frame.id] = source;
  }
  return sources;
}

/**
 * Renders a source window the way a terminal or a prompt wants it.
 *
 * The marker on the current line is `>`, and the line numbers are right-aligned to a common width,
 * because a model reading this has to be able to say "line 42" and be right. An unaligned gutter
 * makes that harder for exactly the same reason it does for a person.
 */
export function renderSource(source: FrameSource, indent = ''): string[] {
  if (source.unavailable) return [`${indent}${source.file}: ${source.unavailable}`];

  const width = String(source.lines[source.lines.length - 1]?.number ?? 0).length;

  return source.lines.map((line) =>
    `${indent}${line.current ? '>' : ' '} ${String(line.number).padStart(width)} │ ${line.text}`);
}

/**
 * The single line a frame is stopped on, trimmed.
 *
 * Used where a full window is too much — a one-line summary of every frame in a stack, which is
 * often all that is needed to see where a program went wrong.
 */
export function currentLine(source: FrameSource | undefined): string | undefined {
  return source?.lines.find((line) => line.current)?.text.trim();
}
