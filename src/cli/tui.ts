import { emitKeypressEvents } from 'node:readline';
import type { Snapshot } from '../core/model.ts';
import { capture, defaultAdapters, summarize } from '../core/snapshot.ts';
import { readSession } from '../core/debug-store.ts';
import type { DebugSessionRecord } from '../core/debug-model.ts';
import { renderDebugSession } from './debug-format.ts';
import type { Adapter, CaptureOptions } from '../core/adapter.ts';
import { Redactor } from '../core/redact.ts';
import { bold, dim, grey, paint, pad, shortenPath, truncate, severityColour, confidenceColour } from './format.ts';

/**
 * The live terminal interface.
 *
 * **Hand-rolled rather than built on a TUI framework**, which is consistent with the project having
 * no dependencies and is genuinely the right size of solution here: the interface is a periodically
 * redrawn full-screen view with tab switching and a few keys. That is a few hundred lines of
 * escape sequences, against a dependency that would bring a widget toolkit and a layout engine to
 * draw six lists.
 *
 * Two details that make the difference between this feeling solid and feeling like a script:
 *
 * - **The alternate screen buffer.** Entering it means the user's scrollback is untouched, and
 *   leaving it restores their terminal exactly as it was. A tool that scribbles over someone's
 *   session and leaves it scrolled is a tool they stop running.
 * - **Redrawing the whole frame at once**, built into a string and written in one call. Drawing
 *   line by line produces visible tearing, because the terminal renders whatever has arrived
 *   whenever it feels like it.
 */

const ALTERNATE_SCREEN_ON = '[?1049h';
const ALTERNATE_SCREEN_OFF = '[?1049l';
const HIDE_CURSOR = '[?25l';
const SHOW_CURSOR = '[?25h';
const CLEAR_AND_HOME = '[2J[H';

type Tab = 'overview' | 'documents' | 'diagnostics' | 'debug' | 'workspaces' | 'sources';
const TABS: Tab[] = ['overview', 'documents', 'diagnostics', 'debug', 'workspaces', 'sources'];

export interface TuiOptions {
  adapters?: Adapter[];
  captureOptions?: CaptureOptions;
  redact?: boolean;
  /** Seconds between refreshes. */
  interval?: number;
}

/** Runs the interface until the user quits. Resolves when the screen has been restored. */
export async function runTui(options: TuiOptions = {}): Promise<void> {
  const adapters = options.adapters ?? await defaultAdapters();
  const intervalMs = Math.max(1000, (options.interval ?? 5) * 1000);

  let snapshot: Snapshot | undefined;
  let debug: DebugSessionRecord | undefined;
  let tab: Tab = 'overview';
  let scroll = 0;
  let busy = false;
  let lastError: string | undefined;
  let running = true;

  const refresh = async () => {
    if (busy) return;
    busy = true;
    try {
      snapshot = await capture(adapters, options.captureOptions ?? {}, new Redactor(options.redact !== false));
      // Cheap: one small file read, and it is already redacted by whoever published it. Worth
      // doing on every refresh so the debug tab is as live as the rest of the interface.
      debug = await readSession().catch(() => undefined);
      lastError = undefined;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
      draw();
    }
  };

  const draw = () => {
    if (!running) return;
    const width = process.stdout.columns ?? 100;
    const height = process.stdout.rows ?? 30;
    // One write, one frame. See this module's own docs on tearing.
    process.stdout.write(CLEAR_AND_HOME + renderFrame({ snapshot, debug, tab, scroll, busy, lastError, width, height }));
  };

  // -- Terminal setup. Everything here is undone in `restore`, whatever happens.
  process.stdout.write(ALTERNATE_SCREEN_ON + HIDE_CURSOR);
  emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();

  const restore = () => {
    running = false;
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write(SHOW_CURSOR + ALTERNATE_SCREEN_OFF);
  };

  const timer = setInterval(refresh, intervalMs);

  await new Promise<void>((resolve) => {
    const finish = () => {
      clearInterval(timer);
      process.stdout.off('resize', draw);
      restore();
      resolve();
    };

    process.stdin.on('keypress', (_char: string, key: { name?: string; ctrl?: boolean; shift?: boolean }) => {
      if (!key) return;

      if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
        finish();
        return;
      }
      if (key.name === 'r') {
        void refresh();
        return;
      }
      if (key.name === 'tab' || key.name === 'right') {
        tab = TABS[(TABS.indexOf(tab) + 1) % TABS.length]!;
        scroll = 0;
      } else if (key.name === 'left') {
        tab = TABS[(TABS.indexOf(tab) - 1 + TABS.length) % TABS.length]!;
        scroll = 0;
      } else if (key.name === 'down' || key.name === 'j') {
        scroll += 1;
      } else if (key.name === 'up' || key.name === 'k') {
        scroll = Math.max(0, scroll - 1);
      } else if (key.name === 'pagedown') {
        scroll += 10;
      } else if (key.name === 'pageup') {
        scroll = Math.max(0, scroll - 10);
      } else if (/^[1-5]$/.test(key.name ?? '')) {
        tab = TABS[Number(key.name) - 1]!;
        scroll = 0;
      } else {
        return;
      }
      draw();
    });

    process.stdout.on('resize', draw);
    draw();
    void refresh();
  });
}

