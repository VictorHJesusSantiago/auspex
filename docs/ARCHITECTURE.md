# Architecture

## The shape of the problem

The brief is "extract everything from any IDE, in any language, for any AI". Taken literally that is
impossible, and the interesting engineering is in what you do about that rather than in pretending
otherwise.

Three facts constrain everything below:

1. **You cannot read an arbitrary program's memory.** Where the caret is, what a scratch buffer
   contains, what the debugger is holding — none of that exists outside the editor's process. No
   amount of cleverness on the outside reaches it.
2. **What editors *do* leave outside themselves is their on-disk state**, and every one of them
   invented its own format for it: SQLite for VS Code, XML for JetBrains, an OLE compound file for
   Visual Studio, JSON for Sublime, MessagePack for Neovim, s-expressions for Emacs.
3. **They all speak two open protocols anyway.** LSP and DAP are the same everywhere, for every
   language that has a server, in every editor that has an integration.

So Auspex reads by four mechanisms of decreasing fidelity and increasing universality, and — the
part that makes it honest rather than merely broad — **every record it produces carries the tier it
came from**, so a consumer can tell a live cursor from a five-minute-old one.

## Layers

```
platform/     processes, per-editor paths, guarded filesystem access
languages/    identification (90+ across 8 families), outlines, real data parsers
vcs/          git
   ↓
core/         the model, the adapter contract, redaction, merging, budgets
   ↓
adapters/     push · protocols · vscode · jetbrains · visualstudio · editors · generic
   ↓
server/       MCP (stdio) · HTTP+SSE+OpenAPI · GUI
ai/           per-provider payload shaping
cli/          commands, terminal report, live TUI
```

Nothing points back up. `languages/` knows nothing of editors; `core/` knows nothing of servers;
`adapters/` know nothing of each other. That is what lets an adapter be added without touching
anything else, which is the extension point the whole design is arranged around.

## Confidence, and why it is on every record

```
live       a plugin inside the editor, or an active protocol stream
session    the editor's own on-disk state, while it is running
persisted  configuration and project files, with no running editor
inferred   heuristics over layout and naming
```

This is not decoration. Two adapters routinely describe the same file: the VS Code disk scrape says
`Foo.ts` is open; the extension, reporting from inside the same editor a second ago, says it is open,
dirty, and the caret is on line 42. Both are "right". The merge rule is uniform and applied
everywhere:

> **Higher confidence wins the record; lower confidence fills in the fields the winner left empty.**

So the live cursor beats the stale one, and the file size that only the disk scrape knew is kept
rather than discarded. That is strictly better than last-writer-wins or first-writer-wins, and it is
only expressible because confidence travels with the data.

## `core/`

**`model.ts`** is the editor-agnostic vocabulary — `Snapshot`, `EditorInstance`, `Workspace`,
`OpenDocument`, `Diagnostic`, `DebugState`, `VcsState`. Normalizing into it is the whole product: an
AI asking "what is the user looking at" should not have to know whether the answer came from SQLite,
XML, an LSP stream, or a directory listing.

**`adapter.ts`** defines the contract and, importantly, `runAdapter`, which wraps every adapter in a
timeout and turns any failure into a *report* rather than an exception. A capture pokes at half a
dozen other programs' private files while they are being written to; something will eventually be
locked, missing, or in a format a version bump changed. One adapter failing must degrade the
snapshot, never abort it — an incomplete answer is useful and a stack trace is not.

**`redact.ts`** is covered in the README and in `ROADMAP.md`. The design point worth repeating here
is that it runs **once, over the assembled snapshot**, rather than inside each adapter: one place to
audit, one place the next adapter author cannot forget, one report covering everything.

**`budget.ts`** implements the documented reduction ladder. Two properties matter: it works on a
structural clone (the same capture is served to several consumers with different budgets, so a
destructive fit would make the second depend on the first), and it reports everything it dropped —
including saying so when the irreducible core still exceeds the budget, rather than quietly
returning something oversized.

**`snapshot.ts`** runs the adapters concurrently and merges them. One subtlety worth calling out: it
also *deduplicates workspaces out of the editor records*. Without that, every file tree and git
history is serialized twice — once under each editor that has the folder open, and once in the
merged list — which on a machine with two editors and nine projects was the single largest thing in
a snapshot and pure duplication.

## `languages/`

**`registry.ts`** identifies by exact filename, then shebang, then extension — in that order,
because `Dockerfile` must not be plain text and an extensionless script with
`#!/usr/bin/env python3` really is Python. Every language carries a **family**, and almost all
downstream logic branches on the family rather than the language: that is what makes an unfamiliar
language behave sensibly instead of falling off a switch statement.

