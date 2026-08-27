import { existsSync, mkdirSync, mkdtempSync, utimesSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  createStationTempDir,
  createStationTempDirSync,
  listStationTempEntries,
  removeStationTempDirSync,
  stationTempRoot,
  sweepStationTempRoot,
} from '../temp-dir.js';

let sandbox: string;
let previousRoot: string | undefined;

beforeEach(() => {
  previousRoot = process.env.STATION_TEMP_ROOT;
  sandbox = mkdtempSync(join(tmpdir(), 'temp-dir-spec-'));
  process.env.STATION_TEMP_ROOT = join(sandbox, 'root');
});

afterEach(async () => {
  if (previousRoot === undefined) delete process.env.STATION_TEMP_ROOT;
  else process.env.STATION_TEMP_ROOT = previousRoot;
  await rm(sandbox, { recursive: true, force: true });
});

describe('station temp directories', () => {
  test('creates directories under the Station-owned root, not the system temp dir', () => {
    const directory = createStationTempDirSync('registry-plugin');

    expect(directory.startsWith(stationTempRoot())).toBe(true);
    expect(existsSync(directory)).toBe(true);
  });

  test('honours STATION_TEMP_ROOT so a run can own and delete every artifact', async () => {
    const directory = await createStationTempDir('command-evidence');

    expect(directory.startsWith(join(sandbox, 'root'))).toBe(true);
  });

  test('lists entries by prefix without reading the system temp directory', async () => {
    createStationTempDirSync('registry-plugin');
    createStationTempDirSync('registry-plugin');
    createStationTempDirSync('plugin-update');

    await expect(
      listStationTempEntries('registry-plugin'),
    ).resolves.toHaveLength(2);
    await expect(listStationTempEntries('plugin-update')).resolves.toHaveLength(
      1,
    );
    await expect(listStationTempEntries()).resolves.toHaveLength(3);
  });

  test('reports an empty list rather than throwing when the root does not exist', async () => {
    process.env.STATION_TEMP_ROOT = join(sandbox, 'never-created');

    await expect(listStationTempEntries()).resolves.toEqual([]);
  });

  test('rejects prefixes that would escape the root', () => {
    expect(() => createStationTempDirSync('../escape')).toThrow(/plain label/);
    expect(() => createStationTempDirSync('nested/dir')).toThrow(/plain label/);
    expect(() => createStationTempDirSync('')).toThrow(/plain label/);
  });

  test('removal is idempotent and never throws on a missing directory', () => {
    const directory = createStationTempDirSync('plugin-install');

    removeStationTempDirSync(directory);
    expect(existsSync(directory)).toBe(false);
    expect(() => removeStationTempDirSync(directory)).not.toThrow();
  });

  test('sweeps directories older than the age threshold and keeps live ones', async () => {
    const stale = createStationTempDirSync('assignment-claim');
    const live = createStationTempDirSync('assignment-claim');
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    utimesSync(stale, twoDaysAgo, twoDaysAgo);

    await expect(sweepStationTempRoot()).resolves.toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(live)).toBe(true);
  });

  test('sweeping an absent root is a no-op', async () => {
    process.env.STATION_TEMP_ROOT = join(sandbox, 'absent');

    await expect(sweepStationTempRoot()).resolves.toBe(0);
  });

  test('falls back to the system temp dir when no override is set', () => {
    delete process.env.STATION_TEMP_ROOT;

    expect(stationTempRoot()).toBe(join(tmpdir(), 'station'));
  });

  test('creates the root on demand', () => {
    const root = join(sandbox, 'lazy-root');
    process.env.STATION_TEMP_ROOT = root;
    expect(existsSync(root)).toBe(false);

    createStationTempDirSync('plugin-uninstall');

    expect(existsSync(root)).toBe(true);
  });

  test('tolerates a pre-existing root directory', () => {
    mkdirSync(stationTempRoot(), { recursive: true });

    expect(() => createStationTempDirSync('dev-home')).not.toThrow();
  });
});
