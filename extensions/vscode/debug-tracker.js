'use strict';

/**
 * Deep debug capture from inside VS Code, with no proxy at all.
 *
 * ## Why this exists, and why it matters more than the rest of the extension
 *
 * The hardest thing about Auspex's deep debug capture has nothing to do with debugging. It is that
 * the user has to put the proxy between their editor and its debug adapter — one line of
 * configuration, and a line most people cannot write, because **they do not know what their editor
 * runs.** VS Code launches adapters out of extension directories with generated arguments; the
 * command appears nowhere a person would look. `auspex debug wire` exists to guess at it, and for
 * adapters that live inside extensions it honestly cannot.
 *
 * `vscode.debug.registerDebugAdapterTrackerFactory` removes the problem rather than solving it. It
 * is a supported API that hands an extension every DAP message in both directions, for every debug
 * session the user starts, with no configuration whatsoever. Install the extension, press F5, and
 * the capture happens.
 *
 * That is a better plugin than the proxy in every respect that matters:
 *
 * - **No setup.** No command to find, no launch.json to edit, no port to pick.
 * - **Every session**, including ones started from the Run menu, from a test explorer, or by
 *   another extension.
 * - **Compound and child sessions** — a browser session spawned by a Node session is tracked too,
 *   which the proxy cannot see at all because it only sits on one pipe.
 * - **Session metadata** the wire does not carry: the configuration's name, its type, its parent.
 *
 * ## The one thing it cannot do, stated plainly
 *
 * A tracker **observes**; it cannot inject requests. `onWillReceiveMessage` and `onDidSendMessage`
 * are notifications, not a channel — there is no supported way for a tracker to send a request of
 * its own and receive the reply. So this captures everything the editor's UI asked for, in full
 * fidelity, with timing — and it does *not* do the active probing that is the whole point of the
 * proxy.
 *
 * That makes the two complementary rather than redundant, and the honest recommendation is:
 *
 * - **Tracker** for zero-setup capture of every session, the stack, the timeline, breakpoints,
 *   output, exceptions, and every variable the user expanded.
 * - **Proxy** when you need what nobody expanded: every scope of every frame, deep variable trees,
 *   memory, other threads.
 *
 * The tracker says which of the two it is, in every payload it sends, so nothing downstream ever
 * mistakes a UI-shaped capture for a complete one. Overstating this would be the worst kind of
 * error here: a reader who believes they are seeing the whole program state when they are seeing
 * one collapsed pane will conclude that a variable does not exist.
 *
 * ## Everything stays local
 *
 * Posted to a loopback URL, exactly like the rest of the extension. Nothing leaves the machine.
 */

const vscode = require('vscode');

/** How many wire events to keep per session before the oldest are dropped. */
const TIMELINE_LIMIT = 2000;

/** How often to publish, at most. Debug traffic is bursty and publishing per message would thrash. */
const PUBLISH_INTERVAL_MS = 1000;

/** Largest single value string to keep. */
const MAX_VALUE = 4096;

/** Sessions being tracked, keyed by VS Code's session id. */
const sessions = new Map();

let output;
let publishTimer;
let endpoint;

/**
 * Registers the tracker for every debug type.
 *
 * The `'*'` wildcard is the whole reason this is language-agnostic: it matches every adapter,
 * including ones that did not exist when this was written, which is the same property the proxy
 * gets from working at the protocol level.
 */
