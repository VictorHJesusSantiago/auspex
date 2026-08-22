#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { CaptureOptions } from '../core/adapter.ts';
import { capture, defaultAdapters, summarize, SCHEMA_VERSION } from '../core/snapshot.ts';
import { Redactor } from '../core/redact.ts';
import { fitToBudget } from '../core/budget.ts';
import { extractOutline, flattenSymbols } from '../languages/outline.ts';
import { normalizePath, readTextFile } from '../platform/files.ts';
import { readGitState } from '../vcs/git.ts';
import { listDetectedEditors } from '../adapters/editors.ts';
import { createStdioProxy, protocolStore, type ProtocolKind } from '../adapters/protocols.ts';
import { startHttpServer } from '../server/http.ts';
import { McpServer, mcpClientConfig } from '../server/mcp.ts';
import { PROVIDERS, shapeForProvider, openAiToolDefinitions, type ProviderId } from '../ai/providers.ts';
import { debugRecorder, DebugRecorder } from '../adapters/debug.ts';
import { listSessions, publishSession, readSession } from '../core/debug-store.ts';
import { renderDebugSession } from './debug-format.ts';
import { analyseSession } from '../debug/analysis.ts';
import { DebugJournal, journalPath, readStops, summarizeJournal, replayJournal } from '../debug/journal.ts';
import { findLaunchConfigurations, recommendAdapters, wiringFor } from '../debug/launch-config.ts';
import { adapterById, explainNoMemory } from '../debug/registry.ts';
import { readStopSource, renderSource } from '../debug/source-context.ts';
import { analyseConcurrency, renderConcurrency } from '../debug/concurrency.ts';
import { decodeMemory, decodeRegisters, renderDecodedMemory } from '../debug/memory-decode.ts';
import { queryJournal, queryRecord, renderMatches, renderTrajectory, trajectory, trajectoryFromJournal } from '../debug/query.ts';
import { createBundle, compareBundles, readBundle, writeBundle } from '../debug/bundle.ts';
import { inferShape, interpretTree, renderCollectionSummary, summarizeCollection } from '../debug/values.ts';
import { debugReport, debugSizeReport, debugSummary } from '../ai/debug-report.ts';
import { anthropicDebugTools, geminiDebugTools, openAiDebugTools } from '../ai/debug-tools.ts';
import { renderSnapshot, bold, grey, pad, paint, truncate } from './format.ts';
import { runTui } from './tui.ts';

/**
 * The command-line entry point.
 *
 * Every capability is reachable from here, which is deliberate: a connector that can only be driven
 * by an AI is impossible to debug, and the brief asks for a terminal tool as well as an interface.
 * So `auspex capture` prints what would be sent, `auspex watch` shows it changing live, and
 * `auspex mcp` is the same data behind the protocol — three views of one pipeline, which is what
 * makes it possible to tell whether a thin answer is the tool's fault or the environment's.
 */

interface Args {
  command: string;
  positionals: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const command = argv[0] ?? 'help';
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();

  for (let i = 1; i < argv.length; i++) {
    const token = argv[i]!;
    // Everything after a bare `--` is a command line for a child process, not our business.
    if (token === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith('--')) {
      const [name, inline] = token.slice(2).split('=', 2);
      if (inline !== undefined) {
        flags.set(name!, inline);
      } else if (argv[i + 1] && !argv[i + 1]!.startsWith('-')) {
        flags.set(name!, argv[++i]!);
      } else {
        flags.set(name!, true);
      }
      continue;
    }
    positionals.push(token);
  }
  return { command, positionals, flags };
}

const args = parseArgs(process.argv.slice(2));

function flag(name: string, fallback?: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === 'string' ? value : value === true ? '' : fallback;
}

function boolFlag(name: string, fallback = false): boolean {
  const value = args.flags.get(name);
  if (value === undefined) return fallback;
  return value === true || value === 'true' || value === '';
}

function numberFlag(name: string, fallback: number): number {
  const value = Number(args.flags.get(name));
  return Number.isFinite(value) ? value : fallback;
}

/** Capture options common to every command that captures. */
function captureOptions(): CaptureOptions {
  const root = flag('root');
  return {
    roots: root ? [root] : undefined,
    includeTree: !boolFlag('no-tree'),
    includeText: boolFlag('text'),
    includeVcs: !boolFlag('no-git'),
    includeDiff: boolFlag('diff'),
    maxTreeDepth: numberFlag('depth', 4),
    maxFiles: numberFlag('max-files', 4000),
    timeoutMs: numberFlag('timeout', 10000),
    only: flag('only')?.split(',').filter(Boolean),
    exclude: flag('exclude')?.split(',').filter(Boolean),
  };
}

function redactor(): Redactor {
  // The negative flag is deliberate: redaction is on unless someone types out that they want it off.
  const disabled = boolFlag('no-redact');
  if (disabled) {
    process.stderr.write(paint(
      'WARNING: redaction disabled. This output may contain API keys, tokens and passwords.\n',
      'red',
    ));
  }
  return new Redactor(!disabled);
}

async function main(): Promise<number> {
  switch (args.command) {
    case 'capture': return commandCapture();
    case 'watch': return commandWatch();
    case 'editors': return commandEditors();
    case 'file': return commandFile();
    case 'git': return commandGit();
    case 'serve': return commandServe();
    case 'gui': return commandGui();
    case 'mcp': return commandMcp();
    case 'proxy': return commandProxy();
    case 'debug': return commandDebug();
    case 'connect': return commandConnect();
    case 'doctor': return commandDoctor();
    case 'help':
    case '--help':
    case '-h': printUsage(); return 0;
    case 'version':
    case '--version': process.stdout.write(`auspex ${SCHEMA_VERSION}\n`); return 0;
    default:
      process.stderr.write(`unknown command '${args.command}'\n\n`);
      printUsage();
      return 1;
  }
}

// -- Commands -----------------------------------------------------------------------------------

