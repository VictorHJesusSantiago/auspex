import { readFile, writeFile } from 'node:fs/promises';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { DebugSessionRecord, DebugStop } from '../core/debug-model.ts';
import type { Redactor } from '../core/redact.ts';
import { analyseSession, type AnalysisResult } from './analysis.ts';
import { readStopSource, type FrameSource } from './source-context.ts';
import { SCHEMA_VERSION } from '../core/snapshot.ts';

/**
 * A debug session as a single portable file.
 *
 * ## What this is for
 *
 * "It crashes on my machine" is the oldest problem in software, and the reason it survives is that
 * what one developer can see — the stack, the variables, the exact line, the values that led to it
 * — is exactly what does not travel. What travels is a screenshot of a stack trace and a
 * paragraph of prose, and the person receiving it has to reconstruct the rest by asking questions
 * over hours.
 *
 * A bundle is that state, whole, in a file you can attach to an issue. The recipient does not need
 * the program, the debugger, the dependencies, the data that triggered it, or the machine. They do
 * not even need Auspex: the bundle carries a rendered summary alongside the structured record, so
 * it is readable with `less`.
 *
 * ## Why source is embedded
 *
 * This is the decision that makes a bundle worth more than a JSON dump, and it is worth being
 * explicit about the trade. A stack trace pointing at `handler.py:42` is meaningless to someone
 * who does not have that file at that revision — and "that revision" is doing a lot of work,
 * because the recipient's checkout is a different commit almost by definition. Embedding the
 * captured window of source means the frames stay readable forever, on any machine, at any later
 * date.
 *
 * The cost is real and is stated plainly at the top of every bundle: **a bundle contains source
 * code and program state.** It is redacted with the same rules as everything else, but redaction
 * is a filter for known secret shapes, not a guarantee of safety, and a bundle from a production
 * debugging session may contain customer data no pattern would catch. That is a decision for the
 * person sharing it, so `bundle` never uploads anything and never shares anything — it writes a
 * file, and what happens to that file is entirely the user's call.
 */

export const BUNDLE_VERSION = '1';

export interface DebugBundle {
  /** Format version, so a future reader knows what it is holding. */
  bundleVersion: string;
  /** The Auspex schema the record was captured with. */
  schemaVersion: string;
  createdAt: string;
  /** Free-text note from whoever made it — what they were doing, what went wrong. */
  note?: string;
  /** Where it was captured, for reproducing. */
  environment: {
    platform: string;
    nodeVersion: string;
    /** The adapter and how the program was started. */
    adapterType?: string;
    startMethod?: string;
  };
  record: DebugSessionRecord;
  /** Source windows, by frame id, for the current stop. */
  sources: Record<number, FrameSource>;
  /** The analysis as it stood when the bundle was made. */
  analysis: AnalysisResult;
  /** A rendered summary, so the file is readable without any tooling. */
  summary: string;
  /** Always present, always the same words. */
  warning: string;
}

const SHARING_WARNING =
  'This bundle contains source code and the state of a running program: variable values, ' +
  'program output, and file paths. Secret redaction has been applied, but redaction matches known ' +
  'secret shapes and cannot catch application data — customer records, request bodies, or ' +
  'identifiers that look like ordinary values. Read it before sharing it.';

export interface BundleOptions {
  note?: string;
  redactor?: Redactor;
  /** Include the wire timeline. Off by default: it is large and rarely what a recipient needs. */
  includeTimeline?: boolean;
  /** Include memory dumps. */
  includeMemory?: boolean;
  /** How much source to embed around each frame. */
  sourceRadius?: number;
}

/** Builds a bundle from a session record. */
export async function createBundle(
  record: DebugSessionRecord,
  options: BundleOptions = {},
): Promise<DebugBundle> {
  const trimmed: DebugSessionRecord = {
    ...record,
    timeline: options.includeTimeline ? record.timeline : [],
    currentStop: record.currentStop
      ? {
        ...record.currentStop,
        memory: options.includeMemory ? record.currentStop.memory : undefined,
      }
      : undefined,
  };

  const sources = record.currentStop
    ? await readStopSource(record.currentStop, {
      radius: options.sourceRadius ?? 10,
      maxFrames: 12,
      redactor: options.redactor,
    })
    : {};

  const analysis = analyseSession(trimmed, { sources });

  const bundle: DebugBundle = {
    bundleVersion: BUNDLE_VERSION,
    schemaVersion: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    note: options.note,
    environment: {
      platform: `${process.platform} ${process.arch}`,
      nodeVersion: process.version,
      adapterType: record.adapterType,
      startMethod: record.startMethod,
    },
    record: trimmed,
    sources,
    analysis,
    summary: renderBundleSummary(trimmed, sources, analysis, options.note),
    warning: SHARING_WARNING,
  };

  // Redacted last, over the whole assembled structure including the rendered summary. Redacting
  // the record first and rendering afterwards would leave secrets in the prose.
  return options.redactor ? options.redactor.redactValue(bundle) : bundle;
}

