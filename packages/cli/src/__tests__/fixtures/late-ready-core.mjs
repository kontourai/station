import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';

const generation = Number(process.env.STATION_SUPERVISOR_GENERATION);
const port = Number(process.env.PORT);
const launchBootId = process.env.STATION_BOOT_ID;
const tracePath = process.env.FIXTURE_LATE_READY_TRACE;
const first = generation === 1;

function record(event) {
  appendFileSync(tracePath, `${JSON.stringify({ event, generation })}\n`);
}

const voice = createTcpServer((socket) => socket.end());
const api = createHttpServer((request, response) => {
  response.setHeader('Connection', 'close');
  response.setHeader('Content-Type', 'application/json');
  if (
    request.method === 'POST' &&
    request.url === '/fixture/release' &&
    first
  ) {
    response.end('{}', stop);
    return;
  }
  if (request.url === '/api/system/identity') {
    if (
      request.headers['x-station-internal-token'] !==
      process.env.STATION_INTERNAL_API_TOKEN
    ) {
      response.writeHead(403).end('{}');
      return;
    }
    record('identity');
    response.end(
      JSON.stringify({
        instanceId: process.env.STATION_INSTANCE_ID,
        bootId: launchBootId,
        sha: process.env.STATION_BUILD_SHA,
      }),
    );
    return;
  }
  if (request.url === '/api/system/liveness') {
    response.end(JSON.stringify({ generation }));
    return;
  }
  response.writeHead(404).end('{}');
});

function listen(server, listenerPort) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenerPort, '127.0.0.1', resolve);
  });
}

async function ready() {
  await Promise.all([listen(api, port), listen(voice, port + 2)]);
  record('ready');
  process.send({ type: 'ready', bootId: randomUUID(), port });
}

function stop() {
  api.closeAllConnections();
  voice.close();
  api.close(() => process.exit(0));
}

process.on('message', (message) => {
  if (message.type === 'promote' && !first) void ready();
  if (message.type === 'drain') {
    record('drain');
    if (first && !api.listening) void ready();
    else stop();
  }
});
process.on('disconnect', () => process.exit(0));
process.send({ type: 'parked' });
