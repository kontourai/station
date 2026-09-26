/**
 * station#2689: every entry point that installs a local service from a SOURCE
 * checkout, driven through `runCli` after the real source bootstrap
 * (`initializeSourceBootstrap`) has chosen the development channel, instance
 * and ports — so the real `parseLifecycleArgs`, `parseDefaultArgs`,
 * `runSetupCommand` and service identity resolution all run. Substituted: the
 * systemd backend, the build preparation and readiness probe (other suites
 * own those), same-machine self-authorization, and the interactive prompt.
 *
 * The contract: with no explicit --instance the service is the checkout's
 * development instance, in that instance's home, on the ports the bootstrap
 * chose — and a saved `setup local` profile records exactly that. An explicit
 * non-dev --instance with no explicit home refuses.
 */
import * as nodeFs from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { initializeSourceBootstrap } from '../../../../scripts/source-bootstrap.js';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';
import type { ServiceFs } from '../commands/service.js';

const makeTempDir = trackTempDirs();

const installSystemd = vi.fn();

const BOOTSTRAP_KEYS = [
  'STATION_CHANNEL',
  'STATION_CONSENT_PORT',
  'STATION_DEV_INSTANCE',
  'STATION_HOME',
  'STATION_INSTANCE_ID',
  'STATION_PORT',
  'STATION_PORT_OFFSET',
  'STATION_ROOT',
  'STATION_SERVER_PORT',
  'STATION_UI_PORT',
] as const;

interface Bootstrapped {
  devInstanceId: string;
  devHome: string;
  serverPort: number;
  uiPort: number;
}

/** What `./station` does before the CLI loads, for a fresh checkout. */
function bootstrapSourceCheckout(): Bootstrapped {
  // Canonical: the runtime resolves the root through realpath (/private/var).
  const stationRoot = nodeFs.realpathSync(
    makeTempDir('station-dev-entry-root-'),
  );
  const checkout = makeTempDir('station-dev-entry-checkout-');
  mkdirSync(join(checkout, 'scripts'));
  const env: NodeJS.ProcessEnv = { STATION_ROOT: stationRoot };
  const context = initializeSourceBootstrap({
    env,
    wrapperUrl: pathToFileURL(join(checkout, 'scripts', 'station-cli.ts')).href,
  });
  for (const key of BOOTSTRAP_KEYS) vi.stubEnv(key, env[key]);
  expect(context.channel).toBe('development');
  return {
    devInstanceId: context.instanceId,
    devHome: join(stationRoot, 'instances', 'dev', context.instanceId),
    serverPort: context.serverPort,
    uiPort: context.uiPort,
  };
}

const serviceFs = {
  ...nodeFs,
  realpathSync: (path: nodeFs.PathLike) =>
    path === process.execPath ? '/usr/bin/node' : nodeFs.realpathSync(path),
} as unknown as ServiceFs;

async function loadCli(options: { menuChoice?: string } = {}) {
  vi.resetModules();
  vi.doMock('../commands/service-systemd.js', () => ({
    installSystemd,
    startSystemd: vi.fn(),
    stopSystemd: vi.fn(),
    systemdRegistration: (instanceId: string) => ({
      platform: 'linux',
      unitName: `station-${instanceId}.service`,
      unitPath: `/nonexistent/station-${instanceId}.service`,
    }),
    systemdStatus: vi.fn(),
    uninstallSystemd: vi.fn(),
  }));
  vi.doMock('../commands/lifecycle.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../commands/lifecycle.js')>()),
    collectInstanceStatus: vi.fn(async (instanceId: string) => ({
      found: true,
      healthy: true,
      instanceId,
      server: { pid: 10, reachable: true },
      ui: { pid: 11, reachable: true },
    })),
  }));
  // The real service command, with its host-facing seams made hermetic.
  vi.doMock('../commands/service.js', async (importOriginal) => {
    const actual =
      await importOriginal<typeof import('../commands/service.js')>();
    return {
      ...actual,
      runServiceCommand: (
        args: string[],
        lifecycle: Parameters<typeof actual.runServiceCommand>[1],
      ) =>
        actual.runServiceCommand(args, lifecycle, {
          fs: serviceFs,
          platform: 'linux',
          prepareServiceBuild: async () => {},
          run: () => ({ status: 1, stdout: '' }),
        }),
    };
  });
  vi.doMock('../commands/local-self-auth.js', async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('../commands/local-self-auth.js')
    >()),
    selfAuthorizeLocalProfile: vi.fn(async () => ({
      status: 'failed',
      reason: 'not under test',
    })),
  }));
  vi.doMock('@kontourai/station-shared/node-runtime', () => ({
    assertSupportedNodeVersion: vi.fn(),
  }));
  if (options.menuChoice) {
    const choice = options.menuChoice;
    vi.doMock('../commands/prompt.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../commands/prompt.js')>()),
      promptSelect: vi.fn(async () => choice),
    }));
  }
  return {
    runCli: (await import('../cli.js')).runCli,
    readProfileStore: (await import('../commands/profile-store.js'))
      .readProfileStore,
  };
}

