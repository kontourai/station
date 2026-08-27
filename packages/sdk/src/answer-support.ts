import type {
  TaskAnswerSupportAssociation,
  TaskAnswerSupportMutationInput,
  TaskAnswerSupportRemoveInput,
  TaskAnswerSupportReplaceInput,
} from '@kontourai/station-contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import {
  type AnswerSupportBundle,
  type AnswerSupportClaim,
  AnswerSupportRequestError,
  attachAnswerSupport,
  listAnswerSupportBundles,
  listAnswerSupportClaims,
  removeAnswerSupport,
  replaceAnswerSupport,
} from './client/answer-support';
import { type QueryConfig, resolveApiBase, useApiQuery } from './query-core';
import {
  fetchTaskTurnReferences,
  type TaskTurnReferenceProjection,
} from './query-domains/taskGraph';
import { taskQueries } from './queryFactories';

export type { AnswerSupportBundle, AnswerSupportClaim };
export {
  attachAnswerSupport,
  listAnswerSupportBundles,
  listAnswerSupportClaims,
  removeAnswerSupport,
  replaceAnswerSupport,
};

export const answerSupportQueries = {
  cards: (taskId: string) => taskQueries.turnReferences(taskId),
  bundles: (taskId: string, referenceId: string) => ({
    queryKey: ['answer-support', taskId, referenceId, 'bundles'],
    staleTime: 10_000,
  }),
  claims: (taskId: string, referenceId: string, bundleId: string) => ({
    queryKey: [
      'answer-support',
      taskId,
      referenceId,
      'bundles',
      bundleId,
      'claims',
    ],
    staleTime: 10_000,
  }),
};

export async function fetchAnswerSupportBundles(input: {
  taskId: string;
  referenceId: string;
  apiBase?: string;
}): Promise<AnswerSupportBundle[]> {
  return listAnswerSupportBundles(
    await resolveApiBase(input.apiBase),
    input.taskId,
    input.referenceId,
  );
}

export async function fetchAnswerSupportClaims(input: {
  taskId: string;
  referenceId: string;
  bundleId: string;
  apiBase?: string;
}): Promise<AnswerSupportClaim[]> {
  return listAnswerSupportClaims(
    await resolveApiBase(input.apiBase),
    input.taskId,
    input.referenceId,
    input.bundleId,
  );
}

/** Reopens the server-authorized answer cards; no Surface meaning is derived here. */
export async function fetchAnswerSupportCards(
  taskId: string,
  apiBase?: string,
): Promise<TaskTurnReferenceProjection[]> {
  return fetchTaskTurnReferences(taskId, apiBase);
}

export async function createAnswerSupport(
  input: TaskAnswerSupportMutationInput & {
    taskId: string;
    referenceId: string;
    apiBase?: string;
  },
): Promise<TaskAnswerSupportAssociation> {
  const { taskId, referenceId, apiBase, ...body } = input;
  return attachAnswerSupport(
    await resolveApiBase(apiBase),
    taskId,
    referenceId,
    body,
  );
}

export async function updateAnswerSupport(
  input: TaskAnswerSupportReplaceInput & {
    taskId: string;
    referenceId: string;
    apiBase?: string;
  },
): Promise<TaskAnswerSupportAssociation> {
  const { taskId, referenceId, apiBase, ...body } = input;
  return replaceAnswerSupport(
    await resolveApiBase(apiBase),
    taskId,
    referenceId,
    body,
  );
}

export async function deleteAnswerSupport(
  input: TaskAnswerSupportRemoveInput & {
    taskId: string;
    referenceId: string;
    apiBase?: string;
  },
): Promise<void> {
  const { taskId, referenceId, apiBase, ...body } = input;
  await removeAnswerSupport(
    await resolveApiBase(apiBase),
    taskId,
    referenceId,
    body,
  );
}

type ProtectedQuery = ReturnType<typeof useApiQuery>;

/**
 * The route reauthorizes every read. Until this observer has a new successful
 * answer, stale selections and cards must not be rendered; after a refusal we
 * also evict the entry so another consumer cannot recover protected detail.
 */
function isLostAnswerSupportAuthority(error: unknown): boolean {
  if (error instanceof AnswerSupportRequestError) {
    return [401, 403, 404, 503].includes(error.status);
  }
  return (
    error instanceof Error &&
    /answer support|assistant answer/i.test(error.message)
  );
}

function revokeAnswerSupportScope(
  client: ReturnType<typeof useQueryClient>,
  taskId: string,
): void {
  const cards = answerSupportQueries.cards(taskId).queryKey;
  // A failed authorized read proves no reference under this Task is safe to
  // retain. A narrow reference prefix leaves sibling selectors/cards visible
  // to already-mounted observers during an authority transition.
  const supportScope = ['answer-support', taskId];
  void client.cancelQueries({ queryKey: cards, exact: true });
  void client.cancelQueries({ queryKey: supportScope });
  client.removeQueries({ queryKey: cards, exact: true });
  client.removeQueries({ queryKey: supportScope });
}

