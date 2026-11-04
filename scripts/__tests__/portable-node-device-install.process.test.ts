/**
 * The portable archive's bundled Node is the only Node a host may have. Its
 * `runtime/` must carry the distribution's npm so the consent-gated device hub
 * install (`npm ci` of the pinned lockfile) works with no system Node or npm.
 *
 * The distribution fixture has the official archive's shape (`bin/node` plus
 * `lib/node_modules/npm`, or `node.exe` plus `node_modules/npm` on Windows),
 * built from this host's real Node executable and its real npm. The registry
 * is a loopback server holding the pinned tarball; npm's default
 * `replace-registry-host` sends the lockfile's registry.npmjs.org URLs there.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { makeTarball } from '../../src-server/services/devices/toolchain/__tests__/fake-tool-install.js';
import type { DeviceToolPin } from '../../src-server/services/devices/toolchain/device-tool-pins.js';
import { resolveNpmCommand } from '../../src-server/services/devices/toolchain/device-tool-runtime.js';
import {
  createNpmCiInstaller,
  DeviceToolchain,
} from '../../src-server/services/devices/toolchain/device-toolchain.js';
import {
  archiveTool,
  stagePortableNodeRuntime,
} from '../lib/portable-server-archive.mjs';

const makeTempDir = trackTempDirs();
const windows = process.platform === 'win32';
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise((done) => s.close(done))),
  );
});

/** This host's real npm package directory, from its own Node installation. */
function hostNpmPackage(): string {
  const npm = resolveNpmCommand(realpathSync(process.execPath));
  // A host without npm cannot build the fixture; that is a failure, not a pass.
  if (!npm) throw new Error(`${process.execPath} has no adjacent npm`);
  return dirname(dirname(npm.prefixArgs[0]));
}

/**
 * `real` copies this host's Node executable and npm: a copy, never a link,
 * so the staged runtime cannot resolve back to the host's own npm.
 * Otherwise the binary is a placeholder and npm lacks its CLI.
 */
function distribution(root: string, real = true) {
  const directory = 'node-fixture';
  const top = join(root, 'input', directory);
  const binary = windows ? 'node.exe' : join('bin', 'node');
  const npm = windows ? 'node_modules/npm' : 'lib/node_modules/npm';
  mkdirSync(dirname(join(top, binary)), { recursive: true });
  writeFileSync(join(top, 'LICENSE'), 'Node fixture license');
  if (real) {
    copyFileSync(process.execPath, join(top, binary));
    cpSync(hostNpmPackage(), join(top, npm), { recursive: true });
  } else {
    writeFileSync(join(top, binary), 'placeholder executable');
    mkdirSync(join(top, npm, 'bin'), { recursive: true });
    writeFileSync(join(top, npm, 'package.json'), '{"name":"npm"}');
  }
  const file = `${directory}.${windows ? 'zip' : 'tar.gz'}`;
  const archive = join(root, file);
  execFileSync(
    archiveTool(),
    ['-acf', archive, '-C', join(root, 'input'), directory],
    { windowsHide: true },
  );
  return {
    target: {
      platform: process.platform,
      node: { file, directory, binary },
    },
    bytes: readFileSync(archive),
  };
}

function integrity(bytes: Buffer) {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

function hubPin(tarball: Buffer): DeviceToolPin {
  const tool = 'expo-device-hub';
  const version = '9.9.9';
  return {
    tool,
    version,
    requiredIntegrity: integrity(tarball),
    entry: ['cli.mjs'],
    lock: {
      name: 'station-device-tool',
      lockfileVersion: 3,
      packages: {
        '': {
          name: 'station-device-tool',
          dependencies: { [tool]: version },
        },
        [`node_modules/${tool}`]: {
          version,
          resolved: `https://registry.npmjs.org/${tool}/-/${tool}-${version}.tgz`,
          integrity: integrity(tarball),
        },
      },
    },
  };
}

async function registry(tarball: Buffer) {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? '');
    if (request.url === '/expo-device-hub/-/expo-device-hub-9.9.9.tgz') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(tarball);
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/`, requests };
}

describe('portable archive Node runtime', () => {
  it('installs the pinned device hub with only the archive runtime on PATH', async () => {
    const root = realpathSync(makeTempDir('portable-node-device-'));
    const { target, bytes } = distribution(root);
    const stage = join(root, 'station');
    stagePortableNodeRuntime(target, bytes, stage);

    const runtimeBin = join(stage, 'runtime', ...(windows ? [] : ['bin']));
    // The dependency is absent from the selected installation's bin: no npm
    // launcher, only Node. npm exists solely as the distribution's package.
    expect(readdirSync(runtimeBin).sort()).toEqual(
      windows ? ['LICENSE', 'node.exe', 'node_modules'] : ['node'],
    );

    const tarball = makeTarball({
      'package/package.json': JSON.stringify({
        name: 'expo-device-hub',
        version: '9.9.9',
      }),
      'package/cli.mjs': '// fixture hub\n',
    });
    const pin = hubPin(tarball);
    const served = await registry(tarball);
    const home = join(root, 'home');
    mkdirSync(home);
    writeFileSync(join(home, '.npmrc'), `registry=${served.url}\n`);
    const env: NodeJS.ProcessEnv = {
      PATH: runtimeBin,
      HOME: home,
      USERPROFILE: home,
      ...(windows ? { SystemRoot: process.env.SystemRoot } : {}),
      TMPDIR: process.env.TMPDIR,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
    };

    const toolchain = new DeviceToolchain({
      stationHome: join(root, 'station-home'),
      installer: createNpmCiInstaller({ env }),
      pins: { 'expo-device-hub': pin, 'agent-device': pin },
      listProcessCommandLines: async () => undefined,
    });
    await toolchain.install('expo-device-hub', { consent: true }).completion;

    // Compared whole so a failed install prints its reason and detail.
    const state = toolchain.state('expo-device-hub', true);
    expect(state.state === 'failed' ? state : state.state).toBe('installed');
    const entry = toolchain.installedEntry('expo-device-hub');
    expect(entry && readFileSync(entry, 'utf8')).toBe('// fixture hub\n');
    expect(served.requests).toContain(
      '/expo-device-hub/-/expo-device-hub-9.9.9.tgz',
    );
  }, 120_000);

  it('refuses a distribution whose npm package has no CLI', () => {
    const root = realpathSync(makeTempDir('portable-node-no-npm-'));
    const { target, bytes } = distribution(root, false);
    expect(() =>
      stagePortableNodeRuntime(target, bytes, join(root, 'out')),
    ).toThrow(/does not contain (lib\/)?node_modules\/npm/);
  });
});
