import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  buildWindowsArchive,
  extractInstallerCore,
  signWindowsManifest,
  type WindowsArchive,
} from './fixtures/windows-archive.js';

/**
 * install.ps1's installer core (#2675 slice W1), exactly as install.ps1
 * embeds it: the generated base64 block is decoded and run with this Node.js
 * as a child process, the way the PowerShell bootstrap runs it. The fixture
 * archives are Windows-layout zips whose runtime/node.exe wraps this Node.js,
 * so every step through the `--version` self-check really runs on a POSIX
 * host. STATION_INSTALL_TEST_HOST_TARGET (test-only, behind the insecure
 * flag) makes this host select the win32-x64 artifact.
 */

const root = resolve(import.meta.dirname, '../..');
const makeTempDir = trackTempDirs();
const NIGHTLY_KEY_ID = 'station-portable-nightly-2026-09';
const RELEASE_KEY_ID = 'station-portable-release-2026-09';

type Fixture = {
  dir: string;
  core: string;
  stationRoot: string;
  installRoot: string;
  keyUrl: string;
  key: KeyObject;
};

function fixture(channel = 'nightly'): Fixture {
  const dir = makeTempDir('station-install-ps1-');
  const pair = generateKeyPairSync('ed25519');
  const keyPath = join(dir, 'test-key.pem');
  writeFileSync(
    keyPath,
    pair.publicKey.export({ format: 'pem', type: 'spki' }) as string,
  );
  const stationRoot = join(dir, 'root');
  return {
    dir,
    core: extractInstallerCore(dir),
    stationRoot,
    installRoot: join(stationRoot, 'installs', channel),
    keyUrl: pathToFileURL(keyPath).href,
    key: pair.privateKey,
  };
}

