import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  listRetainedPluginBackups,
  recordRecoveryOwner,
} from '../plugin-recovery-inventory.js';

const makeTempDir = trackTempDirs();
afterEach(() => vi.unstubAllEnvs());

test('lists only retained backups owned by this home, without following links', () => {
  const root = makeTempDir('recovery-list-');
  const home = join(root, 'home');
  const otherHome = join(root, 'other');
  const temp = join(root, 'tmp');
  mkdirSync(home);
  mkdirSync(otherHome);
  mkdirSync(temp);
  vi.stubEnv('STATION_TEMP_ROOT', temp);
  const make = (id: string, owner?: string) => {
    const backup = join(temp, id);
    mkdirSync(join(backup, 'integrations', 'email'), { recursive: true });
    writeFileSync(join(backup, '.station-retained-recovery'), 'retained');
    writeFileSync(
      join(backup, 'integrations', 'email', 'integration.json'),
      '{}',
    );
    if (owner) recordRecoveryOwner(backup, owner);
    return backup;
  };
  const owned = make('plugin-install-abc123', home);
  make('plugin-install-def456', otherHome);
  make('plugin-install-old123');
  symlinkSync(otherHome, join(owned, 'ignored-link'));
  const result = listRetainedPluginBackups(home);
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({
    id: 'plugin-install-abc123',
    path: owned,
    integrations: ['email'],
  });
  expect(result[0].sizeBytes).toBeGreaterThan(2);
  expect(new Date(result[0].createdAt).getTime()).toBeGreaterThan(0);
});
