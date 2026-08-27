import type {
  PullRequest,
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
