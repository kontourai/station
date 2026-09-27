import {
  AGENT_PLUGINS_1_0_MANIFEST_SCHEMA_URL,
  type RegistryPackageClaim,
} from '@kontourai/station-contracts/registry-trust';
import * as rootExports from '@kontourai/station-shared';
import { registryPackageSignaturePayload } from '@kontourai/station-shared/plugin-registry-signature';
import { expect, test } from 'vitest';

// The computePluginTreeDigest leaf contract (canonical bytes, framing, symlink
// bytes, filename refusal, root-barrel absence) is owned by
// plugin-tree-digest.test.ts.
test('the public signature payload is domain separated, independent of object property order, and absent from the root barrel', () => {
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
  expect('registryPackageSignaturePayload' in rootExports).toBe(false);
});
