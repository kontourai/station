import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
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

const root = resolve(import.meta.dirname, '../..');
const script = join(root, 'scripts/ecosystem-manifest.mjs');
const installer = join(root, 'install.sh');
const publishBoundary = join(root, 'scripts/ecosystem-publish-boundary.sh');
const workflow = join(root, '.github/workflows/ecosystem-packaging.yml');
const roots: string[] = [];

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
            'station-ecosystem-v1',
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
