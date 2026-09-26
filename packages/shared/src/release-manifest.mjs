/**
 * The signed standalone-server release manifest (#2675): canonical bytes,
 * the pinned signing-key table, the envelope, and the per-platform schema v2
 * payload. One implementation, with `node:crypto` only: the manifest signer
 * (scripts/ecosystem-manifest.mjs) imports it, and so does the service
 * supervisor through `@kontourai/station-shared/release-manifest`. install.sh
 * must stay one standalone file, so it carries the only other copy; golden
 * vectors pin both to the same bytes.
 *
 * Schema v1 (the macOS cask shape) is not here: only the signer's CLI reads
 * it, and it names no server archive anything could install.
 *
 * Not here either: downgrade or replay protection. A validly signed older
 * manifest verifies; the supervisor's monotonic version check (slice D)
 * refuses it.
 */
import { createPublicKey, verify } from 'node:crypto';
import {
  findPortableServerTarget,
  portableServerArchiveName,
} from './portable-server-targets.mjs';

export const SHA256_HEX = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const RELEASE = '(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)';
export const NODE_VERSION = new RegExp(`^${RELEASE}$`);
export const KEY_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

// The installable release rings and whether each is a prerelease: a
// prerelease ring's versions are X.Y.Z-<ring>.N, the one unlabelled ring owns
// X.Y.Z. TODO(#2675): take this from config/channel-ports.json's
// releaseRings once #2688 lands it, so the ring list has one source.
const RELEASE_RINGS = { stable: false, preview: true, nightly: true };

/**
 * Each channel owns exactly one version shape, so a payload cannot claim one
 * ring while carrying another ring's version.
 */
export const CHANNEL_VERSION = Object.freeze(
  Object.fromEntries(
    Object.entries(RELEASE_RINGS).map(([ring, prerelease]) => [
      ring,
      new RegExp(`^${RELEASE}${prerelease ? `-${ring}\\.([1-9][0-9]*)` : ''}$`),
    ]),
  ),
);

const ENVELOPE_KEYS = [
  'algorithm',
  'keyId',
  'payload',
  'schemaVersion',
  'signature',
];
const KEY_ENTRY_KEYS = ['algorithm', 'channels', 'keyId', 'publicKeySpkiPem'];
const PAYLOAD_KEYS_V2 = [
  'artifacts',
  'channel',
  'launcherProtocol',
  'nodeVersion',
  'publishedAt',
  'releaseTag',
  'schemaVersion',
  'sourceSha',
  'version',
];
const ARTIFACT_KEYS = ['arch', 'format', 'name', 'os', 'sha256', 'size', 'url'];

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function hasExactKeys(value, keys) {
  return (
    isObject(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys)
  );
}

/** The signed bytes: recursive sorted-key JSON with no whitespace. */
export function canonicalManifestJson(value) {
  if (Array.isArray(value))
    return `[${value.map(canonicalManifestJson).join(',')}]`;
  if (isObject(value))
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalManifestJson(value[key])}`,
      )
      .join(',')}}`;
  return JSON.stringify(value);
}

/**
 * The URL an installer fetches must be exactly the signed string. `new URL()`
 * silently strips tabs and newlines (and normalizes other input), so only a
 * URL that is already its own canonical href, with no control characters or
 * spaces, is accepted.
 */
export function isCanonicalUrl(value) {
  if (
    typeof value !== 'string' ||
    [...value].some((char) => char <= ' ' || char === '\u007f')
  )
    return false;
  try {
    return new URL(value).href === value;
  } catch {
    return false;
  }
}

/**
 * A canonical URL of one of `protocols` that names a file and nothing else:
 * no userinfo, query or fragment (each would let one signed string stand for
 * a request other than the plain download it appears to be).
 */
export function isPlainCanonicalUrl(value, protocols) {
  if (!isCanonicalUrl(value)) return false;
  const url = new URL(value);
  return (
    protocols.includes(url.protocol) &&
    url.username === '' &&
    url.password === '' &&
    !value.includes('?') &&
    !value.includes('#')
  );
}

/** The only artifact URL policy a published manifest may rely on. */
export function isHttpsArtifactUrl(value) {
  return isPlainCanonicalUrl(value, ['https:']);
}

/**
 * The pinned signing-key table (config/release-manifest-keys.json's shape),
 * as a Map from keyId to its authorized channels and public key.
 */
