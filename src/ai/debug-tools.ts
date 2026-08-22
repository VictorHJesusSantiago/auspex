/**
 * Tool definitions for the assistants that do not speak MCP.
 *
 * MCP clients discover Auspex's tools by asking. GPT and Gemini do not: their function calling is
 * driven by schemas the *caller* supplies with every request, so someone building against them has
 * to write those schemas by hand — and hand-written schemas drift from the server the moment either
 * changes. Generating them here from one description keeps the three surfaces telling the same
 * story, which is the only way a bug in a tool description gets fixed once instead of three times.
 *
 * The debug tools are separated from the context tools deliberately. They address a different
 * server state (a session published by a proxy, not a capture of the machine), they are useless
 * when no session exists, and an agent that is not debugging should not be carrying five tool
 * definitions it will never call. `providers.ts` composes the two when both are wanted.
 *
 * ## What makes these descriptions good rather than merely present
 *
 * A model chooses a tool by reading its description and nothing else. So each one says **when to
 * reach for it in preference to the others** — the distinction between `get_debug_session` and
 * `get_debug_variables` is not obvious from their names and is the whole difference between a
 * useful call and a wasteful one. Each also says what it costs, because a model that knows
 * `get_debug_session` is large will reach for `get_debug_briefing` first, which is usually right.
 */

export interface DebugToolSpec {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required?: string[];
  };
  /** The HTTP route that serves this, for building a client. */
  route: { method: 'GET'; path: string; query?: string[] };
}

