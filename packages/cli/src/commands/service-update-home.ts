import { isAbsolute } from 'node:path';
import {
  createStationHomeUpdateBackup,
  restoreStationHomeUpdateBackup,
} from '@kontourai/station-shared/station-home-archive';

/**
 * `station service update-home <backup|restore> --backup-dir=<dir>`: the
 * home snapshot of a supervised update (#2675 slice D). The fixed launcher
 * runs it with the version it is leaving (backup) or returning to (restore),
 * so the store registry that decides what is product data is always that
 * version's own, never one frozen into the launcher. Not a user command.
 *
 * Prints one JSON line on success; any failure throws, and the CLI exits
 * nonzero, which is what the launcher acts on.
 */
export function runServiceUpdateHome(args: string[], homeDir: string): void {
  const [verb] = args;
  const backupDir = args
    .find((arg) => arg.startsWith('--backup-dir='))
    ?.slice('--backup-dir='.length);
  if ((verb !== 'backup' && verb !== 'restore') || !backupDir) {
    throw new Error(
      'Usage: station service update-home <backup|restore> --backup-dir=<absolute path> --base=<home>',
    );
  }
  if (!isAbsolute(backupDir)) {
    throw new Error('--backup-dir must be an absolute path');
  }
  if (verb === 'backup') {
    const { manifest, reused } = createStationHomeUpdateBackup({
      homeDir,
      backupDir,
    });
    process.stdout.write(
      `${JSON.stringify({ ok: true, verb, reused, files: manifest.files.length })}\n`,
    );
    return;
  }
  const { manifest } = restoreStationHomeUpdateBackup({ homeDir, backupDir });
  process.stdout.write(
    `${JSON.stringify({ ok: true, verb, files: manifest.files.length })}\n`,
  );
}
