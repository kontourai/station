import { readFileSync } from 'node:fs';
import { invokedDirectly } from './lib/module-entry.mjs';

function text(value, label) {
  if (typeof value !== 'string' || !value) {
    throw new Error(`Exported iOS entitlements have no ${label}.`);
  }
  return value;
}

function assertObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Exported iOS entitlements must be a JSON object.');
  }
}

function sameList(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((item, index) => item === expected[index])
  );
}

/**
 * The app's exported entitlements. Without `liveActivity` the app may carry
 * only its default keychain group and no shared group. With it (a build that
 * embeds the Live Activity widget, #2513), the app must carry exactly its
 * default group then the one it shares with the widget, in that order (the
 * plugin derives the shared group from the first), and APNs must be
 * `apsEnvironment` — the environment the build wrote, never inferred here.
 *
 * @param {unknown} value
 * @param {{ team: string, bundleId: string, liveActivity?: boolean, apsEnvironment?: string }} options
 */
export function inspectExportedIosEntitlements(
  value,
  { team, bundleId, liveActivity = false, apsEnvironment },
) {
  assertObject(value);
  if (liveActivity && !apsEnvironment)
    throw new Error(
      'A Live Activity build names the APNs environment it exported.',
    );
  const expectedApplicationIdentifier = `${team}.${bundleId}`;
  const applicationIdentifier = text(
    value['application-identifier'],
    'application-identifier',
  );
  if (applicationIdentifier !== expectedApplicationIdentifier) {
    throw new Error(
      `Exported iOS application-identifier mismatch: expected ${expectedApplicationIdentifier}, got ${applicationIdentifier}.`,
    );
  }
  const teamIdentifier = text(
    value['com.apple.developer.team-identifier'],
    'com.apple.developer.team-identifier',
  );
  if (teamIdentifier !== team) {
    throw new Error(
      `Exported iOS team identifier mismatch: expected ${team}, got ${teamIdentifier}.`,
    );
  }
  const keychainAccessGroups = value['keychain-access-groups'];
  if (liveActivity) {
    const expectedGroups = [
      expectedApplicationIdentifier,
      `${expectedApplicationIdentifier}.agentactivity`,
    ];
    if (!sameList(keychainAccessGroups, expectedGroups))
      throw new Error(
        `Exported iOS keychain access groups must be exactly [${expectedGroups.join(', ')}] in a Live Activity build.`,
      );
    if (value['aps-environment'] !== apsEnvironment)
      throw new Error(
        `Exported iOS aps-environment must be ${apsEnvironment}, got ${value['aps-environment'] ?? '(absent)'}.`,
      );
  } else if (
    keychainAccessGroups !== undefined &&
    (!Array.isArray(keychainAccessGroups) ||
      keychainAccessGroups.length !== 1 ||
      keychainAccessGroups[0] !== expectedApplicationIdentifier)
  ) {
    throw new Error(
      `Exported iOS keychain access groups must be absent or exactly [${expectedApplicationIdentifier}].`,
    );
  }
  if (value['com.apple.security.application-groups'] !== undefined) {
    throw new Error(
      'Exported iOS entitlements contain an unexpected shared application group.',
    );
  }
  return {
    applicationIdentifier,
    teamIdentifier,
    keychainAccessGroups: keychainAccessGroups ?? null,
    sharedApplicationGroups: null,
    ...(liveActivity ? { apsEnvironment: value['aps-environment'] } : {}),
  };
}

/**
 * The Live Activity widget extension's exported entitlements: its own
 * application identifier (`<app>.AgentActivity`) and ONLY the keychain group
 * the app shares with it — no default group, no push, no app group.
 *
 * @param {unknown} value
 * @param {{ team: string, appBundleId: string }} options
 */
export function inspectExportedIosAgentActivityEntitlements(
  value,
  { team, appBundleId },
) {
  assertObject(value);
  const expectedApplicationIdentifier = `${team}.${appBundleId}.AgentActivity`;
  const applicationIdentifier = text(
    value['application-identifier'],
    'application-identifier',
  );
  if (applicationIdentifier !== expectedApplicationIdentifier)
    throw new Error(
      `Exported Live Activity application-identifier mismatch: expected ${expectedApplicationIdentifier}, got ${applicationIdentifier}.`,
    );
  const teamIdentifier = text(
    value['com.apple.developer.team-identifier'],
    'com.apple.developer.team-identifier',
  );
  if (teamIdentifier !== team)
    throw new Error(
      `Exported Live Activity team identifier mismatch: expected ${team}, got ${teamIdentifier}.`,
    );
  const sharedGroup = `${team}.${appBundleId}.agentactivity`;
  if (!sameList(value['keychain-access-groups'], [sharedGroup]))
    throw new Error(
      `Exported Live Activity keychain access groups must be exactly [${sharedGroup}].`,
    );
  if (value['aps-environment'] !== undefined)
    throw new Error('The Live Activity extension must not carry push.');
  if (value['com.apple.security.application-groups'] !== undefined)
    throw new Error(
      'Exported Live Activity entitlements contain an unexpected shared application group.',
    );
  return {
    applicationIdentifier,
    teamIdentifier,
    keychainAccessGroups: [sharedGroup],
  };
}

const USAGE =
  'Usage: ios-exported-entitlements.mjs ENTITLEMENTS_JSON TEAM BUNDLE_ID [--live-activity APS_ENVIRONMENT | --agent-activity-extension]';

/**
 * The CLI's verdict for argv (after the script path); throws on refusal.
 *
 * @param {string[]} args
 * @param {(path: string, encoding: 'utf8') => string} [read]
 */
export function exportedEntitlementsCli(
  args,
  read = (path, encoding) => readFileSync(path, encoding),
) {
  const [path, team, bundleId, mode, apsEnvironment, ...rest] = args;
  if (!path || !team || !bundleId || rest.length) throw new Error(USAGE);
  const entitlements = JSON.parse(read(path, 'utf8'));
  if (mode === undefined)
    return inspectExportedIosEntitlements(entitlements, { team, bundleId });
  if (mode === '--live-activity' && apsEnvironment)
    return inspectExportedIosEntitlements(entitlements, {
      team,
      bundleId,
      liveActivity: true,
      apsEnvironment,
    });
  if (mode === '--agent-activity-extension' && apsEnvironment === undefined)
    return inspectExportedIosAgentActivityEntitlements(entitlements, {
      team,
      appBundleId: bundleId,
    });
  throw new Error(USAGE);
}

if (invokedDirectly(import.meta.url)) {
  process.stdout.write(
    `${JSON.stringify(exportedEntitlementsCli(process.argv.slice(2)), null, 2)}\n`,
  );
}
