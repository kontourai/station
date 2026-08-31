import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  admitStationRuntimeHome,
  resolveRuntimeHome,
  resolveStationRoot,
  resolveStationRuntimeContext,
  runtimeInstancePath,
  stationProfilesPath,
} from '../runtime-path-resolver.js';

const roots: string[] = [];

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'station-runtime-home-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe('Station root runtime path resolver', () => {
  test('derives the root from a lone explicit STATION_HOME', () => {
    expect(
      resolveStationRoot({
        STATION_HOME: '/tmp/isolated-home',
      } as NodeJS.ProcessEnv),
    ).toBe('/tmp/isolated-home');
    expect(
      resolveStationRoot({
        STATION_HOME: '/tmp/isolated-root/instances/e2e',
      } as NodeJS.ProcessEnv),
    ).toBe('/tmp/isolated-root');
    expect(
      resolveStationRoot({
        STATION_HOME: '/tmp/isolated-root/instances/dev/e2e',
      } as NodeJS.ProcessEnv),
    ).toBe('/tmp/isolated-root');
  });

  test('keeps shared profiles at the root while channel runtimes are isolated', () => {
    const env = { STATION_ROOT: '/tmp/station-root' } as NodeJS.ProcessEnv;
    expect(resolveStationRoot(env)).toBe('/tmp/station-root');
    expect(stationProfilesPath(env)).toBe(
      '/tmp/station-root/config/profiles.json',
    );
    expect(runtimeInstancePath('stable', { env })).toBe(
      '/tmp/station-root/instances/stable',
    );
    expect(runtimeInstancePath('beta', { env })).toBe(
      '/tmp/station-root/instances/beta',
    );
    expect(runtimeInstancePath('nightly', { env })).toBe(
      '/tmp/station-root/instances/nightly',
    );
    expect(
      runtimeInstancePath('dev', { env, instanceId: 'dev-worktree-a1b2c3d4' }),
    ).toBe('/tmp/station-root/instances/dev/dev-worktree-a1b2c3d4');
  });

  test('honors STATION_HOME only for the selected runtime', () => {
    const env = {
      STATION_ROOT: '/tmp/station-root',
      STATION_HOME: '/tmp/runtime-override',
      STATION_CHANNEL: 'nightly',
    } as NodeJS.ProcessEnv;
    expect(resolveRuntimeHome(env)).toBe('/tmp/runtime-override');
    expect(stationProfilesPath(env)).toBe(
      '/tmp/station-root/config/profiles.json',
    );
  });

  test('refuses a development runtime without an existing identity', () => {
    expect(() =>
      resolveRuntimeHome({
        STATION_ROOT: '/tmp/station-root',
        STATION_CHANNEL: 'development',
      }),
    ).toThrow(/full-path-derived instance id/);
  });

  test('uses the stable runtime and API port outside a source bootstrap', () => {
    const context = resolveStationRuntimeContext({
      STATION_ROOT: '/tmp/station-root',
    } as NodeJS.ProcessEnv);
    expect(context).toMatchObject({
      channel: 'stable',
      stationRoot: '/tmp/station-root',
      home: '/tmp/station-root/instances/stable',
      serverPort: 18141,
      uiPort: 18000,
      consentPort: 18144,
    });
  });

  test('uses the bootstrap canonical dev identity rather than re-hashing its seed', () => {
    const env = {
      STATION_ROOT: '/tmp/station-root',
      STATION_CHANNEL: 'development',
      STATION_DEV_INSTANCE: 'a raw user seed',
      STATION_INSTANCE_ID: 'dev-source-checkout-a1b2c3d4',
    } as NodeJS.ProcessEnv;
    expect(resolveRuntimeHome(env)).toBe(
      '/tmp/station-root/instances/dev/dev-source-checkout-a1b2c3d4',
    );
  });

  test('rejects the ambient default root as a home when nothing was overridden', () => {
    // Regression: the self-rooted carve-out keyed only on `root === home` with
    // `STATION_ROOT` unset. With `STATION_HOME` ALSO unset the root is the
    // ambient `~/.station` default, so naming that directory as the home —
    // `station start --home=$HOME/.station`, or a script computing it —
    // satisfied the equality and was admitted. That hands a runtime instance
    // the shared root holding config/cache/installs: the exact escape this
    // guard exists to stop. The carve-out is legitimate only when the root was
    // genuinely derived from an explicit `STATION_HOME`.
    const fakeHomedir = fixtureRoot();
    const ambientRoot = join(fakeHomedir, '.station');
    mkdirSync(ambientRoot, { recursive: true });
    // `resolveStationRoot` falls back to `os.homedir()`, which reads the real
    // `HOME`, so the env argument alone cannot reach this branch — stub it,
    // and keep the developer's own `~/.station` out of the assertion.
    vi.stubEnv('HOME', fakeHomedir);
    const env = {} as NodeJS.ProcessEnv;
    // Precondition: with nothing overridden this IS the ambient default root.
    expect(resolveStationRoot(env)).toBe(ambientRoot);
    expect(() => admitStationRuntimeHome(ambientRoot, env)).toThrow(
      /shared Station root/,
    );
  });

  test('admits only concrete runtime leaves and never creates rejected paths', () => {
    const root = fixtureRoot();
    const env = { STATION_ROOT: root } as NodeJS.ProcessEnv;
    const rejected = [
      root,
      dirname(root),
      join(root, 'config'),
      join(root, 'config', 'profiles'),
      join(root, 'cache'),
      join(root, 'installs'),
      join(root, 'instances'),
      join(root, 'instances', 'dev'),
      join(root, 'instances', 'stable', 'nested'),
    ];

    for (const home of rejected) {
      expect(() => admitStationRuntimeHome(home, env)).toThrow(
        /not admissible/,
      );
      expect(existsSync(home)).toBe(home === root || home === dirname(root));
    }
    expect(
      admitStationRuntimeHome(join(root, 'instances', 'stable'), env),
    ).toBe(join(realpathSync(root), 'instances', 'stable'));
    expect(
      admitStationRuntimeHome(join(root, 'instances', 'dev', 'dev-proof'), env),
    ).toBe(join(realpathSync(root), 'instances', 'dev', 'dev-proof'));
    expect(admitStationRuntimeHome(join(root, 'instances', 'test'), env)).toBe(
      join(realpathSync(root), 'instances', 'test'),
    );
    const custom = fixtureRoot();
    expect(admitStationRuntimeHome(custom, env)).toBe(realpathSync(custom));
  });

  test('recognizes canonical aliases and keeps a fresh root creation-free', () => {
    const parent = fixtureRoot();
    const root = join(parent, 'root');
    mkdirSync(root);
    const alias = join(parent, 'root-alias');
    symlinkSync(root, alias);
    const env = { STATION_ROOT: root } as NodeJS.ProcessEnv;

    expect(() => admitStationRuntimeHome(join(alias, 'config'), env)).toThrow(
      /not admissible/,
    );
    expect(
      admitStationRuntimeHome(join(alias, 'instances', 'stable'), env),
    ).toBe(join(realpathSync(root), 'instances', 'stable'));

    const missingRoot = join(parent, 'fresh-root');
    expect(
      admitStationRuntimeHome(join(missingRoot, 'instances', 'stable'), {
        STATION_ROOT: missingRoot,
      } as NodeJS.ProcessEnv),
    ).toBe(join(realpathSync(parent), 'fresh-root', 'instances', 'stable'));
    expect(existsSync(missingRoot)).toBe(false);
  });

  test('rejects every unsafe shared container before unrelated homes are admitted', () => {
    for (const name of [
      'config',
      'cache',
      'installs',
      'instances',
      'instances/dev',
    ]) {
      const parent = fixtureRoot();
      const root = join(parent, 'root');
      const outside = join(parent, 'outside');
      mkdirSync(root);
      mkdirSync(outside);
      if (name.includes('/')) mkdirSync(join(root, 'instances'));
      const env = { STATION_ROOT: root } as NodeJS.ProcessEnv;
      const target = join(outside, name);
      mkdirSync(target, { recursive: true });
      symlinkSync(target, join(root, name));
      for (const candidate of [
        join(root, name, 'runtime'),
        join(target, 'runtime'),
        join(outside, 'unrelated-runtime'),
      ]) {
        expect(() => admitStationRuntimeHome(candidate, env)).toThrow(
          /not admissible/,
        );
        expect(existsSync(candidate)).toBe(false);
      }
    }
  });

  test('rejects dangling and non-directory shared containers', () => {
    for (const kind of ['dangling', 'file'] as const) {
      const parent = fixtureRoot();
      const root = join(parent, 'root');
      mkdirSync(root);
      const container = join(root, 'cache');
      if (kind === 'dangling') symlinkSync(join(parent, 'missing'), container);
      else writeFileSync(container, 'not a directory');
      expect(() =>
        admitStationRuntimeHome(join(parent, 'external'), {
          STATION_ROOT: root,
        } as NodeJS.ProcessEnv),
      ).toThrow(/unsafe|inspected/);
    }
  });

  test.skipIf(!['darwin', 'win32'].includes(process.platform))(
    'rejects differently cased shared containers before they can be created',
    () => {
      const root = fixtureRoot();
      const env = { STATION_ROOT: root } as NodeJS.ProcessEnv;
      for (const segments of [
        ['CONFIG'],
        ['CACHE'],
        ['INSTALLS'],
        ['INSTANCES'],
        ['instances', 'DEV'],
      ]) {
        const candidate = join(root, ...segments);
        expect(() => admitStationRuntimeHome(candidate, env)).toThrow(
          /not admissible/,
        );
        expect(existsSync(candidate)).toBe(false);
      }
    },
  );
});
