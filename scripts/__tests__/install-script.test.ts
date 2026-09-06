import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../..');
const installScript = join(repoRoot, 'install.sh');
const roots: string[] = [];

function posixShellLiteral(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function executable(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function makeFixtureArchive(
  root: string,
  id = 'a',
  failStart = false,
  failStop = false,
  releaseChannel: 'stable' | 'preview' = 'stable',
  provenanceSchema: 2 = 2,
): {
  archive: string;
  checksum: string;
  log: string;
  fakeBin: string;
  manifest: string;
  ghLog: string;
} {
  const source = join(root, 'source', 'station');
  const fakeBin = join(root, 'fake-bin');
  const log = join(root, 'station.log');
  mkdirSync(source, { recursive: true });
  writeFileSync(
    join(source, 'package.json'),
    JSON.stringify({
      name: 'station-installer-fixture',
      version: '0.1.0',
      packageManager: 'pnpm@11.25.0',
      scripts: {
        'dependencies:ci': 'node scripts/dependency-lifecycle.mjs ci',
      },
    }),
  );
  writeFileSync(join(source, 'pnpm-lock.yaml'), '{}\n');
  writeFileSync(join(source, 'pnpm-workspace.yaml'), 'packages: []\n');
  writeFileSync(
    join(source, '.station-release.json'),
    `${JSON.stringify({
      schemaVersion: provenanceSchema,
      sha: id.repeat(40),
      ref: releaseChannel === 'preview' ? 'v0.1.0-preview.1' : 'v0.1.0',
      createdAt: '2026-07-22T00:00:00.000Z',
      channel:
        provenanceSchema === 2 && releaseChannel === 'preview'
          ? 'beta'
          : releaseChannel,
      ...(provenanceSchema === 2 ? { releaseChannel } : {}),
      prerelease: releaseChannel === 'preview',
    })}\n`,
  );
  executable(
    join(source, 'station'),
    `#!/bin/sh
if [ "\${STATION_TEST_REQUIRE_NO_GITHUB_TOKEN:-0}" = 1 ] &&
  [ -n "\${GH_TOKEN:-}\${GITHUB_TOKEN:-}" ]; then exit 92; fi
if [ "\${STATION_TEST_REQUIRE_NO_GITHUB_TOKEN:-0}" = 1 ] &&
  gh auth token >/dev/null 2>&1; then exit 94; fi
if [ -n "\${STATION_TEST_AUTH_CONFIG_PATH:-}" ] &&
  [ -e "$(cat "$STATION_TEST_AUTH_CONFIG_PATH")" ]; then exit 93; fi
if [ -n "\${STATION_TEST_ENV_LOG:-}" ]; then
  printf '%s|%s|%s\\n' "\${STATION_ROOT:-}" "\${STATION_HOME:-}" "\${STATION_INSTALL_ROOT:-}" > "$STATION_TEST_ENV_LOG"
fi
if [ "$1" = start ] && [ -f "$STATION_TEST_RUNNING" ]; then exit 0; fi
printf "%s\\n" "$*" >> "$STATION_TEST_LOG"
${failStart ? 'if [ "$1" = start ]; then exit 1; fi' : ''}
${failStop ? 'if [ "$1" = stop ]; then exit 1; fi' : ''}
if [ "$1" = start ]; then touch "$STATION_TEST_RUNNING"; fi
if [ "$1" = stop ]; then rm -f "$STATION_TEST_RUNNING"; fi
`,
  );
  executable(
    join(fakeBin, 'npm'),
    `#!/bin/sh
if [ "\${STATION_TEST_REQUIRE_NO_GITHUB_TOKEN:-0}" = 1 ] &&
  [ -n "\${GH_TOKEN:-}\${GITHUB_TOKEN:-}" ]; then exit 92; fi
if [ "\${STATION_TEST_REQUIRE_NO_GITHUB_TOKEN:-0}" = 1 ] &&
  gh auth token >/dev/null 2>&1; then exit 94; fi
if [ -n "\${STATION_TEST_AUTH_CONFIG_PATH:-}" ] &&
  [ -e "$(cat "$STATION_TEST_AUTH_CONFIG_PATH")" ]; then exit 93; fi
if [ "\${STATION_TEST_NPM_FAIL:-0}" = 1 ]; then exit 95; fi
touch "$PWD/.npm-ci-complete"
`,
  );
  const fakeNode = join(fakeBin, 'node');
  if (!existsSync(fakeNode)) {
    executable(
      fakeNode,
      `#!/bin/sh
if [ "$1" = -p ] && [ "$2" = 'process.versions.node.split(".")[0]' ]; then
  printf '24\n'
  exit 0
fi
exec "${process.execPath}" "$@"
`,
    );
  }

  const archive = join(root, 'station-portable.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', join(root, 'source'), 'station']);
  const digest = createHash('sha256')
    .update(readFileSync(archive))
    .digest('hex');
  const checksum = `${archive}.sha256`;
  writeFileSync(checksum, `${digest}  station-portable.tar.gz\n`);
  const manifest = join(root, `station-release-ring-${id}.json`);
  const ghLog = join(root, `gh-${id}.log`);
  writeFileSync(
    manifest,
    `${JSON.stringify({
      schemaVersion: 1,
      channel: releaseChannel,
      prerelease: releaseChannel === 'preview',
      ref: releaseChannel === 'preview' ? 'v0.1.0-preview.1' : 'v0.1.0',
      sha: id.repeat(40),
      createdAt: '2026-07-22T00:00:00.000Z',
      archive: { name: 'station-portable.tar.gz', sha256: digest },
      checksum: {
        name: 'station-portable.tar.gz.sha256',
        sha256: createHash('sha256')
          .update(readFileSync(checksum))
          .digest('hex'),
      },
    })}\n`,
  );
  executable(
    join(fakeBin, 'gh'),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$STATION_TEST_GH_LOG"
if [ "$1" = auth ] && [ "$2" = token ]; then
  [ -n "\${GH_TOKEN:-\${GITHUB_TOKEN:-}}" ] || exit 87
  printf '%s\\n' "\${GH_TOKEN:-$GITHUB_TOKEN}"
  exit 0
fi
if [ "$1" = auth ]; then
  [ -n "\${GH_TOKEN:-\${GITHUB_TOKEN:-}}" ] || exit 87
  exit 0
fi
if [ "$1" = attestation ]; then
  [ "$3" = --help ] && exit 0
  [ "\${STATION_TEST_GH_FAIL_ATTEST:-0}" = 1 ] && exit 88
  exit 0
fi
if [ "$1" = api ]; then
  endpoint="$2"
  case "$endpoint" in
    *releases\\?*) printf '[%s]' "$STATION_TEST_RELEASE_METADATA" ;;
    *releases/tags/*) printf '%s' "$STATION_TEST_RELEASE_METADATA" ;;
    *git/ref/tags/*) printf '{"object":{"type":"commit","sha":"%s"}}' "$STATION_TEST_RELEASE_SHA" ;;
    *) exit 91 ;;
  esac
  exit 0
fi
exit 91
`,
  );
  return { archive, checksum, log, fakeBin, manifest, ghLog };
}

function refreshFixtureDigests(
  fixture: ReturnType<typeof makeFixtureArchive>,
): void {
  const archiveDigest = createHash('sha256')
    .update(readFileSync(fixture.archive))
    .digest('hex');
  writeFileSync(
    fixture.checksum,
    `${archiveDigest}  station-portable.tar.gz\n`,
  );
  const manifest = JSON.parse(readFileSync(fixture.manifest, 'utf8'));
  manifest.archive.sha256 = archiveDigest;
  manifest.checksum.sha256 = createHash('sha256')
    .update(readFileSync(fixture.checksum))
    .digest('hex');
  writeFileSync(fixture.manifest, `${JSON.stringify(manifest)}\n`);
}

function runInstaller(
  root: string,
  fixture: ReturnType<typeof makeFixtureArchive>,
  args: string[] = [],
  envOverrides: Record<string, string> = {},
) {
  const { STATION_TEST_CWD: cwd, ...installerOverrides } = envOverrides;
  const home = join(root, 'home');
  const stationRoot = installerOverrides.STATION_ROOT ?? join(home, '.station');
  const runtimeChannel = installerOverrides.STATION_CHANNEL ?? 'stable';
  const installRoot =
    installerOverrides.STATION_INSTALL_ROOT ??
    join(stationRoot, 'installs', runtimeChannel);
  const binDir = join(home, '.local', 'bin');
  const stationHome =
    installerOverrides.STATION_HOME ??
    join(stationRoot, 'instances', runtimeChannel);
  const useDefaultInstallRoot =
    installerOverrides.STATION_TEST_USE_DEFAULT_ROOT === '1';
  const useDefaultRuntimePaths =
    installerOverrides.STATION_TEST_USE_DEFAULT_PATHS === '1';
  mkdirSync(home, { recursive: true });
  const result = spawnSync('sh', [installScript, ...args], {
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
    ...(cwd ? { cwd } : {}),
    env: {
      ...process.env,
      HOME: home,
      GH_TOKEN: 'fixture-token',
      PATH: `${fixture.fakeBin}:${process.env.PATH ?? ''}`,
      STATION_BIN_DIR: binDir,
      ...(useDefaultRuntimePaths ? {} : { STATION_HOME: stationHome }),
      STATION_ROOT: stationRoot,
      STATION_INSTALL_ASSET_URL: `file://${fixture.archive}`,
      STATION_INSTALL_CHECKSUM_URL: `file://${fixture.checksum}`,
      STATION_INSTALL_MANIFEST_URL: `file://${fixture.manifest}`,
      ...(useDefaultInstallRoot || useDefaultRuntimePaths
        ? {}
        : { STATION_INSTALL_ROOT: installRoot }),
      STATION_TEST_RELEASE_SHA:
        readFileSync(
          join(root, 'source', 'station', '.station-release.json'),
          'utf8',
        ).match(/"sha":\s*"([0-9a-f]+)"/)?.[1] ?? '',
      STATION_TEST_GH_LOG: fixture.ghLog,
      STATION_TEST_RELEASE_METADATA: JSON.stringify({
        tag_name:
          envOverrides.STATION_CHANNEL === 'beta'
            ? 'v0.1.0-preview.1'
            : 'v0.1.0',
        target_commitish: 'main',
        draft: false,
        prerelease: envOverrides.STATION_CHANNEL === 'beta',
        assets: [],
      }),
      STATION_TEST_LOG: fixture.log,
      STATION_TEST_RUNNING: `${fixture.log}.running`,
      ...installerOverrides,
    },
  });
  return { result, home, stationRoot, installRoot, binDir, stationHome };
}

function createLegacyStableInstall(root: string) {
  const home = join(root, 'home');
  const legacyRoot = join(home, '.local', 'share', 'station');
  const legacyHome = join(home, '.station-legacy');
  const legacyRelease = join(legacyRoot, 'releases', 'old');
  const launcher = join(home, '.local', 'bin', 'station');
  executable(join(legacyRelease, 'station'), '#!/bin/sh\nexit 0\n');
  mkdirSync(legacyHome, { recursive: true });
  writeFileSync(join(legacyHome, 'legacy-data'), 'preserve me');
  writeFileSync(
    join(legacyRoot, '.station-portable-install-root'),
    'station-portable-install-root-v1\n',
    { mode: 0o600 },
  );
  writeFileSync(
    join(legacyRoot, '.station-release-state.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      channel: 'stable',
      installRoot: legacyRoot,
      stationHome: legacyHome,
    })}\n`,
    { mode: 0o600 },
  );
  symlinkSync('./releases/old', join(legacyRoot, 'current'));
  mkdirSync(dirname(launcher), { recursive: true });
  symlinkSync(join(legacyRoot, 'current', 'station'), launcher);
  return { legacyHome, legacyRoot, launcher };
}

const privateCurlScript = `#!/bin/sh
output=
config=
url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    --config) config="$2"; shift 2 ;;
    -H) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in
  https://api.github.com/*)
    grep -q 'Authorization: Bearer test_private_token' "$config" || exit 90
    node -e 'if ((require("node:fs").statSync(process.argv[1]).mode & 0o077) !== 0) process.exit(1)' "$config" || exit 92
    printf '%s' "$config" > "$STATION_TEST_AUTH_CONFIG_PATH"
    auth=auth
    ;;
  *) auth=anonymous ;;
esac
printf '%s %s\n' "$auth" "$url" >> "$STATION_TEST_CURL_LOG"
case "$url" in
  */releases/latest|*/releases/tags/v0.1.0)
    printf '%s\n' '{"assets":[{"name":"station-portable.tar.gz","url":"https://api.github.com/repos/kontourai/station/releases/assets/1"},{"name":"station-portable.tar.gz.sha256","url":"https://api.github.com/repos/kontourai/station/releases/assets/2"}]}'
    ;;
  */assets/1) cp "$STATION_TEST_ARCHIVE" "$output" ;;
  */assets/2) cp "$STATION_TEST_CHECKSUM" "$output" ;;
  file://*) cp "\${url#file://}" "$output" ;;
  */station-portable.tar.gz) cp "$STATION_TEST_ARCHIVE" "$output" ;;
  */station-portable.tar.gz.sha256) cp "$STATION_TEST_CHECKSUM" "$output" ;;
  *) exit 91 ;;
