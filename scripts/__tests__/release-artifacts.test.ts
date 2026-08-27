import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
  sign,
} from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertOnlyExpectedAssets,
  createReleaseInventory,
  releaseVariants,
  validateReleaseInventory,
  verifyTauriUpdaterSignature,
} from '../lib/release-artifacts.mjs';
import { generateReleaseSboms } from '../lib/release-sbom-generation.mjs';

const roots: string[] = [];
const TAG = 'v1.2.3';
const SHA = 'a'.repeat(40);
const GENERATED_AT = '2026-07-25T12:00:00.000Z';
const RUNTIME_LIFECYCLE_PURL = 'pkg:npm/runtime-native@1.0.0';
const DEPENDENCY_LIFECYCLE = {
  digest: 'd'.repeat(64),
  purlsByScope: {
    portable: [RUNTIME_LIFECYCLE_PURL],
    desktop: [RUNTIME_LIFECYCLE_PURL],
    mobile: [RUNTIME_LIFECYCLE_PURL],
    container: [RUNTIME_LIFECYCLE_PURL],
  },
};
// Produced by @tauri-apps/cli 2.11.4:
// `tauri signer generate --ci` then `tauri signer sign payload`.
const TAURI_PUBLIC_KEY =
  'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDI0RDZDMTZGRTRGQzdBOTIKUldTU2V2emtiOEhXSkh5cnlwdDRHNnZrL3gwYlM4SHhuYmh0dmNlME1nZmZ2UmFCdnJWaHpZVGYK';
const TAURI_SIGNATURE =
  'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTU2V2emtiOEhXSlB4MVAybHkxcHJvSVZ1dkxVTlpQYzdnZUtSYzVESit6WjNXdEpxNkU0YmpxcnZ1cE9KVFIzRDNOclpvRlRtMjErY3pwWmIrbVhGWEtBSTE0L0w0TkFVPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzg0OTg4MTI0CWZpbGU6cGF5bG9hZApsbjdBTFM3SlRuZnp5bC9BbjdCdkxuNDhHTGNHUCtHTkZ2c2hhc1FLYzIwV0VUa0E1bVM5c2xiMGpRS0lBQUpKYnB6Z0ROQzBuTlhXOGthTmk1VkhDQT09Cg==';

function minisignPublicKey(publicKey: KeyObject, keyId: Buffer) {
  const der = publicKey.export({ format: 'der', type: 'spki' });
  const packet = Buffer.concat([
    Buffer.from('Ed'),
    keyId,
    der.subarray(der.length - 32),
  ]);
  const text = `untrusted comment: minisign public key: TEST\n${packet.toString('base64')}\n`;
  return Buffer.from(text).toString('base64');
}

function minisignSignature(
  payload: Buffer,
  privateKey: KeyObject,
  keyId: Buffer,
) {
  const signature = sign(
    null,
    createHash('blake2b512').update(payload).digest(),
    privateKey,
  );
  const trustedComment = 'timestamp:1784988124\tfile:test\tprehashed';
  const globalSignature = sign(
    null,
    Buffer.concat([signature, Buffer.from(trustedComment)]),
    privateKey,
  );
  const text = [
    'untrusted comment: signature from tauri secret key',
    Buffer.concat([Buffer.from('ED'), keyId, signature]).toString('base64'),
    `trusted comment: ${trustedComment}`,
    globalSignature.toString('base64'),
    '',
  ].join('\n');
  return Buffer.from(text).toString('base64');
}

