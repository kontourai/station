import type { ConversationOpenResolution } from '@kontourai/station-contracts/orchestration';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { _getApiBase } from '../api';
import {
  acknowledgeConversation as acknowledgeConversationRaw,
  deleteConversation as deleteConversationRaw,
  forkConversation as forkConversationRaw,
  getConversationMessages,
  listAgentConversationPage,
  listAgentConversations,
  listConversationInventory,
} from '../client/conversations';
import {
  type MutationOptions,
  PERSISTED_QUERY_GC_TIME_MS,
  type QueryConfig,
  resolveApiBase,
  useCancelWhenInactive,
} from '../query-core';
import { conversationQueries } from '../queryFactories';
import { mapConversationMessages } from './chatRuntimeStream';
import type {
  ConversationListItem,
  ConversationLookup,
  ConversationMessage,
  ConversationSummary,
} from './chatRuntimeTypes';
import type { NormalizedSessionSummary } from './sessionSummaryNormalize';

export type {
  ConversationListItem,
  ConversationLookup,
  ConversationMessage,
  ConversationMessagePart,
  ConversationSummary,
} from './chatRuntimeTypes';

export interface MessageSearchResult {
  conversationId: string;
  messageId: string;
  /**
   * Present only for a match projected from another connected Station. This is
   * deliberately the local connection's stable source identity, not a remote
   * assertion about the current user's authority.
   */
  sourceInstanceId?: string;
  sourceInstanceName?: string;
  role: 'user' | 'assistant';
  excerpt: string;
  projectSlug?: string;
  engine?: string;
  agentSlug?: string;
}

/** An independently observed outcome for one Station in a federated search. */
export interface MessageSearchInstance {
  instanceId: string;
  instanceName: string;
  status:
    | 'available'
    | 'empty'
    | 'authentication_required'
    | 'timed_out'
    | 'refused'
    | 'unreachable'
    | 'deferred';
}

export interface MessageSearchResponse {
  matches: MessageSearchResult[];
  instances: MessageSearchInstance[];
  /** Connected Stations skipped by the fixed fan-out budget. */
  deferredInstanceCount: number;
}

/** Derived, discardable model output kept outside the conversation transcript. */
/** V2 contract; optional v1 fields keep old persisted reads representable. */
export type SessionSummary = NormalizedSessionSummary;

async function sessionSummaryRequest<T>(
  agentSlug: string,
  conversationId: string,
  method: 'GET' | 'POST' | 'DELETE',
  action?: 'dismiss' | 'show',
): Promise<T> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(
    `${apiBase}/agents/${encodeURIComponent(agentSlug)}/conversations/${encodeURIComponent(conversationId)}/summary${action ? `/${action}` : ''}`,
    { method },
  );
  const result = (await response.json()) as {
    success: boolean;
    data?: T;
    error?: string;
  };
  if (!response.ok || !result.success)
    throw new Error(apiErrorMessage(result, 'Session summary request failed'));
  return result.data as T;
}

export async function fetchSessionSummary(
  agentSlug: string,
  conversationId: string,
) {
  const [{ normalizeSessionSummary }, value] = await Promise.all([
    import('./sessionSummaryNormalize'),
    sessionSummaryRequest<unknown>(agentSlug, conversationId, 'GET'),
  ]);
  return normalizeSessionSummary(value);
}

export function useSessionSummaryQuery(
  agentSlug: string | undefined,
  conversationId: string | undefined,
  /** Canonical history/evidence revision, not merely the newest visible turn. */
  transcriptExtent?: string | number,
) {
  return useQuery({
    queryKey: ['session-summary', agentSlug, conversationId, transcriptExtent],
    queryFn: () => fetchSessionSummary(agentSlug!, conversationId!),
    enabled: Boolean(agentSlug && conversationId),
    staleTime: 0,
  });
}

/**
 * kontourai/station#3310: a stable mutation key so any surface can observe
 * in-flight/failed generation via `useMutationState` — the entry point (the
 * chat-settings menu) and the transcript's summary card are different
 * components with independent mutation instances.
 */
export const SESSION_SUMMARY_GENERATE_MUTATION_KEY = [
  'session-summary-generate',
] as const;

export function useGenerateSessionSummaryMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: SESSION_SUMMARY_GENERATE_MUTATION_KEY,
    mutationFn: ({
      agentSlug,
      conversationId,
    }: {
      agentSlug: string;
      conversationId: string;
    }) =>
      sessionSummaryRequest<SessionSummary>(agentSlug, conversationId, 'POST'),
    onSuccess: (_data, variables) =>
      queryClient.invalidateQueries({
        queryKey: [
          'session-summary',
          variables.agentSlug,
          variables.conversationId,
        ],
      }),
  });
}

