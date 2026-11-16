import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  activityWithShareIntentBuffer,
  activityWithTauriOnCreate,
  androidNamespace,
  applyAndroidNativeBootstrap,
  manifestWithImageShareTarget,
  manifestWithMediaPermissions,
} from '../apply-android-native-bootstrap.mjs';

// The shape `tauri android init` writes: one launcher MainActivity.
const GENERATED_MANIFEST = `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />
    <application>
        <activity
            android:launchMode="singleTask"
            android:name=".MainActivity"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>`;

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
    `android { namespace = "${namespace}"
 buildTypes { getByName("release") { isMinifyEnabled = true } }
}`,
  );
  writeFileSync(
    join(app, 'src', 'main', 'AndroidManifest.xml'),
    GENERATED_MANIFEST,
  );
  writeFileSync(activityPath, activity);
  return { root, activityPath };
}

describe('Android native bootstrap', () => {
  it.each([
    ['stable', 'io.kontourai.station'],
    ['dev', 'io.kontourai.station'],
    ['onboarding verification', 'io.kontourai.station.onboarding'],
    ['beta', 'io.kontourai.station.beta'],
    ['nightly', 'io.kontourai.station.nightly'],
  ])(
    'gives the generated %s namespace an onCreate hook without initializing ndk_context',
    (_channel, namespace) => {
      const { root, activityPath } = fixture(
        namespace,
        `package ${namespace}\n\nclass MainActivity : TauriActivity()\n`,
      );
      const bridgePath = join(
        root,
        'src-desktop/gen/android/app/src/main/java/io/crates/keyring/Keyring.kt',
      );
      mkdirSync(dirname(bridgePath), { recursive: true });
      writeFileSync(bridgePath, 'package io.crates.keyring\n');
      const result = applyAndroidNativeBootstrap({ root });
      const activity = readFileSync(activityPath, 'utf8');

      const manifestPath = join(
        root,
        'src-desktop/gen/android/app/src/main/AndroidManifest.xml',
      );
      const manifest = readFileSync(manifestPath, 'utf8');
      expect(manifest).toContain('android.permission.ACCESS_NETWORK_STATE');
      expect(
        readFileSync(
          join(root, 'src-desktop/gen/android/app/build.gradle.kts'),
          'utf8',
        ),
      ).toContain('isShrinkResources = true');
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
      expect(manifest).toContain(
        '<action android:name="android.intent.action.SEND_MULTIPLE" />',
      );
      applyAndroidNativeBootstrap({ root });
      expect(readFileSync(manifestPath, 'utf8')).toBe(manifest);
      expect(result.namespace).toBe(namespace);
      expect(activity).not.toContain('initializeNdkContext');
      expect(activity).not.toContain('io.crates.keyring');
      expect(activity).toContain(
        'override fun onCreate(savedInstanceState: Bundle?)',
      );
      expect(activity).toContain('super.onCreate(savedInstanceState)');
      expectShareBuffer(activity);
      expect(readFileSync(activityPath, 'utf8')).toBe(activity);
      expect(existsSync(bridgePath)).toBe(false);
    },
  );

  it('removes a legacy ndk_context initializer and keeps custom onCreate work', () => {
    const source = `package io.kontourai.station.beta

import android.os.Bundle
import io.crates.keyring.Keyring

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    Keyring.initializeNdkContext(applicationContext)
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }
}
`;
    const once = activityWithTauriOnCreate(source, 'io.kontourai.station.beta');
    expect(activityWithTauriOnCreate(once, 'io.kontourai.station.beta')).toBe(
      once,
    );
    expect(once).not.toContain('initializeNdkContext');
    expect(once).not.toContain('io.crates.keyring');
    expect(once).toContain('enableEdgeToEdge()');
    expect(once).toContain('super.onCreate(savedInstanceState)');
  });

  it('refuses an ndk_context initializer it does not recognize', () => {
    expect(() =>
      activityWithTauriOnCreate(
        `package io.kontourai.station\n\nclass MainActivity : TauriActivity() {\n  override fun onCreate(savedInstanceState: Bundle?) {\n    Other.initializeNdkContext(this)\n    super.onCreate(savedInstanceState)\n  }\n}\n`,
        'io.kontourai.station',
      ),
    ).toThrow(/tao owns/);
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

describe('image share target', () => {
  const sendFilter = (manifest: string) =>
    /<activity\b[^>]*android:name="\.MainActivity"[\s\S]*?<intent-filter>\s*<action android:name="android\.intent\.action\.SEND" \/>\s*<action android:name="android\.intent\.action\.SEND_MULTIPLE" \/>\s*<category android:name="android\.intent\.category\.DEFAULT" \/>\s*<data android:mimeType="image\/\*" \/>\s*<\/intent-filter>[\s\S]*?<\/activity>/.test(
      manifest,
    );

  it('adds one image SEND/SEND_MULTIPLE filter inside MainActivity, once', () => {
    expect(sendFilter(GENERATED_MANIFEST)).toBe(false);
    const once = manifestWithImageShareTarget(GENERATED_MANIFEST);
    expect(sendFilter(once)).toBe(true);
    expect(manifestWithImageShareTarget(once)).toBe(once);
    expect(once.match(/action\.SEND"/g)).toHaveLength(1);
  });

  it('keeps the checked-in manifest as the bootstrap writes it', () => {
    const source = readFileSync(
      'src-desktop/gen/android/app/src/main/AndroidManifest.xml',
      'utf8',
    );
    expect(sendFilter(source)).toBe(true);
    expect(manifestWithImageShareTarget(source)).toBe(source);
  });

  it('refuses an unmanaged share filter instead of adding a second one', () => {
    const unmanaged = GENERATED_MANIFEST.replace(
      '</activity>',
      '<intent-filter><action android:name="android.intent.action.SEND" /></intent-filter></activity>',
    );
    expect(() => manifestWithImageShareTarget(unmanaged)).toThrow(/Unmanaged/);
  });

  it('refuses a manifest without exactly one MainActivity', () => {
    expect(() =>
      manifestWithImageShareTarget('<manifest><application /></manifest>'),
    ).toThrow(/one generated Android MainActivity/);
  });
});

/** The override records the intent and buffers it before Tauri forwards it. */
function expectShareBuffer(activity: string) {
  expect(activity).toMatch(/^import android\.content\.Intent$/m);
  expect(activity).toMatch(
    /^import io\.kontourai\.station\.mediaintake\.ShareIntentBuffer$/m,
  );
  const body =
    /override fun onNewIntent\(intent: Intent\) \{\n\s*setIntent\(intent\)\n\s*ShareIntentBuffer\.offer\(intent\)\n\s*super\.onNewIntent\(intent\)\n\s*\}/;
  expect(activity).toMatch(body);
  expect(activity.match(/override fun onNewIntent/g)).toHaveLength(1);
}

describe('MainActivity share buffer', () => {
  const generated =
    'package io.kontourai.station.beta\n\nimport android.os.Bundle\n\nclass MainActivity : TauriActivity() {\n  override fun onCreate(savedInstanceState: Bundle?) {\n    super.onCreate(savedInstanceState)\n  }\n}\n';

  it('adds one onNewIntent that buffers before Tauri forwards, once', () => {
    const once = activityWithShareIntentBuffer(
      generated,
      'io.kontourai.station.beta',
    );
    expectShareBuffer(once);
    expect(
      activityWithShareIntentBuffer(once, 'io.kontourai.station.beta'),
    ).toBe(once);
  });

  it('keeps the checked-in MainActivity as the bootstrap writes it', () => {
    const source = readFileSync(
      'src-desktop/gen/android/app/src/main/java/io/kontourai/station/MainActivity.kt',
      'utf8',
    );
    expectShareBuffer(source);
    expect(activityWithShareIntentBuffer(source, 'io.kontourai.station')).toBe(
      source,
    );
  });

  it('refuses an unmanaged onNewIntent rather than adding a second', () => {
    const custom = generated.replace(
      '\n}\n',
      '\n  override fun onNewIntent(intent: Intent) {\n    super.onNewIntent(intent)\n  }\n}\n',
    );
    expect(() =>
      activityWithShareIntentBuffer(custom, 'io.kontourai.station.beta'),
    ).toThrow(/Unmanaged MainActivity onNewIntent/);
  });
});
