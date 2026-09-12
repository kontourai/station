import { createSocket, type Socket } from 'node:dgram';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  runLabCommand,
  startLabRelay,
} from '../lib/local-collaboration-process.mjs';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), 'station-browser-fixture-test-'));
  roots.push(root);
  return root;
}
async function bind(socket: Socket, port = 0) {
  socket.bind(port, '127.0.0.1');
  await once(socket, 'listening');
  return socket.address().port;
}
async function receive(socket: Socket) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 10000);
  try {
    const [bytes] = await once(socket, 'message', { signal: abort.signal });
    return bytes as Buffer;
  } finally {
    clearTimeout(timer);
  }
}

it('forwards binary UDP in both directions, captures it exactly, and releases only its listener', async () => {
  const root = temporaryRoot();
  const upstream = createSocket('udp4');
  const client = createSocket('udp4');
  const observed: Buffer[] = [];
  upstream.on('message', (bytes, source) => {
    observed.push(Buffer.from(bytes));
    upstream.send(Buffer.from(bytes).reverse(), source.port, source.address);
  });
  const target = await bind(upstream);
  await bind(client);
  let relay: Awaited<ReturnType<typeof startLabRelay>> | undefined;
  try {
    relay = await startLabRelay(target, root, 'forward', 'udp');
    const payload = Buffer.from(
      Array.from({ length: 2048 }, (_, i) => i % 256),
    );
    const expected = Buffer.from(payload).reverse();
    const returned = receive(client);
    client.send(payload, relay.port, '127.0.0.1');
    expect(await returned).toEqual(expected);
    expect(observed).toEqual([payload]);
    await relay.close();
    expect(readFileSync(relay.capturePath)).toEqual(
      Buffer.concat([payload, expected]),
    );
    const probe = createSocket('udp4');
    try {
      expect(await bind(probe, relay.port)).toBe(relay.port);
    } finally {
      probe.close();
    }
    const direct = receive(client);
    client.send(payload, target, '127.0.0.1');
    expect(await direct).toEqual(expected);
  } finally {
    await relay?.close();
    client.close();
    upstream.close();
  }
}, 30000);

it('retains bounded command diagnostics for the private failure owner', async () => {
  const root = temporaryRoot();
  const success = await runLabCommand(
    process.execPath,
    [
      '-e',
      'process.stdout.write("fixture stdout"); process.stderr.write("fixture stderr")',
    ],
    root,
  );
  expect(success).toEqual({
    stdout: 'fixture stdout',
    stderr: 'fixture stderr',
  });
  await expect(
    runLabCommand(
      process.execPath,
      ['-e', 'process.stderr.write("fixture failure"); process.exitCode = 7'],
      root,
    ),
  ).rejects.toMatchObject({ cause: { stdout: '', stderr: 'fixture failure' } });
}, 30000);

it('refuses an unsupported relay transport before spawning a child', async () => {
  await expect(
    startLabRelay(49152, temporaryRoot(), 'forward', 'unknown'),
  ).rejects.toThrow('Unsupported lab relay transport');
});
