import { activeChatsStore } from '../../contexts/active-chats-store';
import { derivePlanArtifactFromStreamingState } from '../../utils/planArtifacts';
import { extractUIBlocks } from '../../utils/uiBlocks';
import {
  createAssistantStreamingMessage,
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

export function handleToolCompletedEvent(
  event: Extract<OrchestrationEvent, { method: 'tool.completed' }>,
) {
  const chat = activeChatsStore.getChatForExecutionSession(event.threadId);
  if (!chat) return;
  const streamingMessage = getStreamingMessage(chat);

  // station#3117: `policyDenied` is derived server-side from the real
  // ToolCallDenial (pre-tool-policy.ts's deny(), carried through the engine
  // adapter and the station-agent relay) — never inferred here from the
  // mere presence of an error. Its absence means "we don't know why this
  // failed", not "policy denied it", so no fallback is applied.
  const policyDenied = event.policyDenied === true;
  let contentParts = upsertToolPart(
    streamingMessage.contentParts,
    event.toolCallId,
    {
      toolName: event.toolName,
      sourceEventId: event.eventId,
      state:
        event.status === 'success'
          ? 'completed'
          : event.status === 'cancelled'
            ? 'cancelled'
            : 'error',
      result: event.output,
      error: event.error,
      ...(event.outputReceipt?.truncated
        ? { outputTruncated: true as const }
        : {}),
      // station#3167: `isError` means "failed" specifically — a
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
    },
  );
  if (event.eventId) {
    contentParts = upsertToolResultBlocks(
      contentParts,
      event.toolCallId,
      event.eventId,
      extractUIBlocks(event.output),
    );
  }

  activeChatsStore.updateChat(event.threadId, {
    isProcessingStep: false,
    streamingMessage: {
      ...streamingMessage,
      // `eventId` is optional on the live event envelope. A missing identity
      // is a corrupt/incomplete result, not a license to coalesce its blocks
      // by the reusable tool-call id; retain the terminal result above but
      // omit unpinnable UI blocks.
      contentParts,
    },
  });

  notifyToolCompletion(event, chat);
}
