import { isValidContextObservation } from '@kontourai/station-shared/usage-semantics';
import type { StationStateScope } from '../../connections/station-state';
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
  station?: StationStateScope,
) {
  const chatStore = activeChatsStore.forStation(station);
  const chat = chatStore.getChatForExecutionSession(event.threadId);
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
  const contextPercent =
    typeof event.contextPercent === 'number' &&
    Number.isFinite(event.contextPercent) &&
    event.contextPercent >= 0 &&
    event.contextPercent <= 100
      ? event.contextPercent
      : undefined;
  const reportedCost =
    event.reportedCost &&
    typeof event.reportedCost.amount === 'number' &&
    Number.isFinite(event.reportedCost.amount) &&
    event.reportedCost.amount >= 0 &&
    typeof event.reportedCost.unit === 'string' &&
    event.reportedCost.unit &&
    (event.reportedCost.scope === 'turn' ||
      event.reportedCost.scope === 'session')
      ? {
          amount: event.reportedCost.amount,
          unit: event.reportedCost.unit,
          scope: event.reportedCost.scope,
        }
      : undefined;
  if (
    !hasTokenUsage &&
    !hasContextObservation &&
    contextPercent === undefined &&
    !reportedCost
  )
    return;

  const mergedUsage = {
    ...chat.liveUsage,
    ...(event.promptTokens !== undefined
      ? { inputTokens: event.promptTokens }
      : {}),
    ...(event.completionTokens !== undefined
      ? { outputTokens: event.completionTokens }
      : {}),
    ...(event.cacheReadTokens !== undefined
      ? { cacheReadTokens: event.cacheReadTokens }
      : {}),
    ...(event.cacheWriteTokens !== undefined
      ? { cacheWriteTokens: event.cacheWriteTokens }
      : {}),
  };

  chatStore.updateChat(event.threadId, {
    liveUsage: {
      ...mergedUsage,
      ...(hasTokenUsage
        ? {
            ...(event.totalTokens !== undefined
              ? { totalTokens: event.totalTokens }
              : event.promptTokens !== undefined ||
                  event.completionTokens !== undefined
                ? {
                    totalTokens:
                      (mergedUsage.inputTokens ?? 0) +
                      (mergedUsage.outputTokens ?? 0),
                  }
                : {}),
          }
        : {}),
      ...(hasContextObservation
        ? {
            contextTokens: event.contextTokens,
            contextWindowTokens: event.contextWindowTokens,
          }
        : {}),
      ...(contextPercent !== undefined ? { contextPercent } : {}),
      ...(reportedCost ? { reportedCost } : {}),
    },
  });
}
