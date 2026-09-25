import { spawnSync } from 'node:child_process';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  verify,
} from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';

const root = resolve(import.meta.dirname, '../..');
const script = join(root, 'scripts/ecosystem-manifest.mjs');
const installer = join(root, 'install.sh');
const publishBoundary = join(root, 'scripts/ecosystem-publish-boundary.sh');
const workflow = join(root, '.github/workflows/ecosystem-packaging.yml');
const keyTablePath = join(root, 'config/release-manifest-keys.json');
const roots: string[] = [];
const makeTempDir = trackTempDirs();
const RELEASE_KEY_ID = 'station-portable-release-2026-09';
const NIGHTLY_KEY_ID = 'station-portable-nightly-2026-09';

function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

afterEach(() => {
  for (const path of roots.splice(0))
    rmSync(path, { recursive: true, force: true });
});

describe('ecosystem manifest', () => {
  it('rejects public payloads whose channel disagrees with their release tag', () => {
    const dir = mkdtempSync(join(tmpdir(), 'station-ecosystem-channel-'));
    roots.push(dir);
    const { privateKey } = generateKeyPairSync('ed25519');
    const privatePath = join(dir, 'private.pem');
    const payloadPath = join(dir, 'payload.json');
    writeFileSync(
      privatePath,
      privateKey.export({ format: 'pem', type: 'pkcs8' }),
    );

    for (const [channel, version] of [
      ['stable', '1.2.3-preview.1'],
      ['preview', '1.2.3'],
    ]) {
      writeFileSync(
        payloadPath,
        `${JSON.stringify({
          schemaVersion: 1,
          channel,
          version,
          releaseTag: `v${version}`,
          sourceSha: 'a'.repeat(40),
          publishedAt: '2026-08-16T00:00:00.000Z',
          artifacts: {
            macos: {
              name: 'station-1.2.3.dmg',
              url: 'https://example.test/station-1.2.3.dmg',
              sha256: 'b'.repeat(64),
            },
            portable: {
              name: 'station-portable.tar.gz',
              url: 'https://example.test/station-portable.tar.gz',
              sha256: 'c'.repeat(64),
            },
          },
        })}\n`,
      );
      const result = run([
        'create',
        '--payload',
        payloadPath,
        '--private-key',
        privatePath,
        '--key-id',
        'station-ecosystem-v1',
        '--output',
        join(dir, `${channel}.json`),
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'manifest channel does not match release tag',
      );
    }
  });

  it('runs the owner-gated publish boundary inertly by default', () => {
    const { STATION_ECOSYSTEM_PUBLISH: _publish, ...environment } = process.env;
    const inert = spawnSync('bash', [publishBoundary], {
      encoding: 'utf8',
      env: environment,
    });
    expect(inert.stdout).toContain('inert by default');
    expect(inert.status).toBe(0);

    const blocked = spawnSync('bash', [publishBoundary], {
      encoding: 'utf8',
      env: { ...process.env, STATION_ECOSYSTEM_PUBLISH: '1' },
    });
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain('explicit manifest publish command');
  });

  it('runs the clean-macOS dry-run before the owner-gated publish boundary', () => {
    const contents = readFileSync(workflow, 'utf8');
    expect(contents).toContain('runs-on: macos-latest');
    expect(contents).toContain(
      'scripts/exercise-ecosystem-packaging-dry-run.sh',
    );
    expect(contents).toMatch(
      /STATION_ECOSYSTEM_PUBLISH: \$\{\{ inputs\.publish && '1' \|\| '0' \}\}/,
    );
    expect(
      contents.indexOf('scripts/exercise-ecosystem-packaging-dry-run.sh'),
    ).toBeLessThan(
      contents.lastIndexOf('scripts/ecosystem-publish-boundary.sh'),
    );
  });

  it('renders a checksum-pinned cask only from a verified signed manifest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'station-ecosystem-manifest-'));
    roots.push(dir);
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const privatePath = join(dir, 'private.pem');
    const publicPath = join(dir, 'public.pem');
    const payloadPath = join(dir, 'payload.json');
    const manifestPath = join(dir, 'manifest.json');
    const caskPath = join(dir, 'station.rb');
    writeFileSync(
      privatePath,
      privateKey.export({ format: 'pem', type: 'pkcs8' }),
    );
    writeFileSync(
      publicPath,
      publicKey.export({ format: 'pem', type: 'spki' }),
    );
    writeFileSync(
      payloadPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          channel: 'stable',
          version: '1.2.3',
          releaseTag: 'v1.2.3',
          sourceSha: 'a'.repeat(40),
          publishedAt: '2026-08-16T00:00:00.000Z',
          artifacts: {
            macos: {
              name: 'station-1.2.3-macos-universal.dmg',
              url: 'https://releases.example.test/v1.2.3/station-1.2.3-macos-universal.dmg',
              sha256: 'b'.repeat(64),
            },
            portable: {
              name: 'station-portable.tar.gz',
              url: 'https://releases.example.test/v1.2.3/station-portable.tar.gz',
              sha256: 'c'.repeat(64),
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    expect(
      run([
        'create',
        '--payload',
        payloadPath,
        '--private-key',
        privatePath,
        '--key-id',
        'station-ecosystem-v1',
        '--output',
        manifestPath,
      ]).status,
    ).toBe(0);
    expect(
      run([
        'cask',
        '--manifest',
        manifestPath,
        '--public-key',
        publicPath,
        '--output',
        caskPath,
      ]).status,
    ).toBe(0);
    expect(readFileSync(caskPath, 'utf8')).toContain(
      `sha256 "${'b'.repeat(64)}"`,
    );
    expect(readFileSync(caskPath, 'utf8')).toContain(
      'station-1.2.3-macos-universal.dmg',
    );

    const envelope = JSON.parse(readFileSync(manifestPath, 'utf8'));
    envelope.payload.artifacts.macos.sha256 = 'd'.repeat(64);
    writeFileSync(manifestPath, `${JSON.stringify(envelope)}\n`);
    const rejected = run([
      'verify',
      '--manifest',
      manifestPath,
      '--public-key',
      publicPath,
    ]);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain('manifest signature did not verify');
  });

  // 60s, not the 5s default. This test signs a manifest, verifies it, and
  // runs a real install — seconds of genuine work, and it shares a host with
  // the rest of the corpus during a full run. It reds at load ~11 and passes
  // at load ~5 on the same tree, so as written it fails whoever gates while
  // the machine is busy and names their branch as the cause (station#3124).
  // Nothing here asserts latency; a latency-derived failure is noise by
  // construction. The bound stays finite so a genuine hang still fails.
  it.each(['npm', 'pnpm'] as const)(
    'installs a signed %s portable artifact without gh or a GitHub credential',
    {
      timeout: 60_000,
    },
    (manager) => {
      const dir = mkdtempSync(join(tmpdir(), 'station-public-install-'));
      roots.push(dir);
      const artifacts = join(dir, 'artifacts');
      const manifests = join(dir, 'manifests');
      const keys = join(dir, 'keys');
      const fakeBin = join(dir, 'bin');
      const source = join(dir, 'source', 'station');
      for (const path of [artifacts, manifests, keys, fakeBin, source]) {
        mkdirSync(path, { recursive: true });
      }
      writeFileSync(
        join(source, 'package.json'),
        JSON.stringify({
          name: 'station-portable-fixture',
          version: '1.2.3',
          ...(manager === 'pnpm' ? { packageManager: 'pnpm@11.25.0' } : {}),
          scripts: {
            'dependencies:ci': 'node scripts/dependency-lifecycle.mjs ci',
          },
        }),
      );
      if (manager === 'pnpm') {
        writeFileSync(join(source, 'pnpm-lock.yaml'), '{}\n');
        writeFileSync(join(source, 'pnpm-workspace.yaml'), 'packages: []\n');
      } else {
        writeFileSync(join(source, 'package-lock.json'), '{}\n');
      }
      writeFileSync(
        join(source, '.station-release.json'),
        `${JSON.stringify({ schemaVersion: 2, sha: 'a'.repeat(40), ref: 'v1.2.3', createdAt: '2026-08-16T00:00:00.000Z', channel: 'stable', releaseChannel: 'stable', prerelease: false })}\n`,
      );
      writeFileSync(
        join(source, 'station'),
        `#!/bin/sh
if [ "\${1:-}" = start ]; then touch "$(dirname "$0")/.launched"; fi
exit 0
`,
      );
      chmodSync(join(source, 'station'), 0o755);
      const archive = join(artifacts, 'station-portable.tar.gz');
      expect(
        spawnSync('tar', [
          '-czf',
          archive,
          '-C',
          join(dir, 'source'),
          'station',
        ]).status,
      ).toBe(0);
      const macos = join(artifacts, 'station-1.2.3-macos-universal.dmg');
      writeFileSync(macos, 'fixture dmg\n');
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const privatePath = join(dir, 'private.pem');
      const publicPath = join(keys, 'public.pem');
      writeFileSync(
        privatePath,
        privateKey.export({ format: 'pem', type: 'pkcs8' }),
      );
      writeFileSync(
        publicPath,
        publicKey.export({ format: 'pem', type: 'spki' }),
      );
      const payloadPath = join(dir, 'payload.json');
      const manifestPath = join(manifests, 'stable.json');
      writeFileSync(
        payloadPath,
        `${JSON.stringify({
          schemaVersion: 1,
          channel: 'stable',
          version: '1.2.3',
          releaseTag: 'v1.2.3',
          sourceSha: 'a'.repeat(40),
          publishedAt: '2026-08-16T00:00:00.000Z',
          artifacts: {
            macos: {
              name: 'station-1.2.3-macos-universal.dmg',
              url: pathToFileURL(macos).href,
              sha256: digest(macos),
            },
            portable: {
              name: 'station-portable.tar.gz',
              url: pathToFileURL(archive).href,
              sha256: digest(archive),
            },
          },
        })}\n`,
      );
      expect(
        run(
          [
            'create',
            '--payload',
            payloadPath,
            '--private-key',
            privatePath,
            '--key-id',
            RELEASE_KEY_ID,
            '--output',
            manifestPath,
          ],
          { STATION_ECOSYSTEM_ALLOW_INSECURE_TEST_URLS: '1' },
        ).status,
      ).toBe(0);
      writeFileSync(
        join(fakeBin, 'npm'),
        '#!/bin/sh\ntouch "$PWD/.npm-ci-complete"\n',
      );
      writeFileSync(
        join(fakeBin, 'gh'),
        '#!/bin/sh\necho gh-must-not-run >&2\nexit 99\n',
      );
      writeFileSync(
        join(fakeBin, 'node'),
        `#!/bin/sh\nif [ "$1" = -p ]; then printf '24\\n'; exit 0; fi\nexec "${process.execPath}" "$@"\n`,
      );
      chmodSync(join(fakeBin, 'npm'), 0o755);
      chmodSync(join(fakeBin, 'gh'), 0o755);
      chmodSync(join(fakeBin, 'node'), 0o755);
      const result = spawnSync('sh', [installer], {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: join(dir, 'home'),
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
          GH_TOKEN: '',
          GITHUB_TOKEN: '',
          STATION_ROOT: '',
          STATION_HOME: '',
          STATION_INSTALL_ROOT: '',
          STATION_BIN_DIR: '',
          STATION_INSTALL_PUBLIC_MANIFEST_URL: pathToFileURL(manifestPath).href,
          STATION_INSTALL_MANIFEST_PUBLIC_KEY_URL:
            pathToFileURL(publicPath).href,
          STATION_INSTALL_ALLOW_INSECURE_TEST_URLS: '1',
        },
      });
      expect(result.status, result.stderr).toBe(0);
      const installedRelease = realpathSync(
        join(dir, 'home', '.station', 'installs', 'stable', 'current'),
      );
      expect(existsSync(join(installedRelease, '.launched'))).toBe(true);

      writeFileSync(join(source, 'checksum-mismatch-marker'), 'mutated\n');
      expect(
        spawnSync('tar', [
          '-czf',
          archive,
          '-C',
          join(dir, 'source'),
          'station',
        ]).status,
      ).toBe(0);
      const rejected = spawnSync('sh', [installer], {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: join(dir, 'other-home'),
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
          GH_TOKEN: '',
          GITHUB_TOKEN: '',
          STATION_ROOT: '',
          STATION_HOME: '',
          STATION_INSTALL_ROOT: '',
          STATION_BIN_DIR: '',
          STATION_INSTALL_PUBLIC_MANIFEST_URL: pathToFileURL(manifestPath).href,
          STATION_INSTALL_MANIFEST_PUBLIC_KEY_URL:
            pathToFileURL(publicPath).href,
          STATION_INSTALL_ALLOW_INSECURE_TEST_URLS: '1',
        },
      });
      expect(rejected.stderr).toContain('release checksum did not match');
      expect(rejected.status).toBe(1);
    },
  );
});

// A fixed ed25519 key (seed 0x01..0x20). Ed25519 signatures are
// deterministic, so a fixed key and payload give a fixed signature.
function goldenPrivateKey(): KeyObject {
  const seed = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1));
  return createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      seed,
    ]),
    format: 'der',
    type: 'pkcs8',
  });
}

