import type { DebugStackFrame, DebugStop, DebugThread } from '../core/debug-model.ts';
import { isUserCode, type KnownAdapter } from './registry.ts';

/**
 * Making sense of a program with many threads.
 *
 * ## Why an IDE struggles here and this does not have to
 *
 * An IDE presents threads as a list you scroll. That works at five threads and collapses at five
 * hundred: a Go server under load has thousands of goroutines, a JVM application server has
 * hundreds, and a thread pool has forty threads whose stacks are *identical*. Scrolling that list
 * to find the one thread doing something interesting is a task nobody should be doing by hand,
 * and it is the reason multi-threaded debugging has a reputation for being miserable.
 *
 * The insight this module runs on is that **threads in a large program fall into a small number of
 * groups**, and the groups are obvious from the stacks: forty workers parked in the same
 * `epoll_wait`, twelve threads blocked on the same lock, one thread actually running application
 * code. Grouping by stack shape turns five hundred rows into six, and the six are individually
 * meaningful.
 *
 * ## What it finds
 *
 * - **Groups** of threads sharing a stack shape, so a pool reads as a pool.
 * - **What each group is doing** — parked, waiting on I/O, blocked on a lock, running user code —
 *   inferred from the frame names, which are remarkably consistent across runtimes.
 * - **Threads worth looking at**: the ones in the user's own code, which are almost always what
 *   the question is about and are almost always a handful out of hundreds.
 * - **Possible deadlocks**: a cycle of threads each blocked while holding something another wants.
 *   Detected structurally from what is knowable, and reported as *possible* — see below.
 *
 * ## The honest limit on deadlock detection
 *
 * DAP does not carry lock ownership. No adapter reports "thread 7 holds mutex A"; that information
 * exists inside the runtime and never reaches the protocol. So this cannot prove a deadlock, and
 * does not claim to. What it can do is find the *shape* of one — several threads simultaneously
 * blocked in lock-acquisition frames, with none running — which is the signature of a deadlock and
 * is also, occasionally, the signature of a program legitimately waiting on a lock held by
 * something slow. Reporting that shape as "possible" with the evidence attached is useful.
 * Reporting it as "deadlock detected" would be a confident guess about the thing people are most
 * likely to act on drastically.
 */

export type ThreadActivity =
  | 'running-user-code'
  | 'running-runtime'
  | 'waiting-io'
  | 'waiting-lock'
  | 'waiting-condition'
  | 'sleeping'
  | 'parked'
  | 'unknown';

export interface ThreadGroup {
  /** A name for the group, taken from the deepest shared frame. */
  name: string;
  activity: ThreadActivity;
  threads: Array<{ id: number; name: string }>;
  /**
   * How many threads are really in this group.
   *
   * Distinct from `threads.length`, which is capped for display. Conflating the two made the
   * activity distribution under-report a large pool by however much the cap removed — a statistic
   * quietly corrupted by a presentation decision, which is the worst kind.
   */
  totalThreads: number;
  /** The stack the group shares, from the top down. */
  sharedStack: string[];
  /** How many frames are common to every thread in the group. */
  sharedDepth: number;
  /** True when a thread in this group is the one that stopped. */
  containsStopped: boolean;
  /** True when any thread in this group is in the project's own code. */
  containsUserCode: boolean;
}

export interface ConcurrencyReport {
  threadCount: number;
  groups: ThreadGroup[];
  /** Threads running the user's own code — usually the handful that matter. */
  interesting: Array<{ id: number; name: string; frame: string; file?: string; line?: number }>;
  /** Distribution across activities. */
  activity: Record<string, number>;
  /** Structural signs of a deadlock, never a claim that there is one. */
  contention?: {
    blockedThreads: Array<{ id: number; name: string; frame: string }>;
    runningThreads: number;
    /** Why this is worth looking at. */
    reason: string;
    /** What would settle it, since the protocol cannot. */
    howToConfirm: string;
  };
  /** Anything about the capture that limits this analysis. */
  caveats: string[];
}

