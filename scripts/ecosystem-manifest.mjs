#!/usr/bin/env node
// The manifest signer's CLI: create | verify | cask | assemble. Canonical
// bytes, the pinned key table, the envelope and schema v2 come from the one
// shared implementation (packages/shared/src/release-manifest.mjs); schema v1
// (the macOS cask shape) is read only here.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from 'node:crypto';
import {
  closeSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findPortableServerTarget,
  PORTABLE_SERVER_TARGETS,
  portableServerArchiveName,
} from '../packages/shared/src/portable-server-targets.mjs';
import {
  assertEnvelopeShape,
  assertEnvelopeSignature,
  canonicalManifestJson,
  hasExactKeys,
  isCanonicalUrl,
  isHttpsArtifactUrl,
  isPlainCanonicalUrl,
  KEY_ID,
  NODE_VERSION,
  parseKeyTable,
  pinnedKeyFor,
  SHA256_HEX,
  validateCommonPayload,
  validateReleaseManifestPayloadV2,
} from '../packages/shared/src/release-manifest.mjs';

const RELEASE = '(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)';
// Schema v1 (stable/preview with a macOS cask) keeps its original grammar.
const VERSION = new RegExp(`^${RELEASE}(-preview\\.([1-9][0-9]*))?$`);
const DEFAULT_KEY_TABLE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../config/release-manifest-keys.json',
);
const allowInsecureTestUrls =
  process.env.STATION_ECOSYSTEM_ALLOW_INSECURE_TEST_URLS === '1';
// The explicit test escape: fixtures may point artifacts at http:// or
// file:// URLs. A published manifest never needs it, and the shared
// verifyReleaseManifest has no such escape.
const isAllowedArtifactUrl = allowInsecureTestUrls
  ? (value) => isPlainCanonicalUrl(value, ['https:', 'http:', 'file:'])
  : isHttpsArtifactUrl;

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}`);
  return process.argv[index + 1];
}

function optionalOption(name) {
  return process.argv.includes(name) ? option(name) : undefined;
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
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
    !SHA256_HEX.test(artifact.sha256)
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

// Schema v1: stable | preview, with the macOS cask artifact. Kept for the
// existing cask renderer and fixtures.
function validatePayloadV1(payload) {
  if (!hasExactKeys(payload, PAYLOAD_KEYS_V1))
    throw new Error('manifest payload has an unexpected shape');
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
function validatePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new Error('manifest payload has an unexpected shape');
  if (payload.schemaVersion === 1) return validatePayloadV1(payload);
  if (payload.schemaVersion === 2)
    return validateReleaseManifestPayloadV2(payload, { isAllowedArtifactUrl });
  throw new Error('unsupported manifest schema');
}

/**
 * `publicKey` verifies against one explicit PEM and applies no key-id policy;
 * it exists for the cask dry-run and test fixtures. Otherwise the envelope's
 * keyId must name a pinned key that is authorized for the payload's channel.
 */
function verifyManifest({ manifest, publicKey, keyTable }) {
  const envelope = assertEnvelopeShape(readJson(manifest));
  const key = publicKey
    ? createPublicKey(readFileSync(resolve(publicKey), 'utf8'))
    : pinnedKeyFor(
        parseKeyTable(readJson(keyTable ?? DEFAULT_KEY_TABLE)),
        envelope.keyId,
        envelope.payload?.channel,
      );
  assertEnvelopeSignature(envelope, key);
  return validatePayload(envelope.payload);
}

const DESCRIPTOR_FILE = /^station-server-.+\.(tar\.gz|zip)\.json$/;

/**
 * Every archive descriptor under `root`, found recursively. A symbolic link
 * anywhere in the tree is refused rather than skipped or followed: it could
 * substitute another build's descriptor or hide one.
 */
function findDescriptors(root) {
  if (lstatSync(root).isSymbolicLink())
    throw new Error(`descriptor tree contains a symbolic link: ${root}`);
  const found = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`descriptor tree contains a symbolic link: ${path}`);
    if (entry.isDirectory()) found.push(...findDescriptors(path));
    else if (entry.isFile() && DESCRIPTOR_FILE.test(entry.name))
      found.push(path);
  }
  return found.sort();
}

/** The size and sha256 of a regular file, read in bounded chunks. */
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

function parsePositiveInteger(name, value) {
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error(`${name} must be a positive integer`);
  return Number(value);
}

/**
 * The target ids a manifest must publish: every portable server target,
 * unless `--targets` names an explicit subset or `--allow-partial` accepts
 * whatever the descriptors cover (undefined).
 */
function requiredTargets(targets, allowPartial) {
  if (allowPartial && targets !== undefined)
    throw new Error('--targets and --allow-partial are mutually exclusive');
  if (allowPartial) return undefined;
  if (targets === undefined)
    return PORTABLE_SERVER_TARGETS.map(({ os, arch }) => `${os}-${arch}`);
  const ids = targets.split(',');
  for (const id of ids) {
    const [os, arch, ...rest] = id.split('-');
    if (rest.length > 0 || !findPortableServerTarget(os, arch))
      throw new Error(`--targets names an unsupported target: ${id}`);
  }
  if (new Set(ids).size !== ids.length)
    throw new Error('--targets names a target twice');
  return ids;
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
  targets,
}) {
  const releaseTag = `v${version}`;
  if (!isHttpsArtifactUrl(baseUrl) || !baseUrl.endsWith('/'))
    throw new Error(
      '--base-url must be a canonical HTTPS URL ending in a slash, with no userinfo, query or fragment',
    );
  const segments = new URL(baseUrl).pathname.split('/');
  if (
    !segments.includes(releaseTag) ||
    segments.some((segment) => segment.toLowerCase() === 'latest')
  )
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
      !SHA256_HEX.test(descriptor.sha256)
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
    // When the archive sits beside its descriptor (a local or single-job
    // assembly), its bytes must be the ones described. Otherwise the
    // descriptor is trusted here; the publishing job (slice E) re-downloads
    // each uploaded asset and compares it with the signed manifest.
    const archive = join(dirname(path), name);
    let stat;
    try {
      stat = lstatSync(archive);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (stat) {
      if (!stat.isFile())
        throw new Error(`${name}: beside its descriptor but not a file`);
      const actual = describeFile(archive);
      if (
        actual.size !== descriptor.size ||
        actual.sha256 !== descriptor.sha256
      )
        throw new Error(
          `${name}: the archive beside its descriptor is not the one it describes`,
        );
    }
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
  if (targets) {
    const missing = targets.filter((id) => !byTarget.has(id));
    const extra = [...byTarget.keys()].filter((id) => !targets.includes(id));
    if (missing.length > 0 || extra.length > 0)
      throw new Error(
        `archive descriptors do not cover the required targets (missing: ${missing.join(', ') || 'none'}; unexpected: ${extra.join(', ') || 'none'}); pass --targets or --allow-partial for a partial manifest`,
      );
  }
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
    const pinned = parseKeyTable(readJson(DEFAULT_KEY_TABLE));
    if (pinned.has(keyId)) pinnedKeyFor(pinned, keyId, payload.channel);
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
        Buffer.from(canonicalManifestJson(payload)),
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
      targets: requiredTargets(
        optionalOption('--targets'),
        process.argv.includes('--allow-partial'),
      ),
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
