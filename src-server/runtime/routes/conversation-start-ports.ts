/**
 * The start ports runtime routes hand to Station's own durable deliveries:
 * the conversation inbox's placement, a delegated result's delivery, and a
 * scheduled Automation's first run on a dedicated conversation. Each continues the conversation as the recorded sender and says, from the
 * server's own facts, who caused the turn (#4512 `dispatchOrigin`).
 *
 * Kept apart from `runtime-routes.ts` so the exact port production composes
 * is the one its tests drive.
 */
import type { SessionStartResult } from '@kontourai/monument';
import { agentId } from '@kontourai/station-contracts/agent-identity';
import {
  type ClientOrigin,
  type ClientOriginSender,
  UNKNOWN_CLIENT_ORIGIN,
} from '@kontourai/station-contracts/client-origin';
import type { ExecutionModelRequest } from '@kontourai/station-contracts/execution-target';
import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import type { TurnDispatchOrigin } from '@kontourai/station-contracts/runtime-events';
import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import type { ForegroundMessageContext } from '../../services/execution-target/execution-target-execution.js';
import type { StartOwnerAttribution } from '../../services/orchestration/session-owner-attribution.js';
import { STATION_FRAMED_TURN_CLIENT_ORIGIN } from '../../services/orchestration/station-turn-handoff.js';
import {
  inboxTurnDispatchOrigin,
  type ThreadInboxPayload,
} from '../../services/orchestration/thread-inbox.js';
import type { ScheduledConversationRunsPorts } from '../../services/scheduling/scheduled-conversation-runs.js';
import type { executeExecutionTargetMessage } from '../../tools/station-control-delegation.js';

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

/**
 * A scheduled Automation's first run on its dedicated conversation: a new
 * conversation started through the foreground execution seam, as the job's
 * recorded creator, with Station's framed origin and no full-access grant.
 */
export function scheduledDedicatedStartPort(deps: {
  execute(
    input: Parameters<typeof executeExecutionTargetMessage>[0],
    context: ForegroundMessageContext,
  ): ReturnType<typeof executeExecutionTargetMessage>;
  readAuthorityForExecution(userId: string): SessionReadAuthority;
}): ScheduledConversationRunsPorts['startDedicated'] {
  return async ({
    agent,
    workspace,
    message,
    clientTurnId,
    conversationId,
    actor,
  }) => {
    const handle = await deps.execute(
      {
        target: {
          environment: { kind: 'current' },
          agent: agentId(agent),
          ...(workspace ? { workspace } : {}),
        },
        message,
        clientTurnId,
        conversationId,
        userId: actor.userId,
        ...(actor.principal ? { principal: actor.principal } : {}),
        ...(actor.ownerAttribution
          ? { ownerAttribution: actor.ownerAttribution }
          : {}),
        clientOrigin: STATION_FRAMED_TURN_CLIENT_ORIGIN,
        fullAccessGrant: null,
        readAuthority: deps.readAuthorityForExecution(actor.userId),
      },
      // #4512: an Automation's run.
      { dispatchOrigin: 'automation' },
    );
    return {
      conversationId: handle.conversationId,
      sessionId: handle.sessionId,
      turnId: handle.providerTurnId,
    };
  };
}

/**
 * A delegated child's result delivered into its parent's conversation, as
 * the delegating dispatch's recorded sender.
 */
export function delegationResultStartPort(
  deps: StartPortDeps & { readonly origin: ClientOrigin },
) {
  return (input: {
    readonly parentConversationId: string;
    readonly threadId: string;
    readonly actor: {
      readonly userId: string;
      readonly principal?: PrincipalRef;
      readonly attribution?: StartOwnerAttribution;
    };
    readonly sender: ClientOriginSender;
    readonly text: string;
    readonly clientTurnId: string;
  }): Promise<SessionStartResult> => {
    const clientOrigin: ClientOrigin = { ...deps.origin, sender: input.sender };
    return deps.continueAsRecordedActor(
      {
        conversationId: input.parentConversationId,
        message: input.text,
        clientTurnId: input.clientTurnId,
        userId: input.actor.userId,
        principal: input.actor.principal,
        ownerAttribution: input.actor.attribution,
        clientOrigin,
        dispatchOrigin: inboxTurnDispatchOrigin(
          { clientOrigin },
          taskBound(deps, input.threadId),
        ),
      },
      input.threadId,
    );
  };
}
