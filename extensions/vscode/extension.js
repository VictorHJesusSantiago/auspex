'use strict';

/**
 * The Auspex VS Code extension.
 *
 * **This is the piece that makes the highest-fidelity data possible**, and it is deliberately tiny
 * — about a hundred lines of real logic. Everything the disk adapters cannot see (the caret, the
 * selection, the visible range, unsaved buffer contents, live diagnostics from the language server,
 * terminal output) is a single API call from inside the editor. The whole difficulty of reading it
 * from outside evaporates when you are on the inside.
 *
 * It is written in plain JavaScript with no build step, matching the rest of the project: copy this
 * folder into the extensions directory and it runs. A TypeScript source and a bundler would be more
 * conventional and would make the one thing a user has to do harder.
 *
 * **What it sends and what it does not.** It posts to a loopback URL only. It never sends anything
 * anywhere else, it holds no credentials, and it stops entirely when disabled. The document text it
 * includes is capped and is only for *dirty* buffers, because those are the ones whose contents are
 * not on disk and therefore cannot be read any other way — a clean file's contents are already
 * readable by anything with filesystem access, so sending them would be pure duplication.
 *
 * The same shape works for any editor with an extension API. See `docs/ADAPTERS.md`.
 */

const vscode = require('vscode');
const { activateDebugTracker } = require('./debug-tracker.js');

/** Default endpoint. Overridable in settings, because a user may run the server elsewhere. */
const DEFAULT_ENDPOINT = 'http://127.0.0.1:4278/push';

let timer;
let output;
let statusItem;
let lastError;

function activate(context) {
  output = vscode.window.createOutputChannel('Auspex');
  output.appendLine('Auspex extension activated.');

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = 'auspex.pushNow';
  context.subscriptions.push(statusItem, output);

  const push = () => sendState().catch((error) => {
    // A server that is not running is the normal case, not an error worth interrupting anyone over.
    // It is recorded in the status bar and the output channel and nowhere else.
    lastError = error && error.message ? error.message : String(error);
    updateStatus(false);
  });

  // Deep debug capture, with no proxy and no configuration. See `debug-tracker.js` for what this
  // gets that the proxy cannot, and — importantly — what it cannot get that the proxy can.
  if (vscode.workspace.getConfiguration('auspex').get('trackDebugSessions', true)) {
    activateDebugTracker(context, {
      output,
      endpoint: () => vscode.workspace.getConfiguration('auspex').get('endpoint', DEFAULT_ENDPOINT),
    });
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('auspex.pushNow', push),
    vscode.commands.registerCommand('auspex.toggle', () => {
      const config = vscode.workspace.getConfiguration('auspex');
      const enabled = !config.get('enabled', true);
      config.update('enabled', enabled, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`Auspex ${enabled ? 'enabled' : 'disabled'}.`);
      schedule(push);
    }),
  );

  // Push on the events that actually change what the user is looking at, debounced. Pushing on
  // every keystroke would be both wasteful and useless: nothing consuming this can act faster than
  // a second, and a debounce collapses a burst of typing into one message.
  const debounced = debounce(push, 400);
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(debounced),
    vscode.window.onDidChangeTextEditorSelection(debounced),
    vscode.window.onDidChangeVisibleTextEditors(debounced),
    vscode.workspace.onDidChangeTextDocument(debounced),
    vscode.workspace.onDidSaveTextDocument(debounced),
    vscode.languages.onDidChangeDiagnostics(debounced),
    vscode.debug.onDidChangeActiveDebugSession(debounced),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('auspex')) schedule(push);
    }),
  );

  schedule(push);
  push();
}

function deactivate() {
  if (timer) clearInterval(timer);
  if (statusItem) statusItem.dispose();
}

/** Restarts the heartbeat, which keeps the server's view fresh even when nothing is happening. */
function schedule(push) {
  if (timer) clearInterval(timer);
  const config = vscode.workspace.getConfiguration('auspex');
  if (!config.get('enabled', true)) {
    statusItem.hide();
    return;
  }
  const seconds = Math.max(2, config.get('intervalSeconds', 10));
  timer = setInterval(push, seconds * 1000);
  statusItem.show();
}

