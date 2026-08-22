# Roadmap

Kept current, not aspirational. Every item below is either a permanent, deliberate scope boundary
(stated as such) or genuine follow-up work not yet done — the distinction matters, and the two are
listed separately.

## Deliberate, permanent scope boundaries

- **Auspex never calls an AI API and holds no keys.** It produces payloads; the user's own assistant
  consumes them. Calling providers directly would make this a client for one vendor rather than a
  connector for all of them, and it would mean asking a developer to hand their credentials to a
  context-extraction tool.
- **No runtime dependencies, and therefore no build step.** Node strips the type annotations at
  load. That rules out things a dependency would give cheaply — a real SQLite reader, tree-sitter
  parsers, a TUI framework — and each of those trade-offs is documented where it bites. It is
  accepted because a connector's whole value is being trivially runnable next to whatever it is
  inspecting.
- **Visual Studio's `.suo` file is not parsed.** It is an OLE compound file holding undocumented,
  version-specific binary streams. Implementing the container *and* reverse-engineering the streams
  to reach the open-document list is a project of its own, and scraping strings out of it would
  produce plausible-looking garbage. Live Visual Studio state needs an extension; the adapter says
  so rather than guessing.
- **Read-only, always.** Nothing here writes to an editor's configuration, modifies a file, or
  drives an editor's behaviour. A tool that both reads your environment and changes it is a much
  larger thing to trust.
- **The HTTP server binds loopback unless deliberately widened**, and a non-loopback bind requires a
  bearer token whether or not one was asked for. The payload is a developer's source tree; there is
  no defensible looser default.
- **No telemetry of any kind.**
- **Deep debug capture never writes to the debuggee.** No `setVariable`, no `setExpression`, no
  `goto`, no `restartFrame`, and no injected `evaluate` — which in most languages runs arbitrary
  code with side effects. Reading a paused program is safe and repeatable; writing to it is neither,
  and a tool that mutated a debuggee while "just gathering context" would be indefensible. See
  `DEBUG.md`.
- **`--deep` is opt-in rather than the default for `--dap`.** Deep mode issues its own requests into
  a live debug session. That is safe, but it is not *nothing*, and a proxy that silently started
  interrogating someone's debugger because they asked it to watch would be taking a decision that is
  theirs to take.

## Genuine follow-up work (not done, not permanently cut)

- **Only one editor plugin ships.** The VS Code extension is complete and works; JetBrains, Neovim,
  Emacs, Sublime and Visual Studio plugins are all described in `ADAPTERS.md` and none are written.
  The push protocol is deliberately forgiving so that each is a small job, but small is not zero.
- **The VS Code SQLite reader depends on a storage detail rather than an interface.** Extracting
  JSON payloads from the raw database bytes works, is read-only and fails closed, but a change to
  how SQLite lays out text payloads — or a VS Code change to how the editor grid is serialized —
  would break it silently. Values spilled to overflow pages already come back truncated and are
  discarded. A proper fix is either a WebAssembly SQLite build (a dependency, but a portable one) or
  relying on the extension for that data.
- **Symbol outlines for programming languages are heuristic.** Pattern matching over declaration
  shapes finds most top-level declarations in ordinary code and misses unusual formatting. Real
  parsing means tree-sitter (a native dependency) or the LSP proxy (already implemented, but needs
  the user to reconfigure their editor). The results are labelled `heuristic` everywhere they
  appear, which is the honest interim answer rather than a fix.
- **YAML and TOML are parsed for structure, not fully.** Anchors and aliases, multi-document
  streams, tagged types, flow-style collections spanning lines and TOML's full datetime grammar are
  all skipped rather than guessed at. Sufficient for an outline; not a general-purpose parser.
- **The token estimate is characters ÷ 4.** The well-known rule of thumb, labelled an estimate
  everywhere it appears. A real per-provider tokenizer would be a large dependency for a number that
  only has to be good enough to decide what to drop.
- **True context *streaming* is not implemented.** `/events` announces that something changed and
  the consumer asks for the new state, which keeps a chatty editor from pushing megabytes down every
  open connection. Pushing incremental diffs of a snapshot would be better for a live consumer and
  is real work.
- **Search is in-process, not ripgrep.** Slower on a large monorepo, capped at 4,000 files. Shelling
  out to an external binary would be faster and would be exactly the kind of dependency that works
  on the author's machine and not the user's.
- **No Windows-specific process elevation handling.** A process running at a higher integrity level
  than Auspex is invisible to process discovery, which affects an editor launched as administrator.
  Detected as "no editor found" rather than explained.
- **The GUI is read-only.** It shows what was captured and lets you copy it. Editing capture
  settings, pinning workspaces or triggering a proxy from the browser are all reasonable and none
  exist.

