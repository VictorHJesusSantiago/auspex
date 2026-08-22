import type { DebugVariable } from '../core/debug-model.ts';

/**
 * Understanding a debugger's value strings, whatever language produced them.
 *
 * ## The problem this exists to solve
 *
 * DAP transports every variable as **a name, a type string and a value string**. Those strings are
 * whatever the debug adapter chose to print: `debugpy` calls `repr()`, the .NET adapter calls
 * `ToString()`, `lldb` prints a summary from a formatter if one is loaded and raw structure if not,
 * and Delve prints its own Go syntax. There is no structured representation on the wire at all.
 *
 * An IDE handles this by shipping a *renderer per language* — a Python one, a .NET one, a C++ one.
 * That works and it is why an IDE's variable pane looks good, and it is also why an IDE's variable
 * pane looks bad the moment you point it at a language nobody wrote a renderer for.
 *
 * Auspex takes the opposite approach, because its whole premise is being indifferent to the
 * language: **interpret the conventions rather than the languages.** Almost every runtime in
 * existence prints a collection as brackets, a map as braces with `key: value` or `key => value`,
 * a null as one of a dozen well-known words, a pointer as `0x…`, and an optional as a wrapper with
 * a recognizable name. Those conventions are shared far more widely than the languages that use
 * them, and matching on them gives useful structure for a language this code has never heard of.
 *
 * ## What this buys, concretely
 *
 * - A **kind** for every value — scalar, collection, map, pointer, optional, error, future, lazy,
 *   opaque — which is what lets everything downstream reason without a per-language branch.
 * - **Statistical summaries of enormous collections** instead of the first hundred elements. A list
 *   of 50,000 integers is better described as "50,000 ints, 0–4,999, 12 negative" than by its first
 *   hundred, and no IDE does this.
 * - **Inferred structure for dynamically typed values**, so a Python dict or a JavaScript object
 *   gets a shape — the thing a statically typed language would have given you for free.
 * - **Unwrapping**, so an `Option<Result<T, E>>` or a `Future<Response>` is reported as what it
 *   actually holds instead of a wrapper name.
 *
 * ## The honesty rule
 *
 * Every interpretation is a *guess about a formatted string*, and it says so: `confidence` is
 * `certain` only when the type string confirms the shape, `likely` when the value's syntax is
 * unambiguous, and `guess` otherwise. Nothing here ever discards the original string — `raw` is
 * always present, so a reader who disagrees with an interpretation can ignore it entirely. An
 * interpretation layer that overwrote the debugger's own output would be trading a reliable fact
 * for an unreliable one.
 */

export type ValueKind =
  | 'scalar'        // A number, boolean or single primitive.
  | 'string'
  | 'empty'         // null, nil, None, undefined, nullptr.
  | 'collection'    // Ordered: list, array, vector, slice, tuple, set.
  | 'map'           // Keyed: dict, map, object, hash, record, struct.
  | 'object'        // An instance with fields, not a container.
  | 'pointer'       // An address, reference or handle.
  | 'function'      // A callable, closure, lambda, method.
  | 'optional'      // A wrapper that may or may not hold a value.
  | 'error'         // An exception, Err, Failure, Result in its failed state.
  | 'future'        // A promise, task, deferred, coroutine, goroutine handle.
  | 'lazy'          // Not yet evaluated: a generator, a lazy sequence, a thunk.
  | 'binary'        // Bytes, buffers, byte arrays.
  | 'opaque';       // Understood to be something, but not what.

export interface InterpretedValue {
  kind: ValueKind;
  /** The debugger's own string, never discarded. */
  raw: string;
  /** How much to trust the interpretation. */
  confidence: 'certain' | 'likely' | 'guess';
  /** A short, readable rendering — often the raw string, sometimes better. */
  display: string;
  /** Element or entry count, when the value is a container and the count is knowable. */
  size?: number;
  /** The type the value carries, normalized across syntaxes. */
  type?: string;
  /** For wrappers: what is inside. */
  inner?: string;
  /** For pointers: the address. */
  address?: string;
  /** True when the value is a placeholder rather than the data — a truncated repr, a lazy handle. */
  incomplete?: boolean;
  /** Why this interpretation was reached, for a reader who wants to check it. */
  because?: string;
}

