import { readFileSync, writeFileSync } from 'node:fs';
import { assertProductVersion } from '../product-version.mjs';

const RELEASE_TAG =
  /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-preview\.(?:[1-9]\d*))?)$/;
export const NATIVE_UPDATER_ARTIFACT_MODE = 'v1Compatible';
export const STABLE_NATIVE_IDENTIFIER = 'io.kontourai.station';
export const BETA_NATIVE_IDENTIFIER = 'io.kontourai.station.beta';
export const STABLE_NATIVE_PRODUCT_NAME = 'Station';
export const BETA_NATIVE_PRODUCT_NAME = 'Station Beta';

function fail(message) {
  throw new Error(`Invalid native release configuration: ${message}`);
}

export function nativeVersionFromTag(tag) {
  const match = typeof tag === 'string' ? RELEASE_TAG.exec(tag) : null;
  if (!match) {
    fail('tag must be vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-preview.N');
  }
  return match[1];
}

/**
 * The repository records the release train's stable base version once. A
 * preview suffix belongs to the immutable release tag/build overlay, not to a
 * source edit between preview and Stable promotion. This lets both tags name
 * the exact same reviewed commit while keeping package.json authoritative for
 * the train being released.
 */
export function repositoryVersionForTag(tag) {
  return nativeVersionFromTag(tag).replace(/-preview\.[1-9]\d*$/, '');
}

export function nativeReleaseChannel(tag) {
  nativeVersionFromTag(tag);
  return tag.includes('-preview.') ? 'beta' : 'stable';
}

export function desktopUpdaterTagForReleaseTag(tag) {
  return nativeReleaseChannel(tag) === 'beta'
    ? 'beta-desktop'
    : 'stable-desktop';
}

export function nativeIdentifierForChannel(channel) {
  if (channel === 'stable') return STABLE_NATIVE_IDENTIFIER;
  if (channel === 'beta') return BETA_NATIVE_IDENTIFIER;
  fail(`unsupported native release channel ${JSON.stringify(channel)}`);
}

export function nativeProductNameForChannel(channel) {
  if (channel === 'stable') return STABLE_NATIVE_PRODUCT_NAME;
  if (channel === 'beta') return BETA_NATIVE_PRODUCT_NAME;
  fail(`unsupported native release channel ${JSON.stringify(channel)}`);
}

/**
 * Store identity for one tagged release. Marketing version is the tag without
 * the leading `v`. Android `versionCode` and iOS `CFBundleVersion` are the same
 * monotonic integer, in a band that cannot collide with a later tag:
 *   major * 10_000_000 + minor * 10_000 + patch * 100 + channel
 * where channel is the preview number (1–98) or 99 for the stable tag.
 * Nightly (`io.kontourai.station.nightly`) uses a different package and its
 * own day-based numbering; it does not share this space.
 */
export function taggedStoreIdentity(tag) {
  const marketingVersion = nativeVersionFromTag(tag);
  const parsed =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-preview\.([1-9]\d*))?$/.exec(
      marketingVersion,
    );
  if (!parsed) {
    fail('tag version could not be parsed after validation');
  }
  const major = Number(parsed[1]);
  const minor = Number(parsed[2]);
  const patch = Number(parsed[3]);
  const preview = parsed[4] === undefined ? null : Number(parsed[4]);
  if (preview !== null && preview > 98) {
    fail('preview number must be 1-98 so it fits the versionCode slot');
  }
  const channel = preview === null ? 99 : preview;
  const versionCode =
    major * 10_000_000 + minor * 10_000 + patch * 100 + channel;
  if (!Number.isSafeInteger(versionCode) || versionCode > 2_100_000_000) {
    fail('derived versionCode exceeds the Android maximum');
  }
  return {
    marketingVersion,
    versionCode,
    bundleVersion: String(versionCode),
  };
}

function storeBundle(identity) {
  return {
    android: { versionCode: identity.versionCode },
    iOS: { bundleVersion: identity.bundleVersion },
    macOS: { bundleVersion: identity.bundleVersion },
  };
}

const HTTPS_URL_PATTERN = /^https:\/\/\S+$/;

/**
 * Tauri updater plugin overlay shared by every channel that ships a signed
 * update artifact. `updaterEndpoint` is optional for version-only overlays;
 * every distributable desktop build stamps both the public key and the
 * endpoint selected for its rolling release channel.
 */
