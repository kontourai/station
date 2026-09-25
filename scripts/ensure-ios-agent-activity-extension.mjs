#!/usr/bin/env node

// Adds the Live Activity widget extension (#2513) to a Tauri-rendered
// XcodeGen spec: the StationAgentActivity app-extension target, its embed
// in the app, a weak ActivityKit link (the app still deploys below iOS 16.1),
// and the app's keychain groups (default first, then the group shared with
// the widget).
//
// This is the project half of the feature switch; STATION_IOS_LIVE_ACTIVITY=1
// (plugins/agent-activity/build.rs) is the plugin half, and a build enables
// both or neither. The committed gen/apple spec carries NEITHER, so the
// local and CI simulator builds, `build:ios:simulator`, `tauri ios dev` and a
// local App Store export embed no extension and need no provisioning for one.
// The TestFlight delivery enables both for the channels whose table entry
// names an extension (Beta and Nightly; scripts/ios-testflight-channel.mjs):
// it runs this on the re-rendered spec, signs the extension target
// (ios-store-signing-config.mjs agent-activity), then `xcodegen generate`,
// with an App Store profile for `<app bundle id>.AgentActivity` and push on
// the app (#2513 slice D).
//
// `--aps-environment` names the APNs environment once and writes it to both
// places that must agree: the app's `aps-environment` entitlement and the
// Info.plist `StationApsEnvironment` the plugin reads it back from (iOS
// cannot read its own entitlements at runtime). The same Info.plist step
// declares `NSSupportsLiveActivities`, which ActivityKit requires. A later run without it is
// refused while the spec still names one, so the two stay paired.
//
// The extension's bundle id cannot be derived from the app's in build
// settings: Tauri's project sync writes PRODUCT_BUNDLE_IDENTIFIER only onto
// the station_iOS target's configurations, so `--app-bundle-id` (and the
// simulator preparation in ios-simulator-build.mjs) sets it explicitly.
//
//   node scripts/ensure-ios-agent-activity-extension.mjs <project.yml> \
//     --app-bundle-id <id> \
//     [--aps-environment development|production --info-plist <Info.plist>]

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';

export const EXTENSION_TARGET = 'StationAgentActivity';
const APP_TARGET = 'station_iOS';
const APP_BUNDLE_ID = /^io\.kontourai\.station(\.[a-z0-9-]+)*$/;
const APS_ENVIRONMENTS = new Set(['development', 'production']);

function agentActivityExtensionTarget(appBundleId) {
  return {
    type: 'app-extension',
    platform: 'iOS',
    deploymentTarget: '18.0',
    sources: [
      {
        path: '../../ios/StationAgentActivity',
        excludes: ['Info.plist', '*.entitlements'],
      },
      {
        path: '../../plugins/agent-activity/ios/Sources/StationAgentActivityShared',
      },
    ],
    settings: {
      base: {
        STATION_APP_BUNDLE_IDENTIFIER: appBundleId,
        PRODUCT_BUNDLE_IDENTIFIER:
          '$(STATION_APP_BUNDLE_IDENTIFIER).AgentActivity',
        PRODUCT_NAME: EXTENSION_TARGET,
        INFOPLIST_FILE: '../../ios/StationAgentActivity/Info.plist',
        CODE_SIGN_ENTITLEMENTS:
          '../../ios/StationAgentActivity/StationAgentActivity.entitlements',
        TARGETED_DEVICE_FAMILY: '1,2',
        SWIFT_VERSION: '5.0',
        ENABLE_BITCODE: false,
        ARCHS: ['arm64'],
        SKIP_INSTALL: true,
      },
    },
    // App Store validation requires an extension's versions to equal its
    // app's. Tauri writes the app's into station_iOS/Info.plist before
    // xcodebuild runs, so copy them from there into the built extension.
    postBuildScripts: [
      {
        name: 'Use the app version',
        basedOnDependencyAnalysis: false,
        inputFiles: ['$(PROJECT_DIR)/station_iOS/Info.plist'],
        script: VERSION_SCRIPT,
      },
    ],
    dependencies: [
      { sdk: 'ActivityKit.framework' },
      { sdk: 'SwiftUI.framework' },
      { sdk: 'WidgetKit.framework' },
    ],
  };
}

