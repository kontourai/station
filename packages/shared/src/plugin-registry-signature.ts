import { Buffer } from 'node:buffer';
import type { RegistryPackageClaim } from '@kontourai/station-contracts/registry-trust';

/** Domain-separated canonical bytes signed by the registry's trusted key. */
export function registryPackageSignaturePayload(
  claim: Omit<RegistryPackageClaim, 'signature'>,
): Buffer {
  return Buffer.from(
    JSON.stringify([
      'station.registry-package-signature/v1',
      claim.packageSchema,
      claim.registryId,
      claim.registryKey,
      claim.pluginName,
      claim.packageVersion,
      claim.source,
      claim.packageDigest,
    ]),
  );
}
