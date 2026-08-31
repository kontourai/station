/**
 * Build identity for the daily nightly channel.
 *
 * "Nightly" is a claim about cadence, so it is derived from a date and not
 * from a push. One build per day, and a day with no new commit produces no
 * build at all — a new version number over identical content is a version
 * number that lies.
 *
 * The nightly ships under its own applicationId (station#2211). That keeps
 * two things apart that would otherwise be permanently entangled: Play
 * version codes are monotonic forever per application, and Tauri's default
 * derivation for the production app (major*1e6 + minor*1e3 + patch, so 0.1.0
 * is 1000) sits far below any date-derived code. Sharing one listing would
 * mean a nightly outranking production and production numbering having to be
 * reworked to stay ahead of it for good.
 */

/** Tauri/Play ceiling for an Android version code. */
export const MAX_ANDROID_VERSION_CODE = 2_100_000_000;

/**
 * Day zero for the nightly counter. Deliberately recent and deliberately not
 * a YYYYMMDD encoding: 2026-08-09 as YYYYMMDDNN is 2_026_080_900, which is
 * 96% of the ceiling and leaves no room for any future scheme to supersede
 * it — and a version code can never be lowered.
 */
const EPOCH_UTC = Date.UTC(2020, 0, 1);
const MS_PER_DAY = 86_400_000;

/** Room for 100 builds in a single day before the next day's code is reached. */
export const NIGHTLY_BUILDS_PER_DAY = 100;

/**
 * Permanent prefix for immutable reservations made before an Android build.
 *
 * A signed artifact can be installed or uploaded after its workflow fails, so
 * treating failed builds as reusable is not safe. These tags are an append-only
 * ledger rather than a record of only successful Play edits.
 */
// Keep this a sibling of the rolling `nightly` tag. Git stores refs as paths,
// so `refs/tags/nightly/version-code/*` cannot coexist with
// `refs/tags/nightly` (the latter is already a leaf ref).
export const NIGHTLY_VERSION_CODE_TAG_PREFIX =
  'refs/tags/nightly-version-code/';

/**
 * The first reservation rollout follows an already-published 2026-08-24
 * artifact (242702). It has no immutable reservation tag because the old
 * workflow did not create one. Keeping this floor forever is safe: date-based
 * codes naturally exceed it after that day, while a clock rollback fails
 * closed instead of regressing the Play version-code line.
 */
export const NIGHTLY_PUBLISHED_VERSION_CODE_FLOOR = 242_702;
export const NIGHTLY_PRODUCT_NAME = 'Station Nightly';

function assertDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime()))
    throw new Error('nightly identity requires a valid Date');
  return date;
}

/** Whole UTC days since the epoch above. Strictly increasing, forever. */
export function nightlyDayNumber(date) {
  const day = Math.floor((assertDate(date).getTime() - EPOCH_UTC) / MS_PER_DAY);
  if (day < 0) throw new Error('nightly identity predates its epoch');
  return day;
}

/**
 * Monotonic Android version code. `build` distinguishes a re-run on the same
 * day; the day number alone would collide and Play rejects a reused code.
 */
export function nightlyVersionCode(date, build = 0) {
  if (!Number.isInteger(build) || build < 0 || build >= NIGHTLY_BUILDS_PER_DAY)
    throw new Error(
      `nightly build index must be 0..${NIGHTLY_BUILDS_PER_DAY - 1}`,
    );
  const code = nightlyDayNumber(date) * NIGHTLY_BUILDS_PER_DAY + build;
  if (code > MAX_ANDROID_VERSION_CODE)
    throw new Error('nightly version code exceeds the Android ceiling');
  return code;
}

/**
 * Parses refs emitted by `git ls-remote --refs origin
 * refs/tags/nightly-version-code/*`. Malformed entries are rejected rather
 * than ignored: silently skipping an unfamiliar reservation would make a
 * future allocation capable of reusing a version code.
 */
export function parseNightlyVersionCodeReservations(refs) {
  if (typeof refs !== 'string')
    throw new Error('nightly version-code reservations must be text');

  const reservations = new Set();
  for (const rawLine of refs.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const ref = line.includes('\t')
      ? line.slice(line.lastIndexOf('\t') + 1)
      : line;
    if (!ref.startsWith(NIGHTLY_VERSION_CODE_TAG_PREFIX))
      throw new Error(`unexpected nightly reservation ref: ${ref}`);
    const rawCode = ref.slice(NIGHTLY_VERSION_CODE_TAG_PREFIX.length);
    if (!/^(0|[1-9]\d*)$/.test(rawCode))
      throw new Error(`invalid nightly version-code reservation: ${ref}`);
    const code = Number(rawCode);
    if (
      !Number.isSafeInteger(code) ||
      code < 0 ||
      code > MAX_ANDROID_VERSION_CODE
    )
      throw new Error(`invalid nightly version-code reservation: ${ref}`);
    reservations.add(code);
  }
  return [...reservations].sort((a, b) => a - b);
}

