import type { Snapshot } from '../core/model.ts';

/**
 * Terminal rendering.
 *
 * Colour is applied through a tiny helper rather than a library, and it checks for a TTY and for
 * `NO_COLOR` before emitting anything. That matters more for this tool than for most: its output is
 * routinely piped into a file or into another program, and escape codes in a captured snapshot are
 * garbage that someone has to strip later.
 */

const useColour = process.stdout.isTTY === true &&
  !process.env.NO_COLOR &&
  process.env.TERM !== 'dumb';

const CODES = {
  reset: '[0m', bold: '[1m', dim: '[2m',
  red: '[31m', green: '[32m', yellow: '[33m',
  blue: '[34m', magenta: '[35m', cyan: '[36m', grey: '[90m',
};

export type Colour = keyof typeof CODES;

export function paint(text: string, ...styles: Colour[]): string {
  if (!useColour) return text;
  return styles.map((style) => CODES[style]).join('') + text + CODES.reset;
}

export const bold = (text: string) => paint(text, 'bold');
export const dim = (text: string) => paint(text, 'dim');
export const grey = (text: string) => paint(text, 'grey');

/** Colours a severity consistently everywhere it appears. */
export function severityColour(severity: string): Colour {
  switch (severity) {
    case 'error': return 'red';
    case 'warning': return 'yellow';
    case 'hint': return 'grey';
    default: return 'blue';
  }
}

/** Colours a confidence level, so the reader can see at a glance how much to trust a line. */
export function confidenceColour(confidence: string): Colour {
  switch (confidence) {
    case 'live': return 'green';
    case 'session': return 'cyan';
    case 'persisted': return 'blue';
    default: return 'grey';
  }
}

/** Truncates to a display width, with an ellipsis, never mid-escape. */
export function truncate(text: string, width: number): string {
  if (text.length <= width) return text;
  return `${text.slice(0, Math.max(0, width - 1))}…`;
}

/**
 * Shortens a path from the left, keeping the end.
 *
 * The end is what identifies a file; the beginning is almost always a home directory the reader
 * already knows. Truncating from the right would remove the only part that answers "which file".
 */
export function shortenPath(path: string, width = 60): string {
  if (path.length <= width) return path;
  const parts = path.split(/[/\\]/);
  const tail: string[] = [];
  let length = 0;

  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]!;
    if (length + part.length + 1 > width - 2) break;
    tail.unshift(part);
    length += part.length + 1;
  }
  return `…/${tail.join('/')}`;
}

/** Right-pads to a column width. */
export function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/** Formats a byte count for humans. */
export function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The human-readable snapshot report the CLI prints.
 *
 * Deliberately ordered the same way the budget prioritizes and the Markdown renderer lays out:
 * active file, problems, projects, sources. A reader who learns the order once can find what they
 * want in any of the three outputs.
 */