const GOLDEN_PAYLOAD = {
  schemaVersion: 2,
  channel: 'nightly',
  version: '0.7.0-nightly.12',
  releaseTag: 'v0.7.0-nightly.12',
  sourceSha: '0123456789abcdef0123456789abcdef01234567',
  publishedAt: '2026-09-25T00:00:00.000Z',
  artifacts: {
    portable: {
      url: 'file:///nonexistent/station-golden/station-portable.tar.gz',
      name: 'station-portable.tar.gz',
      sha256: 'ab'.repeat(32),
    },
  },
};
// The exact bytes both the signer (ecosystem-manifest.mjs) and the verifier
// (install.sh) must derive from GOLDEN_PAYLOAD: recursively sorted keys, no
// whitespace. Written out, not computed, so neither side can drift alone.
const GOLDEN_CANONICAL = `{"artifacts":{"portable":{"name":"station-portable.tar.gz","sha256":"${'ab'.repeat(32)}","url":"file:///nonexistent/station-golden/station-portable.tar.gz"}},"channel":"nightly","publishedAt":"2026-09-25T00:00:00.000Z","releaseTag":"v0.7.0-nightly.12","schemaVersion":2,"sourceSha":"0123456789abcdef0123456789abcdef01234567","version":"0.7.0-nightly.12"}`;
const GOLDEN_SIGNATURE =
  '0qCbEHmy8XP5SdwwyAlY4fJKYqX3c4ypu+hvwCDDPUSokVaEXa5lQ0ttKUJZWDygzVZzbJa2Xamwd5QeKLOdDw==';

