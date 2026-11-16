import {
  existsSync,
  mkdirSync,
  readdirSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { adoptStationCompileCache } from '../adopt-compile-cache.js';
import {
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
const silent = () => {};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('withStationCompileCache', () => {
  test("adds the home's cache directory, existing or not yet created", () => {
    const home = tempDir('station-compile-cache-home-');
    const expected = {
      A: '1',
      NODE_COMPILE_CACHE: resolve(home, 'cache', 'node-compile'),
    };
    const options = { resolveHome: () => home, parent: {}, warn: silent };
    expect(withStationCompileCache({ A: '1' }, options)).toEqual(expected);
    mkdirSync(join(home, 'cache', 'node-compile'), { recursive: true });
    expect(withStationCompileCache({ A: '1' }, options)).toEqual(expected);
  });

  test('adds nothing when the operator disabled the cache or the home is unavailable', () => {
    const home = tempDir('station-compile-cache-home-');
    expect(
      withStationCompileCache(
        { A: '1' },
        {
          resolveHome: () => home,
          parent: { NODE_DISABLE_COMPILE_CACHE: '1' },
          warn: silent,
        },
      ),
    ).toEqual({ A: '1' });
    expect(
      withStationCompileCache(
        { A: '1' },
        {
          resolveHome: () => {
            throw new Error('home refused');
          },
          parent: {},
          warn: silent,
        },
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
  const definition = (id: string, path: string) => ({
    id,
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
        definition('station-control', builtinStationControlServerPath()),
        {},
      ),
    ).toMatchObject({ NODE_COMPILE_CACHE: cache });
    expect(
      withStationControlRuntimeEnv(
        'station-knowledge',
        definition('station-knowledge', builtinStationKnowledgeServerPath()),
        {},
      ),
    ).toMatchObject({ NODE_COMPILE_CACHE: cache });
    expect(
      withStationControlRuntimeEnv(
        'third-party',
        definition('third-party', builtinStationControlServerPath()),
        { SAFE: 'value' },
      ),
    ).toEqual({ SAFE: 'value' });
    expect(
      withStationControlRuntimeEnv(
        'station-control',
        definition('station-control', '/tmp/station-control.js'),
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

describe('a cache root that is not a plain directory in the home', () => {
  const DAY_MS = 24 * 60 * 60_000;
  const NOW = Date.UTC(2026, 10, 1);
  const old = (NOW - 400 * DAY_MS) / 1000;

  /** An operator's directory outside the home: one old subdirectory and one
   * recent 4 KiB file, what both prune passes would remove if they reached
   * it. */
  function outsideTree(
    outside: string = tempDir('station-compile-cache-outside-'),
  ) {
    mkdirSync(join(outside, 'old-dir'), { recursive: true });
    writeFileSync(join(outside, 'old-dir', 'keep-me'), 'x');
    utimesSync(join(outside, 'old-dir'), old, old);
    writeFileSync(join(outside, 'recent-file'), Buffer.alloc(4096));
    return outside;
  }

  const untouched = (outside: string) => {
    expect(readdirSync(outside).sort()).toEqual(['old-dir', 'recent-file']);
    expect(existsSync(join(outside, 'old-dir', 'keep-me'))).toBe(true);
  };

  /** `link` links part of the home's cache path out of the home and returns
   * the directory a prune following that link would act on. */
  async function refusesLinkedRoot(link: (home: string) => string) {
    const home = tempDir('station-compile-cache-home-');
    const outside = outsideTree(link(home));
    const warn = vi.fn();
    // Over the size bound and with an old directory: both passes would act.
    const pruned = await scheduleStationCompileCachePrune(home, {
      delayMs: 0,
      now: NOW,
      maxBytes: 1,
      warn,
    });
    untouched(outside);
    expect(pruned).toBeUndefined();
    // The children are not handed it either, and the refusal is logged once
    // for the home across both uses.
    expect(
      withStationCompileCache(
        {},
        { resolveHome: () => home, parent: {}, warn },
      ),
    ).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toMatchObject({
      reason: expect.stringContaining('symbolic link'),
    });
  }

  test('a linked cache directory is neither pruned nor handed to children', async () => {
    await refusesLinkedRoot((home) => {
      const shared = tempDir('station-compile-cache-shared-');
      symlinkSync(shared, join(home, 'cache'), 'dir');
      return join(shared, 'node-compile');
    });
  });

  test('a linked node-compile directory is neither pruned nor handed to children', async () => {
    await refusesLinkedRoot((home) => {
      const shared = tempDir('station-compile-cache-shared-');
      mkdirSync(join(home, 'cache'));
      symlinkSync(shared, join(home, 'cache', 'node-compile'), 'dir');
      return shared;
    });
  });

  test('a link inside the root is never followed: its target survives both prune passes', async () => {
    const home = tempDir('station-compile-cache-home-');
    const outside = outsideTree();
    const root = join(home, 'cache', 'node-compile');
    mkdirSync(join(root, NODE_VERSION_DIR), { recursive: true });
    writeFileSync(join(root, NODE_VERSION_DIR, 'entry'), Buffer.alloc(1024));
    symlinkSync(outside, join(root, 'v0.0.0-linked-dir'), 'dir');
    // Old enough that the age pass would remove it, if it followed the link.
    utimesSync(outside, old, old);
    symlinkSync(
      join(outside, 'recent-file'),
      join(root, NODE_VERSION_DIR, 'linked-file'),
    );
    // Age pass: the link is not a directory to age out.
    const aged = await scheduleStationCompileCachePrune(home, {
      activeDir: join(root, NODE_VERSION_DIR),
      delayMs: 0,
      now: NOW,
      warn: silent,
    });
    expect(aged).toMatchObject({
      removedVersionDirs: [],
      // The 4 KiB file behind the link is not counted.
      totalBytes: 1024,
      clearedForSize: false,
    });
    untouched(outside);
    // Size pass: removing the cache removes the links, not their targets.
    const cleared = await scheduleStationCompileCachePrune(home, {
      delayMs: 0,
      now: NOW,
      maxBytes: 1,
      warn: silent,
    });
    expect(cleared).toMatchObject({ clearedForSize: true });
    expect(readdirSync(root)).toEqual([]);
    untouched(outside);
  });
});
