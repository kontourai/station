import type {
  PullRequestMergeInput,
  PullRequestMergeResult,
  PullRequestResult,
  PullRequestReviewInput,
  PullRequestReviewOutcome,
  PullRequestReviewSnapshot,
} from '@kontourai/station-contracts/pull-request-provider';
import { type ClientRequestOptions, getJson, mutateJson } from './http';

export interface PullRequestReviewTarget {
  provider: string;
  host: string;
  owner: string;
  repository: string;
  ref: string;
  project: string;
  thread?: string;
  workingDirectory?: string;
}
function path(apiBase: string, target: PullRequestReviewTarget) {
  const identity = [
    target.provider,
    target.host,
    target.owner,
    target.repository,
    target.ref,
  ];
  if (identity.some((value) => !value) || !target.project)
    throw Error('An exact pull request and project are required.');
  const query = new URLSearchParams({ project: target.project });
  if (target.thread) query.set('thread', target.thread);
  if (target.workingDirectory)
    query.set('workingDirectory', target.workingDirectory);
  return `${apiBase}/api/pull-requests/${identity.map(encodeURIComponent).join('/')}/review?${query}`;
}
async function read<T>(response: Response): Promise<PullRequestResult<T>> {
  const value = await response.json();
  if (
    !response.ok ||
    value?.success !== true ||
    typeof value.data?.available !== 'boolean'
  )
    throw Error(
      'Pull request review unavailable. Refresh to inspect current provider state.',
    );
  return value.data;
}
export async function getPullRequestReview(
  apiBase: string,
  target: PullRequestReviewTarget,
  options?: ClientRequestOptions,
): Promise<PullRequestResult<PullRequestReviewSnapshot>> {
  const result = await read<PullRequestReviewSnapshot>(
    await getJson(path(apiBase, target), options),
  );
  if (!result.available) return result;
  const snapshot = result.data;
  const pr = snapshot?.pullRequest;
  if (
    !pr ||
    pr.provider !== target.provider ||
    pr.host !== target.host ||
    pr.repository.owner !== target.owner ||
    pr.repository.name !== target.repository ||
    pr.ref !== target.ref ||
    !snapshot ||
    !/^[a-f0-9]{40,64}$/i.test(snapshot.headSha) ||
    !/^[a-f0-9]{40,64}$/i.test(snapshot.baseSha) ||
    !Array.isArray(snapshot.discussion) ||
    !snapshot.diff ||
    !['available', 'unavailable'].includes(snapshot.diff.state)
  )
    throw Error(
      'The provider returned a review for a different or incomplete target.',
    );
  return result;
}
export async function submitPullRequestReview(
  apiBase: string,
  target: PullRequestReviewTarget,
  input: PullRequestReviewInput,
  options?: ClientRequestOptions,
): Promise<PullRequestResult<PullRequestReviewOutcome>> {
  const result = await read<PullRequestReviewOutcome>(
    await mutateJson(path(apiBase, target), 'POST', options, input),
  );
  if (result.available) {
    const outcome = result.data;
    if (
      !outcome ||
      !['confirmed', 'refused', 'indeterminate'].includes(outcome.status) ||
      (outcome.status === 'confirmed' &&
        (!outcome.nativeId ||
          !outcome.actor ||
          (input.action === 'approve' &&
            outcome.headSha !== input.expectedHeadSha)))
    )
      throw Error(
        'The review acknowledgement could not be verified. Inspect the provider before trying again.',
      );
  }
  return result;
}

export async function mergeReviewedPullRequest(
  apiBase: string,
  target: PullRequestReviewTarget,
  input: PullRequestMergeInput & { expectedHeadSha: string },
  options?: ClientRequestOptions,
): Promise<PullRequestResult<PullRequestMergeResult>> {
  const result = await read<PullRequestMergeResult>(
    await mutateJson(
      path(apiBase, target).replace('/review?', '/merge?'),
      'POST',
      options,
      input,
    ),
  );
  if (
    result.available &&
    (!result.data ||
      !['merged', 'queued-auto-merge', 'refused', 'indeterminate'].includes(
        result.data.status,
      ))
  )
    throw Error(
      'The merge acknowledgement could not be verified. Inspect the provider before trying again.',
    );
  return result;
}