esac
`;

function privateDownloadFixture(
  root: string,
  fixture: ReturnType<typeof makeFixtureArchive>,
) {
  const curlLog = join(root, 'curl-auth.log');
  executable(join(fixture.fakeBin, 'curl'), privateCurlScript);
  return {
    curlLog,
    env: {
      STATION_TEST_ARCHIVE: fixture.archive,
      STATION_TEST_CHECKSUM: fixture.checksum,
      STATION_TEST_CURL_LOG: curlLog,
      STATION_TEST_AUTH_CONFIG_PATH: join(root, 'auth-config-path'),
    },
  };
}

// These integration-style cases intentionally execute the real shell installer
// multiple times. Give each case enough headroom for loaded local/CI runners;
// product subprocesses still retain their own tighter failure boundaries.
describe('one-line Station installer', { timeout: 15_000 }, () => {
  it.each([
    {
      name: 'missing pnpm lock with an npm fallback',
      remove: 'pnpm-lock.yaml',
      npmLock: true,
      error: 'missing pnpm-lock.yaml',
    },
    {
      name: 'missing pnpm workspace',
      remove: 'pnpm-workspace.yaml',
      error: 'missing pnpm-workspace.yaml',
    },
    {
      name: 'mixed dependency locks',
      npmLock: true,
      error: 'ambiguous dependency lockfiles',
    },
    {
      name: 'unpinned pnpm',
      manager: 'pnpm@11',
      error: 'must pin supported pnpm 11',
    },
    {
      name: 'unsupported pnpm major',
      manager: 'pnpm@10.0.0',
      error: 'must pin supported pnpm 11',
    },
    {
      name: 'unsupported manager',
      manager: 'yarn@4.0.0',
      error: 'must pin supported pnpm 11',
    },
    {
      name: 'undeclared pnpm configuration',
      manager: null,
      npmLock: true,
      error: 'undeclared pnpm dependency configuration',
    },
    {
      name: 'missing package metadata',
      remove: 'package.json',
      error: 'missing package.json',
    },
    {
      name: 'missing managed runner',
      missingRunner: true,
      error: 'missing its managed dependencies:ci runner',
    },
    {
      name: 'conflicting manager declarations',
      conflictingManager: true,
      error: 'conflicting package-manager declarations',
    },
  ])('refuses $name before dependency execution', (scenario) => {
    const root = mkdtempSync(join(tmpdir(), 'station-installer-contract-'));
    roots.push(root);
    const fixture = makeFixtureArchive(root);
    const source = join(root, 'source', 'station');
    const manifestPath = join(source, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if ('manager' in scenario) {
      if (scenario.manager === null) delete manifest.packageManager;
      else manifest.packageManager = scenario.manager;
    }
    if ('missingRunner' in scenario) manifest.scripts = {};
    if ('conflictingManager' in scenario)
      manifest.devEngines = {
        packageManager: { name: 'npm', version: '11.0.0' },
      };
    writeFileSync(manifestPath, JSON.stringify(manifest));
    if ('remove' in scenario && scenario.remove)
      rmSync(join(source, scenario.remove));
    if ('npmLock' in scenario)
      writeFileSync(join(source, 'package-lock.json'), '{}\n');
    execFileSync(
      'tar',
      ['-czf', fixture.archive, '-C', join(root, 'source'), 'station'],
      { windowsHide: true },
    );
    refreshFixtureDigests(fixture);
    const installed = runInstaller(root, fixture, [], {
      STATION_TEST_NPM_FAIL: '1',
    });
    expect(installed.result.status).not.toBe(0);
    expect(installed.result.status).not.toBe(95);
    expect(installed.result.stderr).toContain(scenario.error);
    expect(installed.result.stdout).not.toContain(
      'Installing Station dependencies',
    );
    expect(existsSync(join(installed.installRoot, 'current'))).toBe(false);
  });

  it('delegates an explicitly npm-pinned legacy release to its archived managed runner', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-installer-npm-'));
    roots.push(root);
    const fixture = makeFixtureArchive(root);
    const source = join(root, 'source', 'station');
    const manifest = JSON.parse(
      readFileSync(join(source, 'package.json'), 'utf8'),
    );
    manifest.packageManager = 'npm@11.10.0';
    writeFileSync(join(source, 'package.json'), JSON.stringify(manifest));
    rmSync(join(source, 'pnpm-lock.yaml'));
    rmSync(join(source, 'pnpm-workspace.yaml'));
    writeFileSync(join(source, 'package-lock.json'), '{}\n');
    execFileSync(
      'tar',
      ['-czf', fixture.archive, '-C', join(root, 'source'), 'station'],
      { windowsHide: true },
    );
    refreshFixtureDigests(fixture);
    executable(
      join(fixture.fakeBin, 'npm'),
      '#!/bin/sh\n[ "$*" = "run dependencies:ci" ] || exit 96\n[ -f "$PWD/package-lock.json" ] || exit 97\ntouch "$PWD/.npm-ci-complete"\n',
    );
    const installed = runInstaller(root, fixture);
    expect(installed.result.status, installed.result.stderr).toBe(0);
    expect(
      existsSync(join(installed.installRoot, 'current', '.npm-ci-complete')),
    ).toBe(true);
  });

  it('installs, starts, and reuses the same checksum-addressed release', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-installer-'));
    roots.push(root);
    const fixture = makeFixtureArchive(root);

    const first = runInstaller(root, fixture, [], {
      GH_TOKEN: 'test_private_token',
      STATION_TEST_REQUIRE_NO_GITHUB_TOKEN: '1',
    });
    expect(first.result.status, first.result.stderr).toBe(0);
    const current = join(first.installRoot, 'current');
    const launcher = join(first.binDir, 'station');
    expect(existsSync(join(current, '.npm-ci-complete'))).toBe(true);
    expect(readFileSync(launcher, 'utf8')).toContain(
      '# station-owned-launcher-v1',
    );
    expect(readFileSync(launcher, 'utf8')).toContain(
      `export STATION_CHANNEL=${posixShellLiteral('stable')}`,
    );
    expect(readFileSync(launcher, 'utf8')).toContain(
      `export STATION_HOME=${posixShellLiteral(realpathSync(first.stationHome))}`,
    );
    expect(readFileSync(launcher, 'utf8')).toContain(
      `exec ${posixShellLiteral(`${realpathSync(first.installRoot)}/current/station`)} "$@"`,
    );
    expect(readFileSync(fixture.log, 'utf8')).toContain('build');
    expect(readFileSync(fixture.log, 'utf8')).toContain('start --base=');
    expect(readFileSync(fixture.log, 'utf8')).toContain('--port=18141');
    expect(readFileSync(fixture.log, 'utf8')).toContain('--ui-port=18000');
    expect(first.result.stdout).toContain('http://localhost:18000');
    expect(first.result.stdout).not.toContain('test_private_token');
    expect(first.result.stderr).not.toContain('test_private_token');
    const attestationCalls = readFileSync(fixture.ghLog, 'utf8');
    expect(attestationCalls).toContain('verify --help');
    expect(attestationCalls).toContain('attestation verify ');
    expect(attestationCalls).toContain(
      '--repo kontourai/station --signer-workflow kontourai/station/.github/workflows/release.yml --source-ref refs/tags/v0.1.0',
    );
    expect(attestationCalls).toContain(
      '--cert-oidc-issuer https://token.actions.githubusercontent.com --deny-self-hosted-runners',
    );

    const second = runInstaller(root, fixture);
    expect(second.result.status, second.result.stderr).toBe(0);
    expect(second.result.stdout).toContain('already installed');
    const calls = readFileSync(fixture.log, 'utf8').trim().split('\n');
    expect(calls.filter((line) => line.startsWith('build '))).toHaveLength(1);
    // Reuse re-starts the release, and must stop the still-running instance
    // first — starting over a live instance races it for its own ports.
    const startIndices = calls.flatMap((line, index) =>
      line.startsWith('start ') ? [index] : [],
    );
    const stopIndices = calls.flatMap((line, index) =>
      line.startsWith('stop ') ? [index] : [],
    );
    expect(startIndices).toHaveLength(2);
    expect(stopIndices).toHaveLength(1);
    expect(stopIndices[0]).toBeGreaterThan(startIndices[0]);
    expect(stopIndices[0]).toBeLessThan(startIndices[1]);
    expect(readlinkSync(current)).toMatch(/\/releases\/[0-9a-f]{64}$/);
    const statePath = join(first.installRoot, '.station-release-state.json');
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual({
      schemaVersion: 3,
      channel: 'stable',
      releaseChannel: 'stable',
      installRoot: realpathSync(first.installRoot),
      stationRoot: realpathSync(join(first.home, '.station')),
      stationHome: realpathSync(first.stationHome),
    });
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
  });

  it('keeps hostile launcher paths literal through install, ownership, upgrade, rollback, and uninstall', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-installer-hostile-'));
    roots.push(root);
    const substitutionMarker = join(root, 'command-substitution-ran');
    const backtickMarker = join(root, 'backtick-ran');
    const hostileSuffix =
      `space ' $(touch ${substitutionMarker}) ` +
      `\`touch ${backtickMarker}\` \\backslash\nnext-line`;
    const installRoot = join(root, `install-${hostileSuffix}`);
    const stationHome = join(root, `home-${hostileSuffix}`);
    const overrides = {
      STATION_INSTALL_ROOT: installRoot,
      STATION_HOME: stationHome,
    };
    const markersRemainAbsent = () => {
      expect(existsSync(substitutionMarker)).toBe(false);
      expect(existsSync(backtickMarker)).toBe(false);
    };

    const firstFixture = makeFixtureArchive(root, '1');
    const first = runInstaller(root, firstFixture, [], overrides);
    expect(first.result.status, first.result.stderr).toBe(0);
    markersRemainAbsent();
    const launcher = join(first.binDir, 'station');
    const current = join(installRoot, 'current');
    expect(readFileSync(launcher, 'utf8')).toContain(
      `export STATION_HOME=${posixShellLiteral(realpathSync(stationHome))}`,
    );
    expect(readFileSync(launcher, 'utf8')).toContain(
      `export STATION_INSTALL_ROOT=${posixShellLiteral(realpathSync(installRoot))}`,
    );
    expect(readFileSync(launcher, 'utf8')).toContain(
      `exec ${posixShellLiteral(`${realpathSync(installRoot)}/current/station`)} "$@"`,
    );

    const throughLauncher = spawnSync(launcher, ['doctor'], {
      encoding: 'utf8',
      env: { ...process.env, STATION_TEST_LOG: firstFixture.log },
    });
    expect(throughLauncher.status, throughLauncher.stderr).toBe(0);
    markersRemainAbsent();

    const ownershipCheck = runInstaller(root, firstFixture, [], overrides);
    expect(ownershipCheck.result.status, ownershipCheck.result.stderr).toBe(0);
    expect(ownershipCheck.result.stdout).toContain('already installed');
    markersRemainAbsent();

    const upgradeFixture = makeFixtureArchive(root, '2');
    const upgraded = runInstaller(root, upgradeFixture, [], overrides);
    expect(upgraded.result.status, upgraded.result.stderr).toBe(0);
    const upgradedRelease = readlinkSync(current);
    markersRemainAbsent();

    const brokenFixture = makeFixtureArchive(root, '3', true);
    const rollback = runInstaller(root, brokenFixture, [], overrides);
    expect(rollback.result.status).not.toBe(0);
    expect(rollback.result.stderr).toContain('previous release was restored');
    expect(readlinkSync(current)).toBe(upgradedRelease);
    markersRemainAbsent();

    const removed = runInstaller(
      root,
      upgradeFixture,
      ['uninstall'],
      overrides,
    );
    expect(removed.result.status, removed.result.stderr).toBe(0);
    expect(existsSync(installRoot)).toBe(false);
    expect(existsSync(stationHome)).toBe(true);
    expect(existsSync(launcher)).toBe(false);
    markersRemainAbsent();
  }, 60_000);

  it('maps a verified preview release to an isolated beta runtime wrapper', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-installer-'));
    roots.push(root);
    const fixture = makeFixtureArchive(root, 'b', false, false, 'preview', 2);
    const beta = runInstaller(root, fixture, [], { STATION_CHANNEL: 'beta' });

    expect(beta.result.status, beta.result.stderr).toBe(0);
    expect(beta.installRoot).toMatch(/\.station\/installs\/beta$/);
    expect(beta.stationHome).toMatch(/\.station\/instances\/beta$/);
    const launcher = join(beta.binDir, 'station-beta');
    expect(readFileSync(launcher, 'utf8')).toContain(
      `export STATION_CHANNEL=${posixShellLiteral('beta')}`,
    );
    expect(
      JSON.parse(
        readFileSync(
          join(beta.installRoot, '.station-release-state.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({
      schemaVersion: 3,
      channel: 'beta',
      releaseChannel: 'preview',
    });

    const throughWrapper = spawnSync(launcher, ['doctor'], {
      encoding: 'utf8',
      env: { ...process.env, STATION_TEST_LOG: fixture.log },
    });
    expect(throughWrapper.status).toBe(0);
    expect(readFileSync(fixture.log, 'utf8')).toContain('doctor');
  });

  it('accepts packaged v2 provenance and preserves the beta-to-preview mapping', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-installer-'));
    roots.push(root);
    const fixture = makeFixtureArchive(root, 'd', false, false, 'preview', 2);
    const installed = runInstaller(root, fixture, [], {
      STATION_CHANNEL: 'beta',
    });

    expect(installed.result.status, installed.result.stderr).toBe(0);
    expect(
      JSON.parse(
        readFileSync(
          join(installed.installRoot, '.station-release-state.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({
      schemaVersion: 3,
      channel: 'beta',
      releaseChannel: 'preview',
    });
  });

  it('leaves an obsolete unqualified install and its data untouched', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-installer-'));
    roots.push(root);
    const fixture = makeFixtureArchive(root, 'e');
    const { legacyHome, legacyRoot, launcher } =
      createLegacyStableInstall(root);

    const installed = runInstaller(root, fixture, [], {
      STATION_TEST_USE_DEFAULT_ROOT: '1',
      STATION_BIN_DIR: join(root, 'new-bin'),
    });
    expect(installed.result.status, installed.result.stderr).toBe(0);
    expect(existsSync(legacyRoot)).toBe(true);
    expect(readFileSync(join(legacyHome, 'legacy-data'), 'utf8')).toBe(
      'preserve me',
    );
    expect(readlinkSync(launcher)).toContain('/current/station');
    expect(installed.installRoot).toMatch(/\.station\/installs\/stable$/);
    expect(
      JSON.parse(
        readFileSync(
          join(installed.installRoot, '.station-release-state.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({
      schemaVersion: 3,
      channel: 'stable',
      releaseChannel: 'stable',
      stationHome: realpathSync(installed.stationHome),
    });
  });

  it.each([
    ['build', { STATION_TEST_NPM_FAIL: '1' }],
    ['start', { STATION_TEST_FAIL_START: '1' }],
  ] as const)(
    'restores the untouched legacy stable root and launcher when adoption %s fails',
    (phase, overrides) => {
      const root = mkdtempSync(join(tmpdir(), 'station-installer-'));
      roots.push(root);
      const fixture = makeFixtureArchive(
        root,
        phase === 'build' ? 'g' : 'h',
        phase === 'start',
      );
      const { legacyHome, legacyRoot, launcher } =
        createLegacyStableInstall(root);
      const originalState = readFileSync(
        join(legacyRoot, '.station-release-state.json'),
        'utf8',
      );

      const result = runInstaller(root, fixture, [], {
        STATION_TEST_USE_DEFAULT_ROOT: '1',
        ...overrides,
      });
      expect(result.result.status).not.toBe(0);
      expect(existsSync(legacyRoot)).toBe(true);
      expect(readlinkSync(join(legacyRoot, 'current'))).toBe('./releases/old');
      expect(readlinkSync(launcher)).toBe(
        join(legacyRoot, 'current', 'station'),
      );
      expect(
        readFileSync(join(legacyRoot, '.station-release-state.json'), 'utf8'),
      ).toBe(originalState);
      expect(readFileSync(join(legacyHome, 'legacy-data'), 'utf8')).toBe(
        'preserve me',
      );
    },
  );

  it('rejects the legacy unqualified preview runtime name with a remediation', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-installer-'));
    roots.push(root);
    const fixture = makeFixtureArchive(root);
    const rejected = runInstaller(root, fixture, [], {
      STATION_CHANNEL: 'preview',
    });
    expect(rejected.result.status).not.toBe(0);
    expect(rejected.result.stderr).toContain('STATION_CHANNEL=beta');
  });

  it('does not inspect or mutate a legacy preview state outside the Station root', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-installer-'));
    roots.push(root);
    const fixture = makeFixtureArchive(root);
    const legacyRoot = join(root, 'home', '.local', 'share', 'station');
    mkdirSync(legacyRoot, { recursive: true });
    writeFileSync(
      join(legacyRoot, '.station-release-state.json'),
      `${JSON.stringify({ schemaVersion: 1, channel: 'preview' })}\n`,
    );
    const installed = runInstaller(root, fixture);
    expect(installed.result.status, installed.result.stderr).toBe(0);
    expect(
      readFileSync(join(legacyRoot, '.station-release-state.json'), 'utf8'),
    ).toContain('preview');
  });

  it('prints the channel launcher, rather than a stale generic command, when start is deferred', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-installer-'));
    roots.push(root);
    const fixture = makeFixtureArchive(root, 'c', false, false, 'preview', 2);
    const deferred = runInstaller(root, fixture, [], {
      STATION_CHANNEL: 'beta',
      STATION_INSTALL_NO_START: '1',
    });
    expect(deferred.result.status, deferred.result.stderr).toBe(0);
    expect(deferred.result.stdout).toContain(
      `Start it with: ${realpathSync(join(deferred.binDir, 'station-beta'))} start`,
    );
    expect(existsSync(`${fixture.log}.running`)).toBe(false);
    expect(readFileSync(fixture.log, 'utf8')).toContain('--port=28141');
    expect(readFileSync(fixture.log, 'utf8')).toContain('--ui-port=28000');
  });

  it('uses installer overrides ahead of lifecycle environment values for build and start', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-installer-'));
    roots.push(root);
    const fixture = makeFixtureArchive(root, 'f');
    const installed = runInstaller(root, fixture, [], {
      STATION_SERVER_PORT: '19001',
      STATION_UI_PORT: '19000',
      STATION_INSTALL_SERVER_PORT: '19101',
      STATION_INSTALL_UI_PORT: '19100',
    });
    expect(installed.result.status, installed.result.stderr).toBe(0);
    const calls = readFileSync(fixture.log, 'utf8');
    expect(calls).toContain('--port=19101');
    expect(calls).toContain('--ui-port=19100');
  });

  it('rejects an unsigned release source instead of using a private curl fallback', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-installer-'));
    roots.push(root);
    const fixture = makeFixtureArchive(root);
    const download = privateDownloadFixture(root, fixture);

    const installed = runInstaller(root, fixture, [], {
      ...download.env,
      GH_TOKEN: 'test_private_token',
      GITHUB_TOKEN: '',
      STATION_INSTALL_ASSET_URL: '',
      STATION_INSTALL_CHECKSUM_URL: '',
      STATION_TEST_REQUIRE_NO_GITHUB_TOKEN: '1',
    });

    expect(installed.result.status).not.toBe(0);
    expect(installed.result.stderr).toContain('release is missing');
  });

  it('rejects an exact version whose release metadata cannot prove its ring', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-installer-'));
    roots.push(root);
    const fixture = makeFixtureArchive(root);
    const download = privateDownloadFixture(root, fixture);

    const pinned = runInstaller(root, fixture, [], {
      ...download.env,
      GH_TOKEN: 'test_private_token',
      GITHUB_TOKEN: '',
      STATION_VERSION: 'v0.1.0',
      STATION_INSTALL_ASSET_URL: `file://${fixture.archive}`,
      STATION_INSTALL_CHECKSUM_URL: '',
      STATION_TEST_REQUIRE_NO_GITHUB_TOKEN: '1',
    });
    expect(pinned.result.status).not.toBe(0);
    expect(pinned.result.stderr).toContain('release is missing');
  });

  it('does not retain an anonymous public release fallback', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-installer-'));
    roots.push(root);
    const fixture = makeFixtureArchive(root);
    const download = privateDownloadFixture(root, fixture);

    const anonymous = runInstaller(root, fixture, [], {
      ...download.env,
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
      STATION_INSTALL_ASSET_URL: '',
      STATION_INSTALL_CHECKSUM_URL: '',
    });
    expect(anonymous.result.status).not.toBe(0);
    expect(anonymous.result.stderr).toContain(
      'GH_TOKEN or GITHUB_TOKEN is required',
    );
  });

  it('makes the documented private bootstrap fail when GitHub cannot fetch the script', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-installer-'));
    roots.push(root);
    const fakeBin = join(root, 'fake-bin');
    executable(
      join(fakeBin, 'gh'),
      '#!/bin/sh\nif [ "$1 $2" = "auth token" ]; then echo test_private_token; exit 0; fi\nexit 42\n',
    );
    executable(join(fakeBin, 'curl'), '#!/bin/sh\nexit 42\n');
    const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
    const command =
      /^#{2,3} (?:Install|Verified installer).*?\n[\s\S]*?```bash\n([^\n]+)\n```/m.exec(
        readme,
      )?.[1];
    expect(command).toBeTruthy();

    const result = spawnSync('sh', ['-c', command ?? 'exit 99'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
    });
    expect(result.status).toBe(42);
  });

  it('rejects a checksum mismatch before creating the install root', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-installer-'));
    roots.push(root);
    const fixture = makeFixtureArchive(root);
    writeFileSync(
      fixture.checksum,
      `${'0'.repeat(64)}  station-portable.tar.gz\n`,
    );

    const { result, installRoot } = runInstaller(root, fixture);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'checksum bytes do not match signed manifest',
    );
    expect(existsSync(installRoot)).toBe(false);
  });

  it('fails attestation before parsing a manifest or claiming an install root', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-installer-'));
    roots.push(root);
    const fixture = makeFixtureArchive(root);
    const { result, installRoot } = runInstaller(root, fixture, [], {
      STATION_TEST_GH_FAIL_ATTEST: '1',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('attestation verification failed');
    expect(existsSync(installRoot)).toBe(false);
  });

  it('replaces an incomplete unpublished checksum cache before promotion', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-installer-'));
    roots.push(root);
    const fixture = makeFixtureArchive(root);
    const digest = createHash('sha256')
      .update(readFileSync(fixture.archive))
      .digest('hex');
    const installRoot = join(root, 'home', '.station', 'installs', 'stable');
    const incomplete = join(installRoot, 'releases', digest);
    mkdirSync(incomplete, { recursive: true });
    writeFileSync(
      join(installRoot, '.station-portable-install-root'),
      'station-portable-install-root-v1\n',
    );
    chmodSync(join(installRoot, '.station-portable-install-root'), 0o600);
    writeFileSync(join(incomplete, 'partial'), 'interrupted copy');

    const installed = runInstaller(root, fixture);
    expect(installed.result.status, installed.result.stderr).toBe(0);
    expect(existsSync(join(incomplete, 'partial'))).toBe(false);
    expect(
      readFileSync(
        join(incomplete, '.station-install-complete'),
        'utf8',
      ).trim(),
    ).toBe(digest);
  });

  it('restores and restarts the previous release when an upgrade cannot start', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-installer-'));
    roots.push(root);
    const firstFixture = makeFixtureArchive(root, 'a');
    const first = runInstaller(root, firstFixture);
    expect(first.result.status, first.result.stderr).toBe(0);
    const current = join(first.installRoot, 'current');
    const previousRelease = readlinkSync(current);

    const brokenFixture = makeFixtureArchive(root, 'b', true);
    expect(
      execFileSync('tar', ['-xOzf', brokenFixture.archive, 'station/station'], {
        encoding: 'utf8',
      }),
    ).toContain('then exit 1');
    const upgrade = runInstaller(root, brokenFixture);
    expect(
      upgrade.result.status,
      JSON.stringify({
        stdout: upgrade.result.stdout,
        stderr: upgrade.result.stderr,
        log: readFileSync(firstFixture.log, 'utf8'),
      }),
    ).not.toBe(0);
    expect(upgrade.result.stderr).toContain('previous release was restored');
    expect(readlinkSync(current)).toBe(previousRelease);
    const calls = readFileSync(firstFixture.log, 'utf8').trim().split('\n');
    expect(calls.filter((line) => line.startsWith('stop '))).toHaveLength(1);
    expect(calls.filter((line) => line.startsWith('start '))).toHaveLength(3);
  });

  it('restores and restarts the previous release when launcher publication fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-installer-'));
    roots.push(root);
    const firstFixture = makeFixtureArchive(root, 'a');
    const first = runInstaller(root, firstFixture);
    expect(first.result.status, first.result.stderr).toBe(0);
    const current = join(first.installRoot, 'current');
    const previousRelease = readlinkSync(current);

    const upgradeFixture = makeFixtureArchive(root, 'b');
    chmodSync(first.binDir, 0o555);
    const upgrade = runInstaller(root, upgradeFixture);
    chmodSync(first.binDir, 0o755);

    expect(upgrade.result.status).not.toBe(0);
    expect(upgrade.result.stderr).toContain(
      'could not stage the channel launcher',
    );
    expect(readlinkSync(current)).toBe(previousRelease);
    const calls = readFileSync(firstFixture.log, 'utf8').trim().split('\n');
    expect(calls.filter((line) => line.startsWith('stop '))).toHaveLength(0);
    expect(calls.filter((line) => line.startsWith('start '))).toHaveLength(1);
  });

  it('rejects traversal entries before creating the install root', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-installer-'));
    roots.push(root);
    const fixture = makeFixtureArchive(root);
    execFileSync('python3', [
      '-c',
      'import io,tarfile,sys; t=tarfile.open(sys.argv[1],"w:gz"); i=tarfile.TarInfo("station/../../escape"); b=b"bad"; i.size=len(b); t.addfile(i,io.BytesIO(b)); t.close()',
      fixture.archive,
    ]);
    refreshFixtureDigests(fixture);

    const { result, installRoot } = runInstaller(root, fixture);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('release archive contains an unsafe path');
    expect(existsSync(installRoot)).toBe(false);
  });

  it('rejects symlink entries before extracting release files', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-installer-'));
    roots.push(root);
    const fixture = makeFixtureArchive(root);
    execFileSync('python3', [
      '-c',
      'import tarfile,sys; t=tarfile.open(sys.argv[1],"w:gz"); i=tarfile.TarInfo("station/link"); i.type=tarfile.SYMTYPE; i.linkname="/tmp/escape"; t.addfile(i); t.close()',
      fixture.archive,
    ]);
    refreshFixtureDigests(fixture);

    const { result, installRoot } = runInstaller(root, fixture);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'release archive contains an unsupported entry type',
    );
    expect(existsSync(installRoot)).toBe(false);
  });

  it('uninstalls program files while preserving data unless purge is explicit', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-installer-'));
    roots.push(root);
    const fixture = makeFixtureArchive(root);
    const installed = runInstaller(root, fixture);
    expect(installed.result.status, installed.result.stderr).toBe(0);
    mkdirSync(installed.stationHome, { recursive: true });
    writeFileSync(join(installed.stationHome, 'keep-me'), 'data');

    const removed = runInstaller(root, fixture, ['uninstall']);
    expect(removed.result.status, removed.result.stderr).toBe(0);
    expect(existsSync(removed.installRoot)).toBe(false);
    expect(existsSync(join(removed.stationHome, 'keep-me'))).toBe(true);

    const reinstalled = runInstaller(root, fixture);
    expect(reinstalled.result.status, reinstalled.result.stderr).toBe(0);
    const purged = runInstaller(root, fixture, ['uninstall', '--purge-data']);
    expect(purged.result.status, purged.result.stderr).toBe(0);
    expect(existsSync(purged.stationHome)).toBe(false);
  });

  it('refuses an unrelated launcher during uninstall', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-installer-'));
    roots.push(root);
    const fixture = makeFixtureArchive(root);
    const installed = runInstaller(root, fixture);
    expect(installed.result.status, installed.result.stderr).toBe(0);

    const launcher = join(installed.binDir, 'station');
    rmSync(launcher);
    symlinkSync(
      `${installed.installRoot.replace('/home/', '//home/')}/current/station`,
      launcher,
    );

    const removed = runInstaller(root, fixture, ['uninstall']);
    expect(removed.result.status).not.toBe(0);
    expect(removed.result.stderr).toContain('not owned by the stable install');
    expect(existsSync(removed.installRoot)).toBe(true);
  });

  it('rejects canonical aliases of HOME before uninstall mutates files', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-installer-'));
    roots.push(root);
    const fixture = makeFixtureArchive(root);
    const installed = runInstaller(root, fixture);
    expect(installed.result.status, installed.result.stderr).toBe(0);

    const homeName = installed.home.split('/').at(-1);
    const aliasedHome = `${installed.home}/../${homeName}`;
    const rejected = runInstaller(
      root,
      fixture,
      ['uninstall', '--purge-data'],
      {
        STATION_HOME: aliasedHome,
      },
    );
    expect(rejected.result.status).not.toBe(0);
    expect(rejected.result.stderr).toContain(
      'Station runtime paths are invalid',
    );
    expect(existsSync(installed.installRoot)).toBe(true);
    expect(existsSync(installed.home)).toBe(true);
  });

  it('rejects a data root nested inside the program root', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-installer-'));
    roots.push(root);
    const fixture = makeFixtureArchive(root);
    const installRoot = join(root, 'home', '.station', 'installs', 'stable');
    const nestedData = join(installRoot, 'data');

    const rejected = runInstaller(root, fixture, [], {
      STATION_HOME: nestedData,
    });
    expect(rejected.result.status).not.toBe(0);
    expect(rejected.result.stderr).toContain(
      'Station runtime paths are invalid',
    );
    expect(existsSync(installRoot)).toBe(false);
  });

  it.each([
    [
      'lexical config alias',
      (stationRoot: string) => `${stationRoot}/./config/../config/new`,
    ],
    [
      'lexical cache alias',
      (stationRoot: string) => `${stationRoot}/./cache/../cache/new`,
    ],
    [
      'install container alias',
      (stationRoot: string) => `${stationRoot}/./installs/stable/..`,
    ],
  ])(
    'rejects protected runtime aliases without creating roots: %s',
    (_label, target) => {
      const root = mkdtempSync(
        join(tmpdir(), 'station-installer-containment-'),
      );
      roots.push(root);
      const fixture = makeFixtureArchive(root);
      const stationRoot = join(root, 'home', '.station');
      const rejected = runInstaller(root, fixture, [], {
        STATION_ROOT: stationRoot,
        STATION_HOME: target(stationRoot),
      });
      expect(rejected.result.status).not.toBe(0);
      expect(existsSync(stationRoot)).toBe(false);
    },
  );

  it.each([
    ['config', 'file'],
    ['cache', 'file'],
    ['installs', 'file'],
    ['instances', 'file'],
    ['instances/dev', 'file'],
  ])(
    'rejects an existing non-directory root container before external paths mutate: %s',
    (container) => {
      const root = mkdtempSync(
        join(tmpdir(), 'station-installer-containment-'),
      );
      roots.push(root);
      const fixture = makeFixtureArchive(root);
      const stationRoot = join(root, 'home', '.station');
      const outsideHome = join(root, 'outside-home');
      const outsideInstall = join(root, 'outside-install');
      const blocked = join(stationRoot, container);
      mkdirSync(dirname(blocked), { recursive: true });
      writeFileSync(blocked, 'not a directory');

      const rejected = runInstaller(root, fixture, [], {
        STATION_ROOT: stationRoot,
        STATION_HOME: outsideHome,
        STATION_INSTALL_ROOT: outsideInstall,
      });
      expect(rejected.result.status).not.toBe(0);
      expect(existsSync(outsideHome)).toBe(false);
      expect(existsSync(outsideInstall)).toBe(false);
    },
  );

  it.each(['STATION_HOME', 'STATION_INSTALL_ROOT'] as const)(
    'rejects a selected %s symlink before canonicalizing or creating roots',
    (selected) => {
      const root = mkdtempSync(
        join(tmpdir(), 'station-installer-containment-'),
      );
      roots.push(root);
      const fixture = makeFixtureArchive(root);
      const stationRoot = join(root, 'home', '.station');
      const outside = join(root, 'outside');
      const canary = join(outside, 'keep-me');
      const selectedPath =
        selected === 'STATION_HOME'
          ? join(stationRoot, 'instances', 'stable')
          : join(stationRoot, 'installs', 'stable');
      mkdirSync(dirname(selectedPath), { recursive: true });
      mkdirSync(outside, { recursive: true });
      writeFileSync(canary, 'existing outside data');
      symlinkSync(outside, selectedPath);

      const rejected = runInstaller(root, fixture, [], {
        STATION_ROOT: stationRoot,
        [selected]: selectedPath,
      });
      expect(rejected.result.status).not.toBe(0);
      expect(readFileSync(canary, 'utf8')).toBe('existing outside data');
      expect(
        existsSync(
          join(
            stationRoot,
            'installs',
            'stable',
            '.station-portable-install-root',
          ),
        ),
      ).toBe(false);
      expect(existsSync(join(root, 'home', '.local', 'bin', 'station'))).toBe(
        false,
      );
    },
  );

  it('accepts a whole-root alias and persists canonical runtime paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-installer-root-alias-'));
    roots.push(root);
    const fixture = makeFixtureArchive(root);
    const actualRoot = join(root, 'actual-root');
    const rootAlias = join(root, 'root-alias');
    mkdirSync(actualRoot, { recursive: true });
    symlinkSync(actualRoot, rootAlias);

    const installed = runInstaller(root, fixture, [], {
      STATION_ROOT: rootAlias,
      STATION_HOME: `${rootAlias}/instances/stable`,
      STATION_INSTALL_ROOT: `${rootAlias}/installs/stable`,
    });
    expect(installed.result.status, installed.result.stderr).toBe(0);
    expect(
      JSON.parse(
        readFileSync(
          join(actualRoot, 'installs', 'stable', '.station-release-state.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({
      stationRoot: realpathSync(actualRoot),
      stationHome: realpathSync(join(actualRoot, 'instances', 'stable')),
      installRoot: realpathSync(join(actualRoot, 'installs', 'stable')),
    });
  });

  it('rejects an ancestor alias into a protected runtime subtree before mutation', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-installer-root-alias-'));
    roots.push(root);
    const fixture = makeFixtureArchive(root);
    const stationRoot = join(root, 'station-root');
    const ancestorAlias = join(root, 'root-alias');
    mkdirSync(stationRoot, { recursive: true });
    symlinkSync(stationRoot, ancestorAlias);

    const rejected = runInstaller(root, fixture, [], {
      STATION_ROOT: stationRoot,
      STATION_HOME: `${ancestorAlias}/config/runtime`,
      STATION_INSTALL_ROOT: join(root, 'outside-install'),
    });
    expect(rejected.result.status).not.toBe(0);
    expect(existsSync(join(stationRoot, 'config', 'runtime'))).toBe(false);
    expect(existsSync(join(root, 'outside-install'))).toBe(false);
  });

  it.each([
    ['redirected protected subtree', false],
    ['dangling protected subtree', true],
  ])(
    'fails closed for %s without creating data or install roots',
    (_label, dangling) => {
      const root = mkdtempSync(
        join(tmpdir(), 'station-installer-containment-'),
      );
      roots.push(root);
      const fixture = makeFixtureArchive(root);
      const stationRoot = join(root, 'home', '.station');
      const outside = join(root, dangling ? 'missing-outside' : 'outside');
      mkdirSync(stationRoot, { recursive: true });
      if (!dangling) mkdirSync(outside, { recursive: true });
      symlinkSync(outside, join(stationRoot, 'config'));

      const rejected = runInstaller(root, fixture, [], {
        STATION_ROOT: stationRoot,
        STATION_HOME: join(stationRoot, 'config', 'new'),
      });
      expect(rejected.result.status).not.toBe(0);
      expect(existsSync(join(outside, 'new'))).toBe(false);
      expect(existsSync(join(stationRoot, 'installs', 'stable'))).toBe(false);
    },
  );

  it('freezes relative root, home, and install inputs into one absolute launcher contract', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-installer-relative-'));
    roots.push(root);
    const fixture = makeFixtureArchive(root);
    const invoke = join(root, 'invoke');
    const launchFrom = join(root, 'launch-from');
    const stationRoot = join(root, 'station-root');
    const stationHome = join(stationRoot, 'instances', 'stable');
    const installRoot = join(stationRoot, 'installs', 'stable');
    const envLog = join(root, 'launcher-env.log');
    mkdirSync(invoke, { recursive: true });
    mkdirSync(launchFrom, { recursive: true });

    const installed = runInstaller(root, fixture, [], {
      STATION_TEST_CWD: invoke,
      STATION_ROOT: '../station-root',
      STATION_HOME: '../station-root/instances/stable',
      STATION_INSTALL_ROOT: '../station-root/installs/stable',
      STATION_TEST_ENV_LOG: envLog,
    });
    expect(installed.result.status, installed.result.stderr).toBe(0);

    const launched = spawnSync(join(installed.binDir, 'station'), ['start'], {
      cwd: launchFrom,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, STATION_TEST_ENV_LOG: envLog },
    });
    expect(launched.status, launched.stderr).toBe(0);
    expect(readFileSync(envLog, 'utf8')).toBe(
      `${realpathSync(stationRoot)}|${realpathSync(stationHome)}|${realpathSync(installRoot)}\n`,
    );
  });

  it.each([
    ['padded relative root', '  ../station-root  ', 'station-root'],
    ['whitespace-only root fallback', '   ', 'home/.station'],
  ])(
    'derives canonical default paths from a %s',
    (_label, rootInput, expectedRootSuffix) => {
      const root = mkdtempSync(join(tmpdir(), 'station-installer-root-input-'));
      roots.push(root);
      const fixture = makeFixtureArchive(root);
      const invoke = join(root, 'invoke');
      const expectedRoot = join(
        realpathSync(root),
        ...expectedRootSuffix.split('/'),
      );
      const envLog = join(root, 'launcher-env.log');
      mkdirSync(invoke, { recursive: true });

      const installed = runInstaller(root, fixture, [], {
        STATION_TEST_CWD: invoke,
        STATION_ROOT: rootInput,
        STATION_TEST_USE_DEFAULT_PATHS: '1',
        STATION_HOME: '',
        STATION_INSTALL_ROOT: '',
        STATION_TEST_ENV_LOG: envLog,
      });
      expect(installed.result.status, installed.result.stderr).toBe(0);
      const [canonicalRoot, canonicalHome, canonicalInstall] = readFileSync(
        envLog,
        'utf8',
      )
        .trim()
        .split('|');
      expect(canonicalRoot).toBe(expectedRoot);
      expect(canonicalHome).toBe(join(expectedRoot, 'instances', 'stable'));
      expect(canonicalInstall).toBe(join(expectedRoot, 'installs', 'stable'));
      expect(
        JSON.parse(
          readFileSync(
            join(canonicalInstall, '.station-release-state.json'),
            'utf8',
          ),
        ),
      ).toMatchObject({
        stationRoot: canonicalRoot,
        stationHome: canonicalHome,
        installRoot: canonicalInstall,
      });
    },
  );

  it.each([
    ['root', ''],
    ['config container', 'config'],
    ['config descendant', 'config/profiles'],
    ['instances container', 'instances'],
    ['instances descendant', 'instances/beta'],
    ['cache container', 'cache'],
    ['cache descendant', 'cache/artifacts'],
    ['installs container', 'installs'],
    ['other channel leaf', 'installs/beta'],
  ])('refuses protected shared-root install target: %s', (_label, suffix) => {
    const root = mkdtempSync(join(tmpdir(), 'station-installer-containment-'));
    roots.push(root);
    const fixture = makeFixtureArchive(root);
    const stationRoot = join(root, 'home', '.station');
    const installRoot = suffix ? join(stationRoot, suffix) : stationRoot;
    const rejected = runInstaller(root, fixture, [], {
      STATION_ROOT: stationRoot,
      STATION_HOME: join(root, 'outside-runtime'),
      STATION_INSTALL_ROOT: installRoot,
    });
    expect(rejected.result.status).not.toBe(0);
    expect(existsSync(installRoot)).toBe(false);
    expect(existsSync(join(root, 'outside-runtime'))).toBe(false);
  });

  it('rejects a program root nested inside the data root', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-installer-'));
    roots.push(root);
    const fixture = makeFixtureArchive(root);
    const stationHome = join(root, 'home', '.station');
    const nestedInstall = join(stationHome, 'program');

    const rejected = runInstaller(root, fixture, [], {
      STATION_HOME: stationHome,
      STATION_INSTALL_ROOT: nestedInstall,
    });
    expect(rejected.result.status).not.toBe(0);
    expect(rejected.result.stderr).toContain(
      'Station runtime paths are invalid',
    );
    expect(existsSync(stationHome)).toBe(false);
  });

  it('refuses to claim or delete an unrelated non-empty install root', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-installer-'));
    roots.push(root);
    const fixture = makeFixtureArchive(root);
    const unrelated = join(root, 'home', 'dev');
    mkdirSync(unrelated, { recursive: true });
    writeFileSync(join(unrelated, 'keep-me'), 'user data');

    const rejected = runInstaller(root, fixture, [], {
      STATION_INSTALL_ROOT: unrelated,
    });
    expect(rejected.result.status).not.toBe(0);
    expect(rejected.result.stderr).toContain('not an empty or installer-owned');
    expect(readFileSync(join(unrelated, 'keep-me'), 'utf8')).toBe('user data');
  });

  it('refuses purge for a pre-existing unmarked data directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-installer-'));
    roots.push(root);
    const fixture = makeFixtureArchive(root);
    const existingData = join(root, 'home', 'existing-station-data');
    mkdirSync(existingData, { recursive: true });
    writeFileSync(join(existingData, 'keep-me'), 'existing data');
    const installed = runInstaller(root, fixture, [], {
      STATION_HOME: existingData,
    });
    expect(installed.result.status, installed.result.stderr).toBe(0);

    const rejected = runInstaller(
      root,
      fixture,
      ['uninstall', '--purge-data'],
      {
        STATION_HOME: existingData,
      },
    );
    expect(rejected.result.status).not.toBe(0);
    expect(rejected.result.stderr).toContain('not owned by this installer');
    expect(readFileSync(join(existingData, 'keep-me'), 'utf8')).toBe(
      'existing data',
    );
    expect(existsSync(installed.installRoot)).toBe(true);
  });

  it('fails closed when the installed Station cannot be stopped', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-installer-'));
    roots.push(root);
    const fixture = makeFixtureArchive(root, 'a', false, true);
    const installed = runInstaller(root, fixture);
    expect(installed.result.status, installed.result.stderr).toBe(0);

    const rejected = runInstaller(root, fixture, ['uninstall']);
    expect(rejected.result.status).not.toBe(0);
    expect(rejected.result.stderr).toContain('no files were removed');
    expect(existsSync(installed.installRoot)).toBe(true);
    expect(existsSync(join(installed.binDir, 'station'))).toBe(true);
  });
});
