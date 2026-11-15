import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  consumeStationCompileCacheEnv,
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
  // Back to "no active cache" for the next test.
  consumeStationCompileCacheEnv({}, undefined);
});

describe('consumeStationCompileCacheEnv', () => {
  test('removes the setting and forwards only the cache Node is using', () => {
    const env: NodeJS.ProcessEnv = { NODE_COMPILE_CACHE: '/home/cache/nc' };
    consumeStationCompileCacheEnv(env, `/home/cache/nc/${NODE_VERSION_DIR}`);
    expect(env).not.toHaveProperty('NODE_COMPILE_CACHE');
    expect(withStationCompileCache({ A: '1' })).toEqual({
      A: '1',
      NODE_COMPILE_CACHE: '/home/cache/nc',
    });
  });

  test('does not forward a setting Node is not using', () => {
    // Disabled (NODE_DISABLE_COMPILE_CACHE=1) or unset at startup.
    const env: NodeJS.ProcessEnv = { NODE_COMPILE_CACHE: '/home/cache/nc' };
    consumeStationCompileCacheEnv(env, undefined);
    expect(env).not.toHaveProperty('NODE_COMPILE_CACHE');
    expect(withStationCompileCache({ A: '1' })).toEqual({ A: '1' });
    // A value that differs from the active cache, as a .env file supplies
    // after startup.
    consumeStationCompileCacheEnv(
      { NODE_COMPILE_CACHE: '/dotenv/cache' },
      `/home/cache/nc/${NODE_VERSION_DIR}`,
    );
    expect(withStationCompileCache({})).toEqual({});
    // A sibling whose name only starts with the requested root.
    consumeStationCompileCacheEnv(
      { NODE_COMPILE_CACHE: '/home/cache/nc' },
      `/home/cache/nc-other/${NODE_VERSION_DIR}`,
    );
    expect(withStationCompileCache({})).toEqual({});
  });
});

describe('built-in child environment', () => {
  const definition = (path: string) => ({
    kind: 'mcp' as const,
    transport: 'stdio' as const,
    command: 'node',
    args: [path],
  });

  test('station-control and station-knowledge get the cache; third-party and spoofed children do not', () => {
    consumeStationCompileCacheEnv(
      { NODE_COMPILE_CACHE: '/home/cache/nc' },
      `/home/cache/nc/${NODE_VERSION_DIR}`,
    );
    expect(
      withStationControlRuntimeEnv(
        'station-control',
        definition(builtinStationControlServerPath()),
        {},
      ),
    ).toMatchObject({ NODE_COMPILE_CACHE: '/home/cache/nc' });
    expect(
      withStationControlRuntimeEnv(
        'station-knowledge',
        definition(builtinStationKnowledgeServerPath()),
        {},
      ),
    ).toMatchObject({ NODE_COMPILE_CACHE: '/home/cache/nc' });
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
    consumeStationCompileCacheEnv({ NODE_COMPILE_CACHE: root }, active);
    return { root, active, stale, recent };
  }

  test("removes another version's cache only once nothing has written it for 30 days", async () => {
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
    // The active version is kept however old: reads do not touch it.
    expect(existsSync(join(active, 'entry'))).toBe(true);
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

  test("never prunes a cache that is not this home's own", async () => {
    const home = tempDir('station-compile-cache-');
    const { stale, active } = seedCache(home);
    const otherHome = tempDir('station-compile-cache-other-');
    expect(
      scheduleStationCompileCachePrune(otherHome, {
        activeDir: active,
        delayMs: 0,
        now: NOW,
      }),
    ).toBeUndefined();
    // No active cache at all.
    consumeStationCompileCacheEnv({}, undefined);
    expect(
      scheduleStationCompileCachePrune(home, { delayMs: 0, now: NOW }),
    ).toBeUndefined();
    expect(existsSync(stale)).toBe(true);
  });
});
