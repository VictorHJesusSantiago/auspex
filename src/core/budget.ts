import type { Diagnostic, OpenDocument, Snapshot, Workspace } from './model.ts';

/**
 * Fitting a snapshot into an AI's context window.
 *
 * A full capture of a working developer machine is easily hundreds of kilobytes: file trees, git
 * diffs, open buffers, diagnostics. Every model has a hard limit, and the naive responses to that
 * are both bad — truncating the serialized JSON produces something unparseable, and dropping
 * whatever happens to be last produces something arbitrary.
 *
 * So this module does the only defensible thing: **a documented priority order, applied
 * deterministically**. What survives a squeeze is decided by what an assistant actually needs to
 * answer a question about the code in front of someone, and the order is stated here rather than
 * being an emergent property of the serializer:
 *
 * 1. The active document and where the caret is in it. Everything else is context for this.
 * 2. Errors, then warnings. A red squiggle is almost always why the user is asking.
 * 3. Version-control state. Branch and in-progress operations change what advice is safe.
 * 4. The other open documents, most recently active first.
 * 5. Project manifests — how the thing is built.
 * 6. The file tree, progressively shallower.
 * 7. Diffs and file contents, which are the largest and the most droppable.
 *
 * Whatever is dropped is *reported*, in `warnings`, so the consumer knows it is looking at a
 * reduced picture. A silently trimmed snapshot is worse than a small one.
 */

/** How many characters roughly make a token, per family. */
const CHARS_PER_TOKEN = 4;

/**
 * Estimates a token count from a serialized payload.
 *
 * Four characters per token is the well-known rule of thumb for English prose and it is roughly
 * right for code too, though code with long identifiers runs denser and minified JSON runs
 * sparser. It is an estimate, it is labelled one everywhere it appears, and the alternative —
 * shipping a real tokenizer per provider — would be a large dependency for a number that only has
 * to be good enough to decide what to drop.
 */
