#!/usr/bin/env node
// Helpers for the portable server Nightly publication
// (.github/workflows/portable-nightly-publish.yml, #2675 slice E). Signing
// itself is scripts/ecosystem-manifest.mjs `create`; this file owns the
// Nightly identity, the release locations, and the checks around a publish:
//
//   version        --marketing-version X.Y.Z --version-code N
//   locations      --repository owner/name --version V   (GITHUB_OUTPUT lines)
//   dry-run-keys   --out-dir D                  (ephemeral key + key table)
//   check-payload  --payload P --version V --source-sha S  (this run's Nightly)
//   check-archives --payload P --archives D     (local bytes are the signed ones)
//   verify         --manifest <file|https URL> --expected-payload P [--keys T]
//   verify-assets  --payload P                  (published bytes are the signed ones)
//   not-regressing --candidate-version V --current <file|https URL> [--keys T]
import { createHash, generateKeyPairSync } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  CHANNEL_VERSION,
  canonicalManifestJson,
  verifyReleaseManifest,
} from '../packages/shared/src/release-manifest.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';

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
 * to run without it rather than creating it.
 */
export const ROLLING_NIGHTLY_TAG = 'portable-nightly';
export const NIGHTLY_MANIFEST_ASSET = 'station-portable-nightly-manifest.json';
/**
 * The launcher protocol range a Nightly archive declares. No launcher reads
 * it yet: the fixed launcher (slice D) owns the protocol and must bump this
 * when it changes what an archive has to support.
 */
export const PORTABLE_LAUNCHER_PROTOCOL = Object.freeze({ min: 1, max: 1 });

const MARKETING_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const VERSION_CODE = /^[1-9]\d*$/;
const REPOSITORY = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

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

function parseNightlyVersion(version) {
  const match =
    typeof version === 'string' ? CHANNEL_VERSION[RING].exec(version) : null;
  if (!match) throw new Error(`${String(version)} is not a ${RING} version`);
  return match.slice(1, 5).map((part) => BigInt(part));
}

/** Negative, zero or positive as `left` orders before, with or after `right`. */
export function compareNightlyVersions(left, right) {
  const a = parseNightlyVersion(left);
  const b = parseNightlyVersion(right);
  for (let index = 0; index < a.length; index += 1)
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  return 0;
}

/** The versioned release, its asset base URL, and the rolling manifest URL. */
export function publicationLocations(repository, version) {
  if (typeof repository !== 'string' || !REPOSITORY.test(repository))
    throw new Error(`invalid repository ${String(repository)}`);
  parseNightlyVersion(version);
  const releaseTag = `v${version}`;
  const download = `https://github.com/${repository}/releases/download`;
  return {
    releaseTag,
    baseUrl: `${download}/${releaseTag}/`,
    rollingTag: ROLLING_NIGHTLY_TAG,
    manifestAsset: NIGHTLY_MANIFEST_ASSET,
    rollingManifestUrl: `${download}/${ROLLING_NIGHTLY_TAG}/${NIGHTLY_MANIFEST_ASSET}`,
  };
}

/** A throwaway signing key and a key table that pins only it, for nightly. */
export function createDryRunKeys() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeySpkiPem = publicKey.export({ type: 'spki', format: 'pem' });
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    keyTable: {
      keys: [
        {
          keyId: DRY_RUN_SIGNING_KEY_ID,
          algorithm: 'ed25519',
          publicKeySpkiPem,
          channels: [RING],
        },
      ],
    },
  };
}

/**
 * Verifies `envelope` against the pinned `keys` for the nightly ring and
 * requires its payload to be exactly `expectedPayload` (canonical bytes), so
 * a re-fetched manifest is the one this run signed, not merely a valid one.
 */
export function verifyExpectedManifest(envelope, keys, expectedPayload) {
  const payload = verifyReleaseManifest(envelope, keys, {
    expectedChannel: RING,
  });
  if (canonicalManifestJson(payload) !== canonicalManifestJson(expectedPayload))
    throw new Error(
      `manifest payload for ${String(payload.version)} is not the payload this run signed (${String(expectedPayload?.version)})`,
    );
  return payload;
}

/**
 * Refuses to replace the rolling manifest with one that is not strictly
 * newer. `current` is the envelope the rolling pointer serves now, or null
 * when it serves none yet (the first publish). A current manifest that does
 * not verify is refused too: the owner reconciles it, the job does not
 * paper over it.
 */
export function assertNotRegressing({ current, keys, candidateVersion }) {
  parseNightlyVersion(candidateVersion);
  if (current === null) return { current: null };
  const payload = verifyReleaseManifest(current, keys, {
    expectedChannel: RING,
  });
  if (compareNightlyVersions(candidateVersion, payload.version) <= 0)
    throw new Error(
      `refusing to replace the rolling ${RING} manifest ${payload.version} with ${candidateVersion}, which is not newer`,
    );
  return { current: payload.version };
}

