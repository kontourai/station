import type {
  LearningReviewDetail,
  LearningReviewIntentInput,
  LearningReviewProposalInput,
  LearningReviewRevisionRef,
  LearningReviewSourceSelection,
} from '@kontourai/station-contracts/learning-review';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect } from 'react';
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
  const query = useApiQuery(
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
    { enabled: authority.isCurrent(), retry: false },
  );
  useLearningReadRefusal(query, slug, projectId, authority);
  return query;
}
export function useProjectLearningDetailQuery(
  slug: string,
  projectId: string,
  id: string,
  compareId: string | undefined,
  authority: LearningReviewRequestScope,
) {
  const query = useApiQuery(
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
    },
  );
  useLearningReadRefusal(query, slug, projectId, authority);
  return query;
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

function useClearLearningScope(
  slug: string,
  projectId: string,
  authority: LearningReviewRequestScope,
) {
  const client = useQueryClient();
  return useCallback(() => {
    const queryKey = key(slug, projectId, authority);
    void client.cancelQueries({ queryKey }).finally(() => {
      client.setQueriesData({ queryKey }, { state: 'restricted' });
      void client.invalidateQueries({ queryKey, refetchType: 'none' });
    });
  }, [client, slug, projectId, authority]);
}

function useLearningMutationRefusal(
  slug: string,
  projectId: string,
  authority: LearningReviewRequestScope,
) {
  const clear = useClearLearningScope(slug, projectId, authority);
  return useCallback(
    (error: Error) => {
      if (isLearningAccessRefusal(error)) clear();
    },
    [clear],
  );
}

function useLearningReadRefusal(
  query: { error: Error | null; data: unknown; isFetching: boolean },
  slug: string,
  projectId: string,
  authority: LearningReviewRequestScope,
) {
  const client = useQueryClient();
  const clear = useClearLearningScope(slug, projectId, authority);
  const restricted =
    isLearningAccessRefusal(query.error) ||
    (!query.isFetching &&
      query.data !== null &&
      typeof query.data === 'object' &&
      'state' in query.data &&
      query.data.state === 'restricted');
  useEffect(() => {
    if (!restricted) return;
    const protectedData = client
      .getQueriesData({ queryKey: key(slug, projectId, authority) })
      .some(
        ([, data]) =>
          data !== null &&
          typeof data === 'object' &&
          'state' in data &&
          data.state === 'available',
      );
    if (protectedData) clear();
  }, [restricted, client, slug, projectId, authority, clear]);
}

export function useProjectLearningEvidenceQuery(
  slug: string,
  projectId: string,
  id: string,
  reference: LearningReviewRevisionRef,
  authority: LearningReviewRequestScope,
) {
  const query = useApiQuery(
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
    { enabled: authority.isCurrent(), retry: false },
  );
  useLearningReadRefusal(query, slug, projectId, authority);
  return query;
}

export function usePrepareLearningSourceQuery(
  slug: string,
  projectId: string,
  source: LearningReviewSourceSelection,
  authority: LearningReviewRequestScope,
  enabled = true,
) {
  const query = useApiQuery(
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
    },
  );
  useLearningReadRefusal(query, slug, projectId, authority);
  return query;
}
