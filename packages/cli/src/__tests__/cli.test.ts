import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Snapshot of any global the CLI reads at runtime so each test is fully
// self-contained regardless of shuffle order. The global vitest setup
// (vitest.setup.ts) and sibling suites (e.g. portability.test.ts) mutate
// process.env.STATION_HOME for the shared worker; without resetting it in
// beforeEach, whichever test happens to run FIRST in this file inherits that
// leaked value and the default-home assertions (homeSource: 'default') break.
let originalStationAiDir: string | undefined;
let originalExitCode: typeof process.exitCode;
let originalBundleMarker: unknown;

beforeEach(() => {
  originalStationAiDir = process.env.STATION_HOME;
  originalExitCode = process.exitCode;
  originalBundleMarker = (globalThis as { __STATION_CLI_BUNDLE__?: unknown })
    .__STATION_CLI_BUNDLE__;
  delete process.env.STATION_HOME;
  process.exitCode = undefined;
  vi.resetModules();
  vi.restoreAllMocks();
});

afterEach(() => {
  if (originalStationAiDir === undefined) {
    delete process.env.STATION_HOME;
  } else {
    process.env.STATION_HOME = originalStationAiDir;
  }
  process.exitCode = originalExitCode;
  if (originalBundleMarker === undefined)
    delete (globalThis as { __STATION_CLI_BUNDLE__?: unknown })
      .__STATION_CLI_BUNDLE__;
  else
    (
      globalThis as { __STATION_CLI_BUNDLE__?: unknown }
    ).__STATION_CLI_BUNDLE__ = originalBundleMarker;
  vi.resetModules();
  vi.doUnmock('../commands/environment.js');
  vi.doUnmock('../commands/lazy-start.js');
  vi.restoreAllMocks();
});

describe('bundled client admission', () => {
  test('a TTY bare invocation refuses before credential setup or lazy-start probing', async () => {
    const lazyStart = vi.fn();
    vi.doMock('../commands/lazy-start.js', () => ({ runLazyStart: lazyStart }));
    (
      globalThis as { __STATION_CLI_BUNDLE__?: unknown }
    ).__STATION_CLI_BUNDLE__ = {
      version: '0.6.0',
      sourceSha: 'a'.repeat(40),
      channel: 'development',
    };
    const { runCli } = await import('../cli.js');
    const configureProfileCredentialStore = vi.fn();

    await expect(
      runCli([], { isInteractive: true, configureProfileCredentialStore }),
    ).rejects.toThrow('cannot start or manage a local backend');
    expect(configureProfileCredentialStore).not.toHaveBeenCalled();
    expect(lazyStart).not.toHaveBeenCalled();
  });

  test('denies spaced host pairing actions but admits remote SSH show commands', async () => {
    const environment = vi.fn();
    vi.doMock('../commands/environment.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../commands/environment.js')>()),
      pairSavedStation: vi.fn(),
      runEnvironmentCommand: environment,
    }));
    (
      globalThis as { __STATION_CLI_BUNDLE__?: unknown }
    ).__STATION_CLI_BUNDLE__ = {
      version: '0.6.0',
      sourceSha: 'a'.repeat(40),
      channel: 'development',
    };
    const { runCli } = await import('../cli.js');
    const configureProfileCredentialStore = vi.fn();

    await expect(
      runCli(
        [
          'environment',
          '--api-base',
          'http://127.0.0.1:1',
          'access',
          'approve',
        ],
        { configureProfileCredentialStore },
      ),
    ).rejects.toThrow('Environment security commands require');
    expect(configureProfileCredentialStore).not.toHaveBeenCalled();

    await runCli(['environment', 'show', 'ssh-environment-id'], {
      configureProfileCredentialStore,
    });
    expect(configureProfileCredentialStore).toHaveBeenCalledOnce();
    expect(environment).toHaveBeenCalledWith(
      ['show', 'ssh-environment-id'],
      expect.any(Object),
    );
  });
});

async function loadCliWithLifecycleMocks() {
  const lifecycle = {
    buildApplication: vi.fn(),
    clean: vi.fn(),
    doctor: vi.fn(),
    doctorJson: vi.fn(),
    homeBackup: vi.fn(() => ({
      backupDir: '/backup',
      manifest: {
        createdAt: '2026-08-17T00:00:00.000Z',
        files: [],
        homeSchemaVersion: 1,
        totalBytes: 0,
      },
    })),
    homeReset: vi.fn(() => ({ archived: false, projectHome: '/home' })),
    homeVerify: vi.fn(() => ({
      homeDir: '/home',
      checkedAt: '2026-08-18T00:00:00.000Z',
      results: [
        {
          databasePath: '/home/data/orchestration.sqlite',
          verdict: 'corrupt',
          durationMs: 42,
          detail: 'Tree 2 page 805: btreeInitPage() returns error code 11',
        },
      ],
      exitCode: 1,
    })),
    homeRestore: vi.fn(() => ({
      homeDir: '/home',
      manifest: { files: [], totalBytes: 0 },
    })),
    link: vi.fn(),
    shortcut: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    upgrade: vi.fn(),
    validateLifecyclePorts: vi.fn(),
  };
  const service = { runServiceCommand: vi.fn() };

  vi.doMock('../commands/build.js', () => ({ build: vi.fn() }));
  vi.doMock('../commands/config.js', () => ({
    configGet: vi.fn(),
    configSet: vi.fn(),
  }));
  vi.doMock('../commands/export.js', () => ({ exportConfig: vi.fn() }));
  vi.doMock('../commands/import.js', () => ({ importConfig: vi.fn() }));
  vi.doMock('../commands/init.js', () => ({
    createPlugin: vi.fn(),
    init: vi.fn(),
  }));
  vi.doMock('../commands/install-registry.js', () => ({
    recordRegistryInstall: vi.fn(),
    resolveRegistryPluginSource: vi.fn(),
  }));
  vi.doMock('../commands/install.js', () => ({
    info: vi.fn(),
    install: vi.fn(),
    installRegistryPlugin: vi.fn(),
    list: vi.fn(),
    preview: vi.fn(),
    registry: vi.fn(),
    remove: vi.fn(),
    update: vi.fn(),
  }));
  vi.doMock('../commands/lifecycle.js', () => lifecycle);
  vi.doMock('../commands/service.js', () => service);
  vi.doMock('../dev/server.js', () => ({
    startDevServer: vi.fn(),
  }));

  const { runCli } = await import('../cli.js');
  return { lifecycle, runCli, service };
}

