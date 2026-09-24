import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { auditMobilePermissions } from '../check-mobile-permissions.mjs';

const androidManifest = `
  <uses-permission android:name="android.permission.INTERNET" />
  <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
  <uses-permission android:name="android.permission.CAMERA" />
  <uses-feature android:name="android.hardware.camera.any" android:required="false" />
  <uses-feature android:name="android.hardware.camera" android:required="false" />
  <uses-feature android:name="android.hardware.camera.autofocus" android:required="false" />
  <uses-permission android:name="android.permission.RECORD_AUDIO" />
  <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
  <uses-feature android:name="android.hardware.microphone" android:required="false" />
  <uses-feature android:name="android.software.leanback" android:required="false" />
  <application android:allowBackup="false" android:fullBackupContent="false" android:dataExtractionRules="@xml/data_extraction_rules">
    <activity android:windowSoftInputMode="adjustResize" />
  </application>
`;
const androidDataExtractionRules = `
  <data-extraction-rules>
    <cloud-backup>
      <exclude domain="root" path="." /><exclude domain="file" path="." /><exclude domain="database" path="." /><exclude domain="sharedpref" path="." /><exclude domain="external" path="." />
    </cloud-backup>
    <device-transfer>
      <exclude domain="root" path="." /><exclude domain="file" path="." /><exclude domain="database" path="." /><exclude domain="sharedpref" path="." /><exclude domain="external" path="." />
    </device-transfer>
  </data-extraction-rules>
`;
const iosInfo = `
  <key>NSCameraUsageDescription</key><string>Station uses the camera to scan pairing codes from another device.</string>
  <key>NSLocalNetworkUsageDescription</key><string>Station connects to Station hosts on your local network.</string>
  <key>NSMicrophoneUsageDescription</key><string>Station uses the microphone for voice conversations with your agents.</string>
`;

describe('mobile permission audit', () => {
  test('accepts the reviewed Android and iOS declarations', () => {
    expect(() =>
      auditMobilePermissions({
        androidManifest,
        androidDataExtractionRules,
        iosInfo,
      }),
    ).not.toThrow();
  });

  test('fails loudly when an unreviewed Android permission is added', () => {
    expect(() =>
      auditMobilePermissions({
        androidManifest: androidManifest.replace(
          '<activity',
          '<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />\n<activity',
        ),
        androidDataExtractionRules,
        iosInfo,
      }),
    ).toThrow(/Android source manifest permissions drifted/);
  });

  test('audits merged/package manifests instead of trusting source declarations', () => {
    expect(() =>
      auditMobilePermissions({
        androidManifest,
        packagedAndroidManifests: [
          [
            'release/AndroidManifest.xml',
            androidManifest.replace(
              '<activity',
              '<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />\n<activity',
            ),
          ],
        ],
        androidDataExtractionRules,
        iosInfo,
      }),
    ).toThrow(
      /merged manifest release\/AndroidManifest.xml permissions drifted/,
    );
  });

  const withLibraryPermissions = androidManifest.replace(
    '<activity',
    [
      'android.permission.VIBRATE',
      'android.permission.POST_PROMOTED_NOTIFICATIONS',
      'com.google.android.c2dm.permission.RECEIVE',
      'io.kontourai.station.nightly.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION',
    ]
      .map((name) => `<uses-permission android:name="${name}" />\n`)
      .join('') + '<activity',
  );

  test('accepts reviewed library permissions in a merged/package manifest', () => {
    expect(() =>
      auditMobilePermissions({
        androidManifest,
        packagedAndroidManifests: [
          ['release/AndroidManifest.xml', withLibraryPermissions],
        ],
        androidDataExtractionRules,
        iosInfo,
      }),
    ).not.toThrow();
  });

  test('rejects library permissions declared in the source manifest', () => {
    expect(() =>
      auditMobilePermissions({
        androidManifest: withLibraryPermissions,
        androidDataExtractionRules,
        iosInfo,
      }),
    ).toThrow(/Android source manifest permissions drifted/);
  });

  test('rejects a dynamic-receiver permission owned by another app', () => {
    expect(() =>
      auditMobilePermissions({
        androidManifest,
        packagedAndroidManifests: [
          [
            'release/AndroidManifest.xml',
            androidManifest.replace(
              '<activity',
              '<uses-permission android:name="com.example.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION" />\n<activity',
            ),
          ],
        ],
        androidDataExtractionRules,
        iosInfo,
      }),
    ).toThrow(/permissions drifted/);
  });

  test('keeps the maintained native keyboard resize contract', () => {
    expect(() =>
      auditMobilePermissions({
        androidManifest: androidManifest.replace('adjustResize', 'adjustPan'),
        androidDataExtractionRules,
        iosInfo,
      }),
    ).toThrow(/maintained platform keyboard-resize contract/);
  });

  test('fails loudly when an iOS privacy justification changes', () => {
    expect(() =>
      auditMobilePermissions({
        androidManifest,
        androidDataExtractionRules,
        iosInfo: iosInfo.replace('voice conversations', 'recordings'),
      }),
    ).toThrow(/NSMicrophoneUsageDescription/);
  });

  test('fails loudly when packaged backup or transfer exclusions drift', () => {
    expect(() =>
      auditMobilePermissions({
        androidManifest: androidManifest.replace(
          'android:allowBackup="false"',
          'android:allowBackup="true"',
        ),
        androidDataExtractionRules,
        iosInfo,
      }),
    ).toThrow(/credential backup boundary/);
    expect(() =>
      auditMobilePermissions({
        androidManifest,
        androidDataExtractionRules: androidDataExtractionRules.replace(
          '<exclude domain="sharedpref" path="." />',
          '',
        ),
        iosInfo,
      }),
    ).toThrow(/sharedpref domain/);
    expect(() =>
      auditMobilePermissions({
        androidManifest,
        androidDataExtractionRules: androidDataExtractionRules.replace(
          '<exclude domain="sharedpref" path="." />',
          '<!-- <exclude domain="sharedpref" path="." /> -->',
        ),
        iosInfo,
      }),
    ).toThrow(/sharedpref domain/);
  });
});

