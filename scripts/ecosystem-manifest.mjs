#!/usr/bin/env node
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SHA256 = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const VERSION =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-preview\.([1-9][0-9]*))?$/;
const allowInsecureTestUrls =
  process.env.STATION_ECOSYSTEM_ALLOW_INSECURE_TEST_URLS === '1';

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}`);
  return process.argv[index + 1];
}

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

function validatePayload(payload) {
  const expected = [
    'artifacts',
    'channel',
    'publishedAt',
    'releaseTag',
    'schemaVersion',
    'sourceSha',
    'version',
  ];
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    JSON.stringify(Object.keys(payload).sort()) !== JSON.stringify(expected)
  )
    throw new Error('manifest payload has an unexpected shape');
  if (payload.schemaVersion !== 1)
    throw new Error('unsupported manifest schema');
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
  if (typeof payload.sourceSha !== 'string' || !SHA.test(payload.sourceSha))
    throw new Error('invalid source SHA');
  if (
    typeof payload.publishedAt !== 'string' ||
    new Date(payload.publishedAt).toISOString() !== payload.publishedAt
  )
    throw new Error('invalid publication timestamp');
  const artifacts = payload.artifacts;
  if (
    !artifacts ||
    typeof artifacts !== 'object' ||
    Array.isArray(artifacts) ||
    JSON.stringify(Object.keys(artifacts).sort()) !==
      JSON.stringify(['macos', 'portable'])
  )
    throw new Error('invalid artifact set');
  for (const [kind, name] of [
    ['macos', /^station-[A-Za-z0-9._-]+\.dmg$/],
    ['portable', /^station-[A-Za-z0-9._-]+\.tar\.gz$/],
  ]) {
    const artifact = artifacts[kind];
    if (
      !artifact ||
      typeof artifact !== 'object' ||
      Array.isArray(artifact) ||
      JSON.stringify(Object.keys(artifact).sort()) !==
        JSON.stringify(['name', 'sha256', 'url']) ||
      typeof artifact.name !== 'string' ||
      !name.test(artifact.name) ||
      typeof artifact.url !== 'string' ||
      !/^(https?:\/\/|file:\/\/)/.test(artifact.url) ||
      (!allowInsecureTestUrls && !artifact.url.startsWith('https://')) ||
      (artifact.url.startsWith('file://') && !allowInsecureTestUrls) ||
      typeof artifact.sha256 !== 'string' ||
      !SHA256.test(artifact.sha256)
    )
      throw new Error(`invalid ${kind} artifact descriptor`);
  }
  return payload;
}

function readEnvelope(path) {
  const envelope = readJson(path);
  if (
    !envelope ||
    typeof envelope !== 'object' ||
    Array.isArray(envelope) ||
    JSON.stringify(Object.keys(envelope).sort()) !==
      JSON.stringify([
        'algorithm',
        'keyId',
        'payload',
        'schemaVersion',
        'signature',
      ]) ||
    envelope.schemaVersion !== 1 ||
    envelope.algorithm !== 'ed25519' ||
    typeof envelope.keyId !== 'string' ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(envelope.keyId) ||
    typeof envelope.signature !== 'string' ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.signature)
  )
    throw new Error('manifest envelope has an unexpected shape');
  return envelope;
}

export function verifyManifest({ manifest, publicKey }) {
  const envelope = readEnvelope(manifest);
  const key = createPublicKey(readFileSync(resolve(publicKey), 'utf8'));
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
      publicKey: option('--public-key'),
    });
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } else if (command === 'cask') {
    const payload = verifyManifest({
      manifest: option('--manifest'),
      publicKey: option('--public-key'),
    });
    writeFileSync(resolve(option('--output')), renderCask(payload));
  } else {
    throw new Error('Usage: ecosystem-manifest.mjs <create|verify|cask> ...');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
