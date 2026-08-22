import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Redactor, REDACTION_RULES } from '../src/core/redact.ts';
import { fitToBudget, estimateTokens, rankDocuments, rankDiagnostics } from '../src/core/budget.ts';
import { runAdapter, NO_CAPABILITIES, type Adapter } from '../src/core/adapter.ts';
import { capture } from '../src/core/snapshot.ts';
import type { Snapshot, Diagnostic, OpenDocument } from '../src/core/model.ts';

/** A snapshot fixture, so budget and merge tests do not depend on the machine they run on. */
function fixture(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    capturedAt: '2026-01-01T00:00:00.000Z',
    schemaVersion: '1.0',
    host: { platform: 'linux', arch: 'x64', hostname: 'test', cwd: '/w' },
    editors: [],
    workspaces: [],
    documents: [],
    diagnostics: [],
    provenance: [],
    warnings: [],
    ...overrides,
  };
}

describe('Redactor', () => {
  test('replaces provider key shapes and names the rule that fired', () => {
    const redactor = new Redactor();
    const output = redactor.redact('key=AKIAIOSFODNN7EXAMPLE');

    assert.match(output, /\[redacted:aws-access-key-id\]/);
    assert.equal(redactor.report()?.byRule['aws-access-key-id'], 1);
  });

  test('keeps the surrounding structure so the consumer still learns what was configured', () => {
    // The point of group-scoped replacement: `api_key = "..."` should still say that an api key is
    // configured there, just not what it is.
    const output = new Redactor().redact('DATABASE_URL=postgres://admin:hunter2@db/prod');
    assert.match(output, /postgres:\/\/admin:\[redacted:url-credentials\]@db\/prod/);
    assert.doesNotMatch(output, /hunter2/);
  });

  test('never redacts something already redacted', () => {
    // Without this guard, a specific rule fires and then a general one overwrites its name with a
    // vaguer one -- losing the most useful part of the report.
    const redactor = new Redactor();
    redactor.redact('api_key = "sk-live-abcdefghij1234567890"');
    const report = redactor.report()!;

    assert.equal(report.count, 1);
    assert.equal(report.byRule['openai-key'], 1);
    assert.equal(report.byRule['secret-assignment'], undefined);
  });

  test('redacts a private key block whole', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\nMIIdef\n-----END RSA PRIVATE KEY-----';
    const output = new Redactor().redact(`before\n${pem}\nafter`);

    assert.equal(output, 'before\n[redacted:private-key]\nafter');
  });

  test('treats a key called password as secret whatever its value looks like', () => {
    const redactor = new Redactor();
    const output = redactor.redactValue({ password: 'correct horse battery staple', port: 5432 });

    assert.equal(output.password, '[redacted:secret-key-name]');
    assert.equal(output.port, 5432, 'non-secret keys must survive untouched');
  });

  test('identifies files whose entire purpose is holding credentials', () => {
    const redactor = new Redactor();
    for (const path of ['/p/.env', '/p/.env.production', '/home/u/.ssh/id_rsa', '/p/certs/server.pem']) {
      assert.equal(redactor.isSensitiveFile(path), true, path);
    }
    for (const path of ['/p/src/env.ts', '/p/README.md', '/p/environment.json']) {
      assert.equal(redactor.isSensitiveFile(path), false, path);
    }
  });

  test('does nothing at all when disabled', () => {
    const output = new Redactor(false).redact('token=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    assert.match(output, /ghp_a+/);
  });

  test('every rule is a global regex, or replacement would stop after the first match', () => {
    for (const rule of REDACTION_RULES) {
      assert.ok(rule.pattern.flags.includes('g'), `${rule.name} must be global`);
    }
  });

  test('walks nested structures', () => {
    const output = new Redactor().redactValue({
      services: [{ name: 'db', config: { apiKey: 'AIza0123456789012345678901234567890123' } }],
    });
    assert.match(JSON.stringify(output), /redacted/);
  });
});

