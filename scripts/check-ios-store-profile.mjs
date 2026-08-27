import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { existsSync } from 'node:fs';

const APP_STORE_PROFILE_REQUIREMENT =
  'APPLE_PROVISIONING_PROFILE_BASE64 must contain an App Store distribution provisioning profile';
const REQUIRED_PROFILE_KEYS = [
  'UUID',
  'TeamIdentifier',
  'ExpirationDate',
  'Entitlements',
  'AppIDName',
];

function decodeXmlText(text) {
  if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-f]+;)/i.test(text))
    throw new Error('invalid XML entity');
  return text
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'");
}

function parsedProfile(xml) {
  // The gate needs a root dictionary. This compact parser intentionally accepts
  // only plist documents and rejects malformed XML before inspecting keys.
  const wrapper = xml.match(
    /^\s*(?:<\?xml[\s\S]*?\?>\s*)?(?:<!DOCTYPE[\s\S]*?>\s*)?<plist(?:\s+[^<>]*)?>([\s\S]*)<\/plist>\s*$/,
  );
  if (!wrapper || xml.includes('\0')) throw new Error('not an XML plist');
  const content = wrapper[1].trim();
  if (!content.startsWith('<dict'))
    throw new Error('plist root is not a dictionary');
  // Convert just the dictionary into a parseable standalone plist value.
  const dict = parseDictionary(content);
  return dict;
}

function parseDictionary(xml) {
  const token =
    /<\/?(?:dict|array|key|string|integer|real|date|data|true|false)(?:\s+[^<>]*)?\s*\/?>|[^<]+/g;
  const tokens = [...xml.matchAll(token)].map((match) => match[0]);
  if (tokens.join('') !== xml) throw new Error('invalid XML');
  let index = 0;
  const whitespace = () => {
    while (/^\s+$/.test(tokens[index] ?? '')) index++;
  };
  const value = () => {
    whitespace();
    const open = tokens[index++];
    const name = open?.match(/^<([\w-]+)/)?.[1];
    if (!name) throw new Error('invalid plist element');
    if (name === 'dict') {
      const result = {};
      while (true) {
        whitespace();
        if (tokens[index] === '</dict>') {
          index++;
          return { type: name, value: result };
        }
        const key = value();
        if (key.type !== 'key' || Object.hasOwn(result, key.value))
          throw new Error('invalid plist dictionary');
        result[key.value] = value().value;
      }
    }
    if (name === 'array') {
      const result = [];
      while (true) {
        whitespace();
        if (tokens[index] === '</array>') {
          index++;
          return { type: name, value: result };
        }
        result.push(value().value);
      }
    }
    if (name === 'true' || name === 'false') {
      if (open.endsWith('/>')) return { type: name, value: name === 'true' };
      if (tokens[index++] !== `</${name}>`)
        throw new Error(`invalid ${name} element`);
      return { type: name, value: name === 'true' };
    }
    if (!['key', 'string', 'integer', 'real', 'date', 'data'].includes(name))
      throw new Error('unsupported plist element');
    const text = tokens[index++];
    if (
      typeof text !== 'string' ||
      text.startsWith('<') ||
      tokens[index++] !== `</${name}>`
    )
      throw new Error(`invalid ${name} element`);
    return { type: name, value: decodeXmlText(text) };
  };
  const root = value();
  whitespace();
  if (root.type !== 'dict' || index !== tokens.length)
    throw new Error('invalid plist document');
  return root.value;
}

/**
 * Fail closed unless a decoded provisioning profile is structurally valid and
 * eligible for App Store Connect.
 */
export function assertAppStoreDistributionProfile(plist, label = 'profile') {
  let profile;
  try {
    profile = parsedProfile(plist);
  } catch {
    throw new Error(
      `Unable to parse ${label} as a decoded provisioning-profile plist; ${APP_STORE_PROFILE_REQUIREMENT}.`,
    );
  }
  const missing = REQUIRED_PROFILE_KEYS.filter(
    (key) => !Object.hasOwn(profile, key),
  );
  if (missing.length) {
    throw new Error(
      `${label} is not a provisioning profile: missing required key(s) ${missing.join(', ')}; ${APP_STORE_PROFILE_REQUIREMENT}.`,
    );
  }
  if (
    typeof profile.UUID !== 'string' ||
    !Array.isArray(profile.TeamIdentifier) ||
    profile.TeamIdentifier.length === 0 ||
    typeof profile.ExpirationDate !== 'string' ||
    !profile.Entitlements ||
    Array.isArray(profile.Entitlements) ||
    typeof profile.Entitlements !== 'object' ||
    typeof profile.AppIDName !== 'string'
  ) {
    throw new Error(
      `${label} is not a provisioning profile: required keys have invalid plist types; ${APP_STORE_PROFILE_REQUIREMENT}.`,
    );
  }
  if (profile.Entitlements?.['get-task-allow'] === true) {
    throw new Error(
      `${label} is a development provisioning profile because get-task-allow is enabled; ${APP_STORE_PROFILE_REQUIREMENT}.`,
    );
  }
  if (Object.hasOwn(profile, 'ProvisionedDevices')) {
    throw new Error(
      `${label} has ProvisionedDevices and is an ad-hoc/development provisioning profile, not an App Store distribution profile; ${APP_STORE_PROFILE_REQUIREMENT}.`,
    );
  }
  if (profile.ProvisionsAllDevices === true) {
    throw new Error(
      `${label} is a managed enterprise provisioning profile (ProvisionsAllDevices is enabled), not an App Store distribution profile; ${APP_STORE_PROFILE_REQUIREMENT}.`,
    );
  }
  return { distribution: 'app-store-connect' };
}