/** Captures once and prints it, in whichever shape was asked for. */
async function commandCapture(): Promise<number> {
  const snapshot = await capture(await defaultAdapters(), captureOptions(), redactor());
  const format = flag('format', 'text')!;
  const maxTokens = args.flags.has('max-tokens') ? numberFlag('max-tokens', 8000) : undefined;

  let output: string;

  if (format === 'json') {
    const payload = maxTokens ? fitToBudget(snapshot, { maxTokens }).snapshot : snapshot;
    output = JSON.stringify(payload, null, 2);
  } else if (format in PROVIDERS) {
    const shaped = shapeForProvider(snapshot, { provider: format as ProviderId, maxTokens });
    output = typeof shaped.content === 'string' ? shaped.content : JSON.stringify(shaped.content, null, 2);
    if (shaped.dropped.length > 0) {
      process.stderr.write(grey(`reduced to ~${shaped.estimatedTokens} tokens; dropped ${shaped.dropped.length} item(s)\n`));
    }
  } else {
    output = renderSnapshot(snapshot, { verbose: boolFlag('verbose') });
  }

  const target = flag('out');
  if (target) {
    await writeFile(target, output, 'utf8');
    process.stdout.write(`${summarize(snapshot)}\nwritten to ${target}\n`);
  } else {
    process.stdout.write(`${output}\n`);
  }
  return 0;
}

/** The live terminal interface. */
async function commandWatch(): Promise<number> {
  if (!process.stdin.isTTY) {
    process.stderr.write('watch needs an interactive terminal; use `capture` when piping\n');
    return 1;
  }
  await runTui({
    captureOptions: captureOptions(),
    redact: !boolFlag('no-redact'),
    interval: numberFlag('interval', 5),
  });
  return 0;
}

/** Lists what could be detected, without a full capture. Fast, and the first thing to try. */
async function commandEditors(): Promise<number> {
  const detected = await listDetectedEditors();

  process.stdout.write(`${bold('Editor processes')}\n`);
  if (detected.length === 0) {
    process.stdout.write(grey('  none found\n'));
  }
  for (const item of detected) {
    process.stdout.write(`  ${item.name} ${grey(`pid ${item.pid}`)}\n`);
    if (boolFlag('verbose')) process.stdout.write(grey(`    ${item.command.slice(0, 160)}\n`));
  }

  process.stdout.write(`\n${bold('Adapters')}\n`);
  for (const adapter of await defaultAdapters()) {
    const available = await adapter.probe();
    const capable = Object.entries(adapter.capabilities)
      .filter(([, enabled]) => enabled).map(([name]) => name);
    const mark = available ? paint('●', 'green') : grey('○');
    process.stdout.write(`  ${mark} ${adapter.id.padEnd(16)} ${grey(adapter.confidence.padEnd(10))} ${grey(capable.join(', '))}\n`);
  }
  return 0;
}

/** Reads one file, or its outline. */
async function commandFile(): Promise<number> {
  const path = args.positionals[0];
  if (!path) {
    process.stderr.write('usage: auspex file <path> [--outline]\n');
    return 1;
  }
  const scrubber = redactor();
  if (scrubber.isSensitiveFile(path)) {
    process.stderr.write(paint('refused: this file exists to hold credentials\n', 'yellow'));
    return 1;
  }
  const text = await readTextFile(path, numberFlag('max-bytes', 1024 * 1024));
  if (text === undefined) {
    process.stderr.write('not readable as text, too large, or missing\n');
    return 1;
  }

  if (boolFlag('outline')) {
    const outline = extractOutline(path, text);
    process.stdout.write(`${bold(path)} ${grey(`(${outline.source})`)}\n`);
    if (outline.note) process.stdout.write(grey(`${outline.note}\n`));
    for (const symbol of flattenSymbols(outline.symbols)) {
      const indent = '  '.repeat(symbol.depth + 1);
      const detail = symbol.detail ? grey(` ${symbol.detail}`) : '';
      process.stdout.write(`${indent}${grey(symbol.kind.padEnd(12))} ${symbol.name}${detail}\n`);
    }
    return 0;
  }
  process.stdout.write(`${scrubber.redact(text)}\n`);
  return 0;
}

/** Version-control state for a directory. */
async function commandGit(): Promise<number> {
  const root = args.positionals[0] ?? process.cwd();
  const state = await readGitState(root, { includeDiff: boolFlag('diff') });

  if (boolFlag('json')) {
    process.stdout.write(`${JSON.stringify(redactor().redactValue(state), null, 2)}\n`);
    return 0;
  }
  if (state.system === 'none') {
    process.stdout.write(grey('not a repository\n'));
    return 0;
  }

  process.stdout.write(`${bold(state.branch ?? '?')}`);
  if (state.upstream) process.stdout.write(grey(` → ${state.upstream}`));
  if (state.ahead) process.stdout.write(paint(` ↑${state.ahead}`, 'green'));
  if (state.behind) process.stdout.write(paint(` ↓${state.behind}`, 'yellow'));
  if (state.operationInProgress) process.stdout.write(paint(` [${state.operationInProgress}]`, 'red'));
  process.stdout.write('\n');

  for (const file of state.files?.slice(0, 40) ?? []) {
    const staged = file.staged ? paint('S', 'green') : ' ';
    process.stdout.write(`  ${staged} ${file.status.padEnd(10)} ${file.path}\n`);
  }
  for (const commit of state.recentCommits?.slice(0, 8) ?? []) {
    process.stdout.write(grey(`  ${commit.hash.slice(0, 8)} ${commit.subject}\n`));
  }
  return 0;
}

/** The HTTP server. */
async function commandServe(): Promise<number> {
  const running = await startHttpServer({
    port: numberFlag('port', 4278),
    host: flag('host', '127.0.0.1'),
    captureOptions: captureOptions(),
    redact: !boolFlag('no-redact'),
    token: flag('token'),
  });

  process.stdout.write(`${bold('auspex')} serving on ${running.url}\n`);
  process.stdout.write(grey(`  GUI          ${running.url}/\n`));
  process.stdout.write(grey(`  context      ${running.url}/context\n`));
  process.stdout.write(grey(`  OpenAPI      ${running.url}/openapi.json\n`));
  process.stdout.write(grey(`  push here    POST ${running.url}/push\n`));
  if (running.token) process.stdout.write(paint(`  bearer token ${running.token}\n`, 'yellow'));
  process.stdout.write(grey('\nCtrl-C to stop.\n'));

  await waitForSignal();
  await running.close();
  return 0;
}

