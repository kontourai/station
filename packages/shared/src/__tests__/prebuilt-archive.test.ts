import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';
import {
  compareStationReleaseVersions,
  packagedInstallerCommand,
  packagedReleaseVersion,
  readArchiveInstallState,
  validatePackagedReleaseManifest,
} from '../prebuilt-archive.js';

const makeTempDir = trackTempDirs();

// The launcher is a standalone file (it must load with no Station version
// present), so its release order is a copy; the cases below pin the two
// together. A plain ESM file with no types, loaded by path.
const LAUNCHER =
  '../../../../packaging/portable-server/bin/station-launcher.mjs';
const { compareVersions: launcherCompareVersions } = (await import(
  LAUNCHER
)) as { compareVersions: (left: string, right: string) => number | null };

describe('compareStationReleaseVersions', () => {
  const cases: Array<[string, string, -1 | 0 | 1 | null]> = [
    ['1.2.3', '1.2.3', 0],
    ['1.2.4', '1.2.3', 1],
    ['1.10.0', '1.9.9', 1],
    ['2.0.0', '10.0.0', -1],
    ['1.2.3', '1.2.3-preview.9', 1],
    ['1.2.3-preview.10', '1.2.3-preview.9', 1],
    ['1.2.3-preview.1', '1.2.3-preview.2', -1],
    ['1.2.4-nightly.1', '1.2.3-nightly.99', 1],
    ['1.2.3-preview.1', '1.2.3-nightly.1', null],
    ['1.2.3', 'v1.2.3', null],
    ['1.2', '1.2.0', null],
    ['01.2.3', '1.2.3', null],
    ['1.2.3-preview.0', '1.2.3-preview.1', null],
    ['99999999999999999999.0.0', '99999999999999999998.0.0', 1],
  ];
  test.each(cases)(
    '%s against %s is %s, as the launcher orders it',
    (a, b, order) => {
      expect(compareStationReleaseVersions(a, b)).toBe(order);
      expect(launcherCompareVersions(a, b)).toBe(order);
    },
  );
});

describe('readArchiveInstallState', () => {
  function state(value: unknown): string {
    const root = makeTempDir('station-install-state-');
    writeFileSync(
      join(root, '.station-release-state.json'),
      typeof value === 'string' ? value : JSON.stringify(value),
    );
    return root;
  }
  const base = {
    channel: 'nightly',
    releaseChannel: 'nightly',
    installRoot: '/i',
    stationRoot: '/r',
    stationHome: '/r/instances/nightly',
  };

  test('reads the ring and, from schema 4, the public manifest URL', () => {
    expect(
      readArchiveInstallState(
        state({
          schemaVersion: 4,
          ...base,
          manifestUrl: 'https://m.test/p.json',
        }),
      ),
    ).toEqual({
      releaseChannel: 'nightly',
      manifestUrl: 'https://m.test/p.json',
      stationRoot: '/r',
    });
    expect(
      readArchiveInstallState(
        state({ schemaVersion: 4, ...base, manifestUrl: null }),
      ),
    ).toEqual({
      releaseChannel: 'nightly',
      manifestUrl: null,
      stationRoot: '/r',
    });
    expect(
      readArchiveInstallState(state({ schemaVersion: 3, ...base })),
    ).toEqual({
      releaseChannel: 'nightly',
      manifestUrl: null,
      stationRoot: '/r',
    });
  });

  test.each([
    ['unparseable', '{'],
    ['another schema', { schemaVersion: 5, ...base, manifestUrl: null }],
    ['an unknown ring', { schemaVersion: 4, ...base, releaseChannel: 'beta' }],
    [
      'a retired Beta state',
      {
        schemaVersion: 4,
        ...base,
        channel: 'beta',
        releaseChannel: 'preview',
        stationHome: '/r/instances/beta',
      },
    ],
    [
      'a ring its runtime channel does not match',
      { schemaVersion: 4, ...base, channel: 'stable' },
    ],
    ['a non-string manifest', { schemaVersion: 4, ...base, manifestUrl: 7 }],
  ])('refuses %s', (_name, value) => {
    expect(readArchiveInstallState(state(value))).toBeNull();
  });

  test('a missing state is null', () => {
    expect(
      readArchiveInstallState(makeTempDir('station-install-state-')),
    ).toBeNull();
  });
});

describe('packagedInstallerCommand', () => {
  test("runs the version's install.sh with sh off Windows", () => {
    expect(packagedInstallerCommand('/i/versions/1.0.0', 'linux')).toEqual({
      command: 'sh',
      args: ['./install.sh', 'install'],
      file: join('/i/versions/1.0.0', 'install.sh'),
    });
  });

  test("runs the version's install.ps1 with the system Windows PowerShell on Windows (#2675 W2)", () => {
    const version = join('/i', 'versions', '1.0.0');
    expect(
      packagedInstallerCommand(version, 'win32', {
        SystemRoot: 'C:\\Windows',
        // A PATH never selects the PowerShell that runs the installer.
        PATH: 'C:\\elsewhere',
      }),
    ).toEqual({
      command: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        join(version, 'install.ps1'),
        'install',
      ],
      file: join(version, 'install.ps1'),
    });
  });
});

describe('packaged provenance schemas', () => {
  const identity = {
    sha: 'a'.repeat(40),
    createdAt: '2026-11-15T12:00:00.000Z',
    channel: 'stable',
    releaseChannel: 'stable',
    prerelease: false,
  };
  const current = { schemaVersion: 3, ...identity, version: '1.2.3' };
  test('reads new version-bound provenance and legacy exact-tag provenance', () => {
    const legacy = { schemaVersion: 2, ...identity, ref: 'v1.2.3' };
    expect(validatePackagedReleaseManifest(current)).toEqual(current);
    expect(validatePackagedReleaseManifest(legacy)).toEqual(legacy);
    expect(packagedReleaseVersion({ version: '1.2.3' })).toBe('1.2.3');
    expect(packagedReleaseVersion({ ref: 'v1.2.3' })).toBe('1.2.3');
    const nightly = {
      ...current,
      version: '1.2.3-nightly.7',
      channel: 'nightly',
      releaseChannel: 'nightly',
      prerelease: true,
    };
    expect(validatePackagedReleaseManifest(nightly)).toEqual(nightly);
  });
  test.each([
    ['origin tag', { ref: 'v1.2.3-rc.1' }],
    ['wrong schema', { schemaVersion: 4 }],
    ['wrong SHA', { sha: 'abc' }],
    ['RC suffix in product version', { version: '1.2.3-rc.1' }],
    ['wrong ring version', { version: '1.2.3-nightly.7' }],
    ['invalid version type', { version: 123 }],
    ['oversized version', { version: `${'1'.repeat(130)}.0.0` }],
    ['wrong runtime channel', { channel: 'nightly' }],
    ['wrong prerelease claim', { prerelease: true }],
    ['invalid timestamp', { createdAt: 'not-a-time' }],
    [
      'retired preview provenance',
      {
        version: '1.2.3-preview.1',
        channel: 'beta',
        releaseChannel: 'preview',
        prerelease: true,
      },
    ],
  ])('rejects v3 %s', (_label, overrides) => {
    expect(
      validatePackagedReleaseManifest({ ...current, ...overrides }),
    ).toBeNull();
  });
});
