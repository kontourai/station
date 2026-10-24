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
import { applyAndroidNativeBootstrap } from '../apply-android-native-bootstrap.mjs';
import { activityWithAndroidInsets } from '../lib/android-window-insets.mjs';

test.each([
  'io.kontourai.station',
  'io.kontourai.station.beta',
  'io.kontourai.station.nightly',
])(
  'the native build bootstrap restores inset delivery after regenerating %s',
  (namespace) => {
    const root = mkdtempSync(join(tmpdir(), 'station-insets-'));
    try {
      const app = join(root, 'src-desktop/gen/android/app');
      const activity = join(
        app,
        'src/main/java',
        ...namespace.split('.'),
        'MainActivity.kt',
      );
      mkdirSync(dirname(activity), { recursive: true });
      writeFileSync(
        join(app, 'build.gradle.kts'),
        `android {
  namespace = "${namespace}"
  buildTypes { getByName("release") { isMinifyEnabled = true } }
}`,
      );
      // The shared bootstrap also restores permissions after Android init.
      // Keep this fixture shaped like a generated project so inset coverage
      // exercises the real caller without silently skipping its manifest step.
      writeFileSync(
        join(app, 'src/main/AndroidManifest.xml'),
        '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application /></manifest>',
      );
      for (let build = 0; build < 2; build++) {
        writeFileSync(
          activity,
          `package ${namespace}\n\nclass MainActivity : TauriActivity()\n`,
        );
        applyAndroidNativeBootstrap({ root });
        expect(readFileSync(activity, 'utf8')).toContain(
          'StationAndroidInsetsBridge.install(webView, this)',
        );
        expect(
          readFileSync(join(app, 'src/main/AndroidManifest.xml'), 'utf8').match(
            /android.permission.CAMERA/g,
          ),
        ).toHaveLength(1);
        const bridge = readFileSync(
          join(dirname(activity), 'StationAndroidInsetsBridge.kt'),
          'utf8',
        );
        expect(bridge).toContain(`package ${namespace}\n`);
        expect(bridge).toContain('WindowInsetsCompat.Type.ime()');
        for (const callback of ['onAvailable', 'onLost']) {
          const body = bridge.match(
            new RegExp(`override fun ${callback}\\([^)]*\\) \\{([^}]+)\\}`),
          )?.[1];
          expect(body, callback).toContain('NativeHttpNetwork.changed()');
        }
        expect(
          bridge.match(/override fun onCapabilitiesChanged[^\n]+/)?.[0],
        ).not.toContain('NativeHttpNetwork');
        expect(bridge).toContain('.put("visibleHeight",');
        expect(bridge).not.toContain('__STATION_NAMESPACE__');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('migrates the old system-bar bridge once while preserving native initialization', () => {
  const legacy = readFileSync(
    'scripts/__tests__/fixtures/android-legacy-MainActivity.kt',
    'utf8',
  );
  const next = activityWithAndroidInsets(legacy);
  expect(next).not.toContain('safeAreaJson');
  expect(next).not.toContain('SafeAreaBridge()');
  expect(next).toContain('Keyring.initializeNdkContext(applicationContext)');
  expect(next).toContain('enableEdgeToEdge()');
  expect(activityWithAndroidInsets(next)).toBe(next);
  expect(() =>
    activityWithAndroidInsets(
      legacy.replace('ViewCompat.requestApplyInsets(webView)', 'customWork()'),
    ),
  ).toThrow('Unrecognized legacy');
});

test('preserves unrelated WebView customization and refuses ambiguous callbacks', () => {
  const activity = `package test.station\nclass MainActivity : TauriActivity() {\n  override fun onWebViewCreate(webView: WebView) {\n    customSetup(webView)\n  }\n}`;
  const next = activityWithAndroidInsets(activity);
  expect(next).toContain('customSetup(webView)');
  expect(next.match(/StationAndroidInsetsBridge.install/g)).toHaveLength(1);
  expect(activityWithAndroidInsets(next)).toBe(next);
  expect(() => activityWithAndroidInsets(activity + activity)).toThrow(
    'Ambiguous',
  );
});

test('the checked-in Android bridge is reproducible from the native bootstrap', () => {
  const path =
    'src-desktop/gen/android/app/src/main/java/io/kontourai/station/StationAndroidInsetsBridge.kt';
  const expected = readFileSync(
    'scripts/templates/android/StationAndroidInsetsBridge.kt',
    'utf8',
  ).replace('__STATION_NAMESPACE__', 'io.kontourai.station');
  expect(readFileSync(path, 'utf8')).toBe(expected);
});

test('iOS recovery clock and network epoch follow monotonic and path APIs', () => {
  const source = readFileSync('src-desktop/src/mobile_recovery_ios.rs', 'utf8');
  expect(source).not.toContain('SystemTime');
  expect(source).toContain('.terminated(Instant::now(),');
  expect(source).toContain('state.foreground(Instant::now())');
  const activation = source.slice(source.indexOf('pub(crate) fn install('));
  expect(activation).toContain('UIApplicationDidBecomeActiveNotification');
  expect(activation).not.toContain('network_changed()');
  expect(activation).toContain('super::ios_network_path::start(&app)');
  expect(readFileSync('src-desktop/src/ios_network_path.rs', 'utf8')).toContain(
    'nw_path_monitor_set_update_handler',
  );
});