function stage(
  f: Fixture,
  manifestUrl: string,
  env: Record<string, string> = {},
  argv: string[] = ['install'],
) {
  const result = spawnSync(process.execPath, [f.core, ...argv], {
    cwd: f.dir,
    encoding: 'utf8',
    windowsHide: true,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: join(f.dir, 'home'),
      STATION_ROOT: f.stationRoot,
      STATION_CHANNEL: 'nightly',
      STATION_INSTALL_STAGE_ONLY: '1',
      STATION_INSTALL_PUBLIC_MANIFEST_URL: manifestUrl,
      STATION_INSTALL_MANIFEST_PUBLIC_KEY_URL: f.keyUrl,
      STATION_INSTALL_ALLOW_INSECURE_TEST_URLS: '1',
      STATION_INSTALL_TEST_HOST_TARGET: 'win32-x64',
      ...env,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    lastLine: result.stdout.trim().split('\n').at(-1),
  };
}

function signed(f: Fixture, archive: WindowsArchive, overrides = {}) {
  return signWindowsManifest(f.dir, archive, f.key, NIGHTLY_KEY_ID, overrides);
}

function versionDirs(f: Fixture): string[] {
  const versions = join(f.installRoot, 'versions');
  return existsSync(versions) ? readdirSync(versions).sort() : [];
}

describe('install.ps1 installer core: stage-only (#2675 W1)', () => {
  it('stages a signed archive as a sealed, complete version and nothing else', () => {
    const f = fixture();
    const archive = buildWindowsArchive(f.dir, '0.7.0-nightly.12');
    const result = stage(f, signed(f, archive));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      'Verified the signed release manifest for Station v0.7.0-nightly.12 (nightly).',
    );
    expect(result.lastLine).toBe('STATION_STAGED_VERSION=0.7.0-nightly.12');
    const version = join(f.installRoot, 'versions', '0.7.0-nightly.12');
    expect(
      readFileSync(join(version, '.station-install-complete'), 'utf8'),
    ).toBe(`${archive.sha256}\n`);
    expect(readFileSync(join(version, 'install.ps1'), 'utf8')).toBe(
      readFileSync(join(root, 'install.ps1'), 'utf8'),
    );
    // Sealed: no write bit on the tree.
    expect(statSync(join(version, 'bin', 'station.mjs')).mode & 0o222).toBe(0);
    expect(statSync(version).mode & 0o222).toBe(0);
    expect(
      readFileSync(
        join(f.installRoot, '.station-portable-install-root'),
        'utf8',
      ),
    ).toBe('station-portable-install-root-v1\n');
    // Stage-only moves nothing: no current, no state, no leftovers.
    expect(existsSync(join(f.installRoot, 'current'))).toBe(false);
    expect(existsSync(join(f.installRoot, '.station-release-state.json'))).toBe(
      false,
    );
    expect(versionDirs(f)).toEqual(['0.7.0-nightly.12']);

    const again = stage(f, signed(f, archive));
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toContain(
      'Station release already installed; reusing verified files.',
    );
    expect(again.lastLine).toBe('STATION_STAGED_VERSION=0.7.0-nightly.12');
  });

  it('stages a version beside the active one, which it leaves alone', () => {
    const f = fixture();
    const first = buildWindowsArchive(f.dir, '0.7.0-nightly.12');
    expect(stage(f, signed(f, first)).status).toBe(0);
    symlinkSync(
      join(f.installRoot, 'versions', '0.7.0-nightly.12'),
      join(f.installRoot, 'current'),
    );
    const second = buildWindowsArchive(f.dir, '0.7.0-nightly.13', {
      sha: 'b'.repeat(40),
    });
    const result = stage(f, signed(f, second));
    expect(result.status, result.stderr).toBe(0);
    expect(result.lastLine).toBe('STATION_STAGED_VERSION=0.7.0-nightly.13');
    expect(versionDirs(f)).toEqual(['0.7.0-nightly.12', '0.7.0-nightly.13']);
    expect(lstatSync(join(f.installRoot, 'current')).isSymbolicLink()).toBe(
      true,
    );

    // The active version again: nothing to do, and it names it.
    const same = stage(f, signed(f, first));
    expect(same.status, same.stderr).toBe(0);
    expect(same.stdout).toContain(
      'Station v0.7.0-nightly.12 is already installed; nothing to do.',
    );
    expect(same.lastLine).toBe('STATION_STAGED_VERSION=0.7.0-nightly.12');
  });

  it('refuses to stage a release older than the active one without the explicit opt-in', () => {
    const f = fixture();
    const newer = buildWindowsArchive(f.dir, '0.7.0-nightly.13');
    expect(stage(f, signed(f, newer)).status).toBe(0);
    symlinkSync(
      join(f.installRoot, 'versions', '0.7.0-nightly.13'),
      join(f.installRoot, 'current'),
    );
    const older = buildWindowsArchive(f.dir, '0.7.0-nightly.12');
    const refused = stage(f, signed(f, older));
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(
      'Station install failed: refusing to downgrade Station from v0.7.0-nightly.13 to v0.7.0-nightly.12',
    );
    expect(versionDirs(f)).toEqual(['0.7.0-nightly.13']);

    const explicit = stage(f, signed(f, older), {
      STATION_VERSION: 'v0.7.0-nightly.12',
      STATION_INSTALL_ALLOW_ROLLBACK: '1',
    });
    expect(explicit.status, explicit.stderr).toBe(0);
    expect(explicit.lastLine).toBe('STATION_STAGED_VERSION=0.7.0-nightly.12');
  });

  // Each rejection path: the named refusal, exit 1, and no version staged.
  it.each<{
    name: string;
    run: (f: Fixture) => ReturnType<typeof stage>;
    message: string;
  }>([
    {
      name: 'an archive byte that differs from the signed sha256',
      run: (f) => {
        const archive = buildWindowsArchive(f.dir, '0.7.0-nightly.12');
        const manifest = signed(f, archive);
        const bytes = readFileSync(archive.archive);
        bytes[bytes.length - 30] ^= 0x01;
        writeFileSync(archive.archive, bytes);
        return stage(f, manifest);
      },
      message: 'release checksum did not match',
    },
    {
      name: 'an archive larger than its signed size',
      run: (f) => {
        const archive = buildWindowsArchive(f.dir, '0.7.0-nightly.12');
        return stage(
          f,
          signed(f, archive, { artifact: { size: archive.size - 1 } }),
        );
      },
      message: `station-server-win32-x64.zip is larger than the`,
    },
    {
      name: 'an archive smaller than its signed size',
      run: (f) => {
        const archive = buildWindowsArchive(f.dir, '0.7.0-nightly.12');
        return stage(
          f,
          signed(f, archive, { artifact: { size: archive.size + 1 } }),
        );
      },
      message: 'bytes; the signed manifest says',
    },
    {
      name: 'an entry that escapes the archive root',
      run: (f) =>
        stage(
          f,
          signed(
            f,
            buildWindowsArchive(f.dir, '0.7.0-nightly.12', {
              extraEntries: [{ name: 'station/../escaped', data: 'x' }],
            }),
          ),
        ),
      message:
        'release archive contains an unsafe or invalid entry: zip entry station/../escaped has an empty, `.` or `..` path segment',
    },
    {
      name: 'a symbolic link entry',
      run: (f) =>
        stage(
          f,
          signed(
            f,
            buildWindowsArchive(f.dir, '0.7.0-nightly.12', {
              extraEntries: [
                {
                  name: 'station/link',
                  data: '/etc/passwd',
                  unixMode: 0o120777,
                },
              ],
            }),
          ),
        ),
      message: 'zip entry station/link is not a regular file or directory',
    },
    {
      name: 'an entry whose bytes fail their CRC-32',
      run: (f) =>
        stage(
          f,
          signed(
            f,
            buildWindowsArchive(f.dir, '0.7.0-nightly.12', {
              extraEntries: [
                { name: 'station/corrupt', data: 'abc', crc32: 1 },
              ],
            }),
          ),
        ),
      message: 'zip entry station/corrupt fails its CRC-32 check',
    },
    {
      name: 'an archive without the prebuilt marker',
      run: (f) =>
        stage(
          f,
          signed(
            f,
            buildWindowsArchive(f.dir, '0.7.0-nightly.12', { marker: null }),
          ),
        ),
      message:
        'release archive is not a prebuilt Station archive (it has no marker or provenance)',
    },
    {
      name: 'a marker with other content',
      run: (f) =>
        stage(
          f,
          signed(
            f,
            buildWindowsArchive(f.dir, '0.7.0-nightly.12', {
              marker: 'station-prebuilt-archive-v2\n',
            }),
          ),
        ),
      message: 'release archive marker is invalid',
    },
    {
      name: 'provenance for another commit',
      run: (f) => {
        const archive = buildWindowsArchive(f.dir, '0.7.0-nightly.12', {
          provenance: { sha: 'c'.repeat(40) },
        });
        return stage(f, signed(f, archive));
      },
      message: 'release provenance is invalid',
    },
    {
      name: 'a runtime that is not the signed Node.js',
      run: (f) =>
        stage(
          f,
          signed(f, buildWindowsArchive(f.dir, '0.7.0-nightly.12'), {
            payload: { nodeVersion: '20.0.0' },
          }),
        ),
      message:
        'the extracted release did not report itself as Station v0.7.0-nightly.12 on Node.js 20.0.0',
    },
    {
      name: 'a manifest signed under a key id that is not pinned',
      run: (f) =>
        stage(
          f,
          signWindowsManifest(
            f.dir,
            buildWindowsArchive(f.dir, '0.7.0-nightly.12'),
            f.key,
            'station-portable-rogue',
          ),
        ),
      message:
        'public ecosystem manifest is signed by a key this installer does not pin',
    },
    {
      name: 'the release key id signing a nightly manifest',
      run: (f) =>
        stage(
          f,
          signWindowsManifest(
            f.dir,
            buildWindowsArchive(f.dir, '0.7.0-nightly.12'),
            f.key,
            RELEASE_KEY_ID,
          ),
        ),
      message:
        'public ecosystem manifest signing key is not authorized for the manifest channel',
    },
    {
      name: 'a signature by another key',
      run: (f) =>
        stage(
          f,
          signWindowsManifest(
            f.dir,
            buildWindowsArchive(f.dir, '0.7.0-nightly.12'),
            generateKeyPairSync('ed25519').privateKey,
            NIGHTLY_KEY_ID,
          ),
        ),
      message: 'public ecosystem manifest signature did not verify',
    },
    {
      name: 'a manifest with no archive for this host',
      run: (f) => {
        const archive = buildWindowsArchive(f.dir, '0.7.0-nightly.12');
        return stage(f, signed(f, archive), {
          STATION_INSTALL_TEST_HOST_TARGET: 'linux-x64',
        });
      },
      message:
        'public ecosystem manifest publishes no server archive for this host (linux-x64)',
    },
    {
      name: 'a nightly manifest for a beta install',
      run: (f) =>
        stage(f, signed(f, buildWindowsArchive(f.dir, '0.7.0-nightly.12')), {
          STATION_CHANNEL: 'beta',
        }),
      message: 'requested channel does not match public ecosystem manifest',
    },
    {
      name: 'a manifest over 1 MiB',
      run: (f) => {
        const path = join(f.dir, 'huge.json');
        writeFileSync(path, ' '.repeat(1_048_577));
        return stage(f, pathToFileURL(path).href);
      },
      message: 'the public ecosystem manifest is larger than 1 MiB',
    },
    {
      name: 'the test-only host target without the test-only flag',
      run: (f) =>
        stage(f, signed(f, buildWindowsArchive(f.dir, '0.7.0-nightly.12')), {
          STATION_INSTALL_ALLOW_INSECURE_TEST_URLS: '0',
          STATION_INSTALL_MANIFEST_PUBLIC_KEY_URL: '',
        }),
      message:
        'STATION_INSTALL_TEST_HOST_TARGET is a test-only override and requires STATION_INSTALL_ALLOW_INSECURE_TEST_URLS=1',
    },
    {
      name: 'the test-only key without the test-only flag',
      run: (f) =>
        stage(f, signed(f, buildWindowsArchive(f.dir, '0.7.0-nightly.12')), {
          STATION_INSTALL_ALLOW_INSECURE_TEST_URLS: '0',
          STATION_INSTALL_TEST_HOST_TARGET: '',
        }),
      message:
        'Station install failed: STATION_INSTALL_MANIFEST_PUBLIC_KEY_URL is a test-only override and requires STATION_INSTALL_ALLOW_INSECURE_TEST_URLS=1',
    },
    ...(['STATION_ROOT', 'STATION_INSTALL_ROOT', 'STATION_HOME'] as const).map(
      (name) => ({
        name: `a relative ${name}`,
        run: (f: Fixture) =>
          stage(f, signed(f, buildWindowsArchive(f.dir, '0.7.0-nightly.12')), {
            [name]: 'relative-root',
          }),
        message: `Station install failed: ${name} must be an absolute path: relative-root`,
      }),
    ),
    {
      name: 'a full install with no signed public manifest',
      run: (f) =>
        stage(f, '', {
          STATION_INSTALL_STAGE_ONLY: '0',
          STATION_INSTALL_PUBLIC_MANIFEST_URL: '',
        }),
      message:
        'install.ps1 installs only from a signed public manifest; set STATION_INSTALL_PUBLIC_MANIFEST_URL',
    },
  ])('refuses $name', ({ run, message }) => {
    const f = fixture();
    const result = run(f);
    expect(result.status, result.stdout).toBe(1);
    expect(result.stderr).toContain(message);
    expect(result.stderr).toContain('Station install failed: ');
    expect(versionDirs(f).filter((name) => !name.startsWith('.'))).toEqual([]);
    // A refused extraction leaves no stage behind either.
    expect(versionDirs(f)).toEqual([]);
  });

  it('refuses an install root that is not the channel leaf', () => {
    const f = fixture();
    mkdirSync(join(f.stationRoot, 'installs'), { recursive: true });
    const result = stage(
      f,
      signed(f, buildWindowsArchive(f.dir, '0.7.0-nightly.12')),
      { STATION_INSTALL_ROOT: join(f.stationRoot, 'installs', 'beta') },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'STATION_INSTALL_ROOT must be the verified nightly channel leaf',
    );
  });

  it('refuses a non-empty install root it does not own', () => {
    const f = fixture();
    mkdirSync(f.installRoot, { recursive: true, mode: 0o700 });
    writeFileSync(join(f.installRoot, 'someone-else'), '');
    const result = stage(
      f,
      signed(f, buildWindowsArchive(f.dir, '0.7.0-nightly.12')),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'STATION_INSTALL_ROOT is not an empty or installer-owned directory',
    );
    expect(existsSync(join(f.installRoot, 'versions'))).toBe(false);
  });
});
