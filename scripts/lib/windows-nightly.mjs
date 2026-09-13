import { createHash } from 'node:crypto';
import { updaterPluginConfig } from './native-release-config.mjs';
import {
  MAX_ANDROID_VERSION_CODE,
  nightlyVersion,
} from './nightly-build-identity.mjs';
import { createUpdaterManifestForPlatforms } from './tauri-updater-manifest.mjs';

const WINDOWS_NIGHTLY_PLATFORM = 'windows-x86_64';
const NIGHTLY_DESKTOP_ENDPOINT =
  'https://github.com/kontourai/station/releases/download/nightly-desktop/latest.json';

/**
 * Derive the Windows channel identity from the shared Nightly reservation.
 * @param {{packageVersion: string, bundleVersion: number | string, updaterPublicKey?: string}} input
 */
export function createWindowsNightlyConfig({
  packageVersion,
  bundleVersion,
  updaterPublicKey,
}) {
  const code = Number(bundleVersion);
  if (
    !Number.isSafeInteger(code) ||
    code < 1 ||
    code > MAX_ANDROID_VERSION_CODE
  ) {
    throw new Error(
      'Windows Nightly requires a valid reserved native bundle version',
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
    mainBinaryName: 'station-nightly',
    identifier: 'io.kontourai.station.nightly',
    version: nightlyVersion(packageVersion, date, build),
    bundle: {
      targets: ['nsis'],
      createUpdaterArtifacts: Boolean(updaterPublicKey),
      windows: { nsis: { installMode: 'currentUser' } },
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
      !(build.platform === WINDOWS_NIGHTLY_PLATFORM
        ? ['VERIFIED', 'NOT_SIGNED'].includes(build.platformSigningState)
        : build.platformSigningState === 'VERIFIED') ||
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

/** Staging names stay stable; published bytes are never clobbered across versions. */
export function desktopPublishedAssetName(name, version) {
  if (name === 'latest.json') return name;
  if (!name.startsWith('station-nightly-desktop-')) {
    throw new Error(`Unexpected desktop staging asset: ${name}`);
  }
  if (!/^\d+\.\d+\.\d+-nightly\.\d+(?:\.\d+)?$/.test(version)) {
    throw new Error('Invalid desktop Nightly version');
  }
  return name.replace('station-nightly-desktop-', `station-${version}-`);
}

export function assertWindowsNightlyReceipt(receipt, identity, installerBytes) {
  if (
    receipt?.kind !== 'station.windows-nightly-build/v1' ||
    receipt.sourceSha !== identity.sourceSha ||
    receipt.version !== identity.version ||
    receipt.bundleVersion !== Number(identity.bundleVersion) ||
    receipt.platform !== WINDOWS_NIGHTLY_PLATFORM ||
    receipt.installerKind !== 'nsis' ||
    receipt.updaterFormat !== 'tauri-v2' ||
    !['VERIFIED', 'NOT_SIGNED'].includes(receipt.platformSigningState) ||
    receipt.updaterPayloadState !== 'VERIFIED' ||
    !/^[a-f0-9]{64}$/.test(receipt.packagedProvenanceSha256 ?? '') ||
    receipt.installerSha256 !==
      createHash('sha256').update(installerBytes).digest('hex')
  )
    throw new Error(
      'Windows signing and provenance receipt does not bind installer',
    );
}

export function assertWindowsNightlyManifest(
  manifest,
  version,
  signatureBytes,
) {
  const entry = manifest?.platforms?.[WINDOWS_NIGHTLY_PLATFORM];
  const name = desktopPublishedAssetName(
    'station-nightly-desktop-windows-x86_64-setup.exe',
    version,
  );
  if (
    manifest?.version !== version ||
    !manifest.platforms ||
    Object.keys(manifest.platforms).sort().join(',') !==
      'darwin-aarch64,windows-x86_64' ||
    entry?.signature !== Buffer.from(signatureBytes).toString('utf8').trim() ||
    entry?.url !==
      `https://github.com/kontourai/station/releases/download/nightly-desktop/${name}`
  ) {
    throw new Error('Windows updater manifest binding differs');
  }
}
