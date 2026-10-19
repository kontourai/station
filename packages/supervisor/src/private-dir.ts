import { lstatSync, mkdirSync } from 'node:fs';

/**
 * Creates `dir` at 0700 when it is missing. An existing directory is used only
 * if it is already private to this user; it is never chmodded, because it may
 * not be ours (for example `--control ~/x.sock` names the home directory).
 */
export function ensurePrivateDir(
  dir: string,
  platform: NodeJS.Platform,
  currentUid: () => number | undefined,
): void {
  let stat: ReturnType<typeof lstatSync> | null = null;
  try {
    stat = lstatSync(dir);
  } catch {
    stat = null;
  }
  if (!stat) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (platform === 'win32') return;
    stat = lstatSync(dir);
  }
  if (platform === 'win32') {
    if (!stat.isDirectory())
      throw new Error(`refusing supervisor directory ${dir}: not a directory`);
    return;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`refusing supervisor directory ${dir}: it is a symlink`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`refusing supervisor directory ${dir}: not a directory`);
  }
  const uid = currentUid();
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(
      `refusing supervisor directory ${dir}: owned by uid ${stat.uid}, not ${uid}`,
    );
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(
      `refusing supervisor directory ${dir}: mode ${(stat.mode & 0o777).toString(8)} is broader than 700`,
    );
  }
}
