import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * The lease FILE STORE: every byte the verification coordinator persists for
 * ownership goes through the atomic JSON writer and torn-file-safe reader in
 * this module. Split from `verification-lease-ownership.mjs` (which owns the
 * lease PROTOCOL) under that module's bounded-size contract.
 */

// One warning per corrupt file path, bounded: the read paths run on every
// admission poll and heartbeat, and repeating the same diagnostic hundreds of
// times per run would bury the one line that matters.
const warnedCorruptPaths = new Set();
const WARNED_CORRUPT_PATH_CAP = 128;

function warnCorruptJson(path, error) {
  if (warnedCorruptPaths.has(path)) return;
  if (warnedCorruptPaths.size < WARNED_CORRUPT_PATH_CAP)
    warnedCorruptPaths.add(path);
  console.warn(
    `verification coordinator: unparseable lease record treated as absent (${path}): ${
      error?.message ?? error
    }`,
  );
}

export function requireDirectoryEntries(path) {
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/**
 * station#3287: `writeJsonAtomic` below publishes only complete files, so an
 * unparseable lease record is durable corruption (disk failure, external
 * truncation), never a transient mid-write state. It must not be trusted —
 * and it must not crash the host-wide request scan either: `readJson` used to
 * rethrow the `JSON.parse` SyntaxError, so ONE torn lease file wedged every
 * subsequent coordinated run on the host at `listJobs`.
 */
export function readJsonRecord(path) {
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')), corrupt: false };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      // Windows cannot replace an open/occupied file with rename(2). During
      // the bounded replace fallback below, the prior complete value remains
      // available under an exact `.previous-*` sibling. Reading that older
      // owner/state is conservative and keeps crash recovery possible.
      try {
        const directory = resolve(path, '..');
        const name = path.slice(directory.length + 1);
        const previous = requireDirectoryEntries(directory).find((entry) =>
          entry.startsWith(`${name}.previous-`),
        );
        if (previous)
          return {
            value: JSON.parse(readFileSync(join(directory, previous), 'utf8')),
            corrupt: false,
          };
      } catch {
        // No complete prior value is available.
      }
      return { value: null, corrupt: false };
    }
    if (error instanceof SyntaxError) {
      warnCorruptJson(path, error);
      return { value: null, corrupt: true, error };
    }
    throw error;
  }
}

export function readJson(path) {
  return readJsonRecord(path).value;
}

function freeDiskMiB(path) {
  try {
    const stats = statfsSync(path);
    return Math.floor((stats.bavail * stats.bsize) / (1024 * 1024));
  } catch {
    return null;
  }
}

/**
 * station#3287: a full host disk surfaced here as a raw unhandled ENOSPC
 * stack out of `markOwnedLeaseLost`, which operators read as a test failure
 * that did not exist. Name the condition instead. The original error stays
 * attached as `cause`, and `code` stays `ENOSPC` so callers that classify by
 * code keep working.
 */
function diskFullError(path, cause) {
  const free = freeDiskMiB(resolve(path, '..'));
  const freeText = free === null ? 'free space unknown' : `${free} MiB free`;
  return Object.assign(
    new Error(
      `host disk full: ${freeText} — the verification lease cannot be recorded (${path}). ` +
        'Free disk space (worktree node_modules are the usual bulk; see station#3287), then rerun.',
      { cause },
    ),
    { code: 'ENOSPC' },
  );
}

export function writeJsonAtomic(path, value) {
  // Lease mutations must never recreate their parent after a recovery rename.
  // Callers create a staging directory before its first write; every later
  // update is constrained to that existing inode.
  //
  // Torn-file guarantee: the destination only ever receives COMPLETE content
  // via rename(2). A failed write (ENOSPC included) can tear only the
  // uniquely-named temporary, which is removed below — the prior complete
  // lease at `path` is never damaged by a failed update.
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
    });
    chmodSync(temporary, 0o600);
    try {
      renameSync(temporary, path);
    } catch (error) {
      if (
        error?.code !== 'EPERM' ||
        process.platform !== 'win32' ||
        !existsSync(path)
      )
        throw error;
      // Win32 rename does not replace an occupied destination. Preserve the
      // previous complete file while publishing the new complete file, so a
      // concurrent reader or crash never has to interpret a partial JSON write.
      const previous = `${path}.previous-${randomUUID()}`;
      renameSync(path, previous);
      try {
        renameSync(temporary, path);
      } catch (replaceError) {
        try {
          renameSync(previous, path);
        } catch {
          // The complete previous sibling remains discoverable by readJson.
        }
        throw replaceError;
      }
      rmSync(previous, { force: true });
    }
  } catch (error) {
    try {
      // A torn temporary is litter that makes a full disk worse; deleting
      // never needs new space.
      rmSync(temporary, { force: true });
    } catch {
      // Removal is best-effort; the unique name can never be trusted as a
      // lease by any reader.
    }
    if (error?.code === 'ENOSPC') throw diskFullError(path, error);
    throw error;
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows does not implement POSIX modes.
  }
}
