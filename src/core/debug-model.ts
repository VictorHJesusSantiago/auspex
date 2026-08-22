/**
 * The full debug model: everything a running, paused or terminated program exposes.
 *
 * This is a much larger vocabulary than the rest of the model needs, and it earns the space. A
 * paused process is the single richest thing Auspex can observe — threads, frames, scopes, variable
 * graphs, raw memory, registers, loaded modules, exception detail, every kind of breakpoint, and the
 * chronological record of everything that crossed the wire. An assistant asked "why is this
 * `null` here" needs the variable graph; asked "why did it stop" needs the exception; asked "what
 * changed since the last breakpoint" needs a diff between two stops.
 *
 * **Everything here comes from the Debug Adapter Protocol**, which every modern editor speaks for
 * every debugger it drives. That is what makes this language-agnostic: the same shapes describe a
 * paused Node process, a .NET process under `coreclr`, Python under `debugpy`, and native code
 * under `lldb` — including registers and raw memory, which only the native adapters report but
 * which the model carries uniformly.
 *
 * See `adapters/debug.ts` for how it is filled in, and in particular for why the proxy has to issue
 * its own requests rather than only watching the editor's.
 */

/** A thread in the debuggee. */
export interface DebugThread {
  id: number;
  name: string;
  /** True for the thread that is stopped and being inspected. */
  stopped?: boolean;
  /** Why this particular thread stopped, when the adapter distinguishes per-thread reasons. */
  stoppedReason?: string;
}

/**
 * One frame of a call stack.
 *
 * Richer than a name and a line because the extra fields are what make a stack readable: the
 * `presentationHint` marks frames the debugger considers noise (runtime internals, generated code),
 * and `instructionPointerReference` is what a disassembly or a memory read anchors to.
 */
export interface DebugStackFrame {
  id: number;
  name: string;
  file?: string;
  /** Source name when there is no file — `<eval>`, a generated module, an unmapped frame. */
  sourceName?: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  /** `normal`, `label`, or `subtle` — the adapter's own hint about whether this frame matters. */
  presentationHint?: string;
  /** True when the debugger could not map this frame to source it can show. */
  unmapped?: boolean;
  /** The module this frame's code came from. */
  moduleId?: string | number;
  /** Opaque address reference, usable with `readMemory` and `disassemble`. */
  instructionPointerReference?: string;
  /** Whether this frame can be restarted — worth knowing before suggesting it. */
  canRestart?: boolean;
}

/**
 * A scope within a frame: `Locals`, `Arguments`, `Globals`, `Registers`, `Closure`, `Static`.
 *
 * The set differs per language and per adapter, which is exactly why this is a list with a name
 * rather than a fixed set of fields. `expensive` matters: an adapter marks a scope expensive when
 * fetching it is slow (a global scope with thousands of entries), and the recorder honours that
 * rather than hanging a debug session to be thorough.
 */
export interface DebugScope {
  name: string;
  /** `arguments`, `locals`, `registers`, `returnValue`, or an adapter-specific string. */
  presentationHint?: string;
  /** True when the adapter warns that reading this is costly. */
  expensive?: boolean;
  /** How many entries the adapter says it holds, before any are fetched. */
  namedVariables?: number;
  indexedVariables?: number;
  /** Source location, for scopes that have one (a closure's defining site). */
  file?: string;
  line?: number;
  variables: DebugVariable[];
  /** Set when the scope was not fetched, saying why. */
  skipped?: string;
}

/**
 * A variable, with everything the protocol offers about it.
 *
 * `memoryReference` is the bridge to raw memory: a variable that has one can be read byte by byte,
 * which is how a native debugger answers "what is actually in that buffer".
 */
export interface DebugVariable {
  name: string;
  value: string;
  type?: string;
  /** An expression that re-evaluates to this variable — what a watch expression would use. */
  evaluateName?: string;
  /** `property`, `method`, `class`, `data`, `event`, `baseClass`, `virtual`, `dataBreakpoint`. */
  kind?: string;
  /** `static`, `constant`, `readOnly`, `rawString`, `hasObjectId`, `canHaveObjectId`, `hasSideEffects`. */
  attributes?: string[];
  /** `public`, `private`, `protected`, `internal`, `final`. */
  visibility?: string;
  /** True when the value can be changed from the debugger. */
  writable?: boolean;
  /** Counts the adapter reported, which is how a truncated collection is detected. */
  namedVariables?: number;
  indexedVariables?: number;
  /** Address for `readMemory`. Present mostly on native adapters. */
  memoryReference?: string;
  children?: DebugVariable[];
  /** Set when children exist but were not fetched: a depth cap, a cycle, or a budget. */
  truncated?: string;
}

