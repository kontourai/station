import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  activityWithNativeCredentialBootstrap,
  androidNamespace,
  applyAndroidNativeBootstrap,
  manifestWithMediaPermissions,
} from '../apply-android-native-bootstrap.mjs';

function fixture(namespace: string, activity: string) {
  const root = mkdtempSync(join(tmpdir(), 'station-android-bootstrap-'));
  const app = join(root, 'src-desktop', 'gen', 'android', 'app');
  const activityPath = join(
    app,
    'src',
    'main',
    'java',
    ...namespace.split('.'),
    'MainActivity.kt',
  );
  mkdirSync(dirname(activityPath), { recursive: true });
  writeFileSync(
    join(app, 'build.gradle.kts'),
    `android { namespace = "${namespace}" }`,
  );
  writeFileSync(
    join(app, 'src', 'main', 'AndroidManifest.xml'),
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><uses-permission android:name="android.permission.INTERNET" /><application /></manifest>',
  );
  writeFileSync(activityPath, activity);
  return { root, activityPath };
}

describe('Android native credential bootstrap', () => {
  it.each([
    ['stable', 'io.kontourai.station'],
    ['dev', 'io.kontourai.station'],
    ['beta', 'io.kontourai.station.beta'],
    ['nightly', 'io.kontourai.station.nightly'],
  ])(
    'initializes the generated %s namespace before Tauri starts',
    (_channel, namespace) => {
      const { root, activityPath } = fixture(
        namespace,
        `package ${namespace}\n\nclass MainActivity : TauriActivity()\n`,
      );
      const result = applyAndroidNativeBootstrap({ root });
      const activity = readFileSync(activityPath, 'utf8');
      const bridge = readFileSync(result.bridgePath, 'utf8');

      const manifestPath = join(
        root,
        'src-desktop/gen/android/app/src/main/AndroidManifest.xml',
      );
      const manifest = readFileSync(manifestPath, 'utf8');
      expect(manifest).toContain(
        '<uses-permission android:name="android.permission.CAMERA" />',
      );
      expect(manifest).toContain(
        'android:name="android.hardware.camera.any" android:required="false"',
      );
      expect(manifest).toContain('android:allowBackup="false"');
      expect(manifest).toContain('android:fullBackupContent="false"');
      expect(manifest).toContain(
        'android:dataExtractionRules="@xml/data_extraction_rules"',
      );
      expect(
        readFileSync(
          join(
            root,
            'src-desktop/gen/android/app/src/main/res/xml/data_extraction_rules.xml',
          ),
          'utf8',
        ),
      ).toBe(
        readFileSync(
          'scripts/templates/android/data_extraction_rules.xml',
          'utf8',
        ),
      );
      expect(manifest).toContain('android.permission.RECORD_AUDIO');
      expect(manifest).toContain('android.permission.MODIFY_AUDIO_SETTINGS');
      expect(manifest).toContain(
        'android:name="android.hardware.microphone" android:required="false"',
      );
      applyAndroidNativeBootstrap({ root });
      expect(readFileSync(manifestPath, 'utf8')).toBe(manifest);
      expect(result.namespace).toBe(namespace);
      expect(activity).toContain('import io.crates.keyring.Keyring');
      expect(
        activity.indexOf('Keyring.initializeNdkContext(applicationContext)'),
      ).toBeLessThan(activity.indexOf('super.onCreate(savedInstanceState)'));
      expect(bridge).toContain('System.loadLibrary("station_ai_lib")');
    },
  );

  it('preserves a custom activity and applies the initializer once', () => {
    const source = `package io.kontourai.station.beta

import android.os.Bundle

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }
}
`;
    const once = activityWithNativeCredentialBootstrap(
      source,
      'io.kontourai.station.beta',
    );
    const twice = activityWithNativeCredentialBootstrap(
      once,
      'io.kontourai.station.beta',
    );
    expect(twice).toBe(once);
    expect(once.match(/initializeNdkContext/g)).toHaveLength(1);
    expect(once).toContain('enableEdgeToEdge()');
  });

  it('rejects ambiguous or malformed generated namespaces', () => {
    expect(() =>
      androidNamespace('namespace = "io.kontourai.station"\nnamespace = "x.y"'),
    ).toThrow(/exactly one/);
    expect(() =>
      androidNamespace('namespace = "io.kontourai.station-beta"'),
    ).toThrow(/Invalid/);
  });

  // The CI workflows and package scripts are ordered by
  // android-channel-release-generation.test.ts; the nightly install script
  // has no other owner.
  it('applies the bootstrap after init and before build in the nightly install script', () => {
    const script = readFileSync('ops/nightly/install-android.zsh', 'utf8');
    const init = script.indexOf('tauri android init');
    const bootstrap = script.indexOf(
      'node scripts/apply-android-native-bootstrap.mjs',
    );
    const build = script.indexOf('tauri android build');
    expect(init).toBeGreaterThanOrEqual(0);
    expect(bootstrap).toBeGreaterThan(init);
    expect(build).toBeGreaterThan(bootstrap);
  });
});

describe('camera manifest restoration', () => {
  it('preserves the checked-in manifest without duplicating permission', () => {
    const source = readFileSync(
      'src-desktop/gen/android/app/src/main/AndroidManifest.xml',
      'utf8',
    );
    expect(manifestWithMediaPermissions(source)).toBe(source);
  });
  it('refuses a restricted camera permission rather than reporting a repair', () => {
    expect(() =>
      manifestWithMediaPermissions(
        '<manifest><uses-permission android:name="android.permission.CAMERA" android:maxSdkVersion="28" /><application /></manifest>',
      ),
    ).toThrow(/restricted/);
  });
});

it('keeps generated Android extraction rules aligned with the reviewed seed', () => {
  expect(
    readFileSync('scripts/templates/android/data_extraction_rules.xml', 'utf8'),
  ).toBe(
    readFileSync(
      'src-desktop/gen/android/app/src/main/res/xml/data_extraction_rules.xml',
      'utf8',
    ),
  );
});
