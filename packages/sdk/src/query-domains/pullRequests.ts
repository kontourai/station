import type {
  PullRequest,
  PullRequestBranchMergeability,
  PullRequestClientContext,
  PullRequestCommentInput,
  PullRequestListQuery,
  PullRequestMergeInput,
  PullRequestMergeResult,
  PullRequestOpenInput,
  PullRequestResult,
} from '@kontourai/station-contracts/pull-request-provider';
import { _getApiBase } from '../api';
import { apiErrorMessage } from '../api-core';
import { authenticatedFetch } from '../client/http';
import { type QueryConfig, useApiMutation, useApiQuery } from '../query-core';

type Result<T> = { success: boolean; data?: T; error?: string };
export interface PullRequestResolvingContext {
  project: string;
  thread?: string;
  workingDirectory?: string;
}
export const pullRequestsQueryKey = (
  provider: string,
  host: string,
  repo: string,
  context?: PullRequestResolvingContext,
) => [
  'pull-requests',
  provider,
  host,
  repo,
  context?.thread ?? '',
  context?.workingDirectory ?? '',
];
export const pullRequestContextQueryKey = (
  project: string,
  thread?: string,
  workingDirectory?: string,
) => ['pull-request-context', project, thread ?? '', workingDirectory ?? ''];
/**
 * Keyed by project and repository, never by session: every row observing one
 * repository shares one cache entry (#2937).
 */
export const pullRequestMergeabilityQueryKey = (
  project: string,
  provider: string,
  host: string,
  repo: string,
) => ['pull-request-mergeability', project, provider, host, repo];
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const base = await _getApiBase();
  const r = await authenticatedFetch(`${base}/api/pull-requests/${path}`, init);
  const j = (await r.json()) as Result<T>;
  if (!r.ok || !j.success || j.data === undefined)
    throw new Error(apiErrorMessage(j, 'Pull request request failed'));
  return j.data;
}
function withContext(path: string, context: PullRequestResolvingContext) {
  const query = new URLSearchParams({ project: context.project });
  if (context.thread) query.set('thread', context.thread);
  if (context.workingDirectory)
    query.set('workingDirectory', context.workingDirectory);
  return `${path}?${query}`;
}
export function usePullRequestContextQuery(
  context: PullRequestResolvingContext,
  config?: QueryConfig<PullRequestClientContext>,
) {
  return useApiQuery(
    pullRequestContextQueryKey(
      context.project,
      context.thread,
      context.workingDirectory,
    ),
    () => request<PullRequestClientContext>(withContext('context', context)),
    {
      ...config,
      enabled: !!context.project && (config?.enabled ?? true),
    },
  );
}
export function usePullRequestsQuery(
  provider: string,
  host: string,
  owner: string,
  repo: string,
  context: PullRequestResolvingContext,
  query?: PullRequestListQuery,
  config?: QueryConfig<any>,
) {
  return useApiQuery(
    [
      ...pullRequestsQueryKey(provider, host, `${owner}/${repo}`, context),
      query?.state ?? 'ALL',
    ],
    () =>
      request<any>(
        withContext(
          `${encodeURIComponent(provider)}/${encodeURIComponent(host)}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
          context,
        ) +
          `${query?.state ? `&state=${encodeURIComponent(query.state)}` : ''}` +
          `${query?.limit ? `&limit=${query.limit}` : ''}`,
      ),
    {
      ...config,
      enabled:
        !!provider &&
        !!host &&
        !!owner &&
        !!repo &&
        !!context?.project &&
        (config?.enabled ?? true),
    },
  );
}
/**
 * The repository's open pull requests narrowed to source branch and
 * mergeability (#2937): a conflict indicator's read, which the server answers
 * without fetching bodies, commits, reviews or comments. It resolves the
 * checkout from the project alone, because the answer is repository-scoped.
 */
export function usePullRequestMergeabilityQuery(
  provider: string,
  host: string,
  owner: string,
  repo: string,
  project: string,
  config?: QueryConfig<PullRequestResult<PullRequestBranchMergeability[]>>,
) {
  return useApiQuery(
    pullRequestMergeabilityQueryKey(
      project,
      provider,
      host,
      `${owner}/${repo}`,
    ),
    () =>
      request<PullRequestResult<PullRequestBranchMergeability[]>>(
        withContext(
          `${encodeURIComponent(provider)}/${encodeURIComponent(host)}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/mergeability`,
          { project },
        ),
      ),
    {
      ...config,
      enabled:
        !!provider &&
        !!host &&
        !!owner &&
        !!repo &&
        !!project &&
        (config?.enabled ?? true),
    },
  );
}
export function usePullRequestQuery(
  provider: string,
  host: string,
  owner: string,
  repo: string,
  ref: string,
  context: PullRequestResolvingContext,
  config?: QueryConfig<any>,
) {
  return useApiQuery(
    [...pullRequestsQueryKey(provider, host, `${owner}/${repo}`), ref],
    () =>
      request<any>(
        withContext(
          `${encodeURIComponent(provider)}/${encodeURIComponent(host)}/${owner}/${repo}/${encodeURIComponent(ref)}`,
          context,
        ),
      ),
    {
      ...config,
      enabled:
        !!provider &&
        !!host &&
        !!owner &&
        !!repo &&
        !!ref &&
        !!context?.project &&
        (config?.enabled ?? true),
    },
  );
}
export function useOpenPullRequestMutation(
  provider: string,
  host: string,
  owner: string,
  repo: string,
  context: PullRequestResolvingContext,
) {
  return useApiMutation(
    (input: PullRequestOpenInput) =>
      request<PullRequest>(
        withContext(`${provider}/${host}/${owner}/${repo}/open`, context),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        },
      ),
    {
      invalidateKeys: [
        pullRequestsQueryKey(provider, host, `${owner}/${repo}`),
      ],
    },
  );
}
export function useCreatePullRequestCommentMutation(
  provider: string,
  host: string,
  owner: string,
  repo: string,
  ref: string,
  context: PullRequestResolvingContext,
) {
  return useApiMutation(
    (input: PullRequestCommentInput) =>
      request<any>(
        withContext(
          `${provider}/${host}/${owner}/${repo}/${ref}/comments`,
          context,
        ),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        },
      ),
    {
      invalidateKeys: [
        pullRequestsQueryKey(provider, host, `${owner}/${repo}`),
      ],
    },
  );
}
export function useApprovePullRequestMutation(
  provider: string,
  host: string,
  owner: string,
  repo: string,
  ref: string,
  context: PullRequestResolvingContext,
) {
  return useApiMutation(
    (input?: { body?: string }) =>
      request<any>(
        withContext(
          `${provider}/${host}/${owner}/${repo}/${ref}/approve`,
          context,
        ),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input ?? {}),
        },
      ),
    {
      invalidateKeys: [
        pullRequestsQueryKey(provider, host, `${owner}/${repo}`),
      ],
    },
  );
}
export function useMergePullRequestMutation(
  provider: string,
  host: string,
  owner: string,
  repo: string,
  ref: string,
  context: PullRequestResolvingContext,
) {
  return useApiMutation(
    (input: PullRequestMergeInput) =>
      request<PullRequestResult<PullRequestMergeResult>>(
        withContext(
          `${provider}/${host}/${owner}/${repo}/${ref}/merge`,
          context,
        ),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        },
      ),
    {
      invalidateKeys: [
        pullRequestsQueryKey(provider, host, `${owner}/${repo}`),
      ],
    },
  );
}
