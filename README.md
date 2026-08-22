# Auspex

An editor-agnostic connector and debugging tool. It reads what a developer is actually working on —
which editors and projects are open, which files are being edited and where the caret is, what the
compiler is complaining about, what git says — from **any IDE or editor**, in **any language**, and
serves it to **any AI** through MCP, plain HTTP, or text you can paste anywhere.

It works in the terminal and in a browser, and it has no runtime dependencies at all: Node 22.6+
strips the type annotations at load, so there is no build step. Clone it and run it.

**121 tests passing. Zero runtime dependencies. No compile step.**

## What it does

```bash
node src/cli/main.ts capture           # what is happening right now, in the terminal
node src/cli/main.ts watch             # the same, live
node src/cli/main.ts gui               # the same, in a browser
node src/cli/main.ts mcp               # the same, as an MCP server for Claude
node src/cli/main.ts serve             # the same, as HTTP + SSE + OpenAPI for GPT/Gemini
node src/cli/main.ts doctor            # why is my capture thin?

node src/cli/main.ts proxy --dap --deep -- <debug adapter>   # capture a running program in full
node src/cli/main.ts debug             # threads, stacks, every variable, memory, what changed
node src/cli/main.ts debug report      # the same, written for an AI to read
node src/cli/main.ts debug wire        # how to capture a debug session for this project
node src/cli/main.ts debug trace x     # one variable's whole history through the session
node src/cli/main.ts debug threads     # threads grouped by what each is doing
node src/cli/main.ts debug bundle f.gz # a portable session, for a bug report
```

```
$ node src/cli/main.ts capture

Editors (2)
  Visual Studio Code         session  pid 7616 · 8 workspace(s) · 118 document(s)
  IntelliJ IDEA              session  pid 9142 · 1 workspace(s) · 6 document(s)

Active file
  …/src/core/redact.ts
  typescript · line 143 · unsaved

Workspaces (9)
  auspex  c:/Users/victo/Documents/projects_github/auspex
    62 files · 340.1 KB · npm
    typescript 34  markdown 6  json 3
    main ↑2 3 changed

Sources
  vscode           ok       2000ms  Visual Studio Code (8 workspace(s), 118 document(s))
  jetbrains        ok        684ms  IntelliJ IDEA (1 project(s), 6 tab(s))
  filesystem       ok        137ms  1 workspace(s) scanned
```

## How it reads any editor

There is no single mechanism that works everywhere, and pretending otherwise is how these tools get
built badly. Auspex uses four, and **every datum it produces says which one it came from and how
much to trust it**:

| Tier | Mechanism | Gets you | Needs |
|---|---|---|---|
| `live` | An editor plugin pushing to `POST /push` | Caret, selection, visible range, unsaved buffer contents, live diagnostics, terminal output | A plugin ([one is included](extensions/vscode)) |
| `live` | An LSP/DAP proxy | The compiler's own diagnostics, real symbol trees, a paused call stack — **for any language with a server, in any editor** | One line of editor config |
| `session` | Reading the editor's own on-disk state | Open folders, open tabs, and in JetBrains' case the caret | Nothing |
| `persisted` | The filesystem: manifests, layout, git | What the project *is* — **for every editor, including ones nobody has written an adapter for** | Nothing |

The bottom tier is the floor and it is why the "whichever editor it is" claim holds: every editor
edits files in directories, and those directories carry the project's manifests, its shape and its
version control.

**Editors with dedicated adapters:** VS Code, VS Code Insiders, VSCodium, Cursor, Windsurf, Trae,
Positron, Theia · IntelliJ IDEA, WebStorm, PyCharm, Rider, GoLand, CLion, PhpStorm, RubyMine,
DataGrip, RustRover, Android Studio, AppCode, Aqua · Visual Studio · Sublime Text · Zed · Neovim ·
Vim · Emacs · Helix · Nova · Xcode · Eclipse · NetBeans · Notepad++ · Kate · Geany — plus a
catch-all that reports any unrecognized editor process whose command line names a real project.

## How it is indifferent to the language