/** Words that mean "nothing here", across runtimes. Matched whole, never as substrings. */
const EMPTY_WORDS = new Set([
  'null', 'NULL', 'Null', 'nil', 'Nil', 'NIL', 'None', 'none', 'undefined', 'nullptr',
  '(null)', '<null>', 'void', 'Nothing', 'nothing', 'NA', 'NaN', 'nan', 'Unit', '()',
  'undef', 'Undefined', 'missing', 'Missing', '0x0', 'null pointer', 'NULL POINTER',
]);

/** Type-name fragments that identify a kind regardless of how the value happens to print. */
const TYPE_HINTS: Array<{ kind: ValueKind; patterns: RegExp[] }> = [
  {
    kind: 'collection',
    patterns: [
      /^(?:list|array|vector|slice|tuple|set|frozenset|deque|seq|sequence|ienumerable|iterable)\b/i,
      /^(?:std::)?(?:vector|array|list|deque|set|unordered_set|forward_list|valarray)\b/,
      /^(?:System\.)?(?:Collections\.)?(?:Generic\.)?(?:List|HashSet|Queue|Stack|IList|ICollection)\b/,
      /^(?:java\.util\.)?(?:ArrayList|LinkedList|HashSet|TreeSet|Vector|Collection)\b/,
      /^\[\]/,                                  // Go slice: `[]string`.
      /\[\]$/,                                  // Java/C# array: `String[]`.
      /^Vec<|^VecDeque<|^BTreeSet<|^HashSet</,  // Rust.
      /^Enumerable|^Array$/i,
    ],
  },
  {
    kind: 'map',
    patterns: [
      /^(?:dict|map|hash|hashmap|dictionary|table|record|struct|object)\b/i,
      /^(?:std::)?(?:map|unordered_map|multimap)\b/,
      /^(?:System\.)?(?:Collections\.)?(?:Generic\.)?(?:Dictionary|IDictionary|SortedDict)/,
      /^(?:java\.util\.)?(?:HashMap|TreeMap|LinkedHashMap|Map|Properties)\b/,
      /^map\[/,                                 // Go: `map[string]int`.
      /^HashMap<|^BTreeMap</,                   // Rust.
    ],
  },
  {
    kind: 'string',
    patterns: [
      /^(?:str|string|char\s*\*|nsstring|text|rope)\b/i,
      /^(?:std::)?(?:string|wstring|u16string|u32string|string_view)\b/,
      /^(?:System\.)?String$/, /^&?str$/, /^String$/,
    ],
  },
  {
    kind: 'binary',
    patterns: [
      /^(?:bytes|bytearray|buffer|blob|memoryview|byte\[\]|uint8array|arraybuffer)\b/i,
      /^(?:std::)?(?:byte|vector<(?:unsigned )?char>)/,
      /^\[\]byte$/, /^Vec<u8>$/,
    ],
  },
  {
    kind: 'optional',
    patterns: [
      /^(?:optional|option|maybe|nullable)\b/i,
      /^(?:std::)?optional</, /^Option</, /^Nullable</, /^Maybe\b/, /\?$/,
    ],
  },
  {
    kind: 'future',
    patterns: [
      /^(?:promise|future|task|deferred|coroutine|awaitable|async|thenable)\b/i,
      /^(?:std::)?(?:future|shared_future|promise)</,
      /^(?:System\.)?Threading\.Tasks\.Task/, /^CompletableFuture\b/, /^Mono<|^Flux</,
    ],
  },
  {
    kind: 'lazy',
    patterns: [
      /^(?:generator|iterator|lazy|thunk|stream|enumerator|range)\b/i,
      /^Lazy</, /^LazySeq\b/, /^Iterator</,
    ],
  },
  {
    kind: 'pointer',
    patterns: [
      /\*$/,                                    // `char *`, `Node *`.
      /^(?:std::)?(?:unique_ptr|shared_ptr|weak_ptr|auto_ptr)</,
      /^(?:Box|Rc|Arc|RefCell|Cell|Weak)</,     // Rust smart pointers.
      /^(?:ref|pointer|intptr|uintptr|handle)\b/i,
      /^&/,                                     // Rust or C++ reference.
    ],
  },
  {
    kind: 'error',
    patterns: [
      /(?:error|exception|fault|panic|failure)$/i,
      /^(?:std::)?(?:exception|runtime_error|logic_error)\b/,
    ],
  },
  {
    kind: 'function',
    patterns: [
      /^(?:function|func|lambda|closure|method|callable|delegate|action|fn)\b/i,
      /^(?:std::)?function</, /^Func<|^Action</, /^\(.*\)\s*(?:->|=>)/,
    ],
  },
];

/**
 * Interprets one value string with its type.
 *
 * Order matters and is deliberate: the **type string is consulted first** whenever there is one,
 * because it is the debugger stating a fact, while the value string is the debugger's *formatting*
 * of that fact and is far easier to misread. A Python value of `[1, 2, 3]` with type `str` is a
 * string that happens to contain brackets, and getting that backwards would be a silly error to
 * make confidently.
 */
export function interpretValue(value: string, type?: string): InterpretedValue {
  const raw = value;
  const trimmed = value.trim();

  // -- Emptiness. Checked before everything, because an empty value has no other structure and
  // because a wrong answer here is the one most likely to mislead a reader.
  if (EMPTY_WORDS.has(trimmed)) {
    return {
      kind: 'empty', raw, confidence: 'certain', display: trimmed, type,
      because: 'the value is one of the well-known words for absence',
    };
  }

  // -- The type string, when there is one.
  const fromType = type ? kindFromType(type) : undefined;

  // -- Strings. A quoted value is a string whatever else it looks like inside.
  if (/^(['"`])(.|\n)*\1$/.test(trimmed) || fromType === 'string') {
    const unquoted = /^(['"`])([\s\S]*)\1$/.exec(trimmed)?.[2] ?? trimmed;
    return {
      kind: 'string', raw, confidence: fromType === 'string' ? 'certain' : 'likely',
      display: trimmed, size: unquoted.length, type,
      // A repr that ends in an ellipsis has been cut by the debugger, and a reader treating it as
      // the whole string would draw a wrong conclusion about its contents.
      incomplete: /(?:\.\.\.|…)['"`]?$/.test(trimmed),
      because: fromType === 'string' ? 'the type says so' : 'the value is quoted',
    };
  }

  // -- Pointers and addresses.
  //
  // Before the numeric test, and that order is the whole of it: `0x7ffd4a2b1000` parses perfectly
  // well as a number, so a numeric test running first claims every address on the machine and
  // reports a pointer as a scalar. The condition below is what keeps this from going the other
  // way and claiming every hexadecimal integer.
  const hexOnly = /^0x[0-9a-fA-F]+$/.test(trimmed);
  const embedded = /^\(?[\w:\s*&]*\)?\s*0x[0-9a-fA-F]{4,}/.test(trimmed);
  const pointerType = fromType === 'pointer' || /\*/.test(type ?? '');

  if ((hexOnly || embedded) && (pointerType || (!type && hexOnly && trimmed.length >= 10))) {
    const hex = /0x[0-9a-fA-F]+/.exec(trimmed)?.[0];
    const nullPointer = hex !== undefined && /^0x0+$/.test(hex);

    return {
      kind: nullPointer ? 'empty' : 'pointer',
      raw,
      confidence: pointerType ? 'certain' : 'likely',
      display: trimmed,
      address: nullPointer ? undefined : hex,
      type,
      // A null pointer is an absence wearing a pointer's clothes, and the distinction is exactly
      // what a reader is asking about.
      because: nullPointer
        ? 'a null pointer'
        : pointerType
          ? 'the type says this is a pointer, and the value is an address'
          : 'the value is a bare address wide enough to be a pointer',
    };
  }

  // -- Numbers and booleans.
  if (/^[-+]?(?:\d[\d_]*\.?\d*(?:[eE][-+]?\d+)?|0x[0-9a-fA-F]+|0b[01]+|0o[0-7]+|\d+\/\d+)$/.test(trimmed)
      || /^(?:true|false|True|False|TRUE|FALSE|yes|no|#t|#f)$/.test(trimmed)) {
    return {
      kind: 'scalar', raw, confidence: 'certain', display: trimmed, type,
      because: 'the value parses as a number or a boolean',
    };
  }

  // -- Containers, read from the value's own brackets.
  const container = readContainer(trimmed);
  if (container) {
    const kind = fromType === 'map' || fromType === 'collection' ? fromType : container.kind;
    return {
      kind, raw, confidence: fromType ? 'certain' : 'likely', display: trimmed,
      size: container.size, type,
      incomplete: container.truncated,
      because: container.because,
    };
  }

  // -- Wrappers, which are what "any typing" mostly means in practice.
  const wrapper = readWrapper(trimmed);
  if (wrapper) return { ...wrapper, raw, type, confidence: fromType === wrapper.kind ? 'certain' : 'likely' };

  // -- Anything the type string identified but the value did not.
  if (fromType) {
    return {
      kind: fromType, raw, confidence: 'likely', display: trimmed, type,
      size: countFromText(trimmed),
      because: `the type "${type}" identifies this kind`,
    };
  }

  // -- An instance printed as a class name with fields.
  if (/^<[\w.]+ (?:object|instance)\b/.test(trimmed) || /^[A-Z][\w.]*\s*[({[]/.test(trimmed)) {
    return {
      kind: 'object', raw, confidence: 'guess', display: trimmed, type,
      because: 'the value looks like a class name followed by its fields',
    };
  }

  return {
    kind: 'opaque', raw, confidence: 'guess', display: trimmed, type,
    because: 'no convention matched; the debugger\'s own string is all there is',
  };
}

/** Matches a type string against the shared conventions. */
function kindFromType(type: string): ValueKind | undefined {
  const cleaned = type.trim();
  for (const { kind, patterns } of TYPE_HINTS) {
    if (patterns.some((pattern) => pattern.test(cleaned))) return kind;
  }
  return undefined;
}

/**
 * Reads a bracketed value, distinguishing an ordered container from a keyed one.
 *
 * The distinction is made by looking for key separators at the top level only. `{1: 2}` is a map
 * and `{1, 2}` is a set, and both are braces — the separator is the entire difference. Depth
 * tracking is what keeps a nested `{"a": [1, 2]}` from being read by its inner brackets.
 */
function readContainer(value: string):
  { kind: ValueKind; size: number; truncated: boolean; because: string } | undefined {
  const open = value[0];
  // Angle brackets are deliberately absent. In practice `<...>` is generic-parameter syntax or a
  // repr wrapper (`<generator object gen at 0x7f>`, `<Foo instance>`) far more often than it is a
  // container, and treating it as one made every such repr read as a one-element collection --
  // which is a confident wrong answer about a value the reader most needs to understand.
  const pairs: Record<string, string> = { '[': ']', '{': '}', '(': ')' };
  const close = open ? pairs[open] : undefined;
  if (!open || !close || !value.endsWith(close)) return undefined;

  const body = value.slice(1, -1).trim();
  if (body.length === 0) {
    return {
      kind: open === '{' ? 'map' : 'collection', size: 0, truncated: false,
      because: 'an empty container',
    };
  }

  let depth = 0;
  let quote: string | undefined;
  let commas = 0;
  let separators = 0;

  for (let index = 0; index < body.length; index++) {
    const character = body[index]!;

    if (quote) {
      if (character === quote && body[index - 1] !== '\\') quote = undefined;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') { quote = character; continue; }
    if ('[{(<'.includes(character)) { depth++; continue; }
    if (']})>'.includes(character)) { depth--; continue; }
    if (depth !== 0) continue;

    if (character === ',') commas++;
    // `:` for Python and JSON, `=>` for PHP and Ruby, `->` for some others, `=` for Go structs.
    else if (character === ':' && body[index + 1] !== ':') separators++;
    else if (character === '=' && (body[index + 1] === '>' || body[index - 1] !== '=')) separators++;
  }

  const elements = commas + 1;
  const truncated = /(?:\.\.\.|…)\s*$/.test(body);

  // A single separator in a one-element container is ambiguous (`{a: 1}` versus a set holding a
  // slice) so the majority rule is used: a map has roughly one separator per element.
  const looksKeyed = separators >= Math.max(1, Math.floor(elements * 0.75));

  return {
    kind: looksKeyed ? 'map' : 'collection',
    size: elements,
    truncated,
    because: looksKeyed
      ? `${separators} key separator(s) across ${elements} entries`
      : `${elements} comma-separated element(s)`,
  };
}

/**
 * Reads a wrapper: `Some(x)`, `Ok(x)`, `Err(e)`, `Just x`, `Promise { … }`, `Future<pending>`.
 *
 * These are how statically typed functional languages carry absence and failure, and reporting one
 * as an opaque object would throw away the single most important thing about it — a `Result` that
 * is `Err` is a failure sitting in a variable, and that is worth surfacing anywhere it appears.
 */
function readWrapper(value: string):
  { kind: ValueKind; display: string; inner?: string; because: string; incomplete?: boolean } | undefined {
  const call = /^(\w+)\s*[({]\s*([\s\S]*?)\s*[)}]$/.exec(value);

  if (call) {
    const [, name = '', inner = ''] = call;

    if (/^(?:Some|Just|Right|Present)$/i.test(name)) {
      return { kind: 'optional', display: value, inner, because: `${name} holds a value` };
    }
    if (/^(?:None|Nothing|Left|Empty|Absent)$/i.test(name)) {
      return { kind: 'empty', display: value, because: `${name} holds nothing` };
    }
    if (/^(?:Ok|Success)$/i.test(name)) {
      return { kind: 'optional', display: value, inner, because: `${name} is the successful case` };
    }
    if (/^(?:Err|Error|Failure|Fail)$/i.test(name)) {
      return { kind: 'error', display: value, inner, because: `${name} is the failure case` };
    }
  }

  if (/^(?:Promise|Future|Task|Deferred|Coroutine)\b/i.test(value)) {
    const state = /<(pending|fulfilled|rejected|resolved|running|completed|canceled|cancelled)>/i
      .exec(value)?.[1] ?? /\b(pending|fulfilled|rejected|resolved)\b/i.exec(value)?.[1];
    return {
      kind: /reject|cancel|fail/i.test(state ?? '') ? 'error' : 'future',
      display: value,
      inner: state,
      // A pending future holds nothing yet, and a reader expecting data would be misled.
      incomplete: /pending|running/i.test(state ?? ''),
      because: state ? `a future in the ${state} state` : 'a future',
    };
  }

  if (/^<(?:generator|iterator|coroutine|lazy|range)\b/i.test(value) || /^#<Enumerator/.test(value)) {
    return {
      kind: 'lazy', display: value, incomplete: true,
      because: 'a lazy sequence: nothing has been produced yet',
    };
  }

  if (/^<(?:function|lambda|bound method|built-in)\b/i.test(value) || /^ƒ\b/.test(value)) {
    return { kind: 'function', display: value, because: 'a callable' };
  }

  return undefined;
}

/** Pulls a count out of a value like `len=42`, `Count = 3`, `size: 9`, `(5 items)`. */
function countFromText(value: string): number | undefined {
  const match = /(?:len|length|count|size|n)\s*[:=]\s*(\d+)/i.exec(value)
    ?? /\((\d+)\s*(?:items?|elements?|entries)\)/i.exec(value);
  return match ? Number(match[1]) : undefined;
}

// ---------------------------------------------------------------------------------------------
// Structural inference
// ---------------------------------------------------------------------------------------------

export interface InferredShape {
  /** A type expression describing the value, in a language-neutral syntax. */
  shape: string;
  /** How many values the inference was drawn from. */
  sampled: number;
  /** True when the elements did not agree — a heterogeneous collection. */
  heterogeneous?: boolean;
  /** Fields that were present in some entries and not others. */
  optionalFields?: string[];
}

/**
 * Infers a structural type from an expanded value.
 *
 * This is the "any typing" half of the brief, and it is aimed squarely at dynamically typed
 * languages: a Python dict, a JavaScript object, a Ruby hash and a JSON blob all arrive with no
 * type worth the name, and what a reader actually wants to know is the *shape* — which fields
 * exist, what they hold, whether the list is homogeneous. A statically typed language hands that
 * over for free in the type string; a dynamic one never does, and this recovers it from the data.
 *
 * Written to be equally correct on a statically typed value, where it simply agrees with the type
 * the debugger already reported.
 */
export function inferShape(variable: DebugVariable, maxSample = 50): InferredShape {
  const children = variable.children ?? [];

  if (children.length === 0) {
    const interpreted = interpretValue(variable.value, variable.type);
    return { shape: variable.type ?? scalarShape(interpreted), sampled: 1 };
  }

  // Indexed children (`[0]`, `0`, `1`) mean an ordered container; named ones mean a record. This
  // is the same distinction `readContainer` makes, drawn from the expansion instead of the string.
  const indexed = children.every((child) => /^\[?\d+\]?$/.test(child.name));
  const sample = children.slice(0, maxSample);

  if (indexed) {
    const shapes = new Set(sample.map((child) => elementShape(child)));
    const heterogeneous = shapes.size > 1;

    return {
      shape: `${shapes.size === 1 ? [...shapes][0] : `${[...shapes].slice(0, 4).join(' | ')}`}[]`,
      sampled: sample.length,
      heterogeneous,
    };
  }

  const fields = sample.map((child) => `${child.name}: ${elementShape(child)}`);
  const shown = fields.slice(0, 12);

  return {
    shape: `{ ${shown.join('; ')}${fields.length > shown.length ? `; …${fields.length - shown.length} more` : ''} }`,
    sampled: sample.length,
  };
}

function elementShape(variable: DebugVariable): string {
  if (variable.type) return variable.type;
  const interpreted = interpretValue(variable.value);

  if (interpreted.kind === 'collection') return 'unknown[]';
  if (interpreted.kind === 'map') return 'object';
  return scalarShape(interpreted);
}

function scalarShape(interpreted: InterpretedValue): string {
  switch (interpreted.kind) {
    case 'string': return 'string';
    case 'empty': return 'null';
    case 'scalar': return /^(?:true|false)$/i.test(interpreted.display) ? 'boolean' : 'number';
    case 'function': return 'function';
    case 'pointer': return 'pointer';
    default: return interpreted.kind;
  }
}

// ---------------------------------------------------------------------------------------------
// Summarizing a large collection
// ---------------------------------------------------------------------------------------------

export interface CollectionSummary {
  count: number;
  /** How many were actually examined. */
  sampled: boolean;
  /** The dominant element type, and how much of the collection it accounts for. */
  elementType?: string;
  homogeneous: boolean;
  /** For numeric collections. */
  numeric?: { min: number; max: number; mean: number; negative: number; zero: number };
  /** For string collections. */
  strings?: { shortest: number; longest: number; empty: number; distinct: number };
  /** How many entries are empty values. */
  empties: number;
  /** A few representative entries, from the start, middle and end. */
  examples: string[];
}

/**
 * Describes a collection statistically rather than by listing it.
 *
 * **This is a thing IDE debuggers do not do, and the omission is felt constantly.** Expanding a
 * list of 50,000 integers in any IDE gives you the first hundred and a paging control; what you
 * usually wanted to know is whether any of them are negative, whether they are sorted, how many
 * are zero. A summary answers the question the listing does not.
 *
 * Samples from the **start, middle and end** rather than the head, because the head is where the
 * interesting case is least likely to be: a list that goes wrong usually goes wrong in the middle
 * or at the tail, and a hundred-element prefix hides exactly that.
 */
export function summarizeCollection(variable: DebugVariable, declaredCount?: number): CollectionSummary {
  const children = variable.children ?? [];
  const count = declaredCount ?? variable.indexedVariables ?? children.length;

  const types = new Map<string, number>();
  const numbers: number[] = [];
  const lengths: number[] = [];
  const distinct = new Set<string>();
  let empties = 0;
  let emptyStrings = 0;

  for (const child of children) {
    const interpreted = interpretValue(child.value, child.type);
    const key = child.type ?? interpreted.kind;
    types.set(key, (types.get(key) ?? 0) + 1);

    if (interpreted.kind === 'empty') empties++;

    if (interpreted.kind === 'scalar') {
      const parsed = Number(interpreted.display);
      if (Number.isFinite(parsed)) numbers.push(parsed);
    } else if (interpreted.kind === 'string') {
      const length = interpreted.size ?? 0;
      lengths.push(length);
      if (length === 0) emptyStrings++;
      distinct.add(interpreted.display);
    }
  }

  const dominant = [...types.entries()].sort((a, b) => b[1] - a[1])[0];

  return {
    count,
    sampled: children.length < count,
    elementType: dominant?.[0],
    homogeneous: types.size <= 1,
    numeric: numbers.length > 0
      ? {
        min: Math.min(...numbers),
        max: Math.max(...numbers),
        mean: Number((numbers.reduce((sum, value) => sum + value, 0) / numbers.length).toFixed(4)),
        negative: numbers.filter((value) => value < 0).length,
        zero: numbers.filter((value) => value === 0).length,
      }
      : undefined,
    strings: lengths.length > 0
      ? {
        shortest: Math.min(...lengths),
        longest: Math.max(...lengths),
        empty: emptyStrings,
        distinct: distinct.size,
      }
      : undefined,
    empties,
    examples: representatives(children).map((child) => `${child.name} = ${clip(child.value, 60)}`),
  };
}

/** Start, middle and end — where a problem is actually likely to be. */
function representatives(children: DebugVariable[]): DebugVariable[] {
  if (children.length <= 6) return children;
  const middle = Math.floor(children.length / 2);
  return [
    ...children.slice(0, 2),
    ...children.slice(middle - 1, middle + 1),
    ...children.slice(-2),
  ];
}

/** Renders a summary as a line a person or a model reads. */
export function renderCollectionSummary(summary: CollectionSummary): string {
  const parts = [`${summary.count.toLocaleString()} entries`];

  if (summary.elementType) {
    parts.push(summary.homogeneous ? `all ${summary.elementType}` : `mostly ${summary.elementType}, mixed`);
  }
  if (summary.numeric) {
    const { min, max, mean, negative, zero } = summary.numeric;
    parts.push(`range ${min}–${max}, mean ${mean}`);
    if (negative > 0) parts.push(`${negative} negative`);
    if (zero > 0) parts.push(`${zero} zero`);
  }
  if (summary.strings) {
    parts.push(`lengths ${summary.strings.shortest}–${summary.strings.longest}`);
    if (summary.strings.empty > 0) parts.push(`${summary.strings.empty} empty`);
    if (summary.strings.distinct < summary.count) parts.push(`${summary.strings.distinct} distinct`);
  }
  if (summary.empties > 0) parts.push(`${summary.empties} null`);
  if (summary.sampled) parts.push('sampled, not exhaustive');

  return parts.join(' · ');
}

/**
 * Interprets a whole variable tree in place, returning a parallel annotation map.
 *
 * Returned separately rather than merged into the variables, because the model shapes are what the
 * protocol produced and mixing derived guesses into them would make it impossible to tell later
 * which fields came from the debugger.
 */
export function interpretTree(
  variables: DebugVariable[],
  path = '',
  into = new Map<string, InterpretedValue>(),
): Map<string, InterpretedValue> {
  for (const variable of variables) {
    const key = path ? `${path}.${variable.name}` : variable.name;
    into.set(key, interpretValue(variable.value, variable.type));
    if (variable.children) interpretTree(variable.children, key, into);
  }
  return into;
}

function clip(value: string, width: number): string {
  const single = value.replace(/\s*\n\s*/g, ' ');
  return single.length > width ? `${single.slice(0, width - 1)}…` : single;
}