/** The server, plus opening the GUI in a browser. */
async function commandGui(): Promise<number> {
  const running = await startHttpServer({
    port: numberFlag('port', 4278),
    captureOptions: captureOptions(),
    redact: !boolFlag('no-redact'),
  });
  process.stdout.write(`${bold('auspex')} GUI at ${running.url}\n`);

  if (!boolFlag('no-open')) {
    // The per-platform incantation for "open this in whatever the user's browser is".
    const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', running.url]]
      : process.platform === 'darwin' ? ['open', [running.url]]
      : ['xdg-open', [running.url]];
    try {
      spawn(opener[0] as string, opener[1] as string[], { detached: true, stdio: 'ignore' }).unref();
    } catch {
      process.stdout.write(grey('could not open a browser; visit the URL above\n'));
    }
  }

  await waitForSignal();
  await running.close();
  return 0;
}

/** The MCP server on stdio. */
async function commandMcp(): Promise<number> {
  const server = new McpServer({
    captureOptions: captureOptions(),
    redact: !boolFlag('no-redact'),
  });
  await server.serveStdio();
  return 0;
}

/**
 * The LSP/DAP proxy.
 *
 * Runs the real server as a child and sits between it and the editor. See `adapters/protocols.ts`
 * for why this is the most universal capture mechanism here.
 */
