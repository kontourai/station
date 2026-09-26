/**
 * Verifies a signed standalone-server release manifest (schema v2, #2675)
 * for the service supervisor, with `node:crypto` only.
 *
 * The signer, scripts/ecosystem-manifest.mjs, carries its own copy of these
 * rules. The two must reach the same decision, for the same reason, on every
 * envelope; scripts/__tests__/release-manifest-vectors.test.ts runs one
 * golden corpus through both. The one deliberate difference: this verifier
 * accepts schema v2 only. Schema v1 (the macOS cask shape) names no
 * per-platform server archive, so the supervisor has nothing to install from
 * it. It also has no insecure-URL test override: every artifact URL is HTTPS.
 */
import { createPublicKey, type KeyObject, verify } from 'node:crypto';
import {
  findPortableServerTarget,
  type PortableServerArch,
  type PortableServerFormat,
  type PortableServerOs,
  portableServerArchiveName,
} from './portable-server-targets.mjs';

const SHA256 = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const RELEASE = '(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)';
const NODE_VERSION = new RegExp(`^${RELEASE}$`);
const KEY_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
// Each channel owns exactly one version shape. This mirrors the signer's
// table; TODO(#2675): derive both from the generated release-ring table once
// #2688 lands it (STATION_RELEASE_RINGS_DATA).
const CHANNEL_VERSION: Readonly<Record<string, RegExp>> = {
  stable: new RegExp(`^${RELEASE}$`),
  preview: new RegExp(`^${RELEASE}-preview\\.([1-9][0-9]*)$`),
  nightly: new RegExp(`^${RELEASE}-nightly\\.([1-9][0-9]*)$`),
};
const ENVELOPE_KEYS = [
  'algorithm',
  'keyId',
  'payload',
  'schemaVersion',
  'signature',
];
const KEY_ENTRY_KEYS = ['algorithm', 'channels', 'keyId', 'publicKeySpkiPem'];
const PAYLOAD_KEYS = [
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

export type ReleaseManifestArtifact = {
  os: PortableServerOs;
  arch: PortableServerArch;
  name: string;
  url: string;
  sha256: string;
  size: number;
  format: PortableServerFormat;
};

export type ReleaseManifestPayload = {
  schemaVersion: 2;
  channel: string;
  version: string;
  releaseTag: string;
  sourceSha: string;
  publishedAt: string;
  nodeVersion: string;
  launcherProtocol: { min: number; max: number };
  artifacts: ReleaseManifestArtifact[];
};

/** The pinned signing-key table: config/release-manifest-keys.json's shape. */
export type ReleaseManifestKeyTable = {
  keys: ReadonlyArray<{
    keyId: string;
    algorithm: string;
    publicKeySpkiPem: string;
    channels: readonly string[];
  }>;
};

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Json {
  return (
    isObject(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys)
  );
}

/** The signed bytes: recursive sorted-key JSON with no whitespace. */
export function canonicalManifestJson(value: unknown): string {
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

/** Only a URL that is already its own canonical href, with no spaces. */
function isCanonicalUrl(value: unknown): value is string {
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

function readKeyTable(table: unknown) {
  if (!hasExactKeys(table, ['keys']) || !Array.isArray(table.keys))
    throw new Error('signing-key table has an unexpected shape');
  const entries = new Map<string, { channels: string[]; key: KeyObject }>();
  for (const entry of table.keys as unknown[]) {
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
    entries.set(entry.keyId, { channels: entry.channels, key });
  }
  return entries;
}

function validateCommonPayload(payload: Json) {
  if (typeof payload.sourceSha !== 'string' || !SHA.test(payload.sourceSha))
    throw new Error('invalid source SHA');
  if (
    typeof payload.publishedAt !== 'string' ||
    Number.isNaN(new Date(payload.publishedAt).getTime()) ||
    new Date(payload.publishedAt).toISOString() !== payload.publishedAt
  )
    throw new Error('invalid publication timestamp');
}

function validateArtifact(artifact: unknown, index: number): string {
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
  if (!isCanonicalUrl(artifact.url) || !artifact.url.startsWith('https://'))
    throw new Error(`platform artifact ${id} url is not a canonical HTTPS URL`);
  if (typeof artifact.sha256 !== 'string' || !SHA256.test(artifact.sha256))
    throw new Error(`platform artifact ${id} sha256 is invalid`);
  if (
    typeof artifact.size !== 'number' ||
    !Number.isSafeInteger(artifact.size) ||
    artifact.size <= 0
  )
    throw new Error(`platform artifact ${id} size is invalid`);
  return id;
}

function validateArtifacts(artifacts: unknown) {
  if (!Array.isArray(artifacts) || artifacts.length === 0)
    throw new Error('invalid artifact set');
  const ids = artifacts.map(validateArtifact);
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`duplicate platform artifact ${id}`);
    seen.add(id);
  }
  // The signed bytes depend on the order, so it is part of the schema.
  for (let index = 1; index < artifacts.length; index += 1) {
    const previous = artifacts[index - 1] as ReleaseManifestArtifact;
    const current = artifacts[index] as ReleaseManifestArtifact;
    if (
      previous.os > current.os ||
      (previous.os === current.os && previous.arch > current.arch)
    )
      throw new Error('platform artifacts are not sorted by os, then arch');
  }
}

function validatePayload(payload: unknown): ReleaseManifestPayload {
  if (!isObject(payload))
    throw new Error('manifest payload has an unexpected shape');
  if (payload.schemaVersion !== 2)
    throw new Error('unsupported manifest schema');
  if (!hasExactKeys(payload, PAYLOAD_KEYS))
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
    typeof protocol.min !== 'number' ||
    typeof protocol.max !== 'number' ||
    !Number.isSafeInteger(protocol.min) ||
    !Number.isSafeInteger(protocol.max) ||
    protocol.min < 1 ||
    protocol.max < protocol.min
  )
    throw new Error('invalid launcher protocol range');
  validateArtifacts(payload.artifacts);
  return payload as ReleaseManifestPayload;
}

