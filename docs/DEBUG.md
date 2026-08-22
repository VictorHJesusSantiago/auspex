# Deep debug capture

Everything a running program will give up: threads, call stacks, scopes, every variable expanded,
raw memory, loaded modules, exceptions, breakpoints, program output, what changed between one stop
and the next, and the complete record of every message that crossed the wire in either direction.

```
auspex proxy --dap --deep -- <the debug adapter command your editor would have run>
auspex debug                 # print it
auspex debug --verbose --timeline --memory
```

---

## Why a passive proxy was not enough

Auspex's DAP proxy originally *watched* the traffic between an editor and its debugger. That gives
you exactly what the editor's user interface happened to ask for, and nothing else:

- nobody clicked the triangle next to an object → its children never crossed the wire;
- the Variables pane was collapsed → no `scopes` request was ever sent;
- the debugger stopped on a thread the UI was not showing → its stack was never fetched;
- the user never scrolled the call stack → only the top frames were requested.

Reporting that as "the state of the program" is reporting the shape of someone's *window*, not the
shape of their process. So the recorder is **active**: on every stop it issues its own DAP requests
and assembles a complete picture, whether or not anyone was looking at it.

## How that is safe

Injecting requests into someone's live debug session is a real intervention, and three rules make
it safe. All three are load-bearing and all three are tested.

**1. Private sequence numbers.** DAP correlates responses to requests by `request_seq`. Editors
number from 1. Auspex numbers from 1,000,000,000 — a session issuing a thousand requests a second
would need eleven days to reach it. Collision is impossible in practice, in either direction.

**2. Our responses never reach the editor.** An editor receiving a response to a request it never
sent is entitled to treat the stream as corrupt. Every probe sequence number is tracked until its
response arrives, and those responses are consumed rather than forwarded. This is the one reason
the deep path *decodes before forwarding* rather than forwarding first: once bytes have been
written to the editor they cannot be recalled. Frames that fail to decode are still forwarded
verbatim, so the proxy stays transparent even when the adapter emits something malformed.

**3. Nothing is ever written.** No `setVariable`, no `setExpression`, no `goto`, no `restartFrame`,
and no injected `evaluate` — which in most languages can run arbitrary code with side effects.
Reading is safe and repeatable; writing is neither. A tool that silently mutated a debuggee while
"just gathering context" would be indefensible. Evaluations that appear in the record are ones the
*user* performed, observed in passing.

Two further properties follow from the design rather than from rules: probing happens only between
a `stopped` event and the next `continued`, when the debuggee is frozen and inspection is free; and
a probe failure is contained — an adapter that rejects `readMemory` produces a warning and a
slightly thinner capture, never a broken session.

`--deep` is **opt-in** rather than the default for `--dap`, deliberately. A proxy that silently
started interrogating someone's debugger because they asked it to watch would be taking a decision
that is theirs to take.

## What gets captured

| | |
|---|---|
| **Threads** | All of them, with the stopped one marked |
| **Stacks** | The stopped thread in full (50 frames), plus up to 4 other threads |
| **Scopes** | Every scope of the top 5 frames — Locals, Arguments, Globals, Registers, Closure |
| **Variables** | Expanded recursively, 4 levels deep, 100 per level, 250 requests per stop |
| **Memory** | `readMemory` behind every variable carrying an address, as base64, hex dump and printable text |
| **Disassembly** | 32 instructions around the instruction pointer |
| **Exceptions** | Type, message, break mode, the exception's own stack trace, chained causes |
| **Breakpoints** | Line, function, data, exception and instruction — with the condition the user set *and* whether the debugger could bind it |
| **Modules** | Name, path, version, symbol status, optimization, address range |
| **Output** | Every line, categorized (stdout, stderr, console, important) |
| **The wire** | Every message, both directions, with size and round-trip timing |
| **Changes** | Between consecutive stops: frames entered and left, variables added, removed, changed — and how many held |

### The limits, and why they exist

Two independent reasons, both real.

**Termination.** A variable graph can be genuinely infinite — a circular reference, a linked list, a
DOM node. Depth alone does not bound it, so cycles are detected by `variablesReference` rather than
by value.

