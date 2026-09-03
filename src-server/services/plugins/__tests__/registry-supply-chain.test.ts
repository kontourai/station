import { generateKeyPairSync, sign } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { computePluginContentDigest } from '../plugin-content-integrity.js';
import {
  finalizeRegistrySupplyChainPin,
  RegistryLastKnownGoodStore,
  type RegistryPackageClaim,
  registryPackageSignaturePayload,
  STATION_PLUGIN_PACKAGE_SCHEMA,
  verifyRegistryPackage,
} from '../registry-supply-chain.js';

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'station-registry-supply-chain-'));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const path of roots.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function packageTree(home: string, content = 'export const value = 1;') {
  const pluginsDir = join(home, 'packages');
  const tree = join(pluginsDir, 'signed-plugin');
  mkdirSync(join(tree, 'src'), { recursive: true });
  writeFileSync(
    join(tree, 'plugin.json'),
    JSON.stringify({ name: 'signed-plugin', version: '1.0.0' }),
  );
  writeFileSync(join(tree, 'src', 'index.js'), content);
  return {
    tree,
    digest: computePluginContentDigest(pluginsDir, 'signed-plugin')!,
  };
}

function signedFixture(home: string) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pkg = packageTree(home);
  const unsigned: Omit<RegistryPackageClaim, 'signature'> = {
    packageSchema: STATION_PLUGIN_PACKAGE_SCHEMA,
    registryId: 'signed-plugin',
    registryKey: 'https://registry.example.test/manifest.json',
    pluginName: 'signed-plugin',
    packageVersion: '1.0.0',
    source: 'https://registry.example.test/signed-plugin-1.0.0.tgz',
    packageDigest: pkg.digest,
  };
  const claim: RegistryPackageClaim = {
    ...unsigned,
    signature: {
      algorithm: 'ed25519',
      keyId: 'registry-release',
      value: sign(
        null,
        registryPackageSignaturePayload(unsigned),
        privateKey,
      ).toString('base64'),
    },
  };
  const policy = {
    signatures: 'required' as const,
    pins: 'exact' as const,
    trustedEd25519Keys: {
      'registry-release': publicKey
        .export({ type: 'spki', format: 'pem' })
        .toString(),
    },
  };
  return { ...pkg, claim, policy };
}

