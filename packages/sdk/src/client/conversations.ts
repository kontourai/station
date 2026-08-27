/**
 * Canonical agent-conversation fetchers (#167 Wave 1): list, get-messages,
 * delete. Shared by the SDK's `chatRuntimeConversations.ts` (thin wrappers),
 * `packages/cli`'s `agents conversations`/`agents messages` verbs, and
 * `station-control-agent-tools.ts`'s `list_conversations`/
 * `get_conversation_messages`/`delete_conversation` tools.
 *
 * `renameConversation` and `fetchConversationById` are intentionally left
 * out of this module — the audit's triplication table does not name them as
 * duplicated (rename has no CLI/station-control leg; `fetchConversationById`
 * targets the distinct `/api/conversations/:id` global-lookup route, not
 * this `/agents/:slug/conversations[...]` family).
 */

import { apiErrorMessage } from './api-error-message';
import {
  type ClientRequestOptions,
  getJson,
  mutateJson,
  StationHttpError,
} from './http';

interface ConversationEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/** Indexed transcript result returned by `/api/conversations/search`. */
export interface ConversationMessageSearchResult {
  conversationId: string;
  messageId: string;
  role: 'user' | 'assistant';
  excerpt: string;
  projectSlug?: string;
  engine?: string;
  agentSlug?: string;
}

/**
 * `GET /api/conversations/search` — bounded, server-authorized transcript
 * search. This client-layer form is also used for protected peer reads over
 * an SSH tunnel; its caller supplies the remote peer bearer in `opts`.
 */
export async function searchConversationMessages(
  apiBase: string,
  query: string,
  opts?: ClientRequestOptions,
): Promise<ConversationMessageSearchResult[]> {
  const response = await getJson(
    `${apiBase}/api/conversations/search?query=${encodeURIComponent(query)}`,
    opts,
  );
  let result: ConversationEnvelope<ConversationMessageSearchResult[]> | null =
    null;
  try {
    result = (await response.json()) as ConversationEnvelope<
      ConversationMessageSearchResult[]
    >;
  } catch {
    throw new Error(`Conversation search API error: ${response.status}`);
  }
  if (!response.ok || !result.success) {
    const message = apiErrorMessage(result, 'Failed to search messages');
    if (!response.ok) throw new StationHttpError(response.status, message);
    throw new Error(message);
  }
  return result.data ?? [];
}

export interface ConversationInventoryPage<T = unknown> {
  items: T[];
  hasMore: boolean;
  nextCursor?: string;
}

export interface ConversationInventoryOptions extends ClientRequestOptions {
  cursor?: string;
  limit?: number;
}

export interface ForkConversationResult {
  conversationId: string;
  seed: string;
  branchPointTurnId?: string;
  sourceSessionId?: string;
  continuation: 'native' | 'replay-seed';
  disclosure?: string;
  idempotent: boolean;
}

export interface ForkConversationOptions extends ClientRequestOptions {
  branchPointTurnId?: string;
  targetProjectSlug?: string;
  idempotencyKey?: string;
}

