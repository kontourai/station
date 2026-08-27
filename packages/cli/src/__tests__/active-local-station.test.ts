import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  activeLocalStationPath,
  publishActiveLocalStation,
  readActiveLocalStation,
  removeOwnedActiveLocalStation,
} from '../commands/active-local-station.js';

const roots: string[] = [];

function record(value: unknown, mode = 0o600): string {
  const root = mkdtempSync(join(tmpdir(), 'station-active-local-'));
  roots.push(root);
  const path = join(root, 'active-local.json');
  writeFileSync(path, JSON.stringify(value), { mode });
  chmodSync(path, mode);
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('active local Station record', () => {
  test('publishes a secured record and removes only the exact owner', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-active-local-home-'));
    roots.push(root);
    const owned = {
      apiBase: 'http://127.0.0.1:56050',
      ownerPid: process.pid,
    };

    publishActiveLocalStation(owned, root);
    const path = activeLocalStationPath(root);
    expect(readActiveLocalStation({ path })).toBe(owned.apiBase);

    removeOwnedActiveLocalStation(
      { ...owned, ownerPid: process.pid + 1 },
      root,
    );
    expect(readActiveLocalStation({ path })).toBe(owned.apiBase);

    removeOwnedActiveLocalStation(owned, root);
    expect(readActiveLocalStation({ path })).toBeUndefined();
  });

  test('restores a replacement that lands after cleanup opens the owned record', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-active-local-race-'));
    roots.push(root);
    const owned = {
      apiBase: 'http://127.0.0.1:56050',
      ownerPid: process.pid,
    };
    publishActiveLocalStation(owned, root);
    const replacement = {
      schemaVersion: 1,
      apiBase: 'http://127.0.0.2:56051',
      ownerPid: process.pid + 1,
    };

    expect(() =>
      removeOwnedActiveLocalStation(owned, root, {
        afterOpened: (path) =>
          writeFileSync(path, JSON.stringify(replacement), { mode: 0o600 }),
      }),
    ).toThrow(/changed during removal/);

    expect(
      JSON.parse(readFileSync(activeLocalStationPath(root), 'utf8')),
    ).toEqual(replacement);
  });

  test('accepts an owner-safe live loopback origin', () => {
    const path = record({
      schemaVersion: 1,
      apiBase: 'http://127.0.0.1:56050',
      ownerPid: 123,
    });

    expect(readActiveLocalStation({ path, isProcessAlive: () => true })).toBe(
      'http://127.0.0.1:56050',
    );
  });

  test.each([
    'https://127.0.0.1:56050',
    'http://station.example.test:56050',
    'http://127.0.0.1:56050/path',
    'http://127.attacker.test:56050',
    'http://127.0.0.1.evil.test:56050',
    'http://user@127.0.0.1:56050',
    'not-a-url',
  ])('rejects unsafe origin %s', (apiBase) => {
    const path = record({ schemaVersion: 1, apiBase, ownerPid: 123 });
    expect(
      readActiveLocalStation({ path, isProcessAlive: () => true }),
    ).toBeUndefined();
  });

  test('rejects a stale owner process', () => {
    const path = record({
      schemaVersion: 1,
      apiBase: 'http://127.0.0.1:56050',
      ownerPid: 123,
    });
    expect(
      readActiveLocalStation({ path, isProcessAlive: () => false }),
    ).toBeUndefined();
  });

  test('rejects malformed, group-readable, and symlink records', () => {
    const malformed = record('{');
    expect(
      readActiveLocalStation({
        path: malformed,
        isProcessAlive: () => true,
      }),
    ).toBeUndefined();

    const readable = record(
      {
        schemaVersion: 1,
        apiBase: 'http://127.0.0.1:56050',
        ownerPid: 123,
      },
      0o644,
    );
    expect(
      readActiveLocalStation({
        path: readable,
        isProcessAlive: () => true,
      }),
    ).toBeUndefined();

    const root = mkdtempSync(join(tmpdir(), 'station-active-local-link-'));
    roots.push(root);
    const target = record({
      schemaVersion: 1,
      apiBase: 'http://127.0.0.1:56050',
      ownerPid: 123,
    });
    const link = join(root, 'active-local.json');
    symlinkSync(target, link);
    expect(
      readActiveLocalStation({ path: link, isProcessAlive: () => true }),
    ).toBeUndefined();
  });
});
