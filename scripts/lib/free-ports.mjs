/**
 * Shared free-port allocation for test/dev harnesses that boot Station
 * instances. Previously duplicated across run-e2e-suite.mjs and
 * proof-phase1-no-aws-startup.mjs (and hand-rolled/hardcoded in cli-agent-e2e).
 */
import { createServer } from 'node:http';

/** Allocate a single free port (OS-assigned ephemeral, then released). */
export async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate a port')));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

/** True if `port` can be bound right now on 127.0.0.1. */
async function isPortAvailable(port) {
  // A block starting near the top of the ephemeral range can run past 65535,
  // and `listen()` rejects an out-of-range port by *throwing synchronously* —
  // the 'error' listener below never sees it, so the RangeError escapes as an
  // unhandled rejection and takes the harness down. Treating out-of-range as
  // simply unavailable lets the caller move on to another block, which is what
  // every call site already does when a port is taken.
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.on('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

/** Allocate `size` contiguous free ports; returns the block start. */
export async function findFreePortBlock(size) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const start = await findFreePort();
    const checks = await Promise.all(
      Array.from({ length: size }, (_, offset) =>
        isPortAvailable(start + offset),
      ),
    );
    if (checks.every(Boolean)) {
      return start;
    }
  }
  throw new Error(`Failed to allocate ${size} contiguous ports`);
}

/** Prefer a block near `preferredStart` (stepping by 10), else any free block. */
export async function findPreferredPortBlock(preferredStart, size) {
  for (let offset = 0; offset < 100; offset += 1) {
    const start = preferredStart + offset * 10;
    const checks = await Promise.all(
      Array.from({ length: size }, (_, index) =>
        isPortAvailable(start + index),
      ),
    );
    if (checks.every(Boolean)) {
      return start;
    }
  }
  return findFreePortBlock(size);
}

/** A free port that falls OUTSIDE [blockStart, blockStart+blockSize). */
export async function findFreePortOutside(blockStart, blockSize) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const port = await findFreePort();
    if (port < blockStart || port >= blockStart + blockSize) {
      return port;
    }
  }
  throw new Error('Failed to allocate a port outside the reserved block');
}

/** Prefer a port near `preferredPort` outside the block, else any free one. */
export async function findPreferredPortOutside(
  preferredPort,
  blockStart,
  blockSize,
) {
  for (let offset = 0; offset < 100; offset += 1) {
    const port = preferredPort + offset * 10;
    if (
      (port < blockStart || port >= blockStart + blockSize) &&
      (await isPortAvailable(port))
    ) {
      return port;
    }
  }
  return findFreePortOutside(blockStart, blockSize);
}
