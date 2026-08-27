import { createServer } from 'node:http';
import { afterEach, describe, expect, test } from 'vitest';
import { devServerOrigin, listenDevServer } from '../dev/server.js';

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

describe('plugin dev listener', () => {
  test('binds the production listener seam to explicit IPv4 loopback', async () => {
    const server = createServer((_req, res) => res.end('ok'));
    servers.push(server);
    const address = await listenDevServer(server, 0);
    expect(address.address).toBe('127.0.0.1');
    expect(address.family).toBe('IPv4');
    expect(address.port).toBeGreaterThan(0);
    expect(devServerOrigin(address)).toBe(`http://127.0.0.1:${address.port}`);
  });
});
