import { hostname } from 'node:os';
import type { Adapter, CaptureOptions } from './adapter.ts';
import { DEFAULT_CAPTURE_OPTIONS, emptySnapshot, runAdapter } from './adapter.ts';
import type {
  AdapterReport, Confidence, Diagnostic, EditorInstance, OpenDocument, Snapshot, TerminalCapture, Workspace,
} from './model.ts';
import { CONFIDENCE_RANK } from './model.ts';
import { rankDiagnostics, rankDocuments } from './budget.ts';
import { Redactor } from './redact.ts';

export const SCHEMA_VERSION = '1.0';

/**
 * Assembling one snapshot from every adapter.
 *
 * The interesting problem here is not running the adapters — it is **merging their answers**, since
 * several of them describe the same reality from different vantage points and they will disagree.
 * The VS Code adapter reads a session file that says `Foo.ts` is open; the push adapter, reporting
 * from inside the same editor a second ago, says `Foo.ts` is open, is dirty, and the caret is on
 * line 42. Both are "right"; only one should survive.
 *
 * The rule is uniform and is applied everywhere: **higher confidence wins the record, and lower
 * confidence fills in fields the winner left empty.** A `live` push beats a `session` scrape for
 * the caret, but if the push omitted the file size and the disk scrape had it, the size is kept.
 * That is strictly better than either "last writer wins" or "first writer wins", and it is why
 * every record in the model carries its confidence.
 */

/** Runs adapters and merges their results into one snapshot. */
export async function capture(
  adapters: Adapter[],
  options: CaptureOptions = {},
  redactor: Redactor = new Redactor(true),
): Promise<Snapshot> {
  const merged: CaptureOptions = { ...DEFAULT_CAPTURE_OPTIONS, ...options };
  const selected = selectAdapters(adapters, merged);

  const snapshot = emptySnapshot(SCHEMA_VERSION);
  snapshot.host = {
    platform: process.platform,
    arch: process.arch,
    hostname: hostname(),
    shell: process.env.SHELL ?? process.env.ComSpec,
    home: process.env.HOME ?? process.env.USERPROFILE,
    cwd: process.cwd(),
  };

  // Adapters run concurrently: several of them shell out or walk directories, and running them in
  // sequence would make a capture take as long as the sum rather than the maximum. They share no
  // mutable state, so this is safe by construction rather than by care.
  const outcomes = await Promise.all(selected.map((adapter) => runAdapter(adapter, merged)));

  const editors: EditorInstance[] = [];
  const documents: OpenDocument[] = [];
  const diagnostics: Diagnostic[] = [];
  const terminals: TerminalCapture[] = [];
  const reports: AdapterReport[] = [];

  // Ordered by confidence so that when the merge functions below meet a duplicate, the better
  // record is already in place and the worse one is the candidate.
  const ordered = outcomes
    .map((outcome, index) => ({ ...outcome, adapter: selected[index]! }))
    .sort((a, b) => CONFIDENCE_RANK[b.adapter.confidence] - CONFIDENCE_RANK[a.adapter.confidence]);

  for (const { result, report, adapter } of ordered) {
    reports.push(report);

    for (const editor of result.editors ?? []) {
      mergeEditor(editors, { ...editor, confidence: editor.confidence ?? adapter.confidence });
    }
    for (const document of result.documents ?? []) {
      mergeDocument(documents, document, adapter.confidence);
    }
    for (const diagnostic of result.diagnostics ?? []) {
      mergeDiagnostic(diagnostics, diagnostic);
    }
    terminals.push(...(result.terminals ?? []));
    snapshot.warnings.push(...(result.warnings ?? []));
  }

  snapshot.editors = editors;
  snapshot.workspaces = mergeWorkspaces(editors);

  // Each editor keeps only a reference to its workspaces from here on; the full descriptions live
  // once, in `snapshot.workspaces`. Without this every file tree and git history is serialized
  // twice -- once per editor that has the folder open, and once in the merged list -- which on a
  // machine with two editors and nine projects was the single largest thing in a snapshot and
  // pure duplication.
  for (const editor of snapshot.editors) {
    editor.workspaces = editor.workspaces.map((workspace) => ({
      root: workspace.root,
      name: workspace.name,
    }));
  }
  snapshot.documents = rankDocuments(documents);
  snapshot.diagnostics = rankDiagnostics(diagnostics);
  snapshot.provenance = reports;
  if (terminals.length > 0) snapshot.terminals = terminals;

  const debug = editors.find((editor) => editor.debug?.active)?.debug
    ?? editors.find((editor) => editor.debug)?.debug;
  if (debug) snapshot.debug = debug;

  return finalize(snapshot, redactor);
}

