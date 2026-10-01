import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import { waitForTcpOk } from '../commands/lifecycle.js';

const servers: Server[] = [];

/** A port that is free now: bound, read and released. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const timers: ReturnType<typeof setTimeout>[] = [];

function listenAfter(port: number, delayMs: number): void {
  timers.push(
    setTimeout(() => {
      const server = createServer();
      servers.push(server);
      server.listen(port, '127.0.0.1');
    }, delayMs),
  );
}

afterEach(async () => {
  for (const timer of timers.splice(0)) clearTimeout(timer);
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

describe('waitForTcpOk slow-boot extension (#2964)', () => {
  test('a listener that opens after the base deadline is reached while the child is alive', async () => {
    const port = await freePort();
    const lines: string[] = [];
    listenAfter(port, 450);
    await waitForTcpOk('127.0.0.1', port, 150, {
      childAlive: () => true,
      // Generous: the wait returns on connect, so a wide extension only
      // costs time when the listener never opens.
      extensionMs: 1_000,
      maxExtensions: 2,
      log: (line) => lines.push(line),
    });
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines[0]).toContain(`TCP listener 127.0.0.1:${port}`);
    expect(lines[0]).toContain('1/2');
  });

  test('without a child probe the base deadline is the whole budget', async () => {
    const port = await freePort();
    listenAfter(port, 450);
    await expect(waitForTcpOk('127.0.0.1', port, 150)).rejects.toThrow(
      `Timed out waiting for TCP listener 127.0.0.1:${port}`,
    );
  });

  test('extensions are bounded: a listener that never opens still times out', async () => {
    const port = await freePort();
    const lines: string[] = [];
    const started = Date.now();
    await expect(
      waitForTcpOk('127.0.0.1', port, 100, {
        childAlive: () => true,
        extensionMs: 100,
        maxExtensions: 2,
        log: (line) => lines.push(line),
      }),
    ).rejects.toThrow(`Timed out waiting for TCP listener 127.0.0.1:${port}`);
    expect(lines).toHaveLength(2);
    // Base plus two extensions, and not a third.
    expect(Date.now() - started).toBeGreaterThanOrEqual(280);
  });

  test('stops at once when the child has exited', async () => {
    const port = await freePort();
    const started = Date.now();
    await expect(
      waitForTcpOk('127.0.0.1', port, 5_000, { childAlive: () => false }),
    ).rejects.toThrow(
      `Managed server exited before TCP listener 127.0.0.1:${port} was ready`,
    );
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
