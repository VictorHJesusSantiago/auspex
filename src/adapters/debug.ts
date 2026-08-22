import type {
  DebugBreakpoint, DebugCapabilities, DebugEvaluation, DebugEvent, DebugExceptionInfo,
  DebugInstruction, DebugLoadedSource, DebugMemory, DebugModule, DebugOutput, DebugScope,
  DebugSessionRecord, DebugStackFrame, DebugStop, DebugStopDiff, DebugThread, DebugVariable,
  DebugVariableDelta,
} from '../core/debug-model.ts';
import type { DebugState } from '../core/model.ts';
import { normalizePath } from '../platform/files.ts';
import type { DebugJournal } from '../debug/journal.ts';

/**
 * Deep Debug Adapter Protocol capture: everything a paused program will give up.
 *
 * ## Why this is not just "watch the traffic"
 *
 * A passive proxy sees exactly what the editor's user interface happened to ask for. If nobody
 * clicked the triangle next to an object, its children never crossed the wire; if the Variables
 * pane was collapsed, no `scopes` request was ever sent; if the debugger stopped on a thread the UI
 * was not showing, its stack was never fetched. Watching that traffic and calling it "the state of
 * the program" would be reporting the shape of someone's window, not the shape of their process.
 *
 * So the recorder is **active**. On every stop it issues its own DAP requests — threads, stack
 * traces for every thread, scopes for every frame, variables recursively, exception detail, raw
 * memory behind every variable that has an address, modules, loaded sources, disassembly around the
 * instruction pointer — and assembles a complete {@link DebugStop}. The editor never sees any of
 * it.
 *
 * ## How that is done without breaking the editor's session
 *
 * This is the delicate part, and three rules make it safe:
 *
 * 1. **Sequence numbers come from a private range.** DAP correlates a response to a request by
 *    `request_seq`, and editors number from 1 upward. The recorder numbers from
 *    {@link PROBE_SEQ_BASE}, so its requests can never be confused with the editor's, in either
 *    direction, however long the session runs.
 * 2. **Responses to our own requests are swallowed, never forwarded.** An editor receiving a
 *    response to a request it never sent is entitled to treat the stream as corrupt. Every probe
 *    seq is tracked until its response arrives, and those responses are consumed here.
 * 3. **Forwarding always happens first, and a probe failure can never touch the editor's traffic.**
 *    Inherited from the transparent proxy this sits inside; every probe is individually wrapped, so
 *    an adapter that rejects `readMemory` produces a warning and nothing else.
 *
 * ## What it deliberately does not do
 *
 * It never *modifies* program state: no `setVariable`, no `setExpression`, no `goto`, no
 * `restartFrame`, and no injected `evaluate` (which can run arbitrary code with side effects in
 * most languages). Reading is safe and repeatable; writing is neither, and a tool that silently
 * mutated a debuggee while "just gathering context" would be indefensible. Evaluations that appear
 * in the record are ones the *user* performed, observed passing by.
 *
 * Nor does it probe while the program is running. Every request here is issued between a `stopped`
 * event and the next `continued`, when the debuggee is frozen and inspection is free.
 */

/**
 * Where the recorder's own request sequence numbers start.
 *
 * Far above anything an editor will reach: a debug session issuing a thousand requests a second
 * would need eleven days to collide with this. See rule 1 in the class docs.
 */
const PROBE_SEQ_BASE = 1_000_000_000;

export interface RecorderLimits {
  /** How deep to expand a variable tree. */
  variableDepth: number;
  /** Most children to fetch at any one level. */
  variableBreadth: number;
  /** Most variable requests per stop, across the whole tree. The real cost ceiling. */
  variableRequests: number;
  /** How many frames per thread to fetch scopes for. */
  framesWithScopes: number;
  /** How many frames per stack to fetch at all. */
  stackDepth: number;
  /** How many threads besides the stopped one to walk. */
  otherThreads: number;
  /** Bytes to read per memory reference. */
  memoryBytes: number;
  /** How many memory references to follow per stop. */
  memoryReads: number;
  /** Instructions to disassemble around the instruction pointer. */
  disassembly: number;
  /** Stops to retain. */
  stopHistory: number;
  /** Timeline entries to retain. */
  timeline: number;
  /** Output lines to retain. */
  output: number;
  /** How long any single probe may take. */
  probeTimeoutMs: number;
  /** Total budget for gathering one stop; when exceeded the rest is skipped and reported. */
  stopBudgetMs: number;
}

/**
 * Defaults chosen so a stop is captured in well under a second on an ordinary program.
 *
 * The limits exist for two independent reasons, and both are real. **Termination**: a variable
 * graph can be genuinely infinite — a circular reference, a linked list, a DOM node — and depth
 * alone does not bound it. **Courtesy**: every probe is a round trip to a debug adapter that is
 * also serving the user's editor, and a recorder that fired a thousand requests on every step would
 * make stepping feel broken, which is a far worse outcome than a slightly shallower capture.
 */
export const DEFAULT_LIMITS: RecorderLimits = {
  variableDepth: 4,
  variableBreadth: 100,
  variableRequests: 250,
  framesWithScopes: 5,
  stackDepth: 50,
  otherThreads: 4,
  memoryBytes: 256,
  memoryReads: 8,
  disassembly: 32,
  stopHistory: 20,
  timeline: 2000,
  output: 1000,
  probeTimeoutMs: 3000,
  stopBudgetMs: 8000,
};

/** How the recorder sends a request to the adapter and is told when a response arrives. */
export interface ProbeTransport {
  /** Writes a DAP message to the adapter. */
  send(message: Record<string, unknown>): void;
}

