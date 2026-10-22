import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { DeviceHubSupervisor } from '../device-hub-supervisor.js';
import { resolveDeviceToolRuntime } from '../device-tool-runtime.js';
import { createNpmCiInstaller } from '../device-toolchain.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const home = realpathSync(
    mkdtempSync(join(tmpdir(), 'station-device-user-node-')),
  );
  homes.push(home);
  function nodeInstallation(name: string) {
    const prefix = join(home, name);
    const bin = join(prefix, 'bin');
    const nodePath = join(
      bin,
      process.platform === 'win32' ? 'node.exe' : 'node',
    );
    mkdirSync(bin, { recursive: true });
    copyFileSync(process.execPath, nodePath, constants.COPYFILE_FICLONE);
    const npm =
      process.platform === 'win32'
        ? join(bin, 'node_modules/npm/bin/npm-cli.js')
        : join(prefix, 'lib/node_modules/npm/bin/npm-cli.js');
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
  return { home, first, second, env };
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
    await expect(resolveDeviceToolRuntime(f.env)).rejects.toThrow(
      'npm was not found in the selected Node.js installation',
    );
  });

  test('no user Node produces actionable setup guidance without a package-manager spawn', async () => {
    await expect(
      createNpmCiInstaller({ env: { ...process.env, PATH: '' } }).run({
        dir: tmpdir(),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      reason: 'package-manager-unavailable',
      retryable: false,
      message: expect.stringContaining('Install Node.js 24 or later with npm'),
    });
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
        resolveDeviceToolRuntime({
          ...f.env,
          PATH: [shim, f.second.bin].join(delimiter),
        }),
      ).rejects.toThrow('Node.js 22.0.0 is too old');
    },
  );
});
