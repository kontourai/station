import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  admitStationRuntimeHome,
  resolveRuntimeHome,
} from '@kontourai/station-shared/runtime-path-resolver';
import { describe, expect, test, vi } from 'vitest';
import { initializeSourceBootstrap } from '../source-bootstrap.js';

const wrapperUrl = pathToFileURL(resolve('scripts/station-cli.ts')).href;

function sourceEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    STATION_ROOT: '/tmp/station-bootstrap-root',
    ...overrides,
  };
}

describe('source Station bootstrap', () => {
  test('anchors one checkout identity to its code root, not either project cwd', () => {
    const first = sourceEnv({ STATION_INVOKED_CWD: '/projects/first' });
    const second = sourceEnv({ STATION_INVOKED_CWD: '/projects/second' });

    const firstContext = initializeSourceBootstrap({ env: first, wrapperUrl });
    const secondContext = initializeSourceBootstrap({
      env: second,
      wrapperUrl,
    });

    expect(secondContext).toEqual(firstContext);
    expect(resolveRuntimeHome(first)).toBe(resolveRuntimeHome(second));
    expect(first.STATION_HOME).toBeUndefined();
    expect(first.STATION_INSTANCE_ID).toBe(firstContext.instanceId);
  });

  test('separates two source worktree code roots without double-hashing a raw seed', () => {
    const one = sourceEnv({ STATION_DEV_INSTANCE: 'alpha' });
    const two = sourceEnv({ STATION_DEV_INSTANCE: 'alpha' });
    const oneContext = initializeSourceBootstrap({
      env: one,
      wrapperUrl: 'file:///tmp/station-worktrees/one/scripts/station-cli.ts',
    });
    const twoContext = initializeSourceBootstrap({
      env: two,
      wrapperUrl: 'file:///tmp/station-worktrees/two/scripts/station-cli.ts',
    });

    // An explicit seed intentionally names the same instance across worktrees.
    expect(oneContext.instanceId).toBe('dev-alpha');
    expect(twoContext.instanceId).toBe('dev-alpha');
    expect(one.STATION_DEV_INSTANCE).toBe('alpha');
    expect(one.STATION_INSTANCE_ID).toBe('dev-alpha');
    expect(resolveRuntimeHome(one)).toBe(
      '/tmp/station-bootstrap-root/instances/dev/dev-alpha',
    );
  });

  test('derives distinct identities and ports for two unseeded code worktrees', () => {
    const one = sourceEnv();
    const two = sourceEnv();
    const oneContext = initializeSourceBootstrap({
      env: one,
      wrapperUrl: 'file:///tmp/station-worktrees/one/scripts/station-cli.ts',
    });
    const twoContext = initializeSourceBootstrap({
      env: two,
      wrapperUrl: 'file:///tmp/station-worktrees/two/scripts/station-cli.ts',
    });

    expect(oneContext.instanceId).not.toBe(twoContext.instanceId);
    expect(oneContext.serverPort).not.toBe(twoContext.serverPort);
    expect(resolveRuntimeHome(one)).not.toBe(resolveRuntimeHome(two));
  });

  test('normalizes only an explicit home and keeps all explicit launch overrides', () => {
    const env = sourceEnv({
      STATION_CHANNEL: 'beta',
      STATION_HOME: './runtime-home',
      STATION_SERVER_PORT: '29141',
      STATION_UI_PORT: '29000',
      STATION_CONSENT_PORT: '29144',
    });
    const context = initializeSourceBootstrap({ env, wrapperUrl });

    expect(context).toMatchObject({
      channel: 'beta',
      serverPort: 29141,
      uiPort: 29000,
      consentPort: 29144,
    });
    expect(env.STATION_ROOT).toBe('/tmp/station-bootstrap-root');
    expect(env.STATION_HOME).toBe(resolve('./runtime-home'));
    expect(resolveRuntimeHome(env)).toBe(resolve('./runtime-home'));
    expect(env.STATION_PORT).toBe('29141');
  });

  test('leaves implicit consent for the lifecycle parser to derive from an overridden API port', async () => {
    const env = sourceEnv({ STATION_SERVER_PORT: '5000' });
    initializeSourceBootstrap({ env, wrapperUrl });
    expect(env.STATION_CONSENT_PORT).toBeUndefined();
    const { parseLifecycleArgs } = await import(
      '../../packages/cli/src/cli.js'
    );
    const original = { ...process.env };
    Object.assign(process.env, env);
    try {
      expect(parseLifecycleArgs([]).consentPort).toBe(5003);
      process.env.STATION_CONSENT_PORT = '5012';
      expect(parseLifecycleArgs([]).consentPort).toBe(5012);
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, original);
    }
  });

  test('makes start, core, active-local, checkpoints, and registry consume one context', async () => {
    const keys = [
      'STATION_ROOT',
      'STATION_HOME',
      'STATION_CHANNEL',
      'STATION_INSTANCE_ID',
      'STATION_DEV_INSTANCE',
      'STATION_PORT',
      'STATION_SERVER_PORT',
      'STATION_UI_PORT',
      'STATION_CONSENT_PORT',
      'STATION_TARGET',
    ] as const;
    const previous = Object.fromEntries(
      keys.map((key) => [key, process.env[key]]),
    );
    try {
      for (const key of keys) delete process.env[key];
      process.env.STATION_ROOT = '/tmp/station-bootstrap-parity';
      vi.resetModules();
      const { initializeSourceBootstrap: initialize } = await import(
        '../source-bootstrap.js'
      );
      const context = initialize({ wrapperUrl });
      const helpers = await import(
        '../../packages/cli/src/commands/helpers.js'
      );
      const core = await import('../../packages/cli/src/commands/core-api.js');
      const active = await import(
        '../../packages/cli/src/commands/active-local-station.js'
      );
      const checkpoints = await import(
        '../../packages/cli/src/commands/checkpoints.js'
      );
      const registry = await import(
        '../../packages/shared/src/instance-registry.js'
      );
      const checkpointOutput: string[] = [];

      await checkpoints.runCheckpointsCommand(['status'], {
        stdout: (line) => checkpointOutput.push(line),
      });

      expect(helpers.DEFAULT_PROJECT_HOME).toBe(
        resolveRuntimeHome(process.env),
      );
      expect(core.resolveApiBase(core.parseCoreArgs([]))).toBe(
        `http://127.0.0.1:${context.serverPort}`,
      );
      expect(active.activeLocalStationPath()).toBe(
        `${helpers.DEFAULT_PROJECT_HOME}/runtime/active-local.json`,
      );
      expect(checkpointOutput[0]).toBe(
        `Workspace checkpoints (index: ${helpers.DEFAULT_PROJECT_HOME}/turn-checkpoints)`,
      );
      expect(registry.resolveInstanceRegistryPath()).toBe(
        `${helpers.DEFAULT_PROJECT_HOME}/instances.json`,
      );
    } finally {
      for (const key of keys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      vi.resetModules();
    }
  });
});

