/** The net catcher on real sockets: holding, counting, stopping, closing. */
import { connect, createServer, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNetCatcher } from '../catcher.ts';
import type { ListenerHandle } from '../generation-manager.ts';

const HOST = '127.0.0.1';
const clients: Socket[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.destroy();
});

/** A raw listening TCP wrap, as a generation sends one with listener.spare. */
async function rawListeningHandle(): Promise<{
  handle: ListenerHandle;
  port: number;
}> {
  const owner = createServer();
  await new Promise<void>((resolve) => owner.listen(0, HOST, resolve));
  const { port } = owner.address() as { port: number };
  const handle = (owner as unknown as { _handle: ListenerHandle })._handle;
  (owner as unknown as { _handle: unknown })._handle = null;
  return { handle, port };
}

function connectTo(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const client = connect(port, HOST, () => resolve(client));
    client.on('error', reject);
    clients.push(client);
  });
}

describe('createNetCatcher', () => {
  it('holds what it accepts, counts it, stops listening on stop, and hands it over on close', async () => {
    const { handle, port } = await rawListeningHandle();
    const onCatch = vi.fn();
    const catcher = createNetCatcher(
      'api',
      handle,
      Date.now,
      onCatch,
      () => {},
    );
    for (let i = 0; i < 3; i += 1) await connectTo(port);
    await vi.waitFor(() => expect(onCatch).toHaveBeenCalledTimes(3));
    expect(catcher.heldCount).toBe(3);
    expect(catcher.lastCaughtAt).toBeGreaterThan(0);
    catcher.stop();
    // Nothing else listens on this socket in a unit test, so it is refused.
    await expect(connectTo(port)).rejects.toMatchObject({
      code: 'ECONNREFUSED',
    });
    expect(catcher.heldCount).toBe(3);
    const held = catcher.close();
    expect(held).toHaveLength(3);
    expect(catcher.close()).toEqual([]);
    for (const connection of held) connection.destroy();
  });
});