/**
 * Frame-name fragments that identify what a thread is doing.
 *
 * Ordered by specificity: the first match wins, so lock waits beat generic waits, and I/O beats
 * "the word wait appears somewhere". Spanning runtimes on purpose — the same handful of primitives
 * underlie every threading implementation, and their names barely differ.
 */
const ACTIVITY_PATTERNS: Array<{ activity: ThreadActivity; patterns: RegExp[]; label: string }> = [
  {
    activity: 'waiting-lock',
    label: 'blocked acquiring a lock',
    patterns: [
      /\b(?:lock|mutex|monitor|semaphore|critical_?section)\b.*\b(?:acquire|enter|wait|lock)\b/i,
      /\b(?:pthread_mutex_lock|EnterCriticalSection|WaitForSingleObject|futex_wait)\b/i,
      /\bMonitor\.(?:Enter|Wait)\b/, /\bsync\.\(\*Mutex\)\.Lock\b/, /\bRawMutex::lock\b/,
      /\bacquireLock\b/, /\b_lock_acquire\b|\bacquire_lock\b/i,
      // `LockSupport.park` on its own is NOT a lock wait, and treating it as one is a mistake
      // with consequences: it is the JVM's universal parking primitive, used just as much by an
      // idle thread-pool worker as by a genuinely blocked lock. Every idle Java application
      // server would have reported forty threads "blocked on locks" with none running -- which is
      // the exact signature this module reports as possible contention. Requiring the
      // synchronizer frame is what actually separates a lock wait from a nap.
      /\bLockSupport\.park\b[\s\S]*\b(?:AbstractQueuedSynchronizer|ReentrantLock|ReentrantReadWriteLock|Semaphore|CountDownLatch)\b/,
      /\bstd::mutex::lock\b|\bunique_lock\b/,
    ],
  },
  {
    activity: 'waiting-condition',
    label: 'waiting on a condition variable',
    patterns: [
      /\b(?:cond|condition)_?(?:var)?\w*\.?\b(?:wait|await)\b/i,
      /\bpthread_cond_(?:timed)?wait\b/, /\bcondition_variable::wait\b/,
      /\bObject\.wait\b/, /\bsync\.runtime_notifyListWait\b/, /\bCondvar::wait\b/,
      /\bthreading\.Condition\.wait\b|\bEvent\.wait\b/,
    ],
  },
  {
    activity: 'waiting-io',
    label: 'waiting on I/O',
    patterns: [
      /\b(?:epoll_wait|kevent|select|poll|GetQueuedCompletionStatus|WSARecv|io_uring)\b/i,
      /\b(?:read|recv|accept|connect|write|send)\b(?:_?(?:from|to|msg))?$/i,
      /\bnetpoll(?:block)?\b/, /\bSocketRead\b|\bSocketAccept\b/,
      /\bselectors?\.select\b/, /\bEpollSelector\b/,
    ],
  },
  {
    activity: 'sleeping',
    label: 'sleeping',
    patterns: [/\b(?:sleep|nanosleep|Sleep|delay|usleep|time\.Sleep|Thread\.sleep)\b/i],
  },
  {
    activity: 'parked',
    label: 'parked, idle in a pool',
    patterns: [
      /\b(?:park|idle|WaitForWork|getTask|take|poll)\b/i,
      /\bThreadPoolExecutor\.getTask\b/, /\bWorkerThread\b/, /\bgopark\b/,
      /\bkqueue\b|\bWaitOnAddress\b/,
    ],
  },
];

export interface ConcurrencyOptions {
  adapter?: KnownAdapter;
  /** How many frames to compare when grouping. */
  compareDepth?: number;
  /** Groups larger than this are summarized rather than listed thread by thread. */
  maxThreadsPerGroup?: number;
}