type InstallFixture = {
  dir: string;
  fakeBin: string;
  testKeyPath: string;
  privateKeyPath: string;
};

function makeInstallFixture(prefix: string): InstallFixture {
  const dir = makeTempDir(prefix);
  const fakeBin = join(dir, 'bin');
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(
    join(fakeBin, 'npm'),
    '#!/bin/sh\ntouch "$PWD/.npm-ci-complete"\n',
  );
  writeFileSync(
    join(fakeBin, 'gh'),
    '#!/bin/sh\necho gh-must-not-run >&2\nexit 99\n',
  );
  writeFileSync(
    join(fakeBin, 'node'),
    `#!/bin/sh\nif [ "$1" = -p ]; then printf '24\\n'; exit 0; fi\nexec "${process.execPath}" "$@"\n`,
  );
  for (const name of ['npm', 'gh', 'node'])
    chmodSync(join(fakeBin, name), 0o755);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateKeyPath = join(dir, 'private.pem');
  const testKeyPath = join(dir, 'test-public.pem');
  writeFileSync(
    privateKeyPath,
    privateKey.export({ format: 'pem', type: 'pkcs8' }),
  );
  writeFileSync(testKeyPath, publicKey.export({ format: 'pem', type: 'spki' }));
  return { dir, fakeBin, testKeyPath, privateKeyPath };
}