interface PendingProbe {
  resolve: (body: Record<string, unknown> | undefined) => void;
  command: string;
  sentAt: number;
  timer: NodeJS.Timeout;
}

/**
 * Records one debug session in full.
 *
 * One instance per session. `observe` is fed every message in both directions; `attach` gives it a
 * way to send its own.
 */
export class DebugRecorder {
  readonly limits: RecorderLimits;
  private transport: ProbeTransport | undefined;
  private journal: DebugJournal | undefined;

  private record: DebugSessionRecord;
  private nextProbeSeq = PROBE_SEQ_BASE;
  private readonly pending = new Map<number, PendingProbe>();
  /** Editor requests awaiting a response, for round-trip timing. */
  private readonly editorRequests = new Map<number, { command: string; at: number }>();
  private eventSeq = 0;
  private lastEventAt = 0;
  private stopCount = 0;
  private capturing = false;
  /** Flattened variable state of the previous stop, for the diff. */
  private previousFlat: Map<string, string> | undefined;
  private previousFrames: string[] = [];

  constructor(sessionId: string, limits: Partial<RecorderLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.record = emptyRecord(sessionId);
  }

  /** Gives the recorder a channel to the adapter, enabling active probing. */
  attach(transport: ProbeTransport): void {
    this.transport = transport;
  }

  /**
   * Attaches a durable journal.
   *
   * Separate from `attach` because the two are independent: a recorder can probe without
   * journalling (the usual case, when nobody asked for history) and can journal without probing
   * (a passive session whose events are still worth keeping). Coupling them would force one on
   * anyone who wanted the other.
   */
  journalTo(journal: DebugJournal): void {
    this.journal = journal;
    void journal.begin({
      sessionId: this.record.sessionId,
      adapterType: this.record.adapterType,
      startMethod: this.record.startMethod,
      name: this.record.name,
      startedAt: this.record.startedAt,
    });
  }

  get session(): DebugSessionRecord {
    return this.record;
  }

  get isActive(): boolean {
    return this.record.status !== 'terminated';
  }

  reset(sessionId: string): void {
    for (const probe of this.pending.values()) clearTimeout(probe.timer);
    this.pending.clear();
    this.record = emptyRecord(sessionId);
    this.eventSeq = 0;
    this.stopCount = 0;
    this.previousFlat = undefined;
    this.previousFrames = [];
  }

  // -------------------------------------------------------------------------------------------
  // Observation
  // -------------------------------------------------------------------------------------------

  /**
   * Feeds one message in. Returns true when the message was one of ours and must be swallowed
   * rather than forwarded to the editor.
   *
   * The return value is the whole of rule 2 from the class docs, and the caller must honour it.
   */
  observe(message: Record<string, unknown>, direction: 'in' | 'out'): boolean {
    const type = String(message.type ?? '');

    // Our own response coming back. Consume it and tell the caller not to forward.
    if (type === 'response' && direction === 'out') {
      const requestSeq = Number(message.request_seq);
      const probe = this.pending.get(requestSeq);
      if (probe) {
        this.pending.delete(requestSeq);
        clearTimeout(probe.timer);
        this.note('probe', 'response', probe.command, message, {
          durationMs: Date.now() - probe.sentAt,
          success: message.success === true,
        });
        probe.resolve(message.success === true ? (message.body as Record<string, unknown>) ?? {} : undefined);
        return true;
      }
    }

    switch (type) {
      case 'request': this.onRequest(message, direction); break;
      case 'response': this.onResponse(message, direction); break;
      case 'event': this.onEvent(message, direction); break;
      default: this.note(direction, type || 'unknown', String(message.command ?? message.event ?? ''), message);
    }
    return false;
  }

  private onRequest(message: Record<string, unknown>, direction: 'in' | 'out'): void {
    const command = String(message.command ?? '');
    const seq = Number(message.seq);
    if (direction === 'in' && Number.isFinite(seq)) {
      this.editorRequests.set(seq, { command, at: Date.now() });
    }
    this.record.totals.requests++;
    this.note(direction, 'request', command, message);

    // The launch/attach arguments are the only place the session's own configuration appears, and
    // they say things nothing else does: the program under test, its arguments, its working
    // directory, its environment.
    if (command === 'launch' || command === 'attach') {
      this.record.startMethod = command;
      const args = message.arguments as Record<string, unknown> | undefined;
      if (args) {
        this.record.configuration = args;
        if (typeof args.name === 'string') this.record.name = args.name;
        if (typeof args.type === 'string') this.record.adapterType = args.type;
      }
    }
  }

  private onResponse(message: Record<string, unknown>, direction: 'in' | 'out'): void {
    const command = String(message.command ?? '');
    const requestSeq = Number(message.request_seq);
    const asked = this.editorRequests.get(requestSeq);
    if (asked) this.editorRequests.delete(requestSeq);

    const durationMs = asked ? Date.now() - asked.at : undefined;
    const success = message.success === true;

    this.record.totals.responses++;
    if (!success) this.record.totals.failedResponses++;
    if (durationMs !== undefined &&
        (this.record.totals.slowestMs === undefined || durationMs > this.record.totals.slowestMs)) {
      this.record.totals.slowestMs = durationMs;
      this.record.totals.slowestCommand = command;
    }
    this.note(direction, 'response', command, message, { durationMs, success });

    const body = (message.body ?? {}) as Record<string, unknown>;

    switch (command) {
      case 'initialize':
        this.record.capabilities = readCapabilities(body);
        break;
      case 'setBreakpoints':
      case 'setFunctionBreakpoints':
      case 'setDataBreakpoints':
      case 'setInstructionBreakpoints':
      case 'setExceptionBreakpoints':
        this.mergeBreakpoints(command, message, body);
        break;
      case 'evaluate':
        // The user's own watch expressions and REPL entries, observed rather than injected.
        this.recordEvaluation(message, body);
        break;
      case 'modules':
        this.record.modules = readModules(body);
        break;
      case 'loadedSources':
        this.record.loadedSources = readLoadedSources(body);
        break;
    }
  }