/**
 * Validates the optional manual rebuild index before a workflow reserves
 * physical-host capacity. The empty dispatch value means "choose the next
 * monotonic index automatically"; it is not an implicit rebuild request.
 */
export function parseNightlyRebuildIndex(rebuildIndex) {
  if (
    rebuildIndex === undefined ||
    rebuildIndex === null ||
    rebuildIndex === ''
  )
    return undefined;
  if (typeof rebuildIndex !== 'number' && typeof rebuildIndex !== 'string') {
    throw new Error('nightly rebuild index must be an integer');
  }
  const text = String(rebuildIndex);
  if (!/^(0|[1-9]\d*)$/.test(text))
    throw new Error('nightly rebuild index must be an integer');
  const build = Number(text);
  // Keep the public range check in nightlyVersionCode, which is also the
  // authoritative bound for direct callers.
  try {
    nightlyVersionCode(new Date(EPOCH_UTC), build);
  } catch {
    throw new Error(
      `nightly rebuild index must be 0..${NIGHTLY_BUILDS_PER_DAY - 1}`,
    );
  }
  return build;
}

/**
 * Distinguishes the GitHub Actions archive receipt from the independent Play
 * publication result. A successful upload without an artifact ID is not
 * evidence that a downloadable archive exists.
 */
export function classifyNightlyArtifactArchive({ outcome, artifactId }) {
  if (outcome === 'success' && typeof artifactId === 'string' && artifactId) {
    return {
      annotation: 'notice',
      message:
        'Signed Nightly artifacts were retained by this workflow archive.',
    };
  }
  if (outcome === 'success') {
    return {
      annotation: 'warning',
      message:
        'Nightly artifact upload completed without an artifact ID. Workflow artifact availability is NOT_VERIFIED.',
    };
  }
  if (outcome === 'skipped') {
    return {
      annotation: 'notice',
      message:
        'Nightly artifact archive was skipped. Workflow artifact availability is NOT_VERIFIED.',
    };
  }
  return {
    annotation: 'warning',
    message: `Signed Nightly artifact archive was not retained (upload outcome: ${String(outcome)}). Do not claim a workflow artifact is available; Play publication is a separate outcome.`,
  };
}

/**
 * Selects an Android version code that is strictly above every durable
 * reservation and the one pre-reservation published code. A supplied manual
 * build is an explicit upward choice, never permission to reuse a lower code.
 *
 * @param {{
 *   date: Date;
 *   requestedBuild?: number | string | null;
 *   reservedVersionCodes?: number[];
 *   publishedVersionCodeFloor?: number;
 * }} options
 */
/**
 * The parameter object is declared rather than left to inference: an inferred
 * shape types `reservedVersionCodes` from its `[]` default as `never[]` and
 * makes every defaulted field non-optional, so a caller passing only `date`
 * (or a real reservation list) is rejected. TS2345/TS2322 under
 * `typecheck:scripts`, invisible to a bare `tsc --noEmit`.
 *
 * @param {{
 *   date: Date,
 *   requestedBuild?: number | string,
 *   reservedVersionCodes?: number[],
 *   publishedVersionCodeFloor?: number,
 * }} input
 */
export function allocateNightlyVersionCode({
  date,
  requestedBuild,
  reservedVersionCodes = [],
  publishedVersionCodeFloor = NIGHTLY_PUBLISHED_VERSION_CODE_FLOOR,
}) {
  if (!Array.isArray(reservedVersionCodes))
    throw new Error('nightly version-code reservations must be an array');
  if (
    !Number.isSafeInteger(publishedVersionCodeFloor) ||
    publishedVersionCodeFloor < 0 ||
    publishedVersionCodeFloor > MAX_ANDROID_VERSION_CODE
  ) {
    throw new Error('nightly published version-code floor is invalid');
  }

  const reservations = reservedVersionCodes.map((code) => {
    if (
      !Number.isSafeInteger(code) ||
      code < 0 ||
      code > MAX_ANDROID_VERSION_CODE
    ) {
      throw new Error('nightly version-code reservation is invalid');
    }
    return code;
  });
  const highestReservedCode = Math.max(
    publishedVersionCodeFloor,
    ...reservations,
  );
  const firstCode = nightlyVersionCode(date, 0);
  const lastCode = nightlyVersionCode(date, NIGHTLY_BUILDS_PER_DAY - 1);
  if (highestReservedCode >= lastCode) {
    throw new Error(
      `nightly version-code allocation exhausted or would regress: latest reservation is ${highestReservedCode}`,
    );
  }

  const manualBuild = parseNightlyRebuildIndex(requestedBuild);
  const build = manualBuild ?? Math.max(0, highestReservedCode - firstCode + 1);
  const versionCode = nightlyVersionCode(date, build);
  if (versionCode <= highestReservedCode) {
    throw new Error(
      `nightly requested build ${build} would reuse or regress version code ${versionCode}; latest reservation is ${highestReservedCode}`,
    );
  }

  return {
    build,
    versionCode,
    reservationTag: `${NIGHTLY_VERSION_CODE_TAG_PREFIX}${versionCode}`,
  };
}

