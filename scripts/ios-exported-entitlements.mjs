import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function text(value, label) {
  if (typeof value !== 'string' || !value) {
    throw new Error(`Exported iOS entitlements have no ${label}.`);
  }
  return value;
}

export function inspectExportedIosEntitlements(value, { team, bundleId }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Exported iOS entitlements must be a JSON object.');
  }
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
  if (
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
  };
}

/**
 * The Notification Service Extension's exported entitlements (#2590): its
 * own application identifier (`<app>.NotificationService`) and ONLY the
 * keychain group the app shares its registrations through — no default
 * group, no push, no app group.
 *
 * @param {unknown} value
 * @param {{ team: string, appBundleId: string }} options
 */
export function inspectExportedIosNotificationServiceEntitlements(
  value,
  { team, appBundleId },
) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Exported iOS entitlements must be a JSON object.');
  }
  const expectedApplicationIdentifier = `${team}.${appBundleId}.NotificationService`;
  const applicationIdentifier = text(
    value['application-identifier'],
    'application-identifier',
  );
  if (applicationIdentifier !== expectedApplicationIdentifier)
    throw new Error(
      `Exported Notification Service application-identifier mismatch: expected ${expectedApplicationIdentifier}, got ${applicationIdentifier}.`,
    );
  const teamIdentifier = text(
    value['com.apple.developer.team-identifier'],
    'com.apple.developer.team-identifier',
  );
  if (teamIdentifier !== team)
    throw new Error(
      `Exported Notification Service team identifier mismatch: expected ${team}, got ${teamIdentifier}.`,
    );
  const sharedGroup = `${team}.${appBundleId}.agentactivity`;
  const groups = value['keychain-access-groups'];
  if (
    !Array.isArray(groups) ||
    groups.length !== 1 ||
    groups[0] !== sharedGroup
  )
    throw new Error(
      `Exported Notification Service keychain access groups must be exactly [${sharedGroup}].`,
    );
  if (value['aps-environment'] !== undefined)
    throw new Error('The Notification Service extension must not carry push.');
  if (value['com.apple.security.application-groups'] !== undefined)
    throw new Error(
      'Exported Notification Service entitlements contain an unexpected shared application group.',
    );
  return {
    applicationIdentifier,
    teamIdentifier,
    keychainAccessGroups: [sharedGroup],
  };
}

const USAGE =
  'Usage: ios-exported-entitlements.mjs ENTITLEMENTS_JSON TEAM BUNDLE_ID [--notification-service-extension]';

/**
 * The CLI's verdict for argv (after the script path); throws on refusal.
 * With `--notification-service-extension`, BUNDLE_ID is the app's.
 *
 * @param {string[]} args
 * @param {(path: string) => string} [read]
 */
export function exportedEntitlementsCli(
  args,
  read = (path) => readFileSync(path, 'utf8'),
) {
  const [path, team, bundleId, mode, ...rest] = args;
  if (!path || !team || !bundleId || rest.length) throw new Error(USAGE);
  if (mode !== undefined && mode !== '--notification-service-extension')
    throw new Error(USAGE);
  const entitlements = JSON.parse(read(path));
  return mode === undefined
    ? inspectExportedIosEntitlements(entitlements, { team, bundleId })
    : inspectExportedIosNotificationServiceEntitlements(entitlements, {
        team,
        appBundleId: bundleId,
      });
}

function isMainModule() {
  try {
    return (
      process.argv[1] &&
      realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
    );
  } catch {
    return false;
  }
}

if (isMainModule()) {
  process.stdout.write(
    `${JSON.stringify(exportedEntitlementsCli(process.argv.slice(2)), null, 2)}\n`,
  );
}
