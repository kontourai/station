import { createHash } from 'node:crypto';
import { constants, fstatSync, lstatSync } from 'node:fs';
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { writeJsonAtomically } from '@kontourai/station-shared/service-launcher-protocol';

/** Local resource custody, not person identity or a home-transfer authorization. */
export async function captureCompanionHomeCustody(home: string) {
  const path = await realpath(home);
  const entry = await lstat(path, { bigint: true });
  const uid = process.getuid?.();
  if (
    !entry.isDirectory() ||
    entry.isSymbolicLink() ||
    uid === undefined ||
    entry.uid !== BigInt(uid)
  )
    throw new Error('Companion home custody unavailable');
  return { path, device: String(entry.dev), inode: String(entry.ino) };
}

export function companionCustodyDigest(
  home: { path: string; device: string; inode: string },
  daemonId: string,
) {
  return createHash('sha256')
    .update(JSON.stringify({ home, daemonId }))
    .digest('hex');
}

export function companionErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

export async function syncCompanionDirectory(path: string): Promise<void> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function companionPrivateDirectory(
  path: string,
  create: boolean,
): Promise<void> {
  if (create) {
    try {
      await mkdir(path, { mode: 0o700 });
      await syncCompanionDirectory(dirname(path));
    } catch (error) {
      if (!companionErrno(error, 'EEXIST')) throw error;
    }
  }
  const entry = await lstat(path);
  if (
    !entry.isDirectory() ||
    entry.isSymbolicLink() ||
    (process.platform !== 'win32' &&
      ((entry.mode & 0o077) !== 0 || entry.uid !== process.getuid?.()))
  )
    throw new Error('Companion private storage unavailable');
}

export async function companionDurableJson(
  path: string,
  value: unknown,
): Promise<void> {
  writeJsonAtomically(path, value);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncCompanionDirectory(dirname(path));
}

/** Shared with install/start/stop. This excludes cooperating owners, not Docker administrators. */
export async function acquireCompanionInstallationLease(
  root: string,
  metadata: { installationId: string; operationId?: string },
) {
  const path = join(root, 'installation.lock');
  const handle = await open(path, 'wx', 0o600);
  let identity: { dev: number; ino: number };
  try {
    identity = await handle.stat();
  } catch (error) {
    await handle.close();
    throw error;
  }
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    let closeError: unknown;
    try {
      await handle.close();
    } catch (error) {
      closeError = error;
    }
    try {
      const entry = await lstat(path);
      if (
        !entry.isSymbolicLink() &&
        entry.dev === identity.dev &&
        entry.ino === identity.ino
      ) {
        await unlink(path);
        await syncCompanionDirectory(root);
      }
    } catch (error) {
      if (!companionErrno(error, 'ENOENT')) throw error;
    }
    if (closeError) throw closeError;
  };
  try {
    await handle.writeFile(JSON.stringify({ ...metadata, pid: process.pid }));
    await handle.sync();
  } catch (error) {
    await release();
    throw error;
  }
  return {
    assertLocalCurrent() {
      if (released) throw new Error('Companion lease released');
      const owned = fstatSync(handle.fd);
      const entry = lstatSync(path);
      if (
        entry.isSymbolicLink() ||
        entry.dev !== owned.dev ||
        entry.ino !== owned.ino
      )
        throw new Error('Companion lease changed');
    },
    release,
  };
}
