import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { writeJsonAtomically } from '@kontourai/station-shared/service-launcher-protocol';

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
