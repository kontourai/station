import { readFileSync, writeFileSync } from 'node:fs';
import { assertProductVersion } from '../product-version.mjs';
import { invokedDirectly } from './module-entry.mjs';
import { parseReleaseTag as parseSharedReleaseTag } from './release-tag.mjs';

export const NATIVE_UPDATER_ARTIFACT_MODE = 'v1Compatible';
export const STABLE_NATIVE_IDENTIFIER = 'io.kontourai.station';
export const STABLE_NATIVE_PRODUCT_NAME = 'Station';
const STABLE_DESKTOP_UPDATER_TAG = 'stable-desktop';
// Store build slot 99 belongs to the final tag; candidates take 1-98.
const FINAL_STORE_SLOT = 99;

function fail(message) {
  throw new Error(`Invalid native release configuration: ${message}`);
}

// A tagged release is either a release candidate (`vX.Y.Z-rc.N`) or a final
// Stable tag (`vX.Y.Z`), parsed by the shared release-tag.mjs. Both build with
// Stable identity and the bare base version so a candidate's exact bytes can
// later be promoted unchanged (#4929).
function parseReleaseTag(tag) {
  let parsed;
  try {
    parsed = parseSharedReleaseTag(tag);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const [major, minor, patch] = parsed.baseVersion.split('.').map(Number);
  return {
    baseVersion: parsed.baseVersion,
    major,
    minor,
    patch,
    kind: parsed.kind,
    candidate: parsed.rc,
  };
}

/**
 * The version every artifact of this tag is built with, and the one
 * package.json must record: the bare base. The `-rc.N` suffix belongs only to
 * the immutable tag, so every candidate and the final tag name the same
 * reviewed base without a source edit between them.
 */
export function repositoryVersionForTag(tag) {
  return parseReleaseTag(tag).baseVersion;
}

/** Tagged releases are always Stable; Beta is retired (#4929). */
export function nativeReleaseChannel(tag) {
  parseReleaseTag(tag);
  return 'stable';
}

export function desktopUpdaterTagForReleaseTag(tag) {
  parseReleaseTag(tag);
  return STABLE_DESKTOP_UPDATER_TAG;
}

export function nativeIdentifierForChannel(channel) {
  if (channel === 'stable') return STABLE_NATIVE_IDENTIFIER;
  fail(`unsupported native release channel ${JSON.stringify(channel)}`);
}

export function nativeProductNameForChannel(channel) {
  if (channel === 'stable') return STABLE_NATIVE_PRODUCT_NAME;
  fail(`unsupported native release channel ${JSON.stringify(channel)}`);
}

/**
 * Store identity for one tagged release. `releaseKind` is `rc` for
 * `vX.Y.Z-rc.N` and `final` for `vX.Y.Z`. Marketing version is the bare base
 * version for both candidates and the final tag. Android `versionCode` and iOS
 * `CFBundleVersion` are the same monotonic integer, in a band that cannot
 * collide with a later tag:
 *   major * 10_000_000 + minor * 10_000 + patch * 100 + slot
 * where slot is the candidate number (1–98) or 99 for the final tag, so every
 * candidate and the final tag of one base are distinct store builds.
 * Nightly (`io.kontourai.station.nightly`) uses a different package and its
 * own day-based numbering; it does not share this space.
 */
export function taggedStoreIdentity(tag) {
  const { baseVersion, major, minor, patch, kind, candidate } =
    parseReleaseTag(tag);
  const slot = candidate ?? FINAL_STORE_SLOT;
  const versionCode = major * 10_000_000 + minor * 10_000 + patch * 100 + slot;
  if (!Number.isSafeInteger(versionCode) || versionCode > 2_100_000_000) {
    fail('derived versionCode exceeds the Android maximum');
  }
  return {
    releaseKind: kind,
    marketingVersion: baseVersion,
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
const GITHUB_RELEASE_ORIGIN = 'https://github.com';
const STATION_RELEASE_DOWNLOAD_ROOT = '/kontourai/station/releases/download';

function assertUpdaterEndpointIdentity(endpoint, updaterTag, tag) {
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    fail('updater endpoint must be a non-empty https URL');
  }
  const expectedPath = `${STATION_RELEASE_DOWNLOAD_ROOT}/${updaterTag}/latest.json`;
  if (
    parsed.origin !== GITHUB_RELEASE_ORIGIN ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== expectedPath ||
    parsed.search !== '' ||
    parsed.hash !== ''
  )
    fail(
      `updater endpoint must be exactly ${GITHUB_RELEASE_ORIGIN}${expectedPath} for tag ${tag}`,
    );
}

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
    if (updaterEndpoint === undefined)
      fail('updater public key requires an updater endpoint');
    const updaterTag = desktopUpdaterTagForReleaseTag(tag);
    assertUpdaterEndpointIdentity(updaterEndpoint, updaterTag, tag);
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
  const repositoryVersion = repositoryVersionForTag(tag);
  if (repositoryVersion !== packageVersion) {
    fail(
      `tag base version ${repositoryVersion} does not match package version ${packageVersion}`,
    );
  }
  assertProductVersion(packageVersion);
  return repositoryVersion;
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

if (invokedDirectly(import.meta.url)) {
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
