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
  type ChatAttachmentInput,
  QUEUED_ATTACHMENT_UNAVAILABLE_CODE,
} from '@kontourai/station-contracts/chat-attachment';
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
  type SessionDispatchFacts,
  type ThreadInboxAttachment,
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
  /** Files read back from the attachment blob store for a queued follow-up. */
  attachments?: ChatAttachmentInput[];
  inputDigest?: string;
  inboxPlacement?: true;
  automaticBackground?: true;
  dispatchOrigin?: TurnDispatchOrigin;
  /** #4827: forwarded from a queued entry a person typed; see `authoredBy`. */
  personAuthored?: true;
}

/**
 * A queued follow-up whose file is no longer in the attachment blob store.
 * Thrown before anything starts, so the inbox records a clean refusal with
 * this code and the message is never sent without its file.
 */
class QueuedAttachmentUnavailableError extends Error {
  readonly code = QUEUED_ATTACHMENT_UNAVAILABLE_CODE;
  constructor() {
    super('A file held with this queued message is no longer stored.');
    this.name = 'QueuedAttachmentUnavailableError';
  }
}

/** Reads one stored file back as a request attachment, or undefined if gone. */
export type ReadQueuedAttachment = (
  file: ThreadInboxAttachment,
) => ChatAttachmentInput | undefined;

export type ContinueAsRecordedActor = (
  input: RecordedActorContinuation,
  threadId: string,
) => Promise<SessionStartResult>;

interface StartPortDeps {
  /** The Session's immutable room execution binding, when it has one. */
  readProjectTaskRoomExecutionBinding(sessionId: string): unknown;
  /**
   * What the Session that takes the turn says about whom it works for
   * (`readSessionDispatchFacts`). Without it a delegated result off a Task's
   * Session is `unknown`, never `delegation`.
   */
  sessionFacts?(sessionId: string): SessionDispatchFacts;
  continueAsRecordedActor: ContinueAsRecordedActor;
  /** Present on hosts that hold files with queued follow-ups. */
  readQueuedAttachment?: ReadQueuedAttachment;
}

/** {@link ReadQueuedAttachment} over the event store's attachment blobs. */
export function readQueuedAttachmentFrom(store: {
  readAttachmentBlob(ref: string): Buffer | undefined;
}): ReadQueuedAttachment {
  return (file) => {
    const bytes = store.readAttachmentBlob(file.blobRef);
    if (!bytes || bytes.length !== file.size) return undefined;
    return {
      kind: file.kind,
      name: file.name,
      mimeType: file.mimeType,
      size: file.size,
      dataUrl: `data:${file.mimeType};base64,${bytes.toString('base64')}`,
    };
  };
}

/**
 * A queued entry's files as request attachments, read back before its turn
 * starts. Throws {@link QueuedAttachmentUnavailableError} when any is gone.
 */
export function queuedAttachmentsOf(
  deps: Pick<StartPortDeps, 'readQueuedAttachment'>,
  payload: ThreadInboxPayload,
): ChatAttachmentInput[] | undefined {
  if (!payload.attachments?.length) return undefined;
  const read = deps.readQueuedAttachment;
  if (!read) throw new QueuedAttachmentUnavailableError();
  return payload.attachments.map((file) => {
    const attachment = read(file);
    if (!attachment) throw new QueuedAttachmentUnavailableError();
    return attachment;
  });
}

export { readSessionDispatchFacts } from '../../services/orchestration/session-dispatch-facts.js';

/** Whether the Session that will take the turn is bound to a Task. */
function taskBound(deps: StartPortDeps, threadId: string): boolean {
  return deps.readProjectTaskRoomExecutionBinding(threadId) !== undefined;
}

/** The conversation inbox's placement: one queued entry, as its sender. */
export function inboxPlacementStartPort(deps: StartPortDeps) {
  return async ({
    conversationId,
    threadId,
    payload,
    clientTurnId,
  }: {
    readonly conversationId: string;
    readonly threadId: string;
    readonly payload: ThreadInboxPayload;
    readonly clientTurnId: string;
  }): Promise<SessionStartResult> => {
    // Read before the start: a missing file refuses the entry cleanly.
    const attachments = queuedAttachmentsOf(deps, payload);
    return deps.continueAsRecordedActor(
      {
        conversationId,
        message: payload.message,
        ...(attachments ? { attachments } : {}),
        automaticBackground: payload.automaticBackground,
        inputDigest: payload.inputDigest,
        inboxPlacement: true,
        dispatchOrigin: inboxTurnDispatchOrigin(
          payload,
          taskBound(deps, threadId),
          deps.sessionFacts?.(threadId),
        ),
        clientTurnId,
        userId: payload.actor.userId,
        principal: payload.actor.principal,
        ownerAttribution: payload.actor.ownerAttribution,
        clientOrigin: payload.clientOrigin ?? UNKNOWN_CLIENT_ORIGIN,
        ...(payload.authoredBy === 'person'
          ? { personAuthored: true as const }
          : {}),
        ...(payload.ambientContext
          ? { ambientContext: payload.ambientContext }
          : {}),
        ...(payload.model ? { model: payload.model } : {}),
      },
      threadId,
    );
  };
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
          deps.sessionFacts?.(input.threadId),
        ),
      },
      input.threadId,
    );
  };
}