/** Builds a portable archive whose provenance names `version`. */
function buildArchive(fixture: InstallFixture, version: string): string {
  const base = join(fixture.dir, 'source', version);
  const source = join(base, 'station');
  mkdirSync(source, { recursive: true });
  writeFileSync(
    join(source, 'package.json'),
    JSON.stringify({
      name: 'station-portable-fixture',
      version,
      scripts: {
        'dependencies:ci': 'node scripts/dependency-lifecycle.mjs ci',
      },
    }),
  );
  writeFileSync(join(source, 'package-lock.json'), '{}\n');
  writeFileSync(
    join(source, '.station-release.json'),
    `${JSON.stringify({ schemaVersion: 2, sha: 'a'.repeat(40), ref: `v${version}`, createdAt: '2026-08-16T00:00:00.000Z', channel: 'stable', releaseChannel: 'stable', prerelease: false })}\n`,
  );
  writeFileSync(
    join(source, 'station'),
    `#!/bin/sh
if [ "\${1:-}" = start ]; then touch "$(dirname "$0")/.launched"; fi
exit 0
`,
  );
  chmodSync(join(source, 'station'), 0o755);
  const artifacts = join(fixture.dir, 'artifacts', version);
  mkdirSync(artifacts, { recursive: true });
  const archive = join(artifacts, 'station-portable.tar.gz');
  expect(
    spawnSync('tar', ['-czf', archive, '-C', base, 'station']).status,
  ).toBe(0);
  return archive;
}