describe('an external STATION_HOME must still launch (#1109)', () => {
  test('a raw external home is left self-rooted, not handed a root equal to itself', () => {
    // `STATION_HOME=/tmp/x ./station start` was refused before the CLI ran.
    // `resolveStationRoot` self-roots a raw home, and writing that value back
    // made the runtime home guard see an explicit root equal to the home --
    // which it reads as a home swallowing a root it does not own. Nothing is
    // lost by omitting it: the derivation reads only STATION_ROOT and
    // STATION_HOME, so the same value is recomputed from the home alone.
    const home = mkdtempSync(join(tmpdir(), 'station-source-home-'));
    const env: NodeJS.ProcessEnv = {
      STATION_HOME: home,
      STATION_CHANNEL: 'stable',
    };
    initializeSourceBootstrap({ env, wrapperUrl });
    expect(env.STATION_ROOT ?? '').toBe('');
    expect(() => admitStationRuntimeHome(home, env)).not.toThrow();
  });

  test('with no external home the ambient root is still written', () => {
    // The omission is specific to the self-rooted case. Dropping the root
    // unconditionally would leave every ordinary source launch deriving it
    // downstream instead of having the decision frozen here.
    const env: NodeJS.ProcessEnv = { STATION_CHANNEL: 'stable' };
    initializeSourceBootstrap({ env, wrapperUrl });
    expect(env.STATION_ROOT).toBeTruthy();
    expect(env.STATION_ROOT).toMatch(/\.station$/);
  });

  test('an operator-set root equal to the home is still refused', () => {
    // The original escape. Only a root DERIVED from the home may be omitted;
    // one the operator wrote down is passed through and stays rejected.
    const shared = mkdtempSync(join(tmpdir(), 'station-source-shared-'));
    const env: NodeJS.ProcessEnv = {
      STATION_ROOT: shared,
      STATION_HOME: shared,
      STATION_CHANNEL: 'stable',
    };
    initializeSourceBootstrap({ env, wrapperUrl });
    expect(env.STATION_ROOT).toBe(shared);
    expect(() => admitStationRuntimeHome(shared, env)).toThrow(
      /shared Station root/,
    );
  });
});
