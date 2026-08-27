#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { canonicalJson } from './lib/release-sboms.mjs';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const PURL =
  /^pkg:([A-Za-z0-9.+-]+)\/[A-Za-z0-9._~%/-]+(?:@[A-Za-z0-9._~%+-]+)?(?:\?[A-Za-z0-9._~%&=.-]+)?(?:#[A-Za-z0-9._~%/-]+)?$/;
const HASH = /^[a-f0-9]{64}$/;
const PLATFORMS = ['linux/amd64', 'linux/arm64'];
export const ANCHORE_SBOM_ACTION =
  'anchore/sbom-action@e22c389904149dbc22b58101806040fa8d37a610';
export const SYFT_VERSION = '1.51.0';

function fail(message) {
  throw new Error(`Invalid container scanner SBOM: ${message}`);
}

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}`);
  return process.argv[index + 1];
}

function safeText(value, max = 512) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}

function exactObject(value, keys) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',')
  );
}

function descriptorBinding(descriptor, sourceSha) {
  if (
    !exactObject(descriptor, [
      'createdAt',
      'digest',
      'image',
      'platforms',
      'sha',
      'tag',
      'tags',
    ]) ||
    !safeText(descriptor.image, 240) ||
    descriptor.image.includes('@') ||
    !DIGEST.test(descriptor.digest ?? '') ||
    !SHA.test(descriptor.sha ?? '') ||
    descriptor.sha !== sourceSha ||
    JSON.stringify(descriptor.platforms) !== JSON.stringify(PLATFORMS)
  )
    fail('release descriptor is not the exact immutable image binding');
  return {
    digest: descriptor.digest,
    image: descriptor.image,
    platforms: [...descriptor.platforms],
  };
}

function licenses(value) {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map((item) => (typeof item === 'string' ? item : item?.license?.id))
        .filter(
          (id) => typeof id === 'string' && /^[A-Za-z0-9.+-]{1,128}$/.test(id),
        ),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

function normalizeComponent(component, strict = false) {
  if (
    strict &&
    !exactObject(component, ['hashes', 'licenses', 'name', 'purl', 'version'])
  )
    fail('scratch source component has an invalid identity envelope');
  const purl = component?.purl;
  const match = typeof purl === 'string' ? purl.match(PURL) : null;
  if (!match) return null;
  if (!safeText(component.name, 240) || !safeText(component.version, 160))
    fail('scanner package has an incomplete identity');
  const hashes = Array.isArray(component.hashes)
    ? component.hashes
        .filter(
          (hash) =>
            hash?.alg === 'SHA-256' &&
            typeof hash.content === 'string' &&
            HASH.test(hash.content),
        )
        .map((hash) => ({ alg: 'SHA-256', content: hash.content }))
    : [];
  if (new Set(hashes.map((hash) => hash.content)).size !== hashes.length)
    fail('scanner package has duplicate SHA-256 hashes');
  return {
    component: {
      hashes: hashes.sort((a, b) => a.content.localeCompare(b.content)),
      licenses: licenses(component.licenses),
      name: component.name,
      purl,
      version: component.version,
    },
    ecosystem: match[1],
  };
}

export function createContainerScannerSource({
  inputs,
  input = undefined,
  descriptor,
  sourceSha,
}) {
  if (!SHA.test(sourceSha ?? '')) fail('source SHA is invalid');
  const binding = descriptorBinding(descriptor, sourceSha);
  // A compatibility-only single input would make a manifest-list scan look
  // verified.  Require both concrete platform scans and bind their digests.
  if (input !== undefined || !Array.isArray(inputs) || inputs.length !== 2)
    fail('scanner inputs must be exactly both required platforms');
  const seenPlatforms = new Set();
  const seenDigests = new Set();
  const inventories = inputs.map((entry) => {
    if (
      !entry ||
      !PLATFORMS.includes(entry.platform) ||
      seenPlatforms.has(entry.platform) ||
      !DIGEST.test(entry.digest ?? '') ||
      seenDigests.has(entry.digest) ||
      !entry.input ||
      typeof entry.input !== 'object' ||
      Array.isArray(entry.input) ||
      entry.input.bomFormat !== 'CycloneDX' ||
      entry.input.specVersion !== '1.6' ||
      !Array.isArray(entry.input.components) ||
      entry.input.components.length === 0 ||
      entry.input.components.length > 20_000
    )
      fail('scanner platform inventory is not exact and nonempty');
    seenPlatforms.add(entry.platform);
    seenDigests.add(entry.digest);
    const normalized = entry.input.components
      .map((component) => normalizeComponent(component))
      .filter((component) => component !== null);
    if (normalized.length === 0)
      fail('scanner platform inventory has no package-url package identities');
    return { digest: entry.digest, platform: entry.platform, normalized };
  });
  if (seenPlatforms.size !== PLATFORMS.length)
    fail('scanner inputs are missing a required platform');
  const normalized = inventories.flatMap((inventory) => inventory.normalized);
  const components = normalized
    .map((entry) => entry.component)
    .sort((left, right) =>
      canonicalJson(left).localeCompare(canonicalJson(right)),
    );
  // Identity is canonical across the two platform inventories.  An identical
  // package can legitimately be present on both platforms; retain it once.
  const unique = [
    ...new Map(
      components.map((component) => [canonicalJson(component), component]),
    ).values(),
  ];
  const ecosystems = [
    ...new Set(normalized.map((entry) => entry.ecosystem)),
  ].sort((left, right) => left.localeCompare(right));
  return {
    components: unique,
    digest: binding.digest,
    ecosystems,
    format: 'CycloneDX',
    image: binding.image,
    platformInventories: inventories
      .map(({ digest, platform }) => ({ digest, platform }))
      .sort((left, right) => left.platform.localeCompare(right.platform)),
    platforms: binding.platforms,
    predicate: 'image',
    scanner: { action: ANCHORE_SBOM_ACTION, syftVersion: SYFT_VERSION },
    source: 'container',
    sourceSha,
  };
}

export function containerSourceToFragment({ source, descriptor, sourceSha }) {
  if (
    !exactObject(source, [
      'components',
      'digest',
      'ecosystems',
      'format',
      'image',
      'platformInventories',
      'platforms',
      'predicate',
      'scanner',
      'source',
      'sourceSha',
    ]) ||
    source.source !== 'container' ||
    source.predicate !== 'image' ||
    source.format !== 'CycloneDX' ||
    source.sourceSha !== sourceSha ||
    !exactObject(source.scanner, ['action', 'syftVersion']) ||
    source.scanner.action !== ANCHORE_SBOM_ACTION ||
    source.scanner.syftVersion !== SYFT_VERSION
  )
    fail('scratch source has an invalid scanner envelope');
  const binding = descriptorBinding(descriptor, sourceSha);
  if (
    source.image !== binding.image ||
    source.digest !== binding.digest ||
    JSON.stringify(source.platforms) !== JSON.stringify(binding.platforms) ||
    !Array.isArray(source.platformInventories) ||
    source.platformInventories.length !== PLATFORMS.length ||
    !Array.isArray(source.components) ||
    source.components.length === 0 ||
    source.components.length > 20_000 ||
    !Array.isArray(source.ecosystems)
  )
    fail(
      'scratch source does not bind the recorded image digest and platforms',
    );
  const components = source.components.map((component) => {
    const normalized = normalizeComponent(component, true);
    if (!normalized) fail('scratch source contains a package without a purl');
    return normalized;
  });
  const platformKeys = source.platformInventories.map(
    (entry) => `${entry?.platform}:${entry?.digest}`,
  );
  if (
    new Set(platformKeys).size !== PLATFORMS.length ||
    !PLATFORMS.every((platform) =>
      source.platformInventories.some(
        (entry) =>
          entry?.platform === platform && DIGEST.test(entry?.digest ?? ''),
      ),
    )
  )
    fail('scratch source does not bind exactly both platform inventories');
  if (
    new Set(components.map((entry) => entry.component.purl)).size !==
    components.length
  )
    fail('scratch source has duplicate package-url identities');
  const ecosystems = [
    ...new Set(components.map((entry) => entry.ecosystem)),
  ].sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(source.ecosystems) !== JSON.stringify(ecosystems))
    fail('scratch source ecosystem envelope disagrees with package identities');
  return {
    components: components
      .map((entry) => entry.component)
      .sort((left, right) =>
        canonicalJson(left).localeCompare(canonicalJson(right)),
      ),
    predicate: 'image',
    source: 'container',
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const output = resolve(option('--output'));
    const sourceSha = option('--source-sha');
    const inputs = [
      ['linux/amd64', option('--amd64-digest'), option('--input-amd64')],
      ['linux/arm64', option('--arm64-digest'), option('--input-arm64')],
    ].map(([platform, digest, file]) => ({
      platform,
      digest,
      input: JSON.parse(readFileSync(resolve(file), 'utf8')),
    }));
    const descriptor = JSON.parse(
      readFileSync(resolve(option('--container-descriptor')), 'utf8'),
    );
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(
      output,
      canonicalJson(
        createContainerScannerSource({ inputs, descriptor, sourceSha }),
      ),
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
