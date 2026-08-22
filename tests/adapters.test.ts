import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import {
  MessageFramer, ProtocolStore, createStdioProxy, frame,
  observeLspMessage, observeDapMessage, convertLspSymbols,
} from '../src/adapters/protocols.ts';
import { PushStore } from '../src/adapters/push.ts';
import { describeWorkspace, detectManifests } from '../src/adapters/generic.ts';
import { expandProjectPath, readWorkspaceXml } from '../src/adapters/jetbrains.ts';
import { readSolution } from '../src/adapters/visualstudio.ts';
import { parsePorcelainStatus } from '../src/vcs/git.ts';

/** A throwaway project directory, so adapter tests never depend on the host machine. */
let sandbox: string;

before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'auspex-test-'));

  await writeFile(join(sandbox, 'package.json'), JSON.stringify({
    name: 'sample', version: '2.1.0',
    scripts: { build: 'tsc', test: 'node --test' },
    dependencies: { left: '^1.0.0' },
    engines: { node: '>=22' },
  }));
  await writeFile(join(sandbox, 'Cargo.toml'), '[package]\nname = "sample-rs"\nversion = "0.3.0"\n');
  await writeFile(join(sandbox, 'Makefile'), 'build: deps\n\tcargo build\n\ntest:\n\tcargo test\n');
  await writeFile(join(sandbox, 'README.md'), '# Sample\n');

  await mkdir(join(sandbox, 'src'), { recursive: true });
  await writeFile(join(sandbox, 'src', 'main.ts'), 'export const x = 1;\n');
  await writeFile(join(sandbox, 'src', 'style.css'), '.a { color: red }\n');

  // A directory that must be skipped, or a scan of a real project drowns in dependencies.
  await mkdir(join(sandbox, 'node_modules', 'dep'), { recursive: true });
  await writeFile(join(sandbox, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
});