export function useDismissSessionSummaryMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      agentSlug,
      conversationId,
    }: {
      agentSlug: string;
      conversationId: string;
    }) =>
      sessionSummaryRequest<void>(agentSlug, conversationId, 'POST', 'dismiss'),
    onSuccess: (_data, variables) =>
      queryClient.invalidateQueries({
        queryKey: [
          'session-summary',
          variables.agentSlug,
          variables.conversationId,
        ],
      }),
  });
}

/** Restores a dismissed derived summary without regenerating or deleting it. */
export function useShowSessionSummaryMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      agentSlug,
      conversationId,
    }: {
      agentSlug: string;
      conversationId: string;
    }) =>
      sessionSummaryRequest<void>(agentSlug, conversationId, 'POST', 'show'),
    onSuccess: (_data, variables) =>
      queryClient.invalidateQueries({
        queryKey: [
          'session-summary',
          variables.agentSlug,
          variables.conversationId,
        ],
      }),
  });
}

/** Separate destructive UI identity; it must never borrow dismiss state. */
export function useDeleteSessionSummaryMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ['session-summary-delete'] as const,
    mutationFn: ({
      agentSlug,
      conversationId,
    }: {
      agentSlug: string;
      conversationId: string;
    }) => sessionSummaryRequest<void>(agentSlug, conversationId, 'DELETE'),
    onSuccess: (_data, variables) =>
      queryClient.invalidateQueries({
        queryKey: [
          'session-summary',
          variables.agentSlug,
          variables.conversationId,
        ],
      }),
  });
}

/** Command-palette transcript search. The server owns ACL and indexing. */
export async function fetchMessageSearch(
  query: string,
  apiBase?: string,
  signal?: AbortSignal,
): Promise<MessageSearchResponse> {
  const resolvedApiBase = await resolveApiBase(apiBase);
  const response = await authenticatedFetch(
    `${resolvedApiBase}/api/conversations/search?query=${encodeURIComponent(query)}`,
    { signal },
  );
  const result = (await response.json()) as {
    success: boolean;
    data?: MessageSearchResult[];
    instances?: MessageSearchInstance[];
    deferredInstanceCount?: number;
    error?: string;
  };
  if (!response.ok || !result.success) {
    throw new Error(apiErrorMessage(result, 'Failed to search messages'));
  }
  return {
    matches: result.data ?? [],
    instances: result.instances ?? [],
    deferredInstanceCount: result.deferredInstanceCount ?? 0,
  };
}

export function useMessageSearchQuery(
  query: string,
  config?: QueryConfig<MessageSearchResponse>,
) {
  const normalized = query.trim();
  return useQuery({
    queryKey: ['message-search', normalized],
    queryFn: ({ signal }) => fetchMessageSearch(normalized, undefined, signal),
    enabled: normalized.length >= 2 && (config?.enabled ?? true),
    staleTime: 0,
    gcTime: config?.gcTime ?? PERSISTED_QUERY_GC_TIME_MS,
    retry: config?.retry,
  });
}

export async function fetchAgentConversations(
  agentSlug: string,
): Promise<ConversationSummary[]> {
  const apiBase = await _getApiBase();
  return listAgentConversations(apiBase, agentSlug) as Promise<
    ConversationSummary[]
  >;
}

export async function fetchAgentConversationPage(
  agentSlug: string,
  options?: { cursor?: string; limit?: number; signal?: AbortSignal },
) {
  const apiBase = await _getApiBase();
  return listAgentConversationPage(apiBase, agentSlug, options);
}

/**
 * `GET /api/conversations` — the global conversation-inventory endpoint
 * (S2 of #1302). Ships dark alongside `useConversationInventoryQuery` below:
 * no UI surface calls either yet.
 */