/**
 * Extends the release gate with the facts a local operator must bind before
 * creating an archive. It deliberately reads only the decoded profile plist;
 * it never imports a certificate or accesses private-key material.
 *
 * The options are declared here because TypeScript infers this parameter's
 * shape from the DEFAULTS alone: `expectedTeam` and `expectedBundleIdentifier`
 * have none, so they were dropped from the inferred type while the body still
 * read them — every caller passing one was a type error even though the
 * option works.
 *
 * @param {unknown} plist
 * @param {{
 *   label?: string,
 *   expectedTeam?: string,
 *   expectedBundleIdentifier?: string,
 *   now?: Date,
 * }} [options]
 */
export function inspectAppStoreDistributionProfile(
  plist,
  {
    label = 'profile',
    expectedTeam,
    expectedBundleIdentifier,
    now = new Date(),
  } = {},
) {
  assertAppStoreDistributionProfile(plist, label);
  const profile = parsedProfile(plist);
  const team = profile.TeamIdentifier[0];
  const parseDate = (value, key) => {
    if (
      typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)
    )
      throw new Error(`${label} has an invalid ${key}.`);
    const date = new Date(value);
    if (Number.isNaN(date.valueOf()))
      throw new Error(`${label} has an invalid ${key}.`);
    return date;
  };
  const creation = parseDate(profile.CreationDate, 'CreationDate');
  const expiration = parseDate(profile.ExpirationDate, 'ExpirationDate');
  if (
    Number.isNaN(creation.valueOf()) ||
    creation > now ||
    creation > expiration
  ) {
    throw new Error(
      `${label} has an invalid, future, or post-expiry CreationDate.`,
    );
  }
  if (Number.isNaN(expiration.valueOf()) || expiration <= now) {
    throw new Error(`${label} is expired or has an invalid ExpirationDate.`);
  }
  if (expectedTeam && team !== expectedTeam) {
    throw new Error(
      `${label} team ${team} does not match expected team ${expectedTeam}.`,
    );
  }
  const applicationIdentifier = profile.Entitlements['application-identifier'];
  const entitlementTeam =
    profile.Entitlements['com.apple.developer.team-identifier'];
  if (
    typeof entitlementTeam !== 'string' ||
    entitlementTeam !== team ||
    (expectedTeam && entitlementTeam !== expectedTeam)
  ) {
    throw new Error(
      `${label} entitlement team ${entitlementTeam} does not match provisioning-profile team ${team}.`,
    );
  }
  const certificates = profile.DeveloperCertificates;
  if (!Array.isArray(certificates) || certificates.length === 0) {
    throw new Error(`${label} has no DeveloperCertificates.`);
  }
  const certificateFingerprints = certificates.map((certificate) => {
    if (typeof certificate !== 'string')
      throw new Error(`${label} has an invalid DeveloperCertificates entry.`);
    const der = Buffer.from(certificate, 'base64');
    try {
      const parsed = new X509Certificate(der);
      if (new Date(parsed.validFrom) > now || new Date(parsed.validTo) <= now)
        throw new Error('certificate is outside its validity period');
    } catch {
      throw new Error(
        `${label} has a malformed or invalid public DeveloperCertificates entry.`,
      );
    }
    return createHash('sha1').update(der).digest('hex').toUpperCase();
  });
  const expectedApplicationIdentifier =
    expectedTeam && expectedBundleIdentifier
      ? `${expectedTeam}.${expectedBundleIdentifier}`
      : undefined;
  if (
    expectedApplicationIdentifier &&
    applicationIdentifier !== expectedApplicationIdentifier
  ) {
    throw new Error(
      `${label} application-identifier ${applicationIdentifier} does not match expected ${expectedApplicationIdentifier}.`,
    );
  }
  return {
    distribution: 'app-store-connect',
    uuid: profile.UUID,
    team,
    expiration: expiration.toISOString(),
    applicationIdentifier,
    certificateFingerprints,
  };
}

export function decodeProvisioningProfile(profilePath, run = execFileSync) {
  if (!existsSync(profilePath)) {
    throw new Error(
      `Missing embedded.mobileprovision at ${profilePath}; cannot verify App Store distribution.`,
    );
  }
  try {
    return run('security', ['cms', '-D', '-i', profilePath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error(
      `Unable to decode embedded.mobileprovision at ${profilePath} with security cms; cannot verify App Store distribution.`,
    );
  }
}

export function verifyAppStoreProvisioningProfile(profilePath, label) {
  return assertAppStoreDistributionProfile(
    decodeProvisioningProfile(profilePath),
    label,
  );
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const profileIndex = process.argv.indexOf('--profile');
  const labelIndex = process.argv.indexOf('--label');
  const profilePath = process.argv[profileIndex + 1];
  if (profileIndex < 0 || !profilePath)
    throw new Error('Expected --profile <path>');
  const label = labelIndex >= 0 ? process.argv[labelIndex + 1] : profilePath;
  if (!label) throw new Error('Expected a value after --label');
  console.log(
    JSON.stringify(verifyAppStoreProvisioningProfile(profilePath, label)),
  );
}