/** Applies the `only` and `exclude` filters. */
function selectAdapters(adapters: Adapter[], options: CaptureOptions): Adapter[] {
  let selected = adapters;
  if (options.only?.length) {
    const wanted = new Set(options.only);
    selected = selected.filter((adapter) => wanted.has(adapter.id));
  }
  if (options.exclude?.length) {
    const unwanted = new Set(options.exclude);
    selected = selected.filter((adapter) => !unwanted.has(adapter.id));
  }
  return selected;
}

/**
 * Merges an editor into the list, combining rather than replacing when the same product appears
 * twice.
 *
 * The same editor legitimately arrives from two adapters: the VS Code disk adapter finds it, and
 * so does its own extension pushing live. Reporting it twice would make a snapshot say the user has
 * two copies of VS Code open, which is both wrong and confusing.
 */
function mergeEditor(editors: EditorInstance[], candidate: EditorInstance): void {
  const existing = editors.find((editor) =>
    editor.name === candidate.name ||
    (editor.pid !== undefined && editor.pid === candidate.pid) ||
    editor.adapter === candidate.adapter,
  );

  if (!existing) {
    editors.push(candidate);
    return;
  }
  if (CONFIDENCE_RANK[candidate.confidence] > CONFIDENCE_RANK[existing.confidence]) {
    // The candidate is better: it becomes the base and the incumbent fills its gaps.
    const index = editors.indexOf(existing);
    editors[index] = fillGaps(candidate, existing);
    return;
  }
  Object.assign(existing, fillGaps(existing, candidate));
}

/**
 * Copies fields present on `weaker` and absent on `stronger` into a combined record.
 *
 * Generic over `object` rather than over `Record<string, unknown>`: the model's interfaces have no
 * index signature, so the stricter constraint would push a cast onto every call site instead of
 * keeping the one unavoidable cast here, where the structural walk actually happens.
 */
function fillGaps<T extends object>(stronger: T, weaker: T): T {
  const combined = { ...stronger } as Record<string, unknown>;

  for (const [key, value] of Object.entries(weaker as Record<string, unknown>)) {
    const current = combined[key];

    if (current === undefined || current === null) {
      combined[key] = value;
      continue;
    }
    // Arrays are unioned by length rather than overwritten: an adapter that found six extensions
    // and one that found none should yield six, whichever had the higher confidence.
    if (Array.isArray(current) && Array.isArray(value) && current.length === 0 && value.length > 0) {
      combined[key] = value;
    }
  }
  return combined as T;
}

/**
 * Merges an open document, keyed by path.
 *
 * The gap-filling matters most here. A push knows the caret and that the buffer is dirty; a disk
 * scrape knows the file's size and modification time. Neither knows the other's, and a user asking
 * "what am I looking at" wants both.
 */
function mergeDocument(documents: OpenDocument[], candidate: OpenDocument, confidence: Confidence): void {
  const existing = documents.find((document) => document.path === candidate.path);

  if (!existing) {
    documents.push(candidate);
    return;
  }

  // Documents carry no confidence field of their own -- they inherit their adapter's -- and the
  // loop that calls this runs highest-confidence first, so an existing record is always at least as
  // trustworthy as the candidate. Fill its gaps and keep it.
  void confidence;
  const target = existing as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(candidate as unknown as Record<string, unknown>)) {
    if (target[key] === undefined && value !== undefined) target[key] = value;
  }
  // Two truthy claims that must not be lost: being open in one window and dirty in another is not
  // possible, but being reported dirty by the live source and clean by the stale one is.
  existing.dirty = existing.dirty || candidate.dirty;
  existing.active = existing.active || candidate.active;
}

