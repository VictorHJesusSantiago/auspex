import { SCHEMA_VERSION } from '../core/snapshot.ts';

/**
 * The graphical interface: a single self-contained page served by the HTTP server.
 *
 * **Why one hand-written page rather than a framework.** The brief asks for a GUI as well as a
 * terminal, and this is a debugging and inspection tool — it shows what was captured, from where,
 * and with what confidence, and it lets a developer poke the endpoints. That is a read-mostly
 * dashboard, and building it as a static page with no build step keeps the project's central
 * promise intact: clone it, run `node`, and it works. A React application would mean a bundler, a
 * dependency tree and a compile step for a page that renders six lists.
 *
 * The page polls `/context` and subscribes to `/events`, so it updates as the developer works —
 * which is also the fastest way to see whether an editor plugin is actually pushing.
 *
 * It is deliberately legible in both colour schemes and on a narrow window, because the realistic
 * use is a small window docked beside an editor.
 */
export function renderDashboard(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Auspex</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #fbfbfd; --panel: #ffffff; --ink: #16181d; --muted: #6b7280;
    --line: #e4e6eb; --accent: #4f46e5; --ok: #059669; --warn: #d97706; --err: #dc2626;
    --mono: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0e1014; --panel: #16191f; --ink: #e6e8ec; --muted: #9199a6;
      --line: #262b33; --accent: #818cf8; --ok: #34d399; --warn: #fbbf24; --err: #f87171;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  header {
    display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap;
    padding: 14px 20px; border-bottom: 1px solid var(--line); background: var(--panel);
    position: sticky; top: 0; z-index: 10;
  }
  h1 { font-size: 16px; margin: 0; letter-spacing: -0.01em; }
  .sub { color: var(--muted); font-size: 12px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; background: var(--muted); }
  .dot.live { background: var(--ok); }
  main { padding: 16px 20px 48px; max-width: 1200px; }
  section { margin-bottom: 22px; }
  h2 {
    font-size: 12px; text-transform: uppercase; letter-spacing: 0.07em;
    color: var(--muted); margin: 0 0 8px; font-weight: 600;
  }
  .card {
    background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
    overflow: hidden;
  }
  .row {
    display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px;
    padding: 9px 14px; border-top: 1px solid var(--line); align-items: center;
  }
  .row:first-child { border-top: none; }
  .row .name { font-family: var(--mono); font-size: 12.5px; overflow-wrap: anywhere; }
  .row .meta { color: var(--muted); font-size: 11.5px; white-space: nowrap; }
  .tag {
    font-size: 10.5px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--line);
    color: var(--muted); font-family: var(--mono);
  }
  .tag.live { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, transparent); }
  .tag.session { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, transparent); }
  .tag.error { color: var(--err); border-color: color-mix(in srgb, var(--err) 40%, transparent); }
  .tag.warning { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, transparent); }
  .grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
  .stat { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
  .stat b { display: block; font-size: 22px; font-weight: 650; letter-spacing: -0.02em; }
  .stat span { color: var(--muted); font-size: 11.5px; }
  button {
    font: inherit; font-size: 12.5px; padding: 5px 11px; border-radius: 7px;
    border: 1px solid var(--line); background: var(--panel); color: var(--ink); cursor: pointer;
  }
  button:hover { border-color: var(--accent); color: var(--accent); }
  .empty { padding: 14px; color: var(--muted); font-size: 12.5px; }
  code { font-family: var(--mono); font-size: 12px; }
  pre {
    margin: 0; padding: 12px 14px; overflow-x: auto; font-family: var(--mono);
    font-size: 11.5px; line-height: 1.45;
  }
  .bar { height: 4px; background: var(--line); border-radius: 2px; overflow: hidden; margin-top: 5px; }
  .bar i { display: block; height: 100%; background: var(--accent); }
</style>
</head>
<body>
<header>
  <h1>Auspex</h1>
  <span class="sub"><span class="dot" id="status-dot"></span> <span id="status">connecting…</span></span>
  <span class="sub" style="margin-left:auto">schema ${SCHEMA_VERSION}</span>
  <button id="refresh">Refresh</button>
  <button id="copy">Copy snapshot</button>
</header>
<main>
  <section>
    <div class="grid" id="stats"></div>
  </section>
  <section>
    <h2>Editors</h2>
    <div class="card" id="editors"><div class="empty">…</div></div>
  </section>
  <section>
    <h2>Open documents</h2>
    <div class="card" id="documents"><div class="empty">…</div></div>
  </section>
  <section>
    <h2>Diagnostics</h2>
    <div class="card" id="diagnostics"><div class="empty">…</div></div>
  </section>
  <section>
    <h2>Debug session <span class="meta" id="debug-status"></span></h2>
    <div class="card" id="debug"><div class="empty">…</div></div>
  </section>
  <section>
    <h2>Workspaces</h2>
    <div class="card" id="workspaces"><div class="empty">…</div></div>
  </section>
  <section>
    <h2>Adapter provenance</h2>
    <div class="card" id="provenance"><div class="empty">…</div></div>
  </section>
  <section>
    <h2>Notices</h2>
    <div class="card" id="notices"><div class="empty">…</div></div>
  </section>
</main>
<script type="module">
const $ = (id) => document.getElementById(id);
let snapshot = null;

const escape = (value) => String(value ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const short = (path) => {
  const parts = String(path).split('/');
  return parts.length > 3 ? '…/' + parts.slice(-3).join('/') : path;
};

function rows(container, items, render) {
  if (!items || items.length === 0) {
    container.innerHTML = '<div class="empty">nothing reported</div>';
    return;
  }
  container.innerHTML = items.map(render).join('');
}

function paint(data) {
  snapshot = data;
  const errors = data.diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = data.diagnostics.filter((d) => d.severity === 'warning').length;

  $('stats').innerHTML = [
    ['Editors', data.editors.length],
    ['Workspaces', data.workspaces.length],
    ['Open files', data.documents.length],
    ['Errors', errors],
    ['Warnings', warnings],
    ['Redactions', data.redactions?.count ?? 0],
  ].map(([label, value]) =>
    \`<div class="stat"><b>\${value}</b><span>\${label}</span></div>\`).join('');

  rows($('editors'), data.editors, (editor) => \`
    <div class="row">
      <div class="name">\${escape(editor.name)}
        <span class="tag \${escape(editor.confidence)}">\${escape(editor.confidence)}</span>
      </div>
      <div class="meta">\${editor.pid ? 'pid ' + editor.pid + ' · ' : ''}\${editor.workspaces.length} ws · \${editor.documents.length} docs</div>
    </div>\`);

  rows($('documents'), data.documents.slice(0, 40), (doc) => \`
    <div class="row">
      <div class="name">\${doc.active ? '● ' : ''}\${escape(short(doc.path))}
        \${doc.dirty ? '<span class="tag warning">unsaved</span>' : ''}
      </div>
      <div class="meta">\${escape(doc.languageId)}\${doc.cursor ? ' · L' + (doc.cursor.line + 1) : ''}</div>
    </div>\`);

  rows($('diagnostics'), data.diagnostics.slice(0, 40), (item) => \`
    <div class="row">
      <div class="name"><span class="tag \${escape(item.severity)}">\${escape(item.severity)}</span>
        \${escape(item.message.slice(0, 160))}</div>
      <div class="meta">\${escape(short(item.file))}:\${item.range.start.line + 1}</div>
    </div>\`);

  rows($('workspaces'), data.workspaces, (ws) => {
    const langs = Object.entries(ws.languages ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 4);
    return \`<div class="row">
      <div class="name">\${escape(ws.name)}
        <div class="meta">\${langs.map(([l, n]) => escape(l) + ' ' + n).join(' · ') || '—'}</div>
      </div>
      <div class="meta">\${ws.fileCount ?? 0} files\${ws.vcs?.branch ? ' · ' + escape(ws.vcs.branch) : ''}</div>
    </div>\`;
  });

  const slowest = Math.max(1, ...data.provenance.map((p) => p.durationMs));
  rows($('provenance'), data.provenance, (report) => \`
    <div class="row">
      <div class="name">\${escape(report.adapter)}
        <div class="meta">\${escape(report.detail ?? report.reason ?? '')}</div>
        <div class="bar"><i style="width:\${Math.round((report.durationMs / slowest) * 100)}%"></i></div>
      </div>
      <div class="meta"><span class="tag \${report.status === 'error' ? 'error' : report.status === 'ok' ? 'live' : ''}">\${escape(report.status)}</span> \${report.durationMs}ms</div>
    </div>\`);

  const notices = [...(data.warnings ?? [])];
  if (data.redactions) {
    notices.unshift('redacted ' + data.redactions.count + ' value(s): ' +
      Object.entries(data.redactions.byRule).map(([k, v]) => k + '×' + v).join(', '));
  }
  rows($('notices'), notices, (text) => \`<div class="row"><div class="name">\${escape(text)}</div><div class="meta"></div></div>\`);

  $('status').textContent = 'updated ' + new Date().toLocaleTimeString();
  $('status-dot').classList.add('live');
}

/**
 * Paints the paused program.
 *
 * Read from its own endpoint rather than from the snapshot, because a deep debug capture lives in
 * the proxy process and is far too large to attach to every context request. When there is none,
 * the panel says how to get one -- an empty card that does not explain itself is the worst thing a
 * dashboard can show.
 */
function paintDebug(data) {
  const card = $('debug');
  if (!data || !data.sessionId) {
    $('debug-status').textContent = '';
    card.innerHTML = '<div class="empty">Not captured. Run ' +
      '<code>auspex proxy --dap --deep -- &lt;debug adapter&gt;</code> and point your editor at it.</div>';
    return;
  }

  $('debug-status').textContent = [data.adapterType, data.status,
    data.totals.stops + ' stop(s)'].filter(Boolean).join(' · ');

  const stop = data.currentStop;
  if (!stop) {
    card.innerHTML = '<div class="empty">Running; the program has not stopped yet.</div>';
    return;
  }

  const parts = [];
  parts.push('<div class="row"><div class="name">' + escape(stop.reason || 'stopped') +
    (stop.text ? ' — ' + escape(stop.text) : '') +
    '<div class="meta">stop #' + stop.index + ' · captured in ' + stop.captureMs + 'ms</div></div>' +
    '<div class="meta"><span class="tag live">' + escape(data.status) + '</span></div></div>');

  if (stop.exception) {
    parts.push('<div class="row"><div class="name">' +
      escape(stop.exception.typeName || stop.exception.exceptionId) +
      '<div class="meta">' + escape(stop.exception.message || '') + '</div></div>' +
      '<div class="meta"><span class="tag error">exception</span></div></div>');
  }

  const threadId = stop.threadId != null ? stop.threadId : Object.keys(stop.stacks)[0];
  const frames = stop.stacks[threadId] || [];
  for (const [index, frame] of frames.slice(0, 12).entries()) {
    const where = frame.file ? frame.file + ':' + (frame.line || '?') : (frame.sourceName || 'no source');
    parts.push('<div class="row"><div class="name">#' + index + ' ' + escape(frame.name) +
      '<div class="meta">' + escape(where) + '</div></div><div class="meta"></div></div>');

    for (const scope of (stop.frames[frame.id] || [])) {
      const values = (scope.variables || []).slice(0, 20).map((variable) =>
        escape(variable.name) + ' = ' + escape(String(variable.value).slice(0, 80)) +
        (variable.truncated ? ' <span class="meta">⟨' + escape(variable.truncated) + '⟩</span>' : ''));
      parts.push('<div class="row"><div class="name">' + escape(scope.name) +
        '<div class="meta">' + (scope.skipped ? escape(scope.skipped) : values.join('<br>') || 'empty') +
        '</div></div><div class="meta"></div></div>');
    }
  }

  const diff = data.diffs && data.diffs[data.diffs.length - 1];
  if (diff && diff.changed.length > 0) {
    parts.push('<div class="row"><div class="name">Changed since stop #' + diff.fromStop +
      '<div class="meta">' + diff.changed.slice(0, 12).map((delta) =>
        escape(delta.scope + '/' + delta.path) + ': ' + escape(String(delta.before)) + ' → ' +
        escape(String(delta.after))).join('<br>') +
      '</div></div><div class="meta"></div></div>');
  }

  card.innerHTML = parts.join('');
}

async function refresh() {
  try {
    const response = await fetch('/context?tree=true');
    if (!response.ok) throw new Error('HTTP ' + response.status);
    paint(await response.json());
  } catch (error) {
    $('status').textContent = 'failed: ' + error.message;
    $('status-dot').classList.remove('live');
  }

  // Separate and independently fault-tolerant: a debug endpoint that fails must not blank the
  // rest of a working dashboard.
  try {
    const response = await fetch('/debug');
    if (response.ok) paintDebug(await response.json());
  } catch {
    // Nothing published, or the server is mid-restart. The panel keeps its last content.
  }
}

$('refresh').addEventListener('click', refresh);
$('copy').addEventListener('click', async () => {
  if (!snapshot) return;
  await navigator.clipboard.writeText(JSON.stringify(snapshot, null, 2));
  $('copy').textContent = 'Copied';
  setTimeout(() => { $('copy').textContent = 'Copy snapshot'; }, 1500);
});

// Live updates: the event stream says *that* something changed, and the page then asks for the new
// state. Pushing whole snapshots down the stream would be far more data for no more information.
try {
  const events = new EventSource('/events');
  events.addEventListener('push', () => refresh());
} catch {
  // No EventSource: polling below still keeps the page current.
}

refresh();
setInterval(refresh, 10000);
</script>
</body>
</html>`;
}
