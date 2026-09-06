import type { ChatContentPart } from '../../contexts/active-chats-state';
import { activeChatsStore } from '../../contexts/active-chats-store';
import { derivePlanArtifactFromStreamingState } from '../../utils/planArtifacts';
import { extractUIBlocks } from '../../utils/uiBlocks';
import {
  createAssistantStreamingMessage,
  toolPartSettleableBy,
  upsertTextPart,
  upsertToolPart,
  upsertToolResultBlocks,
} from './messageParts';
import { notifyToolCompletion } from './toolActivityNotifications';
import type { OrchestrationEvent } from './types';

function getStreamingMessage(
  chat: ReturnType<typeof activeChatsStore.getSnapshot>[string],
) {
  return chat.streamingMessage || createAssistantStreamingMessage();
}

export function handleTextDeltaEvent(
  event: Extract<OrchestrationEvent, { method: 'content.text-delta' }>,
) {
  const chat = activeChatsStore.getChatForExecutionSession(event.threadId);
  if (!chat) return;
  const streamingMessage = getStreamingMessage(chat);

  // Built once and shared by the store update and the plan derivation —
  // this handler runs per streamed token, so any work here is per-token
  // work duplicated verbatim.
  const nextStreamingMessage = {
    role: 'assistant' as const,
    content: `${streamingMessage.content || ''}${event.delta}`,
    contentParts: upsertTextPart(
      streamingMessage.contentParts,
      'text',
      event.delta,
    ),
  };

  activeChatsStore.updateChat(event.threadId, {
    status: 'sending',
    // Real content is flowing — the transient "Thinking…" hint is stale.
    activityHint: undefined,
    streamingMessage: nextStreamingMessage,
    planArtifact: derivePlanArtifactFromStreamingState(
      {
        streamingMessage: nextStreamingMessage,
        planArtifact: chat.planArtifact,
      },
      event.createdAt,
    ),
  });
}

export function handleReasoningDeltaEvent(
  event: Extract<OrchestrationEvent, { method: 'content.reasoning-delta' }>,
) {
  const chat = activeChatsStore.getChatForExecutionSession(event.threadId);
  if (!chat) return;
  const streamingMessage = getStreamingMessage(chat);

  const nextStreamingMessage = {
    ...streamingMessage,
    contentParts: upsertTextPart(
      streamingMessage.contentParts,
      'reasoning',
      event.delta,
    ),
  };

  activeChatsStore.updateChat(event.threadId, {
    status: 'sending',
    streamingMessage: nextStreamingMessage,
    planArtifact: derivePlanArtifactFromStreamingState(
      {
        streamingMessage: nextStreamingMessage,
        planArtifact: chat.planArtifact,
      },
      event.createdAt,
    ),
  });
}

export function handleToolStartedEvent(
  event: Extract<OrchestrationEvent, { method: 'tool.started' }>,
) {
  const chat = activeChatsStore.getChatForExecutionSession(event.threadId);
  if (!chat) return;
  const streamingMessage = getStreamingMessage(chat);

  activeChatsStore.updateChat(event.threadId, {
    isProcessingStep: true,
    streamingMessage: {
      ...streamingMessage,
      contentParts: upsertToolPart(
        streamingMessage.contentParts,
        event.toolCallId,
        {
          toolName: event.toolName,
          args: event.arguments || {},
          state: 'running',
          activityAt: event.createdAt,
        },
      ),
    },
  });
}

export function handleToolProgressEvent(
  event: Extract<OrchestrationEvent, { method: 'tool.progress' }>,
) {
  const chat = activeChatsStore.getChatForExecutionSession(event.threadId);
  if (!chat) return;
  const streamingMessage = getStreamingMessage(chat);

  activeChatsStore.updateChat(event.threadId, {
    isProcessingStep: true,
    streamingMessage: {
      ...streamingMessage,
      contentParts: upsertToolPart(
        streamingMessage.contentParts,
        event.toolCallId,
        {
          state: 'running',
          progressMessage: event.message,
          ...(event.outputReceipt?.truncated
            ? { outputTruncated: true as const }
            : {}),
          activityAt: event.createdAt,
        },
      ),
    },
  });
}

/**
 * station#1558: does this part list already hold the call this result
 * settles? A part already pinned to a DIFFERENT terminal event id is a
 * distinct durable result and does not count.
 *
 * station#1569 (H1): shares `toolPartSettleableBy` with `upsertToolPart`
 * rather than restating it. These two must agree — this one decides WHICH
 * message the result lands on, that one decides which row inside it — and
 * when they disagreed about an `unresolved` row the scan skipped past the
 * message holding the call and the upsert then appended a second row to a
 * different message entirely.
 */
function holdsToolCall(
  parts: ChatContentPart[] | undefined,
  toolCallId: string,
  resultEventId: string | undefined,
): boolean {
  return (parts ?? []).some((part) =>
    toolPartSettleableBy(part, toolCallId, resultEventId),
  );
}