describe('runCli', () => {
  test('threads channel upgrade home and ports, with explicit port env overrides', async () => {
    const previous = {
      channel: process.env.STATION_CHANNEL,
      serverPort: process.env.STATION_SERVER_PORT,
      uiPort: process.env.STATION_UI_PORT,
    };
    process.env.STATION_CHANNEL = 'beta';
    try {
      const { lifecycle, runCli } = await loadCliWithLifecycleMocks();
      await runCli(['upgrade']);
      expect(lifecycle.validateLifecyclePorts).toHaveBeenCalledWith(
        28141,
        28000,
      );
      expect(lifecycle.upgrade).toHaveBeenCalledWith(
        expect.objectContaining({
          baseDir: expect.stringMatching(/instances\/beta$/),
          serverPort: 28141,
          uiPort: 28000,
        }),
      );

      process.env.STATION_SERVER_PORT = '29141';
      process.env.STATION_UI_PORT = '29000';
      await runCli(['upgrade']);
      expect(lifecycle.validateLifecyclePorts).toHaveBeenLastCalledWith(
        29141,
        29000,
      );
      expect(lifecycle.upgrade).toHaveBeenLastCalledWith(
        expect.objectContaining({
          baseDir: expect.stringMatching(/instances\/beta$/),
          serverPort: 29141,
          uiPort: 29000,
        }),
      );
    } finally {
      if (previous.channel === undefined) delete process.env.STATION_CHANNEL;
      else process.env.STATION_CHANNEL = previous.channel;
      if (previous.serverPort === undefined)
        delete process.env.STATION_SERVER_PORT;
      else process.env.STATION_SERVER_PORT = previous.serverPort;
      if (previous.uiPort === undefined) delete process.env.STATION_UI_PORT;
      else process.env.STATION_UI_PORT = previous.uiPort;
    }
  });

  test('dispatches Station home backup and restore with explicit paths', async () => {
    const { lifecycle, runCli } = await loadCliWithLifecycleMocks();
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runCli([
      'home',
      'backup',
      '--base=/station-home',
      '--output=/backup-dir',
      '--json',
    ]);
    expect(lifecycle.homeBackup).toHaveBeenCalledWith(
      expect.objectContaining({
        outputDir: '/backup-dir',
        projectHome: '/station-home',
      }),
    );
    await runCli([
      'home',
      'restore',
      '--base=/station-home',
      '--from=/backup-dir',
      '--confirm',
      '--json',
    ]);
    expect(lifecycle.homeRestore).toHaveBeenCalledWith(
      expect.objectContaining({
        backupDir: '/backup-dir',
        confirm: true,
        projectHome: '/station-home',
      }),
    );
    expect(output).toHaveBeenCalled();
    expect(
      output.mock.calls.every(([value]) => !String(value).includes('"files"')),
    ).toBe(true);
  });

  test('home verify reports a corrupt store and exits non-zero', async () => {
    // The finding has to reach the shell. A verification that prints
    // "corrupt" and exits 0 is invisible to every script that would act on
    // it, which is most of the value of having the command.
    const { lifecycle, runCli } = await loadCliWithLifecycleMocks();
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const previousExitCode = process.exitCode;
    try {
      await runCli(['home', 'verify', '--base=/station-home']);
      expect(lifecycle.homeVerify).toHaveBeenCalledWith(
        expect.objectContaining({ projectHome: '/station-home' }),
      );
      expect(process.exitCode).toBe(1);
      // The human path is the one no `--json` test covers, and the one an
      // operator actually reads.
      expect(
        output.mock.calls.some(([value]) =>
          String(value).includes('corrupt /home/data/orchestration.sqlite'),
        ),
      ).toBe(true);
    } finally {
      process.exitCode = previousExitCode;
      output.mockRestore();
    }
  });

  test('home verify maps a missing home to exit 3, not the corrupt code', async () => {
    // Exit 1 is documented as "the bytes are bad". A typo'd --base must land
    // on 3 ("nothing was verified") or every script keying corruption alerts
    // on 1 pages for a path that was never a Station home.
    const { lifecycle, runCli } = await loadCliWithLifecycleMocks();
    lifecycle.homeVerify.mockImplementation(() => {
      throw Object.assign(new Error('No Station home at /no-such-home.'), {
        code: 'STATION_HOME_MISSING',
      });
    });
    const errorOutput = vi.spyOn(console, 'error').mockImplementation(() => {});
    const previousExitCode = process.exitCode;
    try {
      await runCli(['home', 'verify', '--base=/no-such-home']);
      expect(process.exitCode).toBe(3);
      expect(
        errorOutput.mock.calls.some(([value]) =>
          String(value).includes('No Station home at'),
        ),
      ).toBe(true);
    } finally {
      process.exitCode = previousExitCode;
      errorOutput.mockRestore();
    }
  });

  test('home verify refuses an unknown action rather than falling through to reset', async () => {
    const { lifecycle, runCli } = await loadCliWithLifecycleMocks();
    await expect(runCli(['home', 'verfiy'])).rejects.toThrow(
      /backup\|restore\|reset\|verify/,
    );
    expect(lifecycle.homeReset).not.toHaveBeenCalled();
  });

  test('dispatches doctor --json without invoking human output', async () => {
    const { lifecycle, runCli } = await loadCliWithLifecycleMocks();

    await runCli(['doctor', '--json']);

    expect(lifecycle.doctorJson).toHaveBeenCalledOnce();
    expect(lifecycle.doctor).not.toHaveBeenCalled();
  });

  test('dispatches service lifecycle flags through the shared parser', async () => {
    const { runCli, service } = await loadCliWithLifecycleMocks();

    await runCli([
      'service',
      'status',
      '--instance=hosted',
      '--base=/tmp/station-service',
      '--port=3242',
      '--ui-port=5274',
      '--json',
    ]);

    expect(service.runServiceCommand).toHaveBeenCalledWith(
      [
        'status',
        '--instance=hosted',
        '--base=/tmp/station-service',
        '--port=3242',
        '--ui-port=5274',
        '--json',
      ],
      expect.objectContaining({
        baseDir: '/tmp/station-service',
        instanceName: 'hosted',
        serverPort: 3242,
        uiPort: 5274,
      }),
    );
  });

  test('parses repeatable --allowed-origin fail-closed (#1672)', async () => {
    // The parser delegates validation to the real service-module helper; the
    // suite's service mock must not mask it for this parse-only test.
    vi.doMock('../commands/service.js', async (importOriginal) => ({
      ...(await importOriginal<object>()),
      runServiceCommand: vi.fn(),
    }));
    const { parseLifecycleArgs } = await import('../cli.js');

    expect(
      parseLifecycleArgs([
        '--base=/tmp/station-service',
        '--allowed-origin=https://kontour.example.ts.net',
        '--allowed-origin=https://second.example.ts.net',
      ]),
    ).toMatchObject({
      allowedOrigins: [
        'https://kontour.example.ts.net',
        'https://second.example.ts.net',
      ],
      clearAllowedOrigins: false,
    });
    expect(
      parseLifecycleArgs(['--base=/tmp/x', '--clear-allowed-origins']),
    ).toMatchObject({ allowedOrigins: undefined, clearAllowedOrigins: true });

    for (const [flag, reason] of [
      ['--allowed-origin=not-a-url', /not a URL/],
      ['--allowed-origin=ftp://host.example', /http\/https/],
      ['--allowed-origin=https://host.example/path', /bare origin/],
      ['--allowed-origin=https://host.example/', /bare origin/],
      ['--allowed-origin=https://user:pw@host.example', /bare origin/],
    ] as const) {
      expect(() => parseLifecycleArgs(['--base=/tmp/x', flag])).toThrow(reason);
    }
  });

  test('preserves everything after the first equals sign in lifecycle values', async () => {
    vi.doMock('../commands/service.js', async (importOriginal) => ({
      ...(await importOriginal<object>()),
      runServiceCommand: vi.fn(),
    }));
    const { parseLifecycleArgs } = await import('../cli.js');

    expect(
      parseLifecycleArgs(['--base=/srv/station=blue', '--features=a=1,b']),
    ).toMatchObject({
      baseDir: '/srv/station=blue',
      features: 'a=1,b',
    });
  });

  test('rejects remote selectors before lifecycle effects', async () => {
    const { parseLifecycleArgs } = await import('../cli.js');
    for (const selector of [
      '--station=remote',
      '--api-base=https://station.example.test',
    ]) {
      expect(() => parseLifecycleArgs([selector])).toThrow(
        /cannot be used with local lifecycle commands/,
      );
    }
  });

  test('rejects ephemeral service commands before creating a temp home', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'station-cli-service-test-'));
    const priorTempEnv = {
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      TMPDIR: process.env.TMPDIR,
    };
    Object.assign(process.env, {
      TEMP: tempRoot,
      TMP: tempRoot,
      TMPDIR: tempRoot,
    });

    try {
      const { runCli, service } = await loadCliWithLifecycleMocks();
      const before = readdirSync(tempRoot);

      for (const action of ['install', 'status', 'uninstall', 'run']) {
        await expect(
          runCli(['service', action, '--temp-home']),
        ).rejects.toThrow('--temp-home cannot be used with service commands');
      }
      expect(readdirSync(tempRoot)).toEqual(before);
      expect(service.runServiceCommand).not.toHaveBeenCalled();
    } finally {
      for (const [key, value] of Object.entries(priorTempEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });
  test('dispatches environment commands through the injected root security service', async () => {
    const { runCli } = await loadCliWithLifecycleMocks();
    const initialize = vi.fn().mockResolvedValue({
      schemaVersion: 1,
      environmentId: '11111111-1111-4111-8111-111111111111',
      credential: 'secret-not-for-logs',
    });
    const createEnvironmentSecurityService = vi.fn(() => ({
      initialize,
      readExistingRecord: vi.fn(),
      rotateCredential: vi.fn(),
      resetEnvironment: vi.fn(),
    }));
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runCli(['environment', 'show'], {
      createEnvironmentSecurityService,
      isInteractive: false,
    });

    expect(createEnvironmentSecurityService).toHaveBeenCalledWith(
      expect.stringMatching(/instances\/stable$/),
    );
    expect(initialize).toHaveBeenCalledOnce();
    expect(JSON.stringify(stdout.mock.calls)).not.toContain(
      'secret-not-for-logs',
    );
  });

  test('plugin dev strictly validates options and dispatches valid arguments', async () => {
    const startDevServer = vi.fn();
    vi.doMock('../dev/server.js', () => ({ startDevServer }));
    const { runCli } = await import('../cli.js');
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

    const invalid = [
      ['--host=0.0.0.0'],
      ['--host', '0.0.0.0'],
      ['--unknown'],
      ['4200', '4300'],
      ['0'],
      ['65536'],
      ['-1'],
      ['not-a-port'],
      ['--tools-dir='],
    ];
    for (const args of invalid) {
      process.exitCode = undefined;
      await runCli(['plugin', 'dev', ...args]);
      expect(process.exitCode, args.join(' ')).toBe(1);
    }
    expect(startDevServer).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalled();

    process.exitCode = undefined;
    await runCli([
      'plugin',
      'dev',
      '4300',
      '--no-mcp',
      '--tools-dir=./integrations',
    ]);
    expect(process.exitCode).toBeUndefined();
    expect(startDevServer).toHaveBeenCalledWith(4300, {
      mcp: false,
      toolsDir: './integrations',
    });
  });

  test('lifecycle commands reject space-separated values but ignore unknown flags', async () => {
    const { lifecycle, runCli } = await loadCliWithLifecycleMocks();

    for (const [command, flag, value] of [
      ['start', '--host', '0.0.0.0'],
      ['stop', '--instance', 'workstation'],
    ] as const) {
      await expect(runCli([command, flag, value])).rejects.toThrow(
        `Lifecycle option ${flag} requires the ${flag}=<value> form.`,
      );
    }
    await runCli(['start', '--nonsense']);

    expect(lifecycle.start).toHaveBeenCalledOnce();
    expect(lifecycle.stop).not.toHaveBeenCalled();
  });

  // station#3677: the consent listener's explicit override survives the whole
  // flag path — parsed, validated with the pair, and handed to start().
  test('start passes --consent-port through validation and into the lifecycle', async () => {
    const { lifecycle, runCli } = await loadCliWithLifecycleMocks();

    await runCli([
      'start',
      '--port=3242',
      '--ui-port=5274',
      '--consent-port=3999',
    ]);
    expect(lifecycle.validateLifecyclePorts).toHaveBeenCalledWith(
      3242,
      5274,
      3999,
    );
    expect(lifecycle.start).toHaveBeenCalledWith(
      expect.objectContaining({
        serverPort: 3242,
        uiPort: 5274,
        consentPort: 3999,
      }),
    );

    // Without the flag the parser derives the consent listener from the API
    // port, so ad-hoc --port instances keep a collision-free block.
    await runCli(['start', '--port=3242', '--ui-port=5274']);
    expect(lifecycle.start).toHaveBeenLastCalledWith(
      expect.objectContaining({ consentPort: 3245 }),
    );
  });
  // Flag-shape parity (#CLI audit item 6): `plugin dev` took a bare positional
  // port while every other command uses `--port=`. Both work now.
  test('plugin dev accepts --port= alongside the positional port', async () => {
    const startDevServer = vi.fn();
    vi.doMock('../dev/server.js', () => ({ startDevServer }));
    const { runCli } = await import('../cli.js');
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runCli(['plugin', 'dev', '--port=4321', '--no-mcp']);

    expect(process.exitCode).toBeUndefined();
    expect(startDevServer).toHaveBeenCalledWith(4321, { mcp: false });

    for (const args of [['--port=notaport'], ['--port=0'], ['--port=']]) {
      process.exitCode = undefined;
      await runCli(['plugin', 'dev', ...args]);
      expect(process.exitCode, args.join(' ')).toBe(1);
    }
    expect(startDevServer).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalled();
  });

  test('dispatches registry install through the canonical Station API command', async () => {
    const installRegistryPlugin = vi.fn().mockResolvedValue(undefined);

    vi.doMock('../commands/build.js', () => ({ build: vi.fn() }));
    vi.doMock('../commands/config.js', () => ({
      configGet: vi.fn(),
      configSet: vi.fn(),
    }));
    vi.doMock('../commands/export.js', () => ({ exportConfig: vi.fn() }));
    vi.doMock('../commands/init.js', () => ({
      createPlugin: vi.fn(),
      init: vi.fn(),
    }));
    vi.doMock('../commands/import.js', () => ({ importConfig: vi.fn() }));
    vi.doMock('../commands/install-registry.js', () => ({}));
    vi.doMock('../commands/install.js', () => ({
      info: vi.fn(),
      install: vi.fn(),
      installRegistryPlugin,
      list: vi.fn(),
      preview: vi.fn(),
      registry: vi.fn(),
      remove: vi.fn(),
      update: vi.fn(),
    }));
    vi.doMock('../commands/lifecycle.js', () => ({
      buildApplication: vi.fn(),
      clean: vi.fn(),
      doctor: vi.fn(),
      doctorJson: vi.fn(),
      link: vi.fn(),
      shortcut: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      upgrade: vi.fn(),
      validateLifecyclePorts: vi.fn(),
    }));
    vi.doMock('../dev/server.js', () => ({
      startDevServer: vi.fn(),
    }));

    const { runCli } = await import('../cli.js');
    await runCli(['registry', 'install', 'demo-layout']);

    expect(installRegistryPlugin).toHaveBeenCalledWith(
      'demo-layout',
      expect.objectContaining({ flags: {}, positionals: [] }),
    );
  });

  test('dispatches create-plugin with the selected template', async () => {
    const createPlugin = vi.fn();

    vi.doMock('../commands/build.js', () => ({ build: vi.fn() }));
    vi.doMock('../commands/config.js', () => ({
      configGet: vi.fn(),
      configSet: vi.fn(),
    }));
    vi.doMock('../commands/export.js', () => ({ exportConfig: vi.fn() }));
    vi.doMock('../commands/init.js', () => ({
      createPlugin,
      init: vi.fn(),
    }));
    vi.doMock('../commands/import.js', () => ({ importConfig: vi.fn() }));
    vi.doMock('../commands/install-registry.js', () => ({
      recordRegistryInstall: vi.fn(),
      resolveRegistryPluginSource: vi.fn(),
    }));
    vi.doMock('../commands/install.js', () => ({
      info: vi.fn(),
      install: vi.fn(),
      installRegistryPlugin: vi.fn(),
      list: vi.fn(),
      preview: vi.fn(),
      registry: vi.fn(),
      remove: vi.fn(),
      update: vi.fn(),
    }));
    vi.doMock('../commands/lifecycle.js', () => ({
      buildApplication: vi.fn(),
      clean: vi.fn(),
      doctor: vi.fn(),
      doctorJson: vi.fn(),
      link: vi.fn(),
      shortcut: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      upgrade: vi.fn(),
      validateLifecyclePorts: vi.fn(),
    }));
    vi.doMock('../dev/server.js', () => ({
      startDevServer: vi.fn(),
    }));

    const { runCli } = await import('../cli.js');
    const { INVOKED_CWD } = await import('../commands/helpers.js');
    await runCli(['plugin', 'create', 'provider-kit', '--template=provider']);

    expect(createPlugin).toHaveBeenCalledWith('provider-kit', {
      template: 'provider',
      cwd: INVOKED_CWD,
    });
  });

  test('refuses an unknown plugin template before any filesystem write', async () => {
    // Review finding on the first-'=' parser fix: '--template=provider=extra'
    // previously truncated to 'provider' and worked by accident; the full
    // value now arrives here and must be rejected before createPlugin runs.
    const createPlugin = vi.fn();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.doMock('../commands/init.js', () => ({ createPlugin, init: vi.fn() }));

    const { runCli } = await import('../cli.js');
    await runCli([
      'plugin',
      'create',
      'provider-kit',
      '--template=provider=extra',
    ]);

    expect(createPlugin).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('Unknown plugin template "provider=extra"'),
    );
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    error.mockRestore();
  });

  test('dispatches portability export and import commands', async () => {
    const exportConfig = vi.fn();
    const importConfig = vi.fn();

    vi.doMock('../commands/build.js', () => ({ build: vi.fn() }));
    vi.doMock('../commands/config.js', () => ({
      configGet: vi.fn(),
      configSet: vi.fn(),
    }));
    vi.doMock('../commands/init.js', () => ({
      createPlugin: vi.fn(),
      init: vi.fn(),
    }));
    vi.doMock('../commands/install-registry.js', () => ({
      recordRegistryInstall: vi.fn(),
      resolveRegistryPluginSource: vi.fn(),
    }));
    vi.doMock('../commands/install.js', () => ({
      info: vi.fn(),
      install: vi.fn(),
      installRegistryPlugin: vi.fn(),
      list: vi.fn(),
      preview: vi.fn(),
      registry: vi.fn(),
      remove: vi.fn(),
      update: vi.fn(),
    }));
    vi.doMock('../commands/lifecycle.js', () => ({
      buildApplication: vi.fn(),
      clean: vi.fn(),
      doctor: vi.fn(),
      doctorJson: vi.fn(),
      link: vi.fn(),
      shortcut: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      upgrade: vi.fn(),
      validateLifecyclePorts: vi.fn(),
    }));
    vi.doMock('../commands/export.js', () => ({ exportConfig }));
    vi.doMock('../commands/import.js', () => ({ importConfig }));
    vi.doMock('../dev/server.js', () => ({
      startDevServer: vi.fn(),
    }));

    const { runCli } = await import('../cli.js');
    await runCli(['export', '--format=agents-md', '--output=/tmp/AGENTS.md']);
    await runCli(['import', '/tmp/AGENTS.md']);

    expect(exportConfig).toHaveBeenCalledWith({
      format: 'agents-md',
      includeSecrets: false,
      output: '/tmp/AGENTS.md',
    });
    expect(importConfig).toHaveBeenCalledWith('/tmp/AGENTS.md');
  });

  test('passes an explicit base through clean-before-start lifecycle calls', async () => {
    const { lifecycle, runCli } = await loadCliWithLifecycleMocks();

    await runCli([
      'start',
      '--clean',
      '--force',
      '--base=/tmp/station-home',
      '--instance=smoke-a',
      '--port=3242',
      '--ui-port=5274',
      '--host=127.0.0.1',
    ]);

    expect(lifecycle.clean).toHaveBeenCalledWith({
      actionLabel: 'start --clean',
      allowDefaultHomeClean: false,
      force: true,
      homeSource: '--base',
      instanceName: 'smoke-a',
      projectHome: '/tmp/station-home',
      serverPort: 3242,
      uiPort: 5274,
    });
    expect(lifecycle.start).toHaveBeenCalledWith({
      allowSharedHome: false,
      allowedOrigins: undefined,
      baseDir: '/tmp/station-home',
      build: false,
      features: undefined,
      force: true,
      homeSource: '--base',
      host: '127.0.0.1',
      instanceName: 'smoke-a',
      intent: undefined,
      lifecycleJournal: undefined,
      logFile: undefined,
      readinessFile: undefined,
      rotateLogOnRestart: false,
      serverPort: 3242,
      consentPort: 3245,
      uiPort: 5274,
    });
  });

  // station#4299: "isolated but persistent" had no flag. `--temp-home` throws
  // the home away and `--base` does not read as a home override, so the
  // nearest-looking option was the default -- the operator's real ~/.station.
  test('--home reaches start as the resolved home, with --home as its source', async () => {
    const { lifecycle, runCli } = await loadCliWithLifecycleMocks();

    await runCli([
      'start',
      '--home=/tmp/station-persistent-home',
      '--instance=smoke-home',
      '--port=3242',
      '--ui-port=5274',
    ]);

    expect(lifecycle.start).toHaveBeenCalledWith(
      expect.objectContaining({
        baseDir: '/tmp/station-persistent-home',
        homeSource: '--home',
        instanceName: 'smoke-home',
      }),
    );
  });

  test('--home wins over an ambient STATION_HOME', async () => {
    process.env.STATION_HOME = '/tmp/ambient-home';
    const { lifecycle, runCli } = await loadCliWithLifecycleMocks();

    await runCli(['start', '--home=/tmp/station-persistent-home']);

    expect(lifecycle.start).toHaveBeenCalledWith(
      expect.objectContaining({
        baseDir: '/tmp/station-persistent-home',
        homeSource: '--home',
      }),
    );
  });

  test('refuses --home together with --temp-home or --base', async () => {
    const { lifecycle, runCli } = await loadCliWithLifecycleMocks();

    await expect(
      runCli(['start', '--home=/tmp/keep-me', '--temp-home']),
    ).rejects.toThrow('--temp-home cannot be combined with --home.');
    await expect(
      runCli(['start', '--home=/tmp/keep-me', '--base=/tmp/other']),
    ).rejects.toThrow(
      '--home and --base set the same directory. Pass only one of them.',
    );
    expect(lifecycle.start).not.toHaveBeenCalled();
  });

  test('rejects the space-separated --home form rather than dropping it', async () => {
    // Every other value-taking lifecycle flag is `--flag=value` only. A
    // silently ignored `--home /tmp/x` would boot the default home, which is
    // the failure this flag exists to prevent.
    const { lifecycle, runCli } = await loadCliWithLifecycleMocks();

    await expect(
      runCli(['start', '--home', '/tmp/station-persistent-home']),
    ).rejects.toThrow(
      'Lifecycle option --home requires the --home=<value> form.',
    );
    expect(lifecycle.start).not.toHaveBeenCalled();
  });

  test('--allow-shared-home reaches start as true, not just as a default', async () => {
    // Value power: with only the default-false pins, replacing the flag's
    // wiring with a literal `false` passes every test — the override could
    // silently break while looking covered. This drives the flag through
    // runCli and asserts the TRUE value arrives at the contract boundary.
    const { lifecycle, runCli } = await loadCliWithLifecycleMocks();

    await runCli([
      'start',
      '--allow-shared-home',
      '--base=/tmp/station-home',
      '--instance=smoke-a',
      '--port=3242',
      '--ui-port=5274',
    ]);

    expect(lifecycle.start).toHaveBeenCalledWith(
      expect.objectContaining({ allowSharedHome: true }),
    );
  });

  test('validates the five-port reservation before a destructive clean or start', async () => {
    const { lifecycle, runCli } = await loadCliWithLifecycleMocks();
    lifecycle.validateLifecyclePorts.mockImplementation(
      (serverPort: number, uiPort: number) => {
        if (serverPort + 3 > 65_535 || uiPort === serverPort + 1) {
          throw new Error('invalid five-port reservation');
        }
      },
    );

    await expect(
      runCli(['start', '--clean', '--force', '--port=65534']),
    ).rejects.toThrow('invalid five-port reservation');
    expect(lifecycle.clean).not.toHaveBeenCalled();
    expect(lifecycle.start).not.toHaveBeenCalled();
  });

  test('reuses one generated temp home for clean-before-start flows', async () => {
    const { lifecycle, runCli } = await loadCliWithLifecycleMocks();

    await runCli([
      'start',
      '--clean',
      '--force',
      '--temp-home',
      '--instance=smoke-b',
      '--port=3243',
      '--ui-port=5275',
    ]);

    const cleanArgs = lifecycle.clean.mock.calls[0]?.[0];
    const startArgs = lifecycle.start.mock.calls[0]?.[0];

    expect(cleanArgs).toMatchObject({
      actionLabel: 'start --clean',
      allowDefaultHomeClean: false,
      force: true,
      homeSource: '--temp-home',
      instanceName: 'smoke-b',
      serverPort: 3243,
      uiPort: 5275,
    });
    expect(startArgs).toMatchObject({
      build: false,
      homeSource: '--temp-home',
      host: undefined,
      instanceName: 'smoke-b',
      serverPort: 3243,
      uiPort: 5275,
    });
    expect(cleanArgs.projectHome).toBe(startArgs.baseDir);
    expect(cleanArgs.projectHome).toMatch(/[\\/]station[\\/]dev-home-[^\\/]+$/);
  });

  test('uses the resolved home selector when stopping with an env home override', async () => {
    process.env.STATION_HOME = '/tmp/env-home';
    const { lifecycle, runCli } = await loadCliWithLifecycleMocks();

    await runCli(['stop']);

    expect(lifecycle.stop).toHaveBeenCalledWith({
      baseDir: '/tmp/env-home',
      instanceName: undefined,
      serverPort: undefined,
      uiPort: undefined,
    });
  });

  test('does not inject the resolved default home when stopping a named instance', async () => {
    process.env.STATION_HOME = '/tmp/env-home';
    const { lifecycle, runCli } = await loadCliWithLifecycleMocks();

    await runCli(['stop', '--instance=smoke-a']);

    expect(lifecycle.stop).toHaveBeenCalledWith({
      baseDir: undefined,
      instanceName: 'smoke-a',
      serverPort: undefined,
      uiPort: undefined,
    });
  });

  test('dispatches core resource commands through the shared core command handler', async () => {
    const runCoreCommand = vi.fn().mockResolvedValue(undefined);

    vi.doMock('../commands/build.js', () => ({ build: vi.fn() }));
    vi.doMock('../commands/config.js', () => ({
      configGet: vi.fn(),
      configSet: vi.fn(),
    }));
    vi.doMock('../commands/export.js', () => ({ exportConfig: vi.fn() }));
    vi.doMock('../commands/import.js', () => ({ importConfig: vi.fn() }));
    vi.doMock('../commands/init.js', () => ({
      createPlugin: vi.fn(),
      init: vi.fn(),
    }));
    vi.doMock('../commands/install-registry.js', () => ({
      recordRegistryInstall: vi.fn(),
      resolveRegistryPluginSource: vi.fn(),
    }));
    vi.doMock('../commands/install.js', () => ({
      info: vi.fn(),
      install: vi.fn(),
      installRegistryPlugin: vi.fn(),
      list: vi.fn(),
      preview: vi.fn(),
      registry: vi.fn(),
      remove: vi.fn(),
      update: vi.fn(),
    }));
    vi.doMock('../commands/lifecycle.js', () => ({
      buildApplication: vi.fn(),
      clean: vi.fn(),
      doctor: vi.fn(),
      doctorJson: vi.fn(),
      link: vi.fn(),
      shortcut: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      upgrade: vi.fn(),
      validateLifecyclePorts: vi.fn(),
    }));
    vi.doMock('../commands/core.js', () => ({
      runCoreCommand,
    }));
    vi.doMock('../dev/server.js', () => ({
      startDevServer: vi.fn(),
    }));

    const { runCli } = await import('../cli.js');
    await runCli(['agents', 'list', '--json']);
    await runCli(['tasks', 'list']);
    await runCli(['chat', 'default', 'hello']);

    expect(runCoreCommand).toHaveBeenNthCalledWith(1, 'agents', [
      'list',
      '--json',
    ]);
    expect(runCoreCommand).toHaveBeenNthCalledWith(2, 'tasks', ['list']);
    expect(runCoreCommand).toHaveBeenNthCalledWith(3, 'chat', [
      'default',
      'hello',
    ]);
  });

  test('includes tasks in the core workspace usage surface', async () => {
    await loadCliWithLifecycleMocks();
    const { usageText } = await import('../cli.js');
    const { actionsFor, commandHelpText } = await import('../help.js');
    const summary =
      'List, get, create, attach exact answers, inputs, or tool results, support them, and keep immutable task outputs';
    const taskOutputActions = [
      'list-outputs',
      'get-output',
      'keep-output',
      'download-output',
      'delete-output',
    ];
    const answerSupportActions = [
      'show-support',
      'list-support-bundles',
      'list-support-claims',
      'attach-support',
      'replace-support',
      'remove-support',
    ];
    const userInputActions = ['attach-input', 'show-inputs'];
    const toolResultActions = ['attach-result', 'show-results'];
    const taskOutputUsage = [
      '  station tasks list-outputs|get-output <taskId> [outputId]',
      '  station tasks keep-output <taskId> --path=<relativePath> --title=<title> --operation=<operationId>',
      '  station tasks download-output <taskId> <outputId> --out=<absolute destination>',
      '  station tasks delete-output <taskId> <outputId>',
    ];
    const answerSupportUsage = [
      '  station tasks show-support <taskId>',
      '  station tasks basis <taskId> [--answer-reference=<referenceId>] [--format summary|json]',
      '  station tasks list-support-bundles <taskId> --reference=<referenceId>',
      '  station tasks list-support-claims <taskId> --reference=<referenceId> --bundle=<bundleId>',
      '  station tasks attach-support <taskId> --reference=<referenceId> --bundle=<bundleId> --claim=<claimId>',
      '  station tasks replace-support <taskId> --reference=<referenceId> --bundle=<bundleId> --claim=<claimId> --revision=<revision>',
      '  station tasks remove-support <taskId> --reference=<referenceId> --revision=<revision>',
    ];
    const userInputUsage = [
      '  station tasks attach-input <taskId> --session=<sessionId> --event=<eventId>',
      '  station tasks show-inputs <taskId> [--json]',
    ];
    const toolResultUsage = [
      '  station tasks attach-result <taskId> --session=<sessionId> --event=<eventId>',
      '  station tasks show-results <taskId> [--json]',
    ];
    const taskHelp = commandHelpText('tasks') ?? '';

    expect(usageText()).toContain(`station tasks <action>       ${summary}`);
    expect(taskHelp).toContain(`station tasks — ${summary}`);
    expect(actionsFor('tasks')).toEqual([
      'list',
      'get',
      'create',
      'attach-turn',
      'show-turn',
      ...userInputActions,
      ...toolResultActions,
      'basis',
      ...answerSupportActions,
      ...taskOutputActions,
    ]);
    expect(taskHelp.match(/Usage:\n([\s\S]*?)\n\nActions:/)?.[1]).toContain(
      taskOutputUsage.join('\n'),
    );
    expect(taskHelp.match(/Usage:\n([\s\S]*?)\n\nActions:/)?.[1]).toContain(
      answerSupportUsage.join('\n'),
    );
    expect(taskHelp.match(/Usage:\n([\s\S]*?)\n\nActions:/)?.[1]).toContain(
      userInputUsage.join('\n'),
    );
    expect(taskHelp.match(/Usage:\n([\s\S]*?)\n\nActions:/)?.[1]).toContain(
      toolResultUsage.join('\n'),
    );
  });

  // Slice B (#1984): the interactive-menu and lazy-start additions must not
  // disturb the non-interactive contracts. With no TTY, `station service`
  // (no action) still delegates to runServiceCommand with an empty action —
  // whose canonical usage error is the deterministic non-TTY fallback — and a
  // bare `station` still prints usage rather than lazy-starting.
  describe('Slice B non-interactive fallbacks', () => {
    test('bare service (no TTY) delegates to runServiceCommand with no action', async () => {
      const { runCli, service } = await loadCliWithLifecycleMocks();

      await runCli(['service'], { isInteractive: false });

      expect(service.runServiceCommand).toHaveBeenCalledWith(
        [],
        expect.objectContaining({
          serverPort: expect.any(Number),
          uiPort: expect.any(Number),
        }),
      );
    });

    test('bare invocation (no TTY) still prints usage and does not lazy-start', async () => {
      const { lifecycle, runCli } = await loadCliWithLifecycleMocks();
      const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});

      await runCli([], { isInteractive: false });

      expect(stdout).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBeUndefined();
      expect(lifecycle.start).not.toHaveBeenCalled();
    });
  });

  // The S2 false-green fix: a typo'd command must never read as success.
  // (Found via tests/plugin-system.spec.ts running `cli.ts build` — usage
  // printed, exit 0, and a Playwright build step was a silent no-op.)
  describe('unknown-command exit codes', () => {
    test('top-level build dispatches a named lifecycle build', async () => {
      const { lifecycle, runCli } = await loadCliWithLifecycleMocks();

      await runCli(['build', '--instance=dogfood']);

      expect(process.exitCode).toBeUndefined();
      expect(lifecycle.buildApplication).toHaveBeenCalledWith({
        baseDir: expect.any(String),
        instanceName: 'dogfood',
        serverPort: expect.any(Number),
        uiPort: expect.any(Number),
      });
    });

    test('bare invocation and explicit help print usage to stdout with exit 0', async () => {
      const { runCli } = await loadCliWithLifecycleMocks();
      const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
      const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});

      await runCli([]);
      await runCli(['help']);
      await runCli(['--help']);
      await runCli(['-h']);

      expect(process.exitCode).toBeUndefined();
      expect(stdout).toHaveBeenCalledTimes(4);
      expect(stderr).not.toHaveBeenCalled();
    });

    test('unknown plugin subcommand exits non-zero with usage on stderr', async () => {
      const { runCli } = await loadCliWithLifecycleMocks();
      const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

      await runCli(['plugin', 'bogus']);

      expect(process.exitCode).toBe(1);
      expect(stderr).toHaveBeenCalledWith('Unknown command: plugin bogus');
    });

    test('bare plugin command (missing action) exits non-zero', async () => {
      const { runCli } = await loadCliWithLifecycleMocks();
      const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

      await runCli(['plugin']);

      expect(process.exitCode).toBe(1);
      expect(stderr).toHaveBeenCalledWith(
        'Unknown command: plugin (missing action)',
      );
    });

    test('unknown config action exits non-zero while bare config still lists', async () => {
      const configGet = vi.fn();
      vi.doMock('../commands/build.js', () => ({ build: vi.fn() }));
      vi.doMock('../commands/config.js', () => ({
        configGet,
        configSet: vi.fn(),
      }));
      vi.doMock('../commands/export.js', () => ({ exportConfig: vi.fn() }));
      vi.doMock('../commands/import.js', () => ({ importConfig: vi.fn() }));
      vi.doMock('../commands/init.js', () => ({
        createPlugin: vi.fn(),
        init: vi.fn(),
      }));
      vi.doMock('../commands/install-registry.js', () => ({
        recordRegistryInstall: vi.fn(),
        resolveRegistryPluginSource: vi.fn(),
      }));
      vi.doMock('../commands/install.js', () => ({
        info: vi.fn(),
        install: vi.fn(),
        installRegistryPlugin: vi.fn(),
        list: vi.fn(),
        preview: vi.fn(),
        registry: vi.fn(),
        remove: vi.fn(),
        update: vi.fn(),
      }));
      vi.doMock('../commands/lifecycle.js', () => ({
        buildApplication: vi.fn(),
        clean: vi.fn(),
        doctor: vi.fn(),
        doctorJson: vi.fn(),
        link: vi.fn(),
        shortcut: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        upgrade: vi.fn(),
        validateLifecyclePorts: vi.fn(),
      }));
      vi.doMock('../dev/server.js', () => ({ startDevServer: vi.fn() }));
      const { runCli } = await import('../cli.js');
      const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

      await runCli(['config']);
      expect(configGet).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBeUndefined();

      await runCli(['config', 'sett', 'key', 'value']);
      expect(process.exitCode).toBe(1);
      expect(stderr).toHaveBeenCalledWith('Unknown command: config sett');
    });

    test('known plugin build dispatches to build with exit 0', async () => {
      const build = vi.fn();
      vi.doMock('../commands/build.js', () => ({ build }));
      vi.doMock('../commands/config.js', () => ({
        configGet: vi.fn(),
        configSet: vi.fn(),
      }));
      vi.doMock('../commands/export.js', () => ({ exportConfig: vi.fn() }));
      vi.doMock('../commands/import.js', () => ({ importConfig: vi.fn() }));
      vi.doMock('../commands/init.js', () => ({
        createPlugin: vi.fn(),
        init: vi.fn(),
      }));
      vi.doMock('../commands/install-registry.js', () => ({
        recordRegistryInstall: vi.fn(),
        resolveRegistryPluginSource: vi.fn(),
      }));
      vi.doMock('../commands/install.js', () => ({
        info: vi.fn(),
        install: vi.fn(),
        installRegistryPlugin: vi.fn(),
        list: vi.fn(),
        preview: vi.fn(),
        registry: vi.fn(),
        remove: vi.fn(),
        update: vi.fn(),
      }));
      vi.doMock('../commands/lifecycle.js', () => ({
        buildApplication: vi.fn(),
        clean: vi.fn(),
        doctor: vi.fn(),
        doctorJson: vi.fn(),
        link: vi.fn(),
        shortcut: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        upgrade: vi.fn(),
        validateLifecyclePorts: vi.fn(),
      }));
      vi.doMock('../dev/server.js', () => ({ startDevServer: vi.fn() }));
      const { runCli } = await import('../cli.js');

      await runCli(['plugin', 'build']);

      expect(build).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBeUndefined();
    });
  });
});