/**
 * Merges a diagnostic, deduplicating identical reports.
 *
 * Necessary because the same error genuinely arrives twice: once from the LSP proxy watching the
 * language server, and once from an editor extension that got it from the same server through the
 * editor's own API. Same file, same position, same message — one problem.
 */
function mergeDiagnostic(diagnostics: Diagnostic[], candidate: Diagnostic): void {
  const duplicate = diagnostics.some((existing) =>
    existing.file === candidate.file &&
    existing.range.start.line === candidate.range.start.line &&
    existing.range.start.character === candidate.range.start.character &&
    existing.message === candidate.message,
  );
  if (!duplicate) diagnostics.push(candidate);
}

/** Collects workspaces across editors, merging by root and keeping the richest description. */
function mergeWorkspaces(editors: EditorInstance[]): Workspace[] {
  const byRoot = new Map<string, Workspace>();

  for (const editor of editors) {
    for (const workspace of editor.workspaces) {
      const existing = byRoot.get(workspace.root);
      if (!existing) {
        byRoot.set(workspace.root, workspace);
        continue;
      }
      // "Richest" means: whichever actually walked the tree. Two editors with the same folder open
      // should not produce two half-descriptions of it.
      const merged = fillGaps(existing, workspace);
      if (!existing.tree && workspace.tree) merged.tree = workspace.tree;
      if (!existing.vcs && workspace.vcs) merged.vcs = workspace.vcs;
      byRoot.set(workspace.root, merged);
    }
  }
  return [...byRoot.values()];
}

/**
 * Applies redaction and attaches the report.
 *
 * Runs last, over the assembled snapshot, rather than in each adapter. One place to audit, one
 * place that cannot be forgotten by the next adapter someone writes, and one report covering
 * everything — all three of which matter more than the small cost of walking the structure twice.
 */
export function finalize(snapshot: Snapshot, redactor: Redactor): Snapshot {
  if (!redactor.enabled) {
    snapshot.warnings.push('redaction is DISABLED; this snapshot may contain credentials');
    return snapshot;
  }

  const redacted = redactor.redactValue(snapshot);
  const report = redactor.report();
  if (report) redacted.redactions = report;
  return redacted;
}

/**
 * The default adapter set, in the order they should be tried.
 *
 * Ordering is for readability of the provenance report only — the merge sorts by confidence
 * regardless — but a reader scanning the report should see the live sources first, because those
 * are the ones whose absence explains a thin snapshot.
 */
export async function defaultAdapters(): Promise<Adapter[]> {
  const [
    { PushAdapter },
    { ProtocolAdapter },
    { VsCodeAdapter },
    { JetBrainsAdapter },
    { VisualStudioAdapter },
    { OtherEditorsAdapter, UnknownEditorAdapter, claimedExecutables },
    { GenericFilesystemAdapter },
  ] = await Promise.all([
    import('../adapters/push.ts'),
    import('../adapters/protocols.ts'),
    import('../adapters/vscode.ts'),
    import('../adapters/jetbrains.ts'),
    import('../adapters/visualstudio.ts'),
    import('../adapters/editors.ts'),
    import('../adapters/generic.ts'),
  ]);

  return [
    new PushAdapter(),
    new ProtocolAdapter(),
    new VsCodeAdapter(),
    new JetBrainsAdapter(),
    new VisualStudioAdapter(),
    new OtherEditorsAdapter(),
    new UnknownEditorAdapter(await claimedExecutables()),
    new GenericFilesystemAdapter(),
  ];
}

/** A one-line summary of a snapshot, for logs and for the CLI's status line. */
export function summarize(snapshot: Snapshot): string {
  const errors = snapshot.diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = snapshot.diagnostics.filter((d) => d.severity === 'warning').length;
  const parts = [
    `${snapshot.editors.length} editor(s)`,
    `${snapshot.workspaces.length} workspace(s)`,
    `${snapshot.documents.length} document(s)`,
  ];
  if (errors > 0) parts.push(`${errors} error(s)`);
  if (warnings > 0) parts.push(`${warnings} warning(s)`);
  if (snapshot.debug?.active) parts.push(`debug ${snapshot.debug.status}`);
  return parts.join(', ');
}
