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
        `android { namespace = "${namespace}" }`,
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
        const bridge = readFileSync(
          join(dirname(activity), 'StationAndroidInsetsBridge.kt'),
          'utf8',
        );
        expect(bridge).toContain(`package ${namespace}\n`);
        expect(bridge).toContain('WindowInsetsCompat.Type.ime()');
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