test('release iOS configuration uses durable privacy descriptions outside gen/apple', () => {
  const config = JSON.parse(
    readFileSync('src-desktop/tauri.conf.json', 'utf8'),
  );
  expect(config.bundle.iOS.infoPlist).toBe('Info.ios.plist');
  expect(() =>
    auditMobilePermissions({
      androidManifest,
      androidDataExtractionRules,
      iosInfo: readFileSync(
        `src-desktop/${config.bundle.iOS.infoPlist}`,
        'utf8',
      ),
    }),
  ).not.toThrow();
});

// Captured from a real debug build (#2473): Gradle's merged manifest,
// `apkanalyzer manifest print` of the APK and `bundletool dump manifest` of
// the AAB, which are what release.yml audits. Gradle and apkanalyzer put every
// attribute on its own line; both package prints show windowSoftInputMode as
// an integer, and apkanalyzer shows resources as @ref ids.
const FIXTURES = 'scripts/__tests__/fixtures/android-manifests';
const mergedManifest = readFileSync(`${FIXTURES}/merged-debug.xml`, 'utf8');
const apkanalyzerManifest = readFileSync(
  `${FIXTURES}/apkanalyzer-debug-apk.xml`,
  'utf8',
);
const bundletoolManifest = readFileSync(
  `${FIXTURES}/bundletool-debug-aab.xml`,
  'utf8',
);

