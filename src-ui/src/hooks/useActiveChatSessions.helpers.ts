import type { QueryClient } from '@tanstack/react-query';
import type { ChatMessage } from '../contexts/active-chats-state';
import type { FileAttachment } from '../types';

export type CompletionNoticeKind =
  | 'tool-calls'
  | 'length'
  | 'unexpected'
  | null;

type ConversationMessage = Pick<ChatMessage, 'role' | 'content'> & {
  contentParts?: Array<{
    type: string;
    content?: string;
    url?: string;
    mediaType?: string;
    name?: string;
  }>;
  finishReason?: string;
  model?: string;
  modelOptions?: Record<string, string | number | boolean>;
  metadata?: {
    sourceEventId?: string;
    model?: string | null;
    modelOptions?: Record<string, string | number | boolean>;
  };
  /** archive#1410: flattened by the SDK's `mapConversationMessages`. */
  turnId?: string;
  sessionId?: string;
  sourceEventId?: string;
  answerEligible?: boolean;
  provenance?: unknown;
  /**
   * archive#1295: the backend `ConversationMessage` shape carries this as an
   * ISO string (`chatRuntimeStream.ts`'s `mapConversationMessages`); accept
   * a bare number too so a caller that already parsed it (or a test fixture)
   * doesn't need to re-stringify.
   */
  timestamp?: string | number;
};

export type ActiveChatConversationMessage = ConversationMessage;

/**
 * archive#1295: parses a backend message's `timestamp` into the epoch-ms
 * number `ChatMessage.timestamp` expects, returning `undefined` when the
 * field is genuinely absent or unparsable — callers decide the fallback
 * (typically `Date.now`) rather than this silently defaulting to 0 the way
 * `latestChatTimestamp`'s reducer does for a *missing* field. A silent 0
 * here is exactly the bug (archive#1295): it sorts the chat dead last and skips
 * "Just finished" straight into "Earlier" with an epoch-age relative time.
 */
