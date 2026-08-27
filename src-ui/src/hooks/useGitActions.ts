import { authenticatedFetch } from '@kontourai/station-sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApiBase } from '../contexts/ApiBaseContext';

/** A single git branch as returned by `GET /api/coding/git/branches`. */
export interface GitBranch {
  name: string;
  sha: string;
  date: string;
  current: boolean;
}

/** A discovered git repo as returned by `GET /api/coding/repos`. */
export interface DiscoveredRepo {
  /** Absolute, symlink-resolved repository root. */
  root: string;
  /** Display name (typically the repo directory name). */
  name: string;
  /** Path of the repo relative to the workspace. */
  relativePath: string;
  /** Current branch of the repo. */
  branch: string;
}

/** Result of discovering git repos under a workspace. */
export interface ReposResult {
  workspace: string;
  /** True when the workspace directory is itself a git repo root. */
  workspaceIsRepo: boolean;
  repos: DiscoveredRepo[];
}

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
}

async function postJson<T>(
  url: string,
  body: Record<string, unknown>,
): Promise<T> {
  const response = await authenticatedFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as ApiEnvelope<T>;
  if (!response.ok || !result.success) {
    throw new Error(result.error || `Request failed (${response.status})`);
  }
  return result.data as T;
}

/** Query key for the git-status query owned by the SDK's `useGitStatusQuery`. */
function gitStatusKey(workingDirectory: string) {
  return ['git-status', workingDirectory];
}

/** List branches for a working directory. */
export function useGitBranchesQuery(
  workingDirectory: string | null | undefined,
) {
  const { apiBase, credentialState } = useApiBase();
  return useQuery({
    queryKey: ['git-branches', workingDirectory ?? '', credentialState],
    queryFn: async (): Promise<GitBranch[]> => {
      if (!workingDirectory) return [];
      const response = await authenticatedFetch(
        `${apiBase}/api/coding/git/branches?path=${encodeURIComponent(
          workingDirectory,
        )}`,
      );
      const result = (await response.json()) as ApiEnvelope<GitBranch[]>;
      if (!result.success) return [];
      return result.data ?? [];
    },
    enabled: !!workingDirectory,
    staleTime: 10_000,
  });
}

/**
 * Discover all git repos under a workspace via `GET /api/coding/repos`. Handles
 * a workspace that is not itself a repo but contains several nested repos.
 */
export function useReposQuery(
  workspace: string | null | undefined,
  options: { enabled?: boolean } = {},
) {
  const { apiBase, credentialState } = useApiBase();
  return useQuery({
    queryKey: ['coding-repos', workspace ?? '', credentialState],
    queryFn: async (): Promise<ReposResult> => {
      const empty: ReposResult = {
        workspace: workspace ?? '',
        workspaceIsRepo: false,
        repos: [],
      };
      if (!workspace) return empty;
      const response = await authenticatedFetch(
        `${apiBase}/api/coding/repos?path=${encodeURIComponent(workspace)}`,
      );
      const result = (await response.json()) as ApiEnvelope<ReposResult>;
      if (!result.success || !result.data) return empty;
      return result.data;
    },
    enabled: !!workspace && (options.enabled ?? true),
    staleTime: 30_000,
  });
}

/**
 * Invalidate the git surfaces (status + branches) after a mutation so the
 * toolbar reflects the new repository state.
 */
function useInvalidateGit(workingDirectory: string) {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: gitStatusKey(workingDirectory) });
    queryClient.invalidateQueries({
      queryKey: ['git-branches', workingDirectory],
    });
    queryClient.invalidateQueries({ queryKey: ['git-log', workingDirectory] });
  };
}

/** Checkout (or create) a branch. */
export function useGitCheckoutMutation(workingDirectory: string) {
  const { apiBase } = useApiBase();
  const invalidate = useInvalidateGit(workingDirectory);
  return useMutation({
    mutationFn: ({ branch, create }: { branch: string; create?: boolean }) =>
      postJson<{ branch: string }>(`${apiBase}/api/coding/git/checkout`, {
        path: workingDirectory,
        branch,
        create,
      }),
    onSuccess: invalidate,
  });
}

/** Commit all changes with a message. */
export function useGitCommitMutation(workingDirectory: string) {
  const { apiBase } = useApiBase();
  const invalidate = useInvalidateGit(workingDirectory);
  return useMutation({
    mutationFn: ({ message }: { message: string }) =>
      postJson<{ sha: string }>(`${apiBase}/api/coding/git/commit`, {
        path: workingDirectory,
        message,
      }),
    onSuccess: invalidate,
  });
}

/** Push the current branch to a remote. */
export function useGitPushMutation(workingDirectory: string) {
  const { apiBase } = useApiBase();
  const invalidate = useInvalidateGit(workingDirectory);
  return useMutation({
    mutationFn: (
      args: { remote?: string; branch?: string; setUpstream?: boolean } = {},
    ) =>
      postJson<{ output: string }>(`${apiBase}/api/coding/git/push`, {
        path: workingDirectory,
        ...args,
      }),
    onSuccess: invalidate,
  });
}