  private onEvent(message: Record<string, unknown>, direction: 'in' | 'out'): void {
    const event = String(message.event ?? '');
    const body = (message.body ?? {}) as Record<string, unknown>;

    this.record.totals.events++;
    this.note(direction, 'event', event, message);

    switch (event) {
      case 'initialized':
        this.record.status = 'running';
        break;

      case 'stopped':
        this.record.status = 'paused';
        // Fire and forget: the capture is asynchronous because every probe is a round trip, and
        // blocking the proxy here would stall the editor's own traffic.
        void this.captureStop(body);
        break;

      case 'continued':
        this.record.status = 'running';
        break;

      case 'terminated':
      case 'exited':
        this.record.status = 'terminated';
        this.record.endedAt = new Date().toISOString();
        this.journal?.end('terminated', this.record.totals);
        break;

      case 'output':
        this.recordOutput(body);
        break;

      case 'module':
        this.upsertModule(body);
        break;

      case 'loadedSource':
        this.upsertLoadedSource(body);
        break;

      case 'breakpoint':
        this.upsertBreakpointFromEvent(body);
        break;

      case 'thread':
        // Threads appearing and disappearing is part of "what comes and goes", and a thread that
        // exited between two stops explains a stack that vanished.
        this.note(direction, 'event', `thread:${String(body.reason ?? '')}`, message);
        break;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Active capture
  // -------------------------------------------------------------------------------------------

  /**
   * Gathers everything about one stop.
   *
   * Ordered by how much each answer matters, because the whole thing runs under
   * {@link RecorderLimits.stopBudgetMs} and what does not fit is skipped and reported. Threads and
   * the stopped thread's stack come first — without those nothing else has a frame to hang on —
   * then scopes and variables, then the exception, then the expensive extras.
   */
  private async captureStop(body: Record<string, unknown>): Promise<void> {
    if (!this.transport) return;
    // A second `stopped` while still gathering the first (all-threads-stopped adapters emit one per
    // thread) must not start a second concurrent walk over the same state.
    if (this.capturing) return;
    this.capturing = true;

    const startedAt = Date.now();
    const deadline = startedAt + this.limits.stopBudgetMs;
    const incomplete: string[] = [];

    const stop: DebugStop = {
      index: ++this.stopCount,
      at: new Date().toISOString(),
      reason: asString(body.reason),
      description: asString(body.description),
      text: asString(body.text),
      threadId: asNumber(body.threadId),
      allThreadsStopped: body.allThreadsStopped === true,
      hitBreakpointIds: Array.isArray(body.hitBreakpointIds)
        ? body.hitBreakpointIds.map(Number).filter(Number.isFinite)
        : undefined,
      threads: [],
      stacks: {},
      frames: {},
      captureMs: 0,
    };

    try {
      // -- Threads.
      const threadsBody = await this.probe('threads', {});
      stop.threads = readThreads(threadsBody, stop.threadId);

      const stoppedId = stop.threadId ?? stop.threads.find((thread) => thread.stopped)?.id
        ?? stop.threads[0]?.id;

      // The stopped thread first, then a bounded number of others. A server with two hundred
      // threads is not unusual, and walking all of them would blow the budget on stacks nobody
      // asked about.
      const threadIds: number[] = [];
      if (stoppedId !== undefined) threadIds.push(stoppedId);
      for (const thread of stop.threads) {
        if (thread.id !== stoppedId && threadIds.length <= this.limits.otherThreads) {
          threadIds.push(thread.id);
        }
      }
      if (threadIds.length === 0) threadIds.push(0);

      // -- Stacks.
      let variableBudget = this.limits.variableRequests;

      for (const threadId of threadIds) {
        if (Date.now() > deadline) {
          incomplete.push('stack capture stopped at the time budget');
          break;
        }
        const stackBody = await this.probe('stackTrace', {
          threadId, startFrame: 0, levels: this.limits.stackDepth,
        });
        const frames = readStackFrames(stackBody);
        stop.stacks[threadId] = frames;

        // Scopes and variables only for the stopped thread's frames: other threads' locals are
        // rarely what a question is about, and they are the most expensive thing here.
        if (threadId !== stoppedId) continue;

        for (const frame of frames.slice(0, this.limits.framesWithScopes)) {
          if (Date.now() > deadline) {
            incomplete.push(`variables stopped at frame ${frame.name} (time budget)`);
            break;
          }
          const scopes = await this.captureScopes(frame.id, deadline, () => variableBudget,
            (used) => { variableBudget = used; });
          stop.frames[frame.id] = scopes;
        }
      }

      // -- Exception detail, when that is why it stopped.
      if (stop.reason === 'exception' && this.record.capabilities?.supportsExceptionInfoRequest !== false) {
        const exceptionBody = await this.probe('exceptionInfo', { threadId: stoppedId ?? 0 });
        if (exceptionBody) stop.exception = readExceptionInfo(exceptionBody);
      }

      // -- Raw memory behind variables that carry an address.
      if (this.record.capabilities?.supportsReadMemory) {
        stop.memory = await this.captureMemory(stop, deadline, incomplete);
      }

      // -- Disassembly around the instruction pointer.
      if (this.record.capabilities?.supportsDisassemble && Date.now() < deadline) {
        const pointer = stop.stacks[stoppedId ?? 0]?.[0]?.instructionPointerReference;
        if (pointer) {
          const body2 = await this.probe('disassemble', {
            memoryReference: pointer,
            instructionOffset: -Math.floor(this.limits.disassembly / 2),
            instructionCount: this.limits.disassembly,
            resolveSymbols: true,
          });
          const instructions = readInstructions(body2);
          if (instructions.length > 0) stop.disassembly = instructions;
        }
      }

      // -- Modules and sources, once per session rather than per stop: they change rarely and both
      // are whole-process queries.
      if (this.record.modules.length === 0 && this.record.capabilities?.supportsModulesRequest !== false) {
        const modulesBody = await this.probe('modules', {});
        if (modulesBody) this.record.modules = readModules(modulesBody);
      }
      if (this.record.loadedSources.length === 0 &&
          this.record.capabilities?.supportsLoadedSourcesRequest) {
        const sourcesBody = await this.probe('loadedSources', {});
        if (sourcesBody) this.record.loadedSources = readLoadedSources(sourcesBody);
      }
    } catch (error) {
      incomplete.push(`capture failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      stop.captureMs = Date.now() - startedAt;
      if (incomplete.length > 0) stop.incomplete = incomplete;

      this.commitStop(stop);
      this.capturing = false;
    }
  }

  /** Fetches every scope of one frame, and the variable tree under each. */
  private async captureScopes(
    frameId: number,
    deadline: number,
    getBudget: () => number,
    setBudget: (value: number) => void,
  ): Promise<DebugScope[]> {
    const scopesBody = await this.probe('scopes', { frameId });
    const raw = Array.isArray(scopesBody?.scopes) ? scopesBody.scopes : [];
    const scopes: DebugScope[] = [];

    for (const item of raw) {
      const record = item as Record<string, unknown>;
      const source = record.source as Record<string, unknown> | undefined;

      const scope: DebugScope = {
        name: String(record.name ?? 'scope'),
        presentationHint: asString(record.presentationHint),
        expensive: record.expensive === true,
        namedVariables: asNumber(record.namedVariables),
        indexedVariables: asNumber(record.indexedVariables),
        file: source?.path ? normalizePath(String(source.path)) : undefined,
        line: asNumber(record.line),
        variables: [],
      };

      const reference = asNumber(record.variablesReference) ?? 0;

      // An adapter marking a scope expensive is telling us it is slow; honouring that is the
      // difference between a recorder and a denial of service against the user's own debugger.
      if (scope.expensive) {
        scope.skipped = 'the adapter marked this scope expensive';
      } else if (reference === 0) {
        scope.skipped = 'no variables reference';
      } else if (Date.now() > deadline) {
        scope.skipped = 'time budget';
      } else if (getBudget() <= 0) {
        scope.skipped = 'variable request budget';
      } else {
        scope.variables = await this.captureVariables(reference, 0, new Set(), deadline, getBudget, setBudget);
      }
      scopes.push(scope);
    }
    return scopes;
  }

  /**
   * Walks a variable tree.
   *
   * Cycle detection is by `variablesReference`, not by value: an object graph with a back-pointer
   * produces the same reference again, and depth alone would not stop a linked list a million nodes
   * long. Everything cut short says so in `truncated` rather than simply ending.
   */
  private async captureVariables(
    reference: number,
    depth: number,
    seen: Set<number>,
    deadline: number,
    getBudget: () => number,
    setBudget: (value: number) => void,
  ): Promise<DebugVariable[]> {
    if (depth >= this.limits.variableDepth || getBudget() <= 0 || Date.now() > deadline) return [];
    if (seen.has(reference)) return [];
    seen.add(reference);

    setBudget(getBudget() - 1);
    const body = await this.probe('variables', { variablesReference: reference });
    const raw = Array.isArray(body?.variables) ? body.variables : [];

    const variables: DebugVariable[] = [];

    for (const item of raw.slice(0, this.limits.variableBreadth)) {
      const record = item as Record<string, unknown>;
      const hint = record.presentationHint as Record<string, unknown> | undefined;

      const variable: DebugVariable = {
        name: String(record.name ?? ''),
        value: String(record.value ?? ''),
        type: asString(record.type),
        evaluateName: asString(record.evaluateName),
        kind: asString(hint?.kind),
        attributes: Array.isArray(hint?.attributes) ? hint.attributes.map(String) : undefined,
        visibility: asString(hint?.visibility),
        writable: hint?.lazy === true ? undefined : undefined,
        namedVariables: asNumber(record.namedVariables),
        indexedVariables: asNumber(record.indexedVariables),
        memoryReference: asString(record.memoryReference),
      };

      const childReference = asNumber(record.variablesReference) ?? 0;
      if (childReference > 0) {
        if (seen.has(childReference)) {
          variable.truncated = 'circular reference';
        } else if (depth + 1 >= this.limits.variableDepth) {
          variable.truncated = `depth limit (${this.limits.variableDepth})`;
        } else if (getBudget() <= 0) {
          variable.truncated = 'request budget';
        } else if (Date.now() > deadline) {
          variable.truncated = 'time budget';
        } else {
          const children = await this.captureVariables(childReference, depth + 1, seen, deadline, getBudget, setBudget);
          if (children.length > 0) variable.children = children;
        }
      }
      variables.push(variable);
    }

    if (raw.length > this.limits.variableBreadth) {
      variables.push({
        name: `… ${raw.length - this.limits.variableBreadth} more`,
        value: '',
        truncated: `breadth limit (${this.limits.variableBreadth})`,
      });
    }
    return variables;
  }

  /** Reads raw memory behind the variables that carry an address. */
  private async captureMemory(
    stop: DebugStop,
    deadline: number,
    incomplete: string[],
  ): Promise<DebugMemory[]> {
    const references: string[] = [];
    const seen = new Set<string>();

    const collect = (variables: DebugVariable[]) => {
      for (const variable of variables) {
        if (variable.memoryReference && !seen.has(variable.memoryReference)) {
          seen.add(variable.memoryReference);
          references.push(variable.memoryReference);
        }
        if (variable.children) collect(variable.children);
      }
    };
    for (const scopes of Object.values(stop.frames)) {
      for (const scope of scopes) collect(scope.variables);
    }

    const dumps: DebugMemory[] = [];
    for (const reference of references.slice(0, this.limits.memoryReads)) {
      if (Date.now() > deadline) {
        incomplete.push('memory reads stopped at the time budget');
        break;
      }
      const body = await this.probe('readMemory', {
        memoryReference: reference,
        count: this.limits.memoryBytes,
      });
      if (!body || typeof body.data !== 'string') continue;

      const bytes = Buffer.from(body.data, 'base64');
      dumps.push({
        reference,
        address: asString(body.address),
        unreadableBytes: asNumber(body.unreadableBytes),
        byteCount: bytes.length,
        base64: body.data,
        hex: toHexDump(bytes),
        text: toPrintable(bytes),
      });
    }
    return dumps;
  }

  /** Files a completed stop, computes the diff against the previous one, and evicts old history. */
  private commitStop(stop: DebugStop): void {
    const flat = flattenStop(stop);
    const frames = Object.values(stop.stacks).flat().map((frame) => frame.name);

    if (this.previousFlat && this.record.currentStop) {
      this.record.diffs.push(buildDiff(
        this.record.currentStop, stop, this.previousFlat, flat, this.previousFrames, frames,
      ));
      if (this.record.diffs.length > this.limits.stopHistory) this.record.diffs.shift();
    }

    if (this.record.currentStop) {
      this.record.stops.push(this.record.currentStop);
      if (this.record.stops.length > this.limits.stopHistory) this.record.stops.shift();
    }
    this.record.currentStop = stop;
    this.record.totals.stops++;
    // Journalled here rather than at capture time, so the journal holds only stops that were
    // completed -- a half-gathered stop written to a durable record would be indistinguishable
    // later from a program whose state really was that sparse.
    this.journal?.stop(stop);
    this.previousFlat = flat;
    this.previousFrames = frames;

    for (const note of stop.incomplete ?? []) this.warn(note);
  }

  // -------------------------------------------------------------------------------------------
  // Probing
  // -------------------------------------------------------------------------------------------

  /**
   * Issues one request and waits for its response.
   *
   * Never rejects: a timeout or a failure resolves to `undefined` and leaves a warning. A probe is
   * an optional enrichment, and an adapter that does not implement a request must degrade the
   * capture rather than abort it.
   */
  private probe(command: string, args: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    if (!this.transport) return Promise.resolve(undefined);

    const seq = this.nextProbeSeq++;
    this.record.totals.probes++;

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        this.warn(`probe '${command}' timed out after ${this.limits.probeTimeoutMs}ms`);
        resolve(undefined);
      }, this.limits.probeTimeoutMs);
      timer.unref?.();

      this.pending.set(seq, { resolve, command, sentAt: Date.now(), timer });

      const message = { seq, type: 'request', command, arguments: args };
      this.note('probe', 'request', command, message);

      try {
        this.transport!.send(message);
      } catch (error) {
        this.pending.delete(seq);
        clearTimeout(timer);
        this.warn(`probe '${command}' could not be sent: ${error instanceof Error ? error.message : error}`);
        resolve(undefined);
      }
    });
  }

  // -------------------------------------------------------------------------------------------
  // Bookkeeping
  // -------------------------------------------------------------------------------------------

  /** Appends to the timeline ring, with size and timing. */
  private note(
    direction: 'in' | 'out' | 'probe',
    type: string,
    name: string,
    message: Record<string, unknown>,
    extra: { durationMs?: number; success?: boolean } = {},
  ): void {
    const now = Date.now();
    const serialized = safeStringify(message);

    const entry: DebugEvent = {
      seq: ++this.eventSeq,
      at: new Date(now).toISOString(),
      deltaMs: this.lastEventAt === 0 ? 0 : now - this.lastEventAt,
      direction,
      type,
      name,
      durationMs: extra.durationMs,
      success: extra.success,
      bytes: Buffer.byteLength(serialized),
      summary: summarize(message, name),
    };
    this.lastEventAt = now;

    if (direction === 'in') this.record.totals.bytesIn += entry.bytes;
    else this.record.totals.bytesOut += entry.bytes;

    this.record.timeline.push(entry);
    if (this.record.timeline.length > this.limits.timeline) this.record.timeline.shift();
    this.journal?.event(entry);
  }

  private warn(message: string): void {
    if (this.record.warnings.includes(message)) return;
    this.record.warnings.push(message);
    if (this.record.warnings.length > 50) this.record.warnings.shift();
  }

  private recordOutput(body: Record<string, unknown>): void {
    const text = asString(body.output) ?? '';
    if (!text) return;
    const source = body.source as Record<string, unknown> | undefined;

    for (const line of text.split('\n')) {
      if (!line.trim() && text.trim()) continue;
      this.journal?.output(asString(body.category) ?? 'console', line.replace(/\r$/, ''));
      this.record.output.push({
        at: new Date().toISOString(),
        category: asString(body.category) ?? 'console',
        text: line.replace(/\r$/, ''),
        file: source?.path ? normalizePath(String(source.path)) : undefined,
        line: asNumber(body.line),
      });
    }
    while (this.record.output.length > this.limits.output) this.record.output.shift();
  }

  private recordEvaluation(message: Record<string, unknown>, body: Record<string, unknown>): void {
    const args = (message.arguments ?? {}) as Record<string, unknown>;
    const expression = asString(args.expression);
    if (!expression) return;

    this.record.evaluations.push({
      expression,
      context: asString(args.context) ?? 'repl',
      result: asString(body.result),
      type: asString(body.type),
      error: message.success === false ? asString(message.message) : undefined,
      memoryReference: asString(body.memoryReference),
      frameId: asNumber(args.frameId),
      at: new Date().toISOString(),
    });
    if (this.record.evaluations.length > 200) this.record.evaluations.shift();
  }

  private mergeBreakpoints(
    command: string,
    message: Record<string, unknown>,
    body: Record<string, unknown>,
  ): void {
    const kind: DebugBreakpoint['kind'] =
      command === 'setFunctionBreakpoints' ? 'function'
      : command === 'setDataBreakpoints' ? 'data'
      : command === 'setInstructionBreakpoints' ? 'instruction'
      : command === 'setExceptionBreakpoints' ? 'exception'
      : 'line';

    const args = (message.arguments ?? {}) as Record<string, unknown>;
    const source = args.source as Record<string, unknown> | undefined;
    const file = source?.path ? normalizePath(String(source.path)) : undefined;
    // The request carries the conditions the user set; the response carries whether the debugger
    // could bind them. Both halves are needed, and only the pair together is useful.
    const requested = Array.isArray(args.breakpoints) ? args.breakpoints : [];
    const resolved = Array.isArray(body.breakpoints) ? body.breakpoints : [];

    // A `setBreakpoints` call replaces every breakpoint in that file, so the old ones for this file
    // and kind must go -- otherwise a removed breakpoint lingers in the record forever.
    this.record.breakpoints = this.record.breakpoints.filter((breakpoint) =>
      breakpoint.kind !== kind || (kind === 'line' && breakpoint.file !== file));

    const count = Math.max(requested.length, resolved.length);
    for (let i = 0; i < count; i++) {
      const asked = (requested[i] ?? {}) as Record<string, unknown>;
      const got = (resolved[i] ?? {}) as Record<string, unknown>;
      const gotSource = got.source as Record<string, unknown> | undefined;

      this.record.breakpoints.push({
        kind,
        id: asNumber(got.id),
        verified: got.verified === true,
        message: asString(got.message),
        file: gotSource?.path ? normalizePath(String(gotSource.path)) : file,
        line: asNumber(got.line) ?? asNumber(asked.line),
        column: asNumber(got.column) ?? asNumber(asked.column),
        functionName: asString(asked.name),
        dataId: asString(asked.dataId),
        accessType: asString(asked.accessType),
        instructionReference: asString(asked.instructionReference),
        condition: asString(asked.condition),
        hitCondition: asString(asked.hitCondition),
        logMessage: asString(asked.logMessage),
        enabled: true,
      });
    }
  }

  private upsertBreakpointFromEvent(body: Record<string, unknown>): void {
    const breakpoint = body.breakpoint as Record<string, unknown> | undefined;
    if (!breakpoint) return;
    const id = asNumber(breakpoint.id);
    const reason = asString(body.reason);

    if (reason === 'removed' && id !== undefined) {
      this.record.breakpoints = this.record.breakpoints.filter((item) => item.id !== id);
      return;
    }
    const existing = this.record.breakpoints.find((item) => item.id === id);
    const source = breakpoint.source as Record<string, unknown> | undefined;

    const updated: DebugBreakpoint = {
      ...(existing ?? { kind: 'line' as const }),
      id,
      verified: breakpoint.verified === true,
      message: asString(breakpoint.message),
      file: source?.path ? normalizePath(String(source.path)) : existing?.file,
      line: asNumber(breakpoint.line) ?? existing?.line,
      hitCount: asNumber(breakpoint.hitCount) ?? existing?.hitCount,
    };
    if (existing) Object.assign(existing, updated);
    else this.record.breakpoints.push(updated);
  }

  private upsertModule(body: Record<string, unknown>): void {
    const module = body.module as Record<string, unknown> | undefined;
    if (!module) return;
    const reason = asString(body.reason);
    const id = module.id as string | number;

    if (reason === 'removed') {
      this.record.modules = this.record.modules.filter((item) => item.id !== id);
      return;
    }
    const parsed = readModule(module);
    const index = this.record.modules.findIndex((item) => item.id === id);
    if (index >= 0) this.record.modules[index] = parsed;
    else this.record.modules.push(parsed);
  }

  private upsertLoadedSource(body: Record<string, unknown>): void {
    const source = body.source as Record<string, unknown> | undefined;
    if (!source) return;
    const parsed = readLoadedSource(source);
    if (!this.record.loadedSources.some((item) => item.path === parsed.path && item.name === parsed.name)) {
      this.record.loadedSources.push(parsed);
    }
  }

  /**
   * The compact {@link DebugState} that goes into an ordinary snapshot.
   *
   * A full session record is far too large to attach to every capture, so the snapshot carries a
   * summary and the deep record is fetched deliberately. That split is the reason both shapes
   * exist.
   */
  toDebugState(): DebugState | undefined {
    if (this.record.status === 'initializing' && this.record.totals.events === 0) return undefined;

    const stop = this.record.currentStop;
    const stoppedThread = stop?.threadId ?? Object.keys(stop?.stacks ?? {}).map(Number)[0];
    const stack = stop && stoppedThread !== undefined ? stop.stacks[stoppedThread] ?? [] : [];

    const scopes: Record<string, Array<{ name: string; value: string; type?: string }>> = {};
    const topFrame = stack[0];
    if (stop && topFrame) {
      for (const scope of stop.frames[topFrame.id] ?? []) {
        scopes[scope.name] = scope.variables.map((variable) => ({
          name: variable.name, value: variable.value, type: variable.type,
        }));
      }
    }

    return {
      active: this.record.status !== 'terminated',
      status: this.record.status === 'paused' ? 'paused'
        : this.record.status === 'terminated' ? 'terminated' : 'running',
      adapterType: this.record.adapterType,
      stoppedReason: stop?.reason,
      threadId: stop?.threadId,
      stack: stack.map((frame) => ({
        id: frame.id, name: frame.name, file: frame.file, line: frame.line, column: frame.column,
      })),
      scopes,
      breakpoints: this.record.breakpoints
        .filter((breakpoint) => breakpoint.kind === 'line' && breakpoint.file)
        .map((breakpoint) => ({
          file: breakpoint.file!,
          line: breakpoint.line ?? 0,
          enabled: breakpoint.enabled !== false,
          condition: breakpoint.condition,
          hitCondition: breakpoint.hitCondition,
          logMessage: breakpoint.logMessage,
          verified: breakpoint.verified,
        })),
      output: this.record.output.slice(-100).map((line) => line.text),
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Readers: protocol shapes into model shapes
// ---------------------------------------------------------------------------------------------

function readThreads(body: Record<string, unknown> | undefined, stoppedId?: number): DebugThread[] {
  const raw = Array.isArray(body?.threads) ? body.threads : [];
  return raw.map((item) => {
    const record = item as Record<string, unknown>;
    const id = asNumber(record.id) ?? 0;
    return { id, name: String(record.name ?? `thread ${id}`), stopped: id === stoppedId };
  });
}

function readStackFrames(body: Record<string, unknown> | undefined): DebugStackFrame[] {
  const raw = Array.isArray(body?.stackFrames) ? body.stackFrames : [];
  return raw.map((item) => {
    const record = item as Record<string, unknown>;
    const source = record.source as Record<string, unknown> | undefined;

    return {
      id: asNumber(record.id) ?? 0,
      name: String(record.name ?? ''),
      file: source?.path ? normalizePath(String(source.path)) : undefined,
      sourceName: asString(source?.name),
      line: asNumber(record.line),
      column: asNumber(record.column),
      endLine: asNumber(record.endLine),
      endColumn: asNumber(record.endColumn),
      presentationHint: asString(record.presentationHint),
      // A frame with no source path is one the debugger cannot show, which is exactly the frame a
      // user asks about ("why is it stopped in nothing?").
      unmapped: !source?.path,
      moduleId: (record.moduleId as string | number | undefined),
      instructionPointerReference: asString(record.instructionPointerReference),
      canRestart: record.canRestart === true,
    };
  });
}

function readExceptionInfo(body: Record<string, unknown>): DebugExceptionInfo {
  const details = body.details as Record<string, unknown> | undefined;
  const info: DebugExceptionInfo = {
    exceptionId: String(body.exceptionId ?? 'exception'),
    description: asString(body.description),
    breakMode: asString(body.breakMode),
    message: asString(details?.message),
    typeName: asString(details?.typeName),
    stackTrace: asString(details?.stackTrace),
  };
  const inner = details?.innerException;
  if (Array.isArray(inner) && inner[0]) {
    info.innerException = readExceptionInfo({ exceptionId: 'inner', details: inner[0] });
  }
  return info;
}

function readModules(body: Record<string, unknown> | undefined): DebugModule[] {
  const raw = Array.isArray(body?.modules) ? body.modules : [];
  return raw.map((item) => readModule(item as Record<string, unknown>));
}

function readModule(record: Record<string, unknown>): DebugModule {
  return {
    id: (record.id as string | number) ?? '',
    name: String(record.name ?? ''),
    path: record.path ? normalizePath(String(record.path)) : undefined,
    version: asString(record.version),
    symbolStatus: asString(record.symbolStatus),
    symbolFilePath: asString(record.symbolFilePath),
    isOptimized: record.isOptimized === true,
    isUserCode: record.isUserCode === true,
    addressRange: asString(record.addressRange),
  };
}

function readLoadedSources(body: Record<string, unknown> | undefined): DebugLoadedSource[] {
  const raw = Array.isArray(body?.sources) ? body.sources : [];
  return raw.map((item) => readLoadedSource(item as Record<string, unknown>));
}

function readLoadedSource(record: Record<string, unknown>): DebugLoadedSource {
  return {
    name: String(record.name ?? ''),
    path: record.path ? normalizePath(String(record.path)) : undefined,
    presentationHint: asString(record.presentationHint),
    sourceReference: asNumber(record.sourceReference),
  };
}

function readInstructions(body: Record<string, unknown> | undefined): DebugInstruction[] {
  const raw = Array.isArray(body?.instructions) ? body.instructions : [];
  return raw.map((item) => {
    const record = item as Record<string, unknown>;
    const location = record.location as Record<string, unknown> | undefined;
    return {
      address: String(record.address ?? ''),
      instruction: String(record.instruction ?? ''),
      bytes: asString(record.instructionBytes),
      symbol: asString(record.symbol),
      file: location?.path ? normalizePath(String(location.path)) : undefined,
      line: asNumber(record.line),
    };
  });
}

/** Reads the adapter's declared capabilities, which gate every optional probe. */
export function readCapabilities(body: Record<string, unknown>): DebugCapabilities {
  const flag = (name: string) => body[name] === true;
  return {
    supportsReadMemory: flag('supportsReadMemoryRequest'),
    supportsWriteMemory: flag('supportsWriteMemoryRequest'),
    supportsDisassemble: flag('supportsDisassembleRequest'),
    supportsModulesRequest: flag('supportsModulesRequest'),
    supportsLoadedSourcesRequest: flag('supportsLoadedSourcesRequest'),
    supportsExceptionInfoRequest: flag('supportsExceptionInfoRequest'),
    supportsDataBreakpoints: flag('supportsDataBreakpoints'),
    supportsFunctionBreakpoints: flag('supportsFunctionBreakpoints'),
    supportsConditionalBreakpoints: flag('supportsConditionalBreakpoints'),
    supportsHitConditionalBreakpoints: flag('supportsHitConditionalBreakpoints'),
    supportsLogPoints: flag('supportsLogPoints'),
    supportsSetVariable: flag('supportsSetVariable'),
    supportsSetExpression: flag('supportsSetExpression'),
    supportsRestartFrame: flag('supportsRestartFrame'),
    supportsStepBack: flag('supportsStepBack'),
    supportsGotoTargetsRequest: flag('supportsGotoTargetsRequest'),
    supportsEvaluateForHovers: flag('supportsEvaluateForHovers'),
    supportsValueFormattingOptions: flag('supportsValueFormattingOptions'),
    supportsTerminateRequest: flag('supportsTerminateRequest'),
    raw: body,
  };
}

// ---------------------------------------------------------------------------------------------
// Diffing: what stays and what does not
// ---------------------------------------------------------------------------------------------

/** Flattens a stop's variables into `scope/path` → value, for comparison. */
export function flattenStop(stop: DebugStop): Map<string, string> {
  const flat = new Map<string, string>();

  const walk = (scopeName: string, prefix: string, variables: DebugVariable[]) => {
    for (const variable of variables) {
      const path = prefix ? `${prefix}.${variable.name}` : variable.name;
      flat.set(`${scopeName}/${path}`, variable.value);
      if (variable.children) walk(scopeName, path, variable.children);
    }
  };

  // Only the top frame: comparing variables across frames that changed identity between stops
  // would report every local in every frame as added and removed, which is noise rather than a
  // diff.
  const firstFrame = Object.values(stop.frames)[0];
  for (const scope of firstFrame ?? []) walk(scope.name, '', scope.variables);

  return flat;
}

/** Compares two stops. */
export function buildDiff(
  from: DebugStop,
  to: DebugStop,
  before: Map<string, string>,
  after: Map<string, string>,
  beforeFrames: string[],
  afterFrames: string[],
): DebugStopDiff {
  const changed: DebugVariableDelta[] = [];
  const added: DebugVariableDelta[] = [];
  const removed: DebugVariableDelta[] = [];
  let unchangedCount = 0;

  for (const [key, value] of after) {
    const [scope = '', ...rest] = key.split('/');
    const path = rest.join('/');

    if (!before.has(key)) {
      added.push({ scope, path, change: 'added', after: value });
    } else if (before.get(key) !== value) {
      changed.push({ scope, path, change: 'changed', before: before.get(key), after: value });
    } else {
      unchangedCount++;
    }
  }
  for (const [key, value] of before) {
    if (after.has(key)) continue;
    const [scope = '', ...rest] = key.split('/');
    removed.push({ scope, path: rest.join('/'), change: 'removed', before: value });
  }

  const beforeSet = new Set(beforeFrames);
  const afterSet = new Set(afterFrames);

  return {
    fromStop: from.index,
    toStop: to.index,
    elapsedMs: Date.parse(to.at) - Date.parse(from.at),
    framesEntered: afterFrames.filter((name) => !beforeSet.has(name)),
    framesLeft: beforeFrames.filter((name) => !afterSet.has(name)),
    changed,
    added,
    removed,
    unchangedCount,
  };
}

// ---------------------------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------------------------

/** Renders bytes as a classic hex dump, sixteen per line with an offset column. */
export function toHexDump(bytes: Buffer): string {
  const lines: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const slice = bytes.subarray(offset, offset + 16);
    const hex = [...slice].map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
    lines.push(`${offset.toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  ${toPrintable(slice)}`);
  }
  return lines.join('\n');
}

/** The right-hand column of a hex dump: printable ASCII, everything else as a dot. */
export function toPrintable(bytes: Buffer): string {
  let out = '';
  for (const byte of bytes) {
    out += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '.';
  }
  return out;
}

/** A short, safe rendering of a message for the timeline. Full payloads are never retained. */
function summarize(message: Record<string, unknown>, name: string): string | undefined {
  const body = (message.body ?? message.arguments) as Record<string, unknown> | undefined;
  if (!body) return undefined;

  const parts: string[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (parts.length >= 4) break;
    if (value === null || value === undefined) continue;

    if (Array.isArray(value)) parts.push(`${key}[${value.length}]`);
    else if (typeof value === 'object') parts.push(`${key}{}`);
    else {
      const text = String(value);
      parts.push(`${key}=${text.length > 40 ? `${text.slice(0, 37)}…` : text}`);
    }
  }
  return parts.length > 0 ? `${name} ${parts.join(' ')}` : undefined;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function emptyRecord(sessionId: string): DebugSessionRecord {
  return {
    sessionId,
    startedAt: new Date().toISOString(),
    status: 'initializing',
    stops: [],
    diffs: [],
    breakpoints: [],
    modules: [],
    loadedSources: [],
    evaluations: [],
    output: [],
    timeline: [],
    totals: {
      requests: 0, responses: 0, events: 0, probes: 0, failedResponses: 0,
      bytesIn: 0, bytesOut: 0, stops: 0,
    },
    warnings: [],
  };
}

/** The process-wide recorder the DAP proxy feeds and the adapters read. */
export const debugRecorder = new DebugRecorder('default');
