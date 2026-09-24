import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_ANDROID_PERMISSIONS = new Set([
  'android.permission.INTERNET',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.CAMERA',
  'android.permission.RECORD_AUDIO',
  'android.permission.MODIFY_AUDIO_SETTINGS',
]);
// Permissions that dependencies contribute through manifest merging. They
// never appear in the source manifest, so they are accepted only in merged or
// packaged manifests, and each one is here because a reviewed dependency needs
// it — an unlisted library permission still fails the audit.
const PACKAGED_LIBRARY_PERMISSIONS = new Map([
  ['android.permission.VIBRATE', 'tauri-plugin-haptics'],
  [
    'android.permission.RECEIVE_BOOT_COMPLETED',
    'tauri-plugin-notification (re-arms scheduled notifications)',
  ],
  [
    'android.permission.POST_PROMOTED_NOTIFICATIONS',
    'station agent-activity plugin (Android 16 Live Updates)',
  ],
  [
    'com.google.android.c2dm.permission.RECEIVE',
    'firebase-messaging (FCM receipt)',
  ],
  ['android.permission.WAKE_LOCK', 'firebase-messaging'],
  ['android.permission.ACCESS_NETWORK_STATE', 'firebase-messaging'],
]);
// androidx.core declares `${applicationId}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`,
// signature-level and private to the app; the prefix differs per channel.
const DYNAMIC_RECEIVER_PERMISSION =
  /^io\.kontourai\.station(?:\.[a-z][a-z0-9_]*)*\.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION$/;