interface FrameState {
  snapshot: Snapshot | undefined;
  /** The deep debug session, when a `--deep` proxy has published one. */
  debug?: DebugSessionRecord | undefined;
  tab: Tab;
  scroll: number;
  busy: boolean;
  lastError: string | undefined;
  width: number;
  height: number;
}

/** Builds one complete frame. Pure: given the same state it produces the same string. */
export function renderFrame(state: FrameState): string {
  const { snapshot, tab, width, height } = state;
  const lines: string[] = [];

  // -- Header
  const title = bold(' AUSPEX ');
  const status = state.busy ? paint('capturing…', 'yellow')
    : state.lastError ? paint(`error: ${state.lastError}`, 'red')
    : snapshot ? grey(summarize(snapshot))
    : grey('waiting…');
  lines.push(`${title}${status}`);

  // -- Tabs
  lines.push(TABS.map((name, index) =>
    name === tab
      ? paint(` ${index + 1} ${name} `, 'bold', 'cyan')
      : grey(` ${index + 1} ${name} `),
  ).join(''));
  lines.push(grey('─'.repeat(width)));

  // -- Body
  const bodyHeight = Math.max(3, height - lines.length - 2);
  const body = tab === 'debug'
    ? renderDebug(state, width)
    : snapshot ? renderTab(tab, snapshot, width) : [grey('  no snapshot yet')];
  const scroll = Math.min(state.scroll, Math.max(0, body.length - bodyHeight));
  lines.push(...body.slice(scroll, scroll + bodyHeight));

  // -- Pad so the footer sits at the bottom even on a short list.
  while (lines.length < height - 1) lines.push('');

  // -- Footer
  const more = body.length > bodyHeight ? ` · ${scroll + 1}-${Math.min(scroll + bodyHeight, body.length)}/${body.length}` : '';
  lines.push(grey(`  tab/←→ switch · ↑↓ scroll · r refresh · q quit${more}`));

  return lines.map((line) => truncate(line, width + 40)).join('\n');
}

function renderTab(tab: Tab, snapshot: Snapshot, width: number): string[] {
  switch (tab) {
    case 'overview': return renderOverview(snapshot, width);
    case 'documents': return renderDocuments(snapshot, width);
    case 'diagnostics': return renderDiagnostics(snapshot, width);
    case 'workspaces': return renderWorkspaces(snapshot, width);
    case 'sources': return renderSources(snapshot, width);
    case 'debug': return [];      // Handled before this, because it reads a different source.
  }
}