/**
 * Writes a bundle to disk, gzipped when the name says so.
 *
 * Gzip because a real session bundle is mostly repeated JSON keys and source text, which compresses
 * about eight to one — the difference between a file that attaches to an issue tracker and one that
 * does not.
 */
export async function writeBundle(path: string, bundle: DebugBundle): Promise<number> {
  const json = JSON.stringify(bundle, null, 2);
  const payload = path.endsWith('.gz') ? gzipSync(Buffer.from(json, 'utf8')) : Buffer.from(json, 'utf8');

  await writeFile(path, payload);
  return payload.length;
}

/** Reads a bundle, gzipped or not, detected by content rather than by name. */
export async function readBundle(path: string): Promise<DebugBundle> {
  const raw = await readFile(path);

  // The gzip magic number, because a bundle renamed without its extension should still open.
  const text = raw[0] === 0x1f && raw[1] === 0x8b
    ? gunzipSync(raw).toString('utf8')
    : raw.toString('utf8');

  const bundle = JSON.parse(text) as DebugBundle;

  if (!bundle.bundleVersion) {
    throw new Error('this file is not an Auspex debug bundle');
  }
  if (bundle.bundleVersion !== BUNDLE_VERSION) {
    // Read anyway rather than refusing: the shape is additive, and a recipient with a slightly
    // different version should still get the stack and the values rather than an error.
    bundle.record.warnings = [
      ...(bundle.record.warnings ?? []),
      `this bundle was written in format ${bundle.bundleVersion}; this build reads ${BUNDLE_VERSION}, ` +
      'so some fields may be missing',
    ];
  }
  return bundle;
}

/**
 * The rendered summary embedded in every bundle.
 *
 * Deliberately plain text with no colour and no dependency on anything, because its whole purpose
 * is being readable by someone who has the file and nothing else.
 */
export function renderBundleSummary(
  record: DebugSessionRecord,
  sources: Record<number, FrameSource>,
  analysis: AnalysisResult,
  note?: string,
): string {
  const lines: string[] = [
    '='.repeat(78),
    'AUSPEX DEBUG BUNDLE',
    '='.repeat(78),
    '',
  ];

  if (note) {
    lines.push(`Note: ${note}`, '');
  }

  lines.push(analysis.headline, '');

  const stop = record.currentStop;
  if (!stop) {
    lines.push(`The session was ${record.status} with no captured stop.`);
    return lines.join('\n');
  }

  if (analysis.findings.length > 0) {
    lines.push('-'.repeat(78), 'OBSERVATIONS (facts with evidence, not diagnoses)', '-'.repeat(78), '');
    for (const finding of analysis.findings.slice(0, 8)) {
      lines.push(`[${finding.severity.toUpperCase()}] ${finding.summary}`);
      for (const evidence of finding.evidence.slice(0, 3)) {
        for (const line of evidence.split('\n').slice(0, 6)) lines.push(`    ${line}`);
      }
      if (finding.nextStep) lines.push(`    -> ${finding.nextStep}`);
      lines.push('');
    }
  }

  lines.push('-'.repeat(78), 'STACK', '-'.repeat(78), '');
  const threadId = stop.threadId ?? Number(Object.keys(stop.stacks)[0]);
  const frames = stop.stacks[threadId] ?? [];
  const userFrames = new Set(analysis.userFrames.map((frame) => frame.id));

  for (const [index, frame] of frames.entries()) {
    const marker = userFrames.has(frame.id) ? '>' : ' ';
    lines.push(`${marker} #${String(index).padEnd(3)} ${frame.name}`);
    lines.push(`       ${frame.file ?? frame.sourceName ?? '<no source>'}:${frame.line ?? '?'}`);
  }
  lines.push('');

  const focus = analysis.userFrames[0] ?? frames[0];
  const source = focus ? sources[focus.id] : undefined;

  if (source && source.lines.length > 0) {
    lines.push('-'.repeat(78), `SOURCE — ${focus!.name}`, '-'.repeat(78), '');
    const width = String(source.lines.at(-1)?.number ?? 0).length;
    for (const line of source.lines) {
      lines.push(`${line.current ? '>' : ' '} ${String(line.number).padStart(width)} | ${line.text}`);
    }
    lines.push('');
  }

  if (focus) {
    lines.push('-'.repeat(78), `VALUES — ${focus.name}`, '-'.repeat(78), '');
    for (const scope of stop.frames[focus.id] ?? []) {
      lines.push(`[${scope.name}]${scope.skipped ? ` not captured: ${scope.skipped}` : ''}`);
      for (const variable of scope.variables.slice(0, 40)) {
        lines.push(`  ${variable.name}${variable.type ? `: ${variable.type}` : ''} = ${clip(variable.value, 90)}`);
        for (const child of variable.children?.slice(0, 10) ?? []) {
          lines.push(`    ${child.name} = ${clip(child.value, 80)}`);
        }
      }
      lines.push('');
    }
  }

  if (record.output.length > 0) {
    lines.push('-'.repeat(78), 'PROGRAM OUTPUT', '-'.repeat(78), '');
    for (const line of record.output.slice(-40)) {
      lines.push(line.category === 'stdout' ? line.text : `[${line.category}] ${line.text}`);
    }
    lines.push('');
  }

  lines.push('-'.repeat(78), 'CAPTURE', '-'.repeat(78), '');
  lines.push(`adapter:  ${record.adapterType ?? 'unknown'} (${record.startMethod ?? 'unknown'})`);
  lines.push(`stops:    ${record.totals.stops}`);
  lines.push(`probes:   ${record.totals.probes}`);
  if (stop.incomplete?.length) {
    lines.push('incomplete:');
    for (const note of stop.incomplete) lines.push(`  - ${note}`);
  }
  if (record.warnings.length > 0) {
    lines.push('warnings:');
    for (const warning of record.warnings) lines.push(`  - ${warning}`);
  }
  lines.push('');
  lines.push('Captured read-only: nothing in the program was modified.');
  lines.push('');
  lines.push('-'.repeat(78));
  lines.push(SHARING_WARNING);
  lines.push('-'.repeat(78));

  return lines.join('\n');
}