const VERSION_SCRIPT = `set -eu
app_plist="$PROJECT_DIR/station_iOS/Info.plist"
built_plist="$TARGET_BUILD_DIR/$INFOPLIST_PATH"
for key in CFBundleShortVersionString CFBundleVersion; do
  value=$(/usr/libexec/PlistBuddy -c "Print :$key" "$app_plist")
  case "$value" in
    ''|*'$('*) echo "error: the app's $key is not a literal version: $value" >&2; exit 1 ;;
  esac
  # Xcode drops a key whose $(VARIABLE) expanded empty, so add, not set.
  /usr/libexec/PlistBuddy -c "Delete :$key" "$built_plist" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Add :$key string $value" "$built_plist"
done
`;

function apsEnvironmentValue(apsEnvironment) {
  if (!APS_ENVIRONMENTS.has(apsEnvironment))
    throw new Error('aps-environment must be development or production');
  return apsEnvironment;
}

/** Sets one top-level Info.plist key to `value` XML, replacing any value. */
function setInfoPlistKey(plist, key, value) {
  const entry = `<key>${key}</key>\n\t${value}`;
  const existing = new RegExp(
    `<key>${key}</key>\\s*(?:<string>[^<]*</string>|<true\\s*/>|<false\\s*/>)`,
  );
  if (existing.test(plist)) return plist.replace(existing, entry);
  const end = /\n?<\/dict>\s*<\/plist>\s*$/;
  if (!end.test(plist)) throw new Error('Unrecognized Info.plist shape');
  return plist.replace(end, `\n\t${entry}\n</dict>\n</plist>\n`);
}

/**
 * The app Info.plist half of an enabled build:
 *
 * - `StationApsEnvironment`, the runtime copy of the `aps-environment`
 *   entitlement;
 * - `NSSupportsLiveActivities`, without which ActivityKit reports
 *   activities disabled, `Activity.request` fails and no push-to-start token
 *   is issued, however the rest is signed.
 *
 * `NSSupportsLiveActivitiesFrequentUpdates` is deliberately not set: it only
 * raises the budget for priority-10 updates, and the gateway sends routine
 * updates at priority 5 (`livePriority` in deploy/push-gateway), keeping 10
 * for start, end and alerting updates. It would also add a "More Frequent
 * Updates" switch in Settings that changes nothing Station sends.
 *
 * Existing values are replaced, so re-running moves them together.
 */
function ensureIosLiveActivityInfoPlist(plist, apsEnvironment) {
  const value = apsEnvironmentValue(apsEnvironment);
  return setInfoPlistKey(
    setInfoPlistKey(
      plist,
      'StationApsEnvironment',
      `<string>${value}</string>`,
    ),
    'NSSupportsLiveActivities',
    '<true/>',
  );
}

const APP_KEYCHAIN_GROUPS = [
  '$(AppIdentifierPrefix)$(PRODUCT_BUNDLE_IDENTIFIER)',
  '$(AppIdentifierPrefix)$(PRODUCT_BUNDLE_IDENTIFIER).agentactivity',
];

/**
 * The app's entitlement properties with this feature's added: every existing
 * property is kept. The first keychain group is the app's default one (where
 * the keyring store writes, and what the plugin derives the shared group
 * from), so it must be `$(AppIdentifierPrefix)$(PRODUCT_BUNDLE_IDENTIFIER)`:
 * a spec whose first group is anything else is refused rather than silently
 * given a different default. Other listed groups follow ours.
 */
function appEntitlementProperties(existing, apsEnvironment) {
  const current = existing ?? {};
  if (apsEnvironment === undefined && current['aps-environment'] !== undefined)
    throw new Error(
      `The spec already names aps-environment ${current['aps-environment']}; pass --aps-environment with --info-plist again so the entitlement and StationApsEnvironment stay paired`,
    );
  const existingGroups = current['keychain-access-groups'] ?? [];
  if (!Array.isArray(existingGroups))
    throw new Error('Unrecognized station_iOS keychain-access-groups');
  if (existingGroups.length > 0 && existingGroups[0] !== APP_KEYCHAIN_GROUPS[0])
    throw new Error(
      `The app's first keychain group is ${existingGroups[0]}, not ${APP_KEYCHAIN_GROUPS[0]}; it is the app's default group, so reconcile it by hand`,
    );
  const others = existingGroups.filter(
    (group) => !APP_KEYCHAIN_GROUPS.includes(group),
  );
  const properties = {
    ...current,
    'keychain-access-groups': [...APP_KEYCHAIN_GROUPS, ...others],
  };
  if (apsEnvironment !== undefined)
    properties['aps-environment'] = apsEnvironmentValue(apsEnvironment);
  return properties;
}