export function parseKeyTable(table) {
  if (!hasExactKeys(table, ['keys']) || !Array.isArray(table.keys))
    throw new Error('signing-key table has an unexpected shape');
  const entries = new Map();
  for (const entry of table.keys) {
    if (
      !hasExactKeys(entry, KEY_ENTRY_KEYS) ||
      entry.algorithm !== 'ed25519' ||
      typeof entry.keyId !== 'string' ||
      !KEY_ID.test(entry.keyId) ||
      entries.has(entry.keyId) ||
      !Array.isArray(entry.channels) ||
      entry.channels.length === 0 ||
      !entry.channels.every(
        (channel) =>
          typeof channel === 'string' &&
          Object.hasOwn(CHANNEL_VERSION, channel),
      ) ||
      typeof entry.publicKeySpkiPem !== 'string'
    )
      throw new Error('signing-key table has an invalid entry');
    const key = createPublicKey(entry.publicKeySpkiPem);
    if (key.asymmetricKeyType !== 'ed25519')
      throw new Error('signing-key table has an invalid entry');
    entries.set(entry.keyId, { channels: [...entry.channels], key });
  }
  return entries;
}

/** Throws unless `envelope` is the exact signed-envelope shape. */
export function assertEnvelopeShape(envelope) {
  if (
    !hasExactKeys(envelope, ENVELOPE_KEYS) ||
    envelope.schemaVersion !== 1 ||
    envelope.algorithm !== 'ed25519' ||
    typeof envelope.keyId !== 'string' ||
    !KEY_ID.test(envelope.keyId) ||
    typeof envelope.signature !== 'string' ||
    !BASE64.test(envelope.signature)
  )
    throw new Error('manifest envelope has an unexpected shape');
  return envelope;
}

/**
 * The pinned public key for `keyId`, provided it is authorized to sign
 * `channel`; throws otherwise.
 */
export function pinnedKeyFor(keys, keyId, channel) {
  const entry = keys.get(keyId);
  if (!entry) throw new Error(`manifest signing key ${keyId} is not pinned`);
  if (typeof channel !== 'string') throw new Error('invalid manifest channel');
  if (!entry.channels.includes(channel))
    throw new Error(
      `signing key ${keyId} is not authorized for channel ${channel}`,
    );
  return entry.key;
}

/** Throws unless `envelope.signature` verifies over its payload with `key`. */
export function assertEnvelopeSignature(envelope, key) {
  if (
    !verify(
      null,
      Buffer.from(canonicalManifestJson(envelope.payload)),
      key,
      Buffer.from(envelope.signature, 'base64'),
    )
  )
    throw new Error('manifest signature did not verify');
}

/** sourceSha and publishedAt, shared by every payload schema. */
export function validateCommonPayload(payload) {
  if (typeof payload.sourceSha !== 'string' || !SHA.test(payload.sourceSha))
    throw new Error('invalid source SHA');
  if (
    typeof payload.publishedAt !== 'string' ||
    Number.isNaN(new Date(payload.publishedAt).getTime()) ||
    new Date(payload.publishedAt).toISOString() !== payload.publishedAt
  )
    throw new Error('invalid publication timestamp');
}

function validateArtifact(artifact, index, isAllowedArtifactUrl) {
  if (
    !hasExactKeys(artifact, ARTIFACT_KEYS) ||
    typeof artifact.os !== 'string' ||
    typeof artifact.arch !== 'string'
  )
    throw new Error(`platform artifact ${index} has an unexpected shape`);
  const id = `${artifact.os}-${artifact.arch}`;
  const target = findPortableServerTarget(artifact.os, artifact.arch);
  if (!target)
    throw new Error(`platform artifact ${id} is not a supported target`);
  if (artifact.format !== target.format)
    throw new Error(`platform artifact ${id} format must be ${target.format}`);
  const name = portableServerArchiveName(target);
  if (artifact.name !== name)
    throw new Error(`platform artifact ${id} name must be ${name}`);
  if (!isAllowedArtifactUrl(artifact.url))
    throw new Error(`platform artifact ${id} url is not a canonical HTTPS URL`);
  if (typeof artifact.sha256 !== 'string' || !SHA256_HEX.test(artifact.sha256))
    throw new Error(`platform artifact ${id} sha256 is invalid`);
  if (!Number.isSafeInteger(artifact.size) || artifact.size <= 0)
    throw new Error(`platform artifact ${id} size is invalid`);
  return id;
}

