import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  configureApiCredential,
  parseCoreArgs,
  resolveApiBase,
} from '../commands/core-api.js';
import { DEFAULT_SERVER_PORT } from '../commands/helpers.js';
import { upsertProfile } from '../commands/profile-store.js';

describe('resolveApiBase', () => {
  const originalProfile = process.env.STATION_TARGET;
  const originalPort = process.env.STATION_PORT;
  const originalHome = process.env.STATION_HOME;
  const originalRoot = process.env.STATION_ROOT;
  let stationHome: string;
  let stationRoot: string;

  beforeEach(() => {
    stationRoot = mkdtempSync(join(tmpdir(), 'station-core-api-root-'));
    stationHome = join(stationRoot, 'instances', 'stable');
    mkdirSync(stationHome, { recursive: true, mode: 0o700 });
    process.env.STATION_HOME = stationHome;
    process.env.STATION_ROOT = stationRoot;
    delete process.env.STATION_TARGET;
    delete process.env.STATION_PORT;
  });

  afterEach(() => {
    if (originalProfile === undefined) {
      delete process.env.STATION_TARGET;
    } else {
      process.env.STATION_TARGET = originalProfile;
    }
    if (originalPort === undefined) {
      delete process.env.STATION_PORT;
    } else {
      process.env.STATION_PORT = originalPort;
    }
    if (originalHome === undefined) {
      delete process.env.STATION_HOME;
    } else {
      process.env.STATION_HOME = originalHome;
    }
    if (originalRoot === undefined) delete process.env.STATION_ROOT;
    else process.env.STATION_ROOT = originalRoot;
    rmSync(stationRoot, { recursive: true, force: true });
  });

  it('passes through a bare origin unchanged', () => {
    const parsed = parseCoreArgs(['--api-base=http://127.0.0.1:3350']);
    expect(resolveApiBase(parsed)).toBe('http://127.0.0.1:3350');
  });

  it('strips a trailing /api suffix from the --api-base flag', () => {
    const parsed = parseCoreArgs(['--api-base=http://127.0.0.1:3350/api']);
    expect(resolveApiBase(parsed)).toBe('http://127.0.0.1:3350');
  });

  it('strips a trailing /api/ suffix (with trailing slash) from the --api-base flag', () => {
    const parsed = parseCoreArgs(['--api-base=http://127.0.0.1:3350/api/']);
    expect(resolveApiBase(parsed)).toBe('http://127.0.0.1:3350');
  });

  it('strips a bare trailing slash with no /api suffix', () => {
    const parsed = parseCoreArgs(['--api-base=http://127.0.0.1:3350/']);
    expect(resolveApiBase(parsed)).toBe('http://127.0.0.1:3350');
  });

  it('resolves STATION_TARGET through the saved Station store', () => {
    upsertProfile({ name: 'remote', endpoint: 'http://host.example:3350' });
    process.env.STATION_TARGET = 'remote';
    const parsed = parseCoreArgs([]);
    expect(resolveApiBase(parsed)).toBe('http://host.example:3350');
  });

  it('prefers the explicit --api-base flag over STATION_TARGET', () => {
    upsertProfile({ name: 'remote', endpoint: 'http://env-host:3350' });
    process.env.STATION_TARGET = 'remote';
    const parsed = parseCoreArgs(['--api-base=http://flag-host:3350/api']);
    expect(resolveApiBase(parsed)).toBe('http://flag-host:3350');
  });

  it('refuses to attach an explicit bearer to non-loopback HTTP', () => {
    const parsed = parseCoreArgs(['--credential=bearer']);
    expect(() =>
      configureApiCredential(parsed, 'http://host.example.test'),
    ).toThrow(/bearer credentials require HTTPS/);
  });

  it('permits bearer attachment to strict loopback HTTP', () => {
    const parsed = parseCoreArgs(['--credential=bearer']);
    expect(() =>
      configureApiCredential(parsed, 'http://127.0.0.1:3141'),
    ).not.toThrow();
  });

  it('falls back to 127.0.0.1 with STATION_PORT when nothing is set', () => {
    process.env.STATION_PORT = '4242';
    const parsed = parseCoreArgs([]);
    expect(resolveApiBase(parsed)).toBe('http://127.0.0.1:4242');
  });

  it('falls back to the current runtime port when nothing is set', () => {
    const parsed = parseCoreArgs([]);
    expect(resolveApiBase(parsed)).toBe(
      `http://127.0.0.1:${process.env.STATION_PORT || DEFAULT_SERVER_PORT}`,
    );
  });

  // #174 carry-along (#167 AC5): normalizeApiBase's `/api$/` strip is
  // segment-anchored (requires a leading slash before "api"), so a hostname
  // that merely *contains* "api" as a substring must survive untouched --
  // guards against a future regression to a naive `.replace(/api$/, '')`
  // (no leading-slash anchor) that would incorrectly strip "api" off the
  // end of a hostname like "api.example.com".
  it('leaves a hostname that merely contains "api" as a substring unchanged', () => {
    const parsed = parseCoreArgs(['--api-base=http://api.example.com']);
    expect(resolveApiBase(parsed)).toBe('http://api.example.com');
  });

  it('still strips a trailing /api suffix on a hostname that also contains "api"', () => {
    const parsed = parseCoreArgs(['--api-base=http://api.example.com/api']);
    expect(resolveApiBase(parsed)).toBe('http://api.example.com');
  });
});