describe('packaged audit on real build output (#2473)', () => {
  const audit = (manifest: string) =>
    auditMobilePermissions({
      androidManifest,
      packagedAndroidManifests: [['merged/AndroidManifest.xml', manifest]],
      androidDataExtractionRules,
      iosInfo,
    });
  const auditPrint = (manifest: string) =>
    auditMobilePermissions({
      androidManifest,
      packagedAndroidManifests: [
        ['merged/AndroidManifest.xml', mergedManifest],
      ],
      compiledAndroidManifests: [['app.apk', manifest]],
      androidDataExtractionRules,
      iosInfo,
    });
  const bothOutputs = [
    [audit, mergedManifest],
    [auditPrint, apkanalyzerManifest],
    [auditPrint, bundletoolManifest],
  ] as const;

  it('accepts the real merged manifest and the real apkanalyzer print', () => {
    expect(() => audit(mergedManifest)).not.toThrow();
    expect(() => auditPrint(apkanalyzerManifest)).not.toThrow();
    expect(() => auditPrint(bundletoolManifest)).not.toThrow();
  });

  it('still finds an unreviewed permission written across lines', () => {
    for (const [run, manifest] of bothOutputs) {
      for (const tag of ['uses-permission', 'uses-permission-sdk-23']) {
        const withLocation = manifest.replace(
          /(<application\b)/,
          `<${tag}\n        android:name="android.permission.ACCESS_FINE_LOCATION" />\n\n    $1`,
        );
        expect(() => run(withLocation)).toThrow(
          /permissions drifted; missing=\[\] unexpected=\[android\.permission\.ACCESS_FINE_LOCATION\]/,
        );
      }
    }
  });

  it('refuses a permission whose name it cannot read', () => {
    const unreadable = apkanalyzerManifest.replace(
      /(<application\b)/,
      `<uses-permission\n        android:name='android.permission.ACCESS_FINE_LOCATION' />\n\n    $1`,
    );
    expect(() => auditPrint(unreadable)).toThrow(
      /permission without a readable android:name/,
    );
  });

  it('does not count a commented-out permission', () => {
    const commented = apkanalyzerManifest.replace(
      /<uses-permission\s+android:name="android\.permission\.CAMERA"\s*\/>/,
      (element) => `<!-- ${element} -->`,
    );
    expect(commented).not.toBe(apkanalyzerManifest);
    expect(() => auditPrint(commented)).toThrow(
      /missing=\[android\.permission\.CAMERA\]/,
    );
  });

  it('still finds a required permission that went missing', () => {
    const withoutCamera = apkanalyzerManifest.replace(
      /<uses-permission\s+android:name="android\.permission\.CAMERA"\s*\/>/,
      '',
    );
    expect(withoutCamera).not.toBe(apkanalyzerManifest);
    expect(() => auditPrint(withoutCamera)).toThrow(
      /missing=\[android\.permission\.CAMERA\]/,
    );
  });

  it('decodes the compiled keyboard mode: resize passes, pan fails', () => {
    // bundletool pads the same value to eight digits.
    expect(bundletoolManifest).toContain(
      'android:windowSoftInputMode="0x00000010"',
    );
    expect(() =>
      auditPrint(bundletoolManifest.replace('"0x00000010"', '"0x00000020"')),
    ).toThrow(/keyboard-resize contract/);
    expect(apkanalyzerManifest).toContain('android:windowSoftInputMode="0x10"');
    // 0x20 is SOFT_INPUT_ADJUST_PAN; 0x15 keeps resize with a state flag set.
    expect(() =>
      auditPrint(apkanalyzerManifest.replace('"0x10"', '"0x20"')),
    ).toThrow(/keyboard-resize contract/);
    expect(() =>
      auditPrint(apkanalyzerManifest.replace('"0x10"', '"0x15"')),
    ).not.toThrow();
  });

  it('requires adjustResize as the only symbolic adjust mode', () => {
    expect(mergedManifest).toMatch(/windowSoftInputMode="adjustResize"/);
    expect(() =>
      audit(
        mergedManifest.replace(
          /windowSoftInputMode="adjustResize"/,
          'windowSoftInputMode="stateHidden|adjustResize"',
        ),
      ),
    ).not.toThrow();
    expect(() =>
      audit(
        mergedManifest.replace(
          /windowSoftInputMode="adjustResize"/,
          'windowSoftInputMode="adjustResize|adjustPan"',
        ),
      ),
    ).toThrow(/keyboard-resize contract/);
  });

  it('reads the backup boundary from the single application element', () => {
    for (const [run, manifest] of bothOutputs) {
      expect(() =>
        run(
          manifest.replace(
            'android:allowBackup="false"',
            'android:allowBackup="true"',
          ),
        ),
      ).toThrow(/allowBackup/);
      // A second application is refused outright rather than one of the two
      // being chosen to audit.
      expect(() =>
        run(manifest.replace('</manifest>', '<application />\n</manifest>')),
      ).toThrow(/exactly one application/);
      // The boundary must sit on the application, not on some other element.
      const moved = manifest
        .replace('android:allowBackup="false"', '')
        .replace(/(<activity\b)/, '$1 android:allowBackup="false"');
      expect(() => run(moved)).toThrow(/allowBackup/);
    }
    expect(() =>
      auditPrint(
        apkanalyzerManifest.replace(
          /\s*android:dataExtractionRules="@ref\/0x[0-9a-f]+"/,
          '',
        ),
      ),
    ).toThrow(/dataExtractionRules/);
  });

  it('accepts a compiled rules id only from the package print', () => {
    const compiledRules = '@ref/0x7f130000';
    const mergedWithId = mergedManifest.replace(
      '@xml/data_extraction_rules',
      compiledRules,
    );
    expect(mergedWithId).not.toBe(mergedManifest);
    expect(() => audit(mergedWithId)).toThrow(/dataExtractionRules/);
    expect(() =>
      auditMobilePermissions({
        androidManifest: androidManifest.replace(
          '@xml/data_extraction_rules',
          compiledRules,
        ),
        androidDataExtractionRules,
        iosInfo,
      }),
    ).toThrow(/dataExtractionRules/);
    // The print still has to name a resource, not some other rules file.
    expect(() =>
      auditPrint(
        apkanalyzerManifest.replace(
          /android:dataExtractionRules="@ref\/0x[0-9a-f]+"/,
          'android:dataExtractionRules="@xml/other_rules"',
        ),
      ),
    ).toThrow(/dataExtractionRules/);
  });
});
