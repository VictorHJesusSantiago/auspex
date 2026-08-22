# What this does that an IDE debugger does not

An IDE debugger is built to **drive** a program: step, continue, inspect what is on screen right
now. Auspex is built to **record** one. Almost everything below follows from that single difference,
and where it does not, the difference is that Auspex is protocol-level and therefore has no reason
to care which language it is looking at.

This document is about the gap. [`DEBUG.md`](DEBUG.md) covers the capture itself and
[`AI-DEBUGGING.md`](AI-DEBUGGING.md) covers what an assistant receives.

---

## 1. Historical questions

Every debugger shows you the present. Step, and the previous state is gone. The questions people
actually have while debugging are mostly historical:

```bash
auspex debug trace retries          # every value it held, and where each changed
auspex debug find --kind empty      # every null anywhere in the session
auspex debug find user --value None # when was it null?
```

```
retries — present in 412 stop(s), changed 3 time(s)

  #   1  0            /app/client.py:88
  # 140  1            /app/client.py:88
  # 281  2            /app/client.py:88
  # 402  3            /app/client.py:88
```

That is a description of a bug, and no debugger can produce it — you would have to write the values
down while stepping. Runs of identical values are collapsed, so a variable that held `0` for four
hundred stops is one line rather than four hundred.

**The honesty rule here matters.** The live record is a bounded ring of twenty stops, and a search
of it that found nothing says so explicitly rather than reporting "never":

> no match across 20 stop(s) in the record
>   the live record holds 20 of 412 stop(s); search the journal for the whole session

Run the proxy with `--journal` and the same searches stream over the whole session, however large.

## 2. Values in any language, at any level of typing

DAP carries every variable as a name, a type string and **a value string the adapter chose to
print** — `repr()` in Python, `ToString()` in .NET, whatever formatter `lldb` has loaded. There is
no structured representation on the wire at all.

An IDE solves this with a renderer per language. That works, and it is also why an IDE's variable
pane looks bad the moment you point it at a language nobody wrote a renderer for.

Auspex interprets **the conventions rather than the languages**. Almost every runtime prints a
collection as brackets, a map as braces with `key: value` or `key => value`, a null as one of a
dozen well-known words, a pointer as `0x…`, an optional as a recognizable wrapper. Those
conventions are shared far more widely than the languages that use them.

```bash
auspex debug values
```

```
Locals
  user            empty       certain   None
                  the value is one of the well-known words for absence
  result          error       likely    Err(ConnectionRefused)
                  Err is the failure case
  pending         future      likely    Promise { <pending> }
                  a future in the pending state — this is not the data yet
  rows            collection  certain   [...]
                  50,000 entries · all int · range 0–4999 · 12 negative · sampled
  config          map         likely    {...}
                  shape { host: string; port: number; retries: number; tls: boolean }
```

Four things there that a debugger does not give you:

- **`Err(...)` reported as an error**, not an opaque object. A `Result` in its failed state is a
  failure sitting in a variable, and that is the most important thing about it.
- **A pending future marked as not being the data yet**, so a reader does not take `<pending>` for a
  value.
- **Fifty thousand elements described statistically** instead of the first hundred — and sampled
  from the start, middle *and* end, because a list that goes wrong usually goes wrong away from its
  head, which is exactly what a prefix hides.
- **A shape inferred for an untyped value**, recovering what a statically typed language would have
  given you for free.

Every interpretation carries a confidence and a reason, and **the debugger's own string is never
discarded**. An interpretation layer that overwrote a reliable fact with an unreliable guess would
be a bad trade.

### The judgement calls

- A string whose *contents* are the word `null` is not a null reference. Matched exactly.
- The **type wins over the formatting** when they disagree: a Python value of `[1, 2, 3]` with type
  `str` is a string that contains brackets.
- Angle brackets are not container syntax. `<generator object gen at 0x7f>` is a lazy sequence, not
  a one-element collection — a real bug this caught.
- A bare hexadecimal address is read as a pointer **before** the numeric test, because
  `0x7ffd4a2b1000` parses perfectly well as a number and a numeric test running first claims every
  address on the machine.
- `0x0` is an absence wearing a pointer's clothes, and is reported as empty.

## 3. Raw memory, read every way at once

A native debugger hands you 256 bytes and a hex view. Working out by eye whether they are a UTF-16
string, a length-prefixed buffer, an array of 32-bit integers or a struct full of pointers is slow,
error-prone work a machine should do.

```bash
auspex debug memory
```

```
0x7ffd4a2b1000 — 256 bytes
  [ 98%] C string (ASCII/UTF-8): "GET /v1/messages HTTP/1.1"
         25 character(s), 100% printable, NUL-terminated
  [ 71%] 64-bit pointers: 0x00007ffd4a2b1080 0x00007ffd4a2b10c0 …
         6 of 8 aligned words are in a plausible address range
```

Scores are **self-consistency, not truth** — several readings can be plausible at once, and the
module never picks for you. A confident wrong reading of memory sends someone chasing a corruption
that never happened.

It also names the patterns that are already an answer:

| Pattern | What it means |
|---|---|
| `0xCDCDCDCD` | uninitialized heap (MSVC debug fill) |
| `0xDDDDDDDD` | **freed heap — this is a use-after-free** |
| `0xFDFDFDFD` | a guard region past the end of an allocation — an overrun |
| `0xCCCCCCCC` | uninitialized stack |