- **Deep debug capture is bounded, and the bounds are visible rather than silent.** Four levels of
  variable depth, 100 children per level, 250 variable requests and eight seconds per stop, five
  frames with scopes, four threads besides the stopped one. Two independent reasons: a variable
  graph can be genuinely infinite, and every probe is a round trip to an adapter that is also
  serving the user's editor. Deeper capture is possible — the limits are a constructor argument —
  but the defaults will not be raised, because a recorder that makes stepping feel broken is worse
  than a slightly shallower one. Everything cut short says where and why.
- **Value interpretation is inference over formatted strings, and says so.** DAP carries no
  structured values at all — only whatever the adapter chose to print. Auspex matches the
  conventions shared across runtimes rather than shipping a renderer per language, which is what
  lets it say something useful about a language it has never heard of. Every interpretation carries
  a confidence and a reason, and the debugger's own string is never discarded: overwriting a
  reliable fact with an unreliable guess would be a bad trade whatever the guess.
- **Memory readings are scored for self-consistency, never for truth.** Several readings of the same
  bytes can be plausible at once, and the decoder never picks one. A confident wrong reading of
  memory sends someone chasing a corruption that never happened.
- **Deadlocks cannot be proven, only shaped.** DAP does not carry lock ownership; no adapter reports
  which thread holds which mutex. Auspex reports the *signature* — several threads blocked, none
  running — as a possibility with its evidence, and names the runtime-specific tool that would
  settle it. "Deadlock detected" would be a confident guess about the thing people are most likely
  to act on drastically.
- **A bundle is written, never sent.** `debug bundle` produces a file and does not upload, share or
  transmit it. It carries source code and program state, it says so at the top every time, and what
  happens to it is the user's decision rather than the tool's.
- **The VS Code tracker cannot probe, and every payload says so.** A debug adapter tracker observes;
  there is no supported way for it to issue its own requests. It is stamped
  `captureMethod: 'vscode-tracker'`, the analysis raises a finding about it, and the briefing
  repeats it — because a reader who believes an absent variable does not exist, when really nobody
  expanded it, will act on that.
- **Auspex reports observations about a debug session, never diagnoses.** `debug analyze` says
  "`user` is `None` and appears on the executing line" and attaches the evidence; it does not say
  "the bug is on line 42". It cannot: the same fact is consistent with a broken dereference, a
  lookup that returned nothing, or a caller passing the wrong id. A confident wrong diagnosis
  directs attention away from the real cause exactly when attention is most expensive, which costs
  more than saying nothing. Every finding carries its evidence so that a reader who disagrees can
  check it.
- **The adapter registry is a fallback, never the authority.** When a session is live, the
  adapter's own advertised `capabilities` win in every case. The table describes the version that
  existed when it was written; it earns its place by making an answer possible before a session
  starts and after it ends, which is when capabilities are unavailable.
- **`debug wire` refuses to invent a command it cannot verify.** For adapters that live inside an
  editor extension with generated arguments, it names the extension and offers the socket route
  rather than printing a plausible command. A confident-looking command that fails would be blamed
  by the user on themselves.
- **Only the top frame's variables are diffed between stops.** Comparing across frames whose
  identity changed between two stops would report every local in every frame as both added and
  removed, which is noise rather than a diff.

- **Source context is read from disk, not from the debug adapter.** DAP can serve source the
  adapter holds in memory, but for ordinary files the disk copy is what the developer is editing
  and what an assistant will be asked to change. Where the two differ — a stale build, an unsaved
  buffer — that difference is itself diagnostic, and the reader marks it rather than hiding it. A
  frame whose line number is past the end of its file is reported as "the running code does not
  match the file on disk", because every conclusion drawn from reading that file would be wrong.

- **Only VS Code has a native debug tracker.** Every other editor uses the proxy, which works
  everywhere and needs a line of configuration. A JetBrains, Neovim or Emacs equivalent is real work
  that is not done.

## Real bugs the tests and the build caught, and how each was fixed

Kept as evidence the suites are load-bearing rather than decorative.

1. **The VS Code open-editor list was being read from the wrong database.** The global
   `state.vscdb` was scanned for editor state and turned up nothing but notebook registrations; the
   layout lives in the **per-workspace** databases under `workspaceStorage/<hash>/`, keyed on
   `editorpart.state`. Found by instrumenting the file directly after the adapter reported 118
   workspaces and zero documents. Fixed by scanning the per-workspace databases newest-first, and
   walking the serialized editor grid rather than scraping URIs — which also gained the editor group
   and the active tab, neither of which the raw URIs carry.
2. **Every workspace was serialized twice in every snapshot.** Each editor carried full `Workspace`
   objects *and* the merged `snapshot.workspaces` carried them again, so every file tree and git
   history appeared once per editor plus once more. On a machine with two editors and nine projects
   this was the single largest thing in a snapshot and pure duplication; a `get_context` call with
   an 8,000-token budget was arriving at 39,707 tokens after the budget ladder had run out of things
   to drop. Fixed by reducing each editor's `workspaces` to `{ root, name }` references after the
   merge.