/** Analyses the threads of one stop. */
export function analyseConcurrency(stop: DebugStop, options: ConcurrencyOptions = {}): ConcurrencyReport {
  const compareDepth = options.compareDepth ?? 4;
  const caveats: string[] = [];

  const threads = stop.threads.length > 0
    ? stop.threads
    : Object.keys(stop.stacks).map((id) => ({ id: Number(id), name: `thread ${id}` } as DebugThread));

  // Only threads whose stack was actually captured can be grouped. Saying how many were left out
  // matters: a report covering five of six hundred threads that did not say so would be read as
  // covering the program.
  const withStacks = threads.filter((thread) => (stop.stacks[thread.id]?.length ?? 0) > 0);
  if (withStacks.length < threads.length) {
    caveats.push(
      `${threads.length - withStacks.length} of ${threads.length} thread(s) had no captured stack; ` +
      'the capture walks the stopped thread and a bounded number of others');
  }

  // -- Group by the shape of the top frames.
  const buckets = new Map<string, DebugThread[]>();

  for (const thread of withStacks) {
    const frames = stop.stacks[thread.id] ?? [];
    const key = frames.slice(0, compareDepth).map((frame) => frame.name).join(' ← ');
    buckets.set(key, [...(buckets.get(key) ?? []), thread]);
  }

  const groups: ThreadGroup[] = [];

  for (const [key, members] of buckets) {
    const frames = stop.stacks[members[0]!.id] ?? [];
    const activity = classifyStack(frames, options.adapter);

    groups.push({
      name: describeGroup(frames, activity),
      activity,
      threads: members.slice(0, options.maxThreadsPerGroup ?? 20)
        .map((thread) => ({ id: thread.id, name: thread.name })),
      totalThreads: members.length,
      sharedStack: key.split(' ← '),
      sharedDepth: sharedPrefix(members.map((thread) => stop.stacks[thread.id] ?? [])),
      containsStopped: members.some((thread) => thread.id === stop.threadId || thread.stopped),
      containsUserCode: frames.some((frame) => isUserCode(frame.file, options.adapter)),
    });
  }

  // The stopped thread first, then the ones in user code, then by size. That is the order of
  // interest, not the order of thread id -- which is the order an IDE shows and which is
  // meaningless.
  groups.sort((a, b) => {
    if (a.containsStopped !== b.containsStopped) return a.containsStopped ? -1 : 1;
    if (a.containsUserCode !== b.containsUserCode) return a.containsUserCode ? -1 : 1;
    return b.totalThreads - a.totalThreads;
  });

  // -- Threads worth a second look.
  const interesting: ConcurrencyReport['interesting'] = [];

  for (const thread of withStacks) {
    const frames = stop.stacks[thread.id] ?? [];
    const userFrame = frames.find((frame) => isUserCode(frame.file, options.adapter));
    if (!userFrame) continue;

    interesting.push({
      id: thread.id,
      name: thread.name,
      frame: userFrame.name,
      file: userFrame.file,
      line: userFrame.line,
    });
  }

  // -- Activity distribution.
  const activity: Record<string, number> = {};
  for (const group of groups) {
    activity[group.activity] = (activity[group.activity] ?? 0) + group.totalThreads;
  }

  // -- Contention.
  const blocked = groups.filter((group) =>
    group.activity === 'waiting-lock' || group.activity === 'waiting-condition');
  const running = groups.filter((group) =>
    group.activity === 'running-user-code' || group.activity === 'running-runtime');

  const blockedThreads = blocked.flatMap((group) =>
    group.threads.map((thread) => ({ id: thread.id, name: thread.name, frame: group.sharedStack[0] ?? '' })));
  const blockedCount = blocked.reduce((sum, group) => sum + group.totalThreads, 0);

  const contention = blockedCount >= 2 && running.length === 0
    ? {
      blockedThreads,
      runningThreads: 0,
      reason:
        `${blockedCount} thread(s) are blocked acquiring locks or waiting on conditions, ` +
        'and none are running. That is the shape of a deadlock — and also the shape of a program ' +
        'legitimately waiting on something slow.',
      // The protocol genuinely cannot settle this, so the next step is named rather than implied.
      howToConfirm:
        'The Debug Adapter Protocol does not carry lock ownership, so this cannot be confirmed from ' +
        'the capture. Confirm it with a runtime-specific dump: `jstack` for the JVM, ' +
        '`SIGQUIT` for Go, `py-spy dump` for Python, or `~*k` in WinDbg.',
    }
    : undefined;

  return {
    threadCount: threads.length,
    groups,
    interesting,
    activity,
    contention,
    caveats,
  };
}