**`data.ts`** genuinely parses the data and config formats. Real quoting in CSV, real indentation
scoping in YAML (including skipping block-scalar contents, which is the classic line-oriented YAML
mistake), tables versus arrays-of-tables in TOML. The `.env` reader is deliberately lossy: names
out, values never.

**`outline.ts`** handles the rest heuristically, grouping declaration *shapes* rather than
languages. The results are labelled `heuristic` and carry a note pointing at the LSP proxy, because
a tool that presents a guess with the same authority as a parse is worse than one that guesses
openly.

## `adapters/`

**`generic.ts`** is the floor: manifests (40+ ecosystems), file tree, language census, git. It
cannot tell you where the caret is and does not pretend to. Every other adapter uses its
`describeWorkspace`, so there is one implementation of "what is in this folder" and improvements to
it benefit everything.

**`vscode.ts`** covers the whole fork family from one string table, and contains the one genuinely
awkward piece of the project: reading the open-editor list out of `state.vscdb`, which is SQLite.
The options were a native binding (a compiled dependency, on a tool whose premise is having none),
reimplementing the file format (a large project to read one table), or extracting the JSON payloads
from the raw bytes. The third is what is there, it is labelled a hack in its own docs, it is
read-only, it fails closed, and values SQLite spilled to overflow pages are detected and discarded
rather than half-parsed. The layout lives in the **per-workspace** databases under
`workspaceStorage/<hash>/`, not the global one — which is the kind of thing you only learn by
looking.

**`jetbrains.ts`** can do something the VS Code adapter cannot: report the caret from disk, because
`.idea/workspace.xml` records it. Parsed with targeted regular expressions rather than a DOM, since
the file is megabytes and four attributes are wanted.

**`visualstudio.ts`** is deliberately scoped. The `.suo` file holding open-document state is an OLE
compound file with undocumented streams; parsing it properly is a project, and scraping strings out
of it would produce plausible-looking garbage. So it reads what it can read correctly — solutions,
projects, launch settings — and says plainly that live state needs an extension.

**`protocols.ts`** is the most universal mechanism here. The `MessageFramer` is a streaming decoder
because TCP and pipes split writes wherever they like; anything assuming one chunk per message works
in testing and fails under load. The proxy's contract is absolute: **forward every byte first,
observe a copy afterwards, and never let an observation error affect what was forwarded** — that
ordering is the entire safety argument for putting this in the middle of someone's editor.

**`push.ts`** inverts the direction: the editor posts to Auspex. The payload is deliberately
forgiving — every field optional, unknown fields ignored, paths in any form — because a strict
schema would mean every plugin has to be complete before it is useful, which is how integration
points die.

## `server/`

**`mcp.ts`** speaks JSON-RPC 2.0 over stdio, implemented directly rather than through an SDK,
consistent with having no dependencies. Two details that matter: logs go to **stderr** without
exception, because stdout is the protocol channel and one stray line corrupts the stream; and
captures are cached for two seconds, because an assistant routinely calls three or four tools in one
turn and re-scanning the disk for each would make one question take ten seconds.

The tool set is shaped by the questions an assistant has — "what is happening", "show me that",
"where is that", "what is broken" — rather than by mirroring the data model, which would be tidier
and far less useful.

**`http.ts`** binds loopback by default. That is a security decision, not a default: this server
hands out source, configuration and version-control state, and binding `0.0.0.0` on a laptop that
ever joins a public network would publish a developer's working context to it. A non-loopback bind
gets a bearer token whether or not one was requested.

**`gui.ts`** is one hand-written self-contained page. No framework, no bundler, no external
requests — which keeps the project's central promise (clone, run `node`, done) and works on the
offline machines this is most useful on.

## `cli/`

Every capability is reachable from the command line, which is deliberate: a connector that can only
be driven by an AI is impossible to debug. `capture` prints what would be sent, `watch` shows it
changing live, `mcp` is the same data behind the protocol — three views of one pipeline, which is
what makes it possible to tell whether a thin answer is the tool's fault or the environment's.

`doctor` exists for exactly that. "Nothing found" has half a dozen causes with different fixes, and
naming which one applies is far more useful than an empty snapshot.

The TUI is hand-rolled. Two details separate solid from scripted: the **alternate screen buffer**, so
the user's scrollback is untouched and their terminal is restored exactly; and **one write per
frame**, because drawing line by line tears visibly.

## Why no build step

Node 22.6+ strips type annotations at load, so `node src/cli/main.ts` just runs. Everything in the
codebase stays *erasable* — no enums, no parameter properties, no namespaces — enforced by
`erasableSyntaxOnly` in `tsconfig.json`, which exists purely for type-checking.

That is a real constraint accepted for a real payoff. A connector's whole value is being trivially
runnable next to whatever it is inspecting; a build step, a `node_modules` tree and a version-skew
surface are exactly the friction that stops a tool like this from being used.