/** Signs a v2 stable manifest for `archive` with the fixture's test key. */
function signManifest(
  fixture: InstallFixture,
  version: string,
  archive: string,
  overrides: { channel?: string; keyId?: string } = {},
): string {
  const manifests = join(fixture.dir, 'manifests');
  mkdirSync(manifests, { recursive: true });
  const payloadPath = join(fixture.dir, `payload-${version}.json`);
  writeFileSync(
    payloadPath,
    `${JSON.stringify({
      schemaVersion: 2,
      channel: overrides.channel ?? 'stable',
      version,
      releaseTag: `v${version}`,
      sourceSha: 'a'.repeat(40),
      publishedAt: '2026-09-25T00:00:00.000Z',
      artifacts: {
        portable: {
          name: 'station-portable.tar.gz',
          url: pathToFileURL(archive).href,
          sha256: digest(archive),
        },
      },
    })}\n`,
  );
  const manifestPath = join(manifests, `${version}.json`);
  const created = run(
    [
      'create',
      '--payload',
      payloadPath,
      '--private-key',
      fixture.privateKeyPath,
      '--key-id',
      'station-fixture-signer',
      '--output',
      manifestPath,
    ],
    { STATION_ECOSYSTEM_ALLOW_INSECURE_TEST_URLS: '1' },
  );
  expect(created.status, created.stderr).toBe(0);
  // keyId is envelope metadata, outside the signed payload. Relabelling it
  // here lets a fixture key stand in for a pinned key's bytes (through the
  // test-only override) while the installer's keyId and channel policy
  // still applies to the pinned entry the label names.
  const envelope = JSON.parse(readFileSync(manifestPath, 'utf8'));
  envelope.keyId = overrides.keyId ?? RELEASE_KEY_ID;
  writeFileSync(manifestPath, `${JSON.stringify(envelope, null, 2)}\n`);
  return manifestPath;
}

function runInstaller(
  fixture: InstallFixture,
  manifestPath: string,
  env: Record<string, string> = {},
) {
  const { STATION_CHANNEL: _channel, ...inherited } = process.env;
  return spawnSync('sh', [installer], {
    encoding: 'utf8',
    env: {
      ...inherited,
      HOME: join(fixture.dir, 'home'),
      PATH: `${fixture.fakeBin}:${process.env.PATH ?? ''}`,
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
      STATION_ROOT: '',
      STATION_HOME: '',
      STATION_INSTALL_ROOT: '',
      STATION_BIN_DIR: '',
      STATION_VERSION: '',
      STATION_INSTALL_ALLOW_ROLLBACK: '',
      STATION_INSTALL_PUBLIC_MANIFEST_URL: pathToFileURL(manifestPath).href,
      STATION_INSTALL_MANIFEST_PUBLIC_KEY_URL: pathToFileURL(
        fixture.testKeyPath,
      ).href,
      STATION_INSTALL_ALLOW_INSECURE_TEST_URLS: '1',
      ...env,
    },
  });
}

