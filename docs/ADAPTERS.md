# Adapters: what each editor actually gives up

This is the honest, per-editor accounting. "Extracts everything from any IDE" is a claim that
deserves specifics rather than a checkmark, so what follows is what each adapter can and cannot
read, and why.

## The four mechanisms, ranked

| Tier | How | Cursor & selection | Unsaved buffers | Diagnostics | Debug state | Setup |
|---|---|---|---|---|---|---|
| `live` | Editor plugin → `POST /push` | ✅ | ✅ | ✅ | ✅ | Install a plugin |
| `live` | LSP / DAP proxy | — | — | ✅ exact | ✅ full stack | One config line |
| `session` | Editor's on-disk state | JetBrains only | Detected, not readable | — | Breakpoints only | None |
| `persisted` | Filesystem + git | — | — | — | — | None |

The bottom row works for **every editor that has ever existed**, including one released next week,
because every editor edits files in directories.

## Per editor

### VS Code family — `session`
*VS Code, Insiders, VSCodium, Cursor, Windsurf, Trae, Positron, Theia*

One adapter covers all of them: every fork inherited the storage layout unchanged, so the only
per-product difference is a folder name in `platform/paths.ts`. Supporting the next fork is one
line.

**Reads:** open folders (from the process command line *and* the recent list — the command line is
never stale, the recent list covers restored windows), open tabs with their editor group and which
is active, files with unsaved changes, installed extensions, and the settings that change how code
is written.

**How the tabs are read:** `workspaceStorage/<hash>/state.vscdb` is SQLite. Rather than take a
native dependency or reimplement the format, the JSON payloads are extracted from the raw bytes and
the serialized editor grid is walked. Documented as a hack in its own source; read-only, fails
closed, discards values SQLite spilled to overflow pages.

**Cannot read:** the caret, selections, or unsaved contents — those exist only in memory. That is
what [`extensions/vscode`](../extensions/vscode) is for.

### JetBrains — `session`
*IntelliJ IDEA, WebStorm, PyCharm, Rider, GoLand, CLion, PhpStorm, RubyMine, DataGrip, RustRover,
Android Studio, AppCode, Aqua*

**Reads:** open projects (recent list, with `$USER_HOME$` expanded), open tabs, **the caret line and
column**, breakpoints with their conditions, and run configurations.

JetBrains is the one family that writes the caret to disk, in `.idea/workspace.xml`. The catch, and
why it is `session` rather than `live`: the IDE flushes that file when it feels like it, so the
position can be minutes stale.

### Visual Studio — `persisted`

**Reads:** solutions (both the classic `.sln` text format and the newer `.slnx` XML — both are in
active use, and handling only one would miss half of .NET), project files with their target
frameworks and package references, and `launchSettings.json`.

**Deliberately does not read** the `.suo` file holding open-document state. It is an OLE compound
file with undocumented, version-specific streams; parsing it properly is a project of its own, and
scraping strings out of it would produce plausible-looking garbage. Live state needs an extension —
see "Writing an adapter" below.

### Sublime Text — `session`

The richest of the non-VS-Code session files: `Session.sublime_session` is plain JSON with open
buffers and project folders.

### Zed — `persisted`

Zed keeps state in SQLite; the plain-JSON recent-paths files are read instead. Open documents need
a Zed extension.

### Neovim and Vim — `session`

Vim's `viminfo` is line-oriented text with `>` marking each remembered file. Neovim's `shada` is
MessagePack — binary, but the paths inside are plain UTF-8 and are recovered by scanning. A partial
read, labelled as one: it yields *which* files were recently edited, not the cursor, which is
encoded numerically.

### Emacs — `session`

`recentf-save.el` is a list of quoted strings, every one a path. No Lisp reader needed.

### Everything else — `persisted`

*Helix, Nova, Xcode, Eclipse, NetBeans, Notepad++, Kate, Geany* get process detection and full
workspace description. Their session state is binary or deeply nested, and the workspace description
already answers most of what an assistant needs.

### Unrecognized editors — `inferred`