describe('budget', () => {
  test('returns an untouched snapshot when it already fits', () => {
    const result = fitToBudget(fixture(), { maxTokens: 100000 });
    assert.deepEqual(result.dropped, []);
  });

  test('drops the diff before anything else, because it is the largest and least essential', () => {
    const snapshot = fixture({
      workspaces: [{ root: '/w', name: 'w', vcs: { system: 'git', diff: 'x'.repeat(80000) } }],
    });
    const result = fitToBudget(snapshot, { maxTokens: 500 });

    assert.equal(result.snapshot.workspaces[0]!.vcs!.diff, undefined);
    assert.match(result.dropped[0]!, /diff/);
  });

  test('keeps the active document when it drops the others', () => {
    const documents: OpenDocument[] = [
      { path: '/a.ts', languageId: 'typescript', dirty: false, active: false, text: 'x'.repeat(40000) },
      { path: '/b.ts', languageId: 'typescript', dirty: true, active: true, text: 'y'.repeat(400) },
    ];
    const result = fitToBudget(fixture({ documents }), { maxTokens: 500 });

    const active = result.snapshot.documents.find((document) => document.active);
    assert.ok(active, 'the active document must survive');
    assert.equal(result.snapshot.documents.find((d) => d.path === '/a.ts')?.text, undefined);
  });

  test('reports everything it dropped in the warnings, never silently', () => {
    const snapshot = fixture({
      workspaces: [{ root: '/w', name: 'w', vcs: { system: 'git', diff: 'x'.repeat(80000) } }],
    });
    const result = fitToBudget(snapshot, { maxTokens: 200 });

    assert.ok(result.snapshot.warnings.some((warning) => warning.includes('dropped')));
  });

  test('says so when even the irreducible core exceeds the budget', () => {
    // Honest failure rather than silently returning something oversized. A budget below the floor
    // cannot be met by dropping more.
    const documents = Array.from({ length: 40 }, (_, i) => ({
      path: `/very/long/path/to/file-number-${i}.ts`, languageId: 'typescript', dirty: false, active: false,
    }));
    const result = fitToBudget(fixture({ documents }), { maxTokens: 10 });

    assert.ok(result.estimatedTokens > 10);
    assert.ok(result.snapshot.warnings.some((warning) => warning.includes('irreducible core')));
  });

  test('does not mutate the caller\'s snapshot', () => {
    // The same capture is served to several consumers with different budgets; a destructive fit
    // would make the second depend on the first.
    const snapshot = fixture({
      workspaces: [{ root: '/w', name: 'w', vcs: { system: 'git', diff: 'x'.repeat(80000) } }],
    });
    fitToBudget(snapshot, { maxTokens: 100 });

    assert.equal(snapshot.workspaces[0]!.vcs!.diff!.length, 80000);
  });

  test('ranks the active document first, then dirty ones', () => {
    const ranked = rankDocuments([
      { path: '/c', languageId: 'x', dirty: false, active: false },
      { path: '/a', languageId: 'x', dirty: true, active: false },
      { path: '/b', languageId: 'x', dirty: false, active: true },
    ]);
    assert.deepEqual(ranked.map((document) => document.path), ['/b', '/a', '/c']);
  });

  test('ranks errors above warnings', () => {
    const diagnostics: Diagnostic[] = [
      { file: '/a', range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } }, severity: 'warning', message: 'w' },
      { file: '/a', range: { start: { line: 9, character: 0 }, end: { line: 9, character: 0 } }, severity: 'error', message: 'e' },
    ];
    assert.equal(rankDiagnostics(diagnostics)[0]!.severity, 'error');
  });

  test('estimates tokens proportionally to size', () => {
    assert.ok(estimateTokens('x'.repeat(400)) > estimateTokens('x'.repeat(40)));
  });
});

describe('runAdapter', () => {
  const base = { capabilities: NO_CAPABILITIES, confidence: 'persisted' as const };

  test('turns a thrown error into a report rather than propagating it', async () => {
    // One adapter failing must degrade a snapshot, never abort it: an incomplete answer is useful
    // and a stack trace is not.
    const adapter: Adapter = {
      ...base, id: 'boom', name: 'Boom',
      probe: async () => true,
      capture: async () => { throw new Error('disk on fire'); },
    };
    const { report } = await runAdapter(adapter, {});

    assert.equal(report.status, 'error');
    assert.match(report.reason!, /disk on fire/);
  });

  test('enforces its timeout on an adapter that hangs', async () => {
    const adapter: Adapter = {
      ...base, id: 'slow', name: 'Slow',
      probe: async () => true,
      capture: () => new Promise(() => { /* never resolves */ }),
    };
    const { report } = await runAdapter(adapter, { timeoutMs: 60 });

    assert.equal(report.status, 'error');
    assert.match(report.reason!, /timed out/);
  });

  test('skips capture entirely when the probe says no', async () => {
    let captured = false;
    const adapter: Adapter = {
      ...base, id: 'absent', name: 'Absent',
      probe: async () => false,
      capture: async () => { captured = true; return {}; },
    };
    const { report } = await runAdapter(adapter, {});

    assert.equal(report.status, 'not-found');
    assert.equal(captured, false, 'a failed probe must not cost a capture');
  });
});

