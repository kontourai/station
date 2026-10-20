import type { NativeDeviceBindingCandidateV1 } from './native-device-proof.js';
import type { NativeRelayLinkRoute } from './native-relay-link.js';
import type {
  SelfHostedBrokerNativeClientSurfaceV2,
  SelfHostedBrokerNativeScopeV2,
} from './self-hosted-broker.js';

export type RelayInvitationLifetime = '5m' | '15m' | '1h' | '24h' | 'never';
export interface RelaySetupApproval {
  readonly approvalId: string;
  readonly revision: number;
  readonly approvedBy?: string;
  readonly scope: SelfHostedBrokerNativeScopeV2;
  readonly surface: SelfHostedBrokerNativeClientSurfaceV2;
}
export interface RelayPendingDevice {
  readonly enrollmentId: string;
  readonly requestId: string;
  readonly candidate: NativeDeviceBindingCandidateV1;
  readonly account: {
    readonly issuer: string;
    readonly subject: string;
    readonly displayName: string;
  };
  readonly requestedScope: 'orchestration:read';
  readonly expiresAt: number;
}
export interface RelayManagementView {
  readonly route: NativeRelayLinkRoute;
  readonly confirmationCode: string;
  readonly keyId: string;
  readonly setupLinks: {
    readonly stable: string;
    readonly beta: string;
    readonly nightly: string;
  };
  readonly approvals: readonly RelaySetupApproval[];
  readonly pendingDevices: readonly RelayPendingDevice[];
}
