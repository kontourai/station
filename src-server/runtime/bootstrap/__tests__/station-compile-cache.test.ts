import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  adoptStationCompileCache,
  scheduleStationCompileCachePrune,
  withStationCompileCache,
} from '../station-compile-cache.js';
import {
  builtinStationControlServerPath,
  builtinStationKnowledgeServerPath,
  withStationControlRuntimeEnv,
} from '../station-control-runtime-env.js';

const tempDir = trackTempDirs();
const NODE_VERSION_DIR = 'v24.0.0-arm64-00000000-501';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('withStationCompileCache', () => {
  test("adds the home's cache directory", () => {
    expect(
      withStationCompileCache({ A: '1' }, () => '/station/home', {}),
    ).toEqual({
      A: '1',
      NODE_COMPILE_CACHE: resolve('/station/home/cache/node-compile'),
    });
  });

  test('adds nothing when the operator disabled the cache or the home is unavailable', () => {
    expect(
      withStationCompileCache({ A: '1' }, () => '/station/home', {
        NODE_DISABLE_COMPILE_CACHE: '1',
      }),
    ).toEqual({ A: '1' });
    expect(
      withStationCompileCache(
        { A: '1' },
        () => {
          throw new Error('home refused');
        },
        {},
      ),
    ).toEqual({ A: '1' });
  });
});

describe('adoptStationCompileCache', () => {
  test("removes the setting from the child's own environment", () => {
    const env: NodeJS.ProcessEnv = { NODE_COMPILE_CACHE: '/x', KEEP: '1' };
    adoptStationCompileCache(env);
    expect(env).toEqual({ KEEP: '1' });
  });
});

describe('built-in child environment', () => {
  const definition = (path: string) => ({
    kind: 'mcp' as const,
    transport: 'stdio' as const,
    command: 'node',
    args: [path],
  });

  test('station-control and station-knowledge get the home cache; third-party and spoofed children do not', () => {
    const home = tempDir('station-compile-cache-home-');
    vi.stubEnv('STATION_HOME', home);
    vi.stubEnv('NODE_DISABLE_COMPILE_CACHE', '');
    const cache = resolve(home, 'cache', 'node-compile');
    expect(
      withStationControlRuntimeEnv(
        'station-control',
        definition(builtinStationControlServerPath()),
        {},
      ),
    ).toMatchObject({ NODE_COMPILE_CACHE: cache });
    expect(
      withStationControlRuntimeEnv(
        'station-knowledge',
        definition(builtinStationKnowledgeServerPath()),
        {},
      ),
    ).toMatchObject({ NODE_COMPILE_CACHE: cache });
    expect(
      withStationControlRuntimeEnv(
        'third-party',
        definition(builtinStationControlServerPath()),
        { SAFE: 'value' },
      ),
    ).toEqual({ SAFE: 'value' });
    expect(
      withStationControlRuntimeEnv(
        'station-control',
        definition('/tmp/station-control.js'),
        {},
      ),
    ).not.toHaveProperty('NODE_COMPILE_CACHE');
  });
});

describe('scheduleStationCompileCachePrune', () => {
  const DAY_MS = 24 * 60 * 60_000;
  const NOW = Date.UTC(2026, 10, 1);

  function seedCache(home: string) {
    const root = join(home, 'cache', 'node-compile');
    const active = join(root, NODE_VERSION_DIR);
    const stale = join(root, 'v22.0.0-arm64-11111111-501');
    const recent = join(root, 'v23.0.0-arm64-22222222-501');
    for (const dir of [active, stale, recent]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'entry'), Buffer.alloc(1024));
    }
    // 31 and 29 days before NOW: either side of the 30-day limit.
    const at = (days: number) => (NOW - days * DAY_MS) / 1000;
    utimesSync(stale, at(31), at(31));
    utimesSync(recent, at(29), at(29));
    utimesSync(active, at(400), at(400));
    return { root, active, stale, recent };
  }

  test("removes a version's cache only once nothing has written it for 30 days, keeping this process's own", async () => {
    const home = tempDir('station-compile-cache-');
    const { active, stale, recent } = seedCache(home);
    const result = await scheduleStationCompileCachePrune(home, {
      activeDir: active,
      delayMs: 0,
      now: NOW,
    });
    expect(result).toMatchObject({
      removedVersionDirs: ['v22.0.0-arm64-11111111-501'],
      clearedForSize: false,
    });
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    // Reads never touch it, so age alone must not remove the active one.
    expect(existsSync(join(active, 'entry'))).toBe(true);
  });

  test('without a cache of its own, ages every version alike', async () => {
    const home = tempDir('station-compile-cache-');
    const { active, recent } = seedCache(home);
    const result = await scheduleStationCompileCachePrune(home, {
      activeDir: join(home, 'elsewhere', NODE_VERSION_DIR),
      delayMs: 0,
      now: NOW,
    });
    expect(result?.removedVersionDirs.sort()).toEqual([
      'v22.0.0-arm64-11111111-501',
      NODE_VERSION_DIR,
    ]);
    expect(existsSync(active)).toBe(false);
    expect(existsSync(recent)).toBe(true);
  });

  test('clears the whole cache once it is over the size bound', async () => {
    const home = tempDir('station-compile-cache-');
    const { root, active, recent } = seedCache(home);
    // Two 1 KiB entries remain after the stale one goes.
    const result = await scheduleStationCompileCachePrune(home, {
      activeDir: active,
      delayMs: 0,
      now: NOW,
      maxBytes: 2047,
    });
    expect(result).toMatchObject({ totalBytes: 2048, clearedForSize: true });
    expect(existsSync(root)).toBe(true);
    expect(existsSync(active)).toBe(false);
    expect(existsSync(recent)).toBe(false);
  });

  test('resolves without pruning when the home has no cache', async () => {
    const home = tempDir('station-compile-cache-');
    await expect(
      scheduleStationCompileCachePrune(home, { delayMs: 0, now: NOW }),
    ).resolves.toBeUndefined();
  });
});
