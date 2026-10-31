/**
 * The one hand-off of a Station-framed turn onto a conversation's inbox.
 *
 * A check-back (`AgentWakeUpDelivery`) and an automation run that targets a
 * conversation (`ScheduledConversationRuns`) both send a turn Station wrote,
 * as an actor a durable record kept, under an idempotency key derived from
 * their own id. They share this function so the origin, the actor replay and
 * the key handling cannot drift between them.
 */
import {
  CLIENT_ORIGIN_VERSION,
  type ClientOrigin,
  UNKNOWN_CLIENT_REPORTED_ORIGIN,
} from '@kontourai/station-contracts/client-origin';
import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import type { StartOwnerAttribution } from './session-owner-attribution.js';
import type {
  ThreadInboxPayload,
  ThreadInboxSubmission,
} from './thread-inbox.js';

/**
 * The origin a Station-framed turn records: Station's own server code, never
 * a person, as a delegated result's is.
 */
export const STATION_FRAMED_TURN_CLIENT_ORIGIN: ClientOrigin = Object.freeze({
  version: CLIENT_ORIGIN_VERSION,
  actor: Object.freeze({ kind: 'internal' as const }),
  reported: UNKNOWN_CLIENT_REPORTED_ORIGIN,
});

/** The recorded sender a framed turn replays: never a stronger one. */
export interface StationFramedTurnActor {
  readonly userId: string;
  readonly attribution?: StartOwnerAttribution;
  readonly principal?: PrincipalRef;
}

export type StationFramedTurnSubmit = (input: {
  conversationId: string;
  clientTurnId: string;
  payload: ThreadInboxPayload;
}) => ThreadInboxSubmission;

/**
 * Queue one framed turn. The inbox applies the live continuation's own
 * permission rule at acceptance and again at placement, stores no
 * full-access grant, and accepts a key once, so a caller that hands the
 * same key over again after a restart gets the same entry back.
 */
export function submitStationFramedTurn(
  submit: StationFramedTurnSubmit,
  input: {
    readonly conversationId: string;
    readonly clientTurnId: string;
    readonly message: string;
    readonly actor: StationFramedTurnActor;
  },
): ThreadInboxSubmission {
  return submit({
    conversationId: input.conversationId,
    clientTurnId: input.clientTurnId,
    payload: {
      message: input.message,
      actor: {
        userId: input.actor.userId,
        ...(input.actor.attribution
          ? { ownerAttribution: input.actor.attribution }
          : {}),
        ...(input.actor.principal ? { principal: input.actor.principal } : {}),
      },
      clientOrigin: STATION_FRAMED_TURN_CLIENT_ORIGIN,
    },
  });
}