export function handleToolCompletedEvent(
  event: Extract<OrchestrationEvent, { method: 'tool.completed' }>,
) {
  const chat = activeChatsStore.getChatForExecutionSession(event.threadId);
  if (!chat) return;
  const streamingMessage = getStreamingMessage(chat);

  // archive#3117: `policyDenied` is derived server-side from the real
  // ToolCallDenial (pre-tool-policy.ts's deny, carried through the engine
  // adapter and the station-agent relay) — never inferred here from the
  // mere presence of an error. Its absence means "we don't know why this
  // failed", not "policy denied it", so no fallback is applied.
  const policyDenied = event.policyDenied === true;
  const updates = {
    toolName: event.toolName,
    sourceEventId: event.eventId,
    state:
      event.status === 'success'
        ? 'completed'
        : event.status === 'cancelled'
          ? 'cancelled'
          : // station#1558: an `unresolved` result reports that no outcome
            // will ever arrive — the session ended with the call open. It is
            // its own state: not `error` (nothing observed the tool fail),
            // not `cancelled` (nobody asked it to stop), and not `completed`
            // (there is no result). The durable projection
            // (`runtime-event-projection.ts`) derives the identical state.
            event.status === 'unresolved'
            ? 'unresolved'
            : 'error',
    result: event.output,
    error: event.error,
    ...(event.outputReceipt?.truncated
      ? { outputTruncated: true as const }
      : {}),
    // archive#3167: `isError` means "failed" specifically — a
    // cancellation is a correct user-initiated outcome, not a failure,
    // so it must not flip this. Anything downstream that counts
    // failures from this flag (e.g. `thread-projection.ts`'s export
    // fold) must not start counting cancellations.
    isError: event.status === 'error',
    // Overrides any call-time `approvalStatus` (e.g. an optimistic
    // 'auto-approved' from the session's own trust list) — Station's
    // own policy can deny a call the client believed was pre-approved
    // (config-protection runs before the auto-approve check), and
    // this is the authoritative, later verdict.
    ...(policyDenied ? { approvalStatus: 'policy-denied' as const } : {}),
  };

  const settle = (parts: ChatContentPart[] | undefined) => {
    const next = upsertToolPart(parts, event.toolCallId, updates);
    // `eventId` is optional on the live event envelope. A missing identity
    // is a corrupt/incomplete result, not a license to coalesce its blocks
    // by the reusable tool-call id; retain the terminal result above but
    // omit unpinnable UI blocks.
    return event.eventId
      ? upsertToolResultBlocks(
          next,
          event.toolCallId,
          event.eventId,
          extractUIBlocks(event.output),
        )
      : next;
  };

  // station#1558: a result belongs to the turn that ISSUED the call, which
  // the event names (`turnId`, PR #1560) and which is not always the turn
  // streaming right now — a stopped turn's in-flight tool and a backgrounded
  // Task both settle after their turn's bubble was committed. Folding by
  // stream position moved the row (or invented a result-only one) onto the
  // wrong turn. The durable projection (`runtime-event-projection.ts`) and
  // the provenance fold (`turn-provenance-fold.ts`) both attribute by
  // `turnId`; this is the live path saying the same thing.
  // station#1586 (item 4): the streaming message is subject to the same turn
  // rule as every committed one. It carries no `turnId` of its own — the
  // shell is identified by `chat.openTurnId` (archive#1410) — so the check
  // reads that instead, and is otherwise the committed scan's rule verbatim:
  // a contradiction needs BOTH ids present, because a row with no turn
  // identity makes no competing claim. Without it the fast path below settled
  // by call id alone, so a terminal naming turn A landed on the streaming
  // turn B's row whenever a provider reuses call ids across turns — the
  // defect the committed scan already refuses, reached by the one route that
  // never consulted it.
  const streamingTurnContradicts =
    event.turnId !== undefined &&
    chat.openTurnId !== undefined &&
    chat.openTurnId !== event.turnId;
  if (
    streamingTurnContradicts ||
    !holdsToolCall(
      streamingMessage.contentParts,
      event.toolCallId,
      event.eventId,
    )
  ) {
    const messages = chat.messages ?? [];
    let index = -1;
    // Fix round (M2): matching the call id is not enough. When the event
    // names a turn and a committed row belongs to a DIFFERENT one, settling
    // there would put the newer turn's result on the older row — the same
    // misattribution by another route, which a provider that reuses call ids
    // across turns would hit. Such a row is skipped and the named-turn route
    // below takes over. A row carrying no turn id of its own is not a
    // mismatch: there is no competing claim, and rejecting it would strand
    // every pre-turn-id row.
    for (let position = messages.length - 1; position >= 0; position -= 1) {
      const candidate = messages[position];
      const contradicts =
        event.turnId !== undefined &&
        candidate.turnId !== undefined &&
        candidate.turnId !== event.turnId;
      if (
        !contradicts &&
        holdsToolCall(candidate.contentParts, event.toolCallId, event.eventId)
      ) {
        index = position;
        break;
      }
    }
    if (index === -1 && event.turnId !== undefined) {
      // No call to match anywhere: the row becomes a standalone result on the
      // turn the event names. Only when that turn has no committed message
      // either (it is the streaming one, or it predates this client's
      // history) does the streaming message take it, below.
      for (let position = messages.length - 1; position >= 0; position -= 1) {
        if (messages[position].turnId === event.turnId) {
          index = position;
          break;
        }
      }
    }
    if (index >= 0) {
      const nextMessages = [...messages];
      nextMessages[index] = {
        ...messages[index],
        contentParts: settle(messages[index].contentParts),
      };
      // `isProcessingStep` describes the turn in flight. A result for an
      // EARLIER turn says nothing about it, so it is left alone.
      activeChatsStore.updateChat(event.threadId, { messages: nextMessages });
      notifyToolCompletion(event, chat);
      return;
    }
  }

  // Last resort: the event's turn has no committed message and no row
  // anywhere else, so the streaming shell takes it — including when
  // `streamingTurnContradicts`, which is a disclosed gap rather than a
  // decision (station#1586 item 4). It is reachable only for a turn this
  // client never streamed and never received in its history, since a turn it
  // did stream is committed and matched by the `turnId` scan above; there is
  // nowhere else to put the row, and dropping a terminal outright would leave
  // its call running forever.
  activeChatsStore.updateChat(event.threadId, {
    isProcessingStep: false,
    streamingMessage: {
      ...streamingMessage,
      contentParts: settle(streamingMessage.contentParts),
    },
  });

  notifyToolCompletion(event, chat);
}