describe('snapshot merge', () => {
  /** Two adapters describing the same file from different vantage points. */
  function twoAdapters(): Adapter[] {
    const disk: Adapter = {
      id: 'disk', name: 'Disk', confidence: 'session', capabilities: NO_CAPABILITIES,
      probe: async () => true,
      capture: async () => ({
        editors: [{
          adapter: 'disk', name: 'Editor', confidence: 'session',
          workspaces: [{ root: '/w', name: 'w' }],
          documents: [],
        }],
        documents: [{ path: '/w/a.ts', languageId: 'typescript', dirty: false, active: false, size: 1234 }],
      }),
    };
    const live: Adapter = {
      id: 'live', name: 'Live', confidence: 'live', capabilities: NO_CAPABILITIES,
      probe: async () => true,
      capture: async () => ({
        editors: [{
          adapter: 'live', name: 'Editor', confidence: 'live',
          workspaces: [{ root: '/w', name: 'w' }],
          documents: [],
        }],
        documents: [{
          path: '/w/a.ts', languageId: 'typescript', dirty: true, active: true,
          cursor: { line: 42, character: 8 },
        }],
      }),
    };
    return [disk, live];
  }

  test('the higher-confidence source wins and the lower one fills its gaps', async () => {
    const snapshot = await capture(twoAdapters(), { includeTree: false, includeVcs: false }, new Redactor(false));
    const document = snapshot.documents.find((item) => item.path === '/w/a.ts')!;

    assert.equal(document.cursor?.line, 42, 'the live cursor must win');
    assert.equal(document.dirty, true);
    assert.equal(document.size, 1234, 'the disk-only field must be kept, not discarded');
  });

  test('one editor seen by two adapters is reported once', async () => {
    const snapshot = await capture(twoAdapters(), { includeTree: false, includeVcs: false }, new Redactor(false));
    assert.equal(snapshot.editors.length, 1);
  });

  test('workspaces are described once, not once per editor that has them open', async () => {
    // Without this, every file tree and git history is serialized twice.
    const snapshot = await capture(twoAdapters(), { includeTree: false, includeVcs: false }, new Redactor(false));

    assert.equal(snapshot.workspaces.length, 1);
    assert.deepEqual(Object.keys(snapshot.editors[0]!.workspaces[0]!).sort(), ['name', 'root']);
  });

  test('identical diagnostics from two sources are deduplicated', async () => {
    const duplicate: Diagnostic = {
      file: '/w/a.ts',
      range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } },
      severity: 'error', message: 'same problem',
    };
    const make = (id: string, confidence: 'live' | 'session'): Adapter => ({
      id, name: id, confidence, capabilities: NO_CAPABILITIES,
      probe: async () => true,
      capture: async () => ({ diagnostics: [duplicate] }),
    });

    const snapshot = await capture([make('a', 'live'), make('b', 'session')], {}, new Redactor(false));
    assert.equal(snapshot.diagnostics.length, 1);
  });

  test('the only/exclude filters select adapters', async () => {
    const adapters = twoAdapters();
    const only = await capture(adapters, { only: ['live'] }, new Redactor(false));
    assert.deepEqual(only.provenance.map((report) => report.adapter), ['live']);

    const without = await capture(adapters, { exclude: ['live'] }, new Redactor(false));
    assert.deepEqual(without.provenance.map((report) => report.adapter), ['disk']);
  });

  test('disabling redaction is announced in the snapshot itself', async () => {
    const snapshot = await capture([], {}, new Redactor(false));
    assert.ok(snapshot.warnings.some((warning) => warning.includes('DISABLED')));
  });
});
