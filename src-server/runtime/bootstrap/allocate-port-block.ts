import { createServer, type Server } from 'node:net';

const MAX_PORT = 65_535;

/**
 * Binds a fresh TCP server to `host:port` and resolves with it once it is
 * listening. Rejects (rather than throwing synchronously) on bind failure —
 * e.g. `EADDRINUSE` when the port is taken or `EADDRNOTAVAIL` when the host is
 * not a local address.
 */
function bindPort(host: string, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    const onError = (error: Error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(server);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function closeAll(servers: Server[]): Promise<void> {
  await Promise.allSettled(servers.map(closeServer));
}

/**
 * Attempts to hold every port in `[start, start + count)` on `host` at once.
 * Returns the bound servers on success, or `null` if any port in the range is
 * unavailable (the partially-bound servers are released before returning).
 *
 * Exported for testing the conflict path with real listeners.
 */
export async function reserveContiguousBlock(
  host: string,
  start: number,
  count: number,
): Promise<Server[] | null> {
  const held: Server[] = [];
  for (let offset = 0; offset < count; offset++) {
    try {
      held.push(await bindPort(host, start + offset));
    } catch {
      await closeAll(held);
      return null;
    }
  }
  return held;
}

/**
 * Self-allocates a contiguous block of `span` free ports on `host` and returns
 * its base. Station binds its HTTP listener on the base, its terminal WebSocket
 * on `base + 1`, its voice WebSocket on `base + 2`, and its consent listener
 * on `base + 3` (station#3677), so the whole block must be free
 * simultaneously.
 *
 * Discovers a candidate base via an ephemeral (`:0`) bind, holds it open while
 * reserving the rest of the block, then releases everything and returns the
 * base. Retries on conflict (another process racing for the same ports) and
 * throws after `attempts` exhausted candidates.
 */
export async function allocateFreePortBlock(
  host: string,
  span = 4,
  attempts = 20,
): Promise<number> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let baseServer: Server;
    try {
      baseServer = await bindPort(host, 0);
    } catch (error) {
      lastError = error;
      continue;
    }

    const address = baseServer.address();
    if (!address || typeof address === 'string') {
      await closeAll([baseServer]);
      lastError = new Error(
        'Ephemeral listener did not report an assigned TCP port',
      );
      continue;
    }

    const base = address.port;
    if (base + span - 1 > MAX_PORT) {
      // The base sits too high to fit the whole block; release and retry for a
      // lower candidate.
      await closeAll([baseServer]);
      lastError = new Error(
        `Ephemeral base ${base} leaves no room for a ${span}-port block`,
      );
      continue;
    }

    const rest = await reserveContiguousBlock(host, base + 1, span - 1);
    if (rest) {
      await closeAll([baseServer, ...rest]);
      return base;
    }

    await closeAll([baseServer]);
    lastError = new Error(
      `Ports ${base + 1}..${base + span - 1} on ${host} were not simultaneously free`,
    );
  }

  throw new Error(
    `Could not allocate a free ${span}-port block on ${host} after ${attempts} attempts`,
    { cause: lastError },
  );
}
