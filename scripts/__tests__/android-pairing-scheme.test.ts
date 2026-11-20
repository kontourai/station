import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { load } from 'js-yaml';
import { expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  applyAndroidPairingScheme,
  manifestWithAndroidPairingScheme,
} from '../apply-android-pairing-scheme.mjs';
import {
  FIXTURE_TEST_TIMEOUT_MS,
  runBoundedFixture,
} from './helpers/bounded-fixture-process.mjs';

const manifest = `<manifest><application><activity android:name=".MainActivity" android:exported="true"><intent-filter><action android:name="android.intent.action.MAIN"/></intent-filter></activity><provider android:name="KeepMe"/></application></manifest>`;

test('restoring the generated manifest while Cargo remains cached restores the association', () => {
  const root = mkdtempSync(join(tmpdir(), 'station-pairing-manifest-'));
  const path = join(
    root,
    'src-desktop/gen/android/app/src/main/AndroidManifest.xml',
  );
  try {
    mkdirSync(dirname(path), { recursive: true });
    for (let build = 0; build < 2; build++) {
      writeFileSync(path, manifest);
      applyAndroidPairingScheme('dev', { root });
      expect(readFileSync(path, 'utf8')).toContain(
        'android:scheme="station-dev-instance"',
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([
  ['.github/workflows/build-android.yml', 'dev'],
  ['.github/workflows/nightly-native-stage.yml', 'nightly'],
  ['ops/nightly/install-android.zsh', 'dev'],
])(
  'the %s build registers its scheme after generation and before compilation',
  (path, channel) => {
    const source = readFileSync(path, 'utf8');
    const apply = source.indexOf(
      `node scripts/apply-android-pairing-scheme.mjs ${channel}`,
    );
    expect(apply).toBeGreaterThan(source.indexOf('tauri android init'));
    expect(source.indexOf('tauri android build')).toBeGreaterThan(apply);
  },
);

const repository = resolve(import.meta.dirname, '../..');
const makeTempDir = trackTempDirs();
const androidSteps = (
  load(
    readFileSync(join(repository, '.github/workflows/release.yml'), 'utf8'),
  ) as {
    jobs: { android: { steps: Array<{ run?: string }> } };
  }
).jobs.android.steps;
const identityIndex = androidSteps.findIndex((step) =>
  step.run?.includes('scripts/apply-android-channel-icons.mjs'),
);

function releaseFixture(source = manifest) {
  const root = makeTempDir('station-release-pairing-');
  const write = (path: string, bytes: string) => {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  };
  // Copy the CLI owners so their import-relative roots are isolated as in CI.
  for (const path of [
    'scripts/apply-android-channel-icons.mjs',
    'scripts/apply-android-pairing-scheme.mjs',
    'scripts/channel-platform-matrix.mjs',
    'scripts/lib/android-themed-icon.mjs',
    'scripts/lib/station-icon.mjs',
    'scripts/lib/station-icon-geometry.mjs',
    'scripts/lib/module-entry.mjs',
    'config/channel-platform-matrix.json',
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(repository, path), join(root, path));
  }
  // Distinct byte fixtures detect wrong-channel copying; no image rendering is claimed.
  for (const channel of ['stable', 'dev', 'nightly']) {
    write(
      `src-desktop/icons/${channel}/android/mipmap-mdpi/ic_launcher.png`,
      `${channel} launcher`,
    );
    write(
      `src-ui/public/favicon${channel === 'stable' ? '' : `-${channel}`}.png`,
      `${channel} startup`,
    );
  }
  const manifestPath =
    'src-desktop/gen/android/app/src/main/AndroidManifest.xml';
  write(manifestPath, source);
  return { root, manifestPath: join(root, manifestPath) };
}

function runReleaseIdentity(root: string, tag: string) {
  const step = androidSteps[identityIndex];
  if (!step?.run) throw new Error('Missing Android release identity step');
  return runBoundedFixture(
    'bash',
    ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step.run],
    {
      cwd: root,
      env: { ...process.env, RELEASE_TAG: tag },
    },
  );
}

test('release identity is applied after Android generation and before compilation', () => {
  const init = androidSteps.findIndex((step) =>
    /\btauri android init\b/.test(step.run ?? ''),
  );
  const compile = androidSteps.findIndex((step) =>
    /\btauri android build\b/.test(step.run ?? ''),
  );
  expect(init).toBeGreaterThanOrEqual(0);
  expect(identityIndex).toBeGreaterThan(init);
  expect(compile).toBeGreaterThan(identityIndex);
});

test.each(['v0.2.0-rc.1', 'v0.2.0'])(
  '%s release step writes one Stable pairing association and Stable launcher identity',
  { timeout: FIXTURE_TEST_TIMEOUT_MS },
  async (tag) => {
    const { root, manifestPath } = releaseFixture();
    const result = await runReleaseIdentity(root, tag);
    expect(result.status, result.stderr).toBe(0);
    const once = readFileSync(manifestPath, 'utf8');
    expect(once.match(/android:scheme="[^"]+"/g)).toEqual([
      'android:scheme="station-stable"',
    ]);
    expect(once).toContain('android.intent.action.MAIN');
    expect(once).toContain('android:name="KeepMe"');
    for (const sourceSet of ['main', 'debug']) {
      const resources = join(
        root,
        'src-desktop/gen/android/app/src',
        sourceSet,
        'res',
      );
      expect(
        readFileSync(join(resources, 'mipmap-mdpi/ic_launcher.png'), 'utf8'),
      ).toBe('stable launcher');
      expect(
        readFileSync(
          join(resources, 'drawable/station_startup_logo.png'),
          'utf8',
        ),
      ).toBe('stable startup');
      expect(
        readFileSync(join(resources, 'values/strings.xml'), 'utf8'),
      ).toContain('<string name="app_name">Station</string>');
    }
    const repeat = await runReleaseIdentity(root, tag);
    expect(repeat.status, repeat.stderr).toBe(0);
    expect(readFileSync(manifestPath, 'utf8')).toBe(once);
  },
);

test.each([
  [
    'ambiguous activities',
    manifest + manifest,
    'Expected one generated Android MainActivity.',
  ],
  [
    'unmanaged association',
    manifest.replace(
      '</activity>',
      '<intent-filter><data android:scheme="station-stable"/></intent-filter></activity>',
    ),
    'Unmanaged Station pairing intent filter',
  ],
])(
  'release identity step refuses %s without changing the manifest',
  { timeout: FIXTURE_TEST_TIMEOUT_MS },
  async (_label, source, error) => {
    const { root, manifestPath } = releaseFixture(source);
    const result = await runReleaseIdentity(root, 'v0.2.0-rc.1');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(error);
    expect(readFileSync(manifestPath, 'utf8')).toBe(source);
  },
);

test.each([
  ['dev', 'station-dev-instance'],
  ['stable', 'station-stable'],
  ['nightly', 'station-nightly'],
])(
  'regenerated %s projects receive exactly their pairing association',
  (channel, scheme) => {
    const once = manifestWithAndroidPairingScheme(manifest, channel);
    expect(once).toContain(`android:scheme="${scheme}"`);
    expect(once).toContain('android.intent.action.MAIN');
    expect(once).toContain('android:name="KeepMe"');
    expect(manifestWithAndroidPairingScheme(once, channel)).toBe(once);
    expect(once.match(/android:scheme=/g)).toHaveLength(1);
  },
);

test('a stale plugin-generated stable association is replaced for Nightly', () => {
  const stale = manifestWithAndroidPairingScheme(manifest, 'stable');
  const nightly = manifestWithAndroidPairingScheme(stale, 'nightly');
  expect(nightly).toContain('station-nightly');
  expect(nightly).not.toContain('station-stable');
});

test('unknown channels, ambiguous activities, and unmanaged associations are rejected', () => {
  expect(() => manifestWithAndroidPairingScheme(manifest, 'unknown')).toThrow();
  expect(() => manifestWithAndroidPairingScheme(manifest, 'beta')).toThrow();
  expect(() =>
    manifestWithAndroidPairingScheme(manifest + manifest, 'dev'),
  ).toThrow();
  expect(() =>
    manifestWithAndroidPairingScheme(
      manifest.replace(
        '</activity>',
        '<intent-filter><data android:scheme="station-stable"/></intent-filter></activity>',
      ),
      'dev',
    ),
  ).toThrow();
});