function validateArtifacts(artifacts, isAllowedArtifactUrl) {
  if (!Array.isArray(artifacts) || artifacts.length === 0)
    throw new Error('invalid artifact set');
  const ids = artifacts.map((artifact, index) =>
    validateArtifact(artifact, index, isAllowedArtifactUrl),
  );
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`duplicate platform artifact ${id}`);
    seen.add(id);
  }
  // The signed bytes depend on the order, so it is part of the schema: one
  // entry per target, sorted by os, then arch (code-point order).
  for (let index = 1; index < artifacts.length; index += 1) {
    const previous = artifacts[index - 1];
    const current = artifacts[index];
    if (
      previous.os > current.os ||
      (previous.os === current.os && previous.arch > current.arch)
    )
      throw new Error('platform artifacts are not sorted by os, then arch');
  }
}

/**
 * Validates a schema v2 payload. `isAllowedArtifactUrl` is the artifact URL
 * policy; everything but the signer's explicit test escape passes
 * isHttpsArtifactUrl, which verifyReleaseManifest always does.
 */
export function validateReleaseManifestPayloadV2(
  payload,
  { isAllowedArtifactUrl },
) {
  if (payload?.schemaVersion !== 2 || !hasExactKeys(payload, PAYLOAD_KEYS_V2))
    throw new Error('manifest payload has an unexpected shape');
  if (
    typeof payload.channel !== 'string' ||
    !Object.hasOwn(CHANNEL_VERSION, payload.channel)
  )
    throw new Error('invalid manifest channel');
  if (typeof payload.version !== 'string')
    throw new Error('invalid manifest version');
  if (!CHANNEL_VERSION[payload.channel].test(payload.version))
    throw new Error('manifest channel does not match version');
  if (payload.releaseTag !== `v${payload.version}`)
    throw new Error('release tag does not match version');
  validateCommonPayload(payload);
  if (
    typeof payload.nodeVersion !== 'string' ||
    !NODE_VERSION.test(payload.nodeVersion)
  )
    throw new Error('invalid Node.js version');
  const protocol = payload.launcherProtocol;
  if (
    !hasExactKeys(protocol, ['max', 'min']) ||
    !Number.isSafeInteger(protocol.min) ||
    !Number.isSafeInteger(protocol.max) ||
    protocol.min < 1 ||
    protocol.max < protocol.min
  )
    throw new Error('invalid launcher protocol range');
  validateArtifacts(payload.artifacts, isAllowedArtifactUrl);
  return payload;
}

/**
 * Verifies `envelope` (the parsed manifest JSON) against the pinned `keys`
 * table for the ring the caller installs, and returns its payload or throws
 * with the reason. The ring is required: a validly signed manifest for
 * another channel is refused. Schema v2 only, HTTPS artifact URLs only.
 */
export function verifyReleaseManifest(envelope, keys, options) {
  const expectedChannel = options?.expectedChannel;
  if (typeof expectedChannel !== 'string' || expectedChannel === '')
    throw new Error('an expected release channel is required');
  assertEnvelopeShape(envelope);
  const key = pinnedKeyFor(
    parseKeyTable(keys),
    envelope.keyId,
    envelope.payload?.channel,
  );
  assertEnvelopeSignature(envelope, key);
  if (!isObject(envelope.payload))
    throw new Error('manifest payload has an unexpected shape');
  if (envelope.payload.schemaVersion !== 2)
    throw new Error('unsupported manifest schema');
  const payload = validateReleaseManifestPayloadV2(envelope.payload, {
    isAllowedArtifactUrl: isHttpsArtifactUrl,
  });
  if (payload.channel !== expectedChannel)
    throw new Error(
      `manifest channel ${payload.channel} does not match the expected channel ${expectedChannel}`,
    );
  return payload;
}

/**
 * The artifact a host of `os`/`arch` installs (process.platform and
 * process.arch); throws when the manifest publishes none for it.
 */
export function selectArtifact(payload, os, arch) {
  const artifact = payload.artifacts.find(
    (candidate) => candidate.os === os && candidate.arch === arch,
  );
  if (!artifact)
    throw new Error(
      `the release manifest has no server archive for ${os}-${arch}`,
    );
  return artifact;
}