Every file is classified into one of eight families — programming, markup, style, data, config,
query, shell, text — across **90+ languages**, by exact filename first (`Dockerfile`, `Makefile`,
`.gitignore`), then shebang (`#!/usr/bin/env python3` on an extensionless script), then extension.

Structure extraction is two-tier and honest about which tier answered:

- **Genuinely parsed** — JSON/JSONC, YAML, TOML, INI, `.properties`, `.env`, CSV/TSV, Dockerfiles,
  Makefiles. Their grammars are small enough that guessing is inexcusable, so they are parsed
  properly, with real quoting, real indentation scoping, and CSV column-type inference.
- **Heuristic** — programming languages, matched by *declaration shape grouped by family* rather
  than by language. `class Foo` looks the same in a dozen unrelated languages, so one pattern set
  covers all of them and a language Auspex has never met gets a usable outline for free. Results
  are labelled `heuristic` and say how to do better.

The way to get *exact* symbols for a programming language is the LSP proxy, which asks the language
server that already has a real parse tree.

## How an AI plugs in

```bash
node src/cli/main.ts connect mcp        # prints the config to paste into Claude Desktop / Claude Code
node src/cli/main.ts connect openai     # prints tool definitions for GPT function calling
node src/cli/main.ts connect gemini     # the same, in Gemini's shape
```

**MCP** is the preferred door — an open specification, and pull-based, which matters because a
developer's editor state changes every few seconds and a snapshot pasted into a prompt is stale
before the first reply. Tools: `get_context`, `get_open_files`, `get_diagnostics`, `get_file`,
`search`, `get_git_status`, `list_editors`, plus `get_debug_session`, `get_debug_variables`,
`get_debug_changes`, `get_debug_timeline`, `get_debug_history`, `read_debug_memory`,
`get_debug_briefing`, `get_debug_analysis`, `get_debug_wiring`, `search_debug_history`,
`trace_debug_variable`, `get_debug_threads`, `explain_debug_values` and `decode_debug_memory` for a
running program.

**HTTP + OpenAPI** is the other door, for assistants that derive tools from a schema. Same
capabilities, at `/context`, `/documents`, `/diagnostics`, `/file`, `/git`, `/debug`, plus
`/events` for server-sent change notifications and `/push` for editor plugins.

**Markdown** is the universal fallback: `capture --format markdown` produces something you can paste
into any assistant that exists, including ones released after this was written.

Auspex never calls an AI API and holds no keys. It serves; your assistant reads.

## Debugging a running program

Put Auspex between the editor and its debug adapter and it captures the whole of a paused process —
not what the editor's Variables pane happened to have expanded, but every thread, every frame,
every scope, every variable expanded recursively, raw memory behind anything with an address,
loaded modules, exception detail, and what changed since the last time it stopped.

```bash
auspex proxy --dap --deep -- <the debug adapter command your editor would have run>
auspex debug --verbose --timeline --memory
```

It does this by issuing its own protocol requests while the program is frozen, and swallowing the
answers before they reach the editor — which is safe for three specific reasons, all of them
load-bearing and all of them tested. It never writes to the debuggee: no `setVariable`, no injected
`evaluate`, nothing that could change what it is measuring.

**For an assistant**, the raw capture is the wrong shape — a fifty-frame stack across five threads
can serialize past a million tokens, and most of that is punctuation. So `get_debug_briefing`
returns prose in the order the question is usually asked in: why it stopped, where, the source at
that line, the values there, what changed since the last stop, and observations worth checking —
each carrying the evidence that produced it, because a model that disagrees with a finding needs to
be able to check it.

Auspex does not diagnose bugs, and that restraint is deliberate: knowing `user` is `None` at the
line that dereferences it does not say whether the fault is the dereference, the lookup, or the
caller. A confident wrong diagnosis costs more than none.

If you do not know what command your editor runs for its debugger — which is usual — `debug wire`
reads the project's launch configurations and tells you, or says honestly that it cannot.

