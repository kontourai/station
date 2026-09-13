import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import {
  applyAndroidPairingScheme,
  manifestWithAndroidPairingScheme,
} from '../apply-android-pairing-scheme.mjs';

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

test('release scheme selection shares the channel-selection shell step', () => {
  const source = readFileSync('.github/workflows/release.yml', 'utf8');
  const step = source
    .split('      - name: ')
    .find((value) => value.startsWith('Apply the channel launcher icon'))!;
  expect(step).toContain('icon_channel=stable');
  expect(step).toContain('icon_channel=beta');
  expect(step).toContain(
    'node scripts/apply-android-pairing-scheme.mjs "$icon_channel"',
  );
});

test.each([
  ['dev', 'station-dev-instance'],
  ['stable', 'station-stable'],
  ['beta', 'station-beta'],
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