3. **The JetBrains XML reader did not match the real file format.** It looked for `url="…"`
   attributes and a `<state line=…>` element; actual `workspace.xml` files use a nested
   `<entry file="…">` and a `<caret line=… column=…/>`. Caught by a fixture test that was itself
   written against the invented shape — the fix was to correct *both*, the implementation to the
   real format and the fixture to a real file's structure.
4. **The redactor double-counted and mislabelled nested secrets.** An OpenAI key inside an
   `api_key = "…"` assignment was caught first by the specific rule and then again by the generic
   one, which overwrote the specific rule's name with the vaguer one in the report — losing the most
   useful part of it. Fixed by refusing to redact anything already containing a redaction marker.
5. **`staleAfterMs = 0` meant "never stale" rather than "always stale".** A strict `<` comparison
   against a cutoff computed in the same millisecond is always false. Caught by the test that set it
   to zero expecting immediate expiry. Fixed with an elapsed-time comparison that reads the way the
   setting does.
6. **The unrecognized-editor catch-all reported `.dll` files and installation directories as
   workspaces.** A .NET language server's command line is full of absolute paths, and the first fix
   (require a directory) was not enough because those directories contain `package.json`. Fixed by
   also excluding tool paths — `node_modules`, `extensions`, `AppData`, `Program Files`,
   `site-packages` and the package caches — which is the distinction that actually matters: a
   directory belonging to a tool is never the user's project.
7. **The Elixir, Clojure and Erlang families produced empty outlines.** The declaration patterns
   covered C-family and ML-family keywords and nothing else, so `defmodule`, `defn` and `-module`
   found nothing. Caught by a test that deliberately spans unrelated languages. Fixed by adding
   pattern entries for those keywords rather than loosening the existing patterns, which would have
   produced false matches everywhere else.
8. **The type-checker found four real errors the runtime never would have.** `fillGaps` was
   constrained to `Record<string, unknown>`, which the model's interfaces do not satisfy — forcing a
   cast at every call site and hiding the fact that one of them was structurally wrong. Fixed by
   constraining to `object` and keeping the one unavoidable cast inside the function that actually
   does the structural walk. (`node --test` passes without type-checking, which is exactly why
   `npm run typecheck` is a separate, required step.)
9. **`auspex proxy` never exited after its language server did.** The stdio proxy attaches a
   listener to `process.stdin`, which keeps Node's event loop alive; the child's exit resolved the
   promise and the process then sat there forever instead of returning the child's exit code. Found
   by running the proxy against a real (if small) language server process rather than against a
   unit-test double — the framing tests all passed, because none of them owned the event loop.
   Fixed by having `createStdioProxy` return a detach function that removes both listeners and
   pauses stdin, called on the child's `exit` and `error`.
10. **The deep DAP proxy would have dropped any frame it could not parse.** Deep mode has to decode
   before forwarding — a probe response cannot be un-sent once it has reached the editor — and the
   framer silently skipped frames whose body was not valid JSON, which was correct when the caller
   forwarded raw bytes separately and became a transparency hole the moment forwarding moved
   per-frame. An adapter emitting one malformed message would have had it vanish rather than pass
   through. Fixed by adding `pushRaw`, which returns every complete frame with `message` left
   undefined when the body will not parse, so the bytes are still forwarded verbatim. Caught by
   writing the test for the transparency contract rather than for the happy path.
11. **An idle Java thread pool was reported as a possible deadlock.** `LockSupport.park` was listed
   as a lock-acquisition frame, and it is the JVM's *universal* parking primitive: an idle
   `ThreadPoolExecutor` worker sits in it exactly as much as a genuinely blocked lock does. Every
   idle Java application server would therefore have produced forty threads "blocked on locks" with
   none running — which is precisely the contention signature, and the most alarming thing the
   module can say. Caught by a test that built a realistic pool stack rather than an invented one.
   Fixed by requiring a synchronizer frame (`AbstractQueuedSynchronizer`, `ReentrantLock`,
   `Semaphore`) to accompany the park, which is what actually distinguishes a lock wait from a nap;
   a second test pins the real lock wait so the fix cannot go too far the other way.
12. **A bare hexadecimal address was reported as a scalar, and a repr as a collection.** Two
   ordering mistakes in the value interpreter, both found by testing against what real runtimes
   print. `0x7ffd4a2b1000` parses perfectly well as a number, so the numeric test running before the
   pointer test claimed every address on the machine; and angle brackets were treated as container
   syntax, so `<generator object gen at 0x7f>` came back as a one-element collection instead of a
   lazy sequence. Fixed by moving the pointer test first under a condition narrow enough not to
   claim ordinary hex integers, and by removing `<>` from the container pairs — in practice it is
   generic-parameter or repr syntax far more often than it is a container.
13. **A display cap was corrupting a statistic.** Thread groups list at most twenty members for
   readability, and the activity distribution was counting that capped list — so a forty-thread pool
   reported as twenty parked threads. A presentation decision silently altering a number is the
   worst kind of quiet wrong. Fixed with a separate `totalThreads`, and the contention check now
   counts real membership too.