export const DEBUG_TOOL_SPECS: DebugToolSpec[] = [
  {
    name: 'get_debug_briefing',
    description:
      'A prose briefing on the paused program: why it stopped, where, the source at that line, ' +
      'the values in scope, what changed since the last stop, and observations worth checking. ' +
      'START HERE when a user asks about a running or crashed program — it is a fraction of the ' +
      'size of get_debug_session and answers most questions on its own. Reach for the structured ' +
      'tools afterwards only when you need a specific value the briefing did not include.',
    parameters: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Session id. Defaults to the most recent.' },
        maxTokens: { type: 'number', description: 'Reduce the briefing to fit a budget.', default: 6000 },
        includeMemory: { type: 'boolean', default: false },
      },
    },
    route: { method: 'GET', path: '/debug/briefing', query: ['session', 'maxTokens', 'includeMemory'] },
  },
  {
    name: 'get_debug_session',
    description:
      'The complete structured state of the paused program: every thread, the full call stack, ' +
      'every scope and variable of the stopped frame expanded recursively, the exception, loaded ' +
      'modules, breakpoints and output. LARGE — often thousands of tokens. Prefer ' +
      'get_debug_briefing for an overview and get_debug_variables for one value; use this when ' +
      'you need the whole structure, for example to walk an object graph.',
    parameters: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        includeTimeline: { type: 'boolean', default: false },
        includeMemory: { type: 'boolean', default: false },
        maxDepth: { type: 'number', default: 3, description: 'Variable tree depth. Lower it if the reply is large.' },
      },
    },
    route: { method: 'GET', path: '/debug', query: ['session', 'timeline', 'memory'] },
  },
  {
    name: 'get_debug_variables',
    description:
      'Variables at the paused program, filtered by name and returned at full depth. Use this ' +
      'when you already know which value you are chasing — it is far cheaper than fetching the ' +
      'whole session and it does not truncate the match. The name filter is a substring and ' +
      'searches at every depth, so "user" finds request.context.user.',
    parameters: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        name: { type: 'string', description: 'Substring of the variable name.' },
        scope: { type: 'string', description: 'Scope name, e.g. Locals. Defaults to all.' },
        frameId: { type: 'number', description: 'Defaults to the top frame.' },
        maxDepth: { type: 'number', default: 6 },
      },
    },
    route: { method: 'GET', path: '/debug/variables', query: ['session', 'name', 'scope', 'frameId', 'maxDepth'] },
  },
  {
    name: 'get_debug_changes',
    description:
      'What changed between the last two times the program stopped: frames entered and left, and ' +
      'variables added, removed or given a new value — plus how many held their value. Use this ' +
      'when the user is stepping through code and asks what an operation did. Neither snapshot on ' +
      'its own answers that question.',
    parameters: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        count: { type: 'number', default: 1, description: 'How many recent comparisons.' },
      },
    },
    route: { method: 'GET', path: '/debug/changes', query: ['session', 'count'] },
  },
  {
    name: 'get_debug_analysis',
    description:
      'Observations about the current stop, each with the evidence that produced it: a null value ' +
      'used on the executing line, breakpoints that never bound, recursion, a stop repeated in a ' +
      'loop, frames that are runtime rather than user code. These are FACTS WITH EVIDENCE, not ' +
      'diagnoses — verify any of them before acting on it. Useful as a second opinion after you ' +
      'have formed your own view of a briefing.',
    parameters: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        minSeverity: { type: 'string', enum: ['high', 'medium', 'low', 'info'], default: 'low' },
      },
    },
    route: { method: 'GET', path: '/debug/analysis', query: ['session', 'minSeverity'] },
  },
  {
    name: 'get_debug_timeline',
    description:
      'Every Debug Adapter Protocol message that crossed the wire, with direction, size and ' +
      'round-trip timing. Use it for questions about the debug session itself rather than the ' +
      'program: why the debugger feels slow, what the editor asked for, whether a request failed. ' +
      'Entries marked "probe" are the ones Auspex issued to gather state.',
    parameters: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        limit: { type: 'number', default: 100 },
        direction: { type: 'string', enum: ['in', 'out', 'probe'] },
        name: { type: 'string', description: 'Filter by command or event name.' },
      },
    },
    route: { method: 'GET', path: '/debug/timeline', query: ['session', 'limit', 'direction', 'name'] },
  },
  {
    name: 'read_debug_memory',
    description:
      'Raw memory captured behind variables that carry an address, as a hex dump with printable ' +
      'text. Only native adapters (lldb, gdb, cppdbg, Delve) report addresses; Python, Node, .NET ' +
      'and Java do not, and the reply says which reason applies rather than returning an ' +
      'unexplained empty list.',
    parameters: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        reference: { type: 'string', description: 'Memory reference. Defaults to everything captured.' },
      },
    },
    route: { method: 'GET', path: '/debug/memory', query: ['session', 'reference'] },
  },
  {
    name: 'get_debug_history',
    description:
      'Earlier stops from the session journal, including ones the live record has already ' +
      'evicted. Use this when a user asks what happened before a failure, or wants to compare a ' +
      'working iteration with a failing one. Takes a range of stop indices.',
    parameters: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        from: { type: 'number', default: 1 },
        to: { type: 'number' },
        limit: { type: 'number', default: 10 },
      },
    },
    route: { method: 'GET', path: '/debug/history', query: ['session', 'from', 'to', 'limit'] },
  },
  {
    name: 'search_debug_history',
    description:
      'Search EVERY captured stop, not just the current one — by variable name, by value, by type, ' +
      'or by interpreted kind (`empty` matches null, nil, None, undefined and nullptr alike). No ' +
      'IDE debugger can answer "was user ever non-null" or "which iteration first had an empty ' +
      'list", because a debugger watches a program and this one recorded it.',
    parameters: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        name: { type: 'string', description: 'Substring of the variable name.' },
        value: { type: 'string', description: 'Substring of the value.' },
        kind: {
          type: 'string',
          enum: ['empty', 'error', 'collection', 'map', 'string', 'scalar', 'pointer', 'future', 'lazy'],
          description: 'Interpreted kind, which works the same across every language.',
        },
        limit: { type: 'number', default: 50 },
      },
    },
    route: { method: 'GET', path: '/debug/search', query: ['session', 'name', 'value', 'type', 'kind', 'limit'] },
  },
  {
    name: 'trace_debug_variable',
    description:
      'One variable\'s entire history: every value it held, in order, with the stop and line where ' +
      'each change happened. "retries was 0, 0, 1, 2, 3 and then the exception" is a description ' +
      'of a bug, and producing it by hand would mean writing values down while stepping. Use it ' +
      'for any question about how a value came to be what it is.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Variable name or dotted path, e.g. request.user.id.' },
        session: { type: 'string' },
      },
      required: ['path'],
    },
    route: { method: 'GET', path: '/debug/trace', query: ['path', 'session'] },
  },
  {
    name: 'get_debug_threads',
    description:
      'Threads grouped by what each is doing — running user code, blocked on a lock, waiting on ' +
      'I/O, parked in a pool — rather than as a flat list. Turns a thousand goroutines or forty ' +
      'identical pool threads into a handful of meaningful groups, and names the threads in the ' +
      'project\'s own code. Reports the structural signature of a deadlock as a possibility with ' +
      'evidence, never as a claim: the protocol does not carry lock ownership.',
    parameters: { type: 'object', properties: { session: { type: 'string' } } },
    route: { method: 'GET', path: '/debug/threads', query: ['session'] },
  },
  {
    name: 'explain_debug_values',
    description:
      'What the values in a frame actually ARE, beyond the string the debugger printed: the kind ' +
      '(collection, map, pointer, null, error, unresolved future, lazy sequence) in any language, ' +
      'an inferred structural shape for dynamically typed values, and a statistical summary for a ' +
      'collection too large to read — "50,000 ints, range 0–4999, 12 negative" rather than the ' +
      'first hundred. Use it when a value looks opaque or a collection is too big.',
    parameters: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        frameId: { type: 'number', description: 'Defaults to the top frame.' },
      },
    },
    route: { method: 'GET', path: '/debug/values', query: ['session', 'frameId'] },
  },
  {
    name: 'decode_debug_memory',
    description:
      'Reads captured memory every plausible way at once — C string, UTF-16, length-prefixed, ' +
      'integer arrays at each width, floats, pointer tables — and reports which readings are ' +
      'self-consistent, scored, with the reason. Names debug fill patterns: 0xCDCDCDCD is ' +
      'uninitialized heap and 0xDDDDDDDD is freed memory, which means a use-after-free is already ' +
      'found. Native adapters only (lldb, gdb, cppdbg, Delve).',
    parameters: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        reference: { type: 'string' },
        endianness: { type: 'string', enum: ['little', 'big'] },
        pointerSize: { type: 'number', enum: [4, 8] },
      },
    },
    route: { method: 'GET', path: '/debug/memory/decode', query: ['session', 'reference', 'endianness', 'pointerSize'] },
  },
  {
    name: 'get_debug_wiring',
    description:
      'How to capture a debug session for this project: the launch configurations it already ' +
      'defines, which debug adapter each implies, and the exact command that puts Auspex in ' +
      'between. Call this when a debug tool reports no session — it turns "not configured" into ' +
      'a command the user can run.',
    parameters: {
      type: 'object',
      properties: {
        root: { type: 'string', description: 'Workspace path. Defaults to the first open one.' },
      },
    },
    route: { method: 'GET', path: '/debug/wiring', query: ['root'] },
  },
];

