/**
 * The start ports runtime routes hand to Station's own durable deliveries:
 * the conversation inbox's placement. It continues the conversation as the recorded sender and says, from the
 * server's own facts, who caused the turn (#4512 `dispatchOrigin`).
 *
 * Kept apart from `runtime-routes.ts` so the exact port production composes
 * is the one its tests drive.
 */
import type { SessionStartResult } from '@kontourai/monument';
import {
  type ClientOrigin,
  UNKNOWN_CLIENT_ORIGIN,
} from '@kontourai/station-contracts/client-origin';
import type { ExecutionModelRequest } from '@kontourai/station-contracts/execution-target';
import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import type { TurnDispatchOrigin } from '@kontourai/station-contracts/runtime-events';
import type { StartOwnerAttribution } from '../../services/orchestration/session-owner-attribution.js';
import {
  inboxTurnDispatchOrigin,
  type ThreadInboxPayload,
} from '../../services/orchestration/thread-inbox.js';

/** What a continuation as the recorded sender is asked to send. */
export interface RecordedActorContinuation {
  conversationId: string;
  message: string;
  clientTurnId: string;
  userId: string;
  principal?: PrincipalRef;
  ownerAttribution: StartOwnerAttribution | undefined;
  clientOrigin: ClientOrigin;
  ambientContext?: string;
  model?: ExecutionModelRequest;
  inputDigest?: string;
  inboxPlacement?: true;
  automaticBackground?: true;
  dispatchOrigin?: TurnDispatchOrigin;
}

export type ContinueAsRecordedActor = (
  input: RecordedActorContinuation,
  threadId: string,
) => Promise<SessionStartResult>;

interface StartPortDeps {
  /** The Session's immutable room execution binding, when it has one. */
  readProjectTaskRoomExecutionBinding(sessionId: string): unknown;
  continueAsRecordedActor: ContinueAsRecordedActor;
}

/** Whether the Session that will take the turn is bound to a Task. */
function taskBound(deps: StartPortDeps, threadId: string): boolean {
  return deps.readProjectTaskRoomExecutionBinding(threadId) !== undefined;
}

/** The conversation inbox's placement: one queued entry, as its sender. */
export function inboxPlacementStartPort(deps: StartPortDeps) {
  return ({
    conversationId,
    threadId,
    payload,
    clientTurnId,
  }: {
    readonly conversationId: string;
    readonly threadId: string;
    readonly payload: ThreadInboxPayload;
    readonly clientTurnId: string;
  }): Promise<SessionStartResult> =>
    deps.continueAsRecordedActor(
      {
        conversationId,
        message: payload.message,
        automaticBackground: payload.automaticBackground,
        inputDigest: payload.inputDigest,
        inboxPlacement: true,
        dispatchOrigin: inboxTurnDispatchOrigin(
          payload,
          taskBound(deps, threadId),
        ),
        clientTurnId,
        userId: payload.actor.userId,
        principal: payload.actor.principal,
        ownerAttribution: payload.actor.ownerAttribution,
        clientOrigin: payload.clientOrigin ?? UNKNOWN_CLIENT_ORIGIN,
        ...(payload.ambientContext
          ? { ambientContext: payload.ambientContext }
          : {}),
        ...(payload.model ? { model: payload.model } : {}),
      },
      threadId,
    );
}