function describeFile(path) {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(1024 * 1024);
  const fd = openSync(path, 'r');
  let size = 0;
  try {
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
      size += read;
    }
  } finally {
    closeSync(fd);
  }
  return { size, sha256: hash.digest('hex') };
}

function filesNamed(root, names) {
  const found = new Map();
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`archive tree contains a symbolic link: ${path}`);
      if (entry.isDirectory()) pending.push(path);
      else if (names.has(entry.name)) {
        if (found.has(entry.name))
          throw new Error(`more than one ${entry.name} under ${root}`);
        found.set(entry.name, path);
      }
    }
  }
  return found;
}

/**
 * The payload handed from the dry-run job is this run's Nightly: the nightly
 * ring, the planned version and tag, and the planned source SHA. Checked
 * before signing, so a substituted payload is refused before any release or
 * tag exists.
 */
export function assertPayloadIdentity(payload, { version, sourceSha }) {
  const mismatches = [
    ['channel', payload?.channel, RING],
    ['version', payload?.version, version],
    ['releaseTag', payload?.releaseTag, `v${version}`],
    ['sourceSha', payload?.sourceSha, sourceSha],
  ].filter(([, actual, expected]) => actual !== expected);
  if (typeof version !== 'string' || typeof sourceSha !== 'string')
    throw new Error('the expected version and source SHA are required');
  if (mismatches.length > 0)
    throw new Error(
      `payload is not this run's Nightly: ${mismatches
        .map(
          ([key, actual, expected]) =>
            `${key} ${String(actual)} (expected ${String(expected)})`,
        )
        .join(', ')}`,
    );
  return payload;
}

/**
 * Every artifact the payload signs is present under `archivesDir` with the
 * signed size and sha256: the bytes about to be uploaded are the signed ones.
 * Returns the paths in payload order.
 */
export function checkArchives(payload, archivesDir) {
  const names = new Set(payload.artifacts.map(({ name }) => name));
  const found = filesNamed(archivesDir, names);
  return payload.artifacts.map(({ name, size, sha256 }) => {
    const path = found.get(name);
    if (!path) throw new Error(`${name} is missing under ${archivesDir}`);
    const actual = describeFile(path);
    if (actual.size !== size || actual.sha256 !== sha256)
      throw new Error(`${name} is not the archive the manifest signs`);
    return path;
  });
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * GETs `url`, retrying while a just-uploaded release asset is still
 * propagating. A 404 is returned as null only when `allowMissing` is set.
 */
const REVERIFY_ATTEMPTS = 30;
const REVERIFY_DELAY_MS = 10_000;

export async function fetchBytes(
  url,
  { fetchImpl = fetch, attempts = 10, delayMs = 6000, allowMissing = false },
) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, { redirect: 'follow' });
      if (response.status === 404 && allowMissing) return null;
      if (response.ok) return Buffer.from(await response.arrayBuffer());
      lastError = new Error(`GET ${url} returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) await sleep(delayMs);
  }
  throw lastError;
}

async function readManifest(location, options = {}) {
  if (/^https:\/\//.test(location)) {
    const bytes = await fetchBytes(location, options);
    return bytes === null ? null : JSON.parse(bytes.toString('utf8'));
  }
  return JSON.parse(readFileSync(resolve(location), 'utf8'));
}

/** Downloads every signed artifact from its signed URL and compares bytes. */
export async function verifyPublishedAssets(payload, options = {}) {
  for (const { url, size, sha256, name } of payload.artifacts) {
    const bytes = await fetchBytes(url, options);
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== size || actual !== sha256)
      throw new Error(
        `${name} at ${url} is not the archive the manifest signs`,
      );
  }
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
      const expected = readJson(values['expected-payload']);
      const remote = /^https:\/\//.test(values.manifest ?? '');
      // A just-replaced rolling asset can serve the previous bytes for a
      // while: GitHub's asset host cached the old manifest for longer than a
      // minute after the replacement on 2026-09-30, so a remote read retries a
      // mismatch for up to REVERIFY_ATTEMPTS * REVERIFY_DELAY_MS (5 minutes)
      // before failing. A mismatch that outlasts that still fails the job.
      for (let attempt = 1; ; attempt += 1) {
        const envelope = await readManifest(values.manifest);
        try {
          const payload = verifyExpectedManifest(envelope, keys(), expected);
          process.stdout.write(
            `verified ${payload.version} (${envelope.keyId}) from ${values.manifest}\n`,
          );
          return;
        } catch (error) {
          if (!remote || attempt >= REVERIFY_ATTEMPTS) throw error;
          await sleep(REVERIFY_DELAY_MS);
        }
      }
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