/** Collects the editor's state and posts it. */
async function sendState() {
  const config = vscode.workspace.getConfiguration('auspex');
  if (!config.get('enabled', true)) return;

  const endpoint = config.get('endpoint', DEFAULT_ENDPOINT);
  const includeText = config.get('includeUnsavedText', true);
  const maxTextBytes = config.get('maxTextBytes', 200000);

  const payload = {
    editor: 'vscode',
    name: vscode.env.appName,
    version: vscode.version,
    pid: process.pid,
    workspaces: (vscode.workspace.workspaceFolders || []).map((folder) => ({
      root: folder.uri.fsPath,
      name: folder.name,
    })),
    documents: collectDocuments(includeText, maxTextBytes),
    diagnostics: collectDiagnostics(),
    settings: collectSettings(),
  };

  const session = vscode.debug.activeDebugSession;
  if (session) {
    payload.debug = { active: true, status: 'running', adapterType: session.type };
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  lastError = undefined;
  updateStatus(true, payload.documents.length);
}

/**
 * Every open tab, with the live detail only the editor knows.
 *
 * `vscode.window.tabGroups` rather than `visibleTextEditors`: the latter reports only tabs that are
 * actually rendered, so a window with twelve tabs open reports two. The tab model reports all of
 * them, which is what "what do I have open" means.
 */
function collectDocuments(includeText, maxTextBytes) {
  const documents = [];
  const active = vscode.window.activeTextEditor;
  const byPath = new Map();

  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (!input || !input.uri) continue;

      const path = input.uri.fsPath || input.uri.toString();
      if (byPath.has(path)) continue;

      const record = {
        path,
        languageId: 'plaintext',
        dirty: tab.isDirty === true,
        active: tab.isActive === true && group.isActive === true,
        group: group.viewColumn,
      };
      byPath.set(path, record);
      documents.push(record);
    }
  }

  // Then enrich with what the open editors know: the language, the caret, what is on screen.
  for (const editor of vscode.window.visibleTextEditors) {
    const path = editor.document.uri.fsPath || editor.document.uri.toString();
    let record = byPath.get(path);
    if (!record) {
      record = { path, languageId: 'plaintext', dirty: false, active: false };
      byPath.set(path, record);
      documents.push(record);
    }

    record.languageId = editor.document.languageId;
    record.dirty = editor.document.isDirty;
    record.cursor = { line: editor.selection.active.line, character: editor.selection.active.character };
    record.selections = editor.selections
      .filter((selection) => !selection.isEmpty)
      .map((selection) => ({
        start: { line: selection.start.line, character: selection.start.character },
        end: { line: selection.end.line, character: selection.end.character },
      }));

    const visible = editor.visibleRanges[0];
    if (visible) {
      record.visibleRange = {
        start: { line: visible.start.line, character: visible.start.character },
        end: { line: visible.end.line, character: visible.end.character },
      };
    }
    if (editor === active) record.active = true;

    // Only dirty buffers. A saved file's contents are on disk and readable by anything; an unsaved
    // one exists solely in this process, which is precisely why it is worth sending.
    if (includeText && editor.document.isDirty) {
      const text = editor.document.getText();
      if (text.length <= maxTextBytes) record.text = text;
    }
  }
  return documents;
}

/** Every diagnostic the editor currently holds, from every language server and linter. */
function collectDiagnostics() {
  const collected = [];
  const severities = ['error', 'warning', 'information', 'hint'];

  for (const [uri, items] of vscode.languages.getDiagnostics()) {
    for (const item of items) {
      collected.push({
        path: uri.fsPath || uri.toString(),
        line: item.range.start.line,
        character: item.range.start.character,
        endLine: item.range.end.line,
        endCharacter: item.range.end.character,
        severity: severities[item.severity] || 'information',
        message: item.message,
        code: item.code === undefined || item.code === null
          ? undefined
          : String(typeof item.code === 'object' ? item.code.value : item.code),
        source: item.source,
      });
      // A project mid-refactor can hold thousands. Nothing downstream reads past the first few
      // hundred, and posting the rest costs bandwidth for no information.
      if (collected.length >= 500) return collected;
    }
  }
  return collected;
}

/** The settings that change how code is written, which are the ones worth reporting. */
function collectSettings() {
  const editor = vscode.workspace.getConfiguration('editor');
  const files = vscode.workspace.getConfiguration('files');
  return {
    'editor.tabSize': editor.get('tabSize'),
    'editor.insertSpaces': editor.get('insertSpaces'),
    'editor.formatOnSave': editor.get('formatOnSave'),
    'editor.defaultFormatter': editor.get('defaultFormatter'),
    'files.eol': files.get('eol'),
    'files.encoding': files.get('encoding'),
    'files.insertFinalNewline': files.get('insertFinalNewline'),
  };
}

function updateStatus(ok, count) {
  if (!statusItem) return;
  statusItem.text = ok ? `$(eye) auspex ${count}` : '$(eye-closed) auspex';
  statusItem.tooltip = ok
    ? `Auspex is reporting ${count} open document(s).`
    : `Auspex could not reach the server${lastError ? `: ${lastError}` : ''}.\nRun \`auspex serve\` in a terminal.`;
  statusItem.backgroundColor = ok
    ? undefined
    : new vscode.ThemeColor('statusBarItem.warningBackground');
}

function debounce(fn, delay) {
  let handle;
  return (...callArgs) => {
    if (handle) clearTimeout(handle);
    handle = setTimeout(() => fn(...callArgs), delay);
  };
}

module.exports = { activate, deactivate };
