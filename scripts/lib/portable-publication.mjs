// Ring-generic helpers for publishing a signed portable host manifest: the
// Nightly publisher (scripts/portable-nightly-publication.mjs) and the tagged
// stable/preview publisher (scripts/portable-release-publication.mjs) are thin
// ring-bound wrappers over these. Signing itself is
// scripts/ecosystem-manifest.mjs `create`; verification is the one shared
// verifier (packages/shared/src/release-manifest.mjs), whose CHANNEL_VERSION
// owns each ring's version grammar.
import { createHash, generateKeyPairSync } from 'node:crypto';
import {
  closeSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import {
  CHANNEL_VERSION,
  canonicalManifestJson,
  verifyReleaseManifest,
} from '../../packages/shared/src/release-manifest.mjs';
import { STATION_RELEASE_RINGS } from '../../packages/shared/src/release-rings.generated.mjs';
import {
  manifestPointer,
  releaseBaseUrl,
} from './public-release-locations.mjs';

/**
 * The launcher protocol range a portable archive declares, for every ring.
 * The one copy the publishers read: the fixed launcher (#2675 slice D) owns
 * the protocol and must bump this when it changes what an archive has to
 * support.
 */
export const PORTABLE_LAUNCHER_PROTOCOL = Object.freeze({ min: 1, max: 1 });

function assertRing(ring) {
  if (typeof ring !== 'string' || !Object.hasOwn(STATION_RELEASE_RINGS, ring))
    throw new Error(`${String(ring)} is not a release ring`);
  return ring;
}

/**
 * The numeric parts of a `ring` version: X.Y.Z for the unlabelled ring,
 * X.Y.Z plus N for `X.Y.Z-<ring>.N`. Throws for another ring's version.
 */
export function parseRingVersion(ring, version) {
  assertRing(ring);
  const match =
    typeof version === 'string' ? CHANNEL_VERSION[ring].exec(version) : null;
  if (!match) throw new Error(`${String(version)} is not a ${ring} version`);
  return match
    .slice(1)
    .filter((part) => part !== undefined)
    .map((part) => BigInt(part));
}

/** Negative, zero or positive as `left` orders before, with or after `right`. */
export function compareRingVersions(ring, left, right) {
  const a = parseRingVersion(ring, left);
  const b = parseRingVersion(ring, right);
  for (let index = 0; index < a.length; index += 1)
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  return 0;
}

/**
 * The versioned release, its asset base URL, and the ring's rolling manifest,
 * all from scripts/lib/public-release-locations.mjs.
 */
export function publicationLocations(ring, repository, version) {
  const base = releaseBaseUrl(repository);
  parseRingVersion(ring, version);
  const { rollingTag, manifestAsset } = manifestPointer(ring);
  const releaseTag = `v${version}`;
  return {
    releaseTag,
    baseUrl: `${base}${releaseTag}/`,
    rollingTag,
    manifestAsset,
    rollingManifestUrl: `${base}${rollingTag}/${manifestAsset}`,
  };
}

/** A throwaway signing key and a key table that pins only it, for `ring`. */
export function createDryRunKeys(ring, keyId) {
  assertRing(ring);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeySpkiPem = publicKey.export({ type: 'spki', format: 'pem' });
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    keyTable: {
      keys: [
        {
          keyId,
          algorithm: 'ed25519',
          publicKeySpkiPem,
          channels: [ring],
        },
      ],
    },
  };
}

/**
 * Verifies `envelope` against the pinned `keys` for `ring` and requires its
 * payload to be exactly `expectedPayload` (canonical bytes), so a re-fetched
 * manifest is the one this run signed, not merely a valid one.
 */
export function verifyExpectedManifest(ring, envelope, keys, expectedPayload) {
  const payload = verifyReleaseManifest(envelope, keys, {
    expectedChannel: assertRing(ring),
  });
  if (canonicalManifestJson(payload) !== canonicalManifestJson(expectedPayload))
    throw new ManifestMismatchError(payload.version, expectedPayload?.version);
  return payload;
}

/** A validly signed manifest whose payload is not the one this run signed. */
export class ManifestMismatchError extends Error {
  constructor(fetchedVersion, expectedVersion) {
    super(
      `manifest payload for ${String(fetchedVersion)} is not the payload this run signed (${String(expectedVersion)})`,
    );
    this.fetchedVersion = fetchedVersion;
  }
}

/**
 * True only for the one failure waiting can fix: a validly signed rolling
 * manifest that is still an OLDER version than the one just published, i.e.
 * the asset host serving the replaced bytes from cache. A bad signature, a
 * wrong key or a newer or equal version is not staleness and fails at once.
 */
