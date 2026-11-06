import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../../__test-utils__/temp-dirs.js';
import { DeviceHubSupervisor } from '../device-hub-supervisor.js';
import {
  DEVICE_TOOL_RUNTIME_SETUP,
  resolveDeviceToolRuntime,
} from '../device-tool-runtime.js';
import { createNpmCiInstaller } from '../device-toolchain.js';

const makeTempDir = trackTempDirs();
function fixture() {
  const home = realpathSync(makeTempDir('station-device-user-node-'));
  /** A Node installation laid out as the official archive is. */
  function nodeInstallation(
    name: string,
    { npm: withNpm = true, executable = 'node' } = {},
  ) {
    const prefix = join(home, name);
    const bin = join(prefix, 'bin');
    const nodePath = join(
      bin,
      process.platform === 'win32' ? `${executable}.exe` : executable,
    );
    mkdirSync(bin, { recursive: true });
    copyFileSync(process.execPath, nodePath, constants.COPYFILE_FICLONE);
    const npm =
      process.platform === 'win32'
        ? join(bin, 'node_modules/npm/bin/npm-cli.js')
        : join(prefix, 'lib/node_modules/npm/bin/npm-cli.js');
    if (!withNpm) return { nodePath, bin, npm };
    mkdirSync(dirname(npm), { recursive: true });
    writeFileSync(
      npm,
      `require('node:fs').writeFileSync('npm-observation.json', JSON.stringify({node:process.execPath, path:process.env.PATH, args:process.argv.slice(2)}));`,
    );
    return { nodePath, bin, npm };
  }
  const first = nodeInstallation('User Node A');
  const second = nodeInstallation('User Node B');
  const env = {
    ...process.env,
    PATH: [first.bin, second.bin].join(delimiter),
    STATION_API_KEY: 'fixture-secret',
  };
  return { home, first, second, env, nodeInstallation };
}

/**
 * Runs the real installer and hub supervisor with `env` and `bundledNodePath`
 * and reports which Node each actually ran on.
 */
async function installAndStartHub(
  f: ReturnType<typeof fixture>,
  env: NodeJS.ProcessEnv,
  bundledNodePath: string | null,
) {
  const stage = join(f.home, 'install');
  mkdirSync(stage, { recursive: true });
  writeFileSync(
    join(stage, 'package.json'),
    JSON.stringify({ name: 'isolated-runtime-fixture', version: '1.0.0' }),
  );
  await createNpmCiInstaller({ env, bundledNodePath }).run({
    dir: stage,
    signal: new AbortController().signal,
  });
  const hub = join(f.home, 'hub.js');
  writeFileSync(
    hub,
    `require('node:fs').writeFileSync('hub-observation.json', JSON.stringify({node:process.execPath,path:process.env.PATH})); console.log('Local: http://localhost:51234'); setInterval(()=>{},1000);`,
  );
  const supervisor = new DeviceHubSupervisor({
    env,
    bundledNodePath,
    resolveLaunch: () => ({
      entry: hub,
      cwd: f.home,
      runDir: join(f.home, 'run'),
      version: '0.10.1',
    }),
    probeReady: async () => true,
  });
  try {
    await supervisor.ensureStarted();
    return {
      npm: JSON.parse(
        readFileSync(join(stage, 'npm-observation.json'), 'utf8'),
      ) as { node: string; args: string[] },
      hub: JSON.parse(
        readFileSync(join(f.home, 'hub-observation.json'), 'utf8'),
      ) as { node: string; path: string },
    };
  } finally {
    await supervisor.stop();
  }
}

