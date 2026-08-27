import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { parseCoreArgs, resolveApiBaseDetailed } from '../commands/core-api.js';
import {
  clearProjectProfile,
  readProfileStore,
  setProjectProfile,
  upsertProfile,
} from '../commands/profile-store.js';

let home: string;
let previousHome: string | undefined;
let previousRoot: string | undefined;
let previousProfile: string | undefined;
let previousInvokedCwd: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'station-profile-resolve-'));
  previousHome = process.env.STATION_HOME;
  previousRoot = process.env.STATION_ROOT;
  previousProfile = process.env.STATION_TARGET;
  previousInvokedCwd = process.env.STATION_INVOKED_CWD;
  process.env.STATION_HOME = home;
  process.env.STATION_ROOT = home;
  delete process.env.STATION_TARGET;
  delete process.env.STATION_INVOKED_CWD;
  upsertProfile({
    name: 'kontour',
    endpoint: 'http://127.0.0.1:3141',
    makeDefault: true,
  });
  upsertProfile({ name: 'remote', endpoint: 'https://station.example.test' });
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.STATION_HOME;
  else process.env.STATION_HOME = previousHome;
  if (previousRoot === undefined) delete process.env.STATION_ROOT;
  else process.env.STATION_ROOT = previousRoot;
  if (previousProfile === undefined) delete process.env.STATION_TARGET;
  else process.env.STATION_TARGET = previousProfile;
  if (previousInvokedCwd === undefined) delete process.env.STATION_INVOKED_CWD;
  else process.env.STATION_INVOKED_CWD = previousInvokedCwd;
  rmSync(home, { recursive: true, force: true });
});

describe('saved Station target resolution', () => {
  test('rejects ambiguous saved-Station and direct endpoint selection', () => {
    expect(() =>
      resolveApiBaseDetailed(
        parseCoreArgs([
          '--api-base=https://bootstrap.example',
          '--station=remote',
        ]),
      ),
    ).toThrow(/pass exactly one/);
  });
  test('uses explicit Station, environment target, then selected default', () => {
    expect(resolveApiBaseDetailed(parseCoreArgs(['--station=remote']))).toEqual(
      {
        apiBase: 'https://station.example.test',
        source: 'station-flag',
        station: 'remote',
      },
    );
    process.env.STATION_TARGET = 'remote';
    expect(resolveApiBaseDetailed(parseCoreArgs([]))).toEqual({
      apiBase: 'https://station.example.test',
      source: 'station-env',
      station: 'remote',
    });
    delete process.env.STATION_TARGET;
    expect(resolveApiBaseDetailed(parseCoreArgs([]))).toEqual({
      apiBase: 'http://127.0.0.1:3141',
      source: 'default-station',
      station: 'kontour',
    });
  });
  test('does not fall through after an explicit unavailable Station', () => {
    expect(() =>
      resolveApiBaseDetailed(parseCoreArgs(['--station=missing'])),
    ).toThrow(/No Station named "missing"/);
  });

  test('uses an owner-controlled project mapping after STATION_TARGET', () => {
    const project = mkdtempSync(join(tmpdir(), 'station-project-station-'));
    try {
      setProjectProfile('remote', project);
      process.env.STATION_INVOKED_CWD = project;
      expect(resolveApiBaseDetailed(parseCoreArgs([]))).toEqual({
        apiBase: 'https://station.example.test',
        source: 'project-station',
        station: 'remote',
      });
      expect(readProfileStore().projectProfiles).toEqual({
        [realpathSync(project)]: 'remote',
      });
      expect(existsSync(join(project, '.station', 'profile.json'))).toBe(false);
      expect(clearProjectProfile(project)).toBeUndefined();
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
