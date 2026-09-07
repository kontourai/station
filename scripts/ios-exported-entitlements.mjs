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
  const [path, team, bundleId] = process.argv.slice(2);
  if (!path || !team || !bundleId) {
    throw new Error(
      'Usage: ios-exported-entitlements.mjs ENTITLEMENTS_JSON TEAM BUNDLE_ID',
    );
  }
  const entitlements = JSON.parse(readFileSync(path, 'utf8'));
  process.stdout.write(
    `${JSON.stringify(inspectExportedIosEntitlements(entitlements, { team, bundleId }), null, 2)}\n`,
  );
}
