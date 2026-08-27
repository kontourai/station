/** Protected Task tool-result transport and query surface. */
export * from './client/task-tool-results';

import {
  type MutateOptions,
  type UseMutationResult,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { useMemo } from 'react';
import {
  type AttachTaskToolResultReferenceInput,
  attachTaskToolResultReference,
  getSessionToolResult,
  getTaskToolResultReferences,
  type TaskToolResultProjection,
  TaskToolResultRequestError,
} from './client/task-tool-results';
import {
  type ApiRequestScope,
  isApiRequestScope,
  type MutationOptions,
  type QueryConfig,
  resolveApiBase,
  useApiQuery,
} from './query-core';
import { taskQueries } from './queryFactories';
import { taskBasisQueries } from './task-basis';

export type { AttachTaskToolResultReferenceInput, TaskToolResultProjection };

export const taskToolResultQueries = {
  session: (
    sessionId: string,
    eventId: string,
    requestScope?: ApiRequestScope,
  ) => ({
    queryKey: requestScope
      ? [
          'session-tool-result',
          sessionId,
          eventId,
          requestScope.apiBase,
          requestScope.authorityKey,
        ]
      : ['session-tool-result', sessionId, eventId],
    staleTime: 10 * 1000,
  }),
  references: (taskId: string, requestScope?: ApiRequestScope) => ({
    queryKey: requestScope
      ? [
          'task-tool-result-references',
          taskId,
          requestScope.apiBase,
          requestScope.authorityKey,
        ]
      : ['task-tool-result-references', taskId],
    staleTime: 10 * 1000,
  }),
};

export type TaskToolResultQueryConfig<T> = QueryConfig<T> & {
  /** Captured host authority; new native Basis callers must provide it. */
  requestScope?: ApiRequestScope;
};

function lostAuthority(error: unknown): error is TaskToolResultRequestError {
  // Every failure of this protected transport is intentionally indistinct to
  // consumers. A bad envelope and a network miss must revoke cached content
  // just as a 401/403/404/503 does.
  return error instanceof TaskToolResultRequestError;
}

function revokeKeys(
  client: ReturnType<typeof useQueryClient>,
  keys: readonly (readonly (string | number | object)[])[],
) {
  // A mounted observer can retain its prior result after removeQueries(). Put
  // a harmless tombstone in place first, then stop late work and evict it.
  for (const queryKey of keys)
    client.setQueriesData({ queryKey, exact: true }, null);
  for (const queryKey of keys) {
    void client.cancelQueries({ queryKey, exact: true });
    client.removeQueries({ queryKey, exact: true });
  }
}

function revokeTaskToolResultScope(
  client: ReturnType<typeof useQueryClient>,
  taskId: string,
  requestScope?: ApiRequestScope,
  keepReferences = false,
) {
  const kept = taskToolResultQueries.references(taskId, requestScope).queryKey;
  const basis = taskBasisQueries.scope(taskId, requestScope);
  // Keep the revocation deliberately task-local: another task may retain the
  // same result under a separately authorized relation.
  if (!keepReferences)
    client.setQueriesData({ queryKey: kept, exact: true }, null);
  client.setQueriesData({ queryKey: basis }, null);
  if (!keepReferences)
    void client.cancelQueries({ queryKey: kept, exact: true });
  void client.cancelQueries({ queryKey: basis });
  if (!keepReferences) client.removeQueries({ queryKey: kept, exact: true });
  client.removeQueries({ queryKey: basis });
  // These legacy keys are not authority-partitioned. A scoped native failure
  // must never clear another caller's unscoped task view as collateral.
  if (!requestScope)
    revokeKeys(client, [
      taskQueries.turnReferences(taskId).queryKey,
      taskQueries.userInputReferences(taskId).queryKey,
      taskQueries.graph(taskId).queryKey,
    ]);
}

/** Protected direct result lookup; callers provide the Surface-validated tuple. */
export function useSessionToolResultQuery(
  sessionId: string,
  eventId: string,
  config?: TaskToolResultQueryConfig<
    Awaited<ReturnType<typeof getSessionToolResult>>
  >,
) {
  const client = useQueryClient();
  const requestScope = config?.requestScope;
  const hasRequestScope = isApiRequestScope(requestScope);
  const key = useMemo(
    () =>
      taskToolResultQueries.session(sessionId, eventId, config?.requestScope)
        .queryKey,
    [config?.requestScope, eventId, sessionId],
  );
  const query = useApiQuery(
    key,
    async (signal) => {
      try {
        // Resolve the base inside this request; it is never shared through a
        // module cache or attached to a different observer's tuple.
        const apiBase = hasRequestScope
          ? requestScope.apiBase
          : await resolveApiBase();
        return await getSessionToolResult(apiBase, sessionId, eventId, {
          signal,
          requestScope,
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        if (lostAuthority(error)) {
          // Keep a generic tombstone in the active direct-result observer.
          // Removing it here would immediately re-fetch a mounted sibling and
          // lose the settled denial before it can be rendered or retried.
          client.setQueryData<TaskToolResultRequestError>(key, error);
        }
        throw error;
      }
    },
    {
      staleTime:
        config?.staleTime ??
        taskToolResultQueries.session(sessionId, eventId, config?.requestScope)
          .staleTime,
      gcTime: config?.gcTime,
      enabled:
        hasRequestScope &&
        (config?.enabled ?? (sessionId.length > 0 && eventId.length > 0)),
      refetchOnMount: config?.refetchOnMount ?? 'always',
      retry: false,
      cancelWhenInactive: config?.cancelWhenInactive ?? true,
    },
  );
  const protectedError =
    query.data instanceof TaskToolResultRequestError ? query.data : undefined;
  return {
    ...query,
    error: protectedError ?? query.error,
    status: protectedError ? 'error' : query.status,
    data:
      !protectedError &&
      query.isFetchedAfterMount &&
      query.status === 'success' &&
      !query.isFetching &&
      query.data
        ? query.data
        : undefined,
    isLoading:
      !protectedError &&
      (!query.isFetchedAfterMount || query.isLoading || query.isFetching),
  };
}

export function useTaskToolResultReferencesQuery(
  taskId: string,
  config?: TaskToolResultQueryConfig<TaskToolResultProjection[]>,
) {
  const client = useQueryClient();
  const key = taskToolResultQueries.references(
    taskId,
    config?.requestScope,
  ).queryKey;
  const query = useApiQuery(
    key,
    async (signal) => {
      try {
        const apiBase = isApiRequestScope(config?.requestScope)
          ? config.requestScope.apiBase
          : await resolveApiBase();
        return await getTaskToolResultReferences(apiBase, taskId, {
          signal,
          requestScope: config?.requestScope,
        });
      } catch (error) {
        if (
          signal?.aborted ||
          (error instanceof DOMException && error.name === 'AbortError')
        )
          throw error;
        if (lostAuthority(error)) {
          // Preserve a generic tombstone in this mounted observer instead of
          // removing it (which would immediately re-fetch an active query).
          client.setQueryData<TaskToolResultRequestError>(key, error);
          revokeTaskToolResultScope(client, taskId, config?.requestScope, true);
        }
        throw error;
      }
    },
    {
      staleTime:
        config?.staleTime ??
        taskToolResultQueries.references(taskId, config?.requestScope)
          .staleTime,
      gcTime: config?.gcTime,
      enabled: config?.enabled ?? taskId.length > 0,
      refetchOnMount: config?.refetchOnMount ?? 'always',
      retry: false,
      cancelWhenInactive: config?.cancelWhenInactive ?? true,
    },
  );
  const protectedError =
    query.data instanceof TaskToolResultRequestError ? query.data : undefined;
  return {
    ...query,
    error: protectedError ?? query.error,
    status: protectedError ? 'error' : query.status,
    data:
      !protectedError &&
      query.isFetchedAfterMount &&
      query.status === 'success' &&
      !query.isFetching
        ? query.data
        : undefined,
    isLoading:
      !protectedError &&
      (!query.isFetchedAfterMount || query.isLoading || query.isFetching),
  };
}

export interface AttachTaskToolResultReferenceMutationInput
  extends AttachTaskToolResultReferenceInput {
  taskId: string;
}

export type AttachTaskToolResultReferenceMutationOptions = MutationOptions<
  Awaited<ReturnType<typeof attachTaskToolResultReference>>,
  AttachTaskToolResultReferenceMutationInput
> & {
  /** Captured host authority; native Basis attachment never falls back to a global base. */
  requestScope?: ApiRequestScope;
};

type AttachInvocation = {
  requestScope?: ApiRequestScope;
  onSuccess?: AttachTaskToolResultReferenceMutationOptions['onSuccess'];
  onError?: AttachTaskToolResultReferenceMutationOptions['onError'];
};

type InternalAttachInvocation = {
  variables: AttachTaskToolResultReferenceMutationInput;
  invocation: AttachInvocation;
};

/**
 * Lazy-only attachment action. It carries only the caller's validated result
 * tuple; the server remains the authority for the canonical retained link.
 */
export function useAttachTaskToolResultReferenceMutation(
  options?: AttachTaskToolResultReferenceMutationOptions,
) {
  const client = useQueryClient();
  const mutation = useMutation<
    Awaited<ReturnType<typeof attachTaskToolResultReference>>,
    Error,
    InternalAttachInvocation,
    AttachInvocation
  >({
    onMutate: ({ invocation }) => invocation,
    mutationFn: async ({ variables, invocation }) => {
      const { taskId, ...input } = variables;
      if (!isApiRequestScope(invocation.requestScope))
        throw new TaskToolResultRequestError(0);
      return attachTaskToolResultReference(
        invocation.requestScope.apiBase,
        taskId,
        input,
        { requestScope: invocation.requestScope },
      );
    },
    onSuccess: (data, { variables }, invocation) => {
      const scope = invocation?.requestScope;
      // No optimistic retained state: refetch the exact kept-result list and
      // every selected/whole Task Basis view for this one destination task.
      void client.invalidateQueries({
        queryKey: taskToolResultQueries.references(variables.taskId, scope)
          .queryKey,
        exact: true,
      });
      void client.invalidateQueries({
        queryKey: taskBasisQueries.scope(variables.taskId, scope),
      });
      invocation?.onSuccess?.(data, variables);
    },
    onError: (error, { variables }, invocation) => {
      if (lostAuthority(error))
        revokeTaskToolResultScope(
          client,
          variables.taskId,
          invocation?.requestScope,
        );
      invocation?.onError?.(error as Error, variables);
    },
  });
  const captureInvocation = (): AttachInvocation => ({
    requestScope: isApiRequestScope(options?.requestScope)
      ? {
          apiBase: options.requestScope.apiBase,
          authorityKey: options.requestScope.authorityKey,
        }
      : undefined,
    onSuccess: options?.onSuccess,
    onError: options?.onError,
  });
  const internalOptions = (
    variables: AttachTaskToolResultReferenceMutationInput,
    callOptions?: MutateOptions<
      Awaited<ReturnType<typeof attachTaskToolResultReference>>,
      Error,
      AttachTaskToolResultReferenceMutationInput,
      AttachInvocation
    >,
  ):
    | MutateOptions<
        Awaited<ReturnType<typeof attachTaskToolResultReference>>,
        Error,
        InternalAttachInvocation,
        AttachInvocation
      >
    | undefined =>
    callOptions
      ? {
          onSuccess: (data, _internal, onMutateResult, context) =>
            callOptions.onSuccess?.(data, variables, onMutateResult, context),
          onError: (error, _internal, onMutateResult, context) =>
            callOptions.onError?.(error, variables, onMutateResult, context),
          onSettled: (data, error, _internal, onMutateResult, context) =>
            callOptions.onSettled?.(
              data,
              error,
              variables,
              onMutateResult,
              context,
            ),
        }
      : undefined;
  const mutate = (
    variables: AttachTaskToolResultReferenceMutationInput,
    callOptions?: MutateOptions<
      Awaited<ReturnType<typeof attachTaskToolResultReference>>,
      Error,
      AttachTaskToolResultReferenceMutationInput,
      AttachInvocation
    >,
  ) =>
    mutation.mutate(
      { variables, invocation: captureInvocation() },
      internalOptions(variables, callOptions),
    );
  const mutateAsync = (
    variables: AttachTaskToolResultReferenceMutationInput,
    callOptions?: MutateOptions<
      Awaited<ReturnType<typeof attachTaskToolResultReference>>,
      Error,
      AttachTaskToolResultReferenceMutationInput,
      AttachInvocation
    >,
  ) =>
    mutation.mutateAsync(
      { variables, invocation: captureInvocation() },
      internalOptions(variables, callOptions),
    );
  return {
    ...mutation,
    variables: mutation.variables?.variables,
    mutate,
    mutateAsync,
  } as UseMutationResult<
    Awaited<ReturnType<typeof attachTaskToolResultReference>>,
    Error,
    AttachTaskToolResultReferenceMutationInput,
    AttachInvocation
  >;
}
