import type {
  DiffComment,
  DiffCommentCreateInput,
} from '@kontourai/station-contracts/diff-comment';
import { _getApiBase } from '../api';
import { type QueryConfig, useApiMutation, useApiQuery } from '../query-core';

// ── Inline diff review comments (project-scoped) ──────────────────────────

export type { DiffComment, DiffCommentCreateInput };

interface ApiResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export const diffCommentsQueryKey = (
  projectSlug: string | null | undefined,
) => ['diff-comments', projectSlug ?? ''];

async function fetchDiffComments(projectSlug: string): Promise<DiffComment[]> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(
    `${apiBase}/api/projects/${encodeURIComponent(projectSlug)}/diff-comments`,
  );
  const result = (await response.json()) as ApiResult<DiffComment[]>;
  if (!response.ok || !result.success || result.data === undefined) {
    throw new Error(apiErrorMessage(result, 'Failed to load diff comments'));
  }
  return result.data;
}

export function useDiffCommentsQuery(
  projectSlug: string | null | undefined,
  config?: QueryConfig<DiffComment[]>,
) {
  return useApiQuery<DiffComment[]>(
    diffCommentsQueryKey(projectSlug),
    () => fetchDiffComments(projectSlug as string),
    { ...config, enabled: !!projectSlug && (config?.enabled ?? true) },
  );
}

// ── Cross-project review feed (review queue) ───────────────────────────────

/** Namespaced under 'diff-comments' so a prefix invalidation refreshes both
 *  the aggregate feed and every project-scoped query in one shot. */
export const allDiffCommentsQueryKey = () => ['diff-comments', '__all__'];

async function fetchAllDiffComments(): Promise<DiffComment[]> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(`${apiBase}/api/diff-comments`);
  const result = (await response.json()) as ApiResult<DiffComment[]>;
  if (!response.ok || !result.success || result.data === undefined) {
    throw new Error(apiErrorMessage(result, 'Failed to load diff comments'));
  }
  return result.data;
}

export function useAllDiffCommentsQuery(config?: QueryConfig<DiffComment[]>) {
  return useApiQuery<DiffComment[]>(
    allDiffCommentsQueryKey(),
    fetchAllDiffComments,
    config,
  );
}

/** Resolve (delete) a comment from the cross-project queue, where each item
 *  carries its own projectId. Invalidates the whole 'diff-comments' tree. */
export function useResolveDiffCommentMutation() {
  return useApiMutation(
    ({ projectSlug, id }: { projectSlug: string; id: string }) =>
      deleteDiffComment(projectSlug, id),
    { invalidateKeys: [['diff-comments']] },
  );
}

export async function createDiffComment(
  projectSlug: string,
  input: Omit<DiffCommentCreateInput, 'projectId'>,
): Promise<DiffComment> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(
    `${apiBase}/api/projects/${encodeURIComponent(projectSlug)}/diff-comments`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
  const result = (await response.json()) as ApiResult<DiffComment>;
  if (!response.ok || !result.success || result.data === undefined) {
    throw new Error(apiErrorMessage(result, 'Failed to create diff comment'));
  }
  return result.data;
}

export async function deleteDiffComment(
  projectSlug: string,
  id: string,
): Promise<void> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(
    `${apiBase}/api/projects/${encodeURIComponent(projectSlug)}/diff-comments/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  );
  const result = (await response.json()) as ApiResult<never>;
  if (!response.ok || !result.success) {
    throw new Error(apiErrorMessage(result, 'Failed to delete diff comment'));
  }
}

export function useCreateDiffCommentMutation(projectSlug: string) {
  return useApiMutation(
    (input: Omit<DiffCommentCreateInput, 'projectId'>) =>
      createDiffComment(projectSlug, input),
    { invalidateKeys: [['diff-comments', projectSlug]] },
  );
}

export function useDeleteDiffCommentMutation(projectSlug: string) {
  return useApiMutation((id: string) => deleteDiffComment(projectSlug, id), {
    invalidateKeys: [['diff-comments', projectSlug]],
  });
}

import { apiErrorMessage } from '../api-core';
import { authenticatedFetch } from '../client/http';
