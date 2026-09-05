import { describe, expect, test } from 'vitest';
import { auditMobilePermissions } from '../check-mobile-permissions.mjs';

const androidManifest = `
  <uses-permission android:name="android.permission.INTERNET" />
  <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
  <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
  <uses-permission android:name="android.permission.CAMERA" />
  <uses-feature android:name="android.hardware.camera.any" android:required="false" />
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
      /merged\/package manifest release\/AndroidManifest.xml permissions drifted/,
    );
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
  });
});
