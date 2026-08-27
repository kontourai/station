import { once } from 'node:events';
import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  allocateFreePortBlock,
  reserveContiguousBlock,
} from '../allocate-port-block.js';

const LOOPBACK = '127.0.0.1';
// RFC 5737 TEST-NET-1: never assigned to a local interface, so binding it fails
// with EADDRNOTAVAIL on every attempt — a deterministic exhaustion driver.
const UNBINDABLE_HOST = '192.0.2.1';

/** Binds a real listener on `host:port` and resolves once it is listening. */
async function occupy(host: string, port: number): Promise<Server> {
  const server = createServer();
  server.listen(port, host);
  await once(server, 'listening');
  return server;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

/** Proves a port is actually bindable right now by holding then releasing it. */
async function isBindable(host: string, port: number): Promise<boolean> {
  const server = createServer();
  try {
    server.listen(port, host);
    await once(server, 'listening');
    await closeServer(server);
    return true;
  } catch {
    return false;
  }
}

describe('allocateFreePortBlock', () => {
  const cleanup: Server[] = [];

  afterEach(async () => {
    await Promise.allSettled(cleanup.splice(0).map(closeServer));
  });

  it('returns a base whose entire span is simultaneously bindable', async () => {
    const base = await allocateFreePortBlock(LOOPBACK, 3);
    expect(Number.isInteger(base)).toBe(true);
    expect(base).toBeGreaterThan(0);
    expect(base + 2).toBeLessThanOrEqual(65_535);

    // Every port in the returned block must be free right now.
    for (const offset of [0, 1, 2]) {
      expect(
        await isBindable(LOOPBACK, base + offset),
        `port ${base + offset} should be free`,
      ).toBe(true);
    }
  });

  it('rejects a block whose middle port is already occupied (forcing a retry)', async () => {
    // Discover a currently-free block, then squat its base+1 so the same block
    // can no longer be reserved — the exact conflict the allocator retries past.
    const base = await allocateFreePortBlock(LOOPBACK, 3);
    const blocker = await occupy(LOOPBACK, base + 1);
    cleanup.push(blocker);

    const reserved = await reserveContiguousBlock(LOOPBACK, base + 1, 2);
    expect(reserved).toBeNull();

    // A fully-free range still reserves successfully and releases cleanly.
    const freeBase = await allocateFreePortBlock(LOOPBACK, 3);
    const held = await reserveContiguousBlock(LOOPBACK, freeBase + 1, 2);
    expect(held).not.toBeNull();
    await Promise.allSettled((held ?? []).map(closeServer));
  });

  it('still yields a clean, disjoint block under contention', async () => {
    // Occupy an arbitrary free port, then confirm the allocator never hands back
    // a block that overlaps it and that the block is genuinely bindable.
    const victimBase = await allocateFreePortBlock(LOOPBACK, 3);
    const squatter = await occupy(LOOPBACK, victimBase + 1);
    cleanup.push(squatter);

    const base = await allocateFreePortBlock(LOOPBACK, 3);
    const block = new Set([base, base + 1, base + 2]);
    expect(block.has(victimBase + 1)).toBe(false);
    for (const offset of [0, 1, 2]) {
      expect(await isBindable(LOOPBACK, base + offset)).toBe(true);
    }
  });

  it('throws after exhausting its attempts when no port is bindable', async () => {
    await expect(allocateFreePortBlock(UNBINDABLE_HOST, 3, 3)).rejects.toThrow(
      `Could not allocate a free 3-port block on ${UNBINDABLE_HOST} after 3 attempts`,
    );
  });
});
