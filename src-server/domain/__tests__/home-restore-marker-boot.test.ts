/**
 * The server's boot consumer of the update restore marker (#3851), over a
 * marker written by the real writer for releases identified the way the
 * server identifies itself.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStationHomeUpdateBackup } from '@kontourai/station-shared/station-home-archive';
import {
  readStationHomeRestoreMarker,
  writeStationHomeRestoreMarker,
} from '@kontourai/station-shared/station-home-restore-marker';
import { ensureStationHomeSchemaSync } from '@kontourai/station-shared/station-home-schema';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import type { InstallProvenance } from '../../routes/system/install-provenance.js';
import {
  clearRestoreMarkerOnCommit,
  consumeHomeRestoreMarkerAtBoot,
  runningReleaseIdentity,
} from '../home-restore-marker-boot.js';

const makeTempDir = trackTempDirs();

function archive(root: string, version: string): InstallProvenance {
  const archiveRoot = join(root, 'versions', version);
  mkdirSync(archiveRoot, { recursive: true });
  return {
    installKind: 'archive',
    archiveRoot,
    version,
    installRoot: root,
    release: {} as never,
  };
}

function handoff() {
  const root = makeTempDir('station-restore-boot-');
  const home = join(root, 'home');
  ensureStationHomeSchemaSync(home);
  mkdirSync(join(home, 'config'), { recursive: true });
  writeFileSync(join(home, 'config', 'app.json'), '{"v":"before"}\n');
  const from = archive(root, '1.0.0');
  const target = archive(root, '1.1.0');
  const fromIdentity = runningReleaseIdentity(from);
  const targetIdentity = runningReleaseIdentity(target);
  if (!fromIdentity || !targetIdentity) throw new Error('no identity');
  mkdirSync(join(root, 'backups'), { recursive: true });
  const backupDir = join(root, 'backups', 'h1');
  createStationHomeUpdateBackup({ homeDir: home, backupDir });
  writeStationHomeRestoreMarker(home, {
    fromRelease: fromIdentity,
    targetRelease: targetIdentity,
    backupDir,
  });
  writeFileSync(join(home, 'config', 'app.json'), '{"v":"migrated"}\n');
  return { home, from, target };
}

const app = (home: string) =>
  readFileSync(join(home, 'config', 'app.json'), 'utf8');

describe('the restore marker at server boot (#3851)', () => {
  it('a rollback boot (the from-release) restores the home before the schema gate', () => {
    const { home, from } = handoff();
    expect(
      consumeHomeRestoreMarkerAtBoot(home, () => runningReleaseIdentity(from)),
    ).toBe('restore');
    expect(app(home)).toBe('{"v":"before"}\n');
    expect(readStationHomeRestoreMarker(home).kind).toBe('absent');
  });

  it('a target boot does not restore; the commit clears the marker', () => {
    const { home, target } = handoff();
    expect(
      consumeHomeRestoreMarkerAtBoot(home, () =>
        runningReleaseIdentity(target),
      ),
    ).toBe('await-commit');
    expect(app(home)).toBe('{"v":"migrated"}\n');
    clearRestoreMarkerOnCommit(home);
    expect(readStationHomeRestoreMarker(home).kind).toBe('absent');
  });

  it('a release that cannot state its identity refuses to boot on a marked home', () => {
    const { home } = handoff();
    expect(() => consumeHomeRestoreMarkerAtBoot(home, () => null)).toThrow(
      /will not start/,
    );
    expect(
      runningReleaseIdentity({
        installKind: 'unknown',
        detail: 'x',
        reason: 'missing',
      }),
    ).toBeNull();
  });
});
