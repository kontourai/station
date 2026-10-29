import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { stationTempRoot } from '@kontourai/station-shared/temp-dir';

const OWNER_FILE = '.station-recovery-owner.json';
const MARKER = '.station-retained-recovery';
const MAX_ENTRIES = 100_000;

/** Bind new recovery material to its Station home; older backups have no owner witness. */
export function recordRecoveryOwner(root: string, home: string): void {
  writeFileSync(
    join(root, OWNER_FILE),
    JSON.stringify({ version: 1, home: realpathSync(home) }),
    { mode: 0o600, flag: 'wx' },
  );
}

function measure(root: string): number {
  let bytes = 0;
  let count = 0;
  const stack = [root];
  while (stack.length) {
    const path = stack.pop()!;
    const info = lstatSync(path);
    if (++count > MAX_ENTRIES)
      throw new Error('Recovery inventory exceeds its entry limit');
    if (info.isSymbolicLink()) continue;
    if (info.isFile()) bytes += info.size;
    else if (info.isDirectory()) {
      for (const name of readdirSync(path)) stack.push(join(path, name));
    }
  }
  return bytes;
}

export function listRetainedPluginBackups(home: string) {
  const root = stationTempRoot();
  const realHome = realpathSync(home);
  let names: string[];
  try {
    names = readdirSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const result = [];
  for (const id of names.sort()) {
    if (!/^plugin-install-[a-zA-Z0-9]+$/.test(id)) continue;
    const directory = join(root, id);
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) continue;
    try {
      if (!lstatSync(join(directory, MARKER)).isFile()) continue;
      const ownerPath = join(directory, OWNER_FILE);
      const ownerInfo = lstatSync(ownerPath);
      if (
        !ownerInfo.isFile() ||
        ownerInfo.isSymbolicLink() ||
        ownerInfo.size > 4096
      )
        continue;
      const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
      if (owner.version !== 1 || owner.home !== realHome) continue;
      const integrationsDir = join(directory, 'integrations');
      const integrations = (() => {
        try {
          const d = lstatSync(integrationsDir);
          if (!d.isDirectory() || d.isSymbolicLink())
            throw new Error('Invalid integration backup');
          return readdirSync(integrationsDir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
          throw error;
        }
      })();
      result.push({
        id,
        createdAt: info.birthtime.toISOString(),
        integrations,
        sizeBytes: measure(directory),
        path: directory,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return result;
}