export function updaterPluginConfig(updaterPublicKey, updaterEndpoint) {
  if (
    typeof updaterPublicKey !== 'string' ||
    updaterPublicKey.trim().length === 0
  ) {
    fail('updater public key must be non-empty when provided');
  }
  const updater = { pubkey: updaterPublicKey.trim() };
  if (updaterEndpoint !== undefined) {
    if (
      typeof updaterEndpoint !== 'string' ||
      !HTTPS_URL_PATTERN.test(updaterEndpoint)
    ) {
      fail('updater endpoint must be a non-empty https URL');
    }
    updater.endpoints = [updaterEndpoint];
  }
  return {
    createUpdaterArtifacts: NATIVE_UPDATER_ARTIFACT_MODE,
    plugins: { updater },
  };
}

export function createNativeReleaseConfig({
  tag,
  updaterPublicKey,
  updaterEndpoint,
  channelIdentity = false,
}) {
  const identity = taggedStoreIdentity(tag);
  const channel = nativeReleaseChannel(tag);
  const config = {
    version: identity.marketingVersion,
    bundle: storeBundle(identity),
  };
  // Tauri's root identifier controls both desktop single-instance identity and
  // Android applicationId. iOS intentionally does not opt in: its existing
  // signed App Store identity remains the stable identifier for every tag.
  if (channelIdentity) {
    config.identifier = nativeIdentifierForChannel(channel);
    config.productName = nativeProductNameForChannel(channel);
  }
  if (updaterPublicKey !== undefined) {
    const { createUpdaterArtifacts, plugins } = updaterPluginConfig(
      updaterPublicKey,
      updaterEndpoint,
    );
    return {
      ...config,
      bundle: { ...config.bundle, createUpdaterArtifacts },
      plugins,
    };
  }
  return config;
}

export function assertRepositoryVersion({ tag, packageVersion }) {
  const releaseVersion = nativeVersionFromTag(tag);
  const repositoryVersion = repositoryVersionForTag(tag);
  if (repositoryVersion !== packageVersion) {
    fail(
      `tag base version ${repositoryVersion} does not match package version ${packageVersion}`,
    );
  }
  assertProductVersion(packageVersion);
  return releaseVersion;
}

function option(name, args) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--'))
    fail(`--${name} requires a value`);
  return value;
}

function assertKnownCliArguments(args) {
  const valueOptions = new Set([
    '--tag',
    '--check-package-json',
    '--output',
    '--updater-public-key-file',
    '--updater-endpoint',
  ]);
  const booleanOptions = new Set([
    '--channel-identity',
    '--print-desktop-updater-tag',
  ]);
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!valueOptions.has(argument) && !booleanOptions.has(argument))
      fail(`unknown argument ${JSON.stringify(argument)}`);
    if (seen.has(argument))
      fail(`argument ${argument} may be supplied only once`);
    seen.add(argument);
    if (valueOptions.has(argument)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--'))
        fail(`${argument} requires a value`);
      index += 1;
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  assertKnownCliArguments(args);
  const tag = option('tag', args) ?? process.env.RELEASE_TAG;
  if (args.includes('--print-desktop-updater-tag')) {
    if (args.length !== 3 || !args.includes('--tag'))
      fail('--print-desktop-updater-tag requires exactly one --tag <tag>');
    process.stdout.write(desktopUpdaterTagForReleaseTag(tag));
    process.exit(0);
  }
  const packageJson = option('check-package-json', args);
  if (packageJson) {
    const packageVersion = JSON.parse(
      readFileSync(packageJson, 'utf8'),
    ).version;
    assertRepositoryVersion({ tag, packageVersion });
  }
  const output = option('output', args);
  if (!output) {
    if (!packageJson) fail('--output is required');
  } else {
    const updaterPublicKeyFile = option('updater-public-key-file', args);
    const updaterPublicKey = updaterPublicKeyFile
      ? readFileSync(updaterPublicKeyFile, 'utf8')
      : undefined;
    const updaterEndpoint = option('updater-endpoint', args);
    if (updaterEndpoint !== undefined && updaterPublicKey === undefined)
      fail('--updater-endpoint requires --updater-public-key-file');
    const config = createNativeReleaseConfig({
      tag,
      updaterPublicKey,
      updaterEndpoint,
      channelIdentity: args.includes('--channel-identity'),
    });
    writeFileSync(output, `${JSON.stringify(config, null, 2)}\n`, {
      mode: 0o600,
    });
  }
}
