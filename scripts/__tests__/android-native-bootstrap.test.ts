import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  activityWithNativeCredentialBootstrap,
  androidNamespace,
  applyAndroidNativeBootstrap,
  manifestWithCameraPermission,
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

  it.each([
    '.github/workflows/build-android.yml',
    '.github/workflows/release.yml',
    '.github/workflows/nightly-native-stage.yml',
    'ops/nightly/install-android.zsh',
  ])(
    'applies the bootstrap after init and before build in %s',
    (workflowPath) => {
      const workflow = readFileSync(workflowPath, 'utf8');
      const init = workflow.indexOf('tauri android init');
      const bootstrap = workflow.indexOf(
        'node scripts/apply-android-native-bootstrap.mjs',
      );
      const build = workflow.indexOf('tauri android build');
      expect(init).toBeGreaterThanOrEqual(0);
      expect(bootstrap).toBeGreaterThan(init);
      expect(build).toBeGreaterThan(bootstrap);
    },
  );

  it.each(['build:android', 'build:android:release', 'build:android:arm64'])(
    'keeps the namespace bootstrap ahead of %s',
    (scriptName) => {
      const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
        scripts: Record<string, string>;
      };
      const command = packageJson.scripts[scriptName];
      expect(
        command.indexOf('apply-android-native-bootstrap.mjs'),
      ).toBeGreaterThanOrEqual(0);
      expect(
        command.indexOf('apply-android-native-bootstrap.mjs'),
      ).toBeLessThan(command.indexOf('tauri android build'));
    },
  );
});

describe('camera manifest restoration', () => {
  it('preserves the checked-in manifest without duplicating permission', () => {
    const source = readFileSync(
      'src-desktop/gen/android/app/src/main/AndroidManifest.xml',
      'utf8',
    );
    expect(manifestWithCameraPermission(source)).toBe(source);
  });
  it('refuses a restricted camera permission rather than reporting a repair', () => {
    expect(() =>
      manifestWithCameraPermission(
        '<manifest><uses-permission android:name="android.permission.CAMERA" android:maxSdkVersion="28" /><application /></manifest>',
      ),
    ).toThrow(/restricted/);
  });
});
