#!/usr/bin/env node
/**
 * A minimal debug adapter, as a real process on real pipes.
 *
 * Exists so the deep proxy can be tested against something that behaves like a debug adapter --
 * `Content-Length` framing over stdio, responses correlated by `request_seq`, an unsolicited
 * `stopped` event -- rather than against an in-process double. Every framing test in this project
 * passed while `auspex proxy` hung forever on a real server, which is the precedent for insisting
 * on this.
 */
let buffer = Buffer.alloc(0);
let seq = 0;

// Optional overrides, so the same adapter can drive both the plumbing test (which wants a fixed,
// fictional stack) and an end-to-end test that needs a frame pointing at a file that really exists.
const SOURCE = process.env.AUSPEX_FAKE_SOURCE || '/app/main.js';
const LINE = Number(process.env.AUSPEX_FAKE_LINE || 3);
const FAIL = process.env.AUSPEX_FAKE_EXCEPTION;

function send(message) {
  const body = Buffer.from(JSON.stringify({ seq: ++seq, ...message }), 'utf8');
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function respond(request, body) {
  send({ type: 'response', request_seq: request.seq, success: true, command: request.command, body });
}

function handle(request) {
  switch (request.command) {
    case 'initialize':
      respond(request, { supportsExceptionInfoRequest: true, supportsModulesRequest: true });
      send({ type: 'event', event: 'initialized', body: {} });
      break;
    case 'launch':
      respond(request, {});
      // Stop almost immediately, the way a breakpoint on the first line does.
      setTimeout(() => send({
        type: 'event', event: 'stopped',
        body: {
          reason: FAIL ? 'exception' : 'breakpoint',
          threadId: 1, allThreadsStopped: true,
          ...(FAIL ? { text: FAIL } : {}),
        },
      }), 20);
      break;
    case 'threads':
      respond(request, { threads: [{ id: 1, name: 'main' }] });
      break;
    case 'stackTrace':
      respond(request, {
        stackFrames: [{ id: 7, name: 'main', line: LINE, source: { path: SOURCE } }],
        totalFrames: 1,
      });
      break;
    case 'scopes':
      respond(request, { scopes: [{ name: 'Locals', variablesReference: 42 }] });
      break;
    case 'variables':
      respond(request, {
        variables: Number(request.arguments.variablesReference) === 42
          ? (FAIL
            ? [
              { name: 'user', value: 'None', type: 'NoneType', variablesReference: 0 },
              { name: 'attempts', value: '3', type: 'int', variablesReference: 0 },
            ]
            : [{ name: 'answer', value: '42', type: 'number', variablesReference: 0 }])
          : [],
      });
      break;
    case 'exceptionInfo':
      respond(request, {
        exceptionId: FAIL || 'Error',
        breakMode: 'unhandled',
        details: { typeName: FAIL || 'Error', message: 'user was not found' },
      });
      break;
    case 'modules':
      respond(request, { modules: [] });
      break;
    case 'disconnect':
      respond(request, {});
      process.exit(0);
      break;
    default:
      respond(request, {});
  }
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString('ascii'))[1]);
    const start = headerEnd + 4;
    if (buffer.length < start + length) return;
    const message = JSON.parse(buffer.subarray(start, start + length).toString('utf8'));
    buffer = buffer.subarray(start + length);
    if (message.type === 'request') handle(message);
  }
});