**Courtesy.** Every probe is a round trip to a debug adapter that is *also* serving the user's
editor. A recorder that fired a thousand requests on every step would make stepping feel broken,
which is a far worse outcome than a slightly shallower capture. An adapter that marks a scope
`expensive` is telling us reading it is slow, and that is honoured rather than overridden.

Everything cut short says so — `truncated: 'circular reference'`, `skipped: 'the adapter marked
this scope expensive'`, `incomplete: ['memory reads stopped at the time budget']`. A tree that
simply ended would look like a leaf, and an assistant told that `config` is `{}` when it is really
forty keys deep will confidently draw the wrong conclusion.

## How it reaches the other processes

The recorder lives inside the proxy — the only process on the adapter's wire — while `auspex
serve`, the MCP server and `auspex debug` are separate processes started at different times.

They are bridged by a JSON file in the temp directory, written once a second and once more when the
session ends. No protocol, no port, no daemon, and it survives the reader starting late. Pushing to
a running server (as the proxy already does for diagnostics) was rejected because it only works
when a server happens to be running *and* was started first.

**The record is redacted before it is written**, not on read. A debug session's variables are about
the most secret-dense thing on a developer's machine — decrypted tokens, connection strings, request
bodies, the very environment variables the redactor exists to hide. Writing them unredacted to a
world-readable temp directory to redact them later would be indefensible. Redaction applies the
key-name policy as well as the value patterns, because in a debug record the name is often the only
evidence there is: a variable called `password` holding `hunter2` matches no value pattern at all.

## Reaching it from an assistant

The shapes an assistant reads, and the reasoning behind them, are in
[`AI-DEBUGGING.md`](AI-DEBUGGING.md). In brief:

**MCP** (Claude, and anything else that speaks it):

| Tool | Answers |
|---|---|
| `get_debug_session` | "What is the program doing right now?" |
| `get_debug_variables` | "What is `retries` at this point?" — filtered, full-depth |
| `get_debug_changes` | "What changed since the last breakpoint?" |
| `get_debug_timeline` | "What did the editor ask for, and what did the debugger answer?" |
| `read_debug_memory` | "What is actually in that buffer?" |
| `get_debug_briefing` | The opening move — prose, a fraction of the size, usually enough |
| `get_debug_analysis` | Observations with evidence, as a second opinion |
| `get_debug_history` | "What happened before it crashed?" — needs `--journal` |
| `get_debug_wiring` | "How do I capture this project?" — reads the launch configurations |

**HTTP** (GPT, Gemini, anything with function calling — described in `/openapi.json`):

```
GET /debug?timeline=true&memory=true
GET /debug/changes?count=3
GET /debug/sessions
```

Each tool answers with instructions rather than an empty object when nothing has been captured. "No
debug session" with no further help is the kind of dead end that makes a tool look broken when it is
merely unconfigured.

## Scope boundaries

- **Adapters vary in what they support**, and probes are gated on the `capabilities` the adapter
  declares in its `initialize` response rather than discovered by trial. Managed runtimes
  (`debugpy`, `node`, `coreclr`) generally do not report memory addresses; native ones (`lldb`,
  `gdb`, `cppdbg`) do. When memory is empty, the tools say which of the two reasons applies.
- **Only the top frame's variables are diffed** between stops. Comparing across frames whose
  identity changed would report every local in every frame as both added and removed — noise, not a
  diff.
- **The timeline is a bounded ring** (2,000 entries). When it has evicted anything, it says so; the
  session totals are counted separately and survive the eviction.
- **One session at a time per proxy.** A user debugging two programs at once runs two proxies, and
  each publishes under its own `--session` name.
- **The journal is opt-in** (`--journal`). It is durable, holds the program's variables, and grows
  with every stop; writing one by default would leave a developer's state on disk after every debug
  run without them ever asking for it.
- **Auspex does not diagnose.** `debug analyze` surfaces facts with their evidence and stops there.
  See `AI-DEBUGGING.md` for why that line is drawn where it is.
