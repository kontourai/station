/**
 * The update restore marker (#3851), written by its real writer over a home
 * backed up by the real update backup, then consumed the way a booting
 * release consumes it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';
import {
  createStationHomeUpdateBackup,
  restoreStationHomeUpdateBackup,
} from '../station-home-archive.js';
import {
  consumeStationHomeRestoreMarker,
  readStationHomeRestoreMarker,
  STATION_HOME_RESTORE_MARKER,
  StationHomeRestoreMarkerExistsError,
  StationHomeRestoreRefusedError,
  stationHomeRestoreMarkerPath,
  writeStationHomeRestoreMarker,
} from '../station-home-restore-marker.js';
import { ensureStationHomeSchemaSync } from '../station-home-schema.js';
import { classifyStationHomeRoot } from '../station-home-store-registry.js';

const makeTempDir = trackTempDirs();

/**
 * A handoff as the supervised apply leaves it: the home backed up, the
 * marker written, then the target release migrated the home.
 */
function handedOff() {
  const root = makeTempDir('station-restore-marker-');
  const home = join(root, 'home');
  ensureStationHomeSchemaSync(home);
  mkdirSync(join(home, 'config'), { recursive: true });
  writeFileSync(join(home, 'config', 'app.json'), '{"model":"before"}\n');
  const from = { version: '1.0.0', root: join(root, 'versions', '1.0.0') };
  const target = { version: '1.1.0', root: join(root, 'versions', '1.1.0') };
  mkdirSync(from.root, { recursive: true });
  mkdirSync(target.root, { recursive: true });
  const backupDir = join(root, 'update-backups', 'h1');
  // Its parent exists, as the launcher's `update-backups` does.
  mkdirSync(join(root, 'update-backups'), { recursive: true });
  createStationHomeUpdateBackup({ homeDir: home, backupDir });
  writeStationHomeRestoreMarker(home, {
    fromRelease: from,
    targetRelease: target,
    backupDir,
  });
  // The target ran and changed the home.
  writeFileSync(join(home, 'config', 'app.json'), '{"model":"migrated"}\n');
  return { root, home, from, target, backupDir };
}

const appJson = (home: string) =>
  readFileSync(join(home, 'config', 'app.json'), 'utf8');

describe('the Station home update restore marker (#3851)', () => {
  it('a boot of the from-release (a rollback) restores the home from the backup and clears the marker', () => {
    const { home, from } = handedOff();
    expect(
      consumeStationHomeRestoreMarker({ homeDir: home, running: () => from }),
    ).toBe('restore');
    expect(appJson(home)).toBe('{"model":"before"}\n');
    expect(existsSync(stationHomeRestoreMarkerPath(home))).toBe(false);
  });

  it('a boot of the target release restores nothing and keeps the marker for the commit to clear', () => {
    const { home, target } = handedOff();
    expect(
      consumeStationHomeRestoreMarker({ homeDir: home, running: () => target }),
    ).toBe('await-commit');
    expect(appJson(home)).toBe('{"model":"migrated"}\n');
    expect(readStationHomeRestoreMarker(home).kind).toBe('present');
  });

  it('refuses to boot on a marker that names neither release, or one it cannot read, and changes nothing', () => {
    const { root, home } = handedOff();
    const other = { version: '1.2.0', root: join(root, 'versions', '1.2.0') };
    expect(() =>
      consumeStationHomeRestoreMarker({ homeDir: home, running: () => other }),
    ).toThrow(StationHomeRestoreRefusedError);
    expect(() =>
      consumeStationHomeRestoreMarker({ homeDir: home, running: () => null }),
    ).toThrow(/cannot state its identity/);
    // Same version, another root: not the same release.
    expect(() =>
      consumeStationHomeRestoreMarker({
        homeDir: home,
        running: () => ({ version: '1.0.0', root: other.root }),
      }),
    ).toThrow(StationHomeRestoreRefusedError);
    expect(appJson(home)).toBe('{"model":"migrated"}\n');

    writeFileSync(stationHomeRestoreMarkerPath(home), '{"schemaVersion":1}');
    expect(() =>
      consumeStationHomeRestoreMarker({ homeDir: home, running: () => other }),
    ).toThrow(/not a restore marker this Station reads/);
  });

  it('with no marker, boot reads nothing more and does nothing', () => {
    const root = makeTempDir('station-restore-marker-');
    let asked = false;
    expect(
      consumeStationHomeRestoreMarker({
        homeDir: root,
        running: () => {
          asked = true;
          return null;
        },
      }),
    ).toBe('none');
    expect(asked).toBe(false);
  });

  it('never replaces the marker of an unresolved handoff', () => {
    const { home, from, target, backupDir } = handedOff();
    const before = readFileSync(stationHomeRestoreMarkerPath(home), 'utf8');
    expect(() =>
      writeStationHomeRestoreMarker(home, {
        fromRelease: target,
        targetRelease: from,
        backupDir,
      }),
    ).toThrow(StationHomeRestoreMarkerExistsError);
    expect(readFileSync(stationHomeRestoreMarkerPath(home), 'utf8')).toBe(
      before,
    );
  });

  it('is a live home root: a backup leaves it out and a restore leaves it alone', () => {
    expect(classifyStationHomeRoot(STATION_HOME_RESTORE_MARKER)).toBe('live');
    const { home, from } = handedOff();
    // A restore that does not clear (as the consumer does after it) shows
    // the marker survived it.
    consumeStationHomeRestoreMarker({
      homeDir: home,
      running: () => from,
      restore: (options) => {
        const result = restoreStationHomeUpdateBackup(options);
        expect(existsSync(stationHomeRestoreMarkerPath(home))).toBe(true);
        return result;
      },
    });
  });
});
