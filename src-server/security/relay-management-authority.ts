import {
  PAIRING_SCOPE_RELAY_MANAGE,
  pairingScopeIncludes,
} from '@kontourai/station-contracts/environment-security';
import type { DevicePairingService } from '../services/ssh/device-pairing-service.js';
import type { EnvironmentSecurityService } from '../services/ssh/environment-security-service.js';
import {
  getRuntimeAuthenticatedRequestPrincipal,
  getRuntimeNativeDeviceProofPrincipal,
  isBoundRuntimeLocalOperator,
  isRuntimeNativeDeviceProofCurrent,
  isRuntimeRequestPrincipalCurrent,
} from './runtime-request-security.js';

type Security = Pick<
  EnvironmentSecurityService,
  'verifyOperatorCredential' | 'authorizeCredential' | 'resolveGrantedScope'
>;

/** A fresh operator fact or an explicitly promoted, current Device; never a Project role. */
export function hasRelayManagementAuthority(
  request: Request,
  security: Security,
  pairing: Pick<DevicePairingService, 'deviceHoldsScope'>,
): boolean {
  const native = getRuntimeNativeDeviceProofPrincipal(request);
  if (native) {
    return (
      isRuntimeNativeDeviceProofCurrent(request) &&
      pairing.deviceHoldsScope(native.deviceId, PAIRING_SCOPE_RELAY_MANAGE)
    );
  }
  const principal = getRuntimeAuthenticatedRequestPrincipal(request);
  if (!principal || !isRuntimeRequestPrincipalCurrent(request, security))
    return false;
  if (
    isBoundRuntimeLocalOperator(request) ||
    (principal.authority === 'operator-credential' &&
      security.verifyOperatorCredential(principal.credential))
  )
    return true;
  return (
    principal.authority === 'device-credential' &&
    pairingScopeIncludes(
      security.resolveGrantedScope(principal.credential) ?? '',
      PAIRING_SCOPE_RELAY_MANAGE,
    )
  );
}

const APPROVAL_ORIGIN = Symbol('relay-management-approval');
/** A current management grant bound to one native enrollment, not a claim of raw credential possession. */
export class RelayManagementApproval {
  readonly kind = 'relay-management' as const;
  constructor(
    token: symbol,
    readonly enrollmentId: string,
    private readonly current: () => boolean,
  ) {
    if (token !== APPROVAL_ORIGIN || !/^[A-Za-z0-9_-]{43}$/u.test(enrollmentId))
      throw new Error('relay_management_required');
    Object.freeze(this);
  }
  isCurrent(): boolean {
    return this.current();
  }
}
export function captureRelayManagementApproval(
  request: Request,
  enrollmentId: string,
  security: Security,
  pairing: Pick<DevicePairingService, 'deviceHoldsScope'>,
): RelayManagementApproval {
  const current = () => hasRelayManagementAuthority(request, security, pairing);
  if (!current()) throw new Error('relay_management_required');
  return new RelayManagementApproval(APPROVAL_ORIGIN, enrollmentId, current);
}