describe('registry package supply-chain policy', () => {
  test('verifies an Ed25519 package claim against a local trust anchor', () => {
    const fixture = signedFixture(root());
    const result = verifyRegistryPackage({
      claim: fixture.claim,
      observedPackageDigest: fixture.digest,
      policy: fixture.policy,
    });
    expect(result).toMatchObject({
      kind: 'verified',
      package: {
        verification: { kind: 'ed25519', keyId: 'registry-release' },
        invalidateExistingGrants: false,
      },
    });
  });

  test('refuses a byte-flipped package with an explicit signature mismatch', () => {
    const fixture = signedFixture(root());
    writeFileSync(
      join(fixture.tree, 'src', 'index.js'),
      'export const value = 2;',
    );
    const observed = computePluginContentDigest(
      dirname(fixture.tree),
      'signed-plugin',
    )!;
    expect(
      verifyRegistryPackage({
        claim: fixture.claim,
        observedPackageDigest: observed,
        policy: fixture.policy,
      }),
    ).toEqual({
      kind: 'refused',
      reason: 'signature-mismatch',
      message:
        'Registry package signature mismatch: signed metadata or package bytes changed.',
    });
  });

  test('requires signatures when policy says required', () => {
    const fixture = signedFixture(root());
    const { signature: _signature, ...unsigned } = fixture.claim;
    expect(
      verifyRegistryPackage({
        claim: unsigned,
        observedPackageDigest: fixture.digest,
        policy: fixture.policy,
      }),
    ).toMatchObject({ kind: 'refused', reason: 'unsigned-package' });
  });

  test('refuses registry version/source drift until an explicit pin update', () => {
    const fixture = signedFixture(root());
    const verified = verifyRegistryPackage({
      claim: fixture.claim,
      observedPackageDigest: fixture.digest,
      policy: fixture.policy,
    });
    if (verified.kind !== 'verified') throw new Error('expected verification');
    const currentPin = finalizeRegistrySupplyChainPin({
      verifiedPackage: verified.package,
      installedDigest: fixture.digest,
    });
    const changedUnsigned = {
      ...fixture.claim,
      packageVersion: '1.1.0',
      source: 'https://registry.example.test/signed-plugin-1.1.0.tgz',
    };
    const changedClaim: RegistryPackageClaim = {
      ...changedUnsigned,
      signature: {
        ...fixture.claim.signature!,
        value: fixture.claim.signature!.value,
      },
    };
    expect(
      verifyRegistryPackage({
        claim: changedClaim,
        observedPackageDigest: fixture.digest,
        policy: fixture.policy,
        currentPin,
      }),
    ).toMatchObject({ kind: 'refused', reason: 'pin-mismatch' });
  });

  test('marks explicit source provenance changes for grant invalidation', () => {
    const fixture = signedFixture(root());
    const first = verifyRegistryPackage({
      claim: fixture.claim,
      observedPackageDigest: fixture.digest,
      policy: fixture.policy,
    });
    if (first.kind !== 'verified') throw new Error('expected verification');
    const currentPin = finalizeRegistrySupplyChainPin({
      verifiedPackage: first.package,
      installedDigest: fixture.digest,
    });
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const unsigned = {
      ...fixture.claim,
      source: 'https://mirror.example.test/signed-plugin-1.0.0.tgz',
    };
    const claim: RegistryPackageClaim = {
      ...unsigned,
      signature: {
        algorithm: 'ed25519',
        keyId: 'replacement-release',
        value: sign(
          null,
          registryPackageSignaturePayload(unsigned),
          privateKey,
        ).toString('base64'),
      },
    };
    const policy = {
      ...fixture.policy,
      trustedEd25519Keys: {
        ...fixture.policy.trustedEd25519Keys,
        'replacement-release': publicKey
          .export({ type: 'spki', format: 'pem' })
          .toString(),
      },
    };
    expect(
      verifyRegistryPackage({
        claim,
        observedPackageDigest: fixture.digest,
        policy,
        currentPin,
        allowPinUpdate: true,
      }),
    ).toMatchObject({
      kind: 'verified',
      package: { invalidateExistingGrants: true },
    });
  });
});

describe('registry last-known-good store', () => {
  test('archives and restages the prior tree byte-identically', () => {
    const home = root();
    const fixture = signedFixture(home);
    const store = new RegistryLastKnownGoodStore(home);
    const ref = store.archive({
      registryId: fixture.claim.registryId,
      registryKey: fixture.claim.registryKey,
      pluginName: fixture.claim.pluginName,
      packageVersion: fixture.claim.packageVersion,
      source: fixture.claim.source,
      installedTree: fixture.tree,
      expectedInstalledDigest: fixture.digest,
    });
    const rollback = join(home, 'rollback-stage');
    store.stageRollback(ref, rollback);
    expect(digestAt(rollback)).toBe(fixture.digest);
    expect(readFileSync(join(rollback, 'src', 'index.js'), 'utf8')).toBe(
      'export const value = 1;',
    );
  });

  test('refuses a tampered last-known-good tree before rollback staging', () => {
    const home = root();
    const fixture = signedFixture(home);
    const store = new RegistryLastKnownGoodStore(home);
    const ref = store.archive({
      registryId: fixture.claim.registryId,
      registryKey: fixture.claim.registryKey,
      pluginName: fixture.claim.pluginName,
      packageVersion: fixture.claim.packageVersion,
      source: fixture.claim.source,
      installedTree: fixture.tree,
      expectedInstalledDigest: fixture.digest,
    });
    writeFileSync(join(home, ref.relativePath, 'src', 'index.js'), 'tampered');
    expect(() =>
      store.stageRollback(ref, join(home, 'rollback-stage')),
    ).toThrow('Last-known-good tree no longer matches its pinned digest.');
  });
});

function digestAt(path: string): string | null {
  return computePluginContentDigest(dirname(path), basename(path));
}