/**
 * OpenAI function-calling definitions.
 *
 * The `strict` flag is deliberately not set. It requires every property to be listed in `required`
 * and forbids defaults, which would turn every optional filter here into a value the model has to
 * invent — and a model inventing a `frameId` is worse than one omitting it.
 */
export function openAiDebugTools(): Array<Record<string, unknown>> {
  return DEBUG_TOOL_SPECS.map((spec) => ({
    type: 'function',
    function: {
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
    },
  }));
}

/**
 * Gemini function declarations.
 *
 * The same schemas without OpenAI's wrapper, and with `default` removed: Gemini's schema dialect
 * rejects it, and a tool list that fails validation is worse than one whose defaults are described
 * in prose — which they are, in every description above.
 */
export function geminiDebugTools(): Array<Record<string, unknown>> {
  return DEBUG_TOOL_SPECS.map((spec) => ({
    name: spec.name,
    description: spec.description,
    parameters: stripDefaults(spec.parameters),
  }));
}

/**
 * Anthropic tool definitions.
 *
 * For callers using the Messages API directly rather than through MCP — a smaller audience than the
 * other two, but the shape is different enough (`input_schema`, not `parameters`) that leaving them
 * to convert it by hand would be an obvious omission in a tool whose whole purpose is plugging into
 * assistants.
 */
export function anthropicDebugTools(): Array<Record<string, unknown>> {
  return DEBUG_TOOL_SPECS.map((spec) => ({
    name: spec.name,
    description: spec.description,
    input_schema: spec.parameters,
  }));
}

/** A curl-shaped description of how each tool maps to the HTTP server, for building a client. */
export function debugToolRoutes(baseUrl = 'http://127.0.0.1:4278'): Array<Record<string, unknown>> {
  return DEBUG_TOOL_SPECS.map((spec) => ({
    tool: spec.name,
    method: spec.route.method,
    url: `${baseUrl}${spec.route.path}`,
    query: spec.route.query ?? [],
  }));
}

function stripDefaults(schema: DebugToolSpec['parameters']): Record<string, unknown> {
  const properties: Record<string, unknown> = {};

  for (const [name, definition] of Object.entries(schema.properties)) {
    const { default: _ignored, ...rest } = definition;
    properties[name] = rest;
  }
  return { type: 'object', properties, ...(schema.required ? { required: schema.required } : {}) };
}