function useWithheldProtectedQuery<T extends ProtectedQuery>(
  query: T,
  revoke: () => void,
): T {
  const denied =
    query.isFetchedAfterMount &&
    query.status === 'error' &&
    isLostAnswerSupportAuthority(query.error);
  useEffect(() => {
    if (denied) revoke();
  }, [denied, revoke]);
  return {
    ...query,
    data:
      query.isFetchedAfterMount &&
      query.status === 'success' &&
      !query.isFetching
        ? query.data
        : undefined,
    isLoading:
      !query.isFetchedAfterMount || query.isLoading || query.isFetching,
  } as T;
}

function useProtectedAnswerSupportQuery<T>(input: {
  taskId: string;
  referenceId?: string;
  queryKey: (string | number)[];
  queryFn: () => Promise<T>;
  config: QueryConfig<T>;
}) {
  const client = useQueryClient();
  const revoke = () => revokeAnswerSupportScope(client, input.taskId);
  const query = useApiQuery(
    input.queryKey,
    async () => {
      try {
        return await input.queryFn();
      } catch (error) {
        if (isLostAnswerSupportAuthority(error)) revoke();
        throw error;
      }
    },
    input.config,
  );
  return useWithheldProtectedQuery(query, revoke);
}

export function useAnswerSupportCardsQuery(
  taskId: string,
  config?: QueryConfig<TaskTurnReferenceProjection[]>,
) {
  const query = answerSupportQueries.cards(taskId);
  return useProtectedAnswerSupportQuery({
    taskId,
    queryKey: query.queryKey,
    queryFn: () => fetchAnswerSupportCards(taskId),
    config: {
      staleTime: config?.staleTime ?? query.staleTime,
      gcTime: config?.gcTime,
      enabled: config?.enabled ?? taskId.length > 0,
      refetchOnMount: config?.refetchOnMount ?? 'always',
    },
  });
}

export function useAnswerSupportBundlesQuery(
  taskId: string,
  referenceId: string,
  config?: QueryConfig<AnswerSupportBundle[]>,
) {
  const query = answerSupportQueries.bundles(taskId, referenceId);
  return useProtectedAnswerSupportQuery({
    taskId,
    referenceId,
    queryKey: query.queryKey,
    queryFn: () => fetchAnswerSupportBundles({ taskId, referenceId }),
    config: {
      staleTime: config?.staleTime ?? query.staleTime,
      gcTime: config?.gcTime,
      enabled: config?.enabled ?? (taskId.length > 0 && referenceId.length > 0),
      refetchOnMount: config?.refetchOnMount ?? 'always',
    },
  });
}

export function useAnswerSupportClaimsQuery(
  taskId: string,
  referenceId: string,
  bundleId: string,
  config?: QueryConfig<AnswerSupportClaim[]>,
) {
  const query = answerSupportQueries.claims(taskId, referenceId, bundleId);
  return useProtectedAnswerSupportQuery({
    taskId,
    referenceId,
    queryKey: query.queryKey,
    queryFn: () => fetchAnswerSupportClaims({ taskId, referenceId, bundleId }),
    config: {
      staleTime: config?.staleTime ?? query.staleTime,
      gcTime: config?.gcTime,
      enabled:
        config?.enabled ??
        (taskId.length > 0 && referenceId.length > 0 && bundleId.length > 0),
      refetchOnMount: config?.refetchOnMount ?? 'always',
    },
  });
}

function invalidateAnswerSupport(
  client: ReturnType<typeof useQueryClient>,
  taskId: string,
) {
  client.invalidateQueries({
    queryKey: answerSupportQueries.cards(taskId).queryKey,
  });
  client.invalidateQueries({
    queryKey: ['answer-support', taskId],
  });
}

function refreshAnswerSupportAfterConflict(
  client: ReturnType<typeof useQueryClient>,
  taskId: string,
): void {
  invalidateAnswerSupport(client, taskId);
}

export function useCreateAnswerSupportMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: createAnswerSupport,
    onSuccess: (_data, input) => invalidateAnswerSupport(client, input.taskId),
    onError: (error, input) => {
      if (isLostAnswerSupportAuthority(error))
        revokeAnswerSupportScope(client, input.taskId);
      else if (
        error instanceof AnswerSupportRequestError &&
        error.status === 409
      )
        refreshAnswerSupportAfterConflict(client, input.taskId);
    },
  });
}

export function useReplaceAnswerSupportMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: updateAnswerSupport,
    onSuccess: (_data, input) => invalidateAnswerSupport(client, input.taskId),
    onError: (error, input) => {
      if (isLostAnswerSupportAuthority(error))
        revokeAnswerSupportScope(client, input.taskId);
      else if (
        error instanceof AnswerSupportRequestError &&
        error.status === 409
      )
        refreshAnswerSupportAfterConflict(client, input.taskId);
    },
  });
}

export function useRemoveAnswerSupportMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: deleteAnswerSupport,
    onSuccess: (_data, input) => invalidateAnswerSupport(client, input.taskId),
    onError: (error, input) => {
      if (isLostAnswerSupportAuthority(error))
        revokeAnswerSupportScope(client, input.taskId);
      else if (
        error instanceof AnswerSupportRequestError &&
        error.status === 409
      )
        refreshAnswerSupportAfterConflict(client, input.taskId);
    },
  });
}
