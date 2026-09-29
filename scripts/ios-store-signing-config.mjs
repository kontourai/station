import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';
import {
  decodeProvisioningProfile,
  inspectAppStoreDistributionProfile,
} from './check-ios-store-profile.mjs';
import {
  EXTENSION_TARGET,
  NOTIFICATION_SERVICE_TARGET,
} from './ensure-ios-agent-activity-extension.mjs';
import { IOS_TESTFLIGHT_CHANNELS } from './ios-testflight-channel.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';

const REQUIRED = [
  'profile',
  'identity',
  'team',
  'bundle-id',
  'template',
  'template-output',
  'overlay-output',
];
const SUPPORTED_IOS_BUNDLE_IDS = new Set([
  'io.kontourai.station',
  'io.kontourai.station.beta',
  'io.kontourai.station.nightly',
]);

// The Live Activity widget extension each channel's app embeds, keyed by the
// app's bundle id; a channel without one (Stable) is absent.
const AGENT_ACTIVITY_BUNDLE_IDS = new Map(
  Object.values(IOS_TESTFLIGHT_CHANNELS)
    .filter((channel) => channel.agentActivityBundleId)
    .map((channel) => [channel.bundleId, channel.agentActivityBundleId]),
);
const NOTIFICATION_SERVICE_BUNDLE_IDS = new Map(
  Object.values(IOS_TESTFLIGHT_CHANNELS)
    .filter((channel) => channel.notificationServiceBundleId)
    .map((channel) => [channel.bundleId, channel.notificationServiceBundleId]),
);
const AGENT_ACTIVITY_REQUIRED = [
  'extension-profile',
  'app-profile',
  'identity',
  'team',
  'app-bundle-id',
  'aps-environment',
  'project',
  'export-options-output',
];
const PROFILE_UUID =
  /^[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12}$/;

function parseRequired(args, required) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.slice(2);
    const value = args[index + 1];
    if (
      !args[index]?.startsWith('--') ||
      !required.includes(key) ||
      values[key] ||
      !value ||
      value.startsWith('--')
    )
      throw new Error(
        'Expected every required iOS signing option exactly once with a non-empty value.',
      );
    values[key] = value;
  }
  if (Object.keys(values).length !== required.length)
    throw new Error('Missing required iOS signing option.');
  return values;
}

export function parseOptions(args) {
  return parseRequired(
    args.map((argument) => (argument === '--station' ? '--profile' : argument)),
    REQUIRED,
  );
}

export function parseAgentActivityOptions(args) {
  const notificationOption = '--notification-service-profile';
  const at = args.indexOf(notificationOption);
  if (at < 0) return parseRequired(args, AGENT_ACTIVITY_REQUIRED);
  const value = args[at + 1];
  if (
    !value ||
    value.startsWith('--') ||
    args.lastIndexOf(notificationOption) !== at
  )
    throw new Error(
      'Expected --notification-service-profile exactly once with a non-empty value.',
    );
  return {
    ...parseRequired(
      [...args.slice(0, at), ...args.slice(at + 2)],
      AGENT_ACTIVITY_REQUIRED,
    ),
    'notification-service-profile': value,
  };
}

/** The widget extension's bundle id for a Station app, or a refusal. */
export function agentActivityBundleId(appBundleId) {
  const extensionBundleId = AGENT_ACTIVITY_BUNDLE_IDS.get(appBundleId);
  if (!extensionBundleId)
    throw new Error(
      `No reviewed Live Activity extension for iOS app ${appBundleId}.`,
    );
  return extensionBundleId;
}

export function notificationServiceBundleId(appBundleId) {
  const bundleId = NOTIFICATION_SERVICE_BUNDLE_IDS.get(appBundleId);
  if (!bundleId)
    throw new Error(
      `No reviewed Notification Service extension for iOS app ${appBundleId}.`,
    );
  return bundleId;
}

function assertSigningInputs(profile, identity) {
  if (
    typeof profile?.name !== 'string' ||
    !profile.name.trim() ||
    /[\r\n]/.test(profile.name) ||
    typeof profile?.uuid !== 'string' ||
    !profile.uuid.trim() ||
    /[\r\n]/.test(profile.uuid)
  )
    throw new Error(
      'Provisioning-profile name and UUID must be non-empty single-line text.',
    );
  if (!identity || /[\r\n]/.test(identity))
    throw new Error(
      'Apple signing identity must be non-empty single-line text.',
    );
  if (
    !identity.startsWith('Apple Distribution: ') ||
    !identity.endsWith(`(${profile.team})`)
  )
    throw new Error(
      'Apple signing identity does not bind to the provisioning-profile team.',
    );
}