/**
 * A block of the debuggee's memory.
 *
 * Both encodings are kept deliberately. `hex` is what a person reads; `text` is the printable-ASCII
 * rendering that makes a string or a struct recognizable at a glance; `base64` is the exact bytes,
 * so nothing is lost to either presentation.
 */
export interface DebugMemory {
  /** The reference this was read from — a variable's `memoryReference` or a frame's pointer. */
  reference: string;
  /** Resolved address the adapter reported. */
  address?: string;
  /** Offset from the reference, when one was requested. */
  offset?: number;
  /** Bytes the adapter could not read, reported rather than silently zero-filled. */
  unreadableBytes?: number;
  byteCount: number;
  base64: string;
  hex: string;
  /** Printable characters, with unprintable bytes shown as `.` — the classic hex-dump right column. */
  text: string;
}

/** A disassembled instruction. */
export interface DebugInstruction {
  address: string;
  instruction: string;
  /** Raw bytes of the instruction, when the adapter supplies them. */
  bytes?: string;
  symbol?: string;
  file?: string;
  line?: number;
}

/** A module or shared library loaded into the debuggee. */
export interface DebugModule {
  id: string | number;
  name: string;
  path?: string;
  version?: string;
  /** Whether symbols were found — the usual reason a stack is unreadable. */
  symbolStatus?: string;
  symbolFilePath?: string;
  isOptimized?: boolean;
  isUserCode?: boolean;
  addressRange?: string;
}

/** A source file the debugger knows about, including ones with no file on disk. */
export interface DebugLoadedSource {
  name: string;
  path?: string;
  /** `normal`, `emphasize`, `deemphasize`. */
  presentationHint?: string;
  /** Set for sources the adapter holds in memory rather than on disk (eval, generated code). */
  sourceReference?: number;
}

/** Detail about the exception that stopped execution. */
export interface DebugExceptionInfo {
  exceptionId: string;
  description?: string;
  /** `never`, `always`, `unhandled`, `userUnhandled` — why the debugger broke on it. */
  breakMode?: string;
  message?: string;
  typeName?: string;
  /** The exception's own stack trace, as a string, which is often more precise than the frames. */
  stackTrace?: string;
  /** A nested cause, for languages that chain exceptions. */
  innerException?: DebugExceptionInfo;
}

/** Every kind of breakpoint the protocol defines, in one shape. */
export interface DebugBreakpoint {
  /** `line`, `function`, `data`, `exception`, `instruction`. */
  kind: 'line' | 'function' | 'data' | 'exception' | 'instruction';
  id?: number;
  /** True when the debugger bound it to real code. An unverified breakpoint never fires, and not
   * knowing that is one of the most common sources of confusion in a debug session. */
  verified?: boolean;
  /** Why it could not be verified. */
  message?: string;
  file?: string;
  line?: number;
  column?: number;
  /** For function breakpoints. */
  functionName?: string;
  /** For data breakpoints (watchpoints): what is watched and on which access. */
  dataId?: string;
  accessType?: string;
  /** For instruction breakpoints. */
  instructionReference?: string;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
  /** How many times it has been hit, when the adapter tracks it. */
  hitCount?: number;
  enabled?: boolean;
}

/** The result of evaluating an expression — a watch, a hover, or a REPL entry. */
export interface DebugEvaluation {
  expression: string;
  /** `watch`, `repl`, `hover`, `clipboard`, `variables`. */
  context: string;
  result?: string;
  type?: string;
  error?: string;
  memoryReference?: string;
  children?: DebugVariable[];
  /** Which frame it was evaluated against; an expression means different things in different frames. */
  frameId?: number;
  at: string;
}

/**
 * One message that crossed the wire, in either direction.
 *
 * This is the "everything that comes and goes" record. Kept as a bounded ring so a long session
 * cannot exhaust memory, and deliberately including *both* directions with timing: knowing that the
 * editor asked for something and the adapter took 900 ms to answer is often the whole explanation
 * for a debugger that feels stuck.
 */
export interface DebugEvent {
  /** Monotonic index within the session, so ordering survives equal timestamps. */
  seq: number;
  at: string;
  /** Milliseconds since the previous event — the shape of a session at a glance. */
  deltaMs: number;
  /** `editor→adapter`, `adapter→editor`, or `auspex→adapter` for the recorder's own probes. */
  direction: 'in' | 'out' | 'probe';
  /** `request`, `response`, `event`. */
  type: string;
  /** The command or event name. */
  name: string;
  /** How long a response took to arrive, for request/response pairs. */
  durationMs?: number;
  /** Whether a response reported success. */
  success?: boolean;
  /** Payload size in bytes, so a heavy exchange is visible without keeping the payload. */
  bytes: number;
  /** A short rendering of the payload, capped. Full payloads are never retained. */
  summary?: string;
}

/** What one variable did between two stops. */
export interface DebugVariableDelta {
  scope: string;
  path: string;
  change: 'added' | 'removed' | 'changed' | 'unchanged';
  before?: string;
  after?: string;
}