**Beyond what a debugger can do.** Auspex *records* a program where a debugger *drives* one, and
almost everything below follows from that: `debug trace retries` prints every value a variable held
across the whole session and where each change happened; `debug find --kind empty` finds every null
in the session in any language's spelling; `debug threads` turns a thousand goroutines into six
meaningful groups; `debug memory` reads a block every plausible way at once and names
`0xDDDDDDDD` as freed memory; `debug bundle` writes the whole session, with source embedded, to a
file you can attach to an issue.

Values are interpreted by **convention rather than by language** — brackets are a collection, `Err(…)`
is a failure sitting in a variable, `Promise { <pending> }` is not the data yet — so a language this
tool has never heard of still gets useful structure, with a confidence and a reason attached and the
debugger's own string never discarded.

**The VS Code extension needs no configuration at all.** It registers a debug adapter tracker for
every adapter, so pressing F5 captures the session — no proxy, no command to find. It sees only what
the editor asked for, says so in every payload, and the proxy remains the way to get what nobody
expanded.

[`docs/DEBUG.md`](docs/DEBUG.md) covers the capture; [`docs/AI-DEBUGGING.md`](docs/AI-DEBUGGING.md)
covers what an assistant receives; [`docs/BEYOND-IDE.md`](docs/BEYOND-IDE.md) covers what this does
that an IDE debugger does not.

## Secrets

Auspex's whole job is handing your working context to a third party, so **redaction is on by
default** and turning it off requires typing `--no-redact` and reading a warning.

It works on three axes at once — the *name* of a key (`password`, `token`, `secret`), the *shape* of
a value (AWS key ids, GitHub and OpenAI tokens, JWTs, PEM blocks, credentials inside URLs), and the
*file* it lives in. Files that exist solely to hold credentials (`.env`, `id_rsa`, `*.pem`,
`.npmrc`, `credentials`) are **refused by name rather than read and scrubbed** — with one deliberate
exception: a `.env` file's variable *names* are useful context and carry no secret, so those are
reported and the values never are.

Everything removed is **reported**, by rule and by count, in every snapshot. A silently blanked
value is worse than a visible `[redacted:aws-access-key-id]`.

This is a substantial reduction in exposure, not a guarantee: a secret that looks like ordinary text
under an ordinary name will pass through, and no redactor can fix that.

## Context budgets

A full capture of a working machine is easily hundreds of kilobytes. `--max-tokens` reduces it by a
**documented, deterministic priority order** — diffs first, then inactive file contents, then tree
depth one level at a time, then outlines, then commit history, then low-severity diagnostics, then
documents, then trees entirely, then unused workspaces, then manifests, and the active file's own
text last of all.

Whatever is dropped is listed in `warnings`. If even the irreducible core exceeds the budget, it
says so and suggests narrowing the question instead.

## Install

```bash
git clone <this repo> && cd auspex
npm test                                 # 121 tests, no install needed
node src/cli/main.ts editors             # what can I see?
```

Node 22.6 or newer. `npm install` is only needed for `npm run typecheck`, which installs TypeScript
as a *dev* dependency; nothing is required to run.

The VS Code extension is in [`extensions/vscode`](extensions/vscode) — copy the folder into your
extensions directory, run `node src/cli/main.ts serve`, and the caret, selections and unsaved
buffers start arriving.

## Where to read next

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — how each layer works and why it was built that way
- [`docs/ADAPTERS.md`](docs/ADAPTERS.md) — what each editor gives up, and how to add one
- [`docs/DEBUG.md`](docs/DEBUG.md) — deep debug capture: what it takes, and why injecting requests
  into a live debug session is safe
- [`docs/AI-DEBUGGING.md`](docs/AI-DEBUGGING.md) — what an assistant receives from a paused program,
  why observations are not diagnoses, and how a debug record is fitted to a context budget
- [`docs/BEYOND-IDE.md`](docs/BEYOND-IDE.md) — historical queries, value interpretation across
  languages, memory decoding, thread grouping, portable session bundles, and the zero-setup plugin
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — stated-permanent scope versus genuine follow-up work,
  including every real bug the tests caught during the build