// The manual-signing block storeSigningTemplate owns. `tauri ios init` may
// render some of these itself (DEVELOPMENT_TEAM from APPLE_DEVELOPMENT_TEAM);
// rendered copies are dropped so the spec keeps exactly one of each key.
const SIGNING_SETTING_KEYS = [
  'CODE_SIGN_STYLE',
  'CODE_SIGN_IDENTITY',
  'DEVELOPMENT_TEAM',
  'PROVISIONING_PROFILE',
  'PROVISIONING_PROFILE_SPECIFIER',
];

export function storeSigningTemplate({
  template,
  profile,
  identity,
  bundleId = 'io.kontourai.station',
}) {
  assertSigningInputs(profile, identity);
  if (!SUPPORTED_IOS_BUNDLE_IDS.has(bundleId))
    throw new Error(
      'iOS App Store signing only supports reviewed Station bundle IDs.',
    );
  const marker = `      PRODUCT_BUNDLE_IDENTIFIER: ${bundleId}\n`;
  if (template.split(marker).length !== 2)
    throw new Error(
      'iOS project template has no supported app signing marker.',
    );
  // `tauri ios init` renders DEVELOPMENT_TEAM from APPLE_DEVELOPMENT_TEAM
  // (and may render other signing settings in the future). The template owns
  // the manual-signing block below, so drop rendered copies first: a second
  // copy of any key is a duplicate YAML key, which xcodegen silently
  // tolerates but the strict parse in the Live Activity steps refuses
  // (Nightly 246002). More than one copy means another settings block
  // carries signing: refuse rather than re-sign it by hand.
  let unsigned = template;
  for (const key of SIGNING_SETTING_KEYS) {
    const copies =
      unsigned.match(new RegExp(`^      ${key}: .*$(?:\r?\n|$)`, 'gm')) ?? [];
    if (copies.length > 1)
      throw new Error(
        `iOS project template signs another settings block with ${key}; reconcile it by hand.`,
      );
    unsigned = unsigned.replace(
      new RegExp(`^      ${key}: .*$(?:\r?\n|$)`, 'gm'),
      '',
    );
  }
  return unsigned.replace(
    marker,
    `${marker}      CODE_SIGN_STYLE: Manual\n      CODE_SIGN_IDENTITY: ${JSON.stringify(identity)}\n      DEVELOPMENT_TEAM: ${profile.team}\n      PROVISIONING_PROFILE: ${JSON.stringify(profile.uuid)}\n      PROVISIONING_PROFILE_SPECIFIER: ${JSON.stringify(profile.name)}\n`,
  );
}

export function writeIosStoreSigningConfig(
  options,
  {
    decode = decodeProvisioningProfile,
    inspect = inspectAppStoreDistributionProfile,
    read = readFileSync,
    write = writeFileSync,
  } = {},
) {
  if (!SUPPORTED_IOS_BUNDLE_IDS.has(options.bundleId))
    throw new Error(
      'iOS App Store signing only supports reviewed Station bundle IDs.',
    );
  const paths = [
    options.profile,
    options.template,
    options.templateOutput,
    options.overlayOutput,
  ].map((path) => resolve(path));
  if (new Set(paths).size !== paths.length)
    throw new Error('iOS signing inputs and outputs must not alias.');
  const [profilePath, templatePath, templateOutputPath, overlayOutputPath] =
    paths;
  const profile = inspect(decode(profilePath), {
    label: profilePath,
    expectedTeam: options.team,
    expectedBundleIdentifier: options.bundleId,
  });
  write(
    templateOutputPath,
    storeSigningTemplate({
      template: read(templatePath, 'utf8'),
      profile,
      identity: options.identity,
      bundleId: options.bundleId,
    }),
    { mode: 0o600, flag: 'wx' },
  );
  write(
    overlayOutputPath,
    `${JSON.stringify({ bundle: { iOS: { template: templateOutputPath } } }, null, 2)}\n`,
    { mode: 0o600, flag: 'wx' },
  );
  return profile;
}

