import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { VcsFileStatus, VcsState } from '../core/model.ts';
import { findUpwards } from '../platform/files.ts';

const run = promisify(execFile);

/**
 * Version-control state, read by shelling out to `git`.
 *
 * Shelling out rather than reimplementing the object database, and that is the right call rather
 * than a shortcut: git's own binary is present on every machine that has a git repository, it is
 * authoritative about states a reimplementation would get subtly wrong (submodules, worktrees,
 * sparse checkouts, a rebase in progress), and it is fast. The cost is a process spawn per query,
 * which is irrelevant at the once-per-capture rate this runs at.
 *
 * Every command is invoked through `execFile` with an argument array, never through a shell string.
 * That is deliberate: branch names and paths in a real repository contain spaces, quotes and
 * occasionally shell metacharacters, and building a command line out of them is how a path called
 * `$(rm -rf ~)` becomes a very bad afternoon.
 */

/** Runs a git command in a directory, returning stdout or undefined on any failure. */
async function git(cwd: string, args: string[], timeoutMs = 5000): Promise<string | undefined> {
  try {
    const { stdout } = await run('git', args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      // Stops git from ever opening an editor, a pager or a credential prompt, any of which would
      // hang a capture indefinitely while waiting for input nobody is there to give.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0' },
    });
    return stdout;
  } catch {
    return undefined;
  }
}

/** Finds the repository root containing `path`, or undefined. */
export async function findRepositoryRoot(path: string): Promise<string | undefined> {
  const output = await git(path, ['rev-parse', '--show-toplevel']);
  if (output) return output.trim();
  // A fallback that works even without git installed, so a snapshot at least knows a repo is there.
  return findUpwards(path, ['.git']);
}

export interface GitOptions {
  /** Include a unified diff of the working tree. Large, so off by default. */
  includeDiff?: boolean;
  /** How many recent commits to list. */
  commitCount?: number;
  /** Cap on the number of changed files reported. */
  maxFiles?: number;
}

/**
 * Reads everything worth knowing about a repository's current state.
 *
 * The fields are chosen by what changes what advice is safe to give. A detached HEAD, an in-progress
 * rebase, or a branch twelve commits behind its upstream all mean that "just commit and push" is
 * wrong, and an assistant that cannot see them will say it anyway.
 */