describe('device tooling user runtime', () => {
  test('npm and the supervised external hub entry use the first user Node with unchanged PATH', async () => {
    const f = fixture();
    const stage = join(f.home, 'install');
    mkdirSync(stage);
    writeFileSync(
      join(stage, 'package.json'),
      JSON.stringify({ name: 'isolated-runtime-fixture', version: '1.0.0' }),
    );
    writeFileSync(
      join(stage, 'package-lock.json'),
      JSON.stringify({
        name: 'isolated-runtime-fixture',
        version: '1.0.0',
        lockfileVersion: 3,
        packages: {
          '': { name: 'isolated-runtime-fixture', version: '1.0.0' },
        },
      }),
    );
    await createNpmCiInstaller({ env: f.env }).run({
      dir: stage,
      signal: new AbortController().signal,
    });
    expect(existsSync(join(stage, 'npm-observation.json'))).toBe(true);
    expect(
      JSON.parse(readFileSync(join(stage, 'npm-observation.json'), 'utf8')),
    ).toMatchObject({
      node: f.first.nodePath,
      path: f.env.PATH,
      args: expect.arrayContaining(['ci', '--ignore-scripts']),
    });
    const hub = join(f.home, 'hub.js');
    writeFileSync(
      hub,
      `require('node:fs').writeFileSync('hub-observation.json', JSON.stringify({node:process.execPath,path:process.env.PATH})); console.log('Local: http://localhost:51234'); setInterval(()=>{},1000);`,
    );
    const supervisor = new DeviceHubSupervisor({
      env: f.env,
      resolveLaunch: () => ({
        entry: hub,
        cwd: f.home,
        runDir: join(f.home, 'run'),
        version: '0.10.1',
      }),
      probeReady: async () => true,
    });
    try {
      await supervisor.ensureStarted();
      expect(
        JSON.parse(readFileSync(join(f.home, 'hub-observation.json'), 'utf8')),
      ).toEqual({ node: f.first.nodePath, path: f.env.PATH });
    } finally {
      await supervisor.stop();
    }
  });

  test('an incomplete first installation cannot borrow npm from the second Node', async () => {
    const f = fixture();
    rmSync(f.first.npm);
    // Station's own Node is an archive from before npm was bundled.
    const oldArchive = f.nodeInstallation('Old Station runtime', {
      npm: false,
    });
    await expect(
      resolveDeviceToolRuntime(f.env, { bundledNodePath: oldArchive.nodePath }),
    ).rejects.toThrow('npm was not found in the selected Node.js installation');
  });

  test("a PATH Node without npm falls back to Station's own Node, never a later PATH Node", async () => {
    const f = fixture();
    rmSync(f.first.npm);
    const station = f.nodeInstallation('Station runtime');
    const observed = await installAndStartHub(f, f.env, station.nodePath);
    expect(observed.npm).toMatchObject({
      node: station.nodePath,
      args: expect.arrayContaining(['ci', '--ignore-scripts']),
    });
    expect(observed.hub).toEqual({ node: station.nodePath, path: f.env.PATH });
  });

  test("a foreground start with no Node on PATH installs and runs the hub on Station's own Node", async () => {
    const f = fixture();
    const station = f.nodeInstallation('Station runtime');
    // As `station start` from a shell: PATH has no Node at all.
    const env = { ...f.env, PATH: join(f.home, 'no-node-here') };
    const observed = await installAndStartHub(f, env, station.nodePath);
    expect(observed.npm.node).toBe(station.nodePath);
    expect(observed.hub).toEqual({ node: station.nodePath, path: env.PATH });
  });

  test("the desktop app's private station-node is never the fallback", async () => {
    const f = fixture();
    const desktop = f.nodeInstallation('Desktop', {
      executable: 'station-node',
    });
    await expect(
      resolveDeviceToolRuntime(
        { ...f.env, PATH: '' },
        { bundledNodePath: desktop.nodePath },
      ),
    ).rejects.toThrow("cannot use the desktop app's private Node.js");
  });

  test('no PATH Node and an old archive runtime give update guidance without a package-manager spawn', async () => {
    const f = fixture();
    const oldArchive = f.nodeInstallation('Old Station runtime', {
      npm: false,
    });
    const spawn = vi.fn();
    await expect(
      createNpmCiInstaller({
        env: { ...process.env, PATH: '' },
        bundledNodePath: oldArchive.nodePath,
        spawn,
      }).run({
        dir: tmpdir(),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      reason: 'package-manager-unavailable',
      retryable: false,
      message: expect.stringMatching(
        /^npm was not found in the selected Node\.js installation\. Update Station on this computer/,
      ),
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(DEVICE_TOOL_RUNTIME_SETUP).toMatch(
      /^Update Station on this computer/,
    );
  });

  test('no Node anywhere gives update guidance', async () => {
    await expect(
      resolveDeviceToolRuntime({ PATH: '' }, { bundledNodePath: null }),
    ).rejects.toThrow(
      `Node.js with npm was not found. ${DEVICE_TOOL_RUNTIME_SETUP}`,
    );
  });

  test.skipIf(process.platform === 'win32')(
    'custom version-manager directories reach the user Node shim',
    async () => {
      const f = fixture();
      const shim = join(f.home, 'custom-manager');
      mkdirSync(shim);
      const managerEnv = {
        ASDF_DATA_DIR: '/fixture/asdf-data',
        ASDF_DIR: '/fixture/asdf',
        NODENV_ROOT: '/fixture/nodenv',
      };
      writeFileSync(
        join(shim, 'node'),
        `#!/bin/sh
[ "$ASDF_DATA_DIR" = '/fixture/asdf-data' ] || exit 1
[ "$ASDF_DIR" = '/fixture/asdf' ] || exit 1
[ "$NODENV_ROOT" = '/fixture/nodenv' ] || exit 1
exec "${f.first.nodePath}" "$@"
`,
        { mode: 0o755 },
      );
      const runtime = await resolveDeviceToolRuntime({
        ...f.env,
        ...managerEnv,
        PATH: [shim, f.second.bin].join(delimiter),
      });
      expect(runtime.nodePath).toBe(f.first.nodePath);
    },
  );

  test.skipIf(process.platform === 'win32')(
    'an old first Node shim is rejected instead of silently choosing a later Node',
    async () => {
      const f = fixture();
      const shim = join(f.home, 'shim');
      mkdirSync(shim);
      const report = JSON.stringify({
        nodePath: f.first.nodePath,
        version: '22.0.0',
      });
      writeFileSync(
        join(shim, 'node'),
        `#!/bin/sh\nprintf '%s\n' '${report}'\n`,
        { mode: 0o755 },
      );
      await expect(
        resolveDeviceToolRuntime(
          { ...f.env, PATH: [shim, f.second.bin].join(delimiter) },
          { bundledNodePath: null },
        ),
      ).rejects.toThrow('Node.js 22.0.0 is too old');
    },
  );
});
