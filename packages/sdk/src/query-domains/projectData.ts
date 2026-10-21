import type {
  KnowledgeDocumentMeta,
  KnowledgeNamespaceConfig,
  KnowledgeTreeNode,
} from '@kontourai/station-contracts/knowledge';
import {
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  _getApiBase,
  apiErrorMessage,
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

/** A single git branch as returned by `GET /api/coding/git/branches`. */
export interface GitBranch {
  name: string;
  sha: string;
  /** Committer date, relative (`2 days ago`), as git formats it. */
  date: string;
  current: boolean;
}

/** A discovered git repository as returned by `GET /api/coding/repos`. */
export interface DiscoveredRepo {
  /** Absolute, symlink-resolved repository root. */
  root: string;
  /** Display name (the repository directory name). */
  name: string;
  /** Path of the repository relative to the workspace (`.` for itself). */
  relativePath: string;
  /**
   * Current branch. `''` for a detached HEAD, and for a repository whose
   * `.git` is not the Project's own (the server lists it but reads nothing).
   */
  branch: string;
}

/** Result of `GET /api/coding/repos`. */
export interface ReposResult {
  workspace: string;
  /** True when the workspace directory is itself a git repository root. */
  workspaceIsRepo: boolean;
  repos: DiscoveredRepo[];
}

/** Server answer to a branch checkout: the branch HEAD now names. */
export interface GitCheckoutResult {
  branch: string;
}

/** Server answer to a commit. */
export interface GitCommitResult {
  sha: string;
}

/** Server answer to a push: git's output and the remote it pushed to. */
export interface GitPushResult {
  output: string;
  /**
   * The remote git pushed to. Absent from Stations released before SDK 0.8.0,
   * which answered with `output` alone.
   */
  remote?: string;
}

/**
 * List the branches of a folder in a Project (#2412). Same location and
 * admission as {@link useGitStatusQuery}. A `success: false` envelope becomes
 * `[]`, which does not establish a repository without branches.
 */
export function useGitBranchesQuery(
  location: GitReadLocation | null | undefined,
  config?: QueryConfig<GitBranch[]>,
) {
  return useApiQuery<GitBranch[]>(
    ['git-branches', location?.workingDir ?? ''],
    async () => {
      if (!isGitReadLocation(location)) return [];
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/api/coding/git/branches?${gitReadQuery(location)}`,
      );
      const result = (await response.json()) as GitEnvelope<GitBranch[]>;
      if (!result.success) return [];
      return result.data ?? [];
    },
    {
      ...config,
      enabled: isGitReadLocation(location) && (config?.enabled ?? true),
      staleTime: config?.staleTime ?? 10_000,
    },
  );
}

/**
 * Where repository discovery looks: a folder, and the Project it belongs to
 * when there is one. `projectSlug` is optional, unlike {@link GitReadLocation},
 * because the New Project form asks about a folder that is not a Project yet.
 */
export interface ReposLocation {
  projectSlug?: string;
  /** The folder as the client names it; the server expands and confines it. */
  workingDir: string;
}

/**
 * Discover the git repositories under a folder via `GET /api/coding/repos`,
 * including a folder that is not itself a repository but holds several.
 *
 * #2412: with a `projectSlug` the server refuses a folder outside that
 * Project. Without one only the operator in person gets an answer; anyone
 * else gets none. A `success: false` envelope becomes an empty result, so
 * "no repos" is not proof the folder holds none.
 */
export function useReposQuery(
  location: ReposLocation | null | undefined,
  config?: QueryConfig<ReposResult>,
) {
  const workspace = location?.workingDir || null;
  const projectSlug = location?.projectSlug || null;
  return useApiQuery<ReposResult>(
    ['coding-repos', projectSlug ?? '', workspace ?? ''],
    async () => {
      const empty: ReposResult = {
        workspace: workspace ?? '',
        workspaceIsRepo: false,
        repos: [],
      };
      if (!workspace) return empty;
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/api/coding/repos?${
          projectSlug ? `projectSlug=${encodeURIComponent(projectSlug)}&` : ''
        }path=${encodeURIComponent(workspace)}`,
      );
      const result = (await response.json()) as GitEnvelope<ReposResult>;
      if (!result.success || !result.data) return empty;
      return result.data;
    },
    {
      ...config,
      enabled: !!workspace && (config?.enabled ?? true),
      staleTime: config?.staleTime ?? 30_000,
    },
  );
}

