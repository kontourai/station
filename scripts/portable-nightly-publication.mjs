#!/usr/bin/env node
// Helpers for the portable server Nightly publication
// (.github/workflows/portable-nightly-publish.yml, #2675 slice E). Signing
// itself is scripts/ecosystem-manifest.mjs `create`; this file owns the
// Nightly identity and binds the ring-generic publication checks
// (scripts/lib/portable-publication.mjs) to the nightly ring:
//
//   version        --marketing-version X.Y.Z --version-code N
//   locations      --repository owner/name --version V   (GITHUB_OUTPUT lines)
//   dry-run-keys   --out-dir D                  (ephemeral key + key table)
//   check-payload  --payload P --version V --source-sha S  (this run's Nightly)
//   check-archives --payload P --archives D     (local bytes are the signed ones)
//   verify         --manifest <file|https URL> --expected-payload P [--keys T]
//   verify-assets  --payload P                  (published bytes are the signed ones)
//   not-regressing --candidate-version V --current <file|https URL> [--keys T]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CHANNEL_VERSION } from '../packages/shared/src/release-manifest.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';
import {
  checkArchives,
  compareRingVersions,
  readManifest,
  assertNotRegressing as ringAssertNotRegressing,
  assertPayloadIdentity as ringAssertPayloadIdentity,
  createDryRunKeys as ringCreateDryRunKeys,
  isStaleRollingManifest as ringIsStaleRollingManifest,
  publicationLocations as ringPublicationLocations,
  verifyExpectedManifest as ringVerifyExpectedManifest,
  verifyManifestLocation,
  verifyPublishedAssets,
} from './lib/portable-publication.mjs';
import { PUBLIC_MANIFEST_POINTERS } from './lib/public-release-locations.mjs';

export {
  checkArchives,
  fetchBytes,
  ManifestMismatchError,
  PORTABLE_LAUNCHER_PROTOCOL,
  verifyPublishedAssets,
} from './lib/portable-publication.mjs';

const RING = 'nightly';
const DEFAULT_KEY_TABLE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../config/release-manifest-keys.json',
);
/** The pinned key id authorized for the nightly ring (config/release-manifest-keys.json). */
export const NIGHTLY_SIGNING_KEY_ID = 'station-portable-nightly-2026-09';
/** A key id no installer pins, so a dry-run envelope can never pass as real. */
export const DRY_RUN_SIGNING_KEY_ID = 'station-portable-nightly-dry-run';
/**
 * The rolling pointer release whose one manifest asset always names the
 * newest Nightly. The owner creates this release; the publication job refuses
 * to run without it rather than creating it. Both names come from
 * scripts/lib/public-release-locations.mjs.
 */
export const ROLLING_NIGHTLY_TAG = PUBLIC_MANIFEST_POINTERS.nightly.rollingTag;
export const NIGHTLY_MANIFEST_ASSET =
  PUBLIC_MANIFEST_POINTERS.nightly.manifestAsset;

const MARKETING_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const VERSION_CODE = /^[1-9]\d*$/;

/**
 * `X.Y.Z-nightly.<code>`: the package's marketing version and the version
 * code the native Nightly reserved (refs/tags/nightly-version-code/<code>),
 * so the portable and native Nightlies of one night share one allocation.
 */
export function portableNightlyVersion(marketingVersion, versionCode) {
  if (
    typeof marketingVersion !== 'string' ||
    !MARKETING_VERSION.test(marketingVersion)
  )
    throw new Error(
      `marketing version must be MAJOR.MINOR.PATCH, got ${String(marketingVersion)}`,
    );
  const code = String(versionCode ?? '');
  if (!VERSION_CODE.test(code) || !Number.isSafeInteger(Number(code)))
    throw new Error(
      `version code must be a positive integer, got ${String(versionCode)}`,
    );
  const version = `${marketingVersion}-${RING}.${code}`;
  if (!CHANNEL_VERSION[RING].test(version))
    throw new Error(`${version} is not a ${RING} release version`);
  return version;
}

/** Negative, zero or positive as `left` orders before, with or after `right`. */
export function compareNightlyVersions(left, right) {
  return compareRingVersions(RING, left, right);
}

/** The versioned release, its asset base URL, and the rolling manifest URL. */
export function publicationLocations(repository, version) {
  return ringPublicationLocations(RING, repository, version);
}

/** A throwaway signing key and a key table that pins only it, for nightly. */
export function createDryRunKeys() {
  return ringCreateDryRunKeys(RING, DRY_RUN_SIGNING_KEY_ID);
}