export function estimateTokens(value: unknown): number {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export interface BudgetOptions {
  /** Target size in tokens. */
  maxTokens: number;
  /** Keep full text of the active document even when it is large. */
  preserveActiveDocument?: boolean;
  /** Maximum diagnostics to keep. */
  maxDiagnostics?: number;
  /** Maximum documents to keep. */
  maxDocuments?: number;
}

export interface BudgetResult {
  snapshot: Snapshot;
  /** What the estimate says the result costs. */
  estimatedTokens: number;
  /** Human-readable list of what was dropped, in the order it was dropped. */
  dropped: string[];
}

/**
 * Reduces a snapshot until it fits, following the documented priority order.
 *
 * Works on a structural copy: the caller's snapshot is never mutated, because the same capture is
 * routinely served to several consumers with different budgets, and a destructive fit would make
 * the second one depend on the first.
 */
export function fitToBudget(snapshot: Snapshot, options: BudgetOptions): BudgetResult {
  const budget = structuredClone(snapshot);
  const dropped: string[] = [];
  const { maxTokens } = options;

  const fits = () => estimateTokens(budget) <= maxTokens;
  if (fits()) return { snapshot: budget, estimatedTokens: estimateTokens(budget), dropped };

  // -- Step 1: the biggest, least essential things first.
  for (const workspace of budget.workspaces) {
    if (workspace.vcs?.diff) {
      delete workspace.vcs.diff;
      dropped.push(`diff for ${workspace.name}`);
    }
  }
  if (fits()) return finish(budget, dropped, maxTokens);

  // -- Step 2: text of inactive documents. The active one is kept if asked.
  const preserveActive = options.preserveActiveDocument ?? true;
  for (const document of budget.documents) {
    if (document.text && !(preserveActive && document.active)) {
      delete document.text;
      dropped.push(`contents of ${document.path}`);
    }
  }
  if (fits()) return finish(budget, dropped, maxTokens);

  // -- Step 3: file trees, progressively shallower rather than all at once. A three-level tree is
  // far more useful than no tree, so depth is surrendered one level at a time.
  for (let depth = 4; depth >= 1; depth--) {
    let trimmed = false;
    for (const workspace of budget.workspaces) {
      if (workspace.tree && truncateTree(workspace.tree, depth)) trimmed = true;
    }
    if (trimmed) dropped.push(`file tree beyond depth ${depth}`);
    if (fits()) return finish(budget, dropped, maxTokens);
  }

  // -- Step 4: symbol outlines.
  if (budget.symbols && Object.keys(budget.symbols).length > 0) {
    const count = Object.keys(budget.symbols).length;
    delete budget.symbols;
    dropped.push(`${count} file outline(s)`);
  }
  if (fits()) return finish(budget, dropped, maxTokens);

  // -- Step 5: terminals and commit history, which are context rather than subject.
  if (budget.terminals?.length) {
    dropped.push(`${budget.terminals.length} terminal capture(s)`);
    delete budget.terminals;
  }
  for (const workspace of budget.workspaces) {
    if (workspace.vcs?.recentCommits?.length) {
      delete workspace.vcs.recentCommits;
      dropped.push(`commit history for ${workspace.name}`);
    }
  }
  if (fits()) return finish(budget, dropped, maxTokens);

  // -- Step 6: lower-severity diagnostics, worst kept last.
  const severityOrder = ['hint', 'information', 'warning'] as const;
  for (const severity of severityOrder) {
    const before = budget.diagnostics.length;
    budget.diagnostics = budget.diagnostics.filter((d) => d.severity !== severity);
    if (budget.diagnostics.length < before) {
      dropped.push(`${before - budget.diagnostics.length} ${severity} diagnostic(s)`);
    }
    if (fits()) return finish(budget, dropped, maxTokens);
  }

  // -- Step 7: trim the document list, keeping the active one and the most recent.
  const maxDocuments = options.maxDocuments ?? 10;
  if (budget.documents.length > maxDocuments) {
    const kept = budget.documents.slice(0, maxDocuments);
    if (!kept.some((d) => d.active)) {
      const active = budget.documents.find((d) => d.active);
      if (active) kept[kept.length - 1] = active;
    }
    dropped.push(`${budget.documents.length - kept.length} open document(s)`);
    budget.documents = kept;
  }
  if (fits()) return finish(budget, dropped, maxTokens);

  // -- Step 8: file trees entirely.
  for (const workspace of budget.workspaces) {
    if (workspace.tree) {
      delete workspace.tree;
      dropped.push(`file tree for ${workspace.name}`);
    }
  }
  if (fits()) return finish(budget, dropped, maxTokens);

  // -- Step 9: cap errors. Beyond a few dozen, the rest are almost always cascades of the first.
  const maxDiagnostics = options.maxDiagnostics ?? 50;
  if (budget.diagnostics.length > maxDiagnostics) {
    dropped.push(`${budget.diagnostics.length - maxDiagnostics} further diagnostic(s)`);
    budget.diagnostics = budget.diagnostics.slice(0, maxDiagnostics);
  }
  if (fits()) return finish(budget, dropped, maxTokens);

  // -- Step 10: workspaces the user has nothing open in. Someone with nine projects in their
  // recent list is working in one or two of them, and the rest are context nobody asked for. The
  // ones holding an open document are kept whatever happens.
  if (budget.workspaces.length > 1) {
    const inUse = new Set<string>();
    for (const document of budget.documents) {
      for (const workspace of budget.workspaces) {
        if (document.path.startsWith(workspace.root)) inUse.add(workspace.root);
      }
    }
    const kept = budget.workspaces.filter((workspace) => inUse.has(workspace.root));
    if (kept.length > 0 && kept.length < budget.workspaces.length) {
      dropped.push(`${budget.workspaces.length - kept.length} workspace(s) with nothing open`);
      budget.workspaces = kept;
    }
  }
  if (fits()) return finish(budget, dropped, maxTokens);

  // -- Step 11: manifests, which describe how a project builds. Useful, but not as useful as
  // knowing which file is on screen.
  for (const workspace of budget.workspaces) {
    if (workspace.manifests?.length) {
      dropped.push(`${workspace.manifests.length} manifest(s) for ${workspace.name}`);
      delete workspace.manifests;
    }
  }
  if (fits()) return finish(budget, dropped, maxTokens);

  // -- Step 12: the active document's own text, which by now is the last large thing left. Losing
  // it is a real degradation, so it goes last and is reported prominently.
  for (const document of budget.documents) {
    if (document.text) {
      delete document.text;
      dropped.push(`contents of the active document ${document.path}`);
    }
  }

  return finish(budget, dropped, maxTokens);
}

function finish(snapshot: Snapshot, dropped: string[], maxTokens?: number): BudgetResult {
  const estimatedTokens = estimateTokens(snapshot);

  if (dropped.length > 0) {
    snapshot.warnings = [
      ...snapshot.warnings,
      `reduced to fit a context budget; dropped: ${dropped.join('; ')}`,
    ];
  }
  // Saying so when the floor is still above the budget, rather than returning something oversized
  // and letting the caller discover it. There is an irreducible core -- which editors are open,
  // which documents, what each adapter reported -- and a budget below it cannot be met by dropping
  // more; it can only be met by asking a narrower question.
  if (maxTokens !== undefined && estimatedTokens > maxTokens) {
    snapshot.warnings = [
      ...snapshot.warnings,
      `still ${estimatedTokens} tokens against a ${maxTokens} budget: this is the irreducible core. ` +
      'Narrow the request (a single workspace via `root`, or the get_open_files tool) rather than lowering the budget.',
    ];
  }
  return { snapshot, estimatedTokens, dropped };
}

/** Cuts a file tree off at a depth, marking where it was cut. Returns whether anything changed. */
function truncateTree(node: NonNullable<Workspace['tree']>, maxDepth: number, depth = 0): boolean {
  if (!node.children) return false;
  if (depth >= maxDepth) {
    if (node.children.length === 0) return false;
    delete node.children;
    node.truncated = true;
    return true;
  }
  let changed = false;
  for (const child of node.children) {
    if (truncateTree(child, maxDepth, depth + 1)) changed = true;
  }
  return changed;
}

/**
 * Ranks documents for the priority order: the active one, then dirty ones, then the rest.
 *
 * Dirty ahead of clean because an unsaved buffer is by definition where the user has been working,
 * and its on-disk copy is not what they are looking at.
 */
export function rankDocuments(documents: OpenDocument[]): OpenDocument[] {
  return [...documents].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    if (a.dirty !== b.dirty) return a.dirty ? -1 : 1;
    return a.path.localeCompare(b.path);
  });
}

/** Ranks diagnostics: errors first, then by file, then by line. */
export function rankDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  const weight = { error: 0, warning: 1, information: 2, hint: 3 };
  return [...diagnostics].sort((a, b) => {
    const bySeverity = weight[a.severity] - weight[b.severity];
    if (bySeverity !== 0) return bySeverity;
    const byFile = a.file.localeCompare(b.file);
    if (byFile !== 0) return byFile;
    return a.range.start.line - b.range.start.line;
  });
}
