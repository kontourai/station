/**
 * The two iOS request bodies the Station sends the push gateway, built in
 * exactly the documented shape (docs/design/notification-delivery.md, "iOS"):
 * the gateway refuses unknown keys, so nothing optional is ever present as
 * `undefined` or `null`. Signed like the FCM body (`push-signing-key-store`).
 *
 * A start carries no channel: the gateway creates one per activity inside
 * the start and answers its `channelId` and `channelAuth`, which every later
 * update, end and delete of that channel must carry.
 */
import type { NativePushIosBundle } from '@kontourai/station-contracts/native-push';

export type ApnsEnvironment = 'production' | 'sandbox';

interface Topic {
  bundleId: NativePushIosBundle;
  environment: ApnsEnvironment;
}

interface ChannelRef {
  channelId: string;
  channelAuth: string;
}

interface Card {
  registrationId: string;
  sealed: string;
  alert: boolean;
  /** Unix seconds. */
  timestamp: number;
}

/** `POST /v1/apns/live-activity`. Times are Unix seconds. */
export type LiveActivityGatewayRequest =
  | (Topic & { event: 'start'; pushToStartToken: string } & Card & {
        staleAt: number;
      })
  | (Topic & { event: 'update' } & ChannelRef & Card & { staleAt: number })
  | (Topic & { event: 'end' } & ChannelRef & Card & { dismissAt: number });

export function buildLiveActivityGatewayRequest(
  input: LiveActivityGatewayRequest,
): LiveActivityGatewayRequest {
  const topic = { bundleId: input.bundleId, environment: input.environment };
  const card = {
    registrationId: input.registrationId,
    sealed: input.sealed,
    alert: input.alert,
    timestamp: input.timestamp,
  };
  switch (input.event) {
    case 'start':
      return {
        ...topic,
        event: 'start',
        pushToStartToken: input.pushToStartToken,
        ...card,
        staleAt: input.staleAt,
      };
    case 'update':
      return {
        ...topic,
        event: 'update',
        channelId: input.channelId,
        channelAuth: input.channelAuth,
        ...card,
        staleAt: input.staleAt,
      };
    case 'end':
      return {
        ...topic,
        event: 'end',
        channelId: input.channelId,
        channelAuth: input.channelAuth,
        ...card,
        dismissAt: input.dismissAt,
      };
  }
}

/** `POST /v1/apns/channels`: deletion is the only operation. */
export type ApnsChannelDeleteRequest = { op: 'delete' } & Topic & ChannelRef;

export function buildApnsChannelDeleteRequest(
  input: Topic & ChannelRef,
): ApnsChannelDeleteRequest {
  return {
    op: 'delete',
    bundleId: input.bundleId,
    environment: input.environment,
    channelId: input.channelId,
    channelAuth: input.channelAuth,
  };
}