/**
 * The debug tab.
 *
 * Reads the published session rather than the snapshot, because a deep debug capture lives in the
 * proxy process and reaches this one through a file. When there is none, the tab explains how to
 * get one — an empty pane that does not say why is the worst thing a live interface can show.
 */
function renderDebug(state: FrameState, width: number): string[] {
  if (!state.debug) {
    return [
      '',
      grey('  no debug session captured'),
      '',
      grey('  Auspex captures one by sitting between the editor and its debug adapter:'),
      `  ${bold('auspex proxy --dap --deep -- <debug adapter command>')}`,
      '',
      grey('  Point the editor\'s launch configuration at that instead of at the adapter,'),
      grey('  then start debugging as usual. Stacks, scopes, every variable, memory and'),
      grey('  the whole protocol timeline appear here as soon as the program stops.'),
    ];
  }
  return renderDebugSession(state.debug, { verbose: false, timeline: false })
    .split('\n')
    .map((line) => truncate(line, width + 40));
}

function renderOverview(snapshot: Snapshot, width: number): string[] {
  const lines: string[] = [];
  const errors = snapshot.diagnostics.filter((item) => item.severity === 'error').length;
  const warnings = snapshot.diagnostics.filter((item) => item.severity === 'warning').length;

  lines.push('');
  lines.push(`  ${bold(String(snapshot.editors.length))} editors   ` +
    `${bold(String(snapshot.workspaces.length))} workspaces   ` +
    `${bold(String(snapshot.documents.length))} open files   ` +
    `${paint(String(errors), errors ? 'red' : 'grey')} errors   ` +
    `${paint(String(warnings), warnings ? 'yellow' : 'grey')} warnings`);
  lines.push('');

  lines.push(`  ${bold('Editors')}`);
  if (snapshot.editors.length === 0) lines.push(grey('    none detected'));
  for (const editor of snapshot.editors) {
    lines.push(`    ${pad(editor.name, 26)} ${paint(pad(editor.confidence, 10), confidenceColour(editor.confidence))} ` +
      grey(`${editor.documents.length} docs`));
  }
  lines.push('');

  const active = snapshot.documents.find((document) => document.active);
  if (active) {
    lines.push(`  ${bold('Active')}`);
    lines.push(`    ${shortenPath(active.path, width - 8)}`);
    lines.push(grey(`    ${active.languageId}` +
      (active.cursor ? ` · line ${active.cursor.line + 1}` : '') +
      (active.dirty ? ' · unsaved' : '')));
    lines.push('');
  }

  if (snapshot.debug?.active) {
    lines.push(`  ${bold('Debug')} ${paint(snapshot.debug.status, 'magenta')}` +
      (snapshot.debug.stoppedReason ? grey(` (${snapshot.debug.stoppedReason})`) : ''));
    for (const frame of snapshot.debug.stack?.slice(0, 5) ?? []) {
      lines.push(grey(`    ${frame.name} ${frame.file ? shortenPath(frame.file, 40) + ':' + frame.line : ''}`));
    }
    lines.push('');
  }

  if (snapshot.redactions) {
    lines.push(paint(`  redacted ${snapshot.redactions.count} secret value(s)`, 'yellow'));
  }
  for (const warning of snapshot.warnings.slice(0, 3)) {
    lines.push(paint(`  ! ${truncate(warning, width - 6)}`, 'yellow'));
  }
  return lines;
}

