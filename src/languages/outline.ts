import type { DocumentSymbol, SymbolKind } from '../core/model.ts';
import { detectLanguage, type LanguageFamily } from './registry.ts';
import { parseDataDocument } from './data.ts';

/**
 * Structural outlines for any file, in any language.
 *
 * **What this is and is not.** A real parser per language is the right answer and it is out of
 * scope: that means a grammar for each of the eighty-odd languages in the registry, or a native
 * tree-sitter dependency, and Auspex is deliberately dependency-free. What is here instead is a
 * two-tier arrangement that is honest about which tier produced a given result:
 *
 * 1. **Exact, where exactness is cheap.** Data and configuration formats — JSON, YAML, TOML, INI,
 *    XML, CSV, `.env`, `.properties` — are genuinely parsed, by real parsers in `data.ts`. Their
 *    grammars are small enough that "parse it properly" is a few hundred lines rather than a
 *    project, so there is no excuse for guessing.
 * 2. **Heuristic, where exactness is not.** Programming languages get pattern matching over their
 *    declaration syntax, grouped by family rather than by language, because C-family, ML-family and
 *    indentation-family languages each declare things in a handful of recognizable shapes. This
 *    finds the great majority of top-level declarations in ordinary code and will miss unusual
 *    formatting.
 *
 * The right way to get exact symbols for a programming language is the LSP adapter: if a language
 * server is running, it already has a real parse tree, and `adapters/lsp.ts` asks it. This module is
 * the fallback for when one is not — which, for a file open in a plain text editor, is most of the
 * time.
 */

/** Where an outline came from, so a consumer can weigh it. */
export type OutlineSource = 'parsed' | 'heuristic' | 'none';

export interface Outline {
  symbols: DocumentSymbol[];
  source: OutlineSource;
  /** Present when the extractor knows its own answer is incomplete. */
  note?: string;
}

/** Extracts an outline for a file's contents. */
export function extractOutline(path: string, text: string): Outline {
  const language = detectLanguage(path, text.split('\n', 1)[0]);

  // Data and config formats are parsed properly -- see this module's own docs for why that split.
  if (language.family === 'data' || language.family === 'config') {
    const parsed = parseDataDocument(language.id, text);
    if (parsed) return { symbols: parsed, source: 'parsed' };
  }
  if (language.family === 'markup') {
    return { symbols: extractMarkup(language.id, text), source: 'heuristic' };
  }
  if (language.family === 'style') {
    return { symbols: extractStyle(text), source: 'heuristic' };
  }
  if (language.family === 'programming' || language.family === 'query' || language.family === 'shell') {
    return {
      symbols: extractCode(language.family, language.id, text),
      source: 'heuristic',
      note: 'pattern-based; attach a language server for an exact outline',
    };
  }
  return { symbols: [], source: 'none' };
}

/** A declaration pattern: a regex whose first group is the name, plus the kind it produces. */
interface DeclarationPattern {
  kind: SymbolKind;
  pattern: RegExp;
  /** Which capture group holds the name. Defaults to 1. */
  nameGroup?: number;
}

/**
 * Declaration shapes, grouped by how a language spells them rather than by language.
 *
 * The grouping is the point. `class Foo`, `struct Foo`, `interface Foo` and `enum Foo` are written
 * the same way in a dozen unrelated languages, so one pattern set covers all of them; and a
 * language this tool has never heard of that follows the same convention gets a usable outline for
 * free, which is exactly the "indifferent to the language" property that matters here.
 */
