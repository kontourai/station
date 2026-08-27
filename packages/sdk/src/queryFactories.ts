/**
 * Query Factories - Single source of truth for query definitions
 * Used by both hooks and imperative fetching (e.g., slash commands)
 */

import { parseConversationStatsResponse } from '@kontourai/station-contracts/runtime';
import {
  _getApiBase,
  fetchKnowledgeDocs,
  fetchKnowledgeFiltered,
  fetchKnowledgeNamespaces,
  fetchKnowledgeTree,
  searchKnowledge,
} from './api';
import { apiErrorMessage } from './api-core';
import type { ApiRequestScope } from './client/http';
import { authenticatedFetch } from './client/http';
/**
 * A tools read that failed, with the HTTP status kept. `activating` is the
 * one case a caller must treat as "not yet" rather than "no".
 */
export class AgentToolsRequestError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'AgentToolsRequestError';
    this.status = status;
  }
  get activating(): boolean {
    return this.status === 503;
  }
}

/** True for the transient "this Agent is still activating" tools failure. */
export function isAgentToolsActivatingError(error: unknown): boolean {
  return error instanceof AgentToolsRequestError && error.activating;
}

export const agentQueries = {
  /**
   * Get agent details
   */
  agent: (agentSlug: string) => ({
    queryKey: ['agent', agentSlug],
    queryFn: async () => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/api/agents/${encodeURIComponent(agentSlug)}`,
      );
      if (response.status === 404) throw new Error('Agent not found');
      if (!response.ok) throw new Error('Failed to fetch agent');
      const result = await response.json();
      if (!result.success) throw new Error(result.error);
      return result.data;
    },
    staleTime: 5 * 60 * 1000,
  }),

  /**
   * Get agent tools
   */
  tools: (agentSlug: string) => ({
    queryKey: ['agent-tools', agentSlug],
    queryFn: async () => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/agents/${agentSlug}/tools`,
      );
      if (!response.ok) {
        // Carry the STATUS, not just a sentence. A newly created Agent
        // answers 503 while its activation is still owed — a transient state
        // a caller should retry — where 409 means it genuinely is not active.
        // Collapsing both into one opaque Error left the only two responses
        // that need different handling indistinguishable.
        //
        // And keep the SERVER's sentence when it sent one: a 409 for an
        // abandoned activation carries the actual failure reason, which is
        // the only thing a user can act on. Discarding it for the generic
        // "Failed to fetch tools" is how a diagnosable failure becomes a
        // shrug.
        const detail = await response
          .json()
          .then((body: { error?: unknown }) =>
            typeof body?.error === 'string' ? body.error : undefined,
          )
          .catch(() => undefined);
        throw new AgentToolsRequestError(
          detail ??
            (response.status === 503
              ? 'Agent tools are not available yet; it is still activating.'
              : 'Failed to fetch tools'),
          response.status,
        );
      }
      const result = await response.json();
      if (!result.success) throw new Error(result.error);
      return result.data;
    },
    staleTime: 5 * 60 * 1000,
  }),

  /**
   * Get conversation stats
   */
  stats: (agentSlug: string, conversationId: string) => ({
    queryKey: ['stats', agentSlug, conversationId],
    queryFn: async () => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/agents/${agentSlug}/conversations/${conversationId}/stats`,
      );
      if (!response.ok) throw new Error('Failed to fetch stats');
      const result = await response.json();
      if (!result.success) throw new Error(result.error);
      const stats = parseConversationStatsResponse(result.data);
      if (!stats) throw new Error('Invalid conversation stats response');
      return stats;
    },
    staleTime: 30 * 1000, // 30 seconds
  }),
};

export const conversationQueries = {
  list: (agentSlug: string) => ({
    queryKey: ['conversations', agentSlug],
    queryFn: async () => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/agents/${encodeURIComponent(agentSlug)}/conversations`,
      );
      if (!response.ok) throw new Error('Failed to fetch conversations');
      const result = await response.json();
      if (!result.success) throw new Error(result.error);
      return Array.isArray(result.data)
        ? result.data
        : (result.data?.items ?? []);
    },
    staleTime: 0,
  }),
  /**
   * S2 of #1302: the global conversation-inventory endpoint's query key.
   * staleTime mirrors `orchestrationQueries.sessions()` — the surfaces this
   * feeds (inbox/history/picker, later slices) are read at the same
   * cadence as the session list they fold in.
   */
  inventory: () => ({
    queryKey: ['conversation-inventory'],
    staleTime: 10 * 1000,
  }),
};

