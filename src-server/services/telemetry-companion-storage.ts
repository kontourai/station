import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
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
