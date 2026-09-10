import { createHash } from 'node:crypto';
import { nightlyVersion } from './nightly-build-identity.mjs';
import { updaterPluginConfig } from './native-release-config.mjs';
import { createUpdaterManifestForPlatforms } from './tauri-updater-manifest.mjs';

export const WINDOWS_NIGHTLY_PLATFORM = 'windows-x86_64';
export const NIGHTLY_DESKTOP_ENDPOINT =
  'https://github.com/kontourai/station/releases/download/nightly-desktop/latest.json';

/** The shared reservation also supplies a strictly increasing MSI version. */
export function createWindowsNightlyConfig({
  packageVersion,
  bundleVersion,
  updaterPublicKey,
}) {
  const code = Number(bundleVersion);
  if (!Number.isSafeInteger(code) || code < 1 || code > 16777215) {
    throw new Error(
      'Windows Nightly requires a reserved bundle version in 1..16777215',
    );
  }
  const day = Math.floor(code / 100);
  const build = code % 100;
  const date = new Date(Date.UTC(2020, 0, 1) + day * 86400000);
  const updater = updaterPublicKey
    ? updaterPluginConfig(updaterPublicKey, NIGHTLY_DESKTOP_ENDPOINT)
    : { createUpdaterArtifacts: false, plugins: {} };
  return {
    productName: 'Station Nightly',
    identifier: 'io.kontourai.station.nightly',
    version: nightlyVersion(packageVersion, date, build),
    bundle: {
      targets: ['msi'],
      createUpdaterArtifacts: updater.createUpdaterArtifacts,
      windows: {
        // MSI compares only three numeric fields. Encoding the reservation
        // here avoids dropping the SemVer prerelease and rejecting upgrades.
        wix: { version: `0.${Math.floor(code / 65536)}.${code % 65536}` },
      },
    },
    plugins: updater.plugins,
  };
}

/** Compose only current-build entries; never import a prior public feed. */
export function assembleNightlyDesktopManifest({
  version,
  sourceSha,
  pubDate,
  builds,
}) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha ?? ''))
    throw new Error('Invalid source SHA');
  const expected = ['darwin-aarch64', WINDOWS_NIGHTLY_PLATFORM];
  if (!Array.isArray(builds) || builds.length !== expected.length) {
    throw new Error('Both desktop builds are required');
  }
  const platforms = builds.map((build) => {
    if (build.sourceSha !== sourceSha || build.version !== version) {
      throw new Error('Desktop build identity differs from cohort');
    }
    if (!expected.includes(build.platform))
      throw new Error('Unexpected desktop platform');
    if (
      build.platformSigningState !== 'VERIFIED' ||
      build.updaterSigningState !== 'VERIFIED'
    ) {
      throw new Error('Desktop signatures are not verified');
    }
    const name = build.assetName;
    if (
      typeof name !== 'string' ||
      !name.includes(version) ||
      /[/\\]/.test(name)
    ) {
      throw new Error('Desktop asset must have a versioned basename');
    }
    if (
      !Buffer.isBuffer(build.bytes) ||
      !build.bytes.length ||
      createHash('sha256').update(build.bytes).digest('hex') !== build.sha256
    ) {
      throw new Error('Desktop artifact bytes differ from the verified build');
    }
    return {
      platform: build.platform,
      signature: build.signature,
      url: `https://github.com/kontourai/station/releases/download/nightly-desktop/${name}`,
    };
  });
  if (
    new Set(platforms.map(({ platform }) => platform)).size !== expected.length
  ) {
    throw new Error('Duplicate desktop platform');
  }
  return createUpdaterManifestForPlatforms({
    version,
    pubDate,
    notes: `Station Nightly ${version} at ${sourceSha}`,
    releaseTag: 'nightly-desktop',
    platforms,
  });
}
