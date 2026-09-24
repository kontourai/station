/**
 * The two iOS request bodies the Station sends the push gateway, built in
 * exactly the documented shape (docs/design/notification-delivery.md, "iOS"):
 * the gateway refuses unknown keys, so nothing optional is ever present as
 * `undefined` or `null`. Signed like the FCM body (`push-signing-key-store`).
 */
import type { NativePushIosBundle } from '@kontourai/station-contracts/native-push';

export type ApnsEnvironment = 'production' | 'sandbox';

/** `POST /v1/apns/live-activity`. Times are Unix seconds. */
export type LiveActivityGatewayRequest = {
  bundleId: NativePushIosBundle;
  environment: ApnsEnvironment;
  channelId: string;
  registrationId: string;
  sealed: string;
  alert: boolean;
  timestamp: number;
} & (
  | { event: 'start'; pushToStartToken: string; staleAt: number }
  | { event: 'update'; staleAt: number }
  | { event: 'end'; dismissAt: number }
);

export function buildLiveActivityGatewayRequest(
  input: {
    bundleId: NativePushIosBundle;
    environment: ApnsEnvironment;
    channelId: string;
    registrationId: string;
    sealed: string;
    alert: boolean;
    timestamp: number;
  } & (
    | { event: 'start'; pushToStartToken: string; staleAt: number }
    | { event: 'update'; staleAt: number }
    | { event: 'end'; dismissAt: number }
  ),
): LiveActivityGatewayRequest {
  const common = {
    bundleId: input.bundleId,
    environment: input.environment,
  };
  const routed = {
    channelId: input.channelId,
    registrationId: input.registrationId,
    sealed: input.sealed,
    alert: input.alert,
    timestamp: input.timestamp,
  };
  switch (input.event) {
    case 'start':
      return {
        ...common,
        event: 'start',
        pushToStartToken: input.pushToStartToken,
        ...routed,
        staleAt: input.staleAt,
      };
    case 'update':
      return { ...common, event: 'update', ...routed, staleAt: input.staleAt };
    case 'end':
      return {
        ...common,
        event: 'end',
        ...routed,
        dismissAt: input.dismissAt,
      };
  }
}

/** `POST /v1/apns/channels`. */
export type ApnsChannelGatewayRequest =
  | {
      op: 'create';
      bundleId: NativePushIosBundle;
      environment: ApnsEnvironment;
    }
  | {
      op: 'delete';
      bundleId: NativePushIosBundle;
      environment: ApnsEnvironment;
      channelId: string;
    };

export function buildApnsChannelGatewayRequest(
  input:
    | {
        op: 'create';
        bundleId: NativePushIosBundle;
        environment: ApnsEnvironment;
      }
    | {
        op: 'delete';
        bundleId: NativePushIosBundle;
        environment: ApnsEnvironment;
        channelId: string;
      },
): ApnsChannelGatewayRequest {
  return input.op === 'create'
    ? { op: 'create', bundleId: input.bundleId, environment: input.environment }
    : {
        op: 'delete',
        bundleId: input.bundleId,
        environment: input.environment,
        channelId: input.channelId,
      };
}
