# Debugging with an AI

How Auspex hands a paused program to an assistant, and the reasoning behind each choice.

The deep capture itself is documented in [`DEBUG.md`](DEBUG.md) — what it takes and why injecting
requests into a live session is safe. This is about the other half: what a model actually receives,
and why that shape rather than the obvious one.

---

## The problem with handing over the JSON

A captured stop is a graph — threads containing frames containing scopes containing variables
containing variables. Serialized, that graph spends most of its size on structural punctuation and
repeated keys, and it makes a reader hold the nesting in mind while navigating it. A single frame of
a Java or .NET program routinely carries several hundred variables once expanded; a fifty-frame
stack across five threads can serialize past a million tokens.

So Auspex offers three shapes, and the difference between them is the difference between a useful
answer and a wasted call.

| | Size | Use it when |
|---|---|---|
| **`get_debug_briefing`** | ~1–6k tokens | **Start here.** Any question about a running or crashed program. |
| `get_debug_variables` | ~100 tokens | You know which value you are chasing. |
| `get_debug_session` | 5k–100k+ | You need the whole structure — walking an object graph. |

Every tool description says this explicitly, including which tool to prefer over which. A model
picks a tool from its description and nothing else, so a description that says only what a tool
*returns* leaves the choice to chance.

## What the briefing contains, in order

1. **A headline** that answers the question on its own — adapter, reason, function, file, line, the
   source of that line, and how many frames are the project's own.
2. **Observations worth reading first**, each with its evidence.
3. **The stack**, with `►` marking the project's own frames.
4. **The source** around the first of those frames.
5. **The values** in that frame.
6. **What changed** since the previous stop.
7. **Program output.**
8. **Breakpoints**, with unbound ones called out.
9. **The limits of the capture.**

Ordered so a model that stops reading halfway still has the useful part.

## Observations, not diagnoses

`analysis.ts` does **not** diagnose bugs, and the restraint is deliberate rather than a missing
feature. Knowing that `user` is `None` at the line that dereferences it does not tell you whether
the bug is the dereference, the lookup that returned nothing, or the caller that passed the wrong
id. Producing a confident "the bug is X" from that would be guessing dressed as analysis, and a
wrong diagnosis costs more than no diagnosis, because it directs attention away from the real cause
exactly when attention is most expensive.

What it does instead is surface the facts that are usually relevant and easy to miss:

| Finding | Why it earns a place |
|---|---|
| `empty-value-in-use` | A null **named on the executing line**. The correlation is the value. |
| `unverified-breakpoints` | A breakpoint that never bound never fires. The single largest time sink in debugging. |
| `user-code-depth` | Your code is at frame 4 of 40. Turns a scroll into a glance. |
| `recursion` | Escalates past 20 frames — near where most runtimes overflow. |
| `no-change` | Two stops, nothing moved. The code between them had no effect; did it take the branch you expected? |
| `repeated-stop` | The 400th hit of a loop breakpoint. Suggests a condition. |
| `scope-skipped` | A scope was not captured, and why. Prevents reading an absence as a fact. |
| `adapter-errors` | The adapter is rejecting requests; the capture is thinner than it looks. |

**Every finding carries its evidence.** A model that disagrees can check it — which is the property
that makes this an aid rather than a source of confident errors. An unattributed finding is an
opinion, and a reader cannot check an opinion.

Severity means *how likely this is to be what you are looking for*, never how bad the program's
state is.

### The judgement calls, stated

- A string whose **contents** are the word `null` is not a null reference. Matched exactly, not by
  substring.
- An **empty collection** is weak evidence — it is usually correct. Recorded for correlation with
  the executing line, never raised on its own.
- A variable is only raised as `empty-value-in-use` when the executing line **mentions it as a whole
  word**, and single-character names are excluded because `i` matches everything and says nothing.
- A frame with **no path at all** is classified as runtime; a frame whose path matches no known
  runtime fragment is classified as the user's. Being wrong generously shows one extra frame; being
  wrong strictly hides the line the bug is on. Only one of those is recoverable.

## The context budget

`ai/debug-budget.ts` reduces a record through a documented, deterministic ladder — twelve steps,
each re-measured, stopping as soon as it fits, every step reported.

