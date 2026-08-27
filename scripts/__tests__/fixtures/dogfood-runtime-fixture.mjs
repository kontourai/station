import { appendFileSync } from 'node:fs';
import http from 'node:http';
import { WebSocketServer } from 'ws';

const journal = process.env.STATION_LIFECYCLE_JOURNAL;
const sha = process.env.STATION_BUILD_SHA;
const instanceId = process.env.STATION_INSTANCE_ID ?? 'phone';
const bootId = process.env.STATION_BOOT_ID;
const serverPort = Number(process.env.PORT);

function append(event) {
  if (!journal) return;
  appendFileSync(
    journal,
    `${JSON.stringify({
      version: 1,
      eventId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      sender: 'unknown',
      instanceId,
      sha,
      bootId,
      pid: process.pid,
      ...event,
    })}\n`,
  );
}

const current = { instanceId, sha, bootId, pid: process.pid };
const api = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/api/system/identity') {
    res.end(JSON.stringify({ instanceId, sha, bootId }));
    return;
  }
  res.end(JSON.stringify({ data: { build: { ...current, fullSha: sha } } }));
});
const terminal = new WebSocketServer({
  port: serverPort + 1,
  host: '127.0.0.1',
});
const voice = new WebSocketServer({
  port: serverPort + 2,
  host: '127.0.0.1',
});
for (const server of [terminal, voice]) {
  server.on('connection', (socket, request) => {
    if (request.url === '/__station/health') socket.close(1000, 'healthy');
  });
}
api.listen(serverPort, '127.0.0.1');
// station#3677: the consent listener occupies serverPort + 3; health asserts
// its ownership like every other listener in the block.
const consent = http.createServer((_req, res) => {
  res.statusCode = 404;
  res.end('consent');
});
consent.listen(serverPort + 3, '127.0.0.1');

const shutdown = (signal) => {
  append({ type: 'shutdown_observed', reason: signal });
  append({ type: 'process_exit', exitCode: 0, signal: null });
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