/** Sign one target added to the rendered spec with its own app-bound profile. */
function signExtensionTarget({
  project,
  profile,
  identity,
  appBundleId,
  targetName,
  suffix,
  label,
}) {
  assertSigningInputs(profile, identity);
  const extensionBundleId = `${appBundleId}.${suffix}`;
  if (profile.applicationIdentifier !== `${profile.team}.${extensionBundleId}`)
    throw new Error(
      `The ${label} profile is for ${profile.applicationIdentifier}, not ${profile.team}.${extensionBundleId}.`,
    );
  const document = YAML.parseDocument(project);
  if (document.errors.length) throw document.errors[0];
  const target = document.getIn(['targets', targetName]);
  if (!YAML.isMap(target) || target.get('type') !== 'app-extension')
    throw new Error(
      `iOS project spec has no ${targetName} app-extension target; run ensure-ios-agent-activity-extension.mjs first.`,
    );
  const base = target.getIn(['settings', 'base']);
  if (!YAML.isMap(base))
    throw new Error(`Unrecognized ${targetName} build settings.`);
  if (base.get('STATION_APP_BUNDLE_IDENTIFIER') !== appBundleId)
    throw new Error(
      `${targetName} belongs to ${base.get('STATION_APP_BUNDLE_IDENTIFIER')}, not ${appBundleId}.`,
    );
  if (
    base.get('PRODUCT_BUNDLE_IDENTIFIER') !==
    `$(STATION_APP_BUNDLE_IDENTIFIER).${suffix}`
  )
    throw new Error(
      `${targetName} bundle identifier is not derived from its app.`,
    );
  base.set('CODE_SIGN_STYLE', 'Manual');
  base.set('CODE_SIGN_IDENTITY', identity);
  base.set('DEVELOPMENT_TEAM', profile.team);
  base.set('PROVISIONING_PROFILE', profile.uuid);
  base.set('PROVISIONING_PROFILE_SPECIFIER', profile.name);
  return document.toString({ lineWidth: 0, flowCollectionPadding: false });
}

export function storeAgentActivitySigningSpec(options) {
  agentActivityBundleId(options.appBundleId);
  return signExtensionTarget({
    ...options,
    targetName: EXTENSION_TARGET,
    suffix: 'AgentActivity',
    label: 'Live Activity',
  });
}