export async function readGitState(path: string, options: GitOptions = {}): Promise<VcsState> {
  const root = await findRepositoryRoot(path);
  if (!root) return { system: 'none' };

  const [branch, upstream, statusOutput, log, operation] = await Promise.all([
    git(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']),
    git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']),
    git(root, ['log', '-n', String(options.commitCount ?? 10), '--pretty=format:%H%x1f%an%x1f%aI%x1f%s']),
    detectOperation(root),
  ]);

  const state: VcsState = { system: 'git', root };

  const branchName = branch?.trim();
  if (branchName) {
    // `rev-parse --abbrev-ref HEAD` says literally "HEAD" when detached, which is exactly the state
    // worth flagging rather than reporting as a branch name.
    state.branch = branchName === 'HEAD' ? await describeDetachedHead(root) : branchName;
  }
  if (upstream?.trim()) {
    state.upstream = upstream.trim();
    const counts = await git(root, ['rev-list', '--left-right', '--count', `${state.upstream}...HEAD`]);
    const parts = counts?.trim().split(/\s+/);
    if (parts?.length === 2) {
      state.behind = Number(parts[0]) || 0;
      state.ahead = Number(parts[1]) || 0;
    }
  }
  if (operation) state.operationInProgress = operation;
  if (statusOutput !== undefined) {
    state.files = parsePorcelainStatus(statusOutput, options.maxFiles ?? 500);
  }
  if (log) {
    state.recentCommits = log.split('\n').filter(Boolean).map((line) => {
      const [hash, author, date, subject] = line.split('');
      return { hash: (hash ?? '').slice(0, 12), author: author ?? '', date: date ?? '', subject: subject ?? '' };
    });
  }
  if (options.includeDiff) {
    // Both halves: staged changes are invisible to a plain `git diff`, and a snapshot that showed
    // only unstaged work would misrepresent what the user is about to commit.
    const [unstaged, staged] = await Promise.all([
      git(root, ['diff', '--no-color', '--stat=200', '--patch']),
      git(root, ['diff', '--cached', '--no-color', '--stat=200', '--patch']),
    ]);
    const parts: string[] = [];
    if (staged?.trim()) parts.push(`# staged\n${staged}`);
    if (unstaged?.trim()) parts.push(`# unstaged\n${unstaged}`);
    if (parts.length) state.diff = parts.join('\n');
  }

  return state;
}

/** Turns a detached HEAD into something a human can act on: a tag, or an abbreviated hash. */
async function describeDetachedHead(root: string): Promise<string> {
  const described = await git(root, ['describe', '--tags', '--exact-match', 'HEAD']);
  if (described?.trim()) return `detached at ${described.trim()}`;
  const short = await git(root, ['rev-parse', '--short', 'HEAD']);
  return short?.trim() ? `detached at ${short.trim()}` : 'detached HEAD';
}

/**
 * Detects a multi-step operation in progress by the marker directories git leaves behind.
 *
 * These states matter more than almost anything else in this file: during a rebase or a merge with
 * conflicts, the working tree is in an intermediate state, and advice that ignores that is actively
 * harmful.
 */
async function detectOperation(root: string): Promise<string | undefined> {
  const gitDirOutput = await git(root, ['rev-parse', '--git-dir']);
  const gitDir = gitDirOutput?.trim()
    ? (gitDirOutput.trim().startsWith('/') || /^[A-Za-z]:/.test(gitDirOutput.trim())
      ? gitDirOutput.trim()
      : join(root, gitDirOutput.trim()))
    : join(root, '.git');

  const markers: Array<[string, string]> = [
    ['rebase-merge', 'rebase'],
    ['rebase-apply', 'rebase'],
    ['MERGE_HEAD', 'merge'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ['REVERT_HEAD', 'revert'],
    ['BISECT_LOG', 'bisect'],
  ];
  for (const [marker, name] of markers) {
    if (existsSync(join(gitDir, marker))) return name;
  }
  return undefined;
}

/**
 * Parses `git status --porcelain=v1 -z`.
 *
 * NUL-separated on purpose: the newline-separated form quotes and escapes any path containing a
 * space or a non-ASCII character, and unquoting it correctly is more work — and more failure modes
 * — than reading a length-delimited stream.
 */
export function parsePorcelainStatus(output: string, maxFiles: number): VcsState['files'] {
  const records = output.split('\0').filter(Boolean);
  const files: NonNullable<VcsState['files']> = [];

  for (let i = 0; i < records.length && files.length < maxFiles; i++) {
    const record = records[i]!;
    if (record.length < 3) continue;

    const indexStatus = record[0]!;
    const workTreeStatus = record[1]!;
    const path = record.slice(3);

    // A rename record is followed by its original path as a separate NUL-terminated entry, which
    // has to be consumed or it would be reported as a second, phantom file.
    if (indexStatus === 'R' || indexStatus === 'C') i++;

    if (indexStatus === '?' && workTreeStatus === '?') {
      files.push({ path, status: 'untracked', staged: false });
      continue;
    }
    if (indexStatus === '!' && workTreeStatus === '!') {
      files.push({ path, status: 'ignored', staged: false });
      continue;
    }
    // Any combination involving U, or both sides showing the same non-space letter, is a conflict.
    if (indexStatus === 'U' || workTreeStatus === 'U' ||
        (indexStatus === 'A' && workTreeStatus === 'A') ||
        (indexStatus === 'D' && workTreeStatus === 'D')) {
      files.push({ path, status: 'conflicted', staged: false });
      continue;
    }

    if (indexStatus !== ' ') {
      files.push({ path, status: statusFromCode(indexStatus), staged: true });
    }
    if (workTreeStatus !== ' ') {
      files.push({ path, status: statusFromCode(workTreeStatus), staged: false });
    }
  }
  return files;
}

function statusFromCode(code: string): VcsFileStatus {
  switch (code) {
    case 'M': return 'modified';
    case 'A': return 'added';
    case 'D': return 'deleted';
    case 'R': return 'renamed';
    case 'C': return 'added';
    case 'T': return 'modified';
    case '?': return 'untracked';
    case '!': return 'ignored';
    default: return 'modified';
  }
}

/** Whether git is available at all, cached so repeated captures do not re-probe. */
let gitAvailable: boolean | undefined;

export async function isGitAvailable(): Promise<boolean> {
  if (gitAvailable !== undefined) return gitAvailable;
  const output = await git(process.cwd(), ['--version'], 2000);
  gitAvailable = Boolean(output);
  return gitAvailable;
}
