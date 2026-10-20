import {
  PAIRING_SCOPE_RELAY_MANAGE,
  pairingScopeIncludes,
} from '@kontourai/station-contracts/environment-security';
import {
  isPrincipalRef,
  type PrincipalRef,
} from '@kontourai/station-contracts/principal';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../services/identity/principal-resolver.js';
import type { DevicePairingService } from '../services/ssh/device-pairing-service.js';
import type { EnvironmentSecurityService } from '../services/ssh/environment-security-service.js';
import type { RelayManagementActorCurrency } from './relay-management-actor.js';
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
    readonly subjectId: string,
    readonly actorPrincipalId: string,
    private readonly current: () => boolean,
    private readonly refreshActor: () => Promise<boolean>,
  ) {
    if (
      token !== APPROVAL_ORIGIN ||
      !(
        /^[A-Za-z0-9_-]{43}$/u.test(subjectId) ||
        /^[0-9a-f-]{36}$/u.test(subjectId)
      )
    )
      throw new Error('relay_management_required');
    Object.freeze(this);
  }
  isCurrent(): boolean {
    return this.current();
  }
  async refresh(): Promise<boolean> {
    return (await this.refreshActor()) && this.current();
  }
}
export function captureRelayManagementApproval(
  request: Request,
  subjectId: string,
  security: Security,
  pairing: Pick<DevicePairingService, 'deviceHoldsScope'>,
  actor: PrincipalRef,
  currency?: RelayManagementActorCurrency,
): RelayManagementApproval {
  const current = () =>
    hasRelayManagementAuthority(request, security, pairing) &&
    (currency?.current() ?? true);
  if (!current()) throw new Error('relay_management_required');
  if (actor.kind !== 'human' || !isPrincipalRef(actor))
    throw new Error('relay_management_actor_required');
  const principal = getRuntimeAuthenticatedRequestPrincipal(request);
  const owner =
    principal?.authority === 'operator-credential' ||
    isBoundRuntimeLocalOperator(request);
  if (!currency && !owner) throw new Error('relay_management_actor_required');
  if (!owner && actor.id === LOCAL_OPERATOR_PRINCIPAL_ID)
    throw new Error('relay_management_actor_required');
  return new RelayManagementApproval(
    APPROVAL_ORIGIN,
    subjectId,
    actor.id,
    current,
    () => currency?.refresh() ?? Promise.resolve(current()),
  );
}
