import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decodeProvisioningProfile,
  inspectAppStoreDistributionProfile,
} from './check-ios-store-profile.mjs';

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

export function parseOptions(args) {
  args = args.map((argument) =>
    argument === '--station' ? '--profile' : argument,
  );
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.slice(2);
    const value = args[index + 1];
    if (
      !args[index]?.startsWith('--') ||
      !REQUIRED.includes(key) ||
      values[key] ||
      !value ||
      value.startsWith('--')
    )
      throw new Error(
        'Expected every required iOS signing option exactly once with a non-empty value.',
      );
    values[key] = value;
  }
  if (Object.keys(values).length !== REQUIRED.length)
    throw new Error('Missing required iOS signing option.');
  return values;
}

export function storeSigningTemplate({
  template,
  profile,
  identity,
  bundleId = 'io.kontourai.station',
}) {
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
  if (!SUPPORTED_IOS_BUNDLE_IDS.has(bundleId))
    throw new Error(
      'iOS App Store signing only supports reviewed Station bundle IDs.',
    );
  const marker = `      PRODUCT_BUNDLE_IDENTIFIER: ${bundleId}\n`;
  if (template.split(marker).length !== 2)
    throw new Error(
      'iOS project template has no supported app signing marker.',
    );
  return template.replace(
    marker,
    `${marker}      CODE_SIGN_STYLE: Manual\n      CODE_SIGN_IDENTITY: ${JSON.stringify(identity)}\n      DEVELOPMENT_TEAM: ${profile.team}\n      PROVISIONING_PROFILE_SPECIFIER: ${JSON.stringify(profile.uuid)}\n`,
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

export function mobileCargoConfig(endpoint) {
  if (!endpoint) return '';
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
  return `[env]\nSTATION_MOBILE_DEFAULT_ENDPOINT = { value = ${JSON.stringify(parsed.origin)}, force = true }\n`;
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
