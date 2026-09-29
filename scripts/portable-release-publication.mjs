#!/usr/bin/env node
// Helpers for publishing the signed host-stream manifest of a tagged stable
// or preview release (#2959, ADR 0020 D1): release.yml assembles and dry-run
// signs it on every tag, and publish-release.yml signs it with the release
// key and replaces the ring's rolling pointer, only behind the owner's gate.
// Signing itself is scripts/ecosystem-manifest.mjs `create`; the checks are
// the ring-generic ones Nightly uses (scripts/lib/portable-publication.mjs),
// bound here to the rings the release key signs.
//
//   locations      --ring R --repository owner/name --version V  (GITHUB_OUTPUT lines)
//   manifest-asset --ring R                    (the signed manifest's asset name)
//   dry-run-keys   --ring R --out-dir D        (ephemeral key + key table)
//   check-payload  --ring R --payload P --version V --source-sha S --repository owner/name
//   check-archives --payload P --archives D    (local bytes are the signed ones)
//   verify         --ring R --manifest <file|https URL> --expected-payload P [--keys T]
//   verify-assets  --payload P                 (published bytes are the signed ones)
//   pointer-plan   --ring R --candidate-version V --current <file|https URL>
//                  --signed M [--allow-empty-bootstrap true|false] [--keys T]
//                  (GITHUB_OUTPUT: action=replace|unchanged|skip-older)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { verifyReleaseManifest } from '../packages/shared/src/release-manifest.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';
import {
  assertPayloadIdentity,
  checkArchives,
  compareRingVersions,
  createDryRunKeys,
  fetchBytes,
  parseRingVersion,
  publicationLocations,
  verifyManifestLocation,
  verifyPublishedAssets,
} from './lib/portable-publication.mjs';
import { manifestPointer } from './lib/public-release-locations.mjs';

const DEFAULT_KEY_TABLE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../config/release-manifest-keys.json',
);
/** The rings a tagged release publishes; nightly has its own key and job. */
export const RELEASE_RINGS = Object.freeze(['stable', 'preview']);
/** The pinned key id authorized for stable and preview (config/release-manifest-keys.json). */
export const RELEASE_SIGNING_KEY_ID = 'station-portable-release-2026-09';
/** A key id no installer pins, so a dry-run envelope can never pass as real. */
export const RELEASE_DRY_RUN_KEY_ID = 'station-portable-release-dry-run';

/** Throws unless `ring` is one a tagged release publishes. */
export function releaseRing(ring) {
  if (!RELEASE_RINGS.includes(ring))
    throw new Error(
      `--ring must be ${RELEASE_RINGS.join(' or ')}, got ${String(ring)}`,
    );
  return ring;
}

/**
 * The payload a publish is about to sign is this release's: the ring, the
 * tag's version and source SHA, and every artifact named at the versioned
 * release under the public release base.
 */
export function assertReleasePayload(
  ring,
  payload,
  { repository, version, sourceSha },
) {
  const { baseUrl } = publicationLocations(
    releaseRing(ring),
    repository,
    version,
  );
  return assertPayloadIdentity(
    ring,
    payload,
    { version, sourceSha, baseUrl },
    `this release's ${ring} host build`,
  );
}

/**
 * What to do with the ring's rolling pointer, given the manifest bytes it
 * serves now (`currentBytes`, null when it serves none) and the bytes this
 * run signed. The pointer never moves backwards and is never silently
 * bootstrapped:
 *
 * - none served: refused unless the owner allowed an empty-pointer bootstrap
 *   for this run, then `replace`;
 * - served manifest that does not verify with the pinned keys: refused;
 * - older than the candidate: `replace`;
 * - the same version: `unchanged` when the served bytes are exactly this
 *   run's (a rerun after the pointer already moved), refused otherwise;
 * - newer than the candidate (publishing or repairing an older tag, such as a
 *   desktop rollback): `skip-older`; the host pointer stays where it is.
 *
 * The signed bytes must verify with `keys` and name `candidateVersion`.
 */