function xmlText(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/**
 * The export options for an archive that embeds the extension. `tauri ios
 * build` merges gen/apple/ExportOptions.plist with its own keys, top-level
 * key by key; with IOS_MOBILE_PROVISION set, its `provisioningProfiles`
 * names only the app and replaces this file's, and a manual-signing export
 * then refuses the unlisted extension. So an extension build leaves that
 * variable unset and names every bundle's profile here. The committed file
 * carries only `method`, which Tauri's --export-method replaces anyway.
 *
 * @param {{ identity: string, team: string, profiles: Record<string, string> }} options
 */
export function storeExportOptions({ identity, team, profiles }) {
  if (!identity || /[\r\n]/.test(identity))
    throw new Error(
      'Apple signing identity must be non-empty single-line text.',
    );
  if (!/^[A-Z0-9]{10}$/.test(team))
    throw new Error('Apple team identifier must be ten characters.');
  const entries = Object.entries(profiles);
  if (entries.length === 0)
    throw new Error('Export options need at least one provisioning profile.');
  for (const [bundleId, uuid] of entries) {
    if (!/^io\.kontourai\.station(\.[A-Za-z0-9-]+)*$/.test(bundleId))
      throw new Error(`Unreviewed bundle id in export options: ${bundleId}.`);
    if (!PROFILE_UUID.test(uuid))
      throw new Error(`Invalid provisioning-profile UUID for ${bundleId}.`);
  }
  const mapping = entries
    .map(
      ([bundleId, uuid]) =>
        `\t\t<key>${bundleId}</key>\n\t\t<string>${uuid}</string>\n`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>method</key>
\t<string>app-store-connect</string>
\t<key>signingStyle</key>
\t<string>manual</string>
\t<key>teamID</key>
\t<string>${team}</string>
\t<key>signingCertificate</key>
\t<string>${xmlText(identity)}</string>
\t<key>provisioningProfiles</key>
\t<dict>
${mapping}\t</dict>
</dict>
</plist>
`;
}

/**
 * Validates the app and widget profiles, and the optional Notification Service
 * profile when its target is present. Signs both extension targets in place
 * and writes export options exclusively to `exportOptionsOutput`.
 */
export function writeIosAgentActivitySigning(
  options,
  {
    decode = decodeProvisioningProfile,
    inspect = inspectAppStoreDistributionProfile,
    read = readFileSync,
    write = writeFileSync,
  } = {},
) {
  const extensionBundleId = agentActivityBundleId(options.appBundleId);
  const notificationBundleId = NOTIFICATION_SERVICE_BUNDLE_IDS.get(
    options.appBundleId,
  );
  if (options.notificationServiceProfile && !notificationBundleId)
    throw new Error(
      `No reviewed Notification Service extension for iOS app ${options.appBundleId}.`,
    );
  const paths = [
    options.profile,
    options.appProfile,
    options.project,
    options.exportOptionsOutput,
    ...(options.notificationServiceProfile
      ? [options.notificationServiceProfile]
      : []),
  ].map((path) => resolve(path));
  if (new Set(paths).size !== paths.length)
    throw new Error('iOS signing inputs and outputs must not alias.');
  const [profilePath, appProfilePath, projectPath, exportOptionsPath] = paths;
  const originalProject = read(projectPath, 'utf8');
  const spec = YAML.parseDocument(originalProject);
  if (spec.errors.length) throw spec.errors[0];
  const hasNotificationTarget = spec.hasIn([
    'targets',
    NOTIFICATION_SERVICE_TARGET,
  ]);
  if (hasNotificationTarget !== Boolean(options.notificationServiceProfile))
    throw new Error(
      hasNotificationTarget
        ? `${NOTIFICATION_SERVICE_TARGET} target requires --notification-service-profile.`
        : `--notification-service-profile was provided but ${NOTIFICATION_SERVICE_TARGET} target is absent.`,
    );
  const extension = inspect(decode(profilePath), {
    label: profilePath,
    expectedTeam: options.team,
    expectedBundleIdentifier: extensionBundleId,
  });
  const app = inspect(decode(appProfilePath), {
    label: appProfilePath,
    expectedTeam: options.team,
    expectedBundleIdentifier: options.appBundleId,
    expectedApsEnvironment: options.apsEnvironment,
  });
  const project = storeAgentActivitySigningSpec({
    project: originalProject,
    profile: extension,
    identity: options.identity,
    appBundleId: options.appBundleId,
  });
  const notificationService = options.notificationServiceProfile
    ? inspect(decode(resolve(options.notificationServiceProfile)), {
        label: resolve(options.notificationServiceProfile),
        expectedTeam: options.team,
        expectedBundleIdentifier: notificationBundleId,
      })
    : undefined;
  const signedProject = notificationService
    ? signExtensionTarget({
        project,
        profile: notificationService,
        identity: options.identity,
        appBundleId: options.appBundleId,
        targetName: NOTIFICATION_SERVICE_TARGET,
        suffix: 'NotificationService',
        label: 'Notification Service',
      })
    : project;
  const exportOptions = storeExportOptions({
    identity: options.identity,
    team: options.team,
    profiles: {
      [options.appBundleId]: app.uuid,
      [extensionBundleId]: extension.uuid,
      ...(notificationService
        ? { [notificationBundleId]: notificationService.uuid }
        : {}),
    },
  });
  write(projectPath, signedProject, 'utf8');
  write(exportOptionsPath, exportOptions, { mode: 0o600, flag: 'wx' });
  return { app, extension, notificationService };
}

/**
 * Cargo `[env]` for a device build. `liveActivity` sets
 * STATION_IOS_LIVE_ACTIVITY, the plugin half of the Live Activity switch
 * (plugins/agent-activity/build.rs); Xcode runs cargo without the shell's
 * environment, so it travels as cargo config like the endpoint.
 *
 * @param {string} [endpoint]
 * @param {{ liveActivity?: boolean }} [options]
 */
export function mobileCargoConfig(endpoint, { liveActivity = false } = {}) {
  const liveActivityLine = liveActivity
    ? 'STATION_IOS_LIVE_ACTIVITY = { value = "1", force = true }\n'
    : '';
  if (!endpoint) return liveActivityLine ? `[env]\n${liveActivityLine}` : '';
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error('Mobile endpoint must be an HTTPS origin.');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  )
    throw new Error('Mobile endpoint must be an HTTPS origin or URL.');
  return `[env]\nSTATION_MOBILE_DEFAULT_ENDPOINT = { value = ${JSON.stringify(parsed.origin)}, force = true }\n${liveActivityLine}`;
}

if (invokedDirectly(import.meta.url) && process.argv[2] === 'agent-activity') {
  const values = parseAgentActivityOptions(process.argv.slice(3));
  const { app, extension, notificationService } = writeIosAgentActivitySigning({
    profile: values['extension-profile'],
    appProfile: values['app-profile'],
    identity: values.identity,
    team: values.team,
    appBundleId: values['app-bundle-id'],
    apsEnvironment: values['aps-environment'],
    project: values.project,
    exportOptionsOutput: values['export-options-output'],
    notificationServiceProfile: values['notification-service-profile'],
  });
  process.stdout.write(
    `${JSON.stringify({ app: app.uuid, extension: extension.uuid, ...(notificationService ? { notificationService: notificationService.uuid } : {}) })}\n`,
  );
} else if (invokedDirectly(import.meta.url)) {
  const values = parseOptions(process.argv.slice(2));
  writeIosStoreSigningConfig({
    profile: values.profile,
    identity: values.identity,
    team: values.team,
    bundleId: values['bundle-id'],
    template: values.template,
    templateOutput: values['template-output'],
    overlayOutput: values['overlay-output'],
  });
}
