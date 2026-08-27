import type { SecretBindingView } from '@kontourai/station-contracts/secret-binding';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { _getApiBase } from '../api';
import {
  bindSecretBinding,
  createSecretBinding,
  getIntegrationSecretBindings,
  getSecretBinding,
  type IntegrationSecretBindingProjection,
  listSecretBindings,
  replaceSecretBinding,
  revokeSecretBinding,
  type SecretBindingConsumerInput,
  unbindSecretBinding,
} from '../client/secret-bindings';
import type { QueryConfig } from '../query-core';

export const secretBindingQueries = {
  list: () => ({
    queryKey: ['secret-bindings'] as const,
    queryFn: async () => listSecretBindings(await _getApiBase()),
    staleTime: 30_000,
  }),
  detail: (id: string) => ({
    queryKey: ['secret-bindings', id] as const,
    queryFn: async () => getSecretBinding(await _getApiBase(), id),
    staleTime: 30_000,
  }),
  integration: (integrationId: string) => ({
    queryKey: ['secret-bindings', 'integration', integrationId] as const,
    queryFn: async () =>
      getIntegrationSecretBindings(await _getApiBase(), integrationId),
    staleTime: 30_000,
  }),
};

export function useSecretBindingsQuery(
  config?: QueryConfig<SecretBindingView[]>,
) {
  return useQuery({ ...secretBindingQueries.list(), ...config });
}
export function useSecretBindingQuery(
  id: string | undefined,
  config?: QueryConfig<SecretBindingView>,
) {
  return useQuery({
    ...secretBindingQueries.detail(id ?? ''),
    ...config,
    enabled: !!id && (config?.enabled ?? true),
  });
}
export function useIntegrationSecretBindingQuery(
  integrationId: string | undefined,
  config?: QueryConfig<IntegrationSecretBindingProjection>,
) {
  return useQuery({
    ...secretBindingQueries.integration(integrationId ?? ''),
    ...config,
    enabled: !!integrationId && (config?.enabled ?? true),
  });
}
/** Invalidate every projection that can make an operator's binding state stale. */
export function useRefreshSecretBindingState(integrationId: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: secretBindingQueries.list().queryKey,
      }),
      queryClient.invalidateQueries({
        queryKey: secretBindingQueries.integration(integrationId).queryKey,
      }),
      queryClient.invalidateQueries({ queryKey: ['integrations'] }),
    ]);
}
function useBindingMutation<T, TResult>(
  mutationFn: (apiBase: string, input: T) => Promise<TResult>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: T) => mutationFn(await _getApiBase(), input),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['secret-bindings'] }),
  });
}
export const useCreateSecretBindingMutation = () =>
  useBindingMutation(createSecretBinding);
export const useReplaceSecretBindingMutation = () =>
  useBindingMutation(
    (
      apiBase,
      {
        id,
        ...data
      }: {
        id: string;
        name: string;
        authRef: unknown;
        expectedRevision: number;
      },
    ) => replaceSecretBinding(apiBase, id, data),
  );
export const useRevokeSecretBindingMutation = () =>
  useBindingMutation(
    (
      apiBase,
      { id, expectedRevision }: { id: string; expectedRevision: number },
    ) => revokeSecretBinding(apiBase, id, expectedRevision),
  );
export const useBindSecretBindingMutation = () =>
  useBindingMutation(
    (apiBase, { id, ...data }: SecretBindingConsumerInput & { id: string }) =>
      bindSecretBinding(apiBase, id, data),
  );
export const useUnbindSecretBindingMutation = () =>
  useBindingMutation(
    (apiBase, { id, ...data }: SecretBindingConsumerInput & { id: string }) =>
      unbindSecretBinding(apiBase, id, data),
  );
