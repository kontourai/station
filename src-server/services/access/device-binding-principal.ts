import type { DevicePrincipalBinding } from '@kontourai/station-contracts/environment-security';
import {
  humanPrincipal,
  type PrincipalRef,
} from '@kontourai/station-contracts/principal';
import { deploymentAccountPrincipal } from '../identity/deployment-authentication-service.js';

/**
 * The person a paired device is tied to: an account binding resolves to its
 * deployment account principal, a verified Tailscale binding to that person.
 * The one derivation request principal resolution and Station groups share,
 * so the person a request acts as and the person whose group caps it agree.
 */
export function principalForDeviceBinding(
  binding: DevicePrincipalBinding,
): PrincipalRef {
  return 'kind' in binding
    ? deploymentAccountPrincipal(
        binding.issuer,
        binding.subject,
        binding.displayName,
      )
    : humanPrincipal(binding.provider, binding.subject, binding.subject);
}
