// Test-only TCP transport. No Station modules, identity credentials or TLS keys
// enter this process. Same-user filesystem access is NOT a sandbox guarantee.
import { appendFileSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { join } from 'node:path';

const targetPort = Number(process.argv[2]);
const directory = process.argv[3];
const mode = process.argv[4];
if (
  !Number.isInteger(targetPort) ||
  targetPort < 1 ||
  targetPort > 65535 ||
  [3000, 3141].includes(targetPort) ||
  !directory ||
  !['forward', 'tamper'].includes(mode)
)
  throw new Error('Invalid local relay configuration');

const capturePath = join(directory, 'traffic.bin');
writeFileSync(capturePath, Buffer.alloc(0), { mode: 0o600, flag: 'wx' });
const sockets = new Set();
let captured = 0;
const server = createServer((incoming) => {
  const outgoing = connect({ host: '127.0.0.1', port: targetPort });
  let corrupted = false;
  for (const socket of [incoming, outgoing]) {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {
      incoming.destroy();
      outgoing.destroy();
    });
    socket.setTimeout(10000, () => socket.destroy());
    socket.on('data', (bytes) => {
      captured += bytes.length;
      if (captured > 1024 * 1024) {
        // Overflow is a failing process exit, never a truncated passing capture.
        fail('capture_overflow');
        return;
      }
      appendFileSync(capturePath, bytes);
    });
  }
  if (mode === 'tamper') {
    incoming.on('data', (bytes) => {
      const changed = Buffer.from(bytes);
      if (!corrupted) {
        changed[0] ^= 0xff;
        corrupted = true;
      }
      if (!outgoing.write(changed)) incoming.pause();
    });
    outgoing.on('drain', () => incoming.resume());
    incoming.on('end', () => outgoing.end());
  } else incoming.pipe(outgoing);
  outgoing.pipe(incoming);
});

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  clearTimeout(lifetime);
  for (const socket of sockets) socket.destroy();
  server.close();
}
const lifetime = setTimeout(() => {
  fail('lifetime_exceeded');
}, 120000);
function fail(reason) {
  writeFileSync(join(directory, 'failed.json'), JSON.stringify({ reason }), {
    mode: 0o600,
  });
  process.exitCode = 1;
  shutdown();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
server.on('error', () => fail('listener_error'));
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  writeFileSync(
    join(directory, 'ready.json'),
    JSON.stringify({ port: address.port }),
    { mode: 0o600, flag: 'wx' },
  );
});
