/** Protected retained Flow gate-evaluation transport and query surface. */
export * from './client/flow-gate-evaluations';

import { parseGateEvaluationRef } from '@kontourai/flow/gate-evaluation-contract';
import {
  type MutateOptions,
  type MutationFunctionContext,
  type UseMutationResult,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { useMemo } from 'react';
import {
  type AttachTaskFlowGateEvaluationInput,
  attachTaskFlowGateEvaluation,
  type FlowGateEvaluationProjection,
  FlowGateEvaluationRequestError,
  getProjectFlowGateEvaluation,
  getTaskFlowGateEvaluations,
} from './client/flow-gate-evaluations';
import {
  type ApiRequestScope,
  isApiRequestScope,
  type QueryConfig,
  useApiQuery,
} from './query-core';
import { taskBasisQueries } from './task-basis';
export const flowGateEvaluationQueries = {
  inspect: (
    projectSlug: string,
    ref: { runId: string; gateId: string; evaluationId: string },
    scope?: ApiRequestScope,
  ) => ({
    queryKey: scope
      ? [
          'flow-gate-evaluation',
          projectSlug,
          ref.runId,
          ref.gateId,
          ref.evaluationId,
          scope.apiBase,
          scope.authorityKey,
        ]
      : [
          'flow-gate-evaluation',
          projectSlug,
          ref.runId,
          ref.gateId,
          ref.evaluationId,
        ],
    staleTime: 10_000,
  }),
  retained: (taskId: string, scope?: ApiRequestScope) => ({
    queryKey: scope
      ? ['flow-gate-evaluations', taskId, scope.apiBase, scope.authorityKey]
      : ['flow-gate-evaluations', taskId],
    staleTime: 10_000,
  }),
};

export function useProjectFlowGateEvaluationQuery(
  projectSlug: string,
  ref: { runId: string; gateId: string; evaluationId: string } | undefined,
  config?: QueryConfig<
    Awaited<ReturnType<typeof getProjectFlowGateEvaluation>>
  > & {
    requestScope?: ApiRequestScope;
  },
) {
  const client = useQueryClient();
  const scope = config?.requestScope;
  const validRef = useMemo(() => ref && parseGateEvaluationRef(ref), [ref]);
  const key = useMemo(
    () =>
      validRef
        ? flowGateEvaluationQueries.inspect(projectSlug, validRef, scope)
            .queryKey
        : ['flow-gate-evaluation', projectSlug, 'invalid'],
    [projectSlug, scope, validRef],
  );
  const query = useApiQuery(
    key,
    async (signal) => {
      if (!isApiRequestScope(scope) || !validRef)
        throw new FlowGateEvaluationRequestError(0);
      try {
        return await getProjectFlowGateEvaluation(
          scope.apiBase,
          projectSlug,
          validRef,
          {
            signal,
            requestScope: scope,
          },
        );
      } catch (error) {
        if (signal?.aborted) throw error;
        if (lostAuthority(error))
          // This query owns the refusal. Do not cancel it here: cancelling the
          // currently rejecting observer can leave it permanently pending.
          client.setQueryData<FlowGateEvaluationRequestError>(key, error);
        throw error;
      }
    },
    {
      ...config,
      enabled:
        Boolean(validRef) &&
        isApiRequestScope(scope) &&
        (config?.enabled ?? true),
      retry: false,
      staleTime: config?.staleTime ?? 10_000,
      refetchOnMount: config?.refetchOnMount ?? 'always',
    },
  );
  const protectedError =
    query.error instanceof FlowGateEvaluationRequestError
      ? query.error
      : undefined;
  return {
    ...query,
    error: protectedError ?? query.error,
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

function lostAuthority(
  error: unknown,
): error is FlowGateEvaluationRequestError {
  return error instanceof FlowGateEvaluationRequestError;
}

async function revokeFlowGateEvaluationScope(
  client: ReturnType<typeof useQueryClient>,
  taskId: string,
  scope?: ApiRequestScope,
  tombstone?: FlowGateEvaluationRequestError,
  cancelRetained = false,
) {
  const retained = flowGateEvaluationQueries.retained(taskId, scope).queryKey;
  const basis = taskBasisQueries.scope(taskId, scope);
  // A retained query owns the refusal it observed, so it must not cancel
  // itself. A refused mutation, however, revokes authority for every affected
  // retained and Basis read. Fence those in-flight reads before publishing
  // tombstones: a transport that ignores AbortSignal must not restore data.
  if (cancelRetained)
    await client.cancelQueries(
      { queryKey: retained, exact: true },
      { revert: false },
    );
  await client.cancelQueries({ queryKey: basis }, { revert: false });
  client.setQueriesData({ queryKey: basis }, null);
  client.setQueriesData({ queryKey: retained, exact: true }, tombstone ?? null);
}
export function useTaskFlowGateEvaluationsQuery(
  taskId: string,
  config?: QueryConfig<FlowGateEvaluationProjection[]> & {
    requestScope?: ApiRequestScope;
  },
) {
  const client = useQueryClient();
  const scope = config?.requestScope;
  const key = useMemo(
    () => flowGateEvaluationQueries.retained(taskId, scope).queryKey,
    [taskId, scope],
  );
  const query = useApiQuery(
    key,
    async (signal) => {
      if (!isApiRequestScope(scope))
        throw new FlowGateEvaluationRequestError(0);
      try {
        return await getTaskFlowGateEvaluations(scope.apiBase, taskId, {
          signal,
          requestScope: scope,
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        if (lostAuthority(error)) {
          client.setQueryData<FlowGateEvaluationRequestError>(key, error);
          await revokeFlowGateEvaluationScope(client, taskId, scope, error);
        }
        throw error;
      }
    },
    {
      ...config,
      enabled:
        isApiRequestScope(scope) && (config?.enabled ?? taskId.length > 0),
      retry: false,
      staleTime: config?.staleTime ?? 10_000,
      refetchOnMount: config?.refetchOnMount ?? 'always',
    },
  );
  const protectedError =
    query.data instanceof FlowGateEvaluationRequestError
      ? query.data
      : query.error instanceof FlowGateEvaluationRequestError
        ? query.error
        : undefined;
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
export interface AttachTaskFlowGateEvaluationMutationInput
  extends AttachTaskFlowGateEvaluationInput {
  taskId: string;
}
export type AttachTaskFlowGateEvaluationMutationOptions = {
  requestScope?: ApiRequestScope;
};
type AttachInvocation = { requestScope?: ApiRequestScope };
type InternalAttachInvocation = {
  variables: AttachTaskFlowGateEvaluationMutationInput;
  invocation: AttachInvocation;
};
export function useAttachTaskFlowGateEvaluationMutation(
  options?: AttachTaskFlowGateEvaluationMutationOptions,
) {
  const client = useQueryClient();
  const mutation = useMutation<
    Awaited<ReturnType<typeof attachTaskFlowGateEvaluation>>,
    Error,
    InternalAttachInvocation,
    AttachInvocation
  >({
    onMutate: ({ invocation }) => invocation,
    mutationFn: ({ variables, invocation }) => {
      const { taskId, ...input } = variables;
      if (!isApiRequestScope(invocation.requestScope))
        throw new FlowGateEvaluationRequestError(0);
      return attachTaskFlowGateEvaluation(
        invocation.requestScope.apiBase,
        taskId,
        input,
        { requestScope: invocation.requestScope },
      );
    },
    onSuccess: (_data, { variables }, invocation) => {
      void client.invalidateQueries({
        queryKey: flowGateEvaluationQueries.retained(
          variables.taskId,
          invocation?.requestScope,
        ).queryKey,
        exact: true,
      });
      void client.invalidateQueries({
        queryKey: taskBasisQueries.scope(
          variables.taskId,
          invocation?.requestScope,
        ),
      });
    },
    onError: async (error, { variables }, invocation) => {
      if (lostAuthority(error))
        await revokeFlowGateEvaluationScope(
          client,
          variables.taskId,
          invocation?.requestScope,
          error,
          true,
        );
    },
  });
  const captureInvocation = (): AttachInvocation => ({
    requestScope: isApiRequestScope(options?.requestScope)
      ? {
          apiBase: options.requestScope.apiBase,
          authorityKey: options.requestScope.authorityKey,
        }
      : undefined,
  });
  const captureVariables = (
    variables: AttachTaskFlowGateEvaluationMutationInput,
  ): AttachTaskFlowGateEvaluationMutationInput => ({
    taskId: variables.taskId,
    ref: {
      runId: variables.ref.runId,
      gateId: variables.ref.gateId,
      evaluationId: variables.ref.evaluationId,
    },
    ...(variables.sourceSurface === undefined
      ? {}
      : { sourceSurface: variables.sourceSurface }),
  });
  const internalOptions = (
    variables: AttachTaskFlowGateEvaluationMutationInput,
    callOptions?: MutateOptions<
      Awaited<ReturnType<typeof attachTaskFlowGateEvaluation>>,
      Error,
      AttachTaskFlowGateEvaluationMutationInput,
      AttachInvocation
    >,
  ) =>
    callOptions
      ? {
          onSuccess: (
            data: Awaited<ReturnType<typeof attachTaskFlowGateEvaluation>>,
            _internal: InternalAttachInvocation,
            onMutateResult: AttachInvocation | undefined,
            context: MutationFunctionContext,
          ) =>
            callOptions.onSuccess?.(data, variables, onMutateResult, context),
          onError: (
            error: Error,
            _internal: InternalAttachInvocation,
            onMutateResult: AttachInvocation | undefined,
            context: MutationFunctionContext,
          ) => callOptions.onError?.(error, variables, onMutateResult, context),
          onSettled: (
            data:
              | Awaited<ReturnType<typeof attachTaskFlowGateEvaluation>>
              | undefined,
            error: Error | null,
            _internal: InternalAttachInvocation,
            onMutateResult: AttachInvocation | undefined,
            context: MutationFunctionContext,
          ) =>
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
    variables: AttachTaskFlowGateEvaluationMutationInput,
    callOptions?: MutateOptions<
      Awaited<ReturnType<typeof attachTaskFlowGateEvaluation>>,
      Error,
      AttachTaskFlowGateEvaluationMutationInput,
      AttachInvocation
    >,
  ) =>
    mutation.mutate(
      {
        variables: captureVariables(variables),
        invocation: captureInvocation(),
      },
      internalOptions(variables, callOptions),
    );
  const mutateAsync = (
    variables: AttachTaskFlowGateEvaluationMutationInput,
    callOptions?: MutateOptions<
      Awaited<ReturnType<typeof attachTaskFlowGateEvaluation>>,
      Error,
      AttachTaskFlowGateEvaluationMutationInput,
      AttachInvocation
    >,
  ) =>
    mutation.mutateAsync(
      {
        variables: captureVariables(variables),
        invocation: captureInvocation(),
      },
      internalOptions(variables, callOptions),
    );
  return {
    ...mutation,
    variables: mutation.variables?.variables,
    mutate,
    mutateAsync,
  } as UseMutationResult<
    Awaited<ReturnType<typeof attachTaskFlowGateEvaluation>>,
    Error,
    AttachTaskFlowGateEvaluationMutationInput,
    AttachInvocation
  >;
}
