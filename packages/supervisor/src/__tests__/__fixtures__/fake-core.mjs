// @ts-check
/**
 * A stand-in core server generation that speaks the supervisor IPC protocol.
 * Every message it sends is typed against `protocol.ts` (the package
 * typecheck covers this file), so it uses the shapes the real core must send.
 *
 * Serves `GET /boot` (JSON identity) and `GET /events` (SSE whose first event
 * carries this generation's bootId).
 *
 * Environment:
 *   FAKE_CORE_PORT                  port the first generation binds (required)
 *   FAKE_CORE_NEVER_READY=1         park and accept promote, but never listen or report ready
 *   FAKE_CORE_SERVE_WITHOUT_READY=1 adopt and serve the held listener, but never report ready
 *   FAKE_CORE_EXIT_AFTER_PROMOTE=1  exit(1) on promote
 *   FAKE_CORE_NO_ADOPT=1            ignore adopted handles and bind FAKE_CORE_PORT itself
 *   FAKE_CORE_VOICE_SESSIONS=<n>    report n live voice sessions while draining (never ends them)
 *   FAKE_CORE_EXIT_ON_BOOT=1        exit(1) before parking
 *   FAKE_CORE_REQUEST_HANDOFF=1     generation 1 sends handoff.request once ready
 *   FAKE_CORE_SEND_SERVER=1         send the net.Server itself with listener.bound (a protocol violation)
 *   FAKE_CORE_EXIT_AFTER_READY=1    exit(1) in the same tick as reporting ready
 *   FAKE_CORE_IGNORE_DISCONNECT=1   keep running when the supervisor's IPC channel closes (a protocol violation)
 *   FAKE_CORE_CHILD_PID_FILE=<path> start a long-running child process and write its pid there
 *
 * @import { CoreToSupervisorMessage, SupervisorToCoreMessage } from '../../protocol.ts'
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { SUPERVISOR_ENV } from '../../protocol.ts';

const bootId = randomUUID();
const host = '127.0.0.1';
const port = Number(process.env.FAKE_CORE_PORT);
const generation = Number(process.env[SUPERVISOR_ENV.generation] ?? 0);

if (
  process.env[SUPERVISOR_ENV.ipc] !== '1' ||
  typeof process.send !== 'function'
) {
  process.stderr.write(
    'fake-core: must run under the supervisor IPC channel\n',
  );
  process.exit(3);
}
if (process.env.FAKE_CORE_EXIT_ON_BOOT === '1') process.exit(1);

// A helper process of the core's own, as a real core starts engines.
if (process.env.FAKE_CORE_CHILD_PID_FILE) {
  const helper = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    {
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  if (helper.pid)
    writeFileSync(process.env.FAKE_CORE_CHILD_PID_FILE, String(helper.pid));
}

/** @param {CoreToSupervisorMessage} message @param {unknown} [handle] */
function send(message, handle) {
  /** @type {any} */ (process).send(message, handle);
}

let draining = false;
/** @type {Set<http.ServerResponse>} */
const streams = new Set();

const server = http.createServer((req, res) => {
  // While draining, every response closes its connection so keep-alive
  // clients reconnect (and queue for the next generation) instead of reusing it.
  if (draining) res.setHeader('Connection', 'close');
  if (req.url === '/boot') {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        bootId,
        generation,
        pid: process.pid,
        entry: process.argv[1],
        inheritedBirth: process.env.STATION_SUPERVISOR_BIRTH ?? null,
      }),
    );
    return;
  }
  if (req.url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    });
    res.write(
      `event: boot\ndata: ${JSON.stringify({ bootId, generation })}\n\n`,
    );
    streams.add(res);
    res.on('close', () => streams.delete(res));
    if (draining) res.end();
    return;
  }
  res.statusCode = 404;
  res.end();
});