Someone staring at a hex dump wondering why their struct is nonsense has, in those cases, already
found their bug — and will not find it if nothing says so.

Registers get the same treatment: the architectural roles named (`rip` is where execution is, `rsp`
is the stack), pointer-likeness marked, and every value also shown as a signed decimal — because a
counter that went below zero prints as `0xFFFFFFFFFFFFFFFF` and nobody recognizes that as `-1` by
eye, which is exactly the bug it usually is.

## 4. Threads, grouped rather than listed

An IDE presents threads as a list you scroll. That works at five and collapses at five hundred: a Go
server has thousands of goroutines, a JVM app server has hundreds, and a thread pool has forty
threads with *identical* stacks.

```bash
auspex debug threads
```

```
41 thread(s) in 2 group(s)
  1 running user code · 40 parked

  1× handleRequest   ◆ stopped ► user code
     handleRequest ← run
  40× parked, idle in a pool (ThreadPoolExecutor.getTask)
     LockSupport.park ← ThreadPoolExecutor.getTask
```

Forty rows become one, and the one thread doing something is first.

**Possible contention** is reported when several threads are blocked and none are running — with the
evidence, as a possibility, never as a claim. DAP does not carry lock ownership; no adapter reports
"thread 7 holds mutex A". So Auspex says what the shape is and names what would settle it (`jstack`,
`SIGQUIT`, `py-spy dump`, `~*k`), because reporting "deadlock detected" would be a confident guess
about the thing people are most likely to act on drastically.

> A real bug this caught: `LockSupport.park` was classified as a lock wait, and it is the JVM's
> universal parking primitive — an idle pool worker sits in it just as much as a blocked lock. Every
> idle Java application server would have reported forty threads "blocked on locks" with none
> running, which is precisely the contention signature. The fix requires the synchronizer frame
> (`AbstractQueuedSynchronizer`, `ReentrantLock`) to accompany it, which is what actually separates
> a lock wait from a nap.

## 5. A session you can send someone

"It crashes on my machine" survives because what one developer can see is exactly what does not
travel.

```bash
auspex debug bundle crash.json.gz --note "second request only"
auspex debug open crash.json.gz          # readable with no tooling at all
auspex debug compare working.gz broken.gz
```

A bundle carries the record, the analysis, **and the source around every frame** — a stack trace
pointing at `handler.py:42` is meaningless to someone whose checkout is a different commit, which is
the case almost by definition. It embeds a plain-text summary, so the recipient needs neither the
program nor Auspex. Gzipped, a real session is a couple of hundred kilobytes.

`compare` answers the question everyone actually asks of two captures: what is different between the
run that worked and the run that did not.

**Every bundle carries the same warning, every time**, because a bundle is meant to be shared and
the moment of writing it is the last moment its author can read it first: it contains source code
and program state, redaction matches known secret shapes, and it cannot catch application data.
`bundle` writes a file and never uploads or shares anything — that decision stays with the person.

## 6. The plugin: no setup at all

The hardest step in this whole tool has nothing to do with debugging. It is that the proxy has to go
between the editor and its debug adapter — one line of configuration, and a line most people cannot
write, because **they do not know what their editor runs.** VS Code launches adapters out of
extension directories with generated arguments.

`vscode.debug.registerDebugAdapterTrackerFactory` removes the problem rather than solving it. The
extension in `extensions/vscode/` registers a tracker for `'*'` — every adapter, including ones that
did not exist when it was written — and receives every DAP message with no configuration whatsoever.
Install it, press F5, and the capture happens.

Better than the proxy in four respects: no setup, every session (including ones started from a test
explorer or another extension), compound and child sessions the proxy cannot see because it sits on
one pipe, and session metadata the wire does not carry.

**And it cannot do the one thing the proxy exists for.** A tracker observes; there is no supported
way for it to issue its own requests. So it captures everything the editor's UI asked for, in full
fidelity with timing — and does *not* actively probe. Every payload it sends is stamped
`captureMethod: 'vscode-tracker'` with a note saying so, the analysis raises a finding about it, and
the briefing repeats it. Overstating this would be the worst error available here: a reader who
believes they are seeing the whole program state when they are seeing one collapsed pane will
conclude that a variable does not exist.

The honest recommendation:

- **Tracker** — zero setup, every session, everything the UI touched.
- **Proxy** (`--deep`) — when you need what nobody expanded: every scope of every frame, deep
  variable trees, memory, other threads.

The extension also withholds the `env` block of a launch configuration. That is where people put
database passwords, and it is not something a context tool should forward anywhere, even to
loopback. The variable *names* are kept, because knowing which variables a program was launched with
is useful and the names are not the secret.

## What it still does not do

- **It never writes to the debuggee.** No `setVariable`, no injected `evaluate`, no stepping. Auspex
  records; your debugger drives. This is permanent — see `ROADMAP.md`.
- **It cannot prove a deadlock**, for the protocol reason above.
- **Value interpretation is inference over formatted strings.** It carries a confidence and a
  reason, and the raw string is always there to disagree with.
- **Only VS Code has a tracker.** JetBrains, Neovim and the rest can use the proxy today; a native
  plugin for each is real work that is not done.
