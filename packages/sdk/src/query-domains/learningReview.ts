import type {
  LearningReviewDetail,
  LearningReviewIntentInput,
  LearningReviewProposalInput,
  LearningReviewRevisionRef,
  LearningReviewSourceSelection,
} from '@kontourai/station-contracts/learning-review';
import { useQueryClient } from '@tanstack/react-query';
import type { ApiRequestScope } from '../client/http';
import { StationHttpError } from '../client/http';
import {
  applyProjectLearningIntent,
  fetchProjectLearning,
  fetchProjectLearningDetail,
  fetchProjectLearningEvidence,
  isLearningAccessRefusal,
  prepareProjectLearningSource,
  proposeProjectLearning,
} from '../client/learning-review';
import { useApiMutation, useApiQuery } from '../query-core';

export interface LearningReviewRequestScope extends ApiRequestScope {
  isCurrent(): boolean;
}

const key = (
  slug: string,
  projectId: string,
  authority: LearningReviewRequestScope,
) => [
  'learning-review',
  authority.apiBase,
  authority.authorityKey,
  projectId,
  slug,
];
function checkProject(
  detail: LearningReviewDetail,
  projectId: string,
): LearningReviewDetail {
  if (
    detail.state === 'available' &&
    (detail.projection.scope.kind !== 'project' ||
      detail.projection.scope.id !== projectId)
  )
    throw new StationHttpError(
      409,
      'The selected Project changed. Reopen learning review.',
      { code: 'learning_review_project_changed' },
    );
  return detail;
}
export function useProjectLearningQuery(
  slug: string,
  projectId: string,
  authority: LearningReviewRequestScope,
) {
  return useApiQuery(
    key(slug, projectId, authority),
    (signal) =>
      fetchProjectLearning(authority.apiBase, slug, {
        requestScope: authority,
        projectId,
        signal,
      }).then((index) => {
        if (index.state === 'available')
          index.items.forEach((item) => checkProject(item, projectId));
        return index;
      }),
    { enabled: authority.isCurrent(), retry: false, keepPreviousData: false },
  );
}
export function useProjectLearningDetailQuery(
  slug: string,
  projectId: string,
  id: string,
  compareId: string | undefined,
  authority: LearningReviewRequestScope,
) {
  return useApiQuery(
    [...key(slug, projectId, authority), id, compareId ?? ''],
    (signal) =>
      fetchProjectLearningDetail(authority.apiBase, slug, id, compareId, {
        requestScope: authority,
        projectId,
        signal,
      }).then((detail) => checkProject(detail, projectId)),
    {
      enabled: !!id && authority.isCurrent(),
      retry: false,
      keepPreviousData: false,
    },
  );
}
export function useProjectLearningIntentMutation(
  slug: string,
  projectId: string,
  authority: LearningReviewRequestScope,
) {
  const onError = useLearningMutationRefusal(slug, projectId, authority);
  return useApiMutation(
    (input: { id: string; intent: LearningReviewIntentInput }) =>
      applyProjectLearningIntent(
        authority.apiBase,
        slug,
        input.id,
        input.intent,
        { requestScope: authority, projectId },
      ),
    {
      invalidateKeys: [key(slug, projectId, authority)],
      onError,
      evictSettledVariables: true,
    },
  );
}
export function useProposeProjectLearningMutation(
  slug: string,
  projectId: string,
  authority: LearningReviewRequestScope,
) {
  const onError = useLearningMutationRefusal(slug, projectId, authority);
  return useApiMutation(
    (input: LearningReviewProposalInput) =>
      proposeProjectLearning(authority.apiBase, slug, input, {
        requestScope: authority,
        projectId,
      }),
    {
      invalidateKeys: [key(slug, projectId, authority)],
      onError,
      evictSettledVariables: true,
    },
  );
}

function useLearningMutationRefusal(
  slug: string,
  projectId: string,
  authority: LearningReviewRequestScope,
) {
  const client = useQueryClient();
  return (error: Error) => {
    if (!isLearningAccessRefusal(error)) return;
    const queryKey = key(slug, projectId, authority);
    void client.cancelQueries({ queryKey }).finally(() => {
      client.setQueriesData({ queryKey }, { state: 'restricted' });
      void client.invalidateQueries({ queryKey, refetchType: 'none' });
    });
  };
}

export function useProjectLearningEvidenceQuery(
  slug: string,
  projectId: string,
  id: string,
  reference: LearningReviewRevisionRef,
  authority: LearningReviewRequestScope,
) {
  return useApiQuery(
    [
      ...key(slug, projectId, authority),
      id,
      'evidence',
      reference.authority,
      reference.kind,
      reference.id,
      reference.revision,
    ],
    (signal) =>
      fetchProjectLearningEvidence(authority.apiBase, slug, id, reference, {
        requestScope: authority,
        projectId,
        signal,
      }),
    { enabled: authority.isCurrent(), retry: false, keepPreviousData: false },
  );
}

export function usePrepareLearningSourceQuery(
  slug: string,
  projectId: string,
  source: LearningReviewSourceSelection,
  authority: LearningReviewRequestScope,
  enabled = true,
) {
  return useApiQuery(
    [...key(slug, projectId, authority), 'source', JSON.stringify(source)],
    (signal) =>
      prepareProjectLearningSource(authority.apiBase, slug, source, {
        requestScope: authority,
        projectId,
        signal,
      }),
    {
      enabled: enabled && !!projectId && authority.isCurrent(),
      retry: false,
      keepPreviousData: false,
    },
  );
}