describe('lifecycleArgvFrom — the positional [dir] is a project selector, not a home', () => {
  test('station <dir> --inline does NOT pass --base and resolves the default home', async () => {
    const { lifecycleArgvFrom, parseLifecycleArgs } = await import('../cli.js');

    // The `--inline` flag path (and the interactive inline choice) both funnel
    // the parsed options through lifecycleArgvFrom → parseLifecycleArgs, so
    // proving the shared builder never emits --base proves both start paths.
    const argv = lifecycleArgvFrom({
      dir: '/workspaces/my-project/',
      inline: true,
      serverPort: 3242,
      uiPort: 5274,
    });

    expect(argv).not.toContain('--base=/workspaces/my-project/');
    expect(argv.some((token) => token.startsWith('--base='))).toBe(false);
    expect(argv).toEqual(['--port=3242', '--ui-port=5274']);

    // End-to-end: the dir never becomes the Station home; the start resolves
    // its home as if no positional were given (default source, and never the
    // dir as the base directory).
    const parsed = parseLifecycleArgs(argv);
    expect(parsed.homeSource).toBe('default');
    expect(parsed.baseDir).not.toBe('/workspaces/my-project/');
  });

  test('--allow-shared-home survives the lazy hop end to end', async () => {
    // The default (lazy) path once ACCEPTED this token and silently dropped
    // it — the refusal's own remediation text pointed at a flag that did not
    // work on exactly the bare-`station` path where the prompt-then-refuse
    // UX bites. A future edit to parseDefaultArgs or lifecycleArgvFrom
    // reverts that bug with every suite green unless this pins the full hop.
    const { lifecycleArgvFrom, parseLifecycleArgs } = await import('../cli.js');

    const argv = lifecycleArgvFrom({ allowSharedHome: true, inline: true });
    expect(argv).toContain('--allow-shared-home');

    const parsed = parseLifecycleArgs(argv);
    expect(parsed.allowSharedHome).toBe(true);

    // And the default is genuinely absent, not merely falsy-by-luck.
    expect(lifecycleArgvFrom({ inline: true })).not.toContain(
      '--allow-shared-home',
    );
  });

  test('a temp-home start still routes to --temp-home and never the dir as base', async () => {
    const { lifecycleArgvFrom } = await import('../cli.js');

    const argv = lifecycleArgvFrom({
      dir: '/workspaces/my-project',
      tempHome: true,
    });

    expect(argv).toContain('--temp-home');
    expect(argv.some((token) => token.startsWith('--base='))).toBe(false);
  });
});