function installedService() {
  expect(installSystemd).toHaveBeenCalledTimes(1);
  const [instanceId, input] = installSystemd.mock.calls[0]!;
  return {
    instanceId,
    baseDir: input.lifecycle.baseDir,
    serverPort: input.lifecycle.serverPort,
    uiPort: input.lifecycle.uiPort,
  };
}

beforeEach(() => {
  installSystemd.mockReset();
  installSystemd.mockImplementation((instanceId, input) => ({
    host: input.lifecycle.host,
    installedAt: '',
    instanceId,
    nodePath: input.nodePath,
    platform: 'linux',
    repoPath: input.repoPath,
    serverPort: input.lifecycle.serverPort,
    uiPort: input.lifecycle.uiPort,
    unitName: `station-${instanceId}.service`,
    unitPath: `/nonexistent/station-${instanceId}.service`,
  }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  for (const module of [
    '../commands/service-systemd.js',
    '../commands/lifecycle.js',
    '../commands/service.js',
    '../commands/local-self-auth.js',
    '../commands/prompt.js',
    '@kontourai/station-shared/node-runtime',
  ]) {
    vi.doUnmock(module);
  }
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('source-checkout service entry points name the service after its dev home (station#2689)', () => {
  test.each([
    ['launcher --service', ['--service'], {}],
    [
      'launcher menu "Install and start a background service"',
      [],
      { menuChoice: 'service' },
    ],
    ['station service install', ['service', 'install'], {}],
  ] as const)(
    '%s installs the dev instance in its home on the bootstrap ports',
    async (_label, argv, options) => {
      const dev = bootstrapSourceCheckout();
      const { runCli } = await loadCli(options);

      await runCli([...argv], { isInteractive: 'menuChoice' in options });

      expect(installedService()).toEqual({
        instanceId: dev.devInstanceId,
        baseDir: dev.devHome,
        serverPort: dev.serverPort,
        uiPort: dev.uiPort,
      });
    },
  );

  test('launcher --service with --port keeps the dev id rather than a port hash', async () => {
    const dev = bootstrapSourceCheckout();
    const { runCli } = await loadCli();

    await runCli(['--service', '--port=45111', '--ui-port=45222']);

    expect(installedService()).toEqual({
      instanceId: dev.devInstanceId,
      baseDir: dev.devHome,
      serverPort: 45_111,
      uiPort: 45_222,
    });
  });

  test('station setup local installs the dev instance and saves a profile that records the same service', async () => {
    const dev = bootstrapSourceCheckout();
    const { runCli, readProfileStore } = await loadCli();

    await runCli(['setup', 'local']);

    const service = installedService();
    expect(service).toEqual({
      instanceId: dev.devInstanceId,
      baseDir: dev.devHome,
      serverPort: dev.serverPort,
      uiPort: dev.uiPort,
    });
    const profile = readProfileStore().profiles.find(
      (entry) => entry.name === 'kontour',
    );
    expect(profile?.endpoint).toBe(`http://127.0.0.1:${dev.serverPort}`);
    expect(profile?.localService).toEqual({
      instanceId: service.instanceId,
      baseDir: service.baseDir,
      serverPort: service.serverPort,
      uiPort: service.uiPort,
    });
  });

  test('station service install --instance=default refuses the dev home', async () => {
    const dev = bootstrapSourceCheckout();
    const { runCli } = await loadCli();

    await expect(
      runCli(['service', 'install', '--instance=default']),
    ).rejects.toThrow(
      `Refusing to install Station user service default into this source checkout's development home ${dev.devHome}.`,
    );
    expect(installSystemd).not.toHaveBeenCalled();
  });

  test('station setup local --instance=default refuses the dev home too', async () => {
    const dev = bootstrapSourceCheckout();
    const { runCli } = await loadCli();

    await expect(
      runCli(['setup', 'local', '--instance=default']),
    ).rejects.toThrow(
      `Refusing to install Station user service default into this source checkout's development home ${dev.devHome}.`,
    );
    expect(installSystemd).not.toHaveBeenCalled();
  });

  test('an explicit --base keeps an explicitly named service where it is', async () => {
    const dev = bootstrapSourceCheckout();
    const { runCli } = await loadCli();

    await runCli([
      'service',
      'install',
      '--instance=default',
      `--base=${dev.devHome}`,
    ]);

    expect(installedService()).toMatchObject({
      instanceId: 'default',
      baseDir: dev.devHome,
    });
  });
});
