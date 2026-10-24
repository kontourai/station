import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { restrictAccountLabTcp } from './local-collaboration-network.mjs';

const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
assert(Array.isArray(input.ports) && input.ports.length === 5);
assert(
  input.ports.every(
    (port) => Number.isInteger(port) && port > 1024 && port < 65536,
  ),
);
assert(
  Number.isInteger(input.deniedPort) && !input.ports.includes(input.deniedPort),
);
restrictAccountLabTcp(input.ports);
const allowed = await fetch(`http://127.0.0.1:${input.ports[4]}/`, {
  signal: AbortSignal.timeout(5000),
});
await allowed.body?.cancel();
await assert.rejects(
  fetch(`http://127.0.0.1:${input.deniedPort}/`, {
    signal: AbortSignal.timeout(5000),
  }),
  (error) => error?.cause?.code === 'ACCOUNT_LAB_TCP_REFUSED',
);
const lifetime = setTimeout(
  () => process.kill(process.pid, 'SIGTERM'),
  300_000,
);
lifetime.unref();
await import('../../src-server/index.ts');