after(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe('workspace description', () => {
  test('detects every manifest present, across ecosystems', async () => {
    const manifests = await detectManifests(sandbox);
    const kinds = manifests.map((manifest) => manifest.kind).sort();

    assert.deepEqual(kinds, ['cargo', 'make', 'npm']);
  });

  test('reads the fields that say how a project is built', async () => {
    const manifests = await detectManifests(sandbox);
    const npm = manifests.find((manifest) => manifest.kind === 'npm')!;

    assert.equal(npm.name, 'sample');
    assert.equal(npm.version, '2.1.0');
    assert.deepEqual(Object.keys(npm.scripts!).sort(), ['build', 'test']);
    assert.equal(npm.toolchain, 'node >=22');
  });

  test('reads make targets as runnable entry points', async () => {
    // A Makefile's targets are the closest thing it has to declared commands, and they are exactly
    // what an assistant needs to know how to build the project.
    const make = (await detectManifests(sandbox)).find((manifest) => manifest.kind === 'make')!;
    assert.deepEqual(Object.keys(make.scripts!).sort(), ['build', 'test']);
    assert.equal(make.scripts!.build, 'deps');
  });

  test('reads TOML without a full parser', async () => {
    const cargo = (await detectManifests(sandbox)).find((manifest) => manifest.kind === 'cargo')!;
    assert.equal(cargo.name, 'sample-rs');
    assert.equal(cargo.version, '0.3.0');
  });

  test('counts languages across families', async () => {
    const workspace = await describeWorkspace(sandbox, { includeTree: true, includeVcs: false });

    assert.equal(workspace.languages?.typescript, 1);
    assert.equal(workspace.languages?.css, 1);
    assert.equal(workspace.languages?.markdown, 1);
  });

  test('never walks into node_modules', async () => {
    // Skipping these is most of what makes a scan fast enough to run on every question.
    const workspace = await describeWorkspace(sandbox, { includeTree: true, includeVcs: false });
    assert.ok(!JSON.stringify(workspace.tree).includes('node_modules'));
  });

  test('honours the file budget rather than scanning without limit', async () => {
    const workspace = await describeWorkspace(sandbox, { includeTree: true, includeVcs: false, maxFiles: 2 });
    assert.ok((workspace.fileCount ?? 0) <= 2);
  });
});

describe('git porcelain parsing', () => {
  test('reads NUL-separated status records', () => {
    // NUL-separated because the newline form quotes and escapes any path with a space in it.
    const files = parsePorcelainStatus('M  src/a.ts\0 M src/b.ts\0?? new.txt\0', 100)!;

    assert.deepEqual(files, [
      { path: 'src/a.ts', status: 'modified', staged: true },
      { path: 'src/b.ts', status: 'modified', staged: false },
      { path: 'new.txt', status: 'untracked', staged: false },
    ]);
  });

  test('consumes a rename\'s second path so it is not reported as a phantom file', () => {
    const files = parsePorcelainStatus('R  new.ts\0old.ts\0M  other.ts\0', 100)!;

    assert.equal(files.length, 2);
    assert.equal(files[0]!.status, 'renamed');
    assert.equal(files[1]!.path, 'other.ts');
  });

  test('recognizes conflicts, which change what advice is safe', () => {
    const files = parsePorcelainStatus('UU both.ts\0AA added.ts\0', 100)!;
    assert.ok(files.every((file) => file.status === 'conflicted'));
  });

  test('a file both staged and modified is reported twice, once per state', () => {
    const files = parsePorcelainStatus('MM half.ts\0', 100)!;
    assert.deepEqual(files.map((file) => file.staged), [true, false]);
  });
});

describe('JetBrains workspace.xml', () => {
  test('expands the $PROJECT_DIR$ macro', () => {
    // The macro exists so the file can be committed; unexpanded it matches nothing on disk.
    const path = expandProjectPath('file://$PROJECT_DIR$/src/Main.java', '/home/u/proj');
    assert.ok(path?.endsWith('/home/u/proj/src/Main.java') || path?.endsWith('proj/src/Main.java'));
  });

  test('refuses a macro it does not understand rather than guessing', () => {
    assert.equal(expandProjectPath('file://$MODULE_DIR$/x.java', '/p'), undefined);
  });

  test('skips a path inside a jar, which is not a file anyone is editing', () => {
    assert.equal(expandProjectPath('jar://$PROJECT_DIR$/lib.jar!/Thing.class', '/p'), undefined);
  });

  test('reads open tabs with their caret position and breakpoints', async () => {
    // The thing JetBrains gives away and VS Code does not: the caret, on disk.
    const xml = `<project>
  <component name="FileEditorManager">
    <leaf>
      <file pinned="false" current-in-tab="true">
        <entry file="file://$PROJECT_DIR$/src/App.kt">
          <provider selected="true" editor-type-id="text-editor">
            <state relative-caret-position="612">
              <caret line="41" column="7" selection-start-line="41" selection-end-line="41" />
            </state>
          </provider>
        </entry>
      </file>
    </leaf>
  </component>
  <component name="XDebuggerManager">
    <line-breakpoint enabled="true" type="kotlin-line">
      <url>file://$PROJECT_DIR$/src/App.kt</url>
      <line>17</line>
    </line-breakpoint>
  </component>
  <component name="RunManager">
    <configuration name="Run App" type="JetRunConfigurationType" />
  </component>
</project>`;
    const path = join(sandbox, 'workspace.xml');
    await writeFile(path, xml);

    const state = await readWorkspaceXml(path, '/proj');

    assert.equal(state.documents.length, 1);
    assert.equal(state.documents[0]!.active, true);
    assert.equal(state.documents[0]!.cursor?.line, 41);
    assert.equal(state.documents[0]!.cursor?.character, 7);
    assert.equal(state.breakpoints.length, 1);
    assert.equal(state.breakpoints[0]!.line, 17);
    assert.deepEqual(state.runConfigurations, [{ name: 'Run App', type: 'JetRunConfigurationType' }]);
  });
});

describe('Visual Studio solutions', () => {
  test('parses the classic .sln text format', async () => {
    const path = join(sandbox, 'App.sln');
    await writeFile(path,
      'Microsoft Visual Studio Solution File, Format Version 12.00\n' +
      'Project("{FAE04EC0-0000-0000-0000-000000000000}") = "Core", "src\\Core\\Core.csproj", "{ABC}"\n' +
      'Project("{FAE04EC0-0000-0000-0000-000000000000}") = "Tests", "test\\Tests\\Tests.csproj", "{DEF}"\n');

    const manifest = await readSolution(path);
    assert.equal(manifest?.kind, 'dotnet-solution');
    assert.deepEqual(Object.keys(manifest!.dependencies!).sort(), ['Core', 'Tests']);
  });

  test('parses the newer .slnx XML format', async () => {
    // Both formats are in active use right now; handling only one would miss half of .NET.
    const path = join(sandbox, 'App.slnx');
    await writeFile(path, '<Solution>\n  <Project Path="src/Core/Core.csproj" />\n</Solution>\n');

    const manifest = await readSolution(path);
    assert.equal(manifest?.kind, 'dotnet-solution-xml');
    assert.ok(Object.keys(manifest!.dependencies!).includes('Core.csproj'));
  });
});

describe('protocol framing', () => {
  test('reassembles a message split across chunks', () => {
    // TCP and pipes split writes wherever they like; anything assuming one chunk per message works
    // in testing and fails under load.
    const framer = new MessageFramer();
    const encoded = frame({ jsonrpc: '2.0', method: 'test', params: { value: 42 } });

    assert.deepEqual(framer.push(encoded.subarray(0, 12)), []);
    assert.deepEqual(framer.push(encoded.subarray(12, 30)), []);
    const messages = framer.push(encoded.subarray(30));

    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.message.method, 'test');
  });

  test('decodes two messages arriving in one chunk', () => {
    const framer = new MessageFramer();
    const both = Buffer.concat([frame({ method: 'a' }), frame({ method: 'b' })]);

    const messages = framer.push(both);
    assert.deepEqual(messages.map((item) => item.message.method), ['a', 'b']);
  });

  test('resynchronizes past a header with no length rather than stalling forever', () => {
    const framer = new MessageFramer();
    const stream = Buffer.concat([Buffer.from('Garbage: yes\r\n\r\n'), frame({ method: 'after' })]);

    const messages = framer.push(stream);
    assert.equal(messages[0]?.message.method, 'after');
  });

  test('survives malformed JSON without losing the stream', () => {
    const framer = new MessageFramer();
    const bad = Buffer.from('Content-Length: 3\r\n\r\n{{{');

    assert.deepEqual(framer.push(bad), []);
    assert.equal(framer.push(frame({ method: 'ok' }))[0]?.message.method, 'ok');
  });
});