function tamperGlobalSignature(encodedSignature: string) {
  const lines = Buffer.from(encodedSignature, 'base64')
    .toString('utf8')
    .trimEnd()
    .split('\n');
  const globalSignature = Buffer.from(lines[3], 'base64');
  globalSignature[0] ^= 1;
  lines[3] = globalSignature.toString('base64');
  return Buffer.from(`${lines.join('\n')}\n`).toString('base64');
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'station-release-artifacts-'));
  roots.push(root);
  const assetsDir = join(root, 'assets');
  const fragmentsDir = join(root, 'fragments');
  mkdirSync(assetsDir);
  mkdirSync(fragmentsDir);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keyId = Buffer.from('12345678');
  const updaterPublicKey = minisignPublicKey(publicKey, keyId);
  writeFileSync(
    join(assetsDir, 'station-updater-public-key.txt'),
    `${updaterPublicKey}\n`,
  );
  const variants = releaseVariants(TAG) as Array<{
    id: string;
    platform: string;
    files: string[];
  }>;
  for (const variant of variants) {
    for (const name of variant.files) {
      if (name.endsWith('.sig')) continue;
      const payload = Buffer.from(`${name}\n`);
      writeFileSync(join(assetsDir, name), payload);
      if (variant.files.includes(`${name}.sig`)) {
        writeFileSync(
          join(assetsDir, `${name}.sig`),
          minisignSignature(payload, privateKey, keyId),
        );
      }
    }
  }
  const portableSha = createHash('sha256')
    .update(readFileSync(join(assetsDir, 'station-portable.tar.gz')))
    .digest('hex');
  const portableChecksum = `${portableSha}  station-portable.tar.gz\n`;
  writeFileSync(
    join(assetsDir, 'station-portable.tar.gz.sha256'),
    portableChecksum,
  );
  writeFileSync(
    join(assetsDir, 'station-release-ring-stable.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      channel: 'stable',
      prerelease: false,
      ref: TAG,
      sha: SHA,
      createdAt: GENERATED_AT,
      archive: {
        name: 'station-portable.tar.gz',
        sha256: portableSha,
      },
      checksum: {
        name: 'station-portable.tar.gz.sha256',
        sha256: createHash('sha256').update(portableChecksum).digest('hex'),
      },
    })}\n`,
  );
  const container = {
    image: 'ghcr.io/kontourai/station',
    digest: `sha256:${'b'.repeat(64)}`,
    sha: SHA,
    tag: TAG,
    createdAt: GENERATED_AT,
    platforms: ['linux/amd64', 'linux/arm64'],
    tags: [TAG, '1.2.3', `sha-${SHA}`, 'latest'],
  };
  const containerDescriptor = join(assetsDir, 'station-container-release.json');
  writeFileSync(containerDescriptor, `${JSON.stringify(container)}\n`);
  const subjectsByScope = Object.fromEntries(
    ['portable', 'desktop', 'mobile'].map((scope) => [
      scope,
      variants
        .filter((variant) =>
          scope === 'portable'
            ? variant.id === 'portable-server'
            : scope === 'desktop'
              ? ['macos', 'windows', 'linux'].includes(variant.platform)
              : ['android', 'ios'].includes(variant.platform),
        )
        .flatMap((variant) =>
          variant.files.map((name) => ({
            name,
            variant: variant.id,
            sha256: createHash('sha256')
              .update(readFileSync(join(assetsDir, name)))
              .digest('hex'),
          })),
        ),
    ]),
  );
  const fragments = {
    npm: join(fragmentsDir, 'npm.fragment.json'),
    rust: join(fragmentsDir, 'rust.fragment.json'),
    container: join(fragmentsDir, 'container.fragment.json'),
  };
  writeFileSync(
    fragments.npm,
    '{"components":[{"name":"runtime-native","purl":"pkg:npm/runtime-native@1.0.0","version":"1.0.0"}],"predicate":"runtime","source":"npm"}',
  );
  writeFileSync(
    fragments.rust,
    '{"components":[],"predicate":"native","source":"rust"}',
  );
  writeFileSync(
    fragments.container,
    '{"components":[{"name":"bash","purl":"pkg:deb/debian/bash@5.2","version":"5.2"},{"name":"runtime-native","purl":"pkg:npm/runtime-native@1.0.0","version":"1.0.0"}],"predicate":"image","source":"container"}',
  );
  generateReleaseSboms({
    assetsDir,
    fragmentsDir,
    context: {
      tag: TAG,
      version: '1.2.3',
      sourceSha: SHA,
      generatedAt: GENERATED_AT,
      channel: 'stable',
      dependencyLifecycle: DEPENDENCY_LIFECYCLE,
      container,
      subjectsByScope,
    },
    fragments,
  });
  return { assetsDir, containerDescriptor, updaterPublicKey };
}

function createFixtureInventory() {
  const files = fixture();
  return {
    ...files,
    inventory: createReleaseInventory({
      tag: TAG,
      sourceSha: SHA,
      generatedAt: GENERATED_AT,
      dependencyLifecycle: DEPENDENCY_LIFECYCLE,
      ...files,
    }),
  };
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe('release artifact inventory', () => {
  it('assembles every required variant, sidecar, and immutable container', () => {
    const { assetsDir, inventory, updaterPublicKey } = createFixtureInventory();

    expect(inventory).toMatchObject({
      schemaVersion: 2,
      tag: TAG,
      version: '1.2.3',
      sourceSha: SHA,
      channel: 'stable',
      container: {
        image: 'ghcr.io/kontourai/station',
        digest: `sha256:${'b'.repeat(64)}`,
        platforms: ['linux/amd64', 'linux/arm64'],
      },
    });
    expect(inventory.variants.map((variant) => variant.id)).toEqual(
      releaseVariants(TAG).map((variant) => variant.id),
    );
    expect(inventory.assets).toHaveLength(25);
    expect(inventory.assets).toContainEqual(
      expect.objectContaining({
        name: 'station-updater-public-key.txt',
        role: 'updater-public-key',
      }),
    );
    expect((inventory as any).sboms.map((sbom: any) => sbom.scope)).toEqual([
      'portable',
      'desktop',
      'mobile',
      'container',
    ]);
    expect(inventory.dependencyLifecycle).toEqual(DEPENDENCY_LIFECYCLE);
    expect((inventory as any).sboms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: 'portable',
          dependencyLifecycle: {
            digest: DEPENDENCY_LIFECYCLE.digest,
            purls: [RUNTIME_LIFECYCLE_PURL],
          },
        }),
      ]),
    );
    expect(inventory.assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'portable-checksum' }),
        expect.objectContaining({ role: 'release-ring' }),
        expect.objectContaining({ role: 'container-descriptor' }),
      ]),
    );
    expect(() =>
      validateReleaseInventory(inventory, {
        assetsDir,
        updaterPublicKey,
      }),
    ).not.toThrow();
  });

  it.each([
    [
      'unknown top-level property',
      (inventory: any) => (inventory.extra = true),
    ],
    [
      'unknown nested property',
      (inventory: any) => (inventory.assets[0].extra = true),
    ],
    ['missing required variant', (inventory: any) => inventory.variants.pop()],
    [
      'duplicate variant',
      (inventory: any) => inventory.variants.push(inventory.variants[0]),
    ],
    [
      'mismatched source SHA',
      (inventory: any) => (inventory.sourceSha = 'short'),
    ],
    [
      'invalid checksum',
      (inventory: any) => (inventory.assets[0].sha256 = 'nope'),
    ],
    [
      'missing required lifecycle binding',
      (inventory: any) => delete inventory.dependencyLifecycle,
    ],
    [
      'false distributable signing claim',
      (inventory: any) => {
        inventory.variants.find(
          (variant: any) => variant.id === 'ios-device',
        ).platformSigning.state = 'unsigned';
      },
    ],
    [
      'missing updater signature',
      (inventory: any) => {
        inventory.assets = inventory.assets.filter(
          (asset: any) => asset.role !== 'updater-signature',
        );
      },
    ],
    [
      'container digest drift',
      (inventory: any) =>
        (inventory.container.digest = `sha256:${'c'.repeat(64)}`),
    ],
  ])('fails closed for %s', (_label, mutate) => {
    const { assetsDir, inventory, updaterPublicKey } = createFixtureInventory();
    mutate(inventory);
    expect(() =>
      validateReleaseInventory(inventory, { assetsDir, updaterPublicKey }),
    ).toThrow('Invalid release artifact inventory');
  });

  it('fails when uploaded bytes differ from the assembled checksum', () => {
    const { assetsDir, inventory, updaterPublicKey } = createFixtureInventory();
    writeFileSync(join(assetsDir, inventory.assets[0].name), 'tampered\n');
    expect(() =>
      validateReleaseInventory(inventory, { assetsDir, updaterPublicKey }),
    ).toThrow('checksum mismatch');
  });

  it('rejects unexpected upload extras', () => {
    const { assetsDir } = createFixtureInventory();
    writeFileSync(join(assetsDir, 'station-untracked.txt'), 'unexpected\n');
    expect(() => assertOnlyExpectedAssets(assetsDir, TAG)).toThrow(
      'unexpected asset station-untracked.txt',
    );
  });

  it('rejects symlinked release assets and cross-scope SBOM subjects', () => {
    const { assetsDir, inventory, updaterPublicKey } = createFixtureInventory();
    const target = join(assetsDir, 'payload-target');
    writeFileSync(
      target,
      readFileSync(join(assetsDir, 'station-portable.tar.gz')),
    );
    rmSync(join(assetsDir, 'station-portable.tar.gz'));
    symlinkSync(target, join(assetsDir, 'station-portable.tar.gz'));
    expect(() =>
      validateReleaseInventory(inventory, { assetsDir, updaterPublicKey }),
    ).toThrow('not a regular file');

    rmSync(join(assetsDir, 'station-portable.tar.gz'));
    writeFileSync(
      join(assetsDir, 'station-portable.tar.gz'),
      readFileSync(target),
    );
    (inventory as any).sboms[0].subjects = (inventory as any).sboms[1].subjects;
    expect(() =>
      validateReleaseInventory(inventory, { assetsDir, updaterPublicKey }),
    ).toThrow('SBOM artifact subjects do not match the release inventory');
  });
});

describe('Tauri updater signatures', () => {
  it('verifies a signature emitted by the current Tauri CLI', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-tauri-signature-'));
    roots.push(root);
    const updater = join(root, 'payload');
    const signature = join(root, 'payload.sig');
    writeFileSync(updater, 'payload\n');
    writeFileSync(signature, TAURI_SIGNATURE);

    expect(() =>
      verifyTauriUpdaterSignature({
        updater,
        signature,
        updaterPublicKey: TAURI_PUBLIC_KEY,
      }),
    ).not.toThrow();
  });

  it.each([
    ['empty signature', ''],
    ['arbitrary bytes', 'not-a-signature'],
    ['tampered global signature', tamperGlobalSignature(TAURI_SIGNATURE)],
  ])('rejects %s', (_label, signatureBytes) => {
    const root = mkdtempSync(join(tmpdir(), 'station-tauri-signature-'));
    roots.push(root);
    const updater = join(root, 'payload');
    const signature = join(root, 'payload.sig');
    writeFileSync(updater, 'payload\n');
    writeFileSync(signature, signatureBytes);
    expect(() =>
      verifyTauriUpdaterSignature({
        updater,
        signature,
        updaterPublicKey: TAURI_PUBLIC_KEY,
      }),
    ).toThrow('Invalid release artifact inventory');
  });

  it('rejects updater tampering and a wrong updater key', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-tauri-signature-'));
    roots.push(root);
    const updater = join(root, 'payload');
    const signature = join(root, 'payload.sig');
    writeFileSync(updater, 'tampered\n');
    writeFileSync(signature, TAURI_SIGNATURE);
    expect(() =>
      verifyTauriUpdaterSignature({
        updater,
        signature,
        updaterPublicKey: TAURI_PUBLIC_KEY,
      }),
    ).toThrow('does not verify');

    const { publicKey } = generateKeyPairSync('ed25519');
    expect(() =>
      verifyTauriUpdaterSignature({
        updater,
        signature,
        updaterPublicKey: minisignPublicKey(publicKey, Buffer.from('87654321')),
      }),
    ).toThrow('unexpected updater key');
  });
});

describe('release artifact schema', () => {
  it('accepts the runtime-generated inventory', () => {
    const { inventory } = createFixtureInventory();
    const schemaPath = resolve('schemas/release-artifact-manifest.schema.json');
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    const validate = new Ajv2020({
      formats: { 'date-time': true },
    }).compile(schema);

    expect(validate(inventory), JSON.stringify(validate.errors)).toBe(true);
  });
});