export function renderSnapshot(snapshot: Snapshot, options: { verbose?: boolean } = {}): string {
  const out: string[] = [];
  const errors = snapshot.diagnostics.filter((item) => item.severity === 'error');
  const warnings = snapshot.diagnostics.filter((item) => item.severity === 'warning');

  out.push(bold('Environment'));
  out.push(`  ${snapshot.host.platform}/${snapshot.host.arch} · ${snapshot.host.hostname}`);
  out.push(`  captured ${snapshot.capturedAt}`);
  out.push('');

  out.push(bold(`Editors (${snapshot.editors.length})`));
  if (snapshot.editors.length === 0) {
    out.push(grey('  none detected'));
  }
  for (const editor of snapshot.editors) {
    const tag = paint(editor.confidence, confidenceColour(editor.confidence));
    const details = [
      editor.version && `v${editor.version}`,
      editor.pid && `pid ${editor.pid}`,
      `${editor.workspaces.length} workspace(s)`,
      `${editor.documents.length} document(s)`,
    ].filter(Boolean).join(' · ');
    out.push(`  ${pad(editor.name, 26)} ${tag}  ${grey(details)}`);
  }
  out.push('');

  const active = snapshot.documents.find((document) => document.active);
  if (active) {
    out.push(bold('Active file'));
    const cursor = active.cursor ? ` · line ${active.cursor.line + 1}` : '';
    const dirty = active.dirty ? paint(' · unsaved', 'yellow') : '';
    out.push(`  ${shortenPath(active.path, 70)}`);
    out.push(grey(`  ${active.languageId}${cursor}`) + dirty);
    out.push('');
  }

  out.push(bold(`Open documents (${snapshot.documents.length})`));
  if (snapshot.documents.length === 0) {
    out.push(grey('  none reported — no editor plugin or session file gave any'));
  }
  for (const document of snapshot.documents.slice(0, options.verbose ? 60 : 12)) {
    const marker = document.active ? paint('●', 'green') : ' ';
    const flags = document.dirty ? paint(' *', 'yellow') : '';
    out.push(`  ${marker} ${pad(shortenPath(document.path, 62), 63)} ${grey(document.languageId)}${flags}`);
  }
  if (snapshot.documents.length > (options.verbose ? 60 : 12)) {
    out.push(grey(`    …${snapshot.documents.length - (options.verbose ? 60 : 12)} more`));
  }
  out.push('');

  if (snapshot.diagnostics.length > 0) {
    out.push(bold(`Diagnostics (${errors.length} error(s), ${warnings.length} warning(s))`));
    for (const item of snapshot.diagnostics.slice(0, options.verbose ? 40 : 10)) {
      const severity = paint(pad(item.severity, 8), severityColour(item.severity));
      const location = `${shortenPath(item.file, 40)}:${item.range.start.line + 1}`;
      out.push(`  ${severity} ${pad(location, 46)} ${truncate(item.message, 60)}`);
    }
    out.push('');
  }

  out.push(bold(`Workspaces (${snapshot.workspaces.length})`));
  for (const workspace of snapshot.workspaces) {
    out.push(`  ${bold(workspace.name)}  ${grey(shortenPath(workspace.root, 50))}`);

    const facts: string[] = [];
    if (workspace.fileCount !== undefined) facts.push(`${workspace.fileCount} files`);
    if (workspace.totalBytes !== undefined) facts.push(bytes(workspace.totalBytes));
    if (workspace.manifests?.length) facts.push(workspace.manifests.map((m) => m.kind).join('+'));
    if (facts.length > 0) out.push(grey(`    ${facts.join(' · ')}`));

    if (workspace.languages) {
      const top = Object.entries(workspace.languages)
        .sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([language, count]) => `${language} ${count}`);
      if (top.length) out.push(grey(`    ${top.join('  ')}`));
    }
    if (workspace.vcs?.system === 'git') {
      const vcs = workspace.vcs;
      const parts = [paint(vcs.branch ?? '?', 'magenta')];
      if (vcs.ahead) parts.push(paint(`↑${vcs.ahead}`, 'green'));
      if (vcs.behind) parts.push(paint(`↓${vcs.behind}`, 'yellow'));
      if (vcs.operationInProgress) parts.push(paint(`[${vcs.operationInProgress}]`, 'red'));
      if (vcs.files?.length) parts.push(grey(`${vcs.files.length} changed`));
      out.push(`    ${parts.join(' ')}`);
    }
  }
  out.push('');

  out.push(bold('Sources'));
  for (const report of snapshot.provenance) {
    const status = report.status === 'ok' ? paint('ok', 'green')
      : report.status === 'error' ? paint('error', 'red')
      : report.status === 'partial' ? paint('partial', 'yellow')
      : grey('none');
    const note = report.detail ?? report.reason ?? '';
    out.push(`  ${pad(report.adapter, 16)} ${pad(status, 18)} ${grey(`${report.durationMs}ms`)}  ${grey(truncate(note, 60))}`);
  }

  if (snapshot.redactions) {
    out.push('');
    const rules = Object.entries(snapshot.redactions.byRule)
      .map(([rule, count]) => `${rule}×${count}`).join(', ');
    out.push(paint(`Redacted ${snapshot.redactions.count} secret value(s): ${rules}`, 'yellow'));
    for (const file of snapshot.redactions.skippedFiles.slice(0, 5)) {
      out.push(grey(`  skipped entirely: ${shortenPath(file, 60)}`));
    }
  }

  if (snapshot.warnings.length > 0) {
    out.push('');
    out.push(bold('Notices'));
    for (const warning of snapshot.warnings.slice(0, options.verbose ? 20 : 5)) {
      out.push(paint(`  ! ${truncate(warning, 100)}`, 'yellow'));
    }
  }

  return out.join('\n');
}