function currentRelease(fixture: InstallFixture): string {
  return realpathSync(
    join(fixture.dir, 'home', '.station', 'installs', 'stable', 'current'),
  );
}

function installedTag(fixture: InstallFixture): string {
  return JSON.parse(
    readFileSync(
      join(currentRelease(fixture), '.station-release.json'),
      'utf8',
    ),
  ).ref;
}

describe('pinned manifest signing keys', () => {
  it('embeds exactly the checked-in signing-key table in install.sh', () => {
    const config = JSON.parse(readFileSync(keyTablePath, 'utf8'));
    const expectedLine = `PINNED_MANIFEST_SIGNING_KEYS='${JSON.stringify(config)}'`;
    const script = readFileSync(installer, 'utf8');
    const block = script.match(
      /# BEGIN PINNED MANIFEST SIGNING KEYS\n([^\n]*)\n# END PINNED MANIFEST SIGNING KEYS\n/,
    );
    expect(block?.[1], `install.sh must embed:\n${expectedLine}`).toBe(
      expectedLine,
    );
    // The table the installer carries is the real release/nightly pair.
    expect(
      config.keys.map((entry: { keyId: string; channels: string[] }) => [
        entry.keyId,
        entry.channels,
      ]),
    ).toEqual([
      [NIGHTLY_KEY_ID, ['nightly']],
      [RELEASE_KEY_ID, ['stable', 'preview']],
    ]);
    for (const entry of config.keys)
      expect(createPublicKey(entry.publicKeySpkiPem).asymmetricKeyType).toBe(
        'ed25519',
      );
  });

  it('pins signer and installer canonicalization to one golden vector', () => {
    const dir = makeTempDir('station-manifest-golden-');
    const privateKey = goldenPrivateKey();
    const publicKey = createPublicKey(privateKey);
    const privatePath = join(dir, 'golden-private.pem');
    const publicPath = join(dir, 'golden-public.pem');
    writeFileSync(
      privatePath,
      privateKey.export({ format: 'pem', type: 'pkcs8' }),
    );
    writeFileSync(
      publicPath,
      publicKey.export({ format: 'pem', type: 'spki' }),
    );
    const payloadPath = join(dir, 'payload.json');
    writeFileSync(payloadPath, JSON.stringify(GOLDEN_PAYLOAD));
    const manifestPath = join(dir, 'golden.json');
    const created = run(
      [
        'create',
        '--payload',
        payloadPath,
        '--private-key',
        privatePath,
        '--key-id',
        'station-golden-vector',
        '--output',
        manifestPath,
      ],
      { STATION_ECOSYSTEM_ALLOW_INSECURE_TEST_URLS: '1' },
    );
    expect(created.status, created.stderr).toBe(0);
    const envelope = JSON.parse(readFileSync(manifestPath, 'utf8'));
    // Signer: signs exactly GOLDEN_CANONICAL.
    expect(
      verify(
        null,
        Buffer.from(GOLDEN_CANONICAL),
        publicKey,
        Buffer.from(envelope.signature, 'base64'),
      ),
    ).toBe(true);
    expect(envelope.signature).toBe(GOLDEN_SIGNATURE);

    // Verifier: install.sh accepts the golden signature and proceeds past
    // verification to the artifact download (which does not exist).
    envelope.keyId = NIGHTLY_KEY_ID;
    writeFileSync(manifestPath, JSON.stringify(envelope));
    const fixture = makeInstallFixture('station-manifest-golden-install-');
    const result = runInstaller(fixture, manifestPath, {
      STATION_INSTALL_MANIFEST_PUBLIC_KEY_URL: pathToFileURL(publicPath).href,
    });
    expect(result.stderr).toContain(
      'could not download station-portable.tar.gz',
    );
    expect(result.status).toBe(1);
  });

  it('verifies with --keys only for a pinned key authorized for the channel', () => {
    const fixture = makeInstallFixture('station-manifest-keys-');
    const table = join(fixture.dir, 'keys.json');
    writeFileSync(
      table,
      JSON.stringify({
        keys: [
          {
            keyId: 'station-fixture-nightly',
            algorithm: 'ed25519',
            publicKeySpkiPem: readFileSync(fixture.testKeyPath, 'utf8'),
            channels: ['nightly'],
          },
          {
            keyId: 'station-fixture-release',
            algorithm: 'ed25519',
            publicKeySpkiPem: readFileSync(fixture.testKeyPath, 'utf8'),
            channels: ['stable', 'preview'],
          },
        ],
      }),
    );
    const archive = buildArchive(fixture, '1.2.3');
    const verifyAs = (keyId: string) => {
      const manifestPath = signManifest(fixture, '1.2.3', archive, { keyId });
      return run(['verify', '--manifest', manifestPath, '--keys', table], {
        STATION_ECOSYSTEM_ALLOW_INSECURE_TEST_URLS: '1',
      });
    };
    const good = verifyAs('station-fixture-release');
    expect(good.status, good.stderr).toBe(0);
    expect(JSON.parse(good.stdout).version).toBe('1.2.3');
    const wrongChannel = verifyAs('station-fixture-nightly');
    expect(wrongChannel.status).toBe(1);
    expect(wrongChannel.stderr).toContain(
      'signing key station-fixture-nightly is not authorized for channel stable',
    );
    const unknown = verifyAs('station-fixture-unknown');
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain(
      'manifest signing key station-fixture-unknown is not pinned',
    );
  });

  it('refuses to sign a channel the pinned key id is not authorized for', () => {
    const fixture = makeInstallFixture('station-manifest-sign-policy-');
    const payloadPath = join(fixture.dir, 'payload.json');
    writeFileSync(payloadPath, JSON.stringify(GOLDEN_PAYLOAD));
    const result = run(
      [
        'create',
        '--payload',
        payloadPath,
        '--private-key',
        fixture.privateKeyPath,
        '--key-id',
        RELEASE_KEY_ID,
        '--output',
        join(fixture.dir, 'out.json'),
      ],
      { STATION_ECOSYSTEM_ALLOW_INSECURE_TEST_URLS: '1' },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `signing key ${RELEASE_KEY_ID} is not authorized for channel nightly`,
    );
  });
});