/**
 * A comparison of two consecutive stops.
 *
 * This is the "what stays and what does not" question, answered concretely. Between two breakpoints
 * a program's state moved in some specific way, and that delta is usually the thing a developer is
 * actually trying to see — far more so than either snapshot on its own.
 */
export interface DebugStopDiff {
  fromStop: number;
  toStop: number;
  elapsedMs: number;
  /** Frames entered and left between the two stops. */
  framesEntered: string[];
  framesLeft: string[];
  changed: DebugVariableDelta[];
  added: DebugVariableDelta[];
  removed: DebugVariableDelta[];
  unchangedCount: number;
}

/** What the debug adapter says it can do. Probing is gated on this rather than on trial and error. */
export interface DebugCapabilities {
  supportsReadMemory?: boolean;
  supportsWriteMemory?: boolean;
  supportsDisassemble?: boolean;
  supportsModulesRequest?: boolean;
  supportsLoadedSourcesRequest?: boolean;
  supportsExceptionInfoRequest?: boolean;
  supportsDataBreakpoints?: boolean;
  supportsFunctionBreakpoints?: boolean;
  supportsConditionalBreakpoints?: boolean;
  supportsHitConditionalBreakpoints?: boolean;
  supportsLogPoints?: boolean;
  supportsSetVariable?: boolean;
  supportsSetExpression?: boolean;
  supportsRestartFrame?: boolean;
  supportsStepBack?: boolean;
  supportsGotoTargetsRequest?: boolean;
  supportsEvaluateForHovers?: boolean;
  supportsValueFormattingOptions?: boolean;
  supportsTerminateRequest?: boolean;
  /** Anything else the adapter declared, kept verbatim. */
  raw?: Record<string, unknown>;
}

/** One captured stop: the complete state of the program at one pause. */
export interface DebugStop {
  /** Ordinal within the session, counting from one. */
  index: number;
  at: string;
  reason?: string;
  description?: string;
  text?: string;
  threadId?: number;
  /** True when the adapter says every thread stopped, not only the reported one. */
  allThreadsStopped?: boolean;
  /** Which breakpoint ids caused this stop, when the adapter attributes it. */
  hitBreakpointIds?: number[];
  threads: DebugThread[];
  /** Frames, per thread id. The stopped thread is always fully captured; others may be shallower. */
  stacks: Record<number, DebugStackFrame[]>;
  /** Scopes and their variables, per frame id. */
  frames: Record<number, DebugScope[]>;
  exception?: DebugExceptionInfo;
  memory?: DebugMemory[];
  disassembly?: DebugInstruction[];
  /** How long the recorder spent gathering all of this. */
  captureMs: number;
  /** What it could not gather, and why — never silence. */
  incomplete?: string[];
}

/** Output from the debuggee, categorized. */
export interface DebugOutput {
  at: string;
  /** `stdout`, `stderr`, `console`, `important`, `telemetry`. */
  category: string;
  text: string;
  /** Where the output came from, when the adapter attributes it. */
  file?: string;
  line?: number;
}

/**
 * The complete record of a debug session.
 *
 * Replaces the small `DebugState` for anything that needs depth; `DebugState` remains as the
 * summary shape carried in a snapshot, so an ordinary capture does not balloon.
 */
export interface DebugSessionRecord {
  sessionId: string;
  /** `node`, `coreclr`, `debugpy`, `lldb`, `go`, `java`. */
  adapterType?: string;
  /** `launch` or `attach` — which changes what is safe to suggest. */
  startMethod?: string;
  name?: string;
  startedAt: string;
  endedAt?: string;
  status: 'initializing' | 'running' | 'paused' | 'terminated';
  capabilities?: DebugCapabilities;
  /** The launch/attach configuration, redacted like everything else. */
  configuration?: Record<string, unknown>;

  currentStop?: DebugStop;
  /** Previous stops, newest last, bounded. */
  stops: DebugStop[];
  /** Comparisons between consecutive stops. */
  diffs: DebugStopDiff[];

  breakpoints: DebugBreakpoint[];
  modules: DebugModule[];
  loadedSources: DebugLoadedSource[];
  evaluations: DebugEvaluation[];
  output: DebugOutput[];

  /** Everything that crossed the wire, bounded. */
  timeline: DebugEvent[];
  /** Counters over the whole session, which survive the timeline's eviction. */
  totals: {
    requests: number;
    responses: number;
    events: number;
    probes: number;
    failedResponses: number;
    bytesIn: number;
    bytesOut: number;
    stops: number;
    /** Slowest request/response round trip seen, with its command. */
    slowestMs?: number;
    slowestCommand?: string;
  };
  /** Non-fatal problems: an unsupported request, a capped tree, a timed-out probe. */
  warnings: string[];
}