function reportReady() {
  const address = server.address();
  const boundPort =
    typeof address === 'object' && address ? address.port : port;
  send({ type: 'ready', bootId, port: boundPort });
  if (process.env.FAKE_CORE_EXIT_AFTER_READY === '1') process.exit(1);
  // Models the in-app update asking for a handoff once new code is on disk.
  if (process.env.FAKE_CORE_REQUEST_HANDOFF === '1' && generation === 1)
    requestHandoff();
}

let handoffAttempts = 0;
function requestHandoff() {
  handoffAttempts += 1;
  send({ type: 'handoff.request', requestId: `update-${handoffAttempts}` });
}

/** @type {string[]} */
let expected = [];
let promoted = false;

/**
 * Closing an idle keep-alive connection races a client that has already sent
 * its next request: the unread request makes the close a reset. So draining
 * first marks every response `Connection: close` (busy connections then close
 * themselves after their response) and only closes connections still idle
 * after this grace.
 */
const DRAIN_IDLE_GRACE_MS = 1_000;

function drain() {
  if (draining) return;
  draining = true;
  const voiceSessions = Number(process.env.FAKE_CORE_VOICE_SESSIONS ?? 0);
  send({ type: 'drain.progress', voiceSessions });
  // Stop accepting on this generation's copy of the listener. The supervisor
  // still holds the socket, so new connections wait in the kernel backlog.
  // net.Server's close, not http.Server's: the latter also closes idle
  // connections immediately (Node 19+), which is the race described above.
  net.Server.prototype.close.call(server, () => {
    if (voiceSessions > 0) return; // A live call keeps this generation until the supervisor's cap.
    send({ type: 'drained' });
    // Let the IPC message flush before exiting.
    setImmediate(() => process.exit(0));
  });
  for (const stream of streams) stream.end();
  setTimeout(() => server.closeIdleConnections(), DRAIN_IDLE_GRACE_MS);
}

process.on(
  'message',
  (/** @type {SupervisorToCoreMessage} */ message, handle) => {
    switch (message.type) {
      case 'promote':
        if (promoted) return;
        promoted = true;
        if (process.env.FAKE_CORE_EXIT_AFTER_PROMOTE === '1') process.exit(1);
        expected = [...message.listeners];
        if (expected.length === 0) {
          if (process.env.FAKE_CORE_NEVER_READY === '1') return;
          // First generation: bind normally and hand the raw handle to the supervisor.
          server.listen(port, host, () => {
            send(
              { type: 'listener.bound', name: 'api', port },
              process.env.FAKE_CORE_SEND_SERVER === '1'
                ? server
                : /** @type {any} */ (server)._handle,
            );
            reportReady();
          });
        }
        return;
      case 'listener.adopt': {
        if (message.name !== 'api' || !expected.includes('api')) return;
        // A real core only listens once boot is complete; a hung boot never does.
        if (process.env.FAKE_CORE_NEVER_READY === '1') return;
        if (process.env.FAKE_CORE_SERVE_WITHOUT_READY === '1') {
          // Serving clients already, as a real core does well before ready.
          server.listen(/** @type {any} */ (handle));
          return;
        }
        if (process.env.FAKE_CORE_NO_ADOPT === '1') {
          server.listen(port, host, reportReady);
          return;
        }
        server.listen(/** @type {any} */ (handle), reportReady);
        return;
      }
      case 'drain':
        drain();
        return;
      case 'handoff.refused':
        // The supervisor may still be committing this generation; ask again, boundedly.
        if (handoffAttempts < 50) setTimeout(requestHandoff, 100);
        return;
    }
  },
);

server.on('error', (error) => {
  process.stderr.write(`fake-core gen ${generation}: ${error.message}\n`);
  process.exit(1);
});
process.on('SIGTERM', () => process.exit(0));
process.on('disconnect', () => {
  if (process.env.FAKE_CORE_IGNORE_DISCONNECT !== '1') process.exit(0);
});

send({ type: 'parked' });
