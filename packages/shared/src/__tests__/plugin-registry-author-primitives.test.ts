import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENT_PLUGINS_1_0_MANIFEST_SCHEMA_URL,
  type RegistryPackageClaim,
} from '@kontourai/station-contracts/registry-trust';
import * as rootExports from '@kontourai/station-shared';
import { registryPackageSignaturePayload } from '@kontourai/station-shared/plugin-registry-signature';
import { computePluginTreeDigest } from '@kontourai/station-shared/plugin-tree-digest';
import { expect, test } from 'vitest';

test('public Node leaves preserve canonical source bytes and remain absent from the root barrel', () => {
  const directory = mkdtempSync(join(tmpdir(), 'station-author-digest-'));
  try {
    mkdirSync(join(directory, '.git'));
    mkdirSync(join(directory, 'nested'));
    writeFileSync(join(directory, 'nested', 'b.txt'), 'beta');
    writeFileSync(join(directory, 'a.txt'), 'alpha');
    writeFileSync(
      join(directory, '.git', 'metadata'),
      'not executable package content',
    );
    expect(computePluginTreeDigest(directory)).toBe(
      'sha256:7fae7c89e42747ba005828499d149ae440914ba89af16b18ce4ea16b90584075',
    );
    writeFileSync(join(directory, '.git', 'metadata'), 'different VCS state');
    expect(computePluginTreeDigest(directory)).toBe(
      'sha256:7fae7c89e42747ba005828499d149ae440914ba89af16b18ce4ea16b90584075',
    );
    writeFileSync(join(directory, 'a.txt'), 'changed');
    expect(computePluginTreeDigest(directory)).not.toBe(
      'sha256:7fae7c89e42747ba005828499d149ae440914ba89af16b18ce4ea16b90584075',
    );
    expect(computePluginTreeDigest(join(directory, 'missing'))).toBeNull();
    expect('computePluginTreeDigest' in rootExports).toBe(false);
    expect('registryPackageSignaturePayload' in rootExports).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the public signature payload is domain separated and independent of object property order', () => {
  const claim: RegistryPackageClaim = {
    source: 'https://example.test/review.git#v1',
    packageDigest: `sha256:${'a'.repeat(64)}`,
    packageVersion: '1.0.0',
    pluginName: 'review',
    registryKey: 'https://example.test/catalog.json',
    registryId: 'review',
    packageSchema: AGENT_PLUGINS_1_0_MANIFEST_SCHEMA_URL,
  };
  expect(registryPackageSignaturePayload(claim).toString('utf8')).toBe(
    JSON.stringify([
      'station.registry-package-signature/v1',
      'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      'review',
      'https://example.test/catalog.json',
      'review',
      '1.0.0',
      'https://example.test/review.git#v1',
      `sha256:${'a'.repeat(64)}`,
    ]),
  );
});