/**
 * Compares two bundles.
 *
 * The reason this exists: the single most common thing anyone does with two captures of the same
 * bug is ask what is different between the run that worked and the run that did not. Doing that by
 * eye across two stack traces is exactly the sort of careful, boring comparison that goes wrong.
 */
export function compareBundles(a: DebugBundle, b: DebugBundle): {
  sameLocation: boolean;
  stackDifferences: string[];
  valueDifferences: Array<{ path: string; a?: string; b?: string }>;
  summary: string;
} {
  const stopA = a.record.currentStop;
  const stopB = b.record.currentStop;

  if (!stopA || !stopB) {
    return {
      sameLocation: false,
      stackDifferences: [],
      valueDifferences: [],
      summary: 'one of the bundles has no captured stop, so there is nothing to compare',
    };
  }

  const framesA = topFrames(stopA);
  const framesB = topFrames(stopB);
  const sameLocation = framesA[0]?.file === framesB[0]?.file && framesA[0]?.line === framesB[0]?.line;

  const namesA = framesA.map((frame) => frame.name);
  const namesB = framesB.map((frame) => frame.name);
  const stackDifferences = [
    ...namesA.filter((name) => !namesB.includes(name)).map((name) => `only in A: ${name}`),
    ...namesB.filter((name) => !namesA.includes(name)).map((name) => `only in B: ${name}`),
  ];

  const valuesA = flatten(stopA);
  const valuesB = flatten(stopB);
  const valueDifferences: Array<{ path: string; a?: string; b?: string }> = [];

  for (const [path, value] of valuesA) {
    if (valuesB.get(path) !== value) valueDifferences.push({ path, a: value, b: valuesB.get(path) });
  }
  for (const [path, value] of valuesB) {
    if (!valuesA.has(path)) valueDifferences.push({ path, b: value });
  }

  return {
    sameLocation,
    stackDifferences,
    valueDifferences: valueDifferences.slice(0, 200),
    summary: sameLocation
      ? `Both stopped at the same place (${framesA[0]?.file}:${framesA[0]?.line}); ` +
        `${valueDifferences.length} value(s) differ.`
      : `Different locations: A at ${framesA[0]?.file}:${framesA[0]?.line}, ` +
        `B at ${framesB[0]?.file}:${framesB[0]?.line}.`,
  };
}

function topFrames(stop: DebugStop) {
  const threadId = stop.threadId ?? Number(Object.keys(stop.stacks)[0]);
  return stop.stacks[threadId] ?? [];
}

function flatten(stop: DebugStop): Map<string, string> {
  const flat = new Map<string, string>();
  const frames = Object.values(stop.frames)[0] ?? [];

  const walk = (scopeName: string, prefix: string, variables: typeof frames[number]['variables']) => {
    for (const variable of variables) {
      const path = prefix ? `${prefix}.${variable.name}` : variable.name;
      flat.set(`${scopeName}/${path}`, variable.value);
      if (variable.children) walk(scopeName, path, variable.children);
    }
  };
  for (const scope of frames) walk(scope.name, '', scope.variables);

  return flat;
}

function clip(value: string, width: number): string {
  const single = value.replace(/\s*\n\s*/g, ' ');
  return single.length > width ? `${single.slice(0, width - 1)}…` : single;
}