export async function forkConversation(
  apiBase: string,
  sourceAgent: string,
  sourceConversationId: string,
  targetAgent: string,
  opts?: ForkConversationOptions,
): Promise<ForkConversationResult> {
  const response = await mutateJson(
    `${apiBase}/agents/${encodeURIComponent(sourceAgent)}/conversations/${encodeURIComponent(sourceConversationId)}/fork`,
    'POST',
    opts,
    {
      targetAgent,
      ...(opts?.branchPointTurnId
        ? { branchPointTurnId: opts.branchPointTurnId }
        : {}),
      ...(opts?.targetProjectSlug
        ? { targetProjectSlug: opts.targetProjectSlug }
        : {}),
      ...(opts?.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
    },
  );
  const result =
    (await response.json()) as ConversationEnvelope<ForkConversationResult>;
  if (!result.success || !result.data)
    throw new Error(apiErrorMessage(result, 'Failed to fork conversation'));
  return result.data;
}

/**
 * `GET /agents/:slug/conversations` — list an agent's conversations. Used
 * by the SDK's `fetchAgentConversations` (thin wrapper, exact original error
 * message preserved) and the CLI's `agents conversations` verb.
 */
export async function listAgentConversations(
  apiBase: string,
  agentSlug: string,
  opts?: ConversationInventoryOptions,
): Promise<unknown[]> {
  return (await listAgentConversationPage(apiBase, agentSlug, opts)).items;
}

export async function listAgentConversationPage(
  apiBase: string,
  agentSlug: string,
  opts?: ConversationInventoryOptions,
): Promise<ConversationInventoryPage> {
  const params = new URLSearchParams();
  if (opts?.cursor) params.set('cursor', opts.cursor);
  if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
  const query = params.size ? `?${params.toString()}` : '';
  const response = await getJson(
    `${apiBase}/agents/${encodeURIComponent(agentSlug)}/conversations${query}`,
    opts,
  );
  const result = (await response.json()) as ConversationEnvelope<
    ConversationInventoryPage | unknown[]
  >;
  if (!result.success) {
    throw new Error(apiErrorMessage(result, 'Failed to fetch conversations'));
  }
  if (Array.isArray(result.data)) {
    return { items: result.data, hasMore: false };
  }
  return result.data ?? { items: [], hasMore: false };
}

/**
 * `GET /agents/:slug/conversations/:id/messages` — raw (untransformed)
 * message list. The SDK's `fetchConversationMessages` thin wrapper applies
 * `mapConversationMessages(...)` on top of this fetcher's return value —
 * that mapping stays in `chatRuntimeConversations.ts`, not here, since it is
 * UI-message-shaping logic with no CLI/station-control equivalent.
 */
export async function getConversationMessages(
  apiBase: string,
  agentSlug: string,
  conversationId: string,
  opts?: ClientRequestOptions,
): Promise<unknown[]> {
  const response = await getJson(
    `${apiBase}/agents/${encodeURIComponent(agentSlug)}/conversations/${encodeURIComponent(conversationId)}/messages`,
    opts,
  );
  const result = (await response.json()) as ConversationEnvelope<unknown[]>;
  if (!result.success) {
    throw new Error(
      apiErrorMessage(result, 'Failed to fetch conversation messages'),
    );
  }
  return result.data ?? [];
}

/**
 * `DELETE /agents/:slug/conversations/:id`. The CLI has no verb for this
 * today (per the audit, `#165`-adjacent needed-P3) — only the SDK and
 * station-control legs of this triplication are deduped here.
 */
export async function deleteConversation(
  apiBase: string,
  agentSlug: string,
  conversationId: string,
  opts?: ClientRequestOptions,
): Promise<void> {
  const response = await mutateJson(
    `${apiBase}/agents/${encodeURIComponent(agentSlug)}/conversations/${encodeURIComponent(conversationId)}`,
    'DELETE',
    opts,
  );
  const result = (await response.json()) as ConversationEnvelope<never>;
  if (!result.success) {
    throw new Error(apiErrorMessage(result, 'Failed to delete conversation'));
  }
}

/**
 * `GET /api/conversations` — the global conversation-inventory endpoint
 * (S2 of #1302: conversation-surface consolidation). Folds the
 * orchestration session projection (every agent) and every registered
 * memory adapter's file-store conversations into one recency-capped,
 * deduped list. Ships dark: no query domain hook consumes this yet — a
 * later slice (S3/S4 of #1302) rewrites the ⌘O picker and history panel
 * over it.
 */
export async function listConversationInventory(
  apiBase: string,
  options?: ConversationInventoryOptions,
): Promise<ConversationInventoryPage> {
  const params = new URLSearchParams();
  if (options?.cursor) params.set('cursor', options.cursor);
  if (options?.limit !== undefined) params.set('limit', String(options.limit));
  const query = params.size ? `?${params.toString()}` : '';
  const response = await getJson(
    `${apiBase}/api/conversations${query}`,
    options,
  );
  const result =
    (await response.json()) as ConversationEnvelope<ConversationInventoryPage>;
  if (!result.success) {
    throw new Error(
      apiErrorMessage(result, 'Failed to fetch conversation inventory'),
    );
  }
  return result.data ?? { items: [], hasMore: false };
}

/**
 * Marks the exact version of a globally-addressable conversation as opened.
 * `updatedAt` must be the value returned by the inventory, never a client
 * wall-clock timestamp, so a later turn becomes unseen again deterministically.
 */
export async function acknowledgeConversation(
  apiBase: string,
  conversationId: string,
  updatedAt: string,
  opts?: ClientRequestOptions,
): Promise<void> {
  const response = await mutateJson(
    `${apiBase}/api/conversations/${encodeURIComponent(conversationId)}/acknowledgement`,
    'POST',
    opts,
    { updatedAt },
  );
  const result = (await response.json()) as ConversationEnvelope<never>;
  if (!result.success) {
    throw new Error(
      apiErrorMessage(result, 'Failed to acknowledge conversation'),
    );
  }
}