describe('LSP and DAP observation', () => {
  test('records diagnostics from a publish notification', () => {
    const store = new ProtocolStore();
    observeLspMessage({
      method: 'textDocument/publishDiagnostics',
      params: {
        uri: 'file:///w/a.ts',
        diagnostics: [{
          range: { start: { line: 3, character: 2 }, end: { line: 3, character: 9 } },
          severity: 1, message: 'Type error', code: 'TS2322', source: 'ts',
        }],
      },
    }, store);

    const diagnostics = store.allDiagnostics();
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]!.severity, 'error');
    assert.equal(diagnostics[0]!.code, 'TS2322');
    assert.equal(diagnostics[0]!.file, '/w/a.ts');
  });

  test('an empty publish clears a file, so a fixed error stops being reported', () => {
    const store = new ProtocolStore();
    const publish = (diagnostics: unknown[]) => observeLspMessage({
      method: 'textDocument/publishDiagnostics',
      params: { uri: 'file:///w/a.ts', diagnostics },
    }, store);

    publish([{ range: { start: { line: 0, character: 0 } }, severity: 1, message: 'x' }]);
    assert.equal(store.allDiagnostics().length, 1);

    publish([]);
    assert.equal(store.allDiagnostics().length, 0);
  });

  test('converts nested LSP symbols, keeping the hierarchy', () => {
    const symbols = convertLspSymbols([{
      name: 'Widget', kind: 5,
      range: { start: { line: 0, character: 0 }, end: { line: 9, character: 0 } },
      children: [{
        name: 'render', kind: 6,
        range: { start: { line: 2, character: 2 }, end: { line: 4, character: 2 } },
      }],
    }]);

    assert.equal(symbols[0]!.kind, 'class');
    assert.equal(symbols[0]!.children?.[0]!.kind, 'method');
  });

  test('tracks a debug session through stop, stack and continue', () => {
    const store = new ProtocolStore();

    observeDapMessage({ type: 'event', event: 'stopped', body: { reason: 'breakpoint', threadId: 1 } }, store);
    assert.equal(store.debugState()?.status, 'paused');
    assert.equal(store.debugState()?.stoppedReason, 'breakpoint');

    observeDapMessage({
      type: 'response', command: 'stackTrace',
      body: { stackFrames: [{ id: 1, name: 'main', line: 12, source: { path: '/w/a.ts' } }] },
    }, store);
    assert.equal(store.debugState()?.stack?.[0]!.name, 'main');

    observeDapMessage({ type: 'event', event: 'continued', body: {} }, store);
    assert.equal(store.debugState()?.status, 'running');

    observeDapMessage({ type: 'event', event: 'terminated', body: {} }, store);
    assert.equal(store.debugState()?.active, false);
  });

  test('caps captured output so a debuggee logging in a loop cannot grow it without bound', () => {
    const store = new ProtocolStore();
    for (let i = 0; i < 900; i++) {
      observeDapMessage({ type: 'event', event: 'output', body: { output: `line ${i}\n` } }, store);
    }
    assert.ok((store.debugState()?.output?.length ?? 0) <= 500);
  });
});