export async function fetchConversationInventory(
  apiBase?: string,
  options?: { cursor?: string; limit?: number; signal?: AbortSignal },
): Promise<{
  items: ConversationListItem[];
  hasMore: boolean;
  nextCursor?: string;
}> {
  const resolvedApiBase = await resolveApiBase(apiBase);
  // station#1778: the assertion below is over HTTP, not a validation — see
  // `normalizeRequestAnswerability`. Same version-skew surface as the
  // orchestration fetches.
  const page = (await listConversationInventory(resolvedApiBase, {
    limit: options?.limit ?? 100,
    ...(options?.cursor ? { cursor: options.cursor } : {}),
    ...(options?.signal ? { signal: options.signal } : {}),
  })) as {
    items: ConversationListItem[];
    hasMore: boolean;
    nextCursor?: string;
  };
  return {
    items: page.items.map(withNormalizedAnswerability),
    hasMore: page.hasMore,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
}

export async function acknowledgeConversation(
  conversationId: string,
  updatedAt: string,
): Promise<void> {
  const apiBase = await _getApiBase();
  await acknowledgeConversationRaw(apiBase, conversationId, updatedAt);
}

export async function renameConversation(
  agentSlug: string,
  conversationId: string,
  title: string,
): Promise<unknown> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(
    `${apiBase}/agents/${encodeURIComponent(agentSlug)}/conversations/${encodeURIComponent(conversationId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    },
  );
  const result = (await response.json()) as {
    success: boolean;
    data?: unknown;
    error?: string;
  };
  if (!result.success) {
    throw new Error(apiErrorMessage(result, 'Failed to rename conversation'));
  }
  return result.data;
}

export async function regenerateConversationTitle(
  agentSlug: string,
  conversationId: string,
  options?: { replaceManualTitle?: boolean },
): Promise<unknown> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(
    `${apiBase}/agents/${encodeURIComponent(agentSlug)}/conversations/${encodeURIComponent(conversationId)}/regenerate-title`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options ?? {}),
    },
  );
  const result = (await response.json()) as {
    success: boolean;
    data?: unknown;
    error?: string;
  };
  if (!result.success)
    throw new Error(
      apiErrorMessage(result, 'Failed to regenerate conversation title'),
    );
  return result.data;
}

export async function deleteConversation(
  agentSlug: string,
  conversationId: string,
): Promise<void> {
  const apiBase = await _getApiBase();
  await deleteConversationRaw(apiBase, agentSlug, conversationId);
}

export async function forkConversation(
  sourceAgent: string,
  sourceConversationId: string,
  targetAgent: string,
  options?: Parameters<typeof forkConversationRaw>[4],
) {
  return forkConversationRaw(
    await _getApiBase(),
    sourceAgent,
    sourceConversationId,
    targetAgent,
    options,
  );
}

export async function fetchConversationMessages(
  agentSlug: string,
  conversationId: string,
  toolMappings: Record<
    string,
    { server?: string; toolName?: string; originalName?: string }
  > = {},
): Promise<ConversationMessage[]> {
  const apiBase = await _getApiBase();
  const data = await getConversationMessages(
    apiBase,
    agentSlug,
    conversationId,
  );
  return mapConversationMessages(
    data as Parameters<typeof mapConversationMessages>[0],
    toolMappings,
  );
}

export async function fetchConversationById(
  conversationId: string,
  apiBase?: string,
): Promise<ConversationLookup | null> {
  const resolvedApiBase = await resolveApiBase(apiBase);
  const response = await authenticatedFetch(
    `${resolvedApiBase}/api/conversations/${encodeURIComponent(conversationId)}`,
  );
  const result = (await response.json()) as {
    success: boolean;
    data?: ConversationLookup;
    error?: string;
  };
  if (!result.success) {
    return null;
  }
  return result.data ?? null;
}

/**
 * Resolve an inventory selection before creating a local chat tab.  The
 * result is total; callers render read-only recovery from its status rather
 * than guessing a Session from the selected Agent's provider.
 */
export async function resolveConversationOpen(
  conversationId: string,
  apiBase?: string,
): Promise<ConversationOpenResolution | null> {
  const resolvedApiBase = await resolveApiBase(apiBase);
  const response = await authenticatedFetch(
    `${resolvedApiBase}/api/conversations/${encodeURIComponent(conversationId)}/open`,
  );
  const result = (await response.json()) as {
    success: boolean;
    data?: ConversationOpenResolution;
  };
  return result.success ? (result.data ?? null) : null;
}

export function useConversationsQuery(
  agentSlug: string | undefined,
  config?: QueryConfig<any>,
) {
  return useQuery({
    ...(agentSlug
      ? conversationQueries.list(agentSlug)
      : {
          queryKey: ['conversations'],
          queryFn: async () => [],
          staleTime: 0,
        }),
    enabled: !!agentSlug && (config?.enabled ?? true),
    staleTime: config?.staleTime,
    // station#1223: see PERSISTED_QUERY_GC_TIME_MS.
    gcTime: config?.gcTime ?? PERSISTED_QUERY_GC_TIME_MS,
  });
}

/**
 * S2 of #1302: query hook for the global conversation-inventory endpoint,
 * following the same `useApiQuery` + `queryFactories` shape as
 * `useOrchestrationSessionsQuery`. Ships dark — no view wires this up yet;
 * a later slice (S3 the ⌘O picker, S4 the history panel) is the first
 * consumer.
 */
export function useConversationInventoryQuery(
  config?: QueryConfig<ConversationListItem[]>,
) {
  const queryClient = useQueryClient();
  const queryKey = conversationQueries.inventory().queryKey;
  const enabled = config?.enabled ?? true;
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam, signal }) =>
      fetchConversationInventory(undefined, {
        ...(typeof pageParam === 'string' ? { cursor: pageParam } : {}),
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => (page.hasMore ? page.nextCursor : undefined),
    staleTime: config?.staleTime ?? conversationQueries.inventory().staleTime,
    gcTime:
      config?.gcTime ??
      queryClient.getQueryDefaults(queryKey)?.gcTime ??
      PERSISTED_QUERY_GC_TIME_MS,
    enabled,
    refetchInterval: config?.refetchInterval,
    retry: config?.retry,
    retryDelay: config?.retryDelay,
  });
  useCancelWhenInactive(queryKey, enabled, config?.cancelWhenInactive);
  return {
    ...query,
    data: query.data?.pages.flatMap((page) => page.items),
    hasMore: query.hasNextPage,
    loadingMore: query.isFetchingNextPage,
    loadMoreError: query.isFetchNextPageError,
    loadMore: () => query.fetchNextPage(),
  };
}

export function useAcknowledgeConversationMutation(
  options?: MutationOptions<
    void,
    { conversationId: string; updatedAt: string }
  >,
) {
  const queryClient = useQueryClient();
  return useMutation<
    void,
    Error,
    { conversationId: string; updatedAt: string }
  >({
    mutationFn: ({ conversationId, updatedAt }) =>
      acknowledgeConversation(conversationId, updatedAt),
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({
        queryKey: conversationQueries.inventory().queryKey,
      });
      options?.onSuccess?.(data, variables);
    },
    onError: (error, variables) => {
      options?.onError?.(error as Error, variables);
    },
  });
}

export function useRenameConversationMutation(
  options?: MutationOptions<
    unknown,
    { agentSlug: string; conversationId: string; title: string }
  >,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      agentSlug,
      conversationId,
      title,
    }: {
      agentSlug: string;
      conversationId: string;
      title: string;
    }) => renameConversation(agentSlug, conversationId, title),
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({
        queryKey: ['conversations', variables.agentSlug],
      });
      queryClient.invalidateQueries({
        queryKey: conversationQueries.inventory().queryKey,
      });
      options?.onSuccess?.(data, variables);
    },
    onError: (error, variables) => {
      options?.onError?.(error as Error, variables);
    },
  });
}

export function useRegenerateConversationTitleMutation(
  options?: MutationOptions<
    unknown,
    {
      agentSlug: string;
      conversationId: string;
      replaceManualTitle?: boolean;
    }
  >,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      agentSlug,
      conversationId,
      replaceManualTitle,
    }: {
      agentSlug: string;
      conversationId: string;
      replaceManualTitle?: boolean;
    }) =>
      regenerateConversationTitle(agentSlug, conversationId, {
        replaceManualTitle,
      }),
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({
        queryKey: ['conversations', variables.agentSlug],
      });
      queryClient.invalidateQueries({
        queryKey: conversationQueries.inventory().queryKey,
      });
      options?.onSuccess?.(data, variables);
    },
    onError: (error, variables) =>
      options?.onError?.(error as Error, variables),
  });
}

export function useDeleteConversationMutation(
  options?: MutationOptions<
    void,
    { agentSlug: string; conversationId: string }
  >,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      agentSlug,
      conversationId,
    }: {
      agentSlug: string;
      conversationId: string;
    }) => deleteConversation(agentSlug, conversationId),
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({
        queryKey: ['conversations', variables.agentSlug],
      });
      queryClient.invalidateQueries({
        queryKey: conversationQueries.inventory().queryKey,
      });
      queryClient.removeQueries({
        queryKey: ['messages', variables.agentSlug, variables.conversationId],
      });
      options?.onSuccess?.(data, variables);
    },
    onError: (error, variables) => {
      options?.onError?.(error as Error, variables);
    },
  });
}

import { withNormalizedAnswerability } from '@kontourai/station-contracts/orchestration';
import { apiErrorMessage } from '../api-core';
import { authenticatedFetch } from '../client/http';