export const orchestrationQueries = {
  providers: () => ({
    queryKey: ['orchestration-providers'],
    queryFn: async () => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/api/orchestration/providers`,
      );
      const result = await response.json();
      if (!response.ok || !result.success) {
        throw new Error(apiErrorMessage(result, `HTTP ${response.status}`));
      }
      return result.data;
    },
    staleTime: 30 * 1000,
  }),
  sessions: () => ({
    queryKey: ['orchestration-sessions'],
    staleTime: 10 * 1000,
  }),
  loadedSessions: () => ({
    queryKey: ['orchestration-sessions-loaded'],
    staleTime: 10 * 1000,
  }),
  sessionBoard: (projectSlug: string) => ({
    queryKey: ['orchestration-session-board', projectSlug],
    staleTime: 10 * 1000,
  }),
  session: (threadId: string) => ({
    queryKey: ['orchestration-session', threadId],
    staleTime: 10 * 1000,
  }),
  contextBoundary: (conversationId: string, idempotencyKey: string) => ({
    queryKey: [
      'orchestration-context-boundary',
      conversationId,
      idempotencyKey,
    ],
    staleTime: 2_000,
  }),
  commandReceipts: (threadId?: string) => ({
    queryKey: ['orchestration-command-receipts', threadId ?? 'all'],
    staleTime: 10 * 1000,
  }),
  commandReceipt: (commandId: string) => ({
    queryKey: ['orchestration-command-receipt', commandId],
    staleTime: 10 * 1000,
  }),
  terminalProcesses: () => ({
    queryKey: ['orchestration-terminal-processes'],
    staleTime: 10 * 1000,
  }),
  terminalProcess: (sessionId: string) => ({
    queryKey: ['orchestration-terminal-process', sessionId],
    staleTime: 10 * 1000,
  }),
};

export const taskQueries = {
  list: (projectId?: string, requestScope?: ApiRequestScope) => ({
    queryKey: requestScope
      ? [
          'tasks',
          projectId ?? 'all',
          requestScope.apiBase,
          requestScope.authorityKey,
        ]
      : ['tasks', projectId ?? 'all'],
    staleTime: 10 * 1000,
  }),
  task: (taskId: string) => ({
    queryKey: ['task', taskId],
    staleTime: 10 * 1000,
  }),
  graph: (taskId: string) => ({
    queryKey: ['task-graph', taskId],
    staleTime: 10 * 1000,
  }),
  turnReferences: (taskId: string) => ({
    queryKey: ['task-turn-references', taskId],
    staleTime: 10 * 1000,
  }),
  userInputReferences: (taskId: string) => ({
    queryKey: ['task-user-input-references', taskId],
    staleTime: 10 * 1000,
  }),
  sessionRelations: (sessionId: string) => ({
    queryKey: ['session-relations', sessionId],
    staleTime: 10 * 1000,
  }),
  claim: (taskId: string) => ({
    queryKey: ['task-claim', taskId],
    staleTime: 10 * 1000,
  }),
};

export const projectTaskRoomQueries = {
  discovery: (taskId: string) => ({
    queryKey: ['project-task-room', taskId, 'discovery'],
    staleTime: 10_000,
  }),
  history: (taskId: string) => ({
    queryKey: ['project-task-room', taskId, 'history'],
    staleTime: 0,
  }),
  document: (taskId: string) => ({
    queryKey: ['project-task-room', taskId, 'document'],
    staleTime: 0,
  }),
};

export const liveActivityQueries = {
  current: () => ({
    queryKey: ['live-activity'],
    staleTime: 10_000,
  }),
};

export const knowledgeQueries = {
  namespaces: (projectSlug: string) => ({
    queryKey: ['knowledge', 'namespaces', projectSlug],
    queryFn: async () => fetchKnowledgeNamespaces(projectSlug),
    staleTime: 5 * 60 * 1000,
  }),

  list: (projectSlug: string, namespace?: string) => ({
    queryKey: ['knowledge', 'docs', projectSlug, namespace ?? 'all'],
    queryFn: async () => fetchKnowledgeDocs(projectSlug, namespace),
    staleTime: 2 * 60 * 1000,
  }),

  search: (
    projectSlug: string,
    query: string,
    namespace?: string,
    topK?: number,
  ) => ({
    queryKey: [
      'knowledge',
      'search',
      projectSlug,
      query,
      namespace ?? 'all',
      topK,
    ],
    queryFn: async () => searchKnowledge(projectSlug, query, namespace, topK),
    staleTime: 60 * 1000,
  }),

  tree: (projectSlug: string, namespace: string) => ({
    queryKey: ['knowledge', 'tree', projectSlug, namespace],
    queryFn: async () => fetchKnowledgeTree(projectSlug, namespace),
    staleTime: 2 * 60 * 1000,
  }),

  filtered: (
    projectSlug: string,
    namespace: string,
    filters: Record<string, any>,
  ) => ({
    queryKey: ['knowledge', 'filtered', projectSlug, namespace, filters],
    queryFn: async () =>
      fetchKnowledgeFiltered(projectSlug, namespace, filters),
    staleTime: 2 * 60 * 1000,
  }),
};