function activateDebugTracker(context, options) {
  output = options.output;
  endpoint = options.endpoint;

  context.subscriptions.push(
    vscode.debug.registerDebugAdapterTrackerFactory('*', {
      createDebugAdapterTracker(session) {
        return createTracker(session);
      },
    }),
  );

  context.subscriptions.push(
    vscode.debug.onDidStartDebugSession((session) => {
      output.appendLine(`Auspex: tracking debug session "${session.name}" (${session.type}).`);
    }),
    vscode.debug.onDidTerminateDebugSession((session) => {
      const state = sessions.get(session.id);
      if (state) {
        state.status = 'terminated';
        state.endedAt = new Date().toISOString();
        // Published immediately rather than on the next tick: the end of a session is exactly when
        // someone reaches for the record, and a one-second gap is a gap they would notice.
        void publish(state);
      }
    }),
  );

  publishTimer = setInterval(() => {
    for (const state of sessions.values()) {
      if (state.dirty) void publish(state);
    }
  }, PUBLISH_INTERVAL_MS);

  context.subscriptions.push({
    dispose() {
      clearInterval(publishTimer);
      sessions.clear();
    },
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('auspex.debugStatus', showStatus),
  );
}

function createTracker(session) {
  const state = {
    sessionId: session.id,
    name: session.name,
    adapterType: session.type,
    parentId: session.parentSession ? session.parentSession.id : undefined,
    configuration: sanitizeConfiguration(session.configuration),
    startedAt: new Date().toISOString(),
    status: 'initializing',
    capabilities: undefined,
    currentStop: undefined,
    stops: [],
    breakpoints: [],
    output: [],
    timeline: [],
    totals: {
      requests: 0, responses: 0, events: 0, probes: 0, failedResponses: 0,
      bytesIn: 0, bytesOut: 0, stops: 0,
    },
    warnings: [],
    dirty: true,
    // Requests awaiting a reply, for round-trip timing.
    pending: new Map(),
    // The frames of the current stop, filled in as the editor's UI asks for them.
    frames: {},
    stacks: {},
    threads: [],
    stopCount: 0,
    lastEventAt: 0,
    eventSeq: 0,
  };
  sessions.set(session.id, state);

  return {
    onWillStartSession() {
      state.status = 'running';
      state.dirty = true;
    },

    /** A message from the editor to the adapter. */
    onWillReceiveMessage(message) {
      note(state, message, 'in');
      if (message.type === 'request') {
        state.totals.requests++;
        state.pending.set(message.seq, { command: message.command, at: Date.now(), args: message.arguments });
      }
    },

    /** A message from the adapter to the editor. */
    onDidSendMessage(message) {
      note(state, message, 'out');
      if (message.type === 'event') handleEvent(state, message);
      else if (message.type === 'response') handleResponse(state, message);
    },

    onWillStopSession() {
      state.status = 'terminated';
      state.endedAt = new Date().toISOString();
      state.dirty = true;
    },

    onError(error) {
      state.warnings.push(`adapter error: ${error && error.message ? error.message : String(error)}`);
      state.dirty = true;
    },

    onExit(code, signal) {
      state.status = 'terminated';
      state.exitCode = code;
      if (signal) state.warnings.push(`the adapter was terminated by signal ${signal}`);
      state.dirty = true;
      void publish(state);
    },
  };
}

function handleEvent(state, message) {
  const body = message.body || {};
  state.totals.events++;
  state.dirty = true;

  switch (message.event) {
    case 'stopped': {
      state.status = 'paused';
      state.stopCount++;

      if (state.currentStop) {
        state.stops.push(state.currentStop);
        while (state.stops.length > 20) state.stops.shift();
      }
      // A fresh stop invalidates every frame id from the previous one: DAP ids are only valid for
      // the stop that issued them, and carrying them over would attach old values to new frames.
      state.frames = {};
      state.stacks = {};

      state.currentStop = {
        index: state.stopCount,
        at: new Date().toISOString(),
        reason: body.reason,
        description: body.description,
        text: body.text,
        threadId: body.threadId,
        allThreadsStopped: body.allThreadsStopped === true,
        hitBreakpointIds: body.hitBreakpointIds,
        threads: state.threads,
        stacks: state.stacks,
        frames: state.frames,
        captureMs: 0,
        incomplete: [
          'captured by the VS Code tracker: this holds what the editor requested, which is what ' +
          'was visible in the UI. Scopes nobody opened and variables nobody expanded were never ' +
          'sent over the wire and are absent here rather than empty.',
        ],
      };
      state.totals.stops = state.stopCount;
      void publish(state);
      break;
    }

    case 'continued':
      state.status = 'running';
      break;

    case 'terminated':
    case 'exited':
      state.status = 'terminated';
      state.endedAt = new Date().toISOString();
      break;

    case 'output': {
      const text = typeof body.output === 'string' ? body.output : '';
      for (const line of text.split('\n')) {
        if (!line && text.trim()) continue;
        state.output.push({
          at: new Date().toISOString(),
          category: body.category || 'console',
          text: line.replace(/\r$/, ''),
          file: body.source && body.source.path,
          line: body.line,
        });
      }
      while (state.output.length > 1000) state.output.shift();
      break;
    }

    case 'breakpoint': {
      const breakpoint = body.breakpoint;
      if (!breakpoint) break;

      if (body.reason === 'removed') {
        state.breakpoints = state.breakpoints.filter((item) => item.id !== breakpoint.id);
        break;
      }
      const existing = state.breakpoints.find((item) => item.id === breakpoint.id);
      const updated = {
        kind: 'line',
        id: breakpoint.id,
        verified: breakpoint.verified === true,
        message: breakpoint.message,
        file: breakpoint.source && breakpoint.source.path,
        line: breakpoint.line,
        hitCount: breakpoint.hitCount,
      };
      if (existing) Object.assign(existing, updated);
      else state.breakpoints.push(updated);
      break;
    }

    case 'thread':
      // Threads coming and going explains a stack that vanished between two stops.
      state.warnings = state.warnings.filter((item) => !item.startsWith('thread '));
      break;
  }
}

function handleResponse(state, message) {
  const asked = state.pending.get(message.request_seq);
  if (asked) state.pending.delete(message.request_seq);

  state.totals.responses++;
  if (message.success === false) state.totals.failedResponses++;
  state.dirty = true;

  const body = message.body || {};
  const args = (asked && asked.args) || {};

  switch (message.command) {
    case 'initialize':
      state.capabilities = body;
      break;

    case 'threads':
      state.threads = (body.threads || []).map((thread) => ({
        id: thread.id,
        name: thread.name,
        stopped: state.currentStop ? thread.id === state.currentStop.threadId : undefined,
      }));
      if (state.currentStop) state.currentStop.threads = state.threads;
      break;

    case 'stackTrace': {
      const threadId = args.threadId;
      if (threadId === undefined) break;

      state.stacks[threadId] = (body.stackFrames || []).map((frame) => ({
        id: frame.id,
        name: frame.name,
        file: frame.source && frame.source.path,
        sourceName: frame.source && frame.source.name,
        line: frame.line,
        column: frame.column,
        presentationHint: frame.presentationHint,
        unmapped: !(frame.source && frame.source.path),
        moduleId: frame.moduleId,
        instructionPointerReference: frame.instructionPointerReference,
      }));
      break;
    }

    case 'scopes': {
      const frameId = args.frameId;
      if (frameId === undefined) break;

      state.frames[frameId] = (body.scopes || []).map((scope) => ({
        name: scope.name,
        presentationHint: scope.presentationHint,
        expensive: scope.expensive === true,
        namedVariables: scope.namedVariables,
        indexedVariables: scope.indexedVariables,
        variables: [],
        // The reference is kept so a later `variables` response can be filed under the right scope.
        _reference: scope.variablesReference,
        skipped: 'the editor requested this scope but its contents have not arrived yet',
      }));
      break;
    }

    case 'variables': {
      const reference = args.variablesReference;
      if (reference === undefined) break;

      const variables = (body.variables || []).map((variable) => ({
        name: variable.name,
        value: clip(String(variable.value === undefined ? '' : variable.value)),
        type: variable.type,
        evaluateName: variable.evaluateName,
        kind: variable.presentationHint && variable.presentationHint.kind,
        attributes: variable.presentationHint && variable.presentationHint.attributes,
        namedVariables: variable.namedVariables,
        indexedVariables: variable.indexedVariables,
        memoryReference: variable.memoryReference,
        _reference: variable.variablesReference,
        truncated: variable.variablesReference > 0
          ? 'expandable; the editor has not expanded it, so its children were never sent'
          : undefined,
      }));

      if (!fileVariables(state, reference, variables)) {
        // A reference we have not seen a parent for. Recorded rather than dropped, because it is
        // usually a hover or a watch expression, which is real state the user asked to see.
        state.orphanVariables = state.orphanVariables || {};
        state.orphanVariables[reference] = variables;
      }
      break;
    }

    case 'setBreakpoints': {
      const source = args.source || {};
      const requested = args.breakpoints || [];
      const resolved = body.breakpoints || [];

      state.breakpoints = state.breakpoints.filter((item) => item.file !== source.path);

      for (let index = 0; index < Math.max(requested.length, resolved.length); index++) {
        const asked2 = requested[index] || {};
        const got = resolved[index] || {};
        state.breakpoints.push({
          kind: 'line',
          id: got.id,
          verified: got.verified === true,
          message: got.message,
          file: (got.source && got.source.path) || source.path,
          line: got.line !== undefined ? got.line : asked2.line,
          condition: asked2.condition,
          hitCondition: asked2.hitCondition,
          logMessage: asked2.logMessage,
          enabled: true,
        });
      }
      break;
    }

    case 'exceptionInfo':
      if (state.currentStop) {
        const details = body.details || {};
        state.currentStop.exception = {
          exceptionId: body.exceptionId,
          description: body.description,
          breakMode: body.breakMode,
          message: details.message,
          typeName: details.typeName,
          stackTrace: details.stackTrace,
        };
      }
      break;
  }
}

/** Files a `variables` response under the scope or parent variable that asked for it. */
function fileVariables(state, reference, variables) {
  for (const scopes of Object.values(state.frames)) {
    for (const scope of scopes) {
      if (scope._reference === reference) {
        scope.variables = variables;
        scope.skipped = undefined;
        return true;
      }
      if (attachToChild(scope.variables, reference, variables)) return true;
    }
  }
  return false;
}

function attachToChild(variables, reference, children) {
  for (const variable of variables) {
    if (variable._reference === reference) {
      variable.children = children;
      variable.truncated = undefined;
      return true;
    }
    if (variable.children && attachToChild(variable.children, reference, children)) return true;
  }
  return false;
}

/** Appends to the timeline. */
function note(state, message, direction) {
  const now = Date.now();
  let serialized = '';
  try {
    serialized = JSON.stringify(message);
  } catch {
    serialized = '';
  }

  const entry = {
    seq: ++state.eventSeq,
    at: new Date(now).toISOString(),
    deltaMs: state.lastEventAt === 0 ? 0 : now - state.lastEventAt,
    direction,
    type: message.type || 'unknown',
    name: message.command || message.event || '',
    bytes: Buffer.byteLength(serialized),
    success: message.type === 'response' ? message.success === true : undefined,
  };

  if (message.type === 'response') {
    const asked = state.pending.get(message.request_seq);
    if (asked) entry.durationMs = now - asked.at;
  }

  state.lastEventAt = now;
  if (direction === 'in') state.totals.bytesIn += entry.bytes;
  else state.totals.bytesOut += entry.bytes;

  state.timeline.push(entry);
  while (state.timeline.length > TIMELINE_LIMIT) state.timeline.shift();
}

/**
 * Strips a launch configuration of the things that should not leave the editor.
 *
 * The `env` block of a launch configuration is where people put database passwords and API keys,
 * and it is not something a context tool should be forwarding anywhere — even to loopback, even
 * redacted. The names are kept because knowing *which* variables a program was launched with is
 * genuinely useful and the names are not the secret.
 */
function sanitizeConfiguration(configuration) {
  if (!configuration) return undefined;
  const copy = {};

  for (const [key, value] of Object.entries(configuration)) {
    if (key === 'env' || key === 'environment' || key === 'envFile') {
      copy[key] = value && typeof value === 'object'
        ? { _names: Object.keys(value), _note: 'values withheld by the extension' }
        : '[withheld]';
      continue;
    }
    copy[key] = value;
  }
  return copy;
}

/** Posts a session to the local server. */
async function publish(state) {
  state.dirty = false;

  const payload = {
    editor: 'vscode-debug-tracker',
    name: `VS Code debug: ${state.name}`,
    pid: process.pid,
    debugSession: {
      sessionId: state.sessionId,
      name: state.name,
      adapterType: state.adapterType,
      parentId: state.parentId,
      startMethod: state.configuration && state.configuration.request,
      configuration: state.configuration,
      startedAt: state.startedAt,
      endedAt: state.endedAt,
      status: state.status,
      capabilities: state.capabilities,
      currentStop: state.currentStop,
      stops: state.stops,
      diffs: [],
      breakpoints: state.breakpoints,
      modules: [],
      loadedSources: [],
      evaluations: [],
      output: state.output,
      timeline: state.timeline,
      totals: state.totals,
      warnings: state.warnings,
      // The single most important field in this payload. Everything downstream needs to know that
      // an absent variable here means "nobody looked at it", not "it does not exist".
      captureMethod: 'vscode-tracker',
      captureNote:
        'Captured passively from inside VS Code. This holds exactly what the editor requested — ' +
        'the panes that were open, the variables that were expanded. For every scope of every ' +
        'frame, deep variable trees and memory, run `auspex proxy --dap --deep`.',
    },
  };

  try {
    const response = await fetch(endpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    // A server that is not running is the normal case. Recorded once, not repeatedly: a debug
    // session produces a publish every second and a log line per failure would bury everything.
    const message = error && error.message ? error.message : String(error);
    if (state.lastPublishError !== message) {
      state.lastPublishError = message;
      output.appendLine(`Auspex: could not publish debug session (${message}). Is \`auspex serve\` running?`);
    }
  }
}

function showStatus() {
  if (sessions.size === 0) {
    vscode.window.showInformationMessage('Auspex: no debug session is being tracked. Start one with F5.');
    return;
  }
  const lines = [];
  for (const state of sessions.values()) {
    lines.push(
      `${state.name} (${state.adapterType}): ${state.status}, ${state.totals.stops} stop(s), ` +
      `${state.timeline.length} message(s)`,
    );
  }
  vscode.window.showInformationMessage(`Auspex debug: ${lines.join(' · ')}`, 'Open output')
    .then((choice) => { if (choice) output.show(); });
}

function clip(value) {
  return value.length > MAX_VALUE ? `${value.slice(0, MAX_VALUE - 1)}…` : value;
}

module.exports = { activateDebugTracker };
