#!/usr/bin/env node

// Adds the Live Activity widget extension (#2513) to a Tauri-rendered
// XcodeGen spec: the StationAgentActivity app-extension target, its embed
// in the app, a weak ActivityKit link (the app still deploys below iOS 16.1),
// and the app's keychain groups (default first, then the group shared with
// the widget). `tauri ios init` renders gen/apple from its template, so the
// committed spec carries this already and CI re-applies it after rendering.
//
//   node scripts/ensure-ios-agent-activity-extension.mjs <project.yml> \
//     --app-bundle-id <id> [--aps-environment development|production]

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';

export const EXTENSION_TARGET = 'StationAgentActivity';
const APP_TARGET = 'station_iOS';
const APP_BUNDLE_ID = /^io\.kontourai\.station(\.[a-z0-9-]+)*$/;
const APS_ENVIRONMENTS = new Set(['development', 'production']);

export function agentActivityExtensionTarget(appBundleId) {
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
        MARKETING_VERSION: '0.1.0',
        CURRENT_PROJECT_VERSION: '0.1.0',
        TARGETED_DEVICE_FAMILY: '1,2',
        SWIFT_VERSION: '5.0',
        ENABLE_BITCODE: false,
        ARCHS: ['arm64'],
        SKIP_INSTALL: true,
      },
    },
    dependencies: [
      { sdk: 'ActivityKit.framework' },
      { sdk: 'SwiftUI.framework' },
      { sdk: 'WidgetKit.framework' },
    ],
  };
}

export function appEntitlementProperties(apsEnvironment) {
  const properties = {
    'keychain-access-groups': [
      '$(AppIdentifierPrefix)$(PRODUCT_BUNDLE_IDENTIFIER)',
      '$(AppIdentifierPrefix)$(PRODUCT_BUNDLE_IDENTIFIER).agentactivity',
    ],
  };
  if (apsEnvironment !== undefined) {
    if (!APS_ENVIRONMENTS.has(apsEnvironment))
      throw new Error('aps-environment must be development or production');
    properties['aps-environment'] = apsEnvironment;
  }
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

  document.setIn(
    ['targets', EXTENSION_TARGET],
    document.createNode(agentActivityExtensionTarget(appBundleId)),
  );
  document.setIn(
    ['targets', APP_TARGET, 'entitlements'],
    document.createNode({
      path: entitlementsPath,
      properties: appEntitlementProperties(apsEnvironment),
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

function main(argv) {
  const [projectPath] = argv;
  if (!projectPath) throw new Error('Expected an iOS project.yml path');
  const resolved = resolve(projectPath);
  const current = readFileSync(resolved, 'utf8');
  const next = ensureIosAgentActivityExtension(current, {
    appBundleId: valueAfter(argv, '--app-bundle-id'),
    apsEnvironment: valueAfter(argv, '--aps-environment'),
  });
  if (next !== current) writeFileSync(resolved, next, 'utf8');
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