/**
 * Verifies `envelope` (the parsed manifest JSON) against the pinned `keys`
 * and returns its payload, or throws with the reason. The envelope's keyId
 * must name a pinned key authorized for the payload's channel, in the same
 * order of checks as the signer's `verify`. `expectedChannel`, when given,
 * additionally refuses a validly signed manifest for another channel.
 */
export function verifyReleaseManifest(
  envelope: unknown,
  keys: ReleaseManifestKeyTable | unknown,
  options: { expectedChannel?: string } = {},
): ReleaseManifestPayload {
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
  const entry = readKeyTable(keys).get(envelope.keyId);
  if (!entry)
    throw new Error(`manifest signing key ${envelope.keyId} is not pinned`);
  const channel = isObject(envelope.payload)
    ? envelope.payload.channel
    : undefined;
  if (typeof channel !== 'string' || !entry.channels.includes(channel))
    throw new Error(
      `signing key ${envelope.keyId} is not authorized for channel ${String(channel)}`,
    );
  if (
    !verify(
      null,
      Buffer.from(canonicalManifestJson(envelope.payload)),
      entry.key,
      Buffer.from(envelope.signature, 'base64'),
    )
  )
    throw new Error('manifest signature did not verify');
  const payload = validatePayload(envelope.payload);
  if (
    options.expectedChannel !== undefined &&
    payload.channel !== options.expectedChannel
  )
    throw new Error(
      `manifest channel ${payload.channel} does not match the expected channel ${options.expectedChannel}`,
    );
  return payload;
}

/**
 * The artifact a host of `os`/`arch` installs (process.platform and
 * process.arch), or a thrown error when the manifest publishes none for it.
 */
export function selectArtifact(
  payload: ReleaseManifestPayload,
  os: string,
  arch: string,
): ReleaseManifestArtifact {
  const artifact = payload.artifacts.find(
    (candidate) => candidate.os === os && candidate.arch === arch,
  );
  if (!artifact)
    throw new Error(
      `the release manifest has no server archive for ${os}-${arch}`,
    );
  return artifact;
}
