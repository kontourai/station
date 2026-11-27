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
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { _getApiBase } from '../api';
import { apiErrorMessage } from '../api-core';
import { authenticatedFetch } from '../client/http';
import {
  PERSISTED_QUERY_GC_TIME_MS,
  type QueryConfig,
  useApiMutation,
  useApiQuery,
} from '../query-core';
import { taskQueries } from '../queryFactories';

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
type CheckoutListState = 'OPEN' | 'MERGED' | 'CLOSED' | 'ALL';

export function usePullRequestContextQuery(
  context: PullRequestResolvingContext,
  config?: QueryConfig<PullRequestClientContext> & {
    list?: CheckoutListState;
  },
) {
  const state = config?.list;
  const key = pullRequestContextQueryKey(
    context.project,
    context.thread,
    context.workingDirectory,
  );
  const path = withContext('context', context);
  const client = useQueryClient();
  const listKey = state
    ? ['checkout-pull-requests', state, ...key.slice(1)]
    : key;
  const query = useApiQuery(
    listKey,
    async (signal) => {
      const answer = await request<PullRequestClientContext>(
        state ? `${path}&list=${state}` : path,
        { signal },
      );
      if (
        state &&
        !signal?.aborted &&
        answer.available &&
        client.getQueryState(key)?.fetchStatus !== 'fetching'
      ) {
        const { pullRequests: _pullRequests, ...identity } = answer;
        client.setQueryData(key, identity);
      }
      return answer;
    },
    {
      ...(state === 'OPEN' ? { gcTime: PERSISTED_QUERY_GC_TIME_MS } : {}),
      ...config,
      enabled: !!context.project && (config?.enabled ?? true),
    },
  );
  return {
    ...query,
    isLastKnown:
      !!state && client.getQueryState(listKey)?.dataUpdateCount === 0,
  };
}
/** Additional checkout list pages stay in memory for this list session. */
export function useCheckoutPullRequestPages(
  context: PullRequestResolvingContext,
  state: CheckoutListState,
  cursors: readonly string[],
  checkoutIdentity?: string,
) {
  const scopeKey = pullRequestContextQueryKey(
    context.project,
    context.thread,
    context.workingDirectory,
  ).slice(1);
  return useQueries({
    queries: cursors.map((cursor) => ({
      queryKey: [
        'checkout-pull-request-page',
        ...scopeKey,
        state,
        checkoutIdentity ?? '',
        cursor,
      ],
      queryFn: ({ signal }) =>
        request<PullRequestClientContext>(
          `${withContext('context', context)}&list=${state}&cursor=${encodeURIComponent(cursor)}`,
          { signal },
        ),
      staleTime: 20_000,
    })),
  });
}
export function usePullRequestsQuery(
  provider: string,
  host: string,
  owner: string,
  repo: string,
  context: PullRequestResolvingContext,
  query?: PullRequestListQuery,
  config?: QueryConfig<PullRequestResult<PullRequest[]>>,
) {
  return useApiQuery(
    [
      ...pullRequestsQueryKey(provider, host, `${owner}/${repo}`, context),
      query?.state ?? 'ALL',
    ],
    () =>
      request<PullRequestResult<PullRequest[]>>(
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
        ['checkout-pull-requests'],
        ['checkout-pull-request-page', context.project],
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
        ['checkout-pull-requests'],
        ['checkout-pull-request-page', context.project],
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
        ['checkout-pull-requests'],
        ['checkout-pull-request-page', context.project],
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
        ['checkout-pull-requests'],
        ['checkout-pull-request-page', context.project],
        // A merge moves a Task board card; the server cleared its own
        // status cache on the write, so this refetch reads the forge. Every
        // Project's facts: the merge route does not name one.
        taskQueries.pullRequestFacts('').queryKey.slice(0, 1),
      ],
    },
  );
}