export function isStaleRollingManifest(ring, error, expectedPayload) {
  if (!(error instanceof ManifestMismatchError)) return false;
  try {
    return (
      compareRingVersions(
        ring,
        error.fetchedVersion,
        expectedPayload?.version,
      ) < 0
    );
  } catch {
    return false;
  }
}

/**
 * Refuses to replace the rolling manifest with one that is not strictly
 * newer. `current` is the envelope the rolling pointer serves now, or null
 * when it serves none yet (the first publish). A current manifest that does
 * not verify is refused too: the owner reconciles it, the job does not
 * paper over it.
 */
export function assertNotRegressing(ring, { current, keys, candidateVersion }) {
  parseRingVersion(ring, candidateVersion);
  if (current === null) return { current: null };
  const payload = verifyReleaseManifest(current, keys, {
    expectedChannel: ring,
  });
  if (compareRingVersions(ring, candidateVersion, payload.version) <= 0)
    throw new Error(
      `refusing to replace the rolling ${ring} manifest ${payload.version} with ${candidateVersion}, which is not newer`,
    );
  return { current: payload.version };
}

/**
 * The payload handed to a publish is the expected one: `ring`, the planned
 * version and tag, and the planned source SHA. With `baseUrl`, every artifact
 * must also be named at that versioned release base, so a payload cannot
 * point installers anywhere else. `label` names the publication in the error.
 */
export function assertPayloadIdentity(
  ring,
  payload,
  { version, sourceSha, baseUrl },
  label,
) {
  const mismatches = [
    ['channel', payload?.channel, ring],
    ['version', payload?.version, version],
    ['releaseTag', payload?.releaseTag, `v${version}`],
    ['sourceSha', payload?.sourceSha, sourceSha],
  ];
  if (baseUrl !== undefined)
    for (const artifact of Array.isArray(payload?.artifacts)
      ? payload.artifacts
      : [])
      mismatches.push([
        `${String(artifact?.name)} url`,
        artifact?.url,
        `${baseUrl}${String(artifact?.name)}`,
      ]);
  if (typeof version !== 'string' || typeof sourceSha !== 'string')
    throw new Error('the expected version and source SHA are required');
  const wrong = mismatches.filter(
    ([, actual, expected]) => actual !== expected,
  );
  if (wrong.length > 0)
    throw new Error(
      `payload is not ${label}: ${wrong
        .map(
          ([key, actual, expected]) =>
            `${key} ${String(actual)} (expected ${String(expected)})`,
        )
        .join(', ')}`,
    );
  return payload;
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

/** Bounds one GET, body included; undici's own default is about 300s. */
export const FETCH_TIMEOUT_MS = 30_000;

/**
 * GETs `url`, retrying while a just-uploaded release asset is still
 * propagating. A 404 is returned as null only when `allowMissing` is set.
 * Each attempt is aborted after `timeoutMs`, so a hanging host fails the
 * step instead of running into the job timeout, which cancels it before any
 * restore can run.
 */
export async function fetchBytes(
  url,
  {
    fetchImpl = fetch,
    attempts = 10,
    delayMs = 6000,
    allowMissing = false,
    timeoutMs = FETCH_TIMEOUT_MS,
  },
) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
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

/** A manifest from a local file, or an https URL (null for a 404 with allowMissing). */
export async function readManifest(location, options = {}) {
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

const REVERIFY_ATTEMPTS = 30;
const REVERIFY_DELAY_MS = 10_000;

/**
 * Reads and verifies `location` against `keys` and `expected`. A
 * just-replaced rolling asset can serve the previous bytes for a while:
 * GitHub's asset host cached the old manifest for longer than a minute after
 * the replacement on 2026-09-30 (#3013), so a remote read retries a stale
 * (older) manifest for up to REVERIFY_ATTEMPTS * REVERIFY_DELAY_MS
 * (5 minutes). Any other failure, or staleness that outlasts that, fails at
 * once.
 */
export async function verifyManifestLocation(ring, location, keys, expected) {
  const remote = /^https:\/\//.test(location ?? '');
  for (let attempt = 1; ; attempt += 1) {
    const envelope = await readManifest(location);
    try {
      return {
        envelope,
        payload: verifyExpectedManifest(ring, envelope, keys, expected),
      };
    } catch (error) {
      if (
        !remote ||
        attempt >= REVERIFY_ATTEMPTS ||
        !isStaleRollingManifest(ring, error, expected)
      )
        throw error;
      await sleep(REVERIFY_DELAY_MS);
    }
  }
}