export function planRollingPointer({
  ring,
  candidateVersion,
  currentBytes,
  signedBytes,
  keys,
  allowEmptyBootstrap,
  rollingTag,
}) {
  parseRingVersion(releaseRing(ring), candidateVersion);
  // The manifest about to be served must be this run's version: a validly
  // signed manifest for another release cannot ride on this candidate.
  const candidate = verifyReleaseManifest(
    JSON.parse(signedBytes.toString('utf8')),
    keys,
    { expectedChannel: ring },
  );
  if (candidate.version !== candidateVersion)
    throw new Error(
      `the signed manifest names ${candidate.version}, not the candidate ${candidateVersion}; refusing to plan the ${rollingTag} pointer with it`,
    );
  if (currentBytes === null) {
    if (allowEmptyBootstrap !== true)
      throw new Error(
        `the rolling pointer ${rollingTag} serves no ${ring} manifest; confirm it is new, then re-run with allow_empty_host_manifest_bootstrap for its first publish only`,
      );
    return { action: 'replace', current: null };
  }
  const current = verifyReleaseManifest(
    JSON.parse(currentBytes.toString('utf8')),
    keys,
    { expectedChannel: ring },
  );
  const order = compareRingVersions(ring, candidateVersion, current.version);
  if (order > 0) return { action: 'replace', current: current.version };
  if (order < 0) return { action: 'skip-older', current: current.version };
  if (Buffer.compare(currentBytes, signedBytes) === 0)
    return { action: 'unchanged', current: current.version };
  throw new Error(
    `the rolling ${ring} manifest already names ${current.version} with different bytes than this run signed; inspect ${rollingTag} before re-running`,
  );
}

async function readCurrentBytes(location) {
  if (/^https:\/\//.test(location))
    return fetchBytes(location, { allowMissing: true });
  const path = resolve(location);
  return existsSync(path) ? readFileSync(path) : null;
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}

async function main(argv) {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      ring: { type: 'string' },
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
      signed: { type: 'string' },
      'allow-empty-bootstrap': { type: 'string' },
    },
    strict: true,
  });
  const keys = () => readJson(values.keys ?? DEFAULT_KEY_TABLE);
  const ring = () => releaseRing(values.ring);
  switch (command) {
    case 'locations': {
      const l = publicationLocations(ring(), values.repository, values.version);
      process.stdout.write(
        [
          `release_tag=${l.releaseTag}`,
          `base_url=${l.baseUrl}`,
          `rolling_tag=${l.rollingTag}`,
          `manifest_asset=${l.manifestAsset}`,
          `versioned_manifest_url=${l.baseUrl}${l.manifestAsset}`,
          `rolling_manifest_url=${l.rollingManifestUrl}`,
          '',
        ].join('\n'),
      );
      return;
    }
    case 'manifest-asset':
      process.stdout.write(`${manifestPointer(ring()).manifestAsset}\n`);
      return;
    case 'dry-run-keys': {
      if (!values['out-dir']) throw new Error('--out-dir is required');
      const dir = resolve(values['out-dir']);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const { privateKeyPem, keyTable } = createDryRunKeys(
        ring(),
        RELEASE_DRY_RUN_KEY_ID,
      );
      writeFileSync(join(dir, 'dry-run-private-key.pem'), privateKeyPem, {
        mode: 0o600,
      });
      writeFileSync(
        join(dir, 'dry-run-keys.json'),
        `${JSON.stringify(keyTable, null, 2)}\n`,
      );
      process.stdout.write(`key_id=${RELEASE_DRY_RUN_KEY_ID}\n`);
      return;
    }
    case 'check-payload':
      assertReleasePayload(ring(), readJson(values.payload), {
        repository: values.repository,
        version: values.version,
        sourceSha: values['source-sha'],
      });
      process.stdout.write(
        `payload is ${values.ring} ${values.version} at ${values['source-sha']}\n`,
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
        ring(),
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
    case 'pointer-plan': {
      const flag = values['allow-empty-bootstrap'] ?? 'false';
      if (flag !== 'true' && flag !== 'false')
        throw new Error('--allow-empty-bootstrap must be true or false');
      const plan = planRollingPointer({
        ring: ring(),
        candidateVersion: values['candidate-version'],
        currentBytes: await readCurrentBytes(values.current),
        signedBytes: readFileSync(resolve(values.signed)),
        keys: keys(),
        allowEmptyBootstrap: flag === 'true',
        rollingTag: manifestPointer(ring()).rollingTag,
      });
      process.stderr.write(
        `rolling ${values.ring} pointer serves ${plan.current ?? 'no manifest'}; ${values['candidate-version']}: ${plan.action}\n`,
      );
      process.stdout.write(`action=${plan.action}\n`);
      return;
    }
    default:
      throw new Error(
        'Usage: portable-release-publication.mjs <locations|manifest-asset|dry-run-keys|check-payload|check-archives|verify|verify-assets|pointer-plan> ...',
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
