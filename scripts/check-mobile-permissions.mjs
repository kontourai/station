import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_ANDROID_PERMISSIONS = new Set([
  'android.permission.INTERNET',
  'android.permission.ACCESS_NETWORK_STATE',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.CAMERA',
  'android.permission.RECORD_AUDIO',
  'android.permission.MODIFY_AUDIO_SETTINGS',
]);
const REQUIRED_ANDROID_OPTIONAL_FEATURES = new Set([
  'android.hardware.camera.any',
  'android.hardware.microphone',
]);
const REQUIRED_IOS_USAGE_DESCRIPTIONS = new Map([
  [
    'NSCameraUsageDescription',
    'Station uses the camera to scan pairing codes from another device.',
  ],
  [
    'NSLocalNetworkUsageDescription',
    'Station connects to Station hosts on your local network.',
  ],
  [
    'NSMicrophoneUsageDescription',
    'Station uses the microphone for voice conversations with your agents.',
  ],
]);

function matches(source, expression) {
  return [...source.matchAll(expression)].map((match) => match[1]);
}

function requiredSet(actual, required, description) {
  const unexpected = [...actual].filter((item) => !required.has(item));
  const missing = [...required].filter((item) => !actual.has(item));
  if (missing.length || unexpected.length) {
    throw new Error(
      `${description} drifted; missing=[${missing.join(', ')}] unexpected=[${unexpected.join(', ')}]`,
    );
  }
}

export function auditAndroidManifest(androidManifest, description = 'Android') {
  const androidPermissions = new Set(
    matches(androidManifest, /<uses-permission android:name="([^"]+)"/g),
  );
  requiredSet(
    androidPermissions,
    REQUIRED_ANDROID_PERMISSIONS,
    `${description} permissions`,
  );

  const optionalFeatures = new Set(
    matches(
      androidManifest,
      /<uses-feature android:name="([^"]+)" android:required="false"/g,
    ).filter((feature) => feature !== 'android.software.leanback'),
  );
  requiredSet(
    optionalFeatures,
    REQUIRED_ANDROID_OPTIONAL_FEATURES,
    `${description} optional hardware features`,
  );
  if (!androidManifest.includes('android:windowSoftInputMode="adjustResize"')) {
    throw new Error(
      `${description} activity must use the maintained platform keyboard-resize contract windowSoftInputMode="adjustResize".`,
    );
  }
  for (const attribute of [
    'android:allowBackup="false"',
    'android:fullBackupContent="false"',
    'android:dataExtractionRules="@xml/data_extraction_rules"',
  ]) {
    if (!androidManifest.includes(attribute)) {
      throw new Error(
        `${description} must retain the reviewed credential backup boundary ${attribute}.`,
      );
    }
  }
}

export function auditMobilePermissions({
  androidManifest,
  packagedAndroidManifests = /** @type {Array<[string, string]>} */ ([]),
  androidDataExtractionRules,
  iosInfo,
}) {
  auditAndroidManifest(androidManifest, 'Android source manifest');
  for (const [name, manifest] of packagedAndroidManifests) {
    auditAndroidManifest(manifest, `Android merged/package manifest ${name}`);
  }
  if (typeof androidDataExtractionRules !== 'string') {
    throw new Error('Android data-extraction rules are required for audit.');
  }
  for (const section of ['cloud-backup', 'device-transfer']) {
    const body = new RegExp(
      `<${section}[^>]*>([\\s\\S]*?)<\\/${section}>`,
    ).exec(androidDataExtractionRules)?.[1];
    if (!body)
      throw new Error(`Android ${section} extraction rules are missing.`);
    for (const domain of [
      'root',
      'file',
      'database',
      'sharedpref',
      'external',
    ]) {
      if (!body.includes(`<exclude domain="${domain}" path="." />`)) {
        throw new Error(
          `Android ${section} must exclude the complete ${domain} domain.`,
        );
      }
    }
  }

  const usageEntries = new Map(
    [
      ...iosInfo.matchAll(
        /<key>(NS[^<]+UsageDescription)<\/key>\s*<string>([^<]+)<\/string>/g,
      ),
    ].map((match) => [match[1], match[2]]),
  );
  requiredSet(
    new Set(usageEntries.keys()),
    new Set(REQUIRED_IOS_USAGE_DESCRIPTIONS.keys()),
    'iOS usage-description keys',
  );
  for (const [key, expected] of REQUIRED_IOS_USAGE_DESCRIPTIONS) {
    if (usageEntries.get(key) !== expected) {
      throw new Error(`iOS ${key} must retain its reviewed justification.`);
    }
  }
}

function findMergedManifests(directory) {
  if (!existsSync(directory)) return [];
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) found.push(...findMergedManifests(path));
    else if (
      entry.name === 'AndroidManifest.xml' &&
      path.includes('merged_manifest')
    )
      found.push(path);
  }
  return found;
}

function main() {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const mergedPaths = findMergedManifests(
    resolve(root, 'src-desktop/gen/android/app/build/intermediates'),
  );
  const packageManifest = process.env.STATION_ANDROID_PACKAGE_MANIFEST;
  if (
    process.env.STATION_REQUIRE_PACKAGED_PERMISSION_AUDIT === '1' &&
    !packageManifest
  ) {
    throw new Error(
      'STATION_ANDROID_PACKAGE_MANIFEST is required for packaged permission audit.',
    );
  }
  if (packageManifest) mergedPaths.push(resolve(packageManifest));
  auditMobilePermissions({
    androidManifest: readFileSync(
      resolve(root, 'src-desktop/gen/android/app/src/main/AndroidManifest.xml'),
      'utf8',
    ),
    packagedAndroidManifests: mergedPaths.map((path) => [
      path,
      readFileSync(path, 'utf8'),
    ]),
    androidDataExtractionRules: readFileSync(
      resolve(
        root,
        'src-desktop/gen/android/app/src/main/res/xml/data_extraction_rules.xml',
      ),
      'utf8',
    ),
    iosInfo: readFileSync(
      resolve(root, 'src-desktop/gen/apple/station_iOS/Info.plist'),
      'utf8',
    ),
  });
  console.log('mobile permission audit: PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
