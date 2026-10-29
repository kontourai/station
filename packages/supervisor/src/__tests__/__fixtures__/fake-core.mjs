// @ts-check
/**
 * A stand-in core server generation that speaks the supervisor IPC protocol.
 * Every message it sends is typed against `protocol.ts` (the package
 * typecheck covers this file), so it uses the shapes the real core must send.
 *
 * Serves `GET /boot` (JSON identity, and how many connections it adopted) and `GET /events` (SSE whose first event
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
 *   FAKE_CORE_BLOCK_THEN_DIE_MS=<n> after reporting listener.listening, block the event loop
 *                                   for n ms (acknowledging no handle), then SIGKILL itself
 *   FAKE_CORE_PROTOCOL_1_0=1        speak protocol 1.0: no connection catching (parks without
 *                                   adoptsConnections, ignores listener.spares, closes an adopted
 *                                   connection as a stray handle)
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

const protocol10 = process.env.FAKE_CORE_PROTOCOL_1_0 === '1';
let draining = false;
let lastAcceptAt = 0;
let sparesSent = 0;
let adoptedConnections = 0;
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
        inheritedForceCatching:
          process.env.STATION_SUPERVISOR_TEST_FORCE_CATCHING ?? null,
        adoptedConnections,
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

// Every connection, including those the supervisor passes in with
// `connection.adopt`: net.Server counts only the ones it accepted itself, so
// its close callback alone would let this generation exit under them.
/** @type {Set<net.Socket>} */
const sockets = new Set();
server.on('connection', (/** @type {net.Socket} */ socket) => {
  lastAcceptAt = Date.now();
  sockets.add(socket);
  socket.once('close', () => {
    sockets.delete(socket);
    exitIfDrained();
  });
});

function reportListening() {
  if (!protocol10) send({ type: 'listener.listening', name: 'api' });
  const blockMs = Number(process.env.FAKE_CORE_BLOCK_THEN_DIE_MS ?? 0);
  if (blockMs > 0) {
    // Let the message go out, then hold the loop: handles the supervisor
    // sends meanwhile are never acknowledged.
    setTimeout(() => {
      const until = Date.now() + blockMs;
      while (Date.now() < until) {
        // Blocked.
      }
      process.kill(process.pid, 'SIGKILL');
    }, 0);
  }
}

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
/** As the real core: after sending spares, close the listener once nothing has reached it for this long. */
const DRAIN_QUIET_CLOSE_MS = 50;
const DRAIN_QUIET_CAP_MS = 1_000;

let voiceSessions = 0;
let listenerClosed = false;

function drain() {
  if (draining) return;
  draining = true;
  voiceSessions = Number(process.env.FAKE_CORE_VOICE_SESSIONS ?? 0);
  send({ type: 'drain.progress', voiceSessions });
  for (const stream of streams) stream.end();
  const started = Date.now();
  const closeWhenQuiet = () => {
    const now = Date.now();
    const quietFor = now - lastAcceptAt;
    if (
      sparesSent > 0 &&
      quietFor < DRAIN_QUIET_CLOSE_MS &&
      now - started < DRAIN_QUIET_CAP_MS
    ) {
      setTimeout(closeWhenQuiet, DRAIN_QUIET_CLOSE_MS - quietFor);
      return;
    }
    // Stop accepting on this generation's copy of the listener. The
    // supervisor still holds the socket, so new connections wait in the
    // kernel backlog. net.Server's close, not http.Server's: the latter also
    // closes idle connections immediately (Node 19+), the race described above.
    net.Server.prototype.close.call(server, () => {
      listenerClosed = true;
      exitIfDrained();
    });
    setTimeout(() => server.closeIdleConnections(), DRAIN_IDLE_GRACE_MS);
  };
  closeWhenQuiet();
}

function exitIfDrained() {
  if (!listenerClosed || sockets.size > 0) return;
  if (voiceSessions > 0) return; // A live call keeps this generation until the supervisor's cap.
  send({ type: 'drained' });
  // Let the IPC message flush before exiting.
  setImmediate(() => process.exit(0));
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
          server.listen(/** @type {any} */ (handle), reportListening);
          return;
        }
        if (process.env.FAKE_CORE_NO_ADOPT === '1') {
          server.listen(port, host, reportReady);
          return;
        }
        server.listen(/** @type {any} */ (handle), () => {
          reportListening();
          reportReady();
        });
        return;
      }
      case 'listener.spares':
        // Protocol 1.1: copies of the listening handle for the supervisor.
        if (protocol10) return;
        if (message.name !== 'api' || !server.listening || draining) return;
        for (let i = 0; i < message.count; i += 1) {
          sparesSent += 1;
          send(
            { type: 'listener.spare', name: 'api' },
            /** @type {any} */ (server)._handle,
          );
        }
        return;
      case 'connection.adopt':
        // A connection the supervisor held during a handoff.
        if (!(handle instanceof net.Socket)) return;
        if (protocol10) {
          // A 1.0 core closes a handle sent with a message it does not know.
          handle.destroy();
          return;
        }
        adoptedConnections += 1;
        server.emit('connection', handle);
        handle.resume();
        return;
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

send(
  protocol10 ? { type: 'parked' } : { type: 'parked', adoptsConnections: true },
);
