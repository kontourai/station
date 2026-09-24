/**
 * The device toolchain's install state machine and its verification
 * (#1970), with a fake installer standing in for `npm ci` over a synthetic
 * pin whose tool tarball is real bytes. Nothing here downloads anything.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  assertPinnedLock,
  DEVICE_TOOL_PINS,
  type DeviceToolPin,
} from '../device-tool-pins.js';
import {
  createNpmCiInstaller,
  DeviceToolConsentRequiredError,
  DeviceToolchain,
  DeviceToolInstallError,
  type DeviceToolInstaller,
  resolveNpmCommand,
} from '../device-toolchain.js';
import {
  type InstallTamper,
  makeTarball,
  type SyntheticTool,
  syntheticPins,
  syntheticTool,
  writeFakeInstall,
} from './fake-tool-install.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'station-device-toolchain-'));
  homes.push(home);
  return home;
}

const hub = syntheticTool('expo-device-hub');
const pins = syntheticPins();

function fakeInstaller(
  behave: (dir: string) => Promise<void> | void = () => {},
): DeviceToolInstaller & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    run: async ({ dir }) => {
      calls.push(dir);
      // The staging directory must already hold the pinned manifest and lock.
      const lock = JSON.parse(
        readFileSync(join(dir, 'package-lock.json'), 'utf8'),
      );
      expect(lock).toEqual(hub.pin.lock);
      await behave(dir);
    },
  };
}

function toolchainFor(
  home: string,
  tamper?: InstallTamper,
  synthetic: SyntheticTool = hub,
) {
  const installer = fakeInstaller((dir) =>
    writeFakeInstall(dir, synthetic, tamper),
  );
  return {
    installer,
    toolchain: new DeviceToolchain({ stationHome: home, installer, pins }),
  };
}

async function installOutcome(tamper: InstallTamper) {
  const home = tempHome();
  const { toolchain } = toolchainFor(home, tamper);
  await toolchain.install('expo-device-hub', { consent: true }).completion;
  return {
    home,
    toolchain,
    state: toolchain.state('expo-device-hub', true),
    published: existsSync(
      join(home, 'devices', 'tools', 'expo-device-hub', '9.9.9'),
    ),
  };
}

describe('device toolchain: pins', () => {
  test('the real pins are expo-device-hub 0.10.1 and agent-device 0.21.12, and are sound', () => {
    expect(DEVICE_TOOL_PINS['expo-device-hub'].version).toBe('0.10.1');
    expect(DEVICE_TOOL_PINS['agent-device'].version).toBe('0.21.12');
    expect(
      assertPinnedLock(DEVICE_TOOL_PINS['expo-device-hub']),
    ).toBeUndefined();
    expect(assertPinnedLock(DEVICE_TOOL_PINS['agent-device'])).toBeUndefined();
  });
});

describe('device toolchain: consent', () => {
  test('an install without the literal consent throws before any I/O', () => {
    const home = tempHome();
    const { toolchain, installer } = toolchainFor(home);
    for (const request of [undefined, {}, { consent: 'true' }, { consent: 1 }])
      expect(() =>
        toolchain.install(
          'expo-device-hub',
          request as unknown as { consent: true },
        ),
      ).toThrow(DeviceToolConsentRequiredError);
    expect(installer.calls).toEqual([]);
    expect(existsSync(join(home, 'devices'))).toBe(false);
    expect(toolchain.state('expo-device-hub', false).state).toBe(
      'needs-consent',
    );
  });

  test('needs-consent before any agreement, not-installed after one', () => {
    const { toolchain } = toolchainFor(tempHome());
    expect(toolchain.state('agent-device', false)).toEqual({
      tool: 'agent-device',
      state: 'needs-consent',
      requiredVersion: '9.9.9',
    });
    expect(toolchain.state('agent-device', true).state).toBe('not-installed');
  });
});

describe('device toolchain: install', () => {
  test('installing reports phases, then installed with a sentinel and no cache', async () => {
    const home = tempHome();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const toolchain = new DeviceToolchain({
      stationHome: home,
      pins,
      installer: fakeInstaller(async (dir) => {
        await gate;
        writeFakeInstall(dir, hub);
      }),
    });
    const { completion } = toolchain.install('expo-device-hub', {
      consent: true,
    });
    await vi.waitFor(() =>
      expect(toolchain.state('expo-device-hub', true)).toMatchObject({
        state: 'installing',
        phase: 'downloading',
        step: 2,
        totalSteps: 4,
      }),
    );
    release();
    await completion;
    expect(toolchain.state('expo-device-hub', true)).toEqual({
      tool: 'expo-device-hub',
      state: 'installed',
      version: '9.9.9',
    });
    const dir = join(home, 'devices', 'tools', 'expo-device-hub', '9.9.9');
    expect(readFileSync(join(dir, '.install-complete'), 'utf8').trim()).toBe(
      '9.9.9',
    );
    expect(existsSync(join(dir, '.npm-cache'))).toBe(false);
    expect(toolchain.installedEntry('expo-device-hub')).toBe(
      join(dir, 'node_modules', 'expo-device-hub', 'cli.mjs'),
    );
  });

  test('a recorded integrity that differs from the pin fails and publishes nothing', async () => {
    const outcome = await installOutcome({
      record: (packages) => {
        packages['node_modules/dep'] = {
          ...packages['node_modules/dep'],
          integrity: `sha512-${'A'.repeat(86)}==`,
        };
      },
    });
    expect(outcome.state).toMatchObject({
      state: 'failed',
      reason: 'integrity-mismatch',
      retryable: true,
    });
    expect(outcome.state.state === 'failed' && outcome.state.detail).toContain(
      'node_modules/dep was recorded with integrity',
    );
    expect(outcome.published).toBe(false);
  });

  test('a changed file in the installed tool fails content verification', async () => {
    const outcome = await installOutcome({
      toolFiles: (files) => {
        files['cli.mjs'] = '// tampered\n';
      },
    });
    expect(outcome.state).toMatchObject({
      state: 'failed',
      reason: 'integrity-mismatch',
      detail: 'expo-device-hub/cli.mjs differs from the pinned tarball.',
    });
    expect(outcome.published).toBe(false);
  });

  test('a file the pinned tarball does not contain fails content verification', async () => {
    const outcome = await installOutcome({
      toolFiles: (files) => {
        files['extra.js'] = 'module.exports = 1;\n';
      },
    });
    expect(outcome.state).toMatchObject({
      state: 'failed',
      detail: 'expo-device-hub/extra.js is not in the pinned tarball.',
    });
  });

  test('a fetched tarball missing from the private cache fails closed', async () => {
    const outcome = await installOutcome({ noCache: true });
    expect(outcome.state.state === 'failed' && outcome.state.detail).toContain(
      "tarball is not in the install's cache",
    );
    expect(outcome.published).toBe(false);
  });

  test('cached tarball bytes that do not hash to the pin fail, even when the files match them', async () => {
    // Another tarball whose files are exactly what was extracted: only the
    // tarball hash can tell it is not the pinned one.
    const impostorFiles = {
      ...hub.files,
      'package/cli.mjs': '// not the pinned bytes\n',
    };
    const impostor = makeTarball(impostorFiles);
    const outcome = await installOutcome({
      cacheBytes: impostor,
      toolFiles: (files) => {
        files['cli.mjs'] = '// not the pinned bytes\n';
      },
    });
    expect(outcome.state).toMatchObject({
      state: 'failed',
      reason: 'integrity-mismatch',
    });
    expect(
      outcome.state.state === 'failed' ? outcome.state.detail : '',
    ).toMatch(
      /^The fetched expo-device-hub tarball hashes to sha512-.+, not the pinned sha512-/,
    );
    expect(outcome.published).toBe(false);
  });

  test('an unrecorded package, even nested or scoped, fails the install', async () => {
    for (const extra of [
      'node_modules/left-pad',
      'node_modules/dep/node_modules/nested',
      'node_modules/@scope/pkg',
    ]) {
      const outcome = await installOutcome({ extraPackages: [extra] });
      expect(outcome.state).toMatchObject({
        state: 'failed',
        reason: 'integrity-mismatch',
        detail: `${extra} is not a package npm installed from the pinned lockfile.`,
      });
    }
  });

  test.each([
    // A loose file shadows `require('evil')` from any package.
    ['node_modules/evil.js', 'file'],
    // A directory npm did not install from the pin (no manifest).
    ['node_modules/nomanifest', 'dir'],
    // Nested and scoped loose entries.
    ['node_modules/dep/node_modules/x.js', 'file'],
    ['node_modules/@scope/x.js', 'file'],
    // Dot-directories, and `.bin` when no pinned package declares a bin.
    ['node_modules/.hidden', 'dir'],
    ['node_modules/.bin', 'dir'],
  ] as const)('an unpinned %s (%s) fails the install', async (path, kind) => {
    const outcome = await installOutcome({ extraEntries: [{ path, kind }] });
    expect(outcome.state).toMatchObject({
      state: 'failed',
      reason: 'integrity-mismatch',
      detail: `${path} is not a package npm installed from the pinned lockfile.`,
    });
    expect(outcome.published).toBe(false);
  });

  test('a pinned package replaced by a symlink fails, even to a matching manifest', async () => {
    const home = tempHome();
    const outside = join(home, 'outside-dep');
    const toolchain = new DeviceToolchain({
      stationHome: home,
      pins,
      installer: fakeInstaller((dir) => {
        writeFakeInstall(dir, hub);
        const dep = join(dir, 'node_modules', 'dep');
        rmSync(dep, { recursive: true, force: true });
        mkdirSync(outside, { recursive: true });
        writeFileSync(
          join(outside, 'package.json'),
          JSON.stringify({ version: '1.0.0' }),
        );
        symlinkSync(outside, dep, 'dir');
      }),
    });
    await toolchain.install('expo-device-hub', { consent: true }).completion;
    expect(toolchain.state('expo-device-hub', true)).toMatchObject({
      state: 'failed',
      reason: 'integrity-mismatch',
      detail:
        'node_modules/dep is not a package npm installed from the pinned lockfile.',
    });
  });

  test('a missing entry point is failed(entry-missing), not installed', async () => {
    const outcome = await installOutcome({
      toolFiles: (files) => {
        delete files['cli.mjs'];
      },
    });
    expect(outcome.state).toMatchObject({
      state: 'failed',
      reason: 'entry-missing',
      detail: 'The installed expo-device-hub has no entry point at cli.mjs.',
    });
    expect(outcome.toolchain.installedEntry('expo-device-hub')).toBeUndefined();
    expect(outcome.published).toBe(false);
  });

  test('a pin whose lock disagrees with its integrity never runs the installer', async () => {
    const installer = fakeInstaller();
    const drifted: DeviceToolPin = {
      ...hub.pin,
      requiredIntegrity: `sha512-${'C'.repeat(86)}==`,
    };
    const toolchain = new DeviceToolchain({
      stationHome: tempHome(),
      installer,
      pins: { ...pins, 'expo-device-hub': drifted },
    });
    await toolchain.install('expo-device-hub', { consent: true }).completion;
    expect(installer.calls).toEqual([]);
    expect(toolchain.state('expo-device-hub', true)).toMatchObject({
      state: 'failed',
      reason: 'integrity-mismatch',
      retryable: false,
    });
  });

  test('a package-manager failure is failed(install-failed) and a retry succeeds', async () => {
    let fail = true;
    const toolchain = new DeviceToolchain({
      stationHome: tempHome(),
      pins,
      installer: fakeInstaller((dir) => {
        if (fail)
          throw new DeviceToolInstallError('install-failed', 'npm ci exited 1');
        writeFakeInstall(dir, hub);
      }),
    });
    await toolchain.install('expo-device-hub', { consent: true }).completion;
    expect(toolchain.state('expo-device-hub', true)).toMatchObject({
      state: 'failed',
      reason: 'install-failed',
      detail: 'npm ci exited 1',
    });
    fail = false;
    await toolchain.install('expo-device-hub', { consent: true }).completion;
    expect(toolchain.state('expo-device-hub', true).state).toBe('installed');
  });

  test('stale staging directories are removed, fresh ones are left alone', () => {
    const home = tempHome();
    const root = join(home, 'devices', 'tools', 'expo-device-hub');
    const stale = join(root, '.staging-9.9.9-aaaa');
    const fresh = join(root, '.staging-9.9.9-bbbb');
    mkdirSync(stale, { recursive: true });
    mkdirSync(fresh, { recursive: true });
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(stale, old, old);
    const { toolchain } = toolchainFor(home);
    expect(toolchain.removeStaleStaging()).toEqual([stale]);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
});

describe('device toolchain: versions, updates and reclamation', () => {
  function seedOlder(home: string, version: string) {
    const dir = join(home, 'devices', 'tools', 'expo-device-hub', version);
    writeFakeInstall(dir, hub);
    writeFileSync(join(dir, '.install-complete'), `${version}\n`);
    return dir;
  }

  test('an older completed install reads as update-available', () => {
    const home = tempHome();
    seedOlder(home, '0.9.0');
    const { toolchain } = toolchainFor(home);
    expect(toolchain.state('expo-device-hub', true)).toEqual({
      tool: 'expo-device-hub',
      state: 'update-available',
      installedVersion: '0.9.0',
      requiredVersion: '9.9.9',
    });
  });

  test('the version check is read-only: it never installs or runs anything', () => {
    const home = tempHome();
    seedOlder(home, '0.9.0');
    const installer = fakeInstaller();
    const listProcessCommandLines = vi.fn(async () => []);
    const toolchain = new DeviceToolchain({
      stationHome: home,
      installer,
      pins,
      listProcessCommandLines,
    });
    expect(toolchain.versions({ 'expo-device-hub': '0.9.0' }).tools).toEqual([
      {
        tool: 'expo-device-hub',
        required: '9.9.9',
        installed: ['0.9.0'],
        running: '0.9.0',
      },
      { tool: 'agent-device', required: '9.9.9', installed: [], running: null },
    ]);
    expect(installer.calls).toEqual([]);
    expect(listProcessCommandLines).not.toHaveBeenCalled();
  });

  test('reclamation keeps the required version and anything in use', async () => {
    const home = tempHome();
    const inUse = seedOlder(home, '0.8.0');
    const byOtherProcess = seedOlder(home, '0.8.5');
    const obsolete = seedOlder(home, '0.9.0');
    const toolchain = new DeviceToolchain({
      stationHome: home,
      pins,
      installer: fakeInstaller((dir) => writeFakeInstall(dir, hub)),
      listProcessCommandLines: async () => [
        `node ${join(byOtherProcess, 'node_modules', 'expo-device-hub', 'cli.mjs')} --port 0`,
      ],
    });
    await toolchain.install('expo-device-hub', { consent: true }).completion;
    await expect(
      toolchain.reclaimObsolete('expo-device-hub', [inUse]),
    ).resolves.toEqual(['0.9.0']);
    expect(existsSync(inUse)).toBe(true);
    expect(existsSync(byOtherProcess)).toBe(true);
    expect(existsSync(obsolete)).toBe(false);
    expect(toolchain.installedVersions('expo-device-hub')).toEqual([
      '0.8.0',
      '0.8.5',
      '9.9.9',
    ]);
  });

  test('when process command lines cannot be read, nothing is reclaimed', async () => {
    const home = tempHome();
    const obsolete = seedOlder(home, '0.9.0');
    const toolchain = new DeviceToolchain({
      stationHome: home,
      pins,
      installer: fakeInstaller(),
      listProcessCommandLines: async () => undefined,
    });
    await expect(
      toolchain.reclaimObsolete('expo-device-hub', []),
    ).resolves.toEqual([]);
    expect(existsSync(obsolete)).toBe(true);
  });
});

describe('npm ci installer', () => {
  test('runs npm ci with --ignore-scripts, --omit=dev and the staging-private cache, in a scrubbed env', async () => {
    const calls: Array<{
      command: string;
      args: string[];
      options: { cwd: string; env: NodeJS.ProcessEnv; windowsHide: true };
    }> = [];
    const installer = createNpmCiInstaller({
      resolveNpm: () => ({
        command: '/opt/node/bin/node',
        prefixArgs: ['/opt/node/lib/node_modules/npm/bin/npm-cli.js'],
      }),
      env: {
        PATH: '/usr/bin',
        HOME: '/home/me',
        ANTHROPIC_API_KEY: 'secret',
        STATION_TOKEN: 'secret',
      },
      spawn: ((command: string, args: string[], options: never) => {
        calls.push({ command, args, options });
        const child = Object.assign(new PassThrough(), {
          stderr: new PassThrough(),
          kill: () => true,
        });
        queueMicrotask(() => child.emit('exit', 0, null));
        return child;
      }) as never,
    });
    await installer.run({
      dir: '/home/me/.station/devices/tools/expo-device-hub/.staging-x',
      signal: new AbortController().signal,
    });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.command).toBe('/opt/node/bin/node');
    expect(call?.args).toEqual([
      '/opt/node/lib/node_modules/npm/bin/npm-cli.js',
      'ci',
      '--ignore-scripts',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      '--no-update-notifier',
      '--cache',
      '/home/me/.station/devices/tools/expo-device-hub/.staging-x/.npm-cache',
    ]);
    expect(call?.options.cwd).toBe(
      '/home/me/.station/devices/tools/expo-device-hub/.staging-x',
    );
    expect(call?.options.windowsHide).toBe(true);
    expect(call?.options.env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/me',
      npm_config_ignore_scripts: 'true',
    });
  });
});

describe('resolveNpmCommand', () => {
  test('prefers the npm-cli.js beside the Node runtime, run with that Node', () => {
    const exists = (path: string) =>
      path === '/opt/node/lib/node_modules/npm/bin/npm-cli.js';
    expect(
      resolveNpmCommand('/opt/node/bin/node', 'darwin', exists, '/usr/bin'),
    ).toEqual({
      command: '/opt/node/bin/node',
      prefixArgs: ['/opt/node/lib/node_modules/npm/bin/npm-cli.js'],
    });
  });

  test('falls back to npm on PATH, and to nothing on Windows without npm-cli.js', () => {
    const exists = (path: string) => path === '/usr/local/bin/npm';
    expect(
      resolveNpmCommand(
        '/opt/node/bin/node',
        'linux',
        exists,
        'relative:/usr/local/bin',
      ),
    ).toEqual({ command: '/usr/local/bin/npm', prefixArgs: [] });
    expect(
      resolveNpmCommand('C:\\node\\node.exe', 'win32', () => false, ''),
    ).toBeUndefined();
  });
});
