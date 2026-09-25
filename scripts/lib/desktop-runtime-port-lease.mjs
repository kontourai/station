import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  probeExactProcessIdentity,
  resolveOwnProcessIdentity,
} from '../../packages/shared/src/process-identity.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ownerIdentity(pid) {
  const result = resolveOwnProcessIdentity(pid);
  if (result.state !== 'exact') {
    throw new Error('Cannot prove this process identity for a listener lease');
  }
  return result.identity;
}

function lockPath() {
  const user =
    typeof process.getuid === 'function' ? `-${process.getuid()}` : '';
  return join(
    tmpdir(),
    `station-desktop-runtime-port-leases${user}`,
    'runtime.lock',
  );
}

function readLease(path) {
  try {
    return JSON.parse(readFileSync(join(path, 'lease.json'), 'utf8'));
  } catch {
    return null;
  }
}

function ownerIsDead(lease) {
  const owner = lease?.owner;
  if (!Number.isInteger(owner?.pid) || typeof owner?.start !== 'string') {
    return false;
  }
  const probe = probeExactProcessIdentity(owner.pid);
  return (
    probe.state === 'dead' ||
    (probe.state === 'exact' && probe.identity.start !== owner.start)
  );
}

function reclaimDeadOwner(path, lease) {
  if (!ownerIsDead(lease)) return false;
  const retired = `${path}.retired-${randomUUID()}`;
  try {
    renameSync(path, retired);
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    if (error?.code === 'EEXIST' || error?.code === 'ENOTEMPTY') return false;
    throw error;
  }
  const moved = readLease(retired);
  if (moved?.owner?.nonce !== lease?.owner?.nonce) {
    // The directory changed between inspection and retirement. Restore only
    // when the destination remains vacant; never remove the new owner's data.
    try {
      renameSync(retired, path);
    } catch {}
    return false;
  }
  rmSync(retired, { recursive: true, force: true });
  return true;
}

function releaseLease(path, lease) {
  const current = readLease(path);
  if (current?.owner?.nonce === lease.owner.nonce) {
    // Retire the directory with one atomic rename before deleting it.
    // Deleting in place empties `path` before removing it, and a rename
    // onto an EMPTY directory succeeds: a waiter would claim the lease
    // inside that window and the owner's final rmdir would then fail with
    // ENOTEMPTY (#2648). While it still holds our lease.json, `path`
    // cannot be claimed (non-empty) or reclaimed (we are alive), so the
    // rename moves our own directory and nothing else.
    const retired = `${path}.retired-${lease.owner.nonce}`;
    try {
      renameSync(path, retired);
    } catch (error) {
      // Already gone: nothing of ours is left to release.
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    // Only a misjudged reclaim could have replaced `path` between the read
    // and the rename; as in reclaimDeadOwner, never delete another owner's
    // directory — put it back if the destination is still vacant.
    if (readLease(retired)?.owner?.nonce !== lease.owner.nonce) {
      try {
        renameSync(retired, path);
      } catch {}
      return;
    }
    rmSync(retired, { recursive: true, force: true });
  }
}

/**
 * Serialize cooperating packaged-runtime fixtures until the runtime reports
 * all of its listeners ready. The owner record is published atomically, and a
 * lease is reclaimed only when exact process identity proves its owner dead.
 */
export async function withDesktopRuntimeListenerLease(work, options = {}) {
  const path = options.path ?? lockPath();
  const waitMs = options.waitMs ?? 15_000;
  const pollMs = options.pollMs ?? 20;
  const deadline = Date.now() + waitMs;
  const owner = ownerIdentity(process.pid);
  const lease = { owner: { ...owner, nonce: randomUUID() } };
  const parent = join(path, '..');
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  try {
    chmodSync(parent, 0o700);
  } catch {}

  while (true) {
    const staged = `${path}.claim-${lease.owner.nonce}`;
    mkdirSync(staged, { recursive: false, mode: 0o700 });
    writeFileSync(join(staged, 'lease.json'), JSON.stringify(lease), {
      flag: 'wx',
      mode: 0o600,
    });
    try {
      renameSync(staged, path);
      break;
    } catch (error) {
      rmSync(staged, { recursive: true, force: true });
      if (
        error?.code !== 'EEXIST' &&
        error?.code !== 'ENOTEMPTY' &&
        !(error?.code === 'EPERM' && existsSync(path))
      )
        throw error;
      const existing = readLease(path);
      if (existing && reclaimDeadOwner(path, existing)) continue;
      if (Date.now() >= deadline) {
        throw new Error(
          'Timed out waiting for the packaged-runtime listener lease',
        );
      }
      await delay(pollMs);
    }
  }

  try {
    return await work();
  } finally {
    releaseLease(path, lease);
  }
}