import { readFileSync, writeFileSync } from 'node:fs';
import { assertProductVersion } from '../product-version.mjs';
import { updaterPluginConfig } from './native-release-config.mjs';

/**
 * SemVer-valid marketing version. The prerelease segment carries the same day
 * number as the version code, so a build's two identities cannot drift.
 */
export function nightlyVersion(packageVersion, date, build = 0) {
  try {
    assertProductVersion(packageVersion);
  } catch {
    throw new Error(
      `nightly base version must be MAJOR.MINOR.PATCH, received ${String(packageVersion)}`,
    );
  }
  // Validate the index through the same authority that allocates numeric
  // versions. The first nightly keeps its long-standing day-only SemVer,
  // while a same-day rebuild must sort strictly after it for the updater.
  nightlyVersionCode(date, build);
  const day = nightlyDayNumber(date);
  return build === 0
    ? `${packageVersion}-nightly.${day}`
    : `${packageVersion}-nightly.${day}.${build}`;
}

/** A distinct application, not a variant of the production one. */
export function nightlyIdentifier(productionIdentifier) {
  if (
    typeof productionIdentifier !== 'string' ||
    productionIdentifier.trim().length === 0
  )
    throw new Error('nightly identifier requires the production identifier');
  if (productionIdentifier.endsWith('.nightly'))
    throw new Error('production identifier is already a nightly identifier');
  return `${productionIdentifier}.nightly`;
}

/**
 * Tauri config overlay for one nightly build. Written to a temp file and
 * passed to `tauri android build --config`, so nothing in the tracked
 * `tauri.conf.json` changes.
 */
export function createNightlyConfig({
  packageVersion,
  productionIdentifier,
  date,
  build = 0,
}) {
  const versionCode = nightlyVersionCode(date, build);
  return {
    productName: NIGHTLY_PRODUCT_NAME,
    version: nightlyVersion(packageVersion, date, build),
    identifier: nightlyIdentifier(productionIdentifier),
    bundle: {
      android: { versionCode },
      macOS: { bundleVersion: String(versionCode) },
    },
  };
}

/**
 * Tauri config overlay for the desktop nightly leg: the same
 * `nightlyVersion()`/`nightlyIdentifier()` identity as the Android build (so
 * both artifacts shipped from one day carry the same version string), plus
 * the updater plugin's config fields (pubkey, endpoints) that a built app
 * reads to find its rolling-prerelease manifest. The desktop runtime (#575)
 * registers `tauri-plugin-updater` only when both fields are present and
 * non-empty, which this overlay always supplies together — so a nightly
 * build DOES consume these fields; stable/beta builds carry the pubkey alone
 * today and stay inert until each also gets an endpoint.
 * There is no Android-style version-code reservation here: Tauri's updater
 * orders releases by the SemVer `version` string, not a numeric build
 * index, so this needs no monotonic allocation. macOS still requires a
 * numeric CFBundleVersion, so the desktop config derives the deterministic
 * code through the same `nightlyVersionCode()` authority and the cohort's
 * reserved build index.
 *
 * The parameter object is declared rather than left to inference, for the
 * same TS2345 reason documented on `allocateNightlyVersionCode` above: an
 * inferred shape makes `updaterEndpoint` non-optional and rejects a caller
 * that omits it.
 *
 * @param {{
 *   packageVersion: string,
 *   productionIdentifier: string,
 *   date: Date,
 *   build?: number,
 *   updaterPublicKey: string,
 *   updaterEndpoint?: string,
 * }} input
 */
export function createNightlyDesktopConfig({
  packageVersion,
  productionIdentifier,
  date,
  build = 0,
  updaterPublicKey,
  updaterEndpoint,
}) {
  const { createUpdaterArtifacts, plugins } = updaterPluginConfig(
    updaterPublicKey,
    updaterEndpoint,
  );
  return {
    productName: NIGHTLY_PRODUCT_NAME,
    version: nightlyVersion(packageVersion, date, build),
    identifier: nightlyIdentifier(productionIdentifier),
    bundle: {
      createUpdaterArtifacts,
      macOS: { bundleVersion: String(nightlyVersionCode(date, build)) },
    },
    plugins,
  };
}

