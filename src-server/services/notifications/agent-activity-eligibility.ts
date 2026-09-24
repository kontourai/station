import {
  PAIRING_SCOPE_ORCHESTRATION_READ,
  type PairedDevice,
  pairingScopeIncludes,
} from '@kontourai/station-contracts/environment-security';

/**
 * Whether this device, by its own credential, may list sessions the way the
 * card would show them. Shared with the registration route, so a device the
 * publisher would never read cannot register either.
 */
export function canReadAgentActivity(device: PairedDevice): boolean {
  const binding = device.principalBinding;
  return (
    device.revokedAt === null &&
    device.kind === 'device' &&
    pairingScopeIncludes(device.scope, PAIRING_SCOPE_ORCHESTRATION_READ) &&
    !(binding && 'kind' in binding && binding.kind === 'account')
  );
}
