import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  _getApiBase,
  bulkDeleteKnowledgeDocs,
  deleteKnowledgeDoc,
  fetchKnowledgeDocContent,
  fetchKnowledgeStatus,
  fetchProjectConversations,
  scanKnowledgeDirectory,
  updateKnowledgeDoc,
  uploadKnowledge,
} from '../api';
import { type QueryConfig, useApiQuery } from '../query-core';
import { knowledgeQueries } from '../queryFactories';

export type GitStatusResult =
  | { isRepo: false }
  | {
      isRepo: true;
      branch: string;
      changes: string[];
      staged: number;
      unstaged: number;
      untracked: number;
      lastCommit: {
        sha: string;
        author: string;
        relativeTime: string;
        message: string;
      } | null;
      ahead: number;
      behind: number;
      /**
       * Whether this checkout has anywhere to push (#1536 G5). Three states,
       * never two: `unknown` is a read that could not answer, and a surface
       * that folded it into `absent` would disable Push on no evidence — the
       * distinction `checkout-remote-reader.ts` exists to keep. Optional only
       * because an older server does not send it, which reads as unknown.
       */
      remote?: 'present' | 'absent' | 'unknown';
      /**
       * The git repository root containing the queried path (symlink-resolved
       * via `git --show-toplevel`). Lets clients map an arbitrary file path to
       * its owning repo for multi-repo workspaces.
       */
      repoRoot?: string;
    };

export function useGitStatusQuery(
  workingDirectory: string | null | undefined,
  config?: QueryConfig<any>,
) {
  return useApiQuery<GitStatusResult | null>(
    ['git-status', workingDirectory ?? ''],
    async () => {
      if (!workingDirectory) {
        return null;
      }
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/api/coding/git/status?path=${encodeURIComponent(workingDirectory)}`,
      );
      const result = await response.json();
      if (!result.success) {
        return null;
      }
      return result.data;
    },
    {
      ...config,
      enabled: !!workingDirectory && (config?.enabled ?? true),
      staleTime: config?.staleTime ?? 10_000,
    },
  );
}

export function useGitLogQuery(
  workingDirectory: string | null | undefined,
  count = 5,
  config?: QueryConfig<any>,
) {
  return useApiQuery<
    Array<{
      sha: string;
      author: string;
      relativeTime: string;
      message: string;
    }>
  >(
    ['git-log', workingDirectory ?? '', count],
    async () => {
      if (!workingDirectory) {
        return [];
      }
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/api/coding/git/log?path=${encodeURIComponent(workingDirectory)}&count=${count}`,
      );
      const result = await response.json();
      if (!result.success) {
        return [];
      }
      return result.data;
    },
    {
      ...config,
      enabled: !!workingDirectory && (config?.enabled ?? true),
      staleTime: config?.staleTime ?? 30_000,
    },
  );
}

export function useKnowledgeNamespacesQuery(
  projectSlug: string,
  config?: QueryConfig<any>,
) {
  return useQuery({
    ...knowledgeQueries.namespaces(projectSlug),
    ...config,
    enabled: !!projectSlug && (config?.enabled ?? true),
  });
}

export function useKnowledgeDocsQuery(
  projectSlug: string,
  namespace?: string,
  config?: QueryConfig<any>,
) {
  return useQuery({
    ...knowledgeQueries.list(projectSlug, namespace),
    ...config,
    enabled: !!projectSlug && (config?.enabled ?? true),
  });
}

export function useKnowledgeSearchQuery(
  projectSlug: string,
  query: string,
  namespace?: string,
  config?: QueryConfig<any>,
) {
  return useQuery({
    ...knowledgeQueries.search(projectSlug, query, namespace),
    ...config,
    enabled: !!projectSlug && !!query && (config?.enabled ?? true),
  });
}

export function useKnowledgeSaveMutation(
  projectSlug: string,
  namespace?: string,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      filename,
      content,
      metadata,
    }: {
      filename: string;
      content: string;
      metadata?: Record<string, any>;
    }) => uploadKnowledge(projectSlug, filename, content, namespace, metadata),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['knowledge', 'docs', projectSlug],
      });
    },
  });
}

export function useKnowledgeDeleteMutation(
  projectSlug: string,
  namespace?: string,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (docId: string) =>
      deleteKnowledgeDoc(projectSlug, docId, namespace),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['knowledge', 'docs', projectSlug],
      });
    },
  });
}

export function useKnowledgeBulkDeleteMutation(
  projectSlug: string,
  namespace?: string,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (ids: string[]) =>
      bulkDeleteKnowledgeDocs(projectSlug, ids, namespace),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['knowledge', 'docs', projectSlug],
      });
    },
  });
}

export function useKnowledgeStatusQuery(
  projectSlug: string,
  config?: QueryConfig<any>,
) {
  return useApiQuery(
    ['knowledge', 'status', projectSlug],
    async () => fetchKnowledgeStatus(projectSlug),
    { ...config, enabled: !!projectSlug && (config?.enabled ?? true) },
  );
}

export function useKnowledgeDocContentQuery(
  projectSlug: string,
  docId: string | null,
  namespace?: string,
  config?: QueryConfig<string>,
) {
  return useApiQuery(
    ['knowledge', 'doc-content', projectSlug, docId ?? ''],
    async () => fetchKnowledgeDocContent(projectSlug, docId!, namespace),
    {
      ...config,
      enabled: !!projectSlug && !!docId && (config?.enabled ?? true),
    },
  );
}

export function useKnowledgeScanMutation(projectSlug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (options?: {
      extensions?: string[];
      includePatterns?: string[];
      excludePatterns?: string[];
    }) => scanKnowledgeDirectory(projectSlug, options),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['knowledge', 'docs', projectSlug],
      });
      queryClient.invalidateQueries({
        queryKey: ['knowledge', 'status', projectSlug],
      });
    },
  });
}

export function useKnowledgeTreeQuery(
  projectSlug: string,
  namespace: string,
  config?: QueryConfig<any>,
) {
  return useQuery({
    ...knowledgeQueries.tree(projectSlug, namespace),
    ...config,
    enabled: !!projectSlug && !!namespace && (config?.enabled ?? true),
  });
}

export function useKnowledgeFilteredQuery(
  projectSlug: string,
  namespace: string,
  filters: Record<string, any>,
  config?: QueryConfig<any>,
) {
  return useQuery({
    ...knowledgeQueries.filtered(projectSlug, namespace, filters),
    ...config,
    enabled: !!projectSlug && !!namespace && (config?.enabled ?? true),
  });
}

export function useKnowledgeUpdateMutation(
  projectSlug: string,
  namespace?: string,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      docId,
      content,
      metadata,
    }: {
      docId: string;
      content?: string;
      metadata?: Record<string, any>;
    }) =>
      updateKnowledgeDoc(projectSlug, docId, { content, metadata }, namespace),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['knowledge', 'docs', projectSlug],
      });
      queryClient.invalidateQueries({
        queryKey: ['knowledge', 'tree', projectSlug],
      });
      queryClient.invalidateQueries({
        queryKey: ['knowledge', 'filtered', projectSlug],
      });
    },
  });
}

export function useProjectConversationsQuery(
  projectSlug: string,
  limit = 10,
  config?: QueryConfig<any>,
) {
  return useApiQuery(
    ['project-conversations', projectSlug],
    async () => fetchProjectConversations(projectSlug, limit),
    { ...config, enabled: !!projectSlug && (config?.enabled ?? true) },
  );
}

import { authenticatedFetch } from '../client/http';