/**
 * Verifies `envelope` against the pinned `keys` for the nightly ring and
 * requires its payload to be exactly `expectedPayload` (canonical bytes), so
 * a re-fetched manifest is the one this run signed, not merely a valid one.
 */
export function verifyExpectedManifest(envelope, keys, expectedPayload) {
  return ringVerifyExpectedManifest(RING, envelope, keys, expectedPayload);
}

/** True only for a validly signed rolling manifest older than `expectedPayload`. */
export function isStaleRollingManifest(error, expectedPayload) {
  return ringIsStaleRollingManifest(RING, error, expectedPayload);
}

/**
 * Refuses to replace the rolling manifest with one that is not strictly
 * newer (see scripts/lib/portable-publication.mjs).
 */
export function assertNotRegressing({ current, keys, candidateVersion }) {
  return ringAssertNotRegressing(RING, { current, keys, candidateVersion });
}

/**
 * The payload handed from the dry-run job is this run's Nightly: the nightly
 * ring, the planned version and tag, and the planned source SHA. Checked
 * before signing, so a substituted payload is refused before any release or
 * tag exists.
 */
export function assertPayloadIdentity(payload, { version, sourceSha }) {
  return ringAssertPayloadIdentity(
    RING,
    payload,
    { version, sourceSha },
    "this run's Nightly",
  );
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}

async function main(argv) {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      'marketing-version': { type: 'string' },
      'version-code': { type: 'string' },
      repository: { type: 'string' },
      version: { type: 'string' },
      'out-dir': { type: 'string' },
      payload: { type: 'string' },
      archives: { type: 'string' },
      manifest: { type: 'string' },
      'expected-payload': { type: 'string' },
      keys: { type: 'string' },
      'candidate-version': { type: 'string' },
      'source-sha': { type: 'string' },
      current: { type: 'string' },
    },
    strict: true,
  });
  const keys = () => readJson(values.keys ?? DEFAULT_KEY_TABLE);
  switch (command) {
    case 'version':
      process.stdout.write(
        `${portableNightlyVersion(values['marketing-version'], values['version-code'])}\n`,
      );
      return;
    case 'locations': {
      const l = publicationLocations(values.repository, values.version);
      process.stdout.write(
        [
          `release_tag=${l.releaseTag}`,
          `base_url=${l.baseUrl}`,
          `rolling_tag=${l.rollingTag}`,
          `manifest_asset=${l.manifestAsset}`,
          `rolling_manifest_url=${l.rollingManifestUrl}`,
          '',
        ].join('\n'),
      );
      return;
    }
    case 'dry-run-keys': {
      if (!values['out-dir']) throw new Error('--out-dir is required');
      const dir = resolve(values['out-dir']);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const { privateKeyPem, keyTable } = createDryRunKeys();
      writeFileSync(join(dir, 'dry-run-private-key.pem'), privateKeyPem, {
        mode: 0o600,
      });
      writeFileSync(
        join(dir, 'dry-run-keys.json'),
        `${JSON.stringify(keyTable, null, 2)}\n`,
      );
      process.stdout.write(`key_id=${DRY_RUN_SIGNING_KEY_ID}\n`);
      return;
    }
    case 'check-payload':
      assertPayloadIdentity(readJson(values.payload), {
        version: values.version,
        sourceSha: values['source-sha'],
      });
      process.stdout.write(
        `payload is ${values.version} at ${values['source-sha']}\n`,
      );
      return;
    case 'check-archives':
      for (const path of checkArchives(
        readJson(values.payload),
        resolve(values.archives),
      ))
        process.stdout.write(`${path}\n`);
      return;
    case 'verify': {
      const { envelope, payload } = await verifyManifestLocation(
        RING,
        values.manifest,
        keys(),
        readJson(values['expected-payload']),
      );
      process.stdout.write(
        `verified ${payload.version} (${envelope.keyId}) from ${values.manifest}\n`,
      );
      return;
    }
    case 'verify-assets':
      await verifyPublishedAssets(readJson(values.payload));
      process.stdout.write('every published archive matches the manifest\n');
      return;
    case 'not-regressing': {
      const current = await readManifest(values.current, {
        allowMissing: true,
      });
      const result = assertNotRegressing({
        current,
        keys: keys(),
        candidateVersion: values['candidate-version'],
      });
      process.stdout.write(
        `${values['candidate-version']} is newer than ${result.current ?? 'no published manifest'}\n`,
      );
      return;
    }
    default:
      throw new Error(
        'Usage: portable-nightly-publication.mjs <version|locations|dry-run-keys|check-payload|check-archives|verify|verify-assets|not-regressing> ...',
      );
  }
}

if (invokedDirectly(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(
      `error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