const CODE_PATTERNS: DeclarationPattern[] = [
  // Types, across essentially every curly-brace and ML-family language.
  { kind: 'class', pattern: /^\s*(?:(?:public|private|protected|internal|export|abstract|final|sealed|static|open|data|partial)\s+)*class\s+([A-Za-z_$][\w$]*)/gm },
  { kind: 'struct', pattern: /^\s*(?:(?:public|private|pub|export|internal)\s+)*struct\s+([A-Za-z_$][\w$]*)/gm },
  { kind: 'interface', pattern: /^\s*(?:(?:public|private|export|internal|pub)\s+)*(?:interface|protocol|trait)\s+([A-Za-z_$][\w$]*)/gm },
  { kind: 'enum', pattern: /^\s*(?:(?:public|private|export|internal|pub)\s+)*enum(?:\s+class)?\s+([A-Za-z_$][\w$]*)/gm },
  { kind: 'namespace', pattern: /^\s*(?:namespace|module|package)\s+([A-Za-z_$][\w$.]*)/gm },
  { kind: 'typeParameter', pattern: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/gm },
  { kind: 'class', pattern: /^\s*(?:public\s+)?record\s+([A-Za-z_$][\w$]*)/gm },
  { kind: 'class', pattern: /^\s*(?:@\w+\s+)*(?:case\s+)?object\s+([A-Za-z_$][\w$]*)/gm },

  // Functions. Several spellings because the families genuinely differ.
  { kind: 'function', pattern: /^\s*(?:(?:export|public|private|protected|internal|static|async|pub|extern|inline|virtual|override)\s+)*(?:function|fn|func|def|sub|proc)\s+([A-Za-z_$][\w$]*)/gm },
  { kind: 'function', pattern: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/gm },
  // C, C++, C#, Java, Kotlin, Swift, Rust method-ish forms: `Type name(args) {`.
  { kind: 'method', pattern: /^[ \t]*(?:(?:public|private|protected|internal|static|final|abstract|override|virtual|async|suspend|open|inline)\s+)+(?:[\w<>[\],.?&*: ]+\s+)?([A-Za-z_$][\w$]*)\s*\([^;{]*\)\s*(?:->[^{;]+)?\s*\{/gm },
  { kind: 'function', pattern: /^\s*(?:let|val|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:function|fun|lambda)/gm },

  // The Lisp and BEAM families, whose declaration keywords share nothing with the C-family ones.
  // Worth their own entries rather than a looser general pattern: `defmodule`, `defn` and
  // `-module` are unambiguous, and loosening the patterns above to catch them would produce false
  // matches everywhere else.
  { kind: 'namespace', pattern: /^\s*defmodule\s+([A-Za-z_][\w.]*)/gm },
  { kind: 'interface', pattern: /^\s*def(?:protocol|impl)\s+([A-Za-z_][\w.]*)/gm },
  { kind: 'function', pattern: /^\s*defp?\s+([a-z_][\w?!]*)/gm },
  { kind: 'method', pattern: /^\s*defmacro p?\s*([a-z_][\w?!]*)/gm },
  { kind: 'function', pattern: /^\s*\(defn-?\s+([A-Za-z_$][\w$*+!?<>=/-]*)/gm },
  { kind: 'namespace', pattern: /^\s*\(ns\s+([A-Za-z_$][\w$.*+!?<>=/-]*)/gm },
  { kind: 'variable', pattern: /^\s*\(def\s+([A-Za-z_$][\w$*+!?<>=/-]*)/gm },
  { kind: 'module', pattern: /^\s*-module\(([a-z_][\w]*)\)/gm },

  // Constants and top-level bindings.
  { kind: 'constant', pattern: /^\s*(?:export\s+)?(?:const|final|static\s+readonly|readonly|val|constexpr)\s+([A-Z][A-Z0-9_]{2,})\b/gm },

  // Test declarations, which are what a developer is usually looking at when debugging.
  { kind: 'method', pattern: /^\s*(?:it|test|describe|context|Scenario|Feature)\s*\(\s*['"`]([^'"`]{1,120})['"`]/gm },
  { kind: 'method', pattern: /^\s*\[(?:Fact|Test|TestMethod|Theory)\]/gm, nameGroup: 0 },
];

/** SQL and shell get their own small sets; their declaration syntax has nothing in common. */
const QUERY_PATTERNS: DeclarationPattern[] = [
  { kind: 'class', pattern: /\bCREATE\s+(?:OR\s+REPLACE\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`[]?([\w.]+)/gi },
  { kind: 'interface', pattern: /\bCREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+["`[]?([\w.]+)/gi },
  { kind: 'function', pattern: /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\s+["`[]?([\w.]+)/gi },
  { kind: 'event', pattern: /\bCREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+["`[]?([\w.]+)/gi },
  { kind: 'property', pattern: /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?["`[]?([\w.]+)/gi },
];

const SHELL_PATTERNS: DeclarationPattern[] = [
  { kind: 'function', pattern: /^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{/gm },
  { kind: 'function', pattern: /^\s*function\s+([A-Za-z_][\w-]*)/gm },
  // PowerShell parameter blocks and Make targets are both useful outline entries.
  { kind: 'method', pattern: /^([A-Za-z_][\w.-]*)\s*:(?!=)/gm },
];

function extractCode(family: LanguageFamily, languageId: string, text: string): DocumentSymbol[] {
  const patterns = family === 'query' ? QUERY_PATTERNS
    : family === 'shell' ? SHELL_PATTERNS
    : languageId === 'python' ? [...CODE_PATTERNS, ...PYTHON_PATTERNS]
    : CODE_PATTERNS;

  const symbols = matchAll(text, patterns);

  // Python and other indentation-scoped languages get nesting from column position, which is the
  // one structural fact indentation makes trivially available.
  if (languageId === 'python' || languageId === 'yaml') {
    return nestByIndentation(text, symbols);
  }
  return symbols;
}

const PYTHON_PATTERNS: DeclarationPattern[] = [
  { kind: 'method', pattern: /^\s+(?:async\s+)?def\s+([A-Za-z_][\w]*)/gm },
  { kind: 'property', pattern: /^\s+([A-Za-z_][\w]*)\s*:\s*[A-Za-z_][\w[\], .]*\s*=/gm },
];

function extractMarkup(languageId: string, text: string): DocumentSymbol[] {
  if (languageId === 'markdown' || languageId === 'mdx') {
    return extractMarkdownHeadings(text);
  }
  // XML-ish: report elements carrying an id or a name, which is what makes them findable.
  const patterns: DeclarationPattern[] = [
    { kind: 'key', pattern: /<([A-Za-z][\w.-]*)[^>]*\s(?:id|name|key)\s*=\s*["']([^"']+)["']/g, nameGroup: 2 },
    { kind: 'module', pattern: /<([A-Za-z][\w.-]*)(?:\s|>)/g },
  ];
  const found = matchAll(text, patterns);
  // Only the first occurrence of each element name, or an HTML document becomes a wall of `<div>`.
  const seen = new Set<string>();
  return found.filter((symbol) => {
    const key = `${symbol.kind}:${symbol.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 200);
}

/** Markdown headings nest by level, which gives a genuinely accurate document outline. */
function extractMarkdownHeadings(text: string): DocumentSymbol[] {
  const lines = text.split('\n');
  const root: DocumentSymbol[] = [];
  const stack: Array<{ level: number; symbol: DocumentSymbol }> = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const match = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (!match) continue;

    const level = match[1]!.length;
    const symbol: DocumentSymbol = {
      name: match[2]!,
      kind: 'section',
      range: { start: { line: i, character: 0 }, end: { line: i, character: line.length } },
      children: [],
    };

    while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
    if (stack.length === 0) root.push(symbol);
    else stack[stack.length - 1]!.symbol.children!.push(symbol);
    stack.push({ level, symbol });
  }
  return prune(root);
}

function extractStyle(text: string): DocumentSymbol[] {
  const patterns: DeclarationPattern[] = [
    { kind: 'variable', pattern: /^\s*(--[\w-]+|\$[\w-]+|@[\w-]+)\s*:/gm },
    { kind: 'namespace', pattern: /^\s*@(media|supports|keyframes|font-face|import|layer|container)\b([^{;]*)/gm, nameGroup: 0 },
    { kind: 'class', pattern: /^\s*([.#][\w-]+(?:[^{;]*?))\s*\{/gm },
    { kind: 'key', pattern: /^\s*([a-zA-Z][\w-]*(?:\s*[,>+~]\s*[\w.#:[\]-]+)*)\s*\{/gm },
  ];
  return matchAll(text, patterns).slice(0, 400);
}

/** Runs a pattern set over the text and turns every match into a positioned symbol. */
function matchAll(text: string, patterns: DeclarationPattern[]): DocumentSymbol[] {
  const lineStarts = computeLineStarts(text);
  const symbols: DocumentSymbol[] = [];
  const seen = new Set<string>();

  for (const declaration of patterns) {
    const pattern = new RegExp(declaration.pattern.source, declaration.pattern.flags);
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) !== null) {
      // A zero-length match would spin forever; nudge past it. Real patterns should not produce
      // these, but one written carelessly later should degrade rather than hang.
      if (match[0].length === 0) {
        pattern.lastIndex++;
        continue;
      }

      const name = (match[declaration.nameGroup ?? 1] ?? match[0]).trim();
      if (!name || name.length > 200) continue;

      const start = offsetToPosition(match.index, lineStarts);
      const key = `${start.line}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);

      symbols.push({
        name,
        kind: declaration.kind,
        range: {
          start,
          end: offsetToPosition(match.index + match[0].length, lineStarts),
        },
      });
    }
  }

  symbols.sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
  return symbols;
}

/**
 * Nests symbols by their indentation, for languages where indentation *is* the scope.
 *
 * Only correct for those languages, which is why it is applied selectively rather than everywhere:
 * running it over C-family code would invent a hierarchy out of formatting preferences.
 */
function nestByIndentation(text: string, symbols: DocumentSymbol[]): DocumentSymbol[] {
  const lines = text.split('\n');
  const root: DocumentSymbol[] = [];
  const stack: Array<{ indent: number; symbol: DocumentSymbol }> = [];

  for (const symbol of symbols) {
    const line = lines[symbol.range.start.line] ?? '';
    const indent = line.length - line.trimStart().length;

    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    if (stack.length === 0) {
      root.push(symbol);
    } else {
      const parent = stack[stack.length - 1]!.symbol;
      (parent.children ??= []).push(symbol);
    }
    stack.push({ indent, symbol });
  }
  return prune(root);
}

/** Drops empty `children` arrays so serialized outlines stay compact. */
function prune(symbols: DocumentSymbol[]): DocumentSymbol[] {
  for (const symbol of symbols) {
    if (symbol.children && symbol.children.length === 0) delete symbol.children;
    else if (symbol.children) prune(symbol.children);
  }
  return symbols;
}

/** Byte offsets of every line start, so an index can become a line/character pair in O(log n). */
export function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

/** Converts a string offset to a zero-based position by binary search over the line starts. */
export function offsetToPosition(offset: number, lineStarts: number[]): { line: number; character: number } {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (lineStarts[middle]! <= offset) low = middle;
    else high = middle - 1;
  }
  return { line: low, character: offset - lineStarts[low]! };
}

/** Flattens a nested outline, for consumers that want a simple list. */
export function flattenSymbols(symbols: DocumentSymbol[], depth = 0): Array<DocumentSymbol & { depth: number }> {
  const flat: Array<DocumentSymbol & { depth: number }> = [];
  for (const symbol of symbols) {
    flat.push({ ...symbol, depth });
    if (symbol.children) flat.push(...flattenSymbols(symbol.children, depth + 1));
  }
  return flat;
}