interface GitEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * POST a git write to a Project's folder; a refusal rejects with the server's
 * own message. A location missing its Project or folder is refused here,
 * before any request: there is nothing for the server to act on.
 */
async function postGitWrite<T>(
  route: 'checkout' | 'commit' | 'push',
  location: GitReadLocation | null | undefined,
  body: Record<string, unknown>,
): Promise<T> {
  if (!isGitReadLocation(location)) {
    throw new Error('Choose a Project folder before running git');
  }
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(
    `${apiBase}/api/coding/git/${route}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // The location is the hook's, never a variable's to override.
      body: JSON.stringify({
        ...body,
        projectSlug: location.projectSlug,
        path: location.workingDir,
      }),
    },
  );
  const result = (await response.json()) as GitEnvelope<T>;
  if (!response.ok || !result.success) {
    throw new Error(
      apiErrorMessage(result, `Request failed (${response.status})`),
    );
  }
  return result.data as T;
}

/**
 * Refresh the git reads of one folder (status, branches, log) after a write,
 * so every surface reading that folder shows the new repository state.
 */
function useRefreshGitReads(location: GitReadLocation | null | undefined) {
  const queryClient = useQueryClient();
  const workingDir = location?.workingDir ?? '';
  return () => {
    for (const read of ['git-status', 'git-branches', 'git-log']) {
      queryClient.invalidateQueries({ queryKey: [read, workingDir] });
    }
  };
}

/** Check out (or, with `create`, create) a branch in a Project's folder (#2412). */
export function useGitCheckoutMutation(
  location: GitReadLocation | null | undefined,
) {
  const refresh = useRefreshGitReads(location);
  return useMutation({
    mutationFn: ({ branch, create }: { branch: string; create?: boolean }) =>
      postGitWrite<GitCheckoutResult>('checkout', location, { branch, create }),
    onSuccess: refresh,
  });
}

/**
 * Commit all changes with a message.
 *
 * #2363: commit and push are the Station operator's act; the server refuses
 * any other caller with 403. They run in the Project's own folder, which the
 * server resolves from `projectSlug`; `workingDir` only names which
 * repository inside it (a multi-repo workspace). A refusal (a secret-looking
 * file, repository config Station will not run git with, a remote it will
 * not push to) rejects the mutation with the server's message, which names
 * the files or keys.
 */
export function useGitCommitMutation(
  location: GitReadLocation | null | undefined,
) {
  const refresh = useRefreshGitReads(location);
  return useMutation({
    mutationFn: ({ message }: { message: string }) =>
      postGitWrite<GitCommitResult>('commit', location, { message }),
    onSuccess: refresh,
  });
}

/** Push the current branch to a remote. See {@link useGitCommitMutation}. */
export function useGitPushMutation(
  location: GitReadLocation | null | undefined,
) {
  const refresh = useRefreshGitReads(location);
  return useMutation({
    mutationFn: (
      args: { remote?: string; branch?: string; setUpstream?: boolean } = {},
    ) => postGitWrite<GitPushResult>('push', location, args),
    onSuccess: refresh,
  });
}

export function useKnowledgeNamespacesQuery(
  projectSlug: string,
  config?: QueryConfig<KnowledgeNamespaceConfig[]>,
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
  config?: QueryConfig<KnowledgeDocumentMeta[]>,
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
  config?: QueryConfig<KnowledgeTreeNode>,
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
  config?: QueryConfig<KnowledgeDocumentMeta[]>,
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