The priorities are the opposite of a snapshot's. There, the open file matters most. Here, **the
stopped frame's own values matter most**, and the fiftieth frame matters barely at all — but the
*shape* of the stack still does, so frames beyond the top ten are collapsed to names rather than
deleted. A reader who cannot see there were forty frames will misjudge what they are looking at.

Step 12 is the irreducible core: why it stopped, where, and what the values are there. **If that
alone exceeds the budget, the result says so rather than cutting into it.** A truncated variable
list presented as complete is how a reader draws a confident wrong conclusion, and a budget is never
a good enough reason to cause that.

`auspex debug size` shows where a record's size is going, because the answer is usually a
surprise — one deeply nested object, or a thread nobody was looking at.

## Closing the configuration gap

Deep capture needs Auspex between the editor and its debug adapter. That is one line of
configuration, and it is the hardest step in the whole tool — not because it is complicated, but
because **the user usually does not know what their editor runs.** VS Code launches adapters out of
extension directories with generated arguments; the command appears nowhere a person would look.

So every debug tool that finds no session points at `get_debug_wiring` rather than repeating the
generic instruction the user already could not act on. That tool reads `.vscode/launch.json` (JSONC,
because the file VS Code generates contains comments by default), JetBrains run configurations, and
`.idea/workspace.xml`, works out which adapter each implies, and answers in one of three labelled
ways:

- **exact** — the adapter is a real command (`dlv dap`, `python -m debugpy.adapter`). Copy and paste.
- **pattern** — it lives inside an editor extension with generated arguments. Auspex names the
  extension and offers the socket route, and **does not print a command**, because emitting a
  confident-looking one that fails would be blamed on the user.
- **manual** — an unrecognized adapter, which does not mean it will not work: deep capture is
  protocol-level and adapter-agnostic.

With no configuration at all, it recommends by language.

## History past the ring buffer

The live record keeps twenty stops. A program that stopped four hundred times before failing has
lost the interesting ones by the time anyone looks.

`auspex proxy --dap --deep --journal` writes an append-only NDJSON record that never rewrites
anything. A process killed mid-session leaves a journal complete up to the moment it died — which is
exactly when it is most valuable — losing exactly one line, always the last. `get_debug_history`
reads any range of stops back out.

NDJSON rather than a JSON document because a document cannot be appended to: every write would
rewrite the file, which is quadratic for a long session and leaves a crashed process with something
that will not parse at all.

The journal is **opt-in**. It is durable, it holds the program's variables, and it grows with every
stop; writing one by default would leave a developer's state on disk after every debug run without
them ever asking.

## Adapter differences are facts, not failures

Asking `debugpy` for a memory address is not a bug — CPython objects have no stable one. So
`debug/registry.ts` records what each adapter can do, and an empty memory capture is explained with
the right one of three genuinely different reasons:

- the adapter can read memory, but no variable at this stop carried an address;
- this runtime does not expose addresses at all;
- the adapter never advertised the capability.

Conflating them is how a tool teaches someone the wrong thing about their own runtime. When a
session is live, the adapter's own `capabilities` always wins; the table is what makes an answer
possible before a session starts and after it ends.

## Reaching it

**MCP** — `get_debug_briefing`, `get_debug_analysis`, `get_debug_session`, `get_debug_variables`,
`get_debug_changes`, `get_debug_timeline`, `get_debug_history`, `read_debug_memory`,
`get_debug_wiring`.

**HTTP + OpenAPI** — the same at `/debug/*`, described in `/openapi.json`.

**Generated tool definitions** for assistants that need schemas supplied with every request:

```bash
auspex debug tools openai     # {"type":"function","function":{...}}
auspex debug tools gemini     # defaults stripped: Gemini's dialect rejects them
auspex debug tools claude     # input_schema, for the Messages API directly
```

All three come from one description, so a fix to a tool description happens once instead of three
times.

**Terminal**, for checking any of it by hand:

```bash
auspex debug report --max-tokens 4000   # the briefing
auspex debug analyze --verbose          # the findings, with evidence
auspex debug source                     # source around every frame
auspex debug wire                       # how to capture this project
auspex debug history --replay           # the whole journal
auspex debug size                       # where the tokens are going
```
