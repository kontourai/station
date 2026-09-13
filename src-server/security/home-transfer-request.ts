import {
  PAIRING_SCOPE_HOME_TRANSFER,
  pairingScopeIncludes,
} from '@kontourai/station-contracts/environment-security';
import type { EnvironmentSecurityService } from '../services/ssh/environment-security-service.js';
import { getRuntimeAuthenticatedRequestPrincipal } from './runtime-request-security.js';

/** Derives the current transfer participant from the middleware-owned Request. */
export function currentHomeTransferDevice(
  request: Request,
  security: Pick<EnvironmentSecurityService, 'identifyDevice'>,
): { readonly id: string } | undefined {
  const principal = getRuntimeAuthenticatedRequestPrincipal(request);
  if (principal?.authority !== 'device-credential' || !principal.deviceId)
    return undefined;
  const device = security.identifyDevice(principal.credential);
  if (
    !device ||
    device.id !== principal.deviceId ||
    !pairingScopeIncludes(device.scope, PAIRING_SCOPE_HOME_TRANSFER)
  )
    return undefined;
  return { id: device.id };
}
