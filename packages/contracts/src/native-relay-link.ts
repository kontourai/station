import type { SelfHostedBrokerNativeRouteInvitationV2 } from './self-hosted-broker.js';

export type NativeRelayLinkChannel = 'dev' | 'stable' | 'beta' | 'nightly';

/** Public routing hints. None authenticates a Station or selects it for use. */
export interface NativeRelayLinkRoute {
  readonly applicationOrigin: string;
  readonly brokerOrigin: string;
  readonly stationId: string;
  readonly enrollmentId: string;
}

export type NativeRelayLinkV1 =
  | (NativeRelayLinkRoute & {
      readonly version: 'station-native-relay-link/v1';
      readonly kind: 'route-intent';
    })
  | {
      readonly version: 'station-native-relay-link/v1';
      readonly kind: 'bound-invitation';
      readonly applicationOrigin: string;
      readonly invitation: SelfHostedBrokerNativeRouteInvitationV2;
    };

/** Secret-free native delivery. The host alone retains the invitation. */
export type NativeRelayLinkDelivery =
  | {
      readonly kind: 'route-intent';
      readonly pendingId: string;
      readonly route: NativeRelayLinkRoute;
    }
  | {
      readonly kind: 'bound-invitation';
      readonly pendingId: string;
      readonly route: NativeRelayLinkRoute;
      readonly invitation: {
        readonly invitationId: string;
        readonly expiresAt: number;
        readonly routingGeneration: number;
        readonly stationSigningKeyId: string;
        readonly stationSigningGeneration: number;
        readonly surface: SelfHostedBrokerNativeRouteInvitationV2['surface'];
      };
    }
  | {
      readonly kind: 'rejected';
      readonly code: 'unsupported' | 'invalid' | 'expired' | 'unavailable';
      readonly message: string;
    };