/** Reads a stack top-down and returns the first activity that matches. */
export function classifyStack(frames: DebugStackFrame[], adapter?: KnownAdapter): ThreadActivity {
  // Only the top few frames: a thread's *current* activity is at the top, and a `select` twenty
  // frames down is how it got here rather than what it is doing.
  const top = frames.slice(0, 6).map((frame) => frame.name).join(' ');

  for (const { activity, patterns } of ACTIVITY_PATTERNS) {
    if (patterns.some((pattern) => pattern.test(top))) return activity;
  }

  if (frames.some((frame) => isUserCode(frame.file, adapter))) return 'running-user-code';
  if (frames.length > 0) return 'running-runtime';
  return 'unknown';
}

/** A readable name for a group: the deepest frame that is not runtime plumbing. */
function describeGroup(frames: DebugStackFrame[], activity: ThreadActivity): string {
  const label = ACTIVITY_PATTERNS.find((entry) => entry.activity === activity)?.label;
  const anchor = frames.find((frame) => isUserCode(frame.file)) ?? frames[0];

  if (label) return `${label} (${anchor?.name ?? 'unknown'})`;
  return anchor?.name ?? 'unknown';
}

/** How many leading frames every stack in a set has in common. */
function sharedPrefix(stacks: DebugStackFrame[][]): number {
  if (stacks.length === 0) return 0;
  const shortest = Math.min(...stacks.map((stack) => stack.length));

  for (let depth = 0; depth < shortest; depth++) {
    const name = stacks[0]![depth]!.name;
    if (!stacks.every((stack) => stack[depth]!.name === name)) return depth;
  }
  return shortest;
}

/** Renders the report for a terminal or a briefing. */
export function renderConcurrency(report: ConcurrencyReport, indent = ''): string[] {
  const lines: string[] = [];

  lines.push(`${indent}${report.threadCount} thread(s) in ${report.groups.length} group(s)`);

  const distribution = Object.entries(report.activity)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${count} ${name.replace(/-/g, ' ')}`);
  if (distribution.length > 0) lines.push(`${indent}  ${distribution.join(' · ')}`);

  lines.push('');

  for (const group of report.groups) {
    const marks = [
      group.containsStopped ? '◆ stopped' : '',
      group.containsUserCode ? '► user code' : '',
    ].filter(Boolean).join(' ');

    lines.push(`${indent}  ${group.totalThreads}× ${group.name}${marks ? `   ${marks}` : ''}`);
    lines.push(`${indent}     ${group.sharedStack.slice(0, 3).join(' ← ')}`);

    if (group.totalThreads <= 6) {
      lines.push(`${indent}     ${group.threads.map((thread) => `${thread.name}#${thread.id}`).join(', ')}`);
    }
  }

  if (report.interesting.length > 0) {
    lines.push('');
    lines.push(`${indent}  Threads in this project's own code:`);
    for (const thread of report.interesting.slice(0, 10)) {
      lines.push(`${indent}    ${thread.name}#${thread.id} — ${thread.frame} (${thread.file ?? '?'}:${thread.line ?? '?'})`);
    }
  }

  if (report.contention) {
    lines.push('');
    lines.push(`${indent}  ⚠ ${report.contention.reason}`);
    lines.push(`${indent}    ${report.contention.howToConfirm}`);
  }

  for (const caveat of report.caveats) {
    lines.push('');
    lines.push(`${indent}  note: ${caveat}`);
  }
  return lines;
}