async function commandProxy(): Promise<number> {
  const kind: ProtocolKind = boolFlag('dap') ? 'dap' : 'lsp';
  const command = args.positionals;

  if (command.length === 0) {
    process.stderr.write('usage: auspex proxy [--lsp|--dap] -- <command to run the real server>\n');
    return 1;
  }

  const child = spawn(command[0]!, command.slice(1), {
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  });

  // `--deep` is opt-in rather than the default for `--dap`, and deliberately so. Deep mode issues
  // its own requests into the user's live debug session; that is safe (see `DebugRecorder`) but it
  // is not *nothing*, and a proxy that silently started interrogating someone's debugger because
  // they asked it to watch would be taking a decision that is theirs to take.
  const deep = boolFlag('deep') && kind === 'dap';
  const journals: DebugJournal[] = [];
  const recorder = deep ? new DebugRecorder(flag('session', 'proxy')!) : debugRecorder;

  const detach = createStdioProxy(
    kind,
    { stdin: child.stdin!, stdout: child.stdout! },
    protocolStore,
    { deep, recorder },
  );

  if (deep) {
    process.stderr.write(grey(`deep debug capture on; session published as '${recorder.session.sessionId}'\n`));

    // Opt-in, because a journal is durable: it survives the session, holds the program's variables,
    // and grows with every stop. Writing one by default would leave a developer's state on disk
    // after every debug run without them ever asking for it.
    if (boolFlag('journal')) {
      const journal = new DebugJournal(recorder.session.sessionId, {
        redactor: redactor(),
        includeEvents: !boolFlag('no-journal-events'),
      });
      recorder.journalTo(journal);
      journals.push(journal);
      process.stderr.write(grey(`journalling to ${journal.path}\n`));
    }

    // Published on a timer rather than on every message: a stepping developer produces hundreds of
    // messages a second, and rewriting a megabyte of JSON for each one would make the proxy the
    // slowest thing in the session.
    const publisher = setInterval(() => {
      void publishSession(recorder.session, redactor()).catch(() => {
        // A temp directory that cannot be written is not a reason to break someone's debugger.
      });
    }, 1000);
    publisher.unref();
  }

  // Optionally publish what is observed, so a separate `auspex serve` can see it. Without this the
  // captured diagnostics live only in this process, which is useful only if this process is also
  // the one serving.
  const forwardTo = flag('forward');
  if (forwardTo) {
    const timer = setInterval(() => {
      void fetch(`${forwardTo}/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          editor: `${kind}-proxy`,
          name: `${kind.toUpperCase()} proxy`,
          pid: process.pid,
          diagnostics: protocolStore.allDiagnostics().map((item) => ({
            path: item.file,
            line: item.range.start.line,
            character: item.range.start.character,
            severity: item.severity,
            message: item.message,
            code: item.code,
            source: item.source,
          })),
          debug: protocolStore.debugState(),
        }),
      }).catch(() => {
        // The server may not be running yet, or may have stopped. Neither is fatal to the proxy,
        // whose first duty is to keep the editor working.
      });
    }, 2000);
    timer.unref();
  }

  return new Promise<number>((resolve) => {
    const finish = async (code: number) => {
      detach();
      // One last publish: the timer may not have fired since the final stop, and the end of a
      // session is exactly when someone wants to read it.
      if (deep) await publishSession(recorder.session, redactor()).catch(() => {});
      // Flush before resolving: an append queue with work outstanding would lose the final stops,
      // which are the ones a post-mortem is about.
      for (const journal of journals) {
        journal.end(recorder.session.status, recorder.session.totals);
        await journal.flush().catch(() => {});
      }
      resolve(code);
    };
    child.on('exit', (code) => void finish(code ?? 0));
    child.on('error', (error) => {
      process.stderr.write(`could not start ${command[0]}: ${error.message}\n`);
      void finish(1);
    });
  });
}

/**
 * Prints a captured debug session.
 *
 * Reads whatever a `auspex proxy --dap --deep` published, which is why this works from a different
 * terminal than the one the proxy is running in — and why it works after the session has ended.
 */
async function commandDebug(): Promise<number> {
  const subcommand = args.positionals[0];

  if (subcommand === 'report') return debugReportCommand();
  if (subcommand === 'analyze' || subcommand === 'analyse') return debugAnalyzeCommand();
  if (subcommand === 'wire') return debugWireCommand();
  if (subcommand === 'history') return debugHistoryCommand();
  if (subcommand === 'size') return debugSizeCommand();
  if (subcommand === 'tools') return debugToolsCommand();
  if (subcommand === 'source') return debugSourceCommand();
  if (subcommand === 'threads') return debugThreadsCommand();
  if (subcommand === 'memory') return debugMemoryCommand();
  if (subcommand === 'find' || subcommand === 'query') return debugFindCommand();
  if (subcommand === 'trace') return debugTraceCommand();
  if (subcommand === 'values') return debugValuesCommand();
  if (subcommand === 'bundle') return debugBundleCommand();
  if (subcommand === 'open') return debugOpenCommand();
  if (subcommand === 'compare') return debugCompareCommand();

  if (subcommand === 'list') {
    const sessions = await listSessions();
    if (sessions.length === 0) {
      process.stdout.write('no captured debug sessions\n');
      return 0;
    }
    for (const { path, modified } of sessions) {
      process.stdout.write(`${new Date(modified).toISOString()}  ${path}\n`);
    }
    return 0;
  }

  const record = await readSession(flag('session'));
  if (!record) {
    process.stderr.write(
      'no captured debug session\n\n' +
      'Start one by putting Auspex between your editor and its debug adapter:\n' +
      '  auspex proxy --dap --deep -- <debug adapter command>\n',
    );
    return 1;
  }

  if (flag('format') === 'json') {
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(`${renderDebugSession(record, {
    verbose: boolFlag('verbose'),
    timeline: boolFlag('timeline'),
    memory: boolFlag('memory'),
    timelineLimit: numberFlag('limit', 40),
  })}\n`);
  return 0;
}

/**
 * Loads a session, or explains how to get one.
 *
 * Shared by every debug subcommand, so that "not configured" reads the same everywhere and always
 * points at `auspex debug wire` rather than repeating advice the user has already been unable to
 * act on.
 */
async function loadSession() {
  const record = await readSession(flag('session'));
  if (!record) {
    process.stderr.write(
      'no captured debug session\n\n' +
      'Start one by putting Auspex between your editor and its debug adapter:\n' +
      '  auspex proxy --dap --deep -- <debug adapter command>\n\n' +
      'Not sure what that command is? Run `auspex debug wire` — it reads this project\'s\n' +
      'launch configurations and prints the exact one.\n',
    );
  }
  return record;
}

/** The markdown briefing, which is what gets pasted into an assistant. */
async function debugReportCommand(): Promise<number> {
  const record = await loadSession();
  if (!record) return 1;

  const sources = record.currentStop
    ? await readStopSource(record.currentStop, { redactor: redactor() })
    : {};

  const output = boolFlag('short')
    ? debugSummary(record)
    : debugReport(record, {
      sources,
      maxTokens: args.flags.has('max-tokens') ? numberFlag('max-tokens', 6000) : undefined,
      includeMemory: boolFlag('memory'),
      includeTimeline: boolFlag('timeline'),
    });

  const target = flag('out');
  if (target) {
    await writeFile(target, output, 'utf8');
    process.stdout.write(`written to ${target}\n`);
  } else {
    process.stdout.write(`${output}\n`);
  }
  return 0;
}

/** The findings, ranked. */
async function debugAnalyzeCommand(): Promise<number> {
  const record = await loadSession();
  if (!record) return 1;

  const sources = record.currentStop ? await readStopSource(record.currentStop) : {};
  const analysis = analyseSession(record, { sources });

  if (flag('format') === 'json') {
    process.stdout.write(`${JSON.stringify(analysis, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(`${bold(analysis.headline)}\n\n`);

  if (analysis.findings.length === 0) {
    process.stdout.write(grey('nothing stood out in this capture\n'));
    return 0;
  }

  for (const finding of analysis.findings) {
    const colour = finding.severity === 'high' ? 'red'
      : finding.severity === 'medium' ? 'yellow'
      : finding.severity === 'low' ? 'grey' : 'cyan';
    process.stdout.write(`${paint('●', colour as never)} ${bold(finding.summary)}\n`);

    for (const evidence of finding.evidence.slice(0, boolFlag('verbose') ? 20 : 3)) {
      for (const line of evidence.split('\n').slice(0, 8)) {
        process.stdout.write(grey(`    ${line}\n`));
      }
    }
    if (finding.nextStep) process.stdout.write(`    ${paint('→', 'cyan')} ${finding.nextStep}\n`);
    process.stdout.write('\n');
  }

  // Said at the end rather than the top: it is a caveat on what was just read, and a caveat before
  // the content is a caveat nobody remembers by the time it applies.
  process.stdout.write(grey(
    'These are observations with their evidence, not diagnoses. Check them before acting.\n'));
  return 0;
}

/** How to wire the proxy into this project. */
async function debugWireCommand(): Promise<number> {
  const root = args.positionals[1] ?? process.cwd();
  const configurations = await findLaunchConfigurations(root);

  process.stdout.write(`${bold('Debug wiring')} ${grey(root)}\n\n`);

  if (configurations.length === 0) {
    process.stdout.write(grey('No launch configuration found in this project.\n\n'));

    const snapshot = await capture(await defaultAdapters(), { includeTree: true, includeVcs: false }, redactor());
    const languages = Object.keys(snapshot.workspaces.find((workspace) => workspace.root === normalizePath(root))
      ?.languages ?? snapshot.workspaces[0]?.languages ?? {});

    const recommendations = recommendAdapters(languages);
    if (recommendations.length === 0) {
      process.stdout.write('Auspex could not tell which debugger this project would use.\n');
      process.stdout.write(grey('Deep capture is protocol-level, so any DAP adapter works:\n'));
      process.stdout.write('  auspex proxy --dap --deep -- <your debug adapter command>\n');
      return 0;
    }

    process.stdout.write(`${bold('By language')}\n`);
    for (const item of recommendations) {
      process.stdout.write(`  ${paint(item.language, 'cyan')}\n`);
      for (const adapter of item.adapters) {
        const how = adapter.command
          ? `auspex proxy --dap --deep -- ${adapter.command.program} ${adapter.command.args.join(' ')}`
          : `ships inside the ${adapter.extensionHint} extension — use the socket proxy`;
        process.stdout.write(`    ${adapter.name.padEnd(28)} ${grey(how)}\n`);
        if (adapter.command?.install) {
          process.stdout.write(`    ${' '.repeat(28)} ${grey(`install: ${adapter.command.install}`)}\n`);
        }
      }
    }
    return 0;
  }

  for (const configuration of configurations) {
    const wiring = wiringFor(configuration);
    const mark = wiring.confidence === 'exact' ? paint('✓', 'green')
      : wiring.confidence === 'pattern' ? paint('~', 'yellow')
      : grey('?');

    process.stdout.write(`${mark} ${bold(configuration.name)} ${grey(`(${configuration.type}, ${configuration.request})`)}\n`);
    process.stdout.write(grey(`  from ${configuration.source}\n`));

    if (wiring.command) process.stdout.write(`  ${paint(wiring.command, 'cyan')}\n`);
    if (wiring.snippet && boolFlag('verbose')) {
      for (const line of wiring.snippet.split('\n')) process.stdout.write(grey(`    ${line}\n`));
    }
    for (const line of wrap(wiring.explanation, 92)) process.stdout.write(grey(`  ${line}\n`));
    process.stdout.write('\n');
  }
  return 0;
}

/** Earlier stops, out of the journal. */
async function debugHistoryCommand(): Promise<number> {
  const session = flag('session');
  const record = await readSession(session);
  const path = flag('journal') ?? journalPath(session ?? record?.sessionId ?? 'proxy');

  const summary = await summarizeJournal(path).catch(() => undefined);
  if (!summary || summary.bytes === 0) {
    process.stderr.write(
      `no journal at ${path}\n\n` +
      'The live record keeps only recent stops. To keep the whole history of a session,\n' +
      'run the proxy with --journal:\n' +
      '  auspex proxy --dap --deep --journal -- <debug adapter command>\n',
    );
    return 1;
  }

  process.stdout.write(`${bold('Journal')} ${grey(path)}\n`);
  process.stdout.write(grey(
    `${summary.stops} stop(s) · ${summary.events} event(s) · ${summary.outputLines} output line(s) · ` +
    `${(summary.bytes / 1024).toFixed(1)}KB` +
    (summary.ended ? ` · ended ${summary.ended.status}` : ' · no end entry') +
    (summary.corruptLines > 0 ? ` · ${summary.corruptLines} unparseable line(s)` : '') + '\n\n'));

  if (boolFlag('replay')) {
    const replayed = await replayJournal(path);
    if (replayed) process.stdout.write(`${renderDebugSession(replayed, { verbose: boolFlag('verbose') })}\n`);
    return 0;
  }

  const stops = await readStops(path, {
    from: numberFlag('from', 1),
    to: args.flags.has('to') ? numberFlag('to', 0) : undefined,
    limit: numberFlag('limit', 20),
  });

  for (const stop of stops) {
    const top = Object.values(stop.stacks)[0]?.[0];
    process.stdout.write(
      `${grey(`#${String(stop.index).padStart(4)}`)} ${pad(stop.reason ?? '?', 12)} ` +
      `${top ? `${top.name} ${grey(`${top.file ?? '?'}:${top.line ?? '?'}`)}` : grey('no frames')}` +
      `${stop.exception ? ` ${paint(stop.exception.typeName ?? '', 'red')}` : ''}\n`);
  }
  return 0;
}

/** Where the size of a record is going. */
async function debugSizeCommand(): Promise<number> {
  const record = await loadSession();
  if (!record) return 1;

  process.stdout.write(`${bold('Debug record size')}\n\n${debugSizeReport(record)}\n\n`);
  process.stdout.write(grey('Reduce with `auspex debug report --max-tokens N`, which drops in a documented order.\n'));
  return 0;
}

/** Tool definitions for assistants that do not speak MCP. */
async function debugToolsCommand(): Promise<number> {
  const provider = args.positionals[1] ?? 'openai';
  const tools = provider === 'gemini' ? geminiDebugTools()
    : provider === 'anthropic' || provider === 'claude' ? anthropicDebugTools()
    : openAiDebugTools();

  process.stdout.write(`${JSON.stringify(tools, null, 2)}\n`);
  return 0;
}

/** The source around each frame, which is what makes a stack readable. */
async function debugSourceCommand(): Promise<number> {
  const record = await loadSession();
  if (!record?.currentStop) {
    if (record) process.stderr.write('the session has no captured stop\n');
    return 1;
  }

  const sources = await readStopSource(record.currentStop, {
    radius: numberFlag('radius', 6),
    maxFrames: numberFlag('frames', 8),
    redactor: redactor(),
  });

  const threadId = record.currentStop.threadId ?? Number(Object.keys(record.currentStop.stacks)[0]);
  for (const frame of record.currentStop.stacks[threadId] ?? []) {
    const source = sources[frame.id];
    if (!source) continue;

    process.stdout.write(`${bold(frame.name)} ${grey(`${frame.file ?? '?'}:${frame.line ?? '?'}`)}\n`);
    for (const line of renderSource(source, '  ')) process.stdout.write(`${grey(line)}\n`);
    process.stdout.write('\n');
  }
  return 0;
}

/** Threads, grouped by what they are doing. */
async function debugThreadsCommand(): Promise<number> {
  const record = await loadSession();
  if (!record?.currentStop) {
    if (record) process.stderr.write('the session has no captured stop\n');
    return 1;
  }

  const report = analyseConcurrency(record.currentStop, {
    adapter: record.adapterType ? adapterById(record.adapterType) : undefined,
  });

  if (flag('format') === 'json') {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(`${bold('Threads')}\n\n`);
  for (const line of renderConcurrency(report)) process.stdout.write(`${line}\n`);
  return 0;
}

/** Memory, read every plausible way rather than as bare hex. */
async function debugMemoryCommand(): Promise<number> {
  const record = await loadSession();
  if (!record) return 1;

  const dumps = record.currentStop?.memory ?? [];
  if (dumps.length === 0) {
    process.stderr.write(
      `${explainNoMemory(record.adapterType, record.capabilities?.supportsReadMemory)}\n`);
    return 1;
  }

  for (const dump of dumps) {
    const decoded = decodeMemory(dump, {
      endianness: flag('endian') === 'big' ? 'big' : 'little',
      pointerSize: numberFlag('pointer-size', 8) === 4 ? 4 : 8,
    });
    for (const line of renderDecodedMemory(decoded)) process.stdout.write(`${line}\n`);

    if (boolFlag('hex')) {
      process.stdout.write('\n');
      for (const line of dump.hex.split('\n')) process.stdout.write(grey(`  ${line}\n`));
    }
    process.stdout.write('\n');
  }
  return 0;
}

/**
 * Search across every captured stop.
 *
 * The journal is preferred over the live record whenever one exists, because the record is a
 * bounded ring and a search that silently only covered the last twenty stops would answer a
 * different question than the one asked.
 */
async function debugFindCommand(): Promise<number> {
  const query = {
    name: args.positionals[1] ?? flag('name'),
    value: flag('value'),
    type: flag('type'),
    kind: flag('kind') as never,
    scope: flag('scope'),
    frame: flag('frame'),
    fromStop: args.flags.has('from') ? numberFlag('from', 1) : undefined,
    toStop: args.flags.has('to') ? numberFlag('to', 0) : undefined,
    limit: numberFlag('limit', 50),
  };

  if (!query.name && !query.value && !query.type && !query.kind) {
    process.stderr.write(
      'usage: auspex debug find <name> [--value V] [--type T] [--kind empty|error|collection|…]\n\n' +
      'Searches every captured stop, not just the current one.\n' +
      'Examples:\n' +
      '  auspex debug find retries              every stop where a variable named retries existed\n' +
      '  auspex debug find --kind empty         every null, in any language\'s spelling\n' +
      '  auspex debug find --value "timeout"    every value mentioning a timeout\n');
    return 1;
  }

  const session = flag('session');
  const record = await readSession(session);
  const path = flag('journal') ?? journalPath(session ?? record?.sessionId ?? 'proxy');
  const hasJournal = (await summarizeJournal(path).catch(() => undefined))?.bytes;

  const result = hasJournal
    ? await queryJournal(path, query)
    : record ? queryRecord(record, query) : undefined;

  if (!result) {
    process.stderr.write('no captured debug session\n');
    return 1;
  }

  if (flag('format') === 'json') {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  for (const line of renderMatches(result)) process.stdout.write(`${line}\n`);
  return result.matches.length > 0 ? 0 : 1;
}

/** One variable's history through the whole session. */
async function debugTraceCommand(): Promise<number> {
  const path = args.positionals[1];
  if (!path) {
    process.stderr.write(
      'usage: auspex debug trace <variable[.field]>\n\n' +
      'Shows every value a variable held across the session, and where it changed.\n' +
      'Example: auspex debug trace retries\n');
    return 1;
  }

  const session = flag('session');
  const record = await readSession(session);
  const journal = flag('journal') ?? journalPath(session ?? record?.sessionId ?? 'proxy');
  const hasJournal = (await summarizeJournal(journal).catch(() => undefined))?.bytes;

  const history = hasJournal
    ? await trajectoryFromJournal(journal, path)
    : record
      ? trajectory([...record.stops, ...(record.currentStop ? [record.currentStop] : [])], path)
      : undefined;

  if (!history) {
    process.stderr.write('no captured debug session\n');
    return 1;
  }

  if (flag('format') === 'json') {
    process.stdout.write(`${JSON.stringify(history, null, 2)}\n`);
    return 0;
  }

  for (const line of renderTrajectory(history)) process.stdout.write(`${line}\n`);
  if (!hasJournal) {
    process.stdout.write(grey(
      '\nRead from the live record, which keeps only recent stops. Run the proxy with --journal\n' +
      'to trace a whole session.\n'));
  }
  return 0;
}

/** What the values actually are, beyond the debugger's own formatting. */
async function debugValuesCommand(): Promise<number> {
  const record = await loadSession();
  const stop = record?.currentStop;
  if (!stop) {
    if (record) process.stderr.write('the session has no captured stop\n');
    return 1;
  }

  const frameId = args.flags.has('frame-id')
    ? numberFlag('frame-id', 0)
    : Number(Object.keys(stop.frames)[0]);

  for (const scope of stop.frames[frameId] ?? []) {
    process.stdout.write(`${bold(scope.name)}${scope.skipped ? grey(` — ${scope.skipped}`) : ''}\n`);

    // Registers get their own treatment. Interpreting them as ordinary values would produce a wall
    // of hexadecimal scalars; what a reader wants is which one is the instruction pointer, which is
    // the stack, and whether any of them is a small negative number wearing a 64-bit mask.
    if (/^registers?$/i.test(scope.name) || scope.presentationHint === 'registers') {
      for (const register of decodeRegisters(scope.variables, numberFlag('pointer-size', 8) === 4 ? 4 : 8)) {
        process.stdout.write(
          `  ${pad(register.name, 10)} ${pad(register.value, 22)}` +
          `${register.looksLikePointer ? paint(' ptr', 'cyan') : '    '} ` +
          `${grey(pad(register.signed ?? '', 22))}${grey(register.role ?? '')}\n`);
      }
      process.stdout.write('\n');
      continue;
    }

    const interpreted = interpretTree(scope.variables);
    for (const variable of scope.variables) {
      const info = interpreted.get(variable.name)!;
      process.stdout.write(
        `  ${pad(variable.name, 24)} ${paint(pad(info.kind, 11), 'cyan')} ` +
        `${grey(info.confidence.padEnd(8))} ${truncate(variable.value, 60)}\n`);
      process.stdout.write(grey(`  ${' '.repeat(24)} ${info.because ?? ''}\n`));

      const declared = variable.indexedVariables ?? info.size ?? 0;
      if ((info.kind === 'collection' || info.kind === 'map') && declared > 6) {
        process.stdout.write(
          `  ${' '.repeat(24)} ${paint(renderCollectionSummary(summarizeCollection(variable, declared)), 'green')}\n`);
      }
      if (!variable.type && variable.children && variable.children.length > 1) {
        process.stdout.write(`  ${' '.repeat(24)} ${grey(`shape ${inferShape(variable).shape}`)}\n`);
      }
    }
    process.stdout.write('\n');
  }
  return 0;
}

/** Writes a portable bundle. */
async function debugBundleCommand(): Promise<number> {
  const record = await loadSession();
  if (!record) return 1;

  const target = args.positionals[1] ?? flag('out') ?? `auspex-debug-${record.sessionId}.json.gz`;

  const bundle = await createBundle(record, {
    note: flag('note'),
    redactor: redactor(),
    includeTimeline: boolFlag('timeline'),
    includeMemory: boolFlag('memory'),
  });
  const bytes = await writeBundle(target, bundle);

  process.stdout.write(`${bold('Bundle written')} ${target} ${grey(`(${(bytes / 1024).toFixed(1)}KB)`)}\n\n`);
  // Said every time, deliberately. A bundle is meant to be shared, and the moment of writing it is
  // the moment the person still has the chance to read it first.
  process.stdout.write(paint(bundle.warning, 'yellow'));
  process.stdout.write('\n\nRead it with `auspex debug open ' + target + '`.\n');
  return 0;
}

/** Reads a bundle someone sent you. */
async function debugOpenCommand(): Promise<number> {
  const path = args.positionals[1];
  if (!path) {
    process.stderr.write('usage: auspex debug open <bundle.json.gz>\n');
    return 1;
  }

  let bundle;
  try {
    bundle = await readBundle(path);
  } catch (error) {
    process.stderr.write(`could not read ${path}: ${error instanceof Error ? error.message : error}\n`);
    return 1;
  }

  if (flag('format') === 'json') {
    process.stdout.write(`${JSON.stringify(bundle, null, 2)}\n`);
    return 0;
  }
  if (boolFlag('report')) {
    process.stdout.write(`${debugReport(bundle.record, { sources: bundle.sources, analysis: bundle.analysis })}\n`);
    return 0;
  }

  // The embedded summary by default: it is what makes a bundle readable by someone who has the
  // file and nothing else, and re-rendering would quietly discard that property.
  process.stdout.write(`${bundle.summary}\n`);
  return 0;
}

/** Compares two bundles — the working run against the failing one. */
async function debugCompareCommand(): Promise<number> {
  const [, first, second] = args.positionals;
  if (!first || !second) {
    process.stderr.write('usage: auspex debug compare <bundle-a> <bundle-b>\n');
    return 1;
  }

  const [a, b] = await Promise.all([readBundle(first), readBundle(second)]);
  const comparison = compareBundles(a, b);

  process.stdout.write(`${bold(comparison.summary)}\n\n`);

  if (comparison.stackDifferences.length > 0) {
    process.stdout.write(`${bold('Stack')}\n`);
    for (const line of comparison.stackDifferences.slice(0, 20)) {
      process.stdout.write(`  ${line.startsWith('only in A') ? paint('A', 'cyan') : paint('B', 'magenta')} ${line}\n`);
    }
    process.stdout.write('\n');
  }

  if (comparison.valueDifferences.length === 0) {
    process.stdout.write(grey('every captured value is identical\n'));
    return 0;
  }

  process.stdout.write(`${bold('Values')}\n`);
  for (const difference of comparison.valueDifferences.slice(0, 40)) {
    process.stdout.write(
      `  ${pad(difference.path, 36)} ${paint(truncate(difference.a ?? '(absent)', 28), 'cyan')} ` +
      `${grey('→')} ${paint(truncate(difference.b ?? '(absent)', 28), 'magenta')}\n`);
  }
  if (comparison.valueDifferences.length > 40) {
    process.stdout.write(grey(`  … ${comparison.valueDifferences.length - 40} more\n`));
  }
  return 0;
}

/** Wraps prose to a width, for explanation blocks. */
function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    if (current.length + word.length + 1 > width) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** Prints the configuration a user pastes into their assistant. */
async function commandConnect(): Promise<number> {
  const target = args.positionals[0] ?? 'mcp';
  const entryPoint = fileURLToPath(import.meta.url);

  // The debug tools on their own, for an agent whose job is debugging rather than reading a
  // codebase. Carrying nine tool definitions an agent will never call costs it attention on every
  // request, which is the argument for keeping the two sets separable.
  if (target === 'debug') {
    const provider = args.positionals[1] ?? 'openai';
    const tools = provider === 'gemini' ? geminiDebugTools()
      : provider === 'anthropic' || provider === 'claude' ? anthropicDebugTools()
      : openAiDebugTools();

    process.stdout.write(`${JSON.stringify(tools, null, 2)}
`);
    process.stderr.write(grey(
      `\n${tools.length} debug tool(s) for ${provider}.` +
      ` They read a session published by \`auspex proxy --dap --deep\`;\n` +
      ` serve it with \`auspex serve\` so their HTTP routes are reachable.\n`));
    return 0;
  }

  if (target === 'mcp' || target === 'claude') {
    process.stdout.write(`${bold('MCP server configuration')}\n`);
    process.stdout.write(grey('Add this to your assistant\'s MCP config (Claude Desktop: claude_desktop_config.json;\n'));
    process.stdout.write(grey('Claude Code: .mcp.json in the project, or `claude mcp add`).\n\n'));
    process.stdout.write(`${mcpClientConfig(entryPoint)}\n`);
    return 0;
  }
  if (target === 'openai' || target === 'gpt' || target === 'gemini') {
    const base = flag('url', 'http://127.0.0.1:4278')!;
    process.stdout.write(`${bold(`${target} tool definitions`)}\n`);
    process.stdout.write(grey(`Start the server first: auspex serve\nThen register these tools against ${base}.\n\n`));
    process.stdout.write(`${JSON.stringify(openAiToolDefinitions(base), null, 2)}\n`);
    return 0;
  }
  process.stderr.write(`unknown target '${target}'. Try: mcp, openai, gemini\n`);
  return 1;
}

/**
 * Diagnoses why a capture came back thin.
 *
 * This is the command that makes the tool honest about itself. "Nothing found" has half a dozen
 * causes — no editor running, an editor with no adapter, an adapter that found the directory but
 * could not read it, no language server for diagnostics — and each has a different fix. Printing
 * which of them applies is far more useful than an empty snapshot.
 */
async function commandDoctor(): Promise<number> {
  process.stdout.write(`${bold('auspex doctor')}\n\n`);

  const adapters = await defaultAdapters();
  const snapshot = await capture(adapters, { ...captureOptions(), includeTree: false }, redactor());

  process.stdout.write(`${bold('Adapters')}\n`);
  for (const report of snapshot.provenance) {
    const mark = report.status === 'ok' ? paint('✓', 'green')
      : report.status === 'error' ? paint('✗', 'red')
      : grey('·');
    process.stdout.write(`  ${mark} ${report.adapter.padEnd(16)} ${grey(report.detail ?? report.reason ?? '')}\n`);
  }

  process.stdout.write(`\n${bold('Findings')}\n`);
  const notes: string[] = [];

  if (snapshot.editors.length === 0) {
    notes.push('No editor was detected. Is one running? Process discovery needs permission to list processes.');
  }
  if (snapshot.documents.length === 0) {
    notes.push('No open documents. Most editors only write their session to disk periodically; ' +
      'install the plugin in extensions/ for live open files, cursors and unsaved buffers.');
  }
  if ((await listSessions()).length === 0) {
    notes.push('No debug session captured. To have the paused program\'s threads, stacks, ' +
      'variables and memory available, run `auspex proxy --dap --deep -- <debug adapter>` and ' +
      'point your editor\'s launch configuration at that instead of at the adapter.');
  }
  if (snapshot.diagnostics.length === 0) {
    notes.push('No diagnostics. These come from a language server or an editor plugin — run ' +
      '`auspex proxy --lsp -- <your server>` to capture them.');
  }
  if (!snapshot.workspaces.some((workspace) => workspace.vcs)) {
    notes.push('No version control detected in any workspace. Is git installed and on PATH?');
  }
  const slow = snapshot.provenance.filter((report) => report.durationMs > 3000);
  if (slow.length > 0) {
    notes.push(`Slow adapters: ${slow.map((r) => `${r.adapter} (${r.durationMs}ms)`).join(', ')}. ` +
      'Reduce --max-files or --depth, or exclude them with --exclude.');
  }
  if (notes.length === 0) {
    notes.push('Everything that can report is reporting.');
  }
  for (const note of notes) {
    process.stdout.write(`  ${grey('•')} ${note}\n`);
  }

  process.stdout.write(`\n${bold('Summary')}\n  ${summarize(snapshot)}\n`);
  return 0;
}

// -- Support ------------------------------------------------------------------------------------

/** Resolves on Ctrl-C or SIGTERM, so long-running servers exit cleanly. */
function waitForSignal(): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => resolve();
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
  });
}

function printUsage(): void {
  process.stdout.write(`${bold('auspex')} — read any editor's context, serve it to any AI

${bold('Reading')}
  auspex capture [--format text|json|markdown|claude|openai|gemini] [--out FILE]
                 [--root DIR] [--diff] [--text] [--depth N] [--max-tokens N]
  auspex watch [--interval SECONDS]        live terminal interface
  auspex editors [--verbose]               what is running and what each adapter can do
  auspex file <path> [--outline]           read a file, or outline it (any language)
  auspex git [dir] [--diff] [--json]       version-control state
  auspex doctor                            why is my capture thin?

${bold('Serving')}
  auspex mcp                               Model Context Protocol on stdio (Claude, and any MCP client)
  auspex serve [--port N] [--host ADDR]    HTTP + SSE + OpenAPI, for GPT/Gemini and plugins
  auspex gui [--port N] [--no-open]        the same server, plus a browser dashboard

${bold('Capturing from protocols')}
  auspex proxy --lsp -- <language server>  transparent LSP proxy; captures real diagnostics
  auspex proxy --dap -- <debug adapter>    transparent DAP proxy; captures the live call stack
  auspex proxy --dap --deep -- <adapter>   deep capture: stacks, scopes, every variable, memory
  auspex debug                             print the captured debug session
  auspex debug list                        list captured sessions
  auspex debug report [--max-tokens N]     a markdown briefing written for an AI to read
  auspex debug analyze                     observations about the stop, each with its evidence
  auspex debug source                      the source around every captured frame
  auspex debug wire [path]                 how to put Auspex into this project's debug session
  auspex debug history [--replay]          earlier stops, out of the session journal
  auspex debug size                        where a record's context size is going
  auspex debug tools [openai|gemini|claude]  tool definitions for non-MCP assistants
  auspex debug threads                     threads grouped by what each is doing
  auspex debug values                      what the values are, beyond the debugger's formatting
  auspex debug memory [--hex]              memory read every plausible way, not just hex
  auspex debug find <name>                 search every captured stop, not just the current one
  auspex debug trace <variable>            one variable's whole history through the session
  auspex debug bundle [file]               write a portable session, for a bug report
  auspex debug open <file>                 read a bundle someone sent you
  auspex debug compare <a> <b>             what differs between two bundles
      --journal                            keep a durable, append-only record of the whole session
      --forward URL                        publish what it sees to a running \`auspex serve\`

${bold('Connecting an assistant')}
  auspex connect mcp                       config to paste into Claude Desktop or Claude Code
  auspex connect openai|gemini [--url U]   tool definitions for function calling
  auspex connect debug [openai|gemini|claude]  the debug tools alone, for an agent that debugs

${bold('Everywhere')}
  --no-redact     disable secret redaction (prints a warning; think first)
  --only a,b      run only these adapters        --exclude a,b   skip these
  --no-tree       skip file trees                --no-git        skip version control
  --verbose       more detail

Redaction is on by default. Nothing is sent anywhere by Auspex itself: it serves, your
assistant reads.
`);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`${paint('error:', 'red')} ${error instanceof Error ? error.message : error}\n`);
    if (boolFlag('verbose') && error instanceof Error && error.stack) {
      process.stderr.write(grey(`${error.stack}\n`));
    }
    process.exitCode = 1;
  });
