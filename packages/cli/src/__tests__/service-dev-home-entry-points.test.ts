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

/**
 * A stateful stand-in for the systemd user manager: which units run, and a
 * boot generation per install so a reinstall's readiness sees a new boot.
 */
const runningUnits = new Map<string, number>();
let bootGeneration = 0;
const unitInstance = (target: { unitName?: string }) =>
  String(target.unitName).replace(/^station-(.*)\.service$/, '$1');
const installSystemd = vi.fn();
const startSystemd = vi.fn((target: { unitName?: string }) => {
  runningUnits.set(unitInstance(target), ++bootGeneration);
});
const stopSystemd = vi.fn((target: { unitName?: string }) => {
  runningUnits.delete(unitInstance(target));
});
const uninstallSystemd = vi.fn((target: { unitName?: string }) => {
  runningUnits.delete(unitInstance(target));
});

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
    startSystemd,
    stopSystemd,
    systemdRegistration: (instanceId: string) => ({
      platform: 'linux',
      unitName: `station-${instanceId}.service`,
      unitPath: `/nonexistent/station-${instanceId}.service`,
    }),
    systemdStatus: (target: { unitName?: string }) => ({
      active: runningUnits.has(unitInstance(target)),
      enabled: true,
      present: true,
    }),
    uninstallSystemd,
  }));
  vi.doMock('../commands/lifecycle.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../commands/lifecycle.js')>()),
    collectInstanceStatus: vi.fn(async (instanceId: string) =>
      runningUnits.has(instanceId)
        ? {
            bootId: `boot-${runningUnits.get(instanceId)}`,
            found: true,
            healthy: true,
            instanceId,
            server: { pid: 10, reachable: true },
            ui: { pid: 11, reachable: true },
          }
        : {
            found: false,
            healthy: false,
            instanceId,
            server: { pid: null, reachable: false },
            ui: { pid: null, reachable: false },
          },
    ),
    // `service uninstall` also stops the lifecycle instance; never touch the
    // real checkout's instance records from here.
    stop: vi.fn(),
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
  runningUnits.clear();
  installSystemd.mockReset();
  startSystemd.mockClear();
  stopSystemd.mockClear();
  uninstallSystemd.mockClear();
  installSystemd.mockImplementation((instanceId, input) => {
    runningUnits.set(instanceId, ++bootGeneration);
    return {
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
    };
  });
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
  process.exitCode = undefined;
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

// station#2689 delta review: before the dev-id rule, `setup local` (which
// synthesized `--base=<dev home>`), a flagless `service install` and
// launcher --service all installed `default` INTO the dev home. Flagless
// commands must keep addressing that service, not orphan it.
describe('an existing checkout service in the dev home keeps being the one addressed (station#2689)', () => {
  /**
   * Installed exactly as the old `setup local` did: `default`, `--base=<dev
   * home>`, the bootstrap's ports. `viaSetup` also saves the `kontour`
   * profile the old flow saved, through setup local's own explicit flags.
   */
  async function withLegacyDefaultService(viaSetup = false) {
    const dev = bootstrapSourceCheckout();
    const { runCli, readProfileStore } = await loadCli();
    await runCli(
      viaSetup
        ? ['setup', 'local', '--instance=default', `--base=${dev.devHome}`]
        : ['service', 'install', '--instance=default', `--base=${dev.devHome}`],
    );
    expect(installSystemd).toHaveBeenLastCalledWith(
      'default',
      expect.anything(),
    );
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logs = console.log as unknown as ReturnType<typeof vi.fn>;
    logs.mockClear();
    const adopted = `Using Station user service default, already installed for this checkout in ${dev.devHome} (pass --instance to address another).`;
    return { dev, runCli, readProfileStore, errors, logs, adopted };
  }
  const manifests = (home: string) =>
    nodeFs
      .readdirSync(join(home, 'service'))
      .filter((name) => name.endsWith('.json'))
      .sort();

  test('flagless status reports the existing default service and says so', async () => {
    const { dev, runCli, errors, logs, adopted } =
      await withLegacyDefaultService();

    await runCli(['service', 'status', '--json']);

    const json = logs.mock.calls
      .map(([line]) => String(line))
      .find((line) => line.trimStart().startsWith('{'));
    expect(JSON.parse(json!)).toMatchObject({
      instance: { instanceId: 'default' },
      manifest: { instanceId: 'default', baseDir: dev.devHome },
    });
    expect(errors.mock.calls.map(([line]) => line)).toContain(adopted);
  });

  test('flagless stop stops the existing default unit', async () => {
    const { runCli, errors } = await withLegacyDefaultService();

    await runCli(['service', 'stop']);

    expect(stopSystemd).toHaveBeenCalledWith(
      expect.objectContaining({ unitName: 'station-default.service' }),
      expect.anything(),
    );
    expect(errors.mock.calls.join('\n')).not.toMatch(
      /no service manifest found/,
    );
  });

  test('flagless uninstall removes the existing default service instead of reconciling an absent dev id', async () => {
    const { dev, runCli, logs } = await withLegacyDefaultService();

    await runCli(['service', 'uninstall']);

    expect(uninstallSystemd).toHaveBeenCalledWith(
      expect.objectContaining({ unitName: 'station-default.service' }),
      expect.anything(),
    );
    expect(manifests(dev.devHome)).toEqual([]);
    const printed = logs.mock.calls.map(([line]) => String(line));
    expect(printed).toContain('✓ Uninstalled Station user service default');
    expect(printed.join('\n')).not.toMatch(/Reconciled absent/);
  });

  test('flagless reinstall replaces the default service rather than adding a second unit', async () => {
    const { dev, runCli } = await withLegacyDefaultService();

    await runCli(['service', 'install']);

    expect(installSystemd).toHaveBeenCalledTimes(2);
    expect(installSystemd).toHaveBeenLastCalledWith(
      'default',
      expect.anything(),
    );
    expect(manifests(dev.devHome)).toEqual(['default.json']);
  });

  test('re-running setup local keeps the default service and its saved profile', async () => {
    const { dev, runCli, readProfileStore, errors, adopted } =
      await withLegacyDefaultService(true);

    await runCli(['setup', 'local']);
    expect(errors.mock.calls.map(([line]) => line)).toContain(adopted);

    expect(installSystemd).toHaveBeenLastCalledWith(
      'default',
      expect.anything(),
    );
    expect(manifests(dev.devHome)).toEqual(['default.json']);
    expect(
      readProfileStore().profiles.find((entry) => entry.name === 'kontour')
        ?.localService,
    ).toMatchObject({ instanceId: 'default', baseDir: dev.devHome });
  });

  test('several services for this checkout in one home refuse and list them', async () => {
    const { dev, runCli } = await withLegacyDefaultService();
    await runCli(['service', 'install', `--instance=${dev.devInstanceId}`]);
    expect(manifests(dev.devHome)).toEqual([
      'default.json',
      `${dev.devInstanceId}.json`,
    ]);

    await expect(runCli(['service', 'status'])).rejects.toThrow(
      `Several Station user services in ${dev.devHome} belong to this checkout: default, ${dev.devInstanceId}.\nPass --instance=<name> to choose one.`,
    );
  });
});
