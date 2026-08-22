import type { DocumentSymbol, SymbolKind } from '../core/model.ts';
import { parseJsonc } from '../platform/files.ts';
import { computeLineStarts, offsetToPosition } from './outline.ts';

/**
 * Real parsers for the data and configuration formats.
 *
 * These are genuinely parsed rather than pattern-matched, and the reason is a matter of what is
 * possible rather than of effort: JSON, YAML, TOML, INI, `.properties`, `.env` and CSV have small
 * enough grammars that parsing them properly is a few hundred lines, whereas parsing eighty
 * programming languages properly is not. Where exactness is affordable, guessing is inexcusable —
 * so this module does it right and `outline.ts` falls back to heuristics only where it must.
 *
 * **Stated scope for YAML and TOML.** The parsers here cover the structure Auspex actually needs
 * for an outline: keys, nesting, and sequence membership. They deliberately do not implement
 * anchors and aliases, multi-document streams, tagged types, flow-style collections spanning lines,
 * or TOML's full datetime grammar. That is a real limitation and it is the right one: a full YAML
 * implementation is famously large, and an outline does not need one. Anything the parser cannot
 * confidently interpret is skipped rather than guessed at.
 */

/** Parses a data or config document into an outline, or returns undefined if the format is unknown. */
export function parseDataDocument(languageId: string, text: string): DocumentSymbol[] | undefined {
  switch (languageId) {
    case 'json':
    case 'jsonc':
    case 'json5':
      return parseJsonOutline(text);
    case 'jsonl':
    case 'ndjson':
      return parseJsonLines(text);
    case 'yaml':
    case 'dockercompose':
    case 'ansible':
      return parseYamlOutline(text);
    case 'toml':
      return parseTomlOutline(text);
    case 'ini':
    case 'properties':
    case 'editorconfig':
      return parseIniOutline(text);
    case 'dotenv':
      return parseEnvOutline(text);
    case 'csv':
    case 'tsv':
      return parseDelimitedOutline(text, languageId === 'tsv' ? '\t' : ',');
    case 'dockerfile':
      return parseDockerfileOutline(text);
    case 'makefile':
      return parseMakefileOutline(text);
    case 'gitignore':
      return undefined; // A list of patterns has no structure worth outlining.
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------------------------

/**
 * Outlines a JSON document by parsing it and then locating each top-level key in the source.
 *
 * Parsing for structure and searching for position, rather than writing a position-tracking parser,
 * because the structure is what matters and the position only has to be good enough to jump to.
 */
function parseJsonOutline(text: string): DocumentSymbol[] {
  const value = parseJsonc(text);
  if (value === undefined || value === null || typeof value !== 'object') return [];

  const lineStarts = computeLineStarts(text);
  return describeJsonValue(value as Record<string, unknown>, text, lineStarts, 0, 3);
}

function describeJsonValue(
  value: Record<string, unknown> | unknown[],
  text: string,
  lineStarts: number[],
  depth: number,
  maxDepth: number,
): DocumentSymbol[] {
  if (depth >= maxDepth) return [];

  const entries = Array.isArray(value)
    ? value.map((item, index) => [String(index), item] as const)
    : Object.entries(value);

  const symbols: DocumentSymbol[] = [];
  let searchFrom = 0;

  for (const [key, item] of entries) {
    // Find this key's own quoted occurrence, moving forward so repeated key names in different
    // objects land on different lines rather than all on the first one.
    const needle = `"${key}"`;
    let index = text.indexOf(needle, searchFrom);
    if (index === -1) index = text.indexOf(needle);
    if (index >= 0) searchFrom = index + needle.length;

    const start = index >= 0 ? offsetToPosition(index, lineStarts) : { line: 0, character: 0 };
    const symbol: DocumentSymbol = {
      name: key,
      kind: jsonKind(item),
      detail: describeJsonType(item),
      range: { start, end: { line: start.line, character: start.character + needle.length } },
    };

    if (item && typeof item === 'object') {
      const children = describeJsonValue(item as Record<string, unknown>, text, lineStarts, depth + 1, maxDepth);
      if (children.length > 0) symbol.children = children;
    }
    symbols.push(symbol);
  }
  return symbols;
}

function jsonKind(value: unknown): SymbolKind {
  if (Array.isArray(value)) return 'field';
  if (value !== null && typeof value === 'object') return 'namespace';
  return 'key';
}

/** A short type description, which is most of what makes a data outline useful at a glance. */
function describeJsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array[${value.length}]`;
  switch (typeof value) {
    case 'object': return `object{${Object.keys(value as object).length}}`;
    case 'string': {
      const text = value as string;
      return text.length > 40 ? `string(${text.length})` : JSON.stringify(text);
    }
    default: return String(value);
  }
}

/** JSON Lines: one record per line, so the outline is a list of records with their key counts. */
function parseJsonLines(text: string): DocumentSymbol[] {
  const symbols: DocumentSymbol[] = [];
  const lines = text.split('\n');

  for (let i = 0; i < lines.length && symbols.length < 500; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    const value = parseJsonc(line);
    symbols.push({
      name: `record ${symbols.length}`,
      kind: value && typeof value === 'object' ? 'namespace' : 'key',
      detail: value === undefined ? 'unparseable' : describeJsonType(value),
      range: { start: { line: i, character: 0 }, end: { line: i, character: lines[i]!.length } },
    });
  }
  return symbols;
}

// ---------------------------------------------------------------------------------------------
// YAML
// ---------------------------------------------------------------------------------------------

/**
 * Outlines YAML by indentation.
 *
 * Indentation is YAML's scoping mechanism, so a line-oriented reader that tracks indent depth gets
 * the document's real structure — which is exactly what an outline is. Everything that needs a full
 * parser (anchors, tags, flow collections, multi-line scalars' contents) is skipped rather than
 * guessed; see this module's own scope note.
 */
function parseYamlOutline(text: string): DocumentSymbol[] {
  const lines = text.split('\n');
  const root: DocumentSymbol[] = [];
  const stack: Array<{ indent: number; symbol: DocumentSymbol }> = [];
  let blockScalarIndent: number | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    const indent = line.length - line.trimStart().length;

    // Inside a `|` or `>` block, every line is content rather than structure.
    if (blockScalarIndent !== undefined) {
      if (trimmed === '' || indent > blockScalarIndent) continue;
      blockScalarIndent = undefined;
    }
    if (!trimmed || trimmed.startsWith('#')) continue;

    // A document separator resets the whole hierarchy.
    if (trimmed === '---' || trimmed === '...') {
      stack.length = 0;
      continue;
    }

    let name: string;
    let kind: SymbolKind;
    let detail: string | undefined;

    const sequenceMatch = /^-\s*(.*)$/.exec(trimmed);
    if (sequenceMatch) {
      const rest = sequenceMatch[1] ?? '';
      const nested = /^([^:#]+):\s*(.*)$/.exec(rest);
      if (nested) {
        name = nested[1]!.trim();
        detail = nested[2]?.trim() || undefined;
        kind = detail ? 'key' : 'namespace';
      } else {
        name = rest || '-';
        kind = 'field';
      }
    } else {
      const keyMatch = /^([^:#]+):\s*(.*)$/.exec(trimmed);
      if (!keyMatch) continue;
      name = keyMatch[1]!.trim().replace(/^["']|["']$/g, '');
      detail = keyMatch[2]?.trim() || undefined;
      kind = detail ? 'key' : 'namespace';

      if (detail === '|' || detail === '>' || detail === '|-' || detail === '>-') {
        blockScalarIndent = indent;
        detail = 'block scalar';
      }
    }

    const symbol: DocumentSymbol = {
      name,
      kind,
      range: { start: { line: i, character: indent }, end: { line: i, character: line.length } },
    };
    if (detail && detail.length <= 80) symbol.detail = detail;

    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    if (stack.length === 0) root.push(symbol);
    else {
      const parent = stack[stack.length - 1]!.symbol;
      (parent.children ??= []).push(symbol);
      if (parent.kind === 'key') parent.kind = 'namespace';
    }
    stack.push({ indent, symbol });
  }
  return root;
}

// ---------------------------------------------------------------------------------------------
// TOML
// ---------------------------------------------------------------------------------------------

/** Outlines TOML: `[table]` and `[[array-of-table]]` headers, with the keys inside each. */
function parseTomlOutline(text: string): DocumentSymbol[] {
  const lines = text.split('\n');
  const root: DocumentSymbol[] = [];
  let current: DocumentSymbol | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const tableMatch = /^\[\[?([^\]]+)\]\]?$/.exec(trimmed);
    if (tableMatch) {
      current = {
        name: tableMatch[1]!.trim(),
        kind: trimmed.startsWith('[[') ? 'field' : 'namespace',
        detail: trimmed.startsWith('[[') ? 'array of tables' : undefined,
        range: { start: { line: i, character: 0 }, end: { line: i, character: line.length } },
        children: [],
      };
      root.push(current);
      continue;
    }

    const keyMatch = /^([A-Za-z0-9_."'-]+)\s*=\s*(.*)$/.exec(trimmed);
    if (!keyMatch) continue;

    const symbol: DocumentSymbol = {
      name: keyMatch[1]!.replace(/^["']|["']$/g, ''),
      kind: 'key',
      detail: keyMatch[2] && keyMatch[2].length <= 60 ? keyMatch[2] : undefined,
      range: { start: { line: i, character: 0 }, end: { line: i, character: line.length } },
    };

    if (current) (current.children ??= []).push(symbol);
    else root.push(symbol);
  }

  for (const table of root) {
    if (table.children?.length === 0) delete table.children;
  }
  return root;
}

// ---------------------------------------------------------------------------------------------
// INI, properties, .env
// ---------------------------------------------------------------------------------------------

/** Outlines INI-family files: `[section]` headers with `key = value` lines beneath. */
function parseIniOutline(text: string): DocumentSymbol[] {
  const lines = text.split('\n');
  const root: DocumentSymbol[] = [];
  let current: DocumentSymbol | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';') || trimmed.startsWith('!')) continue;

    const sectionMatch = /^\[([^\]]*)\]$/.exec(trimmed);
    if (sectionMatch) {
      current = {
        name: sectionMatch[1] ?? '',
        kind: 'section',
        range: { start: { line: i, character: 0 }, end: { line: i, character: line.length } },
        children: [],
      };
      root.push(current);
      continue;
    }

    // `.properties` accepts `:` and whitespace as separators as well as `=`.
    const keyMatch = /^([^=:\s]+)\s*[=:]?\s*(.*)$/.exec(trimmed);
    if (!keyMatch) continue;

    const symbol: DocumentSymbol = {
      name: keyMatch[1]!,
      kind: 'key',
      detail: keyMatch[2] && keyMatch[2].length <= 60 ? keyMatch[2] : undefined,
      range: { start: { line: i, character: 0 }, end: { line: i, character: line.length } },
    };
    if (current) (current.children ??= []).push(symbol);
    else root.push(symbol);
  }

  for (const section of root) {
    if (section.children?.length === 0) delete section.children;
  }
  return root;
}

/**
 * Outlines a `.env` file to its variable **names only**.
 *
 * The values are deliberately never included, whatever they look like. A `.env` file exists to hold
 * credentials, so the redactor skips the file entirely — but the names are genuinely useful context
 * ("this project expects DATABASE_URL and STRIPE_KEY") and carry no secret, so they are kept and the
 * values are not. This is the one place in the codebase where an outline is intentionally lossy.
 */
function parseEnvOutline(text: string): DocumentSymbol[] {
  const lines = text.split('\n');
  const symbols: DocumentSymbol[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = /^(?:export\s+)?([A-Za-z_][\w.]*)\s*=/.exec(trimmed);
    if (!match) continue;

    symbols.push({
      name: match[1]!,
      kind: 'variable',
      detail: 'value withheld',
      range: { start: { line: i, character: 0 }, end: { line: i, character: lines[i]!.length } },
    });
  }
  return symbols;
}

// ---------------------------------------------------------------------------------------------
// Delimited data
// ---------------------------------------------------------------------------------------------

/**
 * Outlines CSV or TSV as its columns, with an inferred type per column.
 *
 * Columns rather than rows, because that is the structure: a million-row file has the same shape as
 * a ten-row one, and the shape is what an outline should convey. Types are inferred from a sample
 * rather than the whole file, since the whole point is to be cheap.
 */
function parseDelimitedOutline(text: string, delimiter: string): DocumentSymbol[] {
  const rows = parseDelimitedRows(text, delimiter, 100);
  const header = rows[0];
  if (!header) return [];

  const dataRows = rows.slice(1);
  return header.map((name, column) => {
    const samples = dataRows.map((row) => row[column] ?? '').filter((value) => value !== '');
    return {
      name: name || `column ${column}`,
      kind: 'field' as SymbolKind,
      detail: `${inferColumnType(samples)} · ${dataRows.length}+ rows sampled`,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    };
  });
}

/** A delimited-value reader that honours quoting, doubled quotes and embedded newlines. */
export function parseDelimitedRows(text: string, delimiter: string, maxRows = Infinity): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length && rows.length < maxRows; i++) {
    const char = text[i]!;
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && field === '') inQuotes = true;
    else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Infers a column's type from sampled values, narrowest first. */
function inferColumnType(samples: string[]): string {
  if (samples.length === 0) return 'empty';
  const all = (test: (value: string) => boolean) => samples.every(test);

  if (all((v) => /^-?\d+$/.test(v))) return 'integer';
  if (all((v) => /^-?\d*\.?\d+(?:[eE][-+]?\d+)?$/.test(v))) return 'number';
  if (all((v) => /^(true|false|yes|no|0|1)$/i.test(v))) return 'boolean';
  if (all((v) => /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?/.test(v))) return 'date';
  if (all((v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v))) return 'email';
  if (all((v) => /^https?:\/\//.test(v))) return 'url';

  const distinct = new Set(samples).size;
  // A small distinct count over many samples is a categorical column, which is worth saying.
  if (distinct <= 12 && samples.length >= distinct * 3) return `enum(${distinct})`;
  return 'string';
}

// ---------------------------------------------------------------------------------------------
// Build files
// ---------------------------------------------------------------------------------------------

/** Outlines a Dockerfile as its build stages and the significant instructions in each. */
function parseDockerfileOutline(text: string): DocumentSymbol[] {
  const lines = text.split('\n');
  const root: DocumentSymbol[] = [];
  let stage: DocumentSymbol | undefined;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const instruction = /^([A-Za-z]+)\s+(.*)$/.exec(trimmed);
    if (!instruction) continue;

    const keyword = instruction[1]!.toUpperCase();
    const rest = instruction[2]!;

    if (keyword === 'FROM') {
      const named = /\bAS\s+([\w.-]+)/i.exec(rest);
      stage = {
        name: named?.[1] ?? rest.split(/\s+/)[0] ?? 'stage',
        kind: 'namespace',
        detail: `FROM ${rest}`,
        range: { start: { line: i, character: 0 }, end: { line: i, character: lines[i]!.length } },
        children: [],
      };
      root.push(stage);
      continue;
    }

    // Only the instructions that change what the image *is*; RUN and COPY lines are too numerous
    // and too detailed to belong in an outline.
    if (!['WORKDIR', 'ENTRYPOINT', 'CMD', 'EXPOSE', 'VOLUME', 'USER', 'ENV', 'ARG', 'HEALTHCHECK'].includes(keyword)) {
      continue;
    }

    const symbol: DocumentSymbol = {
      name: keyword,
      kind: 'key',
      detail: rest.length <= 80 ? rest : `${rest.slice(0, 77)}...`,
      range: { start: { line: i, character: 0 }, end: { line: i, character: lines[i]!.length } },
    };
    if (stage) (stage.children ??= []).push(symbol);
    else root.push(symbol);
  }

  for (const item of root) {
    if (item.children?.length === 0) delete item.children;
  }
  return root;
}

/** Outlines a Makefile as its targets, with their prerequisites as the detail. */
function parseMakefileOutline(text: string): DocumentSymbol[] {
  const lines = text.split('\n');
  const symbols: DocumentSymbol[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('\t') || !line.trim() || line.trimStart().startsWith('#')) continue;

    const match = /^([A-Za-z0-9_.$(){}/%-]+)\s*:(?!=)\s*(.*)$/.exec(line);
    if (!match) continue;

    symbols.push({
      name: match[1]!,
      kind: 'function',
      detail: match[2]?.trim() || undefined,
      range: { start: { line: i, character: 0 }, end: { line: i, character: line.length } },
    });
  }
  return symbols;
}
