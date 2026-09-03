import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  RegistryInstallAliasFormatError,
  readRegistryInstallAliases,
  writeRegistryInstallAliases,
} from '../registry-install-aliases.js';

const roots: string[] = [];

function root() {
  const value = mkdtempSync(join(tmpdir(), 'station-registry-aliases-'));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const path of roots.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe('registry install alias supply-chain records', () => {
  test('round-trips an exact package/source pin and last-known-good ref', () => {
    const home = root();
    const digest = `sha256:${'a'.repeat(64)}`;
    writeRegistryInstallAliases(home, {
      review: {
        pluginName: 'review-plugin',
        registryKey: 'https://registry.example.test/manifest.json',
        supplyChain: {
          version: 1,
          packageSchema: { kind: 'station.plugin', version: '1.0' },
          registryId: 'review',
          registryKey: 'https://registry.example.test/manifest.json',
          pluginName: 'review-plugin',
          packageVersion: '1.2.3',
          source: 'https://registry.example.test/review-1.2.3.tgz',
          packageDigest: digest,
          installedDigest: digest,
          verification: {
            kind: 'ed25519',
            keyId: 'registry-release',
            signature: 'c2lnbmF0dXJl',
          },
          lastKnownGood: {
            version: 1,
            relativePath: `registry-last-known-good/${'b'.repeat(64)}/tree`,
            installedDigest: digest,
            packageVersion: '1.1.0',
            source: 'https://registry.example.test/review-1.1.0.tgz',
          },
        },
      },
    });
    expect(readRegistryInstallAliases(home).review.supplyChain).toMatchObject({
      packageVersion: '1.2.3',
      source: 'https://registry.example.test/review-1.2.3.tgz',
      lastKnownGood: { packageVersion: '1.1.0' },
    });
  });

  test('fails closed on an invalid supply-chain pin', () => {
    const home = root();
    const path = join(home, 'config', 'registry-installs.json');
    mkdirSync(join(home, 'config'), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        review: {
          pluginName: 'review-plugin',
          registryKey: 'registry',
          supplyChain: { version: 1, packageDigest: 'not-a-digest' },
        },
      }),
    );
    expect(() => readRegistryInstallAliases(home)).toThrow(
      RegistryInstallAliasFormatError,
    );
  });
});
