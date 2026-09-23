import {
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
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

/**
 * Where a git read acts (#2412): the Project and the folder inside it. The
 * server refuses a folder outside the named Project, so a read without both
 * does not run.
 */
export interface GitReadLocation {
  projectSlug: string;
  /** The folder as the client names it; the server expands and confines it. */
  workingDir: string;
}

function gitReadQuery(location: GitReadLocation): string {
  return `projectSlug=${encodeURIComponent(location.projectSlug)}&path=${encodeURIComponent(location.workingDir)}`;
}

function isGitReadLocation(
  location: GitReadLocation | null | undefined,
): location is GitReadLocation {
  return !!location?.projectSlug && !!location.workingDir;
}

export function useGitStatusQuery(
  location: GitReadLocation | null | undefined,
  config?: QueryConfig<any>,
) {
  return useApiQuery<GitStatusResult | null>(
    ['git-status', location?.workingDir ?? ''],
    async () => {
      if (!isGitReadLocation(location)) {
        return null;
      }
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/api/coding/git/status?${gitReadQuery(location)}`,
      );
      const result = await response.json();
      if (!result.success) {
        return null;
      }
      return result.data;
    },
    {
      ...config,
      enabled: isGitReadLocation(location) && (config?.enabled ?? true),
      staleTime: config?.staleTime ?? 10_000,
    },
  );
}

export function useGitLogQuery(
  location: GitReadLocation | null | undefined,
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
    ['git-log', location?.workingDir ?? '', count],
    async () => {
      if (!isGitReadLocation(location)) {
        return [];
      }
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/api/coding/git/log?${gitReadQuery(location)}&count=${count}`,
      );
      const result = await response.json();
      if (!result.success) {
        return [];
      }
      return result.data;
    },
    {
      ...config,
      enabled: isGitReadLocation(location) && (config?.enabled ?? true),
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

/**
 * Every knowledge-document write refreshes the same listings: the document
 * list, the namespace tree and filtered listings. A write that refreshed only
 * the list left a created note out of the tree and a deleted one in it
 * (#2343). What a write does to a document's cached BODY differs by write,
 * and each mutation says so itself.
 */
function refreshKnowledgeListings(
  queryClient: QueryClient,
  projectSlug: string,
): void {
  for (const view of ['docs', 'tree', 'filtered']) {
    queryClient.invalidateQueries({
      queryKey: ['knowledge', view, projectSlug],
    });
  }
}

function knowledgeDocContentKey(projectSlug: string, docId: string) {
  return ['knowledge', 'doc-content', projectSlug, docId];
}

/**
 * A deleted document's body is gone. Drop its cache entry rather than
 * invalidating it, so no later reader is served the deleted text. A reader
 * still mounted on that document will fetch once more (and get a 404) on its
 * next render; callers stop reading a document they delete.
 */
function forgetKnowledgeDocBodies(
  queryClient: QueryClient,
  projectSlug: string,
  docIds: readonly string[],
): void {
  for (const docId of docIds) {
    queryClient.removeQueries({
      queryKey: knowledgeDocContentKey(projectSlug, docId),
    });
  }
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
    onSuccess: () => refreshKnowledgeListings(queryClient, projectSlug),
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
    onSuccess: (_data, docId) => {
      forgetKnowledgeDocBodies(queryClient, projectSlug, [docId]);
      refreshKnowledgeListings(queryClient, projectSlug);
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
    onSuccess: (_data, ids) => {
      forgetKnowledgeDocBodies(queryClient, projectSlug, ids);
      refreshKnowledgeListings(queryClient, projectSlug);
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
    onSuccess: (_data, { docId, content }) => {
      const key = knowledgeDocContentKey(projectSlug, docId);
      // Seed the body with what was just written before refetching it. A
      // reader that mounts while the refetch is in flight otherwise gets the
      // pre-edit body from the cache, and an editor that loads it saves the
      // next edit over a stale base.
      if (content !== undefined) queryClient.setQueryData(key, content);
      queryClient.invalidateQueries({ queryKey: key });
      refreshKnowledgeListings(queryClient, projectSlug);
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
