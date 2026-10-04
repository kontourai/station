import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import type { DeploymentAuthenticationService } from '../services/identity/deployment-authentication-service.js';
import type { DevicePairingService } from '../services/ssh/device-pairing-service.js';
import {
  getRuntimeAuthenticatedRequestPrincipal,
  getRuntimeNativeDeviceProofPrincipal,
} from './runtime-request-security.js';

export interface RelayManagementActorCurrency {
  current(): boolean;
  refresh(): Promise<boolean>;
}
/** Currency of the canonical actor already resolved by the request-principal owner. */
export function captureRelayManagementActor(
  request: Request,
  actor: PrincipalRef,
  pairing: Pick<DevicePairingService, 'listDevices' | 'identifyDevice'>,
  authentication?: Pick<
    DeploymentAuthenticationService,
    'current' | 'authenticate'
  >,
): RelayManagementActorCurrency {
  const native = getRuntimeNativeDeviceProofPrincipal(request);
  const principal = getRuntimeAuthenticatedRequestPrincipal(request);
  const device = () =>
    native
      ? pairing
          .listDevices()
          .find((candidate) => candidate.id === native.deviceId)
      : principal?.authority === 'device-credential'
        ? pairing.identifyDevice(principal.credential)
        : undefined;
  const fingerprint = () => {
    const binding = device()?.principalBinding;
    if (!binding) return null;
    return 'kind' in binding
      ? JSON.stringify([
          binding.kind,
          binding.issuer,
          binding.subject,
          binding.approvalId,
          binding.approvedAt,
          binding.approvedBy,
        ])
      : JSON.stringify([
          binding.provider,
          binding.subject,
          binding.approvalId,
          binding.approvedAt,
          binding.approvedBy,
        ]);
  };
  const binding = fingerprint();
  const initial = authentication?.current(request);
  const hadAccount = initial?.kind === 'authenticated';
  const current = () => {
    if (request.signal.aborted || fingerprint() !== binding) return false;
    const account = authentication?.current(request);
    return hadAccount
      ? account?.kind === 'authenticated' && account.principal.id === actor.id
      : account === undefined || account.kind === 'absent';
  };
  return Object.freeze({
    current,
    async refresh() {
      if (!current()) return false;
      if (authentication) {
        const latest = await authentication.authenticate(request);
        if (
          hadAccount
            ? latest.kind !== 'authenticated' ||
              latest.principal.id !== actor.id
            : latest.kind !== 'absent'
        )
          return false;
      }
      return current();
    },
  });
}