function renderDocuments(snapshot: Snapshot, width: number): string[] {
  if (snapshot.documents.length === 0) {
    return ['', grey('  No documents reported.'), '',
      grey('  Disk adapters can only see what an editor has written to its session files.'),
      grey('  For live open files, cursors and unsaved buffers, install the editor plugin'),
      grey('  in extensions/ and point it at this server.')];
  }
  return ['', ...snapshot.documents.map((document) => {
    const marker = document.active ? paint('●', 'green') : ' ';
    const flags = [
      document.dirty ? paint('unsaved', 'yellow') : '',
      document.cursor ? grey(`L${document.cursor.line + 1}`) : '',
      document.group !== undefined ? grey(`g${document.group}`) : '',
    ].filter(Boolean).join(' ');
    return `  ${marker} ${pad(shortenPath(document.path, width - 34), width - 33)} ${pad(document.languageId, 14)} ${flags}`;
  })];
}

function renderDiagnostics(snapshot: Snapshot, width: number): string[] {
  if (snapshot.diagnostics.length === 0) {
    return ['', grey('  No diagnostics reported.'), '',
      grey('  Diagnostics come from a language server or an editor plugin.'),
      grey('  Run `auspex proxy --lsp -- <your language server>` to capture them,'),
      grey('  or install the editor plugin.')];
  }
  return ['', ...snapshot.diagnostics.map((item) => {
    const severity = paint(pad(item.severity, 8), severityColour(item.severity));
    const location = `${shortenPath(item.file, 34)}:${item.range.start.line + 1}`;
    return `  ${severity} ${pad(location, 40)} ${truncate(item.message, width - 54)}`;
  })];
}

function renderWorkspaces(snapshot: Snapshot, width: number): string[] {
  const lines: string[] = [''];

  for (const workspace of snapshot.workspaces) {
    lines.push(`  ${bold(workspace.name)}  ${grey(shortenPath(workspace.root, width - workspace.name.length - 8))}`);

    const facts: string[] = [];
    if (workspace.fileCount !== undefined) facts.push(`${workspace.fileCount} files`);
    if (workspace.manifests?.length) facts.push(workspace.manifests.map((m) => m.kind).join('+'));
    if (facts.length) lines.push(grey(`      ${facts.join(' · ')}`));

    if (workspace.languages) {
      const top = Object.entries(workspace.languages).sort((a, b) => b[1] - a[1]).slice(0, 6);
      lines.push(grey(`      ${top.map(([l, n]) => `${l} ${n}`).join('  ')}`));
    }
    const vcs = workspace.vcs;
    if (vcs?.branch) {
      const parts = [paint(vcs.branch, 'magenta')];
      if (vcs.ahead) parts.push(paint(`↑${vcs.ahead}`, 'green'));
      if (vcs.behind) parts.push(paint(`↓${vcs.behind}`, 'yellow'));
      if (vcs.operationInProgress) parts.push(paint(`[${vcs.operationInProgress}]`, 'red'));
      if (vcs.files?.length) parts.push(grey(`${vcs.files.length} changed`));
      lines.push(`      ${parts.join(' ')}`);
    }
    lines.push('');
  }
  return lines;
}

function renderSources(snapshot: Snapshot, width: number): string[] {
  const lines = ['', `  ${dim('Every adapter that ran, what it produced, and how long it took.')}`, ''];
  const slowest = Math.max(1, ...snapshot.provenance.map((report) => report.durationMs));

  for (const report of snapshot.provenance) {
    const status = report.status === 'ok' ? paint('ok', 'green')
      : report.status === 'error' ? paint('error', 'red')
      : report.status === 'partial' ? paint('partial', 'yellow')
      : grey('none');

    // A proportional bar makes an adapter that is slowing every capture obvious at a glance, which
    // a column of numbers does not.
    const barWidth = Math.max(1, Math.round((report.durationMs / slowest) * 20));
    const bar = paint('█'.repeat(barWidth), report.durationMs > 2000 ? 'yellow' : 'grey');

    lines.push(`  ${pad(report.adapter, 16)} ${pad(status, 18)} ${pad(`${report.durationMs}ms`, 8)} ${bar}`);
    const note = report.detail ?? report.reason;
    if (note) lines.push(grey(`      ${truncate(note, width - 8)}`));
  }
  return lines;
}
