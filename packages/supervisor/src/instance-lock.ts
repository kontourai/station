/**
 * One supervisor per (home, instance). The lock is a file in the home's run
 * directory holding the owner's pid and process fingerprint, created with
 * `wx`. It is keyed by home and instance only: a different `--control` socket
 * does not make a second supervisor for the same instance acceptable.
 */
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { type Fingerprint, processFingerprint } from './generation-registry.ts';

interface LockOwner {
  pid: number;
  /** Empty when the owner could not fingerprint itself. */
  fingerprint: string;
}

export class SupervisorStartError extends Error {}

function readOwner(path: string): LockOwner | 'missing' | 'unreadable' {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'missing'
      : 'unreadable';
  }
  try {
    const parsed = JSON.parse(text) as Partial<LockOwner>;
    if (
      Number.isSafeInteger(parsed.pid) &&
      (parsed.pid as number) > 0 &&
      typeof parsed.fingerprint === 'string'
    ) {
      return { pid: parsed.pid as number, fingerprint: parsed.fingerprint };
    }
  } catch {
    // Being written, or garbage.
  }
  return 'unreadable';
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function ownerIsLive(
  owner: LockOwner,
  fingerprint: (pid: number) => Promise<Fingerprint>,
): Promise<boolean> {
  if (owner.pid === process.pid) return false;
  const current = await fingerprint(owner.pid);
  if (current.status === 'gone') return false;
  // Unverifiable: assume the owner is alive rather than risk two supervisors.
  if (current.status === 'unknown') return true;
  if (owner.fingerprint === '') return pidExists(owner.pid);
  return current.value === owner.fingerprint;
}

export interface InstanceLock {
  release(): void;
}

/**
 * Takes the lock or throws SupervisorStartError naming the live owner. A lock
 * whose owner is dead is taken over by renaming it aside and creating a fresh
 * one; a racer that loses either step re-reads the lock and refuses if the
 * winner is alive.
 */
export async function acquireInstanceLock(options: {
  path: string;
  description: string;
  log: (message: string) => void;
  fingerprint?: (pid: number) => Promise<Fingerprint>;
}): Promise<InstanceLock> {
  const fingerprint =
    options.fingerprint ?? ((pid: number) => processFingerprint(pid));
  const self = await fingerprint(process.pid);
  const mine: LockOwner = {
    pid: process.pid,
    fingerprint: self.status === 'ok' ? self.value : '',
  };
  const content = JSON.stringify(mine);
  const refuse = (owner: LockOwner) =>
    new SupervisorStartError(
      `another supervisor (pid ${owner.pid}) holds ${options.description}; refusing to start`,
    );

  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const fd = openSync(options.path, 'wx', 0o600);
      try {
        writeSync(fd, content);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return {
        release: () => {
          const owner = readOwner(options.path);
          // Never remove a lock that is no longer ours.
          if (typeof owner === 'object' && owner.pid !== process.pid) return;
          try {
            unlinkSync(options.path);
          } catch {
            // Already gone.
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    let owner = readOwner(options.path);
    // A racer may be between creating and writing its lock: give it a moment.
    for (let wait = 0; owner === 'unreadable' && wait < 20; wait += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      owner = readOwner(options.path);
    }
    if (owner === 'missing') continue;
    if (owner !== 'unreadable' && (await ownerIsLive(owner, fingerprint))) {
      throw refuse(owner);
    }

    // Stale: move it aside under a unique name, then check what was moved.
    const aside = `${options.path}.stale-${process.pid}-${randomBytes(4).toString('hex')}`;
    try {
      renameSync(options.path, aside);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const moved = readOwner(aside);
    const sameAsJudged =
      owner === 'unreadable'
        ? moved === 'unreadable'
        : typeof moved === 'object' &&
          moved.pid === owner.pid &&
          moved.fingerprint === owner.fingerprint;
    if (
      !sameAsJudged &&
      typeof moved === 'object' &&
      (await ownerIsLive(moved, fingerprint))
    ) {
      // A winner replaced the stale lock between our read and our rename:
      // put its lock back and refuse.
      try {
        linkSync(aside, options.path);
      } catch {
        // Someone else already holds the path; it is theirs.
      }
      try {
        unlinkSync(aside);
      } catch {
        // Already gone.
      }
      throw refuse(moved);
    }
    try {
      unlinkSync(aside);
    } catch {
      // Already gone.
    }
    options.log(
      typeof owner === 'object'
        ? `took over the instance lock of dead supervisor pid ${owner.pid}`
        : 'took over an unreadable instance lock',
    );
  }
  throw new SupervisorStartError(
    `could not take ${options.description} after repeated attempts`,
  );
}
