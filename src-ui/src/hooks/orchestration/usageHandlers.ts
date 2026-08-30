import { isValidContextObservation } from '@kontourai/station-shared/usage-fold';
import { activeChatsStore } from '../../contexts/active-chats-store';
import type { OrchestrationEvent } from './types';

/**
 * Mirrors a `token-usage.updated` event onto the chat's `liveUsage` field
 * (archive#1299 item 3b). Each reported field is intentionally
 * last-event-wins while omitted fields carry forward; this is not a running
 * sum. See `ChatLiveUsage`'s docblock
 * (`active-chats-state.ts`) for why reconciling Claude Code's per-turn
 * deltas against Codex's cumulative running totals client-side isn't
 * attempted here; the server-side fold already does this correctly and
 * remains the authoritative source (the stats route, refetched by
 * `ContextPercentage` on message-count change).
 */
export function handleTokenUsageUpdatedEvent(
  event: Extract<OrchestrationEvent, { method: 'token-usage.updated' }>,
) {
  const chat = activeChatsStore.getChatForExecutionSession(event.threadId);
  if (!chat) return;

  const hasTokenUsage =
    event.promptTokens !== undefined ||
    event.completionTokens !== undefined ||
    event.totalTokens !== undefined ||
    event.cacheReadTokens !== undefined ||
    event.cacheWriteTokens !== undefined;
  const hasContextObservation = isValidContextObservation(
    event.contextTokens,
    event.contextWindowTokens,
  );
  if (!hasTokenUsage && !hasContextObservation) return;

  activeChatsStore.updateChat(event.threadId, {
    liveUsage: {
      ...chat.liveUsage,
      ...(hasTokenUsage
        ? {
            ...(event.promptTokens !== undefined
              ? { inputTokens: event.promptTokens }
              : {}),
            ...(event.completionTokens !== undefined
              ? { outputTokens: event.completionTokens }
              : {}),
            ...(event.totalTokens !== undefined
              ? { totalTokens: event.totalTokens }
              : event.promptTokens !== undefined ||
                  event.completionTokens !== undefined
                ? {
                    totalTokens:
                      (event.promptTokens ?? 0) + (event.completionTokens ?? 0),
                  }
                : {}),
            ...(event.cacheReadTokens !== undefined
              ? { cacheReadTokens: event.cacheReadTokens }
              : {}),
            ...(event.cacheWriteTokens !== undefined
              ? { cacheWriteTokens: event.cacheWriteTokens }
              : {}),
          }
        : {}),
      ...(hasContextObservation
        ? {
            contextTokens: event.contextTokens,
            contextWindowTokens: event.contextWindowTokens,
          }
        : {}),
    },
  });
}