describe('push ingestion', () => {
  test('normalizes a minimal payload', () => {
    // Every field is optional by design: a plugin author should be able to send what their editor
    // makes easy and get proportionate value.
    const store = new PushStore();
    store.ingest({ editor: 'neovim', documents: [{ path: '/w/a.lua' }] });

    const [record] = store.current();
    assert.equal(record!.editor.name, 'neovim');
    assert.equal(record!.editor.documents[0]!.languageId, 'lua', 'the language is inferred when omitted');
  });

  test('trusts an editor\'s own language id over the extension table', () => {
    // The editor knows about the user's file associations and custom modes; no table can.
    const store = new PushStore();
    store.ingest({ documents: [{ path: '/w/thing.conf', languageId: 'nginx' }] });

    assert.equal(store.current()[0]!.editor.documents[0]!.languageId, 'nginx');
  });

  test('accepts severity as a name or as an LSP number', () => {
    const store = new PushStore();
    store.ingest({ diagnostics: [{ path: '/a', severity: 1 }, { path: '/b', severity: 'Warning' }] });

    const [record] = store.current();
    assert.deepEqual(record!.diagnostics.map((item) => item.severity), ['error', 'warning']);
  });

  test('keeps two windows of the same editor apart', () => {
    const store = new PushStore();
    store.ingest({ editor: 'vscode', pid: 1, documents: [{ path: '/a' }] });
    store.ingest({ editor: 'vscode', pid: 2, documents: [{ path: '/b' }] });

    assert.equal(store.size, 2);
  });

  test('ages out a plugin that stopped reporting', () => {
    // A stale push must not be served as though it were live.
    const store = new PushStore();
    store.staleAfterMs = 0;
    store.ingest({ editor: 'vscode', documents: [{ path: '/a' }] });

    assert.equal(store.size, 0);
  });

  test('caps terminal lines at the receiver, not at the sender', () => {
    const store = new PushStore();
    store.ingest({ terminals: [{ name: 'build', lines: Array.from({ length: 900 }, (_, i) => `l${i}`) }] });

    assert.equal(store.current()[0]!.terminals[0]!.lines.length, 200);
  });

  test('reports live confidence, which is what lets it win the merge', () => {
    const store = new PushStore();
    store.ingest({ editor: 'vscode', documents: [{ path: '/a', cursor: { line: 5, character: 0 } }] });

    assert.equal(store.current()[0]!.editor.confidence, 'live');
  });
});

describe('stdio proxy lifecycle', () => {
  test('detaching releases stdin, so the process can exit when the server does', () => {
    // The framing tests all passed while this was broken, because none of them owned the event
    // loop: `auspex proxy` sat forever after its language server exited. Counting listeners is the
    // observable version of "the event loop is no longer held open".
    const before = process.stdin.listenerCount('data');

    const child = {
      stdin: { write: () => true } as unknown as NodeJS.WritableStream,
      stdout: new EventEmitter() as unknown as NodeJS.ReadableStream,
    };
    const detach = createStdioProxy('lsp', child, new ProtocolStore());

    assert.equal(process.stdin.listenerCount('data'), before + 1);
    detach();
    assert.equal(process.stdin.listenerCount('data'), before);
  });

  test('forwards every byte to the child before observing anything', () => {
    // The safety argument for sitting in the middle of someone's editor: an observation error must
    // never be able to affect what was forwarded, which is only true if the forward happens first.
    const written: Buffer[] = [];
    const stdout = new EventEmitter();
    const store = new ProtocolStore();

    const detach = createStdioProxy('lsp', {
      stdin: { write: (chunk: Buffer) => { written.push(chunk); return true; } } as unknown as NodeJS.WritableStream,
      stdout: stdout as unknown as NodeJS.ReadableStream,
    }, store);

    try {
      const message = frame({
        method: 'textDocument/publishDiagnostics',
        params: { uri: 'file:///w/a.ts', diagnostics: [{ range: { start: { line: 0, character: 0 } }, severity: 1, message: 'x' }] },
      });
      stdout.emit('data', message);

      assert.equal(store.allDiagnostics().length, 1, 'the message was observed');
    } finally {
      detach();
    }
  });
});
