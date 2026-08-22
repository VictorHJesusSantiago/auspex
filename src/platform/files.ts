import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import type { FileNode } from '../core/model.ts';
import { detectLanguage } from '../languages/registry.ts';

/**
 * Filesystem access with the guards a tool like this needs.
 *
 * Everything here is defensive for the same reason: Auspex reads directories it does not own, on
 * machines it has never seen, while other programs are writing to them. A file being locked,
 * deleted mid-walk, or turning out to be a 4 GB log is normal, not exceptional, and none of those
 * may abort a capture.
 */

/** Reads a file, returning undefined instead of throwing. */
export async function readTextFile(path: string, maxBytes = 1024 * 1024): Promise<string | undefined> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return undefined;
    if (info.size > maxBytes) return undefined;
    const buffer = await readFile(path);
    if (isBinary(buffer)) return undefined;
    return stripBom(buffer.toString('utf8'));
  } catch {
    return undefined;
  }
}

/** Reads and parses JSON, tolerating the comments and trailing commas real editors write. */
export async function readJsonFile<T = unknown>(path: string, maxBytes = 8 * 1024 * 1024): Promise<T | undefined> {
  const text = await readTextFile(path, maxBytes);
  if (text === undefined) return undefined;
  return parseJsonc<T>(text);
}

/**
 * Parses JSON with comments and trailing commas.
 *
 * Not optional: VS Code's `settings.json`, `launch.json`, `tasks.json` and `keybindings.json` are
 * all JSONC by design and are full of comments in any real installation. `JSON.parse` fails on all
 * of them, which would mean reading none of the most useful files on the machine.
 */
export function parseJsonc<T = unknown>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    // Fall through to the tolerant path only when strict parsing fails, so well-formed JSON never
    // pays for the stripping pass.
  }
  try {
    return JSON.parse(stripJsonComments(text)) as T;
  } catch {
    return undefined;
  }
}

/**
 * Removes `//` and block comments and trailing commas, while respecting string literals.
 *
 * The string-awareness is the whole difficulty: a naive regex mangles any URL in the file, since
 * `https://example.com` contains `//`.
 */
export function stripJsonComments(text: string): string {
  let output = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    const next = text[i + 1];

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
        output += char;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    output += char;
  }

  // Trailing commas, now that comments are gone and only structure remains.
  return output.replace(/,(\s*[}\]])/g, '$1');
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Detects binary content by looking for a NUL byte in the first block.
 *
 * The same heuristic git uses, and for the same reason: it is cheap, it has essentially no false
 * positives on real text, and the alternative (full encoding detection) is a large problem to solve
 * for a question this tool only needs a rough answer to.
 */
export function isBinary(buffer: Buffer): boolean {
  const limit = Math.min(buffer.length, 8000);
  for (let i = 0; i < limit; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

/** Directory names never worth walking into. Skipping them is most of what makes a scan fast. */
export const IGNORED_DIRECTORIES = new Set([
  'node_modules', '.git', '.hg', '.svn', 'bin', 'obj', 'dist', 'build', 'out', 'target',
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.parcel-cache', '.cache', 'coverage',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', 'venv', '.venv', 'env',
  '.gradle', '.idea', '.vs', '.vscode-test', 'vendor', 'Pods', 'DerivedData',
  '.terraform', '.serverless', 'bower_components', 'jspm_packages', '.pnpm-store',
]);

export interface WalkOptions {
  maxDepth?: number;
  maxFiles?: number;
  /** Extra directory names to skip, on top of {@link IGNORED_DIRECTORIES}. */
  ignore?: Set<string>;
  /** Include dotfiles and dot-directories. Off by default; on for config-hunting callers. */
  includeHidden?: boolean;
}

export interface WalkResult {
  tree: FileNode;
  files: string[];
  /** Files per detected language, which characterizes a project faster than anything else. */
  languages: Record<string, number>;
  totalBytes: number;
  truncated: boolean;
}

/**
 * Walks a directory into a tree, with hard limits.
 *
 * Breadth-first with a global file budget, so a monorepo yields a broad shallow picture rather than
 * exhausting the budget inside the first deep subtree it happens to enter. That ordering is the
 * whole reason to prefer breadth-first here: when the answer must be truncated, a wide truncation
 * is far more informative about what a project *is* than a narrow deep one.
 */
export async function walkDirectory(root: string, options: WalkOptions = {}): Promise<WalkResult> {
  const maxDepth = options.maxDepth ?? 6;
  const maxFiles = options.maxFiles ?? 5000;
  const ignore = options.ignore ?? IGNORED_DIRECTORIES;
  const includeHidden = options.includeHidden ?? false;

  const rootNode: FileNode = { path: root, name: basename(root) || root, type: 'directory', children: [] };
  const files: string[] = [];
  const languages: Record<string, number> = {};
  let totalBytes = 0;
  let truncated = false;

  const queue: Array<{ node: FileNode; depth: number }> = [{ node: rootNode, depth: 0 }];

  while (queue.length > 0) {
    const { node, depth } = queue.shift()!;
    if (depth >= maxDepth) {
      node.truncated = true;
      truncated = true;
      continue;
    }

    let entries;
    try {
      entries = await readdir(node.path, { withFileTypes: true });
    } catch {
      // Permission denied, or the directory vanished between listing and descending. Either way the
      // rest of the walk is still worth having.
      node.truncated = true;
      continue;
    }

    // Directories first, then files, each alphabetically -- a stable order means two captures of an
    // unchanged project produce byte-identical trees, which makes them diffable.
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    for (const entry of entries) {
      if (!includeHidden && entry.name.startsWith('.')) continue;
      if (entry.isDirectory() && ignore.has(entry.name)) continue;

      const path = join(node.path, entry.name);

      if (entry.isDirectory()) {
        const child: FileNode = { path, name: entry.name, type: 'directory', children: [] };
        node.children!.push(child);
        queue.push({ node: child, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;

      if (files.length >= maxFiles) {
        node.truncated = true;
        truncated = true;
        break;
      }

      const language = detectLanguage(path);
      const child: FileNode = { path, name: entry.name, type: 'file', languageId: language.id };
      try {
        const info = await stat(path);
        child.size = info.size;
        totalBytes += info.size;
      } catch {
        // A file that disappeared mid-walk. Keep the name, drop the size.
      }
      node.children!.push(child);
      files.push(path);
      languages[language.id] = (languages[language.id] ?? 0) + 1;
    }
  }

  return { tree: rootNode, files, languages, totalBytes, truncated };
}

/** Finds the nearest ancestor directory (including `from`) containing any of `markers`. */
export function findUpwards(from: string, markers: string[]): string | undefined {
  let current = from;
  for (let i = 0; i < 64; i++) {
    for (const marker of markers) {
      if (existsSync(join(current, marker))) return current;
    }
    const parent = join(current, '..');
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

/** True when `child` is inside `parent` — used to attribute an open file to a workspace. */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(`..${sep}`);
}

/** Normalizes a path or `file://` URI to a plain absolute path with forward slashes. */
export function normalizePath(value: string): string {
  let path = value;
  if (path.startsWith('file://')) {
    try {
      path = decodeURIComponent(new URL(path).pathname);
      // A Windows URL yields `/C:/Users/...`; the leading slash is not part of the path.
      if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
    } catch {
      path = path.slice('file://'.length);
    }
  }
  return path.replace(/\\/g, '/').replace(/\/+$/, '') || path;
}

/** Counts lines without materializing them, for reporting file sizes usefully. */
export function countLines(text: string): number {
  if (!text) return 0;
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++;
  }
  return count;
}
