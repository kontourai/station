import type { LearningReviewDetail, LearningReviewIntentInput, LearningReviewProposalInput } from '@kontourai/station-contracts/learning-review';
import { StationHttpError } from '../client/http';
import type { ApiRequestScope } from '../client/http';
import { applyProjectLearningIntent, fetchProjectLearning, fetchProjectLearningDetail, proposeProjectLearning } from '../client/learning-review';
import { useApiMutation, useApiQuery } from '../query-core';

export interface LearningReviewRequestScope extends ApiRequestScope { isCurrent(): boolean }

const key = (slug: string, projectId: string, authority: LearningReviewRequestScope) => ['learning-review', authority.apiBase, authority.authorityKey, projectId, slug];
function checkProject(detail: LearningReviewDetail, projectId: string): LearningReviewDetail {
  if (detail.state === 'available' && (detail.projection.scope.kind !== 'project' || detail.projection.scope.id !== projectId))
    throw new StationHttpError(409, 'The selected Project changed. Reopen learning review.', { code: 'learning_review_project_changed' });
  return detail;
}
export function useProjectLearningQuery(slug: string, projectId: string, authority: LearningReviewRequestScope) {
  return useApiQuery(key(slug, projectId, authority), signal => fetchProjectLearning(authority.apiBase, slug, { requestScope: authority, projectId, signal }).then(index => { if (index.state === 'available') index.items.forEach(item => checkProject(item, projectId)); return index; }),
    { enabled: authority.isCurrent(), retry: false, keepPreviousData: false });
}
export function useProjectLearningDetailQuery(slug: string, projectId: string, id: string, compareId: string | undefined, authority: LearningReviewRequestScope) {
  return useApiQuery([...key(slug, projectId, authority), id, compareId ?? ''], signal =>
    fetchProjectLearningDetail(authority.apiBase, slug, id, compareId, { requestScope: authority, projectId, signal }).then(detail => checkProject(detail, projectId)),
    { enabled: !!id && authority.isCurrent(), retry: false, keepPreviousData: false });
}
export function useProjectLearningIntentMutation(slug: string, projectId: string, authority: LearningReviewRequestScope) {
  return useApiMutation((input: { id: string; intent: LearningReviewIntentInput }) =>
    applyProjectLearningIntent(authority.apiBase, slug, input.id, input.intent, { requestScope: authority, projectId }),
    { invalidateKeys: [key(slug, projectId, authority)] });
}
export function useProposeProjectLearningMutation(slug: string, projectId: string, authority: LearningReviewRequestScope) {
  return useApiMutation((input: LearningReviewProposalInput) =>
    proposeProjectLearning(authority.apiBase, slug, input, { requestScope: authority, projectId }),
    { invalidateKeys: [key(slug, projectId, authority)] });
}
