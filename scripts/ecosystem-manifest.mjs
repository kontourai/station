#!/usr/bin/env node
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

function validateArtifact(kind, artifact, name) {
  if (
    !hasExactKeys(artifact, ['name', 'sha256', 'url']) ||
    typeof artifact.name !== 'string' ||
    !name.test(artifact.name) ||
    typeof artifact.url !== 'string' ||
    !/^(https?:\/\/|file:\/\/)/.test(artifact.url) ||
    (!allowInsecureTestUrls && !artifact.url.startsWith('https://')) ||
    typeof artifact.sha256 !== 'string' ||
    !SHA256.test(artifact.sha256)
  )
    throw new Error(`invalid ${kind} artifact descriptor`);
}

const PORTABLE_NAME = /^station-[A-Za-z0-9._-]+\.tar\.gz$/;
const PAYLOAD_KEYS = [
  'artifacts',
  'channel',
  'publishedAt',
  'releaseTag',
  'schemaVersion',
  'sourceSha',
  'version',
];

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
  if (!hasExactKeys(payload.artifacts, ['portable']))
    throw new Error('invalid artifact set');
  validateArtifact('portable', payload.artifacts.portable, PORTABLE_NAME);
  return payload;
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

function validatePayload(payload) {
  if (!hasExactKeys(payload, PAYLOAD_KEYS))
    throw new Error('manifest payload has an unexpected shape');
  if (payload.schemaVersion === 1) return validatePayloadV1(payload);
  if (payload.schemaVersion === 2) return validatePayloadV2(payload);
  throw new Error('unsupported manifest schema');
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
    throw new Error('Usage: ecosystem-manifest.mjs <create|verify|cask> ...');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
