/**
 * The control client refuses to hand its token to a socket in a directory
 * other users can reach, and turns malformed server output into an error.
 */
import { chmodSync, mkdirSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { connectControl } from '../control-client.ts';
import {
  CONTROL_MAX_LINE_BYTES,
  resolveControlEndpoint,
  SUPERVISOR_PROTOCOL,
} from '../protocol.ts';
import { makeShortHome } from './harness.ts';

const posixOnly = process.platform === 'win32' ? it.skip : it;
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

async function fakeSupervisor(
  dirMode: number,
  onConnection: (socket: Socket) => void,
): Promise<{
  path: string;
  connections: () => number;
  received: () => string;
}> {
  // The real endpoint derivation: a socket in the run directory beside the home, or a named pipe on Windows.
  const home = makeShortHome();
  const { path } = resolveControlEndpoint({ home, instance: 't' });
  if (process.platform !== 'win32') {
    const dir = dirname(path);
    mkdirSync(dir);
    chmodSync(dir, dirMode);
  }
  let connections = 0;
  let received = '';
  const server = createServer((socket) => {
    connections += 1;
    socket.on('data', (chunk) => {
      received += chunk.toString();
    });
    socket.on('error', () => {});
    onConnection(socket);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return { path, connections: () => connections, received: () => received };
}

const welcome = `${JSON.stringify({
  type: 'welcome',
  protocol: SUPERVISOR_PROTOCOL,
  supervisor: { pid: 1, version: '0', instance: 't' },
  capabilities: [],
})}\n`;

describe('control client hardening', () => {
  posixOnly(
    'does not connect or send the token when the socket directory is not private',
    async () => {
      const fake = await fakeSupervisor(0o755, () => {});
      await expect(
        connectControl({
          path: fake.path,
          token: 'secret-token',
          timeoutMs: 1_000,
        }),
      ).rejects.toThrow(/socket directory .* is not private/);
      expect(fake.connections()).toBe(0);
      expect(fake.received()).toBe('');
    },
  );

  it('rejects a malformed first line instead of throwing', async () => {
    const fake = await fakeSupervisor(0o700, (socket) =>
      socket.write('not json\n'),
    );
    await expect(
      connectControl({ path: fake.path, token: 't', timeoutMs: 2_000 }),
    ).rejects.toThrow(/malformed line from the supervisor/);
  });

  it('rejects an over-long line instead of throwing', async () => {
    const fake = await fakeSupervisor(0o700, (socket) =>
      socket.write('x'.repeat(CONTROL_MAX_LINE_BYTES + 1)),
    );
    await expect(
      connectControl({ path: fake.path, token: 't', timeoutMs: 2_000 }),
    ).rejects.toThrow(/line exceeds/);
  });

  it('fails a pending request when a later line is malformed', async () => {
    const fake = await fakeSupervisor(0o700, (socket) => {
      socket.write(welcome);
      socket.once('data', () => socket.write('{broken\n'));
    });
    const connection = await connectControl({
      path: fake.path,
      token: 't',
      timeoutMs: 2_000,
    });
    // The first data event is the hello; the request below triggers the broken reply.
    await expect(
      connection.request({ type: 'status', id: 's1' }, ['status.result']),
    ).rejects.toThrow(
      /malformed line from the supervisor|control connection closed/,
    );
  });
});
