import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { CHANNEL_PORTS, RELEASE_RINGS } from '../channel-ports.mjs';
import {
  bundleInstallerCore,
  checkInstallPs1Script,
  checkInstallScript,
  INSTALL_PS1_PATH,
  INSTALL_SCRIPT_PATH,
  renderInstallPs1Script,
  renderInstallScript,
  syncInstallPs1Script,
  syncInstallScript,
} from '../install-script-generated.mjs';

const root = resolve(import.meta.dirname, '../..');
const makeTempDir = trackTempDirs();
type Ports = { serverPort: number; uiPort: number };
type Ring = { runtimeChannel: string; prerelease: boolean; launcher: string };
const ports = CHANNEL_PORTS as Record<string, Ports>;
const rings = RELEASE_RINGS as Record<string, Ring>;

function scratchCopy(): string {
  const path = join(makeTempDir('station-install-generated-'), 'install.sh');
  copyFileSync(INSTALL_SCRIPT_PATH, path);
  return path;
}

describe('install.sh generated blocks', () => {
  it('matches what the generator renders from its config sources', () => {
    expect(() => checkInstallScript()).not.toThrow();
  });

  it('embeds the checked-in signing-key table, assigned exactly once', () => {
    const config = JSON.parse(
      readFileSync(join(root, 'config/release-manifest-keys.json'), 'utf8'),
    );
    const script = readFileSync(INSTALL_SCRIPT_PATH, 'utf8');
    const expectedLine = `PINNED_MANIFEST_SIGNING_KEYS='${JSON.stringify(config)}'`;
    // Exactly one assignment, and the verifier is its only reader: a second
    // assignment (or an env/default expansion) could silently replace it.
    const uses = script
      .split('\n')
      .filter((line) => line.includes('PINNED_MANIFEST_SIGNING_KEYS'))
      .filter((line) => !line.startsWith('# '));
    expect(uses).toHaveLength(2);
    expect(uses[0]).toBe(expectedLine);
    expect(uses[1]).toContain(' "$PINNED_MANIFEST_SIGNING_KEYS" ');
    expect(uses[1]).not.toMatch(/PINNED_MANIFEST_SIGNING_KEYS[:=-]/);
  });

  it('defines each generated channel name exactly once', () => {
    // --check compares only the marker blocks, so a second definition after
    // them would shadow the generated one without making the check fail.
    const lines = readFileSync(INSTALL_SCRIPT_PATH, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => !line.startsWith('#'));
    for (const definition of [
      /^(?:(?:export|readonly)\s+)?RELEASE_RINGS_JSON=/,
      /^(?:(?:export|readonly)\s+)?INSTALLABLE_RUNTIME_CHANNELS=/,
      /^channel_constants\s*\(\s*\)/,
      /^(?:(?:export|readonly)\s+)?PORTABLE_SERVER_TARGETS_JSON=/,
      /^(?:(?:export|readonly)\s+)?PINNED_NODE_VERSION=/,
      /^(?:(?:export|readonly)\s+)?PINNED_NODE_ORIGIN=/,
      /^pinned_node_distribution\s*\(\s*\)/,
    ]) {
      expect(lines.filter((line) => definition.test(line))).toHaveLength(1);
    }
  });

  it('projects every installable ring and its channel ports into install.sh', () => {
    const script = readFileSync(INSTALL_SCRIPT_PATH, 'utf8');
    expect(Object.keys(rings)).toEqual(['stable', 'preview', 'nightly']);
    for (const [ring, entry] of Object.entries(rings)) {
      const { serverPort, uiPort } = ports[entry.runtimeChannel];
      expect(script).toContain(
        [
          `    ${entry.runtimeChannel})`,
          `      runtime_release_channel=${ring}`,
          `      runtime_server_port=${serverPort}`,
          `      runtime_ui_port=${uiPort}`,
          `      runtime_launcher_name=${entry.launcher}`,
          '      ;;',
        ].join('\n'),
      );
    }
    expect(script).toContain(
      `RELEASE_RINGS_JSON='${JSON.stringify({
        stable: { runtimeChannel: 'stable', prerelease: false },
        preview: { runtimeChannel: 'beta', prerelease: true },
        nightly: { runtimeChannel: 'nightly', prerelease: true },
      })}'`,
    );
  });

  it('projects the pinned Node.js distributions and archive targets into install.sh', () => {
    const script = readFileSync(INSTALL_SCRIPT_PATH, 'utf8');
    const runtime = JSON.parse(
      readFileSync(
        join(root, 'config/portable-server-node-runtime.json'),
        'utf8',
      ),
    );
    expect(script).toContain(`PINNED_NODE_VERSION='${runtime.version}'\n`);
    expect(script).toContain(`PINNED_NODE_ORIGIN='${runtime.origin}'\n`);
    // Every POSIX target, and only those: Windows installs via install.ps1.
    for (const id of ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'])
      expect(script).toContain(
        [
          `    ${id})`,
          `      pinned_node_file='${runtime.distributions[id].file}'`,
          `      pinned_node_sha256=${runtime.distributions[id].sha256}`,
          '      ;;',
        ].join('\n'),
      );
    expect(script).not.toContain('win32-x64)');
    expect(script).toContain(
      `PORTABLE_SERVER_TARGETS_JSON='${JSON.stringify([
        { os: 'darwin', arch: 'arm64', format: 'tar.gz' },
        { os: 'darwin', arch: 'x64', format: 'tar.gz' },
        { os: 'linux', arch: 'arm64', format: 'tar.gz' },
        { os: 'linux', arch: 'x64', format: 'tar.gz' },
        { os: 'win32', arch: 'x64', format: 'zip' },
      ])}'`,
    );
  });

  it.each([
    [
      'a hand-edited channel port',
      'runtime_server_port=38141',
      'runtime_server_port=38142',
    ],
    [
      'a hand-edited ring table',
      '"nightly":{"runtimeChannel":"nightly","prerelease":true}',
      '"nightly":{"runtimeChannel":"beta","prerelease":true}',
    ],
    [
      'a hand-edited Node.js pin',
      'pinned_node_sha256=bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057',
      'pinned_node_sha256=bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6058',
    ],
    [
      'a hand-edited archive target',
      '{"os":"win32","arch":"x64","format":"zip"}',
      '{"os":"win32","arch":"x64","format":"tar.gz"}',
    ],
    [
      'a hand-edited signing key',
      'MCowBQYDK2VwAyEAH74uCwGmcJFftH+reVCJjJysQRRON2k0mTUoDBf14OM=',
      'MCowBQYDK2VwAyEAH74uCwGmcJFftH+reVCJjJysQRRON2k0mTUoDBf14OO=',
    ],
  ])('fails the check for %s, and --sync restores it', (_name, from, to) => {
    const path = scratchCopy();
    const pristine = readFileSync(path, 'utf8');
    expect(pristine.split(from)).toHaveLength(2);
    writeFileSync(path, pristine.replace(from, to));
    expect(() => checkInstallScript(path)).toThrow(
      /Generated install\.sh blocks are stale/,
    );
    syncInstallScript(path);
    expect(readFileSync(path, 'utf8')).toBe(pristine);
    expect(() => checkInstallScript(path)).not.toThrow();
  });

  it('refuses a script whose generated markers are missing or duplicated', () => {
    const pristine = readFileSync(INSTALL_SCRIPT_PATH, 'utf8');
    expect(() =>
      renderInstallScript(
        pristine.replace('# END GENERATED CHANNEL CONSTANTS\n', ''),
      ),
    ).toThrow(/exactly one CHANNEL CONSTANTS block/);
    expect(() =>
      renderInstallScript(
        `${pristine}# BEGIN GENERATED PINNED MANIFEST SIGNING KEYS\n# END GENERATED PINNED MANIFEST SIGNING KEYS\n`,
      ),
    ).toThrow(/exactly one PINNED MANIFEST SIGNING KEYS block/);
  });
});

function scratchPs1Copy(): string {
  const path = join(
    makeTempDir('station-install-ps1-generated-'),
    'install.ps1',
  );
  copyFileSync(INSTALL_PS1_PATH, path);
  return path;
}

/** The base64 core block of an install.ps1 text, decoded. */
function embeddedCore(script: string): string {
  const match = /^\$StationInstallerCore = @'\n([A-Za-z0-9+/=\n]+)\n'@$/m.exec(
    script,
  );
  if (!match) throw new Error('no installer core block');
  return Buffer.from(match[1].replace(/\n/g, ''), 'base64').toString('utf8');
}

describe('install.ps1 generated blocks (#2675 slice W)', () => {
  it('matches what the generator renders from its sources', () => {
    expect(() => checkInstallPs1Script()).not.toThrow();
  });

  it('embeds the bundled installer core, which carries the pinned keys and exports the verifier', () => {
    const script = readFileSync(INSTALL_PS1_PATH, 'utf8');
    const core = embeddedCore(script);
    expect(core).toBe(bundleInstallerCore());
    // The pinned public keys travel inside the bundle, not as a second copy.
    const config = JSON.parse(
      readFileSync(join(root, 'config/release-manifest-keys.json'), 'utf8'),
    );
    for (const key of config.keys) {
      expect(core).toContain(key.keyId);
      expect(core).toContain(key.publicKeySpkiPem.split('\n')[1] as string);
    }
    const dir = makeTempDir('station-install-ps1-core-');
    const path = join(dir, 'core.cjs');
    writeFileSync(path, core);
    const loaded = createRequire(import.meta.url)(path);
    expect(typeof loaded.verifyInstallManifest).toBe('function');
    expect(typeof loaded.runInstaller).toBe('function');
  });

  it('projects the pinned win32-x64 Node.js zip and the installable channels', () => {
    const script = readFileSync(INSTALL_PS1_PATH, 'utf8');
    const runtime = JSON.parse(
      readFileSync(
        join(root, 'config/portable-server-node-runtime.json'),
        'utf8',
      ),
    );
    const pin = runtime.distributions['win32-x64'];
    expect(script).toContain(`$PinnedNodeFile = '${pin.file}'\n`);
    expect(script).toContain(`$PinnedNodeSha256 = '${pin.sha256}'\n`);
    expect(script).toContain(`$PinnedNodeOrigin = '${runtime.origin}'\n`);
    expect(script).toContain(
      `$PinnedNodeEntry = '${pin.file.replace(/\.zip$/, '')}/node.exe'\n`,
    );
    expect(script).toContain(
      "$InstallableRuntimeChannels = @('stable', 'beta', 'nightly')\n",
    );
    // Each generated name is assigned exactly once, so nothing after the
    // blocks can shadow them.
    for (const name of [
      'InstallableRuntimeChannels',
      'PinnedNodeVersion',
      'PinnedNodeOrigin',
      'PinnedNodeFile',
      'PinnedNodeEntry',
      'PinnedNodeSha256',
      'StationInstallerCore',
    ])
      expect(
        script
          .split('\n')
          .filter((line) => line.trim().startsWith(`$${name} =`)),
      ).toHaveLength(1);
  });

  it.each([
    [
      'a hand-edited Node.js pin',
      "$PinnedNodeSha256 = '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541'",
      "$PinnedNodeSha256 = '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e542'",
    ],
    [
      'a hand-edited channel list',
      "@('stable', 'beta', 'nightly')",
      "@('stable', 'beta', 'nightly', 'dev')",
    ],
  ])('fails the check for %s, and --sync restores it', (_name, from, to) => {
    const path = scratchPs1Copy();
    const pristine = readFileSync(path, 'utf8');
    expect(pristine.split(from)).toHaveLength(2);
    writeFileSync(path, pristine.replace(from, to));
    expect(() => checkInstallPs1Script(path)).toThrow(
      /Generated install\.ps1 blocks are stale/,
    );
    syncInstallPs1Script(path);
    expect(readFileSync(path, 'utf8')).toBe(pristine);
  });

  it('fails the check for a hand-edited installer core byte', () => {
    const path = scratchPs1Copy();
    const pristine = readFileSync(path, 'utf8');
    const core = embeddedCore(pristine);
    const tampered = core.replace(
      'refusing to downgrade Station',
      'refusing to downgrade Stati0n',
    );
    expect(tampered).not.toBe(core);
    const encode = (text: string) =>
      (
        Buffer.from(text)
          .toString('base64')
          .match(/.{1,120}/g) ?? []
      ).join('\n');
    writeFileSync(path, pristine.replace(encode(core), encode(tampered)));
    expect(readFileSync(path, 'utf8')).not.toBe(pristine);
    expect(() => checkInstallPs1Script(path)).toThrow(
      /Generated install\.ps1 blocks are stale/,
    );
  });

  it('refuses a script whose generated markers are missing', () => {
    const pristine = readFileSync(INSTALL_PS1_PATH, 'utf8');
    expect(() =>
      renderInstallPs1Script(
        pristine.replace('# END GENERATED INSTALLER CORE\n', ''),
      ),
    ).toThrow(/install\.ps1 must contain exactly one INSTALLER CORE block/);
  });
});

describe('install-script:check as a process', () => {
  // The gate verify:static:raw runs is the CLI, not the exported functions, so
  // run it as a child and read its exit status in both directions.
  function runCheck(cwd: string) {
    return spawnSync(
      process.execPath,
      [join(cwd, 'scripts/install-script-generated.mjs'), '--check'],
      { cwd, encoding: 'utf8' },
    );
  }

  it('exits 0 on this checkout', () => {
    const result = runCheck(root);
    expect(result.status, result.stderr).toBe(0);
  });

  it('exits non-zero, naming the stale blocks, when install.sh drifts', () => {
    const copy = makeTempDir('station-install-check-');
    mkdirSync(join(copy, 'scripts/lib'), { recursive: true });
    mkdirSync(join(copy, 'config'));
    mkdirSync(join(copy, 'packages/shared/src'), { recursive: true });
    for (const file of [
      'scripts/install-script-generated.mjs',
      'scripts/channel-ports.mjs',
      'scripts/lib/module-entry.mjs',
      'config/channel-ports.json',
      'config/release-manifest-keys.json',
      'config/portable-server-node-runtime.json',
      'packages/shared/src/portable-server-targets.mjs',
    ]) {
      copyFileSync(join(root, file), join(copy, file));
    }
    const nightly = String(ports.nightly.serverPort);
    const source = readFileSync(INSTALL_SCRIPT_PATH, 'utf8');
    expect(source).toContain(nightly);
    writeFileSync(
      join(copy, 'install.sh'),
      source.replace(nightly, String(ports.nightly.serverPort + 1)),
    );

    const result = runCheck(copy);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/stale/i);
  });

  it('exits non-zero, naming install.ps1, when only install.ps1 drifts', () => {
    // A checkout copy with the installer core's sources and this checkout's
    // node_modules, so the child bundles the core as the real gate does.
    const copy = makeTempDir('station-install-check-ps1-');
    for (const path of [
      'scripts/install-script-generated.mjs',
      'scripts/channel-ports.mjs',
      'scripts/lib/module-entry.mjs',
      'config/channel-ports.json',
      'config/release-manifest-keys.json',
      'config/portable-server-node-runtime.json',
      'packages/shared/src/portable-server-targets.mjs',
      'packages/shared/src/release-manifest.mjs',
      'packages/shared/src/release-rings.generated.mjs',
      'packages/shared/src/channel-ports.generated.ts',
      'packages/shared/src/release-manifest-keys.generated.ts',
      'packages/shared/src/windows-path-trust.ts',
      'packages/shared/src/windows-system-utility.mjs',
      'packages/shared/src/installer',
      'install.sh',
    ])
      cpSync(join(root, path), join(copy, path), { recursive: true });
    symlinkSync(join(root, 'node_modules'), join(copy, 'node_modules'));
    writeFileSync(
      join(copy, 'install.ps1'),
      readFileSync(INSTALL_PS1_PATH, 'utf8').replace(
        "$PinnedNodeVersion = '24.21.0'",
        "$PinnedNodeVersion = '24.21.1'",
      ),
    );
    const stale = runCheck(copy);
    expect(stale.status).not.toBe(0);
    expect(stale.stderr).toContain('Generated install.ps1 blocks are stale');

    copyFileSync(INSTALL_PS1_PATH, join(copy, 'install.ps1'));
    const fresh = runCheck(copy);
    expect(fresh.status, fresh.stderr).toBe(0);
  });
});
