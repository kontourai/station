/**
 * archive#1225 (offline): the ONE shared "refresh this chat's
 * transcript from the server" mechanism — extracted out of
 * `useRehydrateSessions` (`useActiveChatSessionLifecycle.ts`, previously the
 * only caller) so a second caller doesn't have to reimplement it.
 *
 * The second caller is `applyOrchestrationSnapshot`'s reconnect-fallback
 * branch (`snapshotHandlers.ts`): when the server's resume cursor decides a
 * reconnecting client's missed-event gap is too large to replay (or the
 * cursor itself is stale/evicted — `resolveStreamResumePlan`'s
 * `gap_exceeded`/`invalid_cursor` outcomes), it falls back to an
 * `orchestration:snapshot` frame that only carries per-session STATUS
 * fields, not the turns that happened during the gap. A currently-open
 * chat's message transcript would otherwise stay stale forever — this is
 * the bounded "full refetch" the gap-exceeded fallback needs, applied
 * per-session instead of unbounded event replay.
 *
 * Deliberately NOT a hook: both call sites need to invoke this from
 * non-React code (`ensureOrchestrationEventStream.ts`'s module-level SSE
 * handler has no component to hook into) or, in `useRehydrateSessions`'s
 * case, from inside a `useCallback` body — a plain async function over the
 * store singletons (`conversationsStore`, `activeChatsStore`) works for both.
 *
 * archive#1225 `queryClient` is threaded through as an
 * explicit param, NOT dropped — `conversationsStore.fetchMessages` uses it
 * to look up the cached `['agentTools', agentSlug]` query and build
 * `toolMappings`, the fallback for a persisted tool-call part that lacks its
 * own server/toolName/originalName (without it, those render raw internal
 * tool names instead of the resolved display name). Both callers supply it
 * from a real hook boundary: `useRehydrateSessions` calls `useQueryClient`
 * directly; the reconnect path threads it down from `useOrchestration`'s
 * `useQueryClient` call through `ensureOrchestrationEventStream` ->
 * `applyOrchestrationSnapshot` (neither of which is a hook, so neither can
 * call `useQueryClient` itself).
 */
import type { QueryClient } from '@tanstack/react-query';
import type { ChatUIState } from '../../contexts/active-chats-state';
import { activeChatsStore } from '../../contexts/active-chats-store';
import { conversationsStore } from '../../contexts/conversations-store';
import { deriveLatestPlanArtifactFromMessages } from '../../utils/planArtifacts';
import {
  type ActiveChatConversationMessage,
  buildRehydratedInputHistory,
  normalizeConversationMessages,
  resolveConversationUpdatedAt,
} from '../useActiveChatSessions.helpers';

export interface RehydrateChatSessionOptions {
  /**
   * `true` bypasses `conversationsStore`'s in-flight/cached fetch guard
   * (`refreshMessages`) so a known-stale transcript is genuinely
   * re-fetched. `false`/omitted uses the cheaper `fetchMessages` path
   * (`useRehydrateSessions`'s mount-time behavior, unchanged).
   */
  force?: boolean;
  /**
   * The mounted app's `QueryClient`, when the caller has one available (see
   * the file-header note) — forwarded verbatim to
   * `conversationsStore.fetchMessages`/`refreshMessages` for the
   * `toolMappings` cache lookup. Omitted only where no hook boundary is
   * reachable at all; every real call site in this app has one.
   */
  queryClient?: QueryClient;
}

/**
 * Refetches one chat session's transcript from the server and folds it back
 * into `activeChatsStore` — the same normalize / plan-artifact /
 * input-history derivation `useRehydrateSessions` used inline before this
 * extraction, PLUS the `queryClient`-backed `toolMappings` fallback that
 * inline code also had (see the file-header -fix note).
 */
export async function rehydrateChatSession(
  apiBase: string,
  sessionId: string,
  chat: Pick<
    ChatUIState,
    | 'agentSlug'
    | 'conversationId'
    | 'inputHistory'
    | 'planArtifact'
    | 'orchestrationSessionStarted'
    | 'provider'
  >,
  options: RehydrateChatSessionOptions = {},
): Promise<void> {
  const { agentSlug, conversationId } = chat;
  if (!agentSlug || !conversationId) return;
  // Station-owned threads hydrate through the bounded event-window reader in
  // ChatDock. Reading /messages here would recreate an unbounded second
  // transcript authority during every reconnect.
  if (chat.orchestrationSessionStarted) return;

  if (options.force) {
    await conversationsStore.refreshMessages(
      apiBase,
      agentSlug,
      conversationId,
      options.queryClient,
    );
  } else {
    await conversationsStore.fetchMessages(
      apiBase,
      agentSlug,
      conversationId,
      options.queryClient,
    );
  }

  const messagesKey = `messages:${agentSlug}:${conversationId}`;
  const backendMessages = (conversationsStore.getSnapshot().messages[
    messagesKey
  ] || []) as ActiveChatConversationMessage[];
  // archive#1311: this path is BOTH the mount-time rehydrate AND the
  // reconnect-fallback catchup sweep (see file header) — the latter can run
  // for every tracked chat on every SSE reconnect, so re-normalizing the
  // SAME backend messages here must not re-inflate recency to "now" each
  // time. Anchor to the conversation's real `updatedAt` when resolvable.
  const conversationUpdatedAt = resolveConversationUpdatedAt(
    options.queryClient,
    agentSlug,
    conversationId,
  );
  const normalizedMessages = normalizeConversationMessages(
    backendMessages,
    conversationUpdatedAt,
  );
  const latestPlanArtifact =
    deriveLatestPlanArtifactFromMessages(normalizedMessages as any) ??
    chat.planArtifact ??
    null;

  activeChatsStore.updateChat(sessionId, {
    messages: normalizedMessages,
    inputHistory: buildRehydratedInputHistory(
      backendMessages,
      chat.inputHistory,
    ),
    planArtifact: latestPlanArtifact,
  });
}
