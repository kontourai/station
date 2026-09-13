// Blind, bounded UDP capture for test-owned TURN traffic. No endpoint keys.
import { createSocket } from 'node:dgram';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const targetPort = Number(process.argv[2]);
const directory = process.argv[3];
if (
  !Number.isInteger(targetPort) ||
  targetPort < 1 ||
  targetPort > 65535 ||
  [3000, 3141].includes(targetPort) ||
  !directory ||
  process.argv[4] !== 'forward'
)
  throw new Error('Invalid local UDP relay configuration');
const path = join(directory, 'traffic.bin');
writeFileSync(path, Buffer.alloc(0), { mode: 0o600, flag: 'wx' });
const server = createSocket('udp4');
const clients = new Map();
let captured = 0;
let closing = false;
function close() {
  if (closing) return;
  closing = true;
  clearTimeout(lifetime);
  for (const socket of clients.values()) socket.close();
  server.close();
}
function fail(reason) {
  writeFileSync(join(directory, 'failed.json'), JSON.stringify({ reason }), {
    mode: 0o600,
  });
  process.exitCode = 1;
  close();
}
function capture(bytes) {
  captured += bytes.length;
  if (captured > 1024 * 1024) {
    fail('capture_overflow');
    return false;
  }
  appendFileSync(path, bytes);
  return true;
}
server.on('message', (bytes, source) => {
  if (closing || source.address !== '127.0.0.1' || !capture(bytes)) return;
  let socket = clients.get(source.port);
  if (!socket) {
    if (clients.size >= 16) {
      fail('client_limit');
      return;
    }
    socket = createSocket('udp4');
    clients.set(source.port, socket);
    socket.on('error', () => fail('upstream_error'));
    socket.on('message', (reply, sender) => {
      if (
        closing ||
        sender.address !== '127.0.0.1' ||
        sender.port !== targetPort ||
        !capture(reply)
      )
        return;
      server.send(reply, source.port, source.address);
    });
  }
  socket.send(bytes, targetPort, '127.0.0.1');
});
server.on('error', () => fail('listener_error'));
const lifetime = setTimeout(() => fail('lifetime_exceeded'), 120000);
process.once('SIGINT', close);
process.once('SIGTERM', close);
server.bind(0, '127.0.0.1', () => {
  writeFileSync(
    join(directory, 'ready.json'),
    JSON.stringify({ port: server.address().port }),
    { mode: 0o600, flag: 'wx' },
  );
});