function parseBackendTimestamp(
  value: string | number | undefined,
): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * archive#1311: the *rehydrate* path's
 * `Date.now` fallback re-inflated an old, already-read conversation's
 * recency on every reopen and every SSE-reconnect catchup sweep —
 * normalizing the SAME backend messages hours apart produced a newer stamp
 * each time, which resorts a stale conversation to the top of the inbox on
 * nothing more than a reopen or a network blip. `resolveConversationUpdatedAt`
 * gives `normalizeConversationMessages` a real, stable anchor instead: a
 * best-effort, synchronous (no network call added) read of the conversation
 * list query React Query already caches for this agent
 * (`conversationQueries.list`'s `['conversations', agentSlug]` key) — the
 * same list surfaced by the agent's conversation picker/share-target modal
 * so a conversation the client has actually seen before yields its real
 * server-side `updatedAt`. An explicit inventory value from a row-open path
 * wins over the per-agent cache, closing the cold-cache first-reopen gap
 * without another request. Returns `undefined` when neither source resolves.
 */
export function resolveConversationUpdatedAt(
  queryClient: Pick<QueryClient, 'getQueryData'> | undefined,
  agentSlug: string,
  conversationId: string,
  explicitUpdatedAt?: string,
): number | undefined {
  const explicit = parseBackendTimestamp(explicitUpdatedAt);
  if (explicit !== undefined) return explicit;
  if (!queryClient) return undefined;
  const cached = queryClient.getQueryData<
    Array<{ id: string; updatedAt?: string }>
  >(['conversations', agentSlug]);
  const match = cached?.find(
    (conversation) => conversation.id === conversationId,
  );
  return match ? parseBackendTimestamp(match.updatedAt) : undefined;
}

/**
 * Per-message spacing (ms) used only to keep un-timestamped rehydrated
 * messages in stable relative order below the real anchor — not a claim
 * about actual inter-message timing.
 */
const REHYDRATE_MESSAGE_ORDER_BACKOFF_MS = 1000;

export function buildOutgoingUserMessage(
  currentMessages: ChatMessage[] | undefined,
  content: string,
  attachments?: FileAttachment[],
): {
  messages: ChatMessage[];
  contentParts?: ChatMessage['contentParts'];
  clientId: string;
} {
  const contentParts: NonNullable<ChatMessage['contentParts']> = [];
  if (content) {
    contentParts.push({ type: 'text', content });
  }
  if (attachments) {
    for (const attachment of attachments) {
      contentParts.push({
        type: 'file',
        mediaType: attachment.type,
        name: attachment.name,
      });
    }
  }

  // archive#1293: a stable client-only id for this optimistic append, so a
  // rejected send's rollback can remove exactly this message by id instead
  // of relying on the whole `messages` array still being the same reference
  // it was at send time (see rejectedSendRollback in
  // useActiveChatSessionMessaging.ts).
  const clientId = crypto.randomUUID();

  const nextMessage: ChatMessage = {
    role: 'user',
    content,
    contentParts: contentParts.length > 0 ? contentParts : undefined,
    clientId,
    // archive#1295: no normal write path stamped this before, so a healthy
    // chat's `latestChatTimestamp` reduced to 0 — dead last in recency sort,
    // and never young enough to land in "Just finished".
    timestamp: Date.now(),
  };

  return {
    messages: [...(currentMessages || []), nextMessage],
    contentParts: contentParts.length > 0 ? contentParts : undefined,
    clientId,
  };
}

export function buildPostSendState(
  backendMessages: ConversationMessage[],
  finishReason?: string,
): {
  messages: ChatMessage[];
  noticeKind: CompletionNoticeKind;
  effectiveFinishReason?: string;
} {
  const effectiveFinishReason =
    finishReason ||
    backendMessages[backendMessages.length - 1]?.finishReason ||
    undefined;

  // archive#1295: one fallback timestamp for the whole batch rather than a
  // fresh `Date.now` per message — the backend has no per-message
  // timestamp to lose precision against today, and a shared value keeps
  // this batch's relative order stable if the backend ever starts sending
  // real ones for only some of them.
  const fallbackTimestamp = Date.now();
  const messages = backendMessages.map((message) => ({
    role: message.role,
    content: message.content,
    contentParts: message.contentParts as ChatMessage['contentParts'],
    model: message.model ?? message.metadata?.model ?? undefined,
    modelOptions: message.modelOptions ?? message.metadata?.modelOptions,
    sourceEventId: message.sourceEventId ?? message.metadata?.sourceEventId,
    turnId: message.turnId,
    sessionId: message.sessionId,
    answerEligible: message.answerEligible,
    provenance: message.provenance,
    timestamp: parseBackendTimestamp(message.timestamp) ?? fallbackTimestamp,
  }));

  if (effectiveFinishReason === 'tool-calls') {
    return { messages, noticeKind: 'tool-calls', effectiveFinishReason };
  }

  if (effectiveFinishReason === 'length') {
    return { messages, noticeKind: 'length', effectiveFinishReason };
  }

  if (
    effectiveFinishReason &&
    effectiveFinishReason !== 'stop' &&
    effectiveFinishReason !== 'end_turn'
  ) {
    return { messages, noticeKind: 'unexpected', effectiveFinishReason };
  }

  return { messages, noticeKind: null, effectiveFinishReason };
}

export function buildRehydratedInputHistory(
  backendMessages: ConversationMessage[],
  inputHistory: string[] | undefined,
): string[] {
  const userMessages = backendMessages
    .filter((message) => message.role === 'user')
    .map((message) => message.content);
  const storedSlashCommands = (inputHistory || []).filter((input) =>
    input.startsWith('/'),
  );

  return [...userMessages, ...storedSlashCommands];
}

export function normalizeConversationMessages(
  backendMessages: ConversationMessage[],
  /**
   * archive#1311: the conversation's own server-side `updatedAt`
   * (epoch ms), when the caller can resolve one — see
   * `resolveConversationUpdatedAt`. Used as the anchor for every
   * un-timestamped message instead of `Date.now`, so rehydrating the SAME
   * old conversation twice (a reopen, or a reconnect catchup sweep) yields
   * the SAME result both times rather than jumping to "now" on each call.
   * Omitted (or unresolvable), this falls back to `Date.now` exactly as
   * before — the same fallback `buildPostSendState` uses unconditionally,
   * which is correct there: it runs immediately after a live send, so its
   * messages genuinely are fresh.
   */
  conversationUpdatedAt?: number,
): ChatMessage[] {
  const anchor = conversationUpdatedAt ?? Date.now();
  return backendMessages.map((message, index) => ({
    role: message.role,
    content: message.content,
    contentParts: message.contentParts as ChatMessage['contentParts'],
    model: message.model ?? message.metadata?.model ?? undefined,
    modelOptions: message.modelOptions ?? message.metadata?.modelOptions,
    turnId: message.turnId,
    sessionId: message.sessionId,
    answerEligible: message.answerEligible,
    provenance: message.provenance,
    timestamp:
      parseBackendTimestamp(message.timestamp) ??
      anchor -
        (backendMessages.length - 1 - index) *
          REHYDRATE_MESSAGE_ORDER_BACKOFF_MS,
  }));
}