describe('install.sh public manifest verification', () => {
  it('installs a v2 manifest signed under the pinned release key id', {
    timeout: 60_000,
  }, () => {
    const fixture = makeInstallFixture('station-pinned-good-');
    const archive = buildArchive(fixture, '1.2.3');
    const result = runInstaller(
      fixture,
      signManifest(fixture, '1.2.3', archive),
    );
    expect(result.status, result.stderr).toBe(0);
    expect(installedTag(fixture)).toBe('v1.2.3');
    expect(existsSync(join(currentRelease(fixture), '.launched'))).toBe(true);
  });

  it('rejects a tampered payload', { timeout: 60_000 }, () => {
    const fixture = makeInstallFixture('station-pinned-tampered-');
    const archive = buildArchive(fixture, '1.2.3');
    const manifestPath = signManifest(fixture, '1.2.3', archive);
    const envelope = JSON.parse(readFileSync(manifestPath, 'utf8'));
    envelope.payload.sourceSha = 'b'.repeat(40);
    writeFileSync(manifestPath, JSON.stringify(envelope));
    const result = runInstaller(fixture, manifestPath);
    expect(result.stderr).toContain(
      'public ecosystem manifest signature did not verify',
    );
    expect(result.status).toBe(1);
    expect(existsSync(join(fixture.dir, 'home', '.station', 'installs'))).toBe(
      false,
    );
  });

  it('rejects an envelope whose keyId is not pinned', {
    timeout: 60_000,
  }, () => {
    const fixture = makeInstallFixture('station-pinned-unknown-');
    const archive = buildArchive(fixture, '1.2.3');
    const result = runInstaller(
      fixture,
      signManifest(fixture, '1.2.3', archive, {
        keyId: 'station-portable-rogue-2026-09',
      }),
    );
    expect(result.stderr).toContain(
      'public ecosystem manifest is signed by a key this installer does not pin',
    );
    expect(result.status).toBe(1);
  });

  it('rejects the nightly key signing a stable manifest', {
    timeout: 60_000,
  }, () => {
    const fixture = makeInstallFixture('station-pinned-channel-');
    const archive = buildArchive(fixture, '1.2.3');
    const result = runInstaller(
      fixture,
      signManifest(fixture, '1.2.3', archive, { keyId: NIGHTLY_KEY_ID }),
    );
    expect(result.stderr).toContain(
      'public ecosystem manifest signing key is not authorized for the manifest channel',
    );
    expect(result.status).toBe(1);
  });

  it('verifies against the pinned public key when no test override is set', {
    timeout: 60_000,
  }, () => {
    // A fixture key cannot produce a signature the real pinned release key
    // accepts, so without the override the same manifest must fail.
    const fixture = makeInstallFixture('station-pinned-real-key-');
    const archive = buildArchive(fixture, '1.2.3');
    const result = runInstaller(
      fixture,
      signManifest(fixture, '1.2.3', archive),
      { STATION_INSTALL_MANIFEST_PUBLIC_KEY_URL: '' },
    );
    expect(result.stderr).toContain(
      'public ecosystem manifest signature did not verify',
    );
    expect(result.status).toBe(1);
  });

  it('refuses the test-only key URL without the insecure test flag', {
    timeout: 60_000,
  }, () => {
    const fixture = makeInstallFixture('station-pinned-key-url-');
    const archive = buildArchive(fixture, '1.2.3');
    const result = runInstaller(
      fixture,
      signManifest(fixture, '1.2.3', archive),
      { STATION_INSTALL_ALLOW_INSECURE_TEST_URLS: '' },
    );
    expect(result.stderr).toContain(
      'STATION_INSTALL_MANIFEST_PUBLIC_KEY_URL is a test-only override',
    );
    expect(result.status).toBe(1);
  });

  it('treats a reinstall of the same version and bytes as a no-op', {
    timeout: 120_000,
  }, () => {
    const fixture = makeInstallFixture('station-pinned-same-');
    const archive = buildArchive(fixture, '1.2.3');
    const manifestPath = signManifest(fixture, '1.2.3', archive);
    const first = runInstaller(fixture, manifestPath);
    expect(first.status, first.stderr).toBe(0);
    const launched = join(currentRelease(fixture), '.launched');
    rmSync(launched);
    const again = runInstaller(fixture, manifestPath);
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toContain(
      'Station v1.2.3 is already installed; nothing to do.',
    );
    // Nothing was stopped or started.
    expect(existsSync(launched)).toBe(false);
  });

  it('refuses a downgrade unless an exact version and the rollback flag are both given', {
    timeout: 180_000,
  }, () => {
    const fixture = makeInstallFixture('station-pinned-downgrade-');
    const current = signManifest(
      fixture,
      '1.2.3',
      buildArchive(fixture, '1.2.3'),
    );
    const installed = runInstaller(fixture, current);
    expect(installed.status, installed.stderr).toBe(0);
    const older = signManifest(
      fixture,
      '1.2.2',
      buildArchive(fixture, '1.2.2'),
    );

    for (const env of <Record<string, string>[]>[
      {},
      { STATION_INSTALL_ALLOW_ROLLBACK: '1' },
      { STATION_VERSION: 'v1.2.2' },
    ]) {
      const refused = runInstaller(fixture, older, env);
      expect(refused.stderr).toContain(
        'refusing to downgrade Station from v1.2.3 to v1.2.2',
      );
      expect(refused.status).toBe(1);
      expect(installedTag(fixture)).toBe('v1.2.3');
    }

    const rolledBack = runInstaller(fixture, older, {
      STATION_VERSION: 'v1.2.2',
      STATION_INSTALL_ALLOW_ROLLBACK: '1',
    });
    expect(rolledBack.status, rolledBack.stderr).toBe(0);
    expect(rolledBack.stdout).toContain(
      'Rolling back Station from v1.2.3 to v1.2.2',
    );
    expect(installedTag(fixture)).toBe('v1.2.2');

    // Control: an upgrade still proceeds without any flag.
    const newer = runInstaller(
      fixture,
      signManifest(fixture, '1.2.4', buildArchive(fixture, '1.2.4')),
    );
    expect(newer.status, newer.stderr).toBe(0);
    expect(installedTag(fixture)).toBe('v1.2.4');
  });
});