const REQUIRED_ANDROID_OPTIONAL_FEATURES = new Set([
  'android.hardware.camera.any',
  'android.hardware.camera',
  'android.hardware.camera.autofocus',
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

/**
 * Every `<tag ...>` element's attribute text. Manifests from Gradle's merger
 * and `apkanalyzer manifest print` put each attribute on its own line, so an
 * element is matched up to its closing `>`, never within one line. The name
 * must end at whitespace, `/` or `>`: a word boundary would also match the
 * hyphen in `<uses-permission-sdk-23` and `<activity-alias`.
 */
function elements(source, tag) {
  const uncommented = source.replace(/<!--[\s\S]*?-->/g, '');
  const element = new RegExp(`<${tag}(?=[\\s/>])([^>]*)>`, 'g');
  return [...uncommented.matchAll(element)].map((match) => match[1]);
}

function attribute(attributes, name) {
  const match = new RegExp(`\\bandroid:${name}\\s*=\\s*"([^"]*)"`).exec(
    attributes,
  );
  return match ? match[1] : undefined;
}

// android.view.WindowManager.LayoutParams: SOFT_INPUT_MASK_ADJUST and
// SOFT_INPUT_ADJUST_RESIZE. `apkanalyzer` prints the compiled integer.
const SOFT_INPUT_MASK_ADJUST = 0xf0;
const SOFT_INPUT_ADJUST_RESIZE = 0x10;

function resizesForKeyboard(value) {
  if (value === undefined) return false;
  if (/^0x[0-9a-f]+$/i.test(value)) {
    return (
      (Number.parseInt(value, 16) & SOFT_INPUT_MASK_ADJUST) ===
      SOFT_INPUT_ADJUST_RESIZE
    );
  }
  const adjust = value.split('|').filter((flag) => flag.startsWith('adjust'));
  return adjust.length === 1 && adjust[0] === 'adjustResize';
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

export function auditAndroidManifest(
  androidManifest,
  description = 'Android',
  { packaged = false, compiled = false } = {},
) {
  const androidPermissions = new Set(
    [
      ...elements(androidManifest, 'uses-permission'),
      ...elements(androidManifest, 'uses-permission-sdk-23'),
    ]
      .map((attributes) => {
        const permission = attribute(attributes, 'name');
        if (permission === undefined) {
          throw new Error(
            `${description} declares a permission without a readable android:name.`,
          );
        }
        return permission;
      })
      .filter(
        (permission) =>
          !packaged ||
          !(
            PACKAGED_LIBRARY_PERMISSIONS.has(permission) ||
            DYNAMIC_RECEIVER_PERMISSION.test(permission)
          ),
      ),
  );
  requiredSet(
    androidPermissions,
    REQUIRED_ANDROID_PERMISSIONS,
    `${description} permissions`,
  );

  const optionalFeatures = new Set(
    elements(androidManifest, 'uses-feature')
      .filter((attributes) => attribute(attributes, 'required') === 'false')
      .map((attributes) => attribute(attributes, 'name'))
      .filter(
        (feature) =>
          feature !== undefined && feature !== 'android.software.leanback',
      ),
  );
  requiredSet(
    optionalFeatures,
    REQUIRED_ANDROID_OPTIONAL_FEATURES,
    `${description} optional hardware features`,
  );
  const activities = elements(androidManifest, 'activity');
  if (
    !activities.some((attributes) =>
      resizesForKeyboard(attribute(attributes, 'windowSoftInputMode')),
    )
  ) {
    throw new Error(
      `${description} activity must use the maintained platform keyboard-resize contract windowSoftInputMode="adjustResize".`,
    );
  }
  const application = elements(androidManifest, 'application');
  if (application.length !== 1) {
    throw new Error(`${description} must declare exactly one application.`);
  }
  const [applicationAttributes] = application;
  for (const [name, expected] of [
    ['allowBackup', 'false'],
    ['fullBackupContent', 'false'],
  ]) {
    if (attribute(applicationAttributes, name) !== expected) {
      throw new Error(
        `${description} must retain the reviewed credential backup boundary android:${name}="${expected}".`,
      );
    }
  }
  const extractionRules = attribute(
    applicationAttributes,
    'dataExtractionRules',
  );
  // `apkanalyzer` prints resources by compiled id, which cannot be tied back
  // to a file here. Only that print accepts one; the source and merged
  // manifests audited in the same run must still name the reviewed rules file.
  const extractionRulesAccepted =
    extractionRules === '@xml/data_extraction_rules' ||
    (compiled && /^@ref\/0x[0-9a-f]{8}$/i.test(extractionRules ?? ''));
  if (!extractionRulesAccepted) {
    throw new Error(
      `${description} must retain the reviewed credential backup boundary android:dataExtractionRules="@xml/data_extraction_rules".`,
    );
  }
}

export function auditMobilePermissions({
  androidManifest,
  packagedAndroidManifests = /** @type {Array<[string, string]>} */ ([]),
  compiledAndroidManifests = /** @type {Array<[string, string]>} */ ([]),
  androidDataExtractionRules,
  iosInfo,
}) {
  auditAndroidManifest(androidManifest, 'Android source manifest');
  for (const [name, manifest] of packagedAndroidManifests) {
    auditAndroidManifest(manifest, `Android merged manifest ${name}`, {
      packaged: true,
    });
  }
  for (const [name, manifest] of compiledAndroidManifests) {
    auditAndroidManifest(manifest, `Android package manifest ${name}`, {
      packaged: true,
      compiled: true,
    });
  }
  if (typeof androidDataExtractionRules !== 'string') {
    throw new Error('Android data-extraction rules are required for audit.');
  }
  // A commented-out exclusion must not count as one.
  const extractionRules = androidDataExtractionRules.replace(
    /<!--[\s\S]*?-->/g,
    '',
  );
  for (const section of ['cloud-backup', 'device-transfer']) {
    const body = new RegExp(
      `<${section}[^>]*>([\\s\\S]*?)<\\/${section}>`,
    ).exec(extractionRules)?.[1];
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
  if (process.env.STATION_REQUIRE_PACKAGED_PERMISSION_AUDIT === '1') {
    if (!packageManifest) {
      throw new Error(
        'STATION_ANDROID_PACKAGE_MANIFEST is required for packaged permission audit.',
      );
    }
    // The package print cannot show which file its compiled rules id names,
    // so the build's merged manifest must be there to show it symbolically.
    if (mergedPaths.length === 0) {
      throw new Error(
        'A merged Android manifest from the build is required for packaged permission audit.',
      );
    }
  }
  auditMobilePermissions({
    androidManifest: readFileSync(
      resolve(root, 'src-desktop/gen/android/app/src/main/AndroidManifest.xml'),
      'utf8',
    ),
    packagedAndroidManifests: mergedPaths.map((path) => [
      path,
      readFileSync(path, 'utf8'),
    ]),
    compiledAndroidManifests: packageManifest
      ? [[packageManifest, readFileSync(resolve(packageManifest), 'utf8')]]
      : [],
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