/** Replaces the dependency whose `key` is `value`, or appends it. */
function ensureDependency(document, dependencies, key, entry) {
  const index = dependencies.items.findIndex(
    (item) => YAML.isMap(item) && item.get(key) === entry[key],
  );
  const node = document.createNode(entry);
  if (index === -1) dependencies.items.push(node);
  else dependencies.items[index] = node;
}

export function ensureIosAgentActivityExtension(
  project,
  { appBundleId, apsEnvironment } = {},
) {
  if (typeof appBundleId !== 'string' || !APP_BUNDLE_ID.test(appBundleId))
    throw new Error('Expected a Station iOS app bundle identifier');
  const document = YAML.parseDocument(project);
  if (document.errors.length) throw document.errors[0];
  const app = document.getIn(['targets', APP_TARGET]);
  if (
    !YAML.isMap(app) ||
    app.get('type') !== 'application' ||
    app.get('platform') !== 'iOS'
  )
    throw new Error('iOS project spec has no station_iOS application target');
  const entitlementsPath = app.getIn(['entitlements', 'path']);
  if (typeof entitlementsPath !== 'string')
    throw new Error('iOS project spec has no station_iOS entitlements path');
  const existingProperties = app.getIn(['entitlements', 'properties']);
  if (existingProperties !== undefined && !YAML.isMap(existingProperties))
    throw new Error('Unrecognized station_iOS entitlement properties');

  document.setIn(
    ['targets', EXTENSION_TARGET],
    document.createNode(agentActivityExtensionTarget(appBundleId)),
  );
  document.setIn(
    ['targets', APP_TARGET, 'entitlements'],
    document.createNode({
      path: entitlementsPath,
      properties: appEntitlementProperties(
        existingProperties?.toJSON(),
        apsEnvironment,
      ),
    }),
  );
  let dependencies = app.get('dependencies', true);
  if (!YAML.isSeq(dependencies)) {
    dependencies = document.createNode([]);
    app.set('dependencies', dependencies);
  }
  ensureDependency(document, dependencies, 'target', {
    target: EXTENSION_TARGET,
    embed: true,
  });
  ensureDependency(document, dependencies, 'sdk', {
    sdk: 'ActivityKit.framework',
    weak: true,
  });
  return document.toString({ lineWidth: 0, flowCollectionPadding: false });
}

function valueAfter(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

/**
 * Applies the spec and, when an APNs environment is named, the Info.plist
 * copy of it. Within a run the one argument feeds both; across runs, an
 * aps-less run is refused while the spec names an environment. What this
 * cannot see is an edit made outside it, such as an Info.plist copy left
 * beside a spec re-rendered from scratch.
 *
 * @param {{ project: string, infoPlist?: string }} files
 * @param {{ appBundleId?: string, apsEnvironment?: string }} [options]
 */
export function ensureIosAgentActivity(
  { project, infoPlist },
  { appBundleId, apsEnvironment } = {},
) {
  if ((apsEnvironment === undefined) !== (infoPlist === undefined))
    throw new Error(
      'An APNs environment and the app Info.plist are required together',
    );
  return {
    project: ensureIosAgentActivityExtension(project, {
      appBundleId,
      apsEnvironment,
    }),
    infoPlist:
      infoPlist === undefined
        ? undefined
        : ensureIosLiveActivityInfoPlist(infoPlist, apsEnvironment),
  };
}

function rewrite(path, next) {
  if (next !== readFileSync(path, 'utf8')) writeFileSync(path, next, 'utf8');
}

function main(argv) {
  const [projectPath] = argv;
  if (!projectPath) throw new Error('Expected an iOS project.yml path');
  const project = resolve(projectPath);
  const plistPath = valueAfter(argv, '--info-plist');
  const infoPlist = plistPath === undefined ? undefined : resolve(plistPath);
  const next = ensureIosAgentActivity(
    {
      project: readFileSync(project, 'utf8'),
      infoPlist:
        infoPlist === undefined ? undefined : readFileSync(infoPlist, 'utf8'),
    },
    {
      appBundleId: valueAfter(argv, '--app-bundle-id'),
      apsEnvironment: valueAfter(argv, '--aps-environment'),
    },
  );
  rewrite(project, next.project);
  if (infoPlist !== undefined) rewrite(infoPlist, next.infoPlist);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(
      `iOS agent-activity extension error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