A catch-all reports any process whose name looks like an editor and whose command line names a real
project directory (verified by a project marker, and excluding tool paths like `node_modules` and
installation directories — a language server's command line is full of those). Strictly better than
silence, and how someone on a niche or brand-new editor gets *something*.

## The two universal mechanisms

### LSP / DAP proxy — `live`, any editor, any language

```bash
auspex proxy --lsp -- typescript-language-server --stdio
auspex proxy --dap -- node /path/to/debug-adapter.js
auspex proxy --lsp --forward http://127.0.0.1:4278 -- rust-analyzer
```

Point your editor's server command at Auspex with the real server as arguments. Every byte passes
through untouched in both directions; the notifications worth remembering are kept.

This is the only mechanism that gives the **compiler's own** diagnostics and a **real** symbol tree,
and it works for a language Auspex has never heard of. Its cost is one line of editor
reconfiguration — the honest price of exactness.

### Editor plugin — `live`, highest fidelity

`POST /push` with anything you have. Every field is optional; send what your editor makes easy.

```json
{
  "editor": "neovim",
  "documents": [{
    "path": "/w/src/main.rs",
    "dirty": true, "active": true,
    "cursor": { "line": 41, "character": 7 },
    "text": "…unsaved contents…"
  }],
  "diagnostics": [{ "path": "/w/src/main.rs", "line": 41, "severity": "error", "message": "…" }]
}
```

Severity is accepted as a name or an LSP number. Paths may be file URIs or plain paths in either
slash direction. Unknown fields are ignored rather than rejected.

## Writing an adapter

Two ways, depending on whether you are inside the editor or outside it.

### From inside: a plugin (preferred)

Anything that can make an HTTP request works. The included
[VS Code extension](../extensions/vscode/extension.js) is about a hundred lines of real logic and is
the reference. The shape for other editors:

- **JetBrains** — a plugin with `FileEditorManagerListener` and `CaretListener`, posting on change.
- **Neovim** — a Lua module on `CursorMoved`, `BufEnter` and `DiagnosticChanged` autocommands.
- **Emacs** — a hook on `post-command-hook`, debounced.
- **Sublime** — an `EventListener` with `on_selection_modified_async`.
- **Visual Studio** — a VSIX using `IVsRunningDocumentTable` and `DTE.ActiveDocument`.

Send on change, debounced to a few hundred milliseconds; nothing downstream can act faster than a
second, and a debounce collapses a burst of typing into one message.

### From outside: an `Adapter`

```ts
import type { Adapter, AdapterResult, CaptureOptions } from 'auspex';
import { NO_CAPABILITIES } from 'auspex';
import { describeWorkspace } from 'auspex';

export class MyEditorAdapter implements Adapter {
  readonly id = 'myeditor';
  readonly name = 'My Editor';
  readonly confidence = 'session' as const;
  readonly capabilities = { ...NO_CAPABILITIES, discovery: true, workspaces: true };

  async probe(): Promise<boolean> {
    // Cheap: does this machine have the editor at all? Never throw.
    return existsSync(configDirectory);
  }

  async capture(options: CaptureOptions): Promise<AdapterResult> {
    // Never throw either -- return a warning instead. See core/adapter.ts.
    return {
      editors: [{
        adapter: this.id, name: this.name, confidence: this.confidence,
        workspaces: [await describeWorkspace(root, options)],
        documents: [],
      }],
      detail: '1 window',
    };
  }
}
```

Then add it to `defaultAdapters()` in `core/snapshot.ts`. Nothing else changes: the model, the
merge, the servers, the CLI and the GUI all pick it up.

**Three rules, each of which the merge depends on:**

1. **Declare your real confidence.** Reporting `live` for a file you read off disk breaks the merge
   for everyone, because a genuinely live source will lose to you.
2. **Never throw.** Return `warnings`. `runAdapter` will catch it anyway, but a returned warning
   says what happened and a caught exception says only that something did.
3. **Honour the budget.** `options.maxFiles` and `options.timeoutMs` exist so one adapter cannot
   make every capture slow.


## Debug capture from inside an editor

`extensions/vscode/debug-tracker.js` is the reference implementation of the second thing an editor
plugin can do that nothing outside the editor can: **see the debug protocol without a proxy.**

VS Code exposes `vscode.debug.registerDebugAdapterTrackerFactory`, which hands an extension every
DAP message in both directions, for every session, with no configuration. Registering it for `'*'`
makes it language-agnostic in exactly the way the proxy is — it works for adapters that did not
exist when the code was written.

**Every editor with a debug API can do some version of this.** The shape to follow:

1. Observe messages in both directions. Keep a bounded timeline with direction, size and round-trip
   timing.
2. Build up the current stop from what the editor requests: `stackTrace` gives frames, `scopes`
   gives scopes, `variables` fills them in. File each response under the reference that asked for
   it, so the tree assembles itself.
3. Reset frame state on every `stopped` event. DAP frame ids are valid only for the stop that issued
   them, and carrying them over attaches old values to new frames.
4. Post the record to `/push` as `debugSession`, with **`captureMethod` set to something other than
   `proxy`**. This is not optional: a passive capture holds only what the editor asked for, and
   everything downstream needs to tell that apart from an exhaustive one. A variable nobody expanded
   is *absent*, not empty, and a reader who does not know that will conclude it does not exist.
5. Withhold the launch configuration's `env` block. Keep the variable names; drop the values.

A tracker cannot issue its own requests — the API is notifications, not a channel — so it cannot do
the active probing the proxy exists for. Say so in the payload rather than letting a consumer assume
otherwise.
