#!/usr/bin/env node
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findPortableServerTarget,
  portableServerArchiveName,
} from '../packages/shared/src/portable-server-targets.mjs';

const SHA256 = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const RELEASE = '(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)';
// Schema v1 (stable/preview with a macOS cask) keeps its original grammar.
const VERSION = new RegExp(`^${RELEASE}(-preview\\.([1-9][0-9]*))?$`);
// Schema v2 is portable-only and adds the nightly channel. Each channel owns
// exactly one version shape, so a payload cannot claim one ring while carrying
// another ring's version.
const CHANNEL_VERSION = {
  stable: new RegExp(`^${RELEASE}$`),
  preview: new RegExp(`^${RELEASE}-preview\\.([1-9][0-9]*)$`),
  nightly: new RegExp(`^${RELEASE}-nightly\\.([1-9][0-9]*)$`),
};
const KEY_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DEFAULT_KEY_TABLE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../config/release-manifest-keys.json',
);
const allowInsecureTestUrls =
  process.env.STATION_ECOSYSTEM_ALLOW_INSECURE_TEST_URLS === '1';

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}`);
  return process.argv[index + 1];
}

function optionalOption(name) {
  return process.argv.includes(name) ? option(name) : undefined;
}

/**
 * The signed bytes: recursive sorted-key JSON with no whitespace. install.sh
 * carries an independent copy of this function; the golden vector in
 * ecosystem-manifest.test.ts pins both to the same bytes.
 */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}

function hasExactKeys(value, keys) {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys)
  );
}

/**
 * The URL an installer fetches must be exactly the signed string. `new URL()`
 * silently strips tabs and newlines (and normalizes other input), so only a
 * URL that is already its own canonical href, with no control characters or
 * spaces, is accepted.
 */
function isCanonicalUrl(value) {
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

function validateArtifact(kind, artifact, name) {
  if (
    !hasExactKeys(artifact, ['name', 'sha256', 'url']) ||
    typeof artifact.name !== 'string' ||
    !name.test(artifact.name) ||
    !isCanonicalUrl(artifact.url) ||
    !/^(https?:\/\/|file:\/\/)/.test(artifact.url) ||
    (!allowInsecureTestUrls && !artifact.url.startsWith('https://')) ||
    typeof artifact.sha256 !== 'string' ||
    !SHA256.test(artifact.sha256)
  )
    throw new Error(`invalid ${kind} artifact descriptor`);
}

const PORTABLE_NAME = /^station-[A-Za-z0-9._-]+\.tar\.gz$/;
const PAYLOAD_KEYS_V1 = [
  'artifacts',
  'channel',
  'publishedAt',
  'releaseTag',
  'schemaVersion',
  'sourceSha',
  'version',
];
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
const PLATFORM_ARTIFACT_KEYS = [
  'arch',
  'format',
  'name',
  'os',
  'sha256',
  'size',
  'url',
];
const NODE_VERSION = new RegExp(`^${RELEASE}$`);

function validateCommonPayload(payload) {
  if (typeof payload.sourceSha !== 'string' || !SHA.test(payload.sourceSha))
    throw new Error('invalid source SHA');
  if (
    typeof payload.publishedAt !== 'string' ||
    Number.isNaN(new Date(payload.publishedAt).getTime()) ||
    new Date(payload.publishedAt).toISOString() !== payload.publishedAt
  )
    throw new Error('invalid publication timestamp');
}

// Schema v2: portable-only, stable | preview | nightly.
//
// One prebuilt server archive per platform (#2675). packages/shared's
// release-manifest.ts verifies the same schema for the service supervisor;
// the shared golden vectors in release-manifest-vectors.test.ts hold the two
// to the same accept/reject decisions and reasons.
function validatePayloadV2(payload) {
  if (!Object.hasOwn(CHANNEL_VERSION, payload.channel))
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
  validatePlatformArtifacts(payload.artifacts);
  return payload;
}

function validatePlatformArtifact(artifact, index) {
  if (
    !hasExactKeys(artifact, PLATFORM_ARTIFACT_KEYS) ||
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
  if (
    !isCanonicalUrl(artifact.url) ||
    !(
      artifact.url.startsWith('https://') ||
      (allowInsecureTestUrls && /^(http|file):\/\//.test(artifact.url))
    )
  )
    throw new Error(`platform artifact ${id} url is not a canonical HTTPS URL`);
  if (typeof artifact.sha256 !== 'string' || !SHA256.test(artifact.sha256))
    throw new Error(`platform artifact ${id} sha256 is invalid`);
  if (!Number.isSafeInteger(artifact.size) || artifact.size <= 0)
    throw new Error(`platform artifact ${id} size is invalid`);
  return id;
}

/**
 * The signed bytes depend on array order, so the order is part of the
 * schema: one entry per target, sorted by os, then arch (code-point order).
 */
function validatePlatformArtifacts(artifacts) {
  if (!Array.isArray(artifacts) || artifacts.length === 0)
    throw new Error('invalid artifact set');
  const ids = artifacts.map(validatePlatformArtifact);
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`duplicate platform artifact ${id}`);
    seen.add(id);
  }
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

// Schema v1: stable | preview, with the macOS cask artifact. Kept for the
// existing cask renderer and fixtures.
function validatePayloadV1(payload) {
  if (!['stable', 'preview'].includes(payload.channel))
    throw new Error('invalid manifest channel');
  if (typeof payload.version !== 'string' || !VERSION.test(payload.version))
    throw new Error('invalid manifest version');
  if (payload.releaseTag !== `v${payload.version}`)
    throw new Error('release tag does not match version');
  const isPreviewTag = payload.version.includes('-preview.');
  if (
    (payload.channel === 'stable' && isPreviewTag) ||
    (payload.channel === 'preview' && !isPreviewTag)
  )
    throw new Error('manifest channel does not match release tag');
  validateCommonPayload(payload);
  if (!hasExactKeys(payload.artifacts, ['macos', 'portable']))
    throw new Error('invalid artifact set');
  validateArtifact(
    'macos',
    payload.artifacts.macos,
    /^station-[A-Za-z0-9._-]+\.dmg$/,
  );
  validateArtifact('portable', payload.artifacts.portable, PORTABLE_NAME);
  return payload;
}

// Each schema owns an exact key set: a v2 payload under schema 1, or v1 keys
// under schema 2, is malformed rather than read as the other shape.
const SCHEMAS = {
  1: { keys: PAYLOAD_KEYS_V1, validate: validatePayloadV1 },
  2: { keys: PAYLOAD_KEYS_V2, validate: validatePayloadV2 },
};

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new Error('manifest payload has an unexpected shape');
  const schema =
    payload.schemaVersion === 1 || payload.schemaVersion === 2
      ? SCHEMAS[payload.schemaVersion]
      : undefined;
  if (!schema) throw new Error('unsupported manifest schema');
  if (!hasExactKeys(payload, schema.keys))
    throw new Error('manifest payload has an unexpected shape');
  return schema.validate(payload);
}

function readEnvelope(path) {
  const envelope = readJson(path);
  if (
    !hasExactKeys(envelope, [
      'algorithm',
      'keyId',
      'payload',
      'schemaVersion',
      'signature',
    ]) ||
    envelope.schemaVersion !== 1 ||
    envelope.algorithm !== 'ed25519' ||
    typeof envelope.keyId !== 'string' ||
    !KEY_ID.test(envelope.keyId) ||
    typeof envelope.signature !== 'string' ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.signature)
  )
    throw new Error('manifest envelope has an unexpected shape');
  return envelope;
}

/**
 * The pinned signing-key table (config/release-manifest-keys.json). install.sh
 * embeds a copy of the same table; a unit test holds the two equal.
 */
function readKeyTable(path) {
  const table = readJson(path);
  if (!hasExactKeys(table, ['keys']) || !Array.isArray(table.keys))
    throw new Error('signing-key table has an unexpected shape');
  const seen = new Set();
  for (const entry of table.keys) {
    if (
      !hasExactKeys(entry, [
        'algorithm',
        'channels',
        'keyId',
        'publicKeySpkiPem',
      ]) ||
      entry.algorithm !== 'ed25519' ||
      typeof entry.keyId !== 'string' ||
      !KEY_ID.test(entry.keyId) ||
      seen.has(entry.keyId) ||
      !Array.isArray(entry.channels) ||
      entry.channels.length === 0 ||
      !entry.channels.every((channel) =>
        Object.hasOwn(CHANNEL_VERSION, channel),
      ) ||
      typeof entry.publicKeySpkiPem !== 'string' ||
      createPublicKey(entry.publicKeySpkiPem).asymmetricKeyType !== 'ed25519'
    )
      throw new Error('signing-key table has an invalid entry');
    seen.add(entry.keyId);
  }
  return table.keys;
}

function assertChannelAllowed(entry, payload) {
  if (!entry.channels.includes(payload?.channel))
    throw new Error(
      `signing key ${entry.keyId} is not authorized for channel ${String(payload?.channel)}`,
    );
}

/**
 * `publicKey` verifies against one explicit PEM and applies no key-id policy;
 * it exists for the cask dry-run and test fixtures. Otherwise the envelope's
 * keyId must name a pinned key that is authorized for the payload's channel.
 */
export function verifyManifest({ manifest, publicKey, keyTable }) {
  const envelope = readEnvelope(manifest);
  let key;
  if (publicKey) {
    key = createPublicKey(readFileSync(resolve(publicKey), 'utf8'));
  } else {
    const entry = readKeyTable(keyTable ?? DEFAULT_KEY_TABLE).find(
      (candidate) => candidate.keyId === envelope.keyId,
    );
    if (!entry)
      throw new Error(`manifest signing key ${envelope.keyId} is not pinned`);
    assertChannelAllowed(entry, envelope.payload);
    key = createPublicKey(entry.publicKeySpkiPem);
  }
  const signature = Buffer.from(envelope.signature, 'base64');
  if (!verify(null, Buffer.from(canonical(envelope.payload)), key, signature))
    throw new Error('manifest signature did not verify');
  return validatePayload(envelope.payload);
}

const DESCRIPTOR_FILE = /^station-server-.+\.(tar\.gz|zip)\.json$/;

/** Every archive descriptor under `root`, found recursively. */
function findDescriptors(root) {
  const found = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...findDescriptors(path));
    else if (entry.isFile() && DESCRIPTOR_FILE.test(entry.name))
      found.push(path);
  }
  return found.sort();
}

function parsePositiveInteger(name, value) {
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error(`${name} must be a positive integer`);
  return Number(value);
}

/**
 * A schema v2 payload built from the descriptors the portable archive build
 * writes beside each archive (`<archive>.json`), so no digest or size is ever
 * typed by hand. `baseUrl` must be the versioned release-asset directory: a
 * rolling pointer would make a pinned or rollback manifest resolve to other
 * bytes than it signed.
 */
function assemblePayload({
  descriptorsDir,
  version,
  channel,
  sourceSha,
  baseUrl,
  nodeVersion,
  launcherProtocolMin,
  launcherProtocolMax,
  publishedAt,
}) {
  const releaseTag = `v${version}`;
  if (
    !isCanonicalUrl(baseUrl) ||
    !baseUrl.startsWith('https://') ||
    !baseUrl.endsWith('/')
  )
    throw new Error(
      '--base-url must be a canonical HTTPS URL ending in a slash',
    );
  const segments = new URL(baseUrl).pathname.split('/');
  if (!segments.includes(releaseTag) || segments.includes('latest'))
    throw new Error(
      `--base-url must name the versioned release ${releaseTag}, not a rolling pointer`,
    );
  if (!NODE_VERSION.test(nodeVersion))
    throw new Error('--node-version must be MAJOR.MINOR.PATCH');
  const paths = findDescriptors(resolve(descriptorsDir));
  if (paths.length === 0)
    throw new Error(`no archive descriptors found under ${descriptorsDir}`);
  const byTarget = new Map();
  const nodeVersions = new Set();
  for (const path of paths) {
    const descriptor = readJson(path);
    const where = basename(path);
    const [os, arch, ...rest] =
      typeof descriptor?.target === 'string'
        ? descriptor.target.split('-')
        : [];
    const target =
      rest.length === 0 ? findPortableServerTarget(os, arch) : undefined;
    if (descriptor?.schemaVersion !== 1 || !target)
      throw new Error(`${where}: not a supported archive descriptor`);
    const name = portableServerArchiveName(target);
    if (
      descriptor.format !== target.format ||
      descriptor.name !== name ||
      where !== `${name}.json`
    )
      throw new Error(`${where}: name or format does not match ${name}`);
    if (
      typeof descriptor.sha256 !== 'string' ||
      !SHA256.test(descriptor.sha256)
    )
      throw new Error(`${where}: malformed sha256`);
    if (!Number.isSafeInteger(descriptor.size) || descriptor.size <= 0)
      throw new Error(`${where}: malformed size`);
    const release = descriptor.release;
    if (
      release?.sha !== sourceSha ||
      release?.ref !== releaseTag ||
      release?.releaseChannel !== channel
    )
      throw new Error(
        `${where}: built for ${String(release?.ref)} (${String(release?.releaseChannel)}) at ${String(release?.sha)}, not ${releaseTag} (${channel}) at ${sourceSha}`,
      );
    if (byTarget.has(descriptor.target))
      throw new Error(`duplicate archive descriptor for ${descriptor.target}`);
    nodeVersions.add(descriptor.node?.version);
    byTarget.set(descriptor.target, {
      os: target.os,
      arch: target.arch,
      name,
      url: new URL(name, baseUrl).href,
      sha256: descriptor.sha256,
      size: descriptor.size,
      format: target.format,
    });
  }
  if (nodeVersions.size !== 1)
    throw new Error(
      `archive descriptors disagree on the Node.js version: ${[...nodeVersions].map(String).join(', ')}`,
    );
  const [bundledNode] = nodeVersions;
  if (bundledNode !== nodeVersion)
    throw new Error(
      `archives bundle Node.js ${String(bundledNode)}, not the pinned ${nodeVersion}`,
    );
  const artifacts = [...byTarget.values()].sort((left, right) =>
    left.os === right.os
      ? left.arch < right.arch
        ? -1
        : 1
      : left.os < right.os
        ? -1
        : 1,
  );
  return validatePayload({
    schemaVersion: 2,
    channel,
    version,
    releaseTag,
    sourceSha,
    publishedAt,
    nodeVersion,
    launcherProtocol: { min: launcherProtocolMin, max: launcherProtocolMax },
    artifacts,
  });
}

function renderCask(payload) {
  return `cask "station" do\n  version "${payload.version}"\n  sha256 "${payload.artifacts.macos.sha256}"\n\n  url "${payload.artifacts.macos.url}"\n  name "Station"\n  desc "Local-first agent workspace"\n  homepage "https://station.kontour.ai"\n\n  app "Station.app"\nend\n`;
}

try {
  const command = process.argv[2];
  if (command === 'create') {
    const payload = validatePayload(readJson(option('--payload')));
    const keyId = option('--key-id');
    if (!KEY_ID.test(keyId)) throw new Error('invalid signing key id');
    // A pinned key id may only sign the channels it is pinned for; refuse to
    // emit an envelope every installer would reject.
    const pinned = readKeyTable(DEFAULT_KEY_TABLE).find(
      (entry) => entry.keyId === keyId,
    );
    if (pinned) assertChannelAllowed(pinned, payload);
    // No installer trusts an unpinned key id, so emitting one is only useful
    // for fixtures and dry-runs; make that an explicit choice.
    else if (!process.argv.includes('--allow-unpinned-key'))
      throw new Error(
        `signing key id ${keyId} is not pinned; pass --allow-unpinned-key for a test or dry-run manifest`,
      );
    const privateKey = createPrivateKey(
      readFileSync(resolve(option('--private-key')), 'utf8'),
    );
    const envelope = {
      schemaVersion: 1,
      algorithm: 'ed25519',
      keyId,
      payload,
      signature: sign(
        null,
        Buffer.from(canonical(payload)),
        privateKey,
      ).toString('base64'),
    };
    writeFileSync(
      resolve(option('--output')),
      `${JSON.stringify(envelope, null, 2)}\n`,
    );
  } else if (command === 'assemble') {
    // TODO(#2675): once config/portable-server-node-runtime.json lands with
    // the archive build (#2705), default --node-version from it and refuse a
    // value that differs.
    const payload = assemblePayload({
      descriptorsDir: option('--descriptors'),
      version: option('--version'),
      channel: option('--channel'),
      sourceSha: option('--source-sha'),
      baseUrl: option('--base-url'),
      nodeVersion: option('--node-version'),
      launcherProtocolMin: parsePositiveInteger(
        '--launcher-protocol-min',
        option('--launcher-protocol-min'),
      ),
      launcherProtocolMax: parsePositiveInteger(
        '--launcher-protocol-max',
        option('--launcher-protocol-max'),
      ),
      publishedAt: optionalOption('--published-at') ?? new Date().toISOString(),
    });
    writeFileSync(
      resolve(option('--output')),
      `${JSON.stringify(payload, null, 2)}\n`,
    );
  } else if (command === 'verify') {
    const payload = verifyManifest({
      manifest: option('--manifest'),
      publicKey: optionalOption('--public-key'),
      keyTable: optionalOption('--keys'),
    });
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } else if (command === 'cask') {
    const payload = verifyManifest({
      manifest: option('--manifest'),
      publicKey: optionalOption('--public-key'),
      keyTable: optionalOption('--keys'),
    });
    if (payload.schemaVersion !== 1)
      throw new Error(
        'the cask requires a schema v1 manifest with a macOS artifact',
      );
    writeFileSync(resolve(option('--output')), renderCask(payload));
  } else {
    throw new Error(
      'Usage: ecosystem-manifest.mjs <create|verify|cask|assemble> ...',
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
