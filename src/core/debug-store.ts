import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DebugSessionRecord } from './debug-model.ts';
import type { Redactor } from './redact.ts';

/**
 * Where a deep debug session is published so other processes can read it.
 *
 * The recorder necessarily lives inside the proxy process — it is the only process sitting on the
 * debug adapter's wire — while `auspex serve`, the MCP server and the `debug` command are separate
 * processes started at different times. Something has to bridge them.
 *
 * A file in the temp directory does that with no protocol, no port, no daemon and no ordering
 * requirement: the proxy writes, anything else reads whichever session file is newest. It survives
 * the reader starting late, which an in-memory channel would not, and it costs nothing when nobody
 * is looking.
 *
 * The obvious alternative — pushing the record to a running server, as the proxy already does for
 * diagnostics — was rejected because it only works when a server happens to be running *and* was
 * started first, and because a full session record is far too large to send every two seconds.
 *
 * **The record is redacted before it is written**, not on read. A debug session's variables are
 * about the most secret-dense thing in a developer's machine — decrypted tokens, connection
 * strings, request bodies, the contents of the very environment variables the redactor exists to
 * hide — and writing them unredacted to a world-readable temp directory to redact them later would
 * be indefensible.
 */

const PREFIX = 'auspex-debug-';

export function sessionDirectory(): string {
  return join(tmpdir(), 'auspex');
}

function sessionPath(sessionId: string): string {
  // The id reaches this from a session name, so it is constrained rather than trusted: anything
  // that is not a plain word becomes a dash, which makes a traversal impossible by construction.
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64) || 'session';
  return join(sessionDirectory(), `${PREFIX}${safe}.json`);
}

/** Publishes a session record, redacting it first. */
export async function publishSession(
  record: DebugSessionRecord,
  redactor?: Redactor,
): Promise<string> {
  await mkdir(sessionDirectory(), { recursive: true });

  // `redactValue` rather than a pass over the serialized text, because it applies the key-name
  // policy as well as the value patterns -- and in a debug record the key name is often the only
  // evidence there is. A variable literally named `password` holding `hunter2` matches no value
  // pattern at all; its name is the whole tell.
  const payload = redactor ? redactor.redactValue(record) : record;

  const path = sessionPath(record.sessionId);
  await writeFile(path, JSON.stringify(payload), 'utf8');
  return path;
}

/** Every published session, newest first. */
export async function listSessions(): Promise<Array<{ path: string; modified: number }>> {
  let names: string[];
  try {
    names = await readdir(sessionDirectory());
  } catch {
    return [];              // Nothing has ever been published. Not an error.
  }

  const found: Array<{ path: string; modified: number }> = [];
  for (const name of names) {
    if (!name.startsWith(PREFIX) || !name.endsWith('.json')) continue;
    const path = join(sessionDirectory(), name);
    try {
      found.push({ path, modified: (await stat(path)).mtimeMs });
    } catch {
      // Removed between the listing and the stat; a stale entry is not worth failing over.
    }
  }
  return found.sort((a, b) => b.modified - a.modified);
}

/** Reads one published session, or the newest when no id is given. */
export async function readSession(sessionId?: string): Promise<DebugSessionRecord | undefined> {
  const path = sessionId ? sessionPath(sessionId) : (await listSessions())[0]?.path;
  if (!path) return undefined;

  try {
    return JSON.parse(await readFile(path, 'utf8')) as DebugSessionRecord;
  } catch {
    // A half-written file caught mid-publish, or one from an incompatible version. Reporting "no
    // session" is right: a partial record is worse than none.
    return undefined;
  }
}

/** Removes published sessions that have terminated or gone stale. */
export async function pruneSessions(maxAgeMs = 24 * 60 * 60 * 1000): Promise<number> {
  const now = Date.now();
  let removed = 0;

  for (const { path, modified } of await listSessions()) {
    if (now - modified < maxAgeMs) continue;
    try {
      await unlink(path);
      removed++;
    } catch {
      // Held open by another process, or already gone.
    }
  }
  return removed;
}