// Inherited as-is (station#575 fix round L3): tauri-updater-manifest.mjs's
// sibling `option()` now refuses a value that is itself another flag; this
// copy is left unchanged here since every caller in this file already
// requires every flag it reads, so a swallowed `--flag` value surfaces as a
// clear "Usage:" error rather than silently shifting arguments.
function option(name, args) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
}

/**
 * Writes one ephemeral desktop Nightly overlay from the stable checked-in
 * authority and the caller-supplied updater material.
 *
 * @param {{
 *   packageJsonPath: string,
 *   tauriConfigPath: string,
 *   date: string,
 *   build?: number,
 *   updaterPublicKey: string,
 *   updaterEndpoint?: string,
 *   outputPath: string,
 *   githubOutput?: string,
 * }} input
 */
export function writeNightlyDesktopConfig({
  packageJsonPath,
  tauriConfigPath,
  date,
  build = 0,
  updaterPublicKey,
  updaterEndpoint,
  outputPath,
  githubOutput = undefined,
}) {
  const packageVersion = JSON.parse(
    readFileSync(packageJsonPath, 'utf8'),
  ).version;
  const productionIdentifier = JSON.parse(
    readFileSync(tauriConfigPath, 'utf8'),
  ).identifier;
  const config = createNightlyDesktopConfig({
    packageVersion,
    productionIdentifier,
    date: new Date(date),
    build,
    updaterPublicKey,
    updaterEndpoint,
  });
  writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  if (githubOutput) {
    writeFileSync(
      githubOutput,
      `${[
        `version=${config.version}`,
        `identifier=${config.identifier}`,
        `product_name=${config.productName}`,
        `bundle_version=${config.bundle.macOS.bundleVersion}`,
      ].join('\n')}\n`,
      { flag: 'a' },
    );
  }
  return config;
}

/** Writes one ephemeral Nightly overlay from the stable checked-in authority. */
export function writeNightlyConfig({
  packageJsonPath,
  tauriConfigPath,
  date,
  build,
  outputPath,
  githubOutput = undefined,
}) {
  const packageVersion = JSON.parse(
    readFileSync(packageJsonPath, 'utf8'),
  ).version;
  const productionIdentifier = JSON.parse(
    readFileSync(tauriConfigPath, 'utf8'),
  ).identifier;
  const config = createNightlyConfig({
    packageVersion,
    productionIdentifier,
    date: new Date(date),
    build: Number(build),
  });
  writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  if (githubOutput) {
    writeFileSync(
      githubOutput,
      `${[
        `version=${config.version}`,
        `identifier=${config.identifier}`,
        `product_name=${config.productName}`,
        `version_code=${config.bundle.android.versionCode}`,
        `bundle_version=${config.bundle.macOS.bundleVersion}`,
      ].join('\n')}\n`,
      { flag: 'a' },
    );
  }
  return config;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const packageJsonPath = option('package-json', args);
  const tauriConfigPath = option('tauri-config', args);
  const date = option('date', args);
  const outputPath = option('output', args);
  if (args.includes('--desktop')) {
    const updaterPublicKeyFile = option('updater-public-key-file', args);
    if (
      !packageJsonPath ||
      !tauriConfigPath ||
      !date ||
      !outputPath ||
      !updaterPublicKeyFile
    ) {
      throw new Error(
        'Usage: nightly-build-identity.mjs --desktop --package-json <path> --tauri-config <path> --date <ISO-8601> --output <path> --updater-public-key-file <path> [--updater-endpoint <url>] [--github-output <path>]',
      );
    }
    const config = writeNightlyDesktopConfig({
      packageJsonPath,
      tauriConfigPath,
      date,
      updaterPublicKey: readFileSync(updaterPublicKeyFile, 'utf8'),
      updaterEndpoint: option('updater-endpoint', args),
      build: Number(option('build', args) ?? 0),
      outputPath,
      githubOutput: option('github-output', args),
    });
    console.log(
      `Nightly desktop identity ${config.version} (${config.identifier})`,
    );
  } else {
    const build = option('build', args);
    if (
      !packageJsonPath ||
      !tauriConfigPath ||
      !date ||
      build === undefined ||
      !outputPath
    ) {
      throw new Error(
        'Usage: nightly-build-identity.mjs --package-json <path> --tauri-config <path> --date <ISO-8601> --build <index> --output <path> [--github-output <path>]',
      );
    }
    const config = writeNightlyConfig({
      packageJsonPath,
      tauriConfigPath,
      date,
      build,
      outputPath,
      githubOutput: option('github-output', args),
    });
    console.log(
      `Nightly identity ${config.version} (${config.identifier}, Android ${config.bundle.android.versionCode})`,
    );
  }
}
