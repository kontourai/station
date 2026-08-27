import { createHash, createPublicKey, verify } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  canonicalJson,
  SBOM_ASSETS,
  validateSbomBytes,
  validateSbomDescriptorSet,
} from './release-sboms.mjs';

const TAG =
  /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-preview\.([1-9][0-9]*))?$/;
const SHA = /^[0-9a-f]{40}$/;
const CHECKSUM = /^[0-9a-f]{64}$/;
const CONTAINER_DIGEST = /^sha256:[0-9a-f]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const MAX_INVENTORY_BYTES = 512 * 1024;
const schema = JSON.parse(
  readFileSync(
    new URL(
      '../../schemas/release-artifact-manifest.schema.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const schemaValidator = new Ajv2020({
  allErrors: true,
  formats: {
    'date-time': {
      type: 'string',
      validate: (value) =>
        !Number.isNaN(Date.parse(value)) &&
        new Date(value).toISOString() === value,
    },
  },
}).compile(schema);

function fail(message) {
  throw new Error(`Invalid release artifact inventory: ${message}`);
}

function regularFile(file, label = basename(file)) {
  let stat;
  try {
    stat = lstatSync(file);
  } catch {
    fail(`missing ${label}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile())
    fail(`${label} is not a regular file`);
  return file;
}

function decodeBase64(value, label) {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length % 4 !== 0 ||
    !BASE64.test(normalized)
  )
    fail(`${label} is not canonical base64`);
  const decoded = Buffer.from(normalized, 'base64');
  if (decoded.toString('base64') !== normalized)
    fail(`${label} is not canonical base64`);
  return decoded;
}

function readPublicKeyInput(input) {
  if (typeof input !== 'string' || input.trim() === '')
    fail('an updater public key is required');
  return existsSync(input) ? readFileSync(input, 'utf8') : input;
}

function parseTauriPublicKey(input) {
  const encodedFile = readPublicKeyInput(input).trim();
  const decodedFile = decodeBase64(encodedFile, 'updater public key').toString(
    'utf8',
  );
  const lines = decodedFile.trimEnd().split('\n');
  if (
    lines.length !== 2 ||
    !lines[0].startsWith('untrusted comment: minisign public key: ')
  )
    fail('updater public key has an invalid minisign envelope');
  const packet = decodeBase64(lines[1], 'updater public key packet');
  if (
    packet.length !== 42 ||
    (packet.subarray(0, 2).toString('ascii') !== 'Ed' &&
      packet.subarray(0, 2).toString('ascii') !== 'ED')
  )
    fail('updater public key packet is invalid');
  return {
    keyId: packet.subarray(2, 10),
    key: createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, packet.subarray(10)]),
      format: 'der',
      type: 'spki',
    }),
  };
}

function parseTauriSignature(file) {
  const encodedFile = readFileSync(file, 'utf8').trim();
  const decodedFile = decodeBase64(
    encodedFile,
    `updater signature ${basename(file)}`,
  ).toString('utf8');
  const lines = decodedFile.trimEnd().split('\n');
  if (
    lines.length !== 4 ||
    !lines[0].startsWith('untrusted comment: ') ||
    !lines[2].startsWith('trusted comment: ')
  )
    fail(`${basename(file)} has an invalid minisign envelope`);
  const packet = decodeBase64(lines[1], `${basename(file)} signature packet`);
  const globalSignature = decodeBase64(
    lines[3],
    `${basename(file)} global signature`,
  );
  if (
    packet.length !== 74 ||
    packet.subarray(0, 2).toString('ascii') !== 'ED' ||
    globalSignature.length !== 64
  )
    fail(`${basename(file)} is not a prehashed minisign signature`);
  return {
    keyId: packet.subarray(2, 10),
    signature: packet.subarray(10),
    trustedComment: lines[2].slice('trusted comment: '.length),
    globalSignature,
  };
}

export function verifyTauriUpdaterSignature({
  updater,
  signature,
  updaterPublicKey,
}) {
  const publicKey = parseTauriPublicKey(updaterPublicKey);
  const parsed = parseTauriSignature(signature);
  if (!publicKey.keyId.equals(parsed.keyId))
    fail(`${basename(signature)} was signed by an unexpected updater key`);
  const digest = createHash('blake2b512')
    .update(readFileSync(updater))
    .digest();
  if (!verify(null, digest, publicKey.key, parsed.signature))
    fail(`${basename(signature)} does not verify for ${basename(updater)}`);
  const globalMessage = Buffer.concat([
    parsed.signature,
    Buffer.from(parsed.trustedComment, 'utf8'),
  ]);
  if (!verify(null, globalMessage, publicKey.key, parsed.globalSignature))
    fail(`${basename(signature)} has an invalid trusted-comment signature`);
}

export function releaseVariants(tag) {
  if (!TAG.test(tag)) fail(`invalid tag ${tag}`);
  const variants = [
    [
      'portable-server',
      'portable',
      'universal',
      'tar.gz',
      'distributable',
      'not-applicable',
      'not-applicable',
      'not-applicable',
      'not-applicable',
      ['station-portable.tar.gz'],
    ],
    [
      'macos-aarch64',
      'macos',
      'aarch64',
      'dmg',
      'distributable',
      'signed',
      'platform-signature',
      'signed',
      'tauri-updater-signature',
      [
        `station-${tag}-macos-aarch64.dmg`,
        `station-${tag}-macos-aarch64.app.tar.gz`,
        `station-${tag}-macos-aarch64.app.tar.gz.sig`,
      ],
    ],
    [
      'macos-x86_64',
      'macos',
      'x86_64',
      'dmg',
      'distributable',
      'signed',
      'platform-signature',
      'signed',
      'tauri-updater-signature',
      [
        `station-${tag}-macos-x86_64.dmg`,
        `station-${tag}-macos-x86_64.app.tar.gz`,
        `station-${tag}-macos-x86_64.app.tar.gz.sig`,
      ],
    ],
    [
      'windows-x86_64',
      'windows',
      'x86_64',
      'msi',
      'distributable',
      'signed',
      'platform-signature',
      'signed',
      'tauri-updater-signature',
      [
        `station-${tag}-windows-x86_64.msi`,
        `station-${tag}-windows-x86_64.msi.zip`,
        `station-${tag}-windows-x86_64.msi.zip.sig`,
      ],
    ],
    [
      'linux-x86_64',
      'linux',
      'x86_64',
      'appimage',
      'distributable',
      'not-applicable',
      'not-applicable',
      'signed',
      'tauri-updater-signature',
      [
        `station-${tag}-linux-x86_64.AppImage`,
        `station-${tag}-linux-x86_64.AppImage.tar.gz`,
        `station-${tag}-linux-x86_64.AppImage.tar.gz.sig`,
      ],
    ],
    [
      'android-universal-apk',
      'android',
      'universal',
      'apk',
      'distributable',
      'signed',
      'platform-signature',
      'not-applicable',
      'not-applicable',
      [`station-${tag}-android-universal.apk`],
    ],
    [
      'android-universal-aab',
      'android',
      'universal',
      'aab',
      'distributable',
      'signed',
      'platform-signature',
      'not-applicable',
      'not-applicable',
      [`station-${tag}-android-universal.aab`],
    ],
    [
      'ios-simulator',
      'ios',
      'aarch64',
      'tar.gz',
      'verification-only',
      'unsigned',
      'not-applicable',
      'not-applicable',
      'not-applicable',
      [`station-${tag}-ios-simulator.app.tar.gz`],
    ],
    [
      'ios-device',
      'ios',
      'aarch64',
      'ipa',
      'distributable',
      'signed',
      'platform-signature',
      'not-applicable',
      'not-applicable',
      [`station-${tag}-ios-device.ipa`],
    ],
  ].map(
    ([
      id,
      platform,
      architecture,
      packageType,
      distribution,
      platformSigningState,
      platformSigningProof,
      updaterSigningState,
      updaterSigningProof,
      files,
    ]) => ({
      id,
      platform,
      architecture,
      packageType,
      distribution,
      platformSigning: {
        state: platformSigningState,
        proof: platformSigningProof,
      },
      updaterSigning: {
        state: updaterSigningState,
        proof: updaterSigningProof,
      },
      files,
    }),
  );
  return tag.includes('-preview.')
    ? variants.filter((variant) => variant.platform !== 'ios')
    : variants;
}

function ancillaryAssets(tag) {
  return [
    { name: 'station-updater-public-key.txt', role: 'updater-public-key' },
    {
      name: 'station-portable.tar.gz.sha256',
      role: 'portable-checksum',
    },
    {
      name: `station-release-ring-${tag.includes('-preview.') ? 'preview' : 'stable'}.json`,
      role: 'release-ring',
    },
    {
      name: 'station-container-release.json',
      role: 'container-descriptor',
    },
    ...Object.entries(SBOM_ASSETS).map(([scope, name]) => ({
      name,
      role: `sbom-${scope}`,
    })),
  ];
}

export function sha256(file) {
  return createHash('sha256')
    .update(readFileSync(regularFile(file)))
    .digest('hex');
}

function readContainerDescriptor(file) {
  let descriptor;
  try {
    regularFile(file, 'container descriptor');
    descriptor = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    fail(
      `cannot parse container descriptor: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return descriptor;
}

function validateContainerDescriptor(descriptor, { tag, sourceSha }) {
  const keys = Object.keys(descriptor ?? {}).sort();
  const expectedKeys = [
    'createdAt',
    'digest',
    'image',
    'platforms',
    'sha',
    'tag',
    'tags',
  ];
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys))
    fail('container descriptor fields are invalid');
  if (
    typeof descriptor.image !== 'string' ||
    descriptor.image.trim() === '' ||
    !CONTAINER_DIGEST.test(descriptor.digest) ||
    descriptor.sha !== sourceSha ||
    descriptor.tag !== tag ||
    !Array.isArray(descriptor.platforms) ||
    descriptor.platforms.length === 0 ||
    new Set(descriptor.platforms).size !== descriptor.platforms.length ||
    [...descriptor.platforms].sort().join(',') !==
      ['linux/amd64', 'linux/arm64'].sort().join(',') ||
    descriptor.platforms.some(
      (platform) =>
        typeof platform !== 'string' ||
        !/^linux\/[a-z0-9][a-z0-9_-]*$/.test(platform),
    ) ||
    !Array.isArray(descriptor.tags) ||
    descriptor.tags.length === 0 ||
    new Set(descriptor.tags).size !== descriptor.tags.length ||
    !descriptor.tags.includes(tag) ||
    !descriptor.tags.includes(`sha-${sourceSha}`) ||
    descriptor.tags.some(
      (containerTag) =>
        typeof containerTag !== 'string' || containerTag.trim() === '',
    ) ||
    Number.isNaN(Date.parse(descriptor.createdAt)) ||
    new Date(descriptor.createdAt).toISOString() !== descriptor.createdAt
  )
    fail('container descriptor metadata is invalid');
  return descriptor;
}

function expectedAssets(tag) {
  const expected = new Map();
  for (const variant of releaseVariants(tag)) {
    variant.files.forEach((name, index) =>
      expected.set(name, {
        variantId: variant.id,
        role:
          index === 0
            ? 'primary'
            : index === 1
              ? 'updater'
              : 'updater-signature',
      }),
    );
  }
  for (const asset of ancillaryAssets(tag)) expected.set(asset.name, asset);
  return expected;
}

function collectAssets(tag, assetsDir) {
  const assets = [];
  for (const [name, metadata] of expectedAssets(tag)) {
    const file = join(assetsDir, name);
    regularFile(file, name);
    assets.push({ name, sha256: sha256(file), ...metadata });
  }
  return assets.sort((left, right) => left.name.localeCompare(right.name));
}

function releaseSubjectsByScope(tag, assets) {
  const releaseAssets = new Map(assets.map((asset) => [asset.name, asset]));
  const subjects = {};
  for (const scope of ['portable', 'desktop', 'mobile']) {
    subjects[scope] = releaseVariants(tag)
      .filter((variant) =>
        scope === 'portable'
          ? variant.id === 'portable-server'
          : scope === 'desktop'
            ? ['macos', 'windows', 'linux'].includes(variant.platform)
            : ['android', 'ios'].includes(variant.platform),
      )
      .flatMap((variant) =>
        variant.files.map((name) => {
          const asset = releaseAssets.get(name);
          if (!asset) fail(`missing primary release subject ${name}`);
          return { name, sha256: asset.sha256, variant: variant.id };
        }),
      )
      .sort((left, right) => left.name.localeCompare(right.name));
  }
  return subjects;
}

function sbomContext(inventory) {
  return {
    tag: inventory.tag,
    version: inventory.version,
    sourceSha: inventory.sourceSha,
    generatedAt: inventory.generatedAt,
    channel: inventory.channel,
    dependencyLifecycle: inventory.dependencyLifecycle,
    container: inventory.container,
    subjectsByScope: releaseSubjectsByScope(inventory.tag, inventory.assets),
  };
}

function readSbomDescriptors(inventory, assetsDir) {
  const context = sbomContext(inventory);
  const descriptors = Object.entries(SBOM_ASSETS).map(([scope, asset]) => {
    const assetRecord = inventory.assets.find((entry) => entry.name === asset);
    if (!assetRecord) fail(`missing ${scope} SBOM asset`);
    const descriptor = {
      scope,
      asset,
      format: scope === 'container' ? 'SPDX' : 'CycloneDX',
      sha256: assetRecord.sha256,
      tag: inventory.tag,
      version: inventory.version,
      sourceSha: inventory.sourceSha,
      generatedAt: inventory.generatedAt,
      dependencyLifecycle: {
        digest: inventory.dependencyLifecycle.digest,
        purls: inventory.dependencyLifecycle.purlsByScope[scope],
      },
      ...(scope === 'container'
        ? {
            container: {
              image: inventory.container.image,
              digest: inventory.container.digest,
              platforms: inventory.container.platforms,
            },
          }
        : { subjects: context.subjectsByScope[scope] }),
    };
    if (assetsDir) {
      try {
        validateSbomBytes(descriptor, readFileSync(join(assetsDir, asset)));
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
    }
    return descriptor;
  });
  try {
    return validateSbomDescriptorSet(descriptors, context);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

export function createReleaseInventory({
  tag,
  sourceSha,
  generatedAt,
  assetsDir,
  updaterPublicKey,
  containerDescriptor,
  dependencyLifecycle,
}) {
  if (!TAG.test(tag)) fail(`invalid tag ${tag}`);
  if (!SHA.test(sourceSha)) fail(`invalid source SHA ${sourceSha}`);
  const descriptorPath =
    containerDescriptor ?? join(assetsDir, 'station-container-release.json');
  if (basename(descriptorPath) !== 'station-container-release.json')
    fail('container descriptor must be named station-container-release.json');
  const container = validateContainerDescriptor(
    readContainerDescriptor(descriptorPath),
    { tag, sourceSha },
  );
  const inventory = {
    schemaVersion: 2,
    tag,
    version: tag.slice(1),
    sourceSha,
    channel: tag.includes('-preview.') ? 'preview' : 'stable',
    generatedAt,
    dependencyLifecycle,
    container,
    variants: releaseVariants(tag).map(({ files, ...variant }) => variant),
    assets: collectAssets(tag, assetsDir),
  };
  inventory.sboms = readSbomDescriptors(inventory, assetsDir);
  validateReleaseInventory(inventory, { assetsDir, updaterPublicKey });
  return inventory;
}

export function writeChecksums(
  inventory,
  assetsDir,
  output = 'station-release-checksums.txt',
) {
  const lines = inventory.assets
    .map((asset) => `${asset.sha256}  ${asset.name}`)
    .sort();
  writeFileSync(join(assetsDir, output), `${lines.join('\n')}\n`);
}

function validateSchema(inventory) {
  if (schemaValidator(inventory)) return;
  const details = schemaValidator.errors
    ?.map((error) => `${error.instancePath || '/'} ${error.message}`)
    .join('; ');
  fail(`schema validation failed: ${details || 'unknown schema error'}`);
}

function validateVariants(inventory) {
  const expected = releaseVariants(inventory.tag);
  const expectedVariants = new Map(
    expected.map((variant) => [variant.id, variant]),
  );
  if (inventory.variants.length !== expected.length)
    fail('required variants are missing or duplicated');
  const seen = new Set();
  for (const variant of inventory.variants) {
    const expectedVariant = expectedVariants.get(variant.id);
    if (!expectedVariant || seen.has(variant.id))
      fail(`unexpected or duplicate variant ${variant.id}`);
    seen.add(variant.id);
    for (const key of [
      'platform',
      'architecture',
      'packageType',
      'distribution',
    ]) {
      if (variant[key] !== expectedVariant[key])
        fail(`${variant.id} has an invalid ${key}`);
    }
    for (const claim of ['platformSigning', 'updaterSigning']) {
      if (
        variant[claim].state !== expectedVariant[claim].state ||
        variant[claim].proof !== expectedVariant[claim].proof
      )
        fail(`${variant.id} makes an invalid ${claim} claim`);
    }
    if (
      variant.distribution === 'distributable' &&
      (variant.platformSigning.state === 'unsigned' ||
        variant.updaterSigning.state === 'unsigned')
    )
      fail(`${variant.id} is unsigned but distributable`);
  }
}

function validateAssets(inventory, assetsDir) {
  const expected = expectedAssets(inventory.tag);
  if (inventory.assets.length !== expected.size)
    fail('required assets are missing or duplicated');
  const seen = new Set();
  for (const asset of inventory.assets) {
    const expectedAsset = expected.get(asset.name);
    if (!expectedAsset || seen.has(asset.name))
      fail(`unexpected or duplicate asset ${asset.name}`);
    seen.add(asset.name);
    if (!CHECKSUM.test(asset.sha256))
      fail(`${asset.name} has an invalid checksum`);
    if (
      asset.variantId !== expectedAsset.variantId ||
      asset.role !== expectedAsset.role
    )
      fail(`${asset.name} has invalid metadata`);
    if (assetsDir) {
      if (basename(asset.name) !== asset.name)
        fail(`asset has an unsafe name: ${asset.name}`);
      const file = join(assetsDir, asset.name);
      regularFile(file, `asset file ${asset.name}`);
      if (sha256(file) !== asset.sha256)
        fail(`checksum mismatch: ${asset.name}`);
    }
  }
}

function validateUpdaterPairs(inventory, assetsDir, updaterPublicKey) {
  const publicAsset = inventory.assets.find(
    (asset) => asset.role === 'updater-public-key',
  );
  if (!publicAsset) fail('release-bound updater public key is missing');
  if (assetsDir) {
    const releaseKey = join(assetsDir, publicAsset.name);
    // Parse both values and require byte identity: release validation cannot
    // silently switch to a protected environment value after staging.
    parseTauriPublicKey(releaseKey);
    if (
      updaterPublicKey !== undefined &&
      readPublicKeyInput(releaseKey).trim() !==
        readPublicKeyInput(updaterPublicKey).trim()
    )
      fail(
        'release-bound updater public key does not match validation authority',
      );
    updaterPublicKey = releaseKey;
  }
  if (!updaterPublicKey) fail('an updater public key is required');
  const variants = releaseVariants(inventory.tag);
  for (const variant of variants) {
    if (variant.updaterSigning.proof !== 'tauri-updater-signature') continue;
    const updater = inventory.assets.find(
      (asset) => asset.variantId === variant.id && asset.role === 'updater',
    );
    const signature = inventory.assets.find(
      (asset) =>
        asset.variantId === variant.id && asset.role === 'updater-signature',
    );
    if (!updater || !signature || signature.name !== `${updater.name}.sig`)
      fail(`${variant.id} is missing an updater/signature pair`);
    if (!assetsDir) continue;
    verifyTauriUpdaterSignature({
      updater: join(assetsDir, updater.name),
      signature: join(assetsDir, signature.name),
      updaterPublicKey,
    });
  }
}

function validateSidecars(inventory, assetsDir) {
  if (!assetsDir) return;
  const portable = inventory.assets.find(
    (asset) =>
      asset.variantId === 'portable-server' && asset.role === 'primary',
  );
  const checksum = readFileSync(
    join(assetsDir, 'station-portable.tar.gz.sha256'),
    'utf8',
  );
  if (checksum !== `${portable.sha256}  station-portable.tar.gz\n`)
    fail('portable checksum sidecar does not match the portable archive');
  let ring;
  try {
    ring = JSON.parse(
      readFileSync(
        join(assetsDir, `station-release-ring-${inventory.channel}.json`),
        'utf8',
      ),
    );
  } catch (error) {
    fail(
      `cannot parse release-ring sidecar: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const expectedKeys = [
    'archive',
    'channel',
    'checksum',
    'createdAt',
    'prerelease',
    'ref',
    'schemaVersion',
    'sha',
  ];
  const checksumAsset = inventory.assets.find(
    (asset) => asset.role === 'portable-checksum',
  );
  if (
    JSON.stringify(Object.keys(ring ?? {}).sort()) !==
      JSON.stringify(expectedKeys) ||
    ring.schemaVersion !== 1 ||
    ring.channel !== inventory.channel ||
    ring.prerelease !== (inventory.channel === 'preview') ||
    ring.ref !== inventory.tag ||
    ring.sha !== inventory.sourceSha ||
    ring.createdAt !== inventory.generatedAt ||
    ring.archive?.name !== 'station-portable.tar.gz' ||
    ring.archive?.sha256 !== portable.sha256 ||
    ring.checksum?.name !== 'station-portable.tar.gz.sha256' ||
    ring.checksum?.sha256 !== checksumAsset.sha256
  )
    fail('release-ring sidecar does not match inventory metadata');
}

function validateContainer(inventory, assetsDir, containerDescriptor) {
  validateContainerDescriptor(inventory.container, {
    tag: inventory.tag,
    sourceSha: inventory.sourceSha,
  });
  if (!assetsDir) return;
  const descriptorPath =
    containerDescriptor ?? join(assetsDir, 'station-container-release.json');
  if (basename(descriptorPath) !== 'station-container-release.json')
    fail('container descriptor must be named station-container-release.json');
  const descriptor = validateContainerDescriptor(
    readContainerDescriptor(descriptorPath),
    { tag: inventory.tag, sourceSha: inventory.sourceSha },
  );
  if (JSON.stringify(descriptor) !== JSON.stringify(inventory.container))
    fail('container descriptor does not match inventory metadata');
}

export function validateReleaseInventory(
  inventory,
  { assetsDir, updaterPublicKey, containerDescriptor } = {},
) {
  validateSchema(inventory);
  if (inventory.version !== inventory.tag.slice(1))
    fail('version does not match tag');
  if (
    inventory.channel !==
    (inventory.tag.includes('-preview.') ? 'preview' : 'stable')
  )
    fail('channel does not match tag');
  validateVariants(inventory);
  validateAssets(inventory, assetsDir);
  let descriptors;
  try {
    descriptors = validateSbomDescriptorSet(
      inventory.sboms,
      sbomContext(inventory),
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (assetsDir) {
    for (const descriptor of descriptors) {
      try {
        validateSbomBytes(
          descriptor,
          readFileSync(join(assetsDir, descriptor.asset)),
        );
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
    }
  }
  validateSidecars(inventory, assetsDir);
  validateContainer(inventory, assetsDir, containerDescriptor);
  validateUpdaterPairs(inventory, assetsDir, updaterPublicKey);
  return inventory;
}

export function readInventory(file) {
  try {
    regularFile(file, basename(file));
    const bytes = readFileSync(file);
    if (bytes.byteLength > MAX_INVENTORY_BYTES)
      fail('inventory exceeds the bounded size');
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const inventory = JSON.parse(source);
    if (canonicalJson(inventory) !== source)
      fail('inventory JSON is not canonical');
    return inventory;
  } catch (error) {
    fail(
      `cannot parse ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function assertOnlyExpectedAssets(assetsDir, tag) {
  const allowed = new Set(expectedAssets(tag).keys());
  allowed.add('station-release-inventory.json');
  allowed.add('station-release-checksums.txt');
  for (const entry of readdirSync(assetsDir, { withFileTypes: true })) {
    if (!allowed.has(entry.name)) fail(`unexpected asset ${entry.name}`);
    if (entry.isSymbolicLink() || !entry.isFile())
      fail(`asset ${entry.name} is not a regular file`);
  }
}
