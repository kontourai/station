/** React hooks over the React-free existing-setup import client. */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { _getApiBase } from '../api';
import {
  applyExistingSetupImport,
  createExistingSetupImportPreview,
  type ExistingSetupImportItem,
  type ExistingSetupImportPreview,
  type ExistingSetupImportReceipt,
  fetchExistingSetupImportSources,
  reviewExistingSetupImportTargets,
  rollbackExistingSetupImport,
} from '../client/setup-imports';
import {
  type MutationOptions,
  type QueryConfig,
  useApiQuery,
} from '../query-core';

export type SetupImportPreview = ExistingSetupImportPreview;
export type SetupImportReceipt = ExistingSetupImportReceipt;
export type SetupImportItem = ExistingSetupImportItem;
export type SetupImportTargetReview =
  import('../client/setup-imports').ExistingSetupImportTargetReview;

export function useSetupImportSourcesQuery(
  config?: QueryConfig<Array<{ id: string; available: boolean }>>,
) {
  return useApiQuery(
    ['setup-imports', 'sources'],
    async () => fetchExistingSetupImportSources(await _getApiBase()),
    config,
  );
}

export function useCreateSetupImportPreviewMutation(
  options?: MutationOptions<SetupImportPreview, string | undefined>,
) {
  return useMutation<SetupImportPreview, Error, string | undefined>({
    mutationFn: async (sourceId) =>
      createExistingSetupImportPreview(
        await _getApiBase(),
        sourceId ?? 'codex-prompts',
      ),
    ...options,
  });
}

export function useApplySetupImportMutation(
  options?: MutationOptions<
    SetupImportReceipt,
    { previewId: string; witnessId: string }
  >,
) {
  const queryClient = useQueryClient();
  return useMutation<
    SetupImportReceipt,
    Error,
    { previewId: string; witnessId: string }
  >({
    mutationFn: async ({ previewId, witnessId }) =>
      applyExistingSetupImport(await _getApiBase(), { previewId, witnessId }),
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['skills'] });
      options?.onSuccess?.(data, variables);
    },
    onError: (error, variables) => options?.onError?.(error, variables),
  });
}

export function useReviewSetupImportTargetsMutation(
  options?: MutationOptions<
    SetupImportTargetReview,
    { previewId: string; items: SetupImportItem[] }
  >,
) {
  return useMutation<
    SetupImportTargetReview,
    Error,
    { previewId: string; items: SetupImportItem[] }
  >({
    mutationFn: async ({ previewId, items }) =>
      reviewExistingSetupImportTargets(await _getApiBase(), {
        previewId,
        items,
      }),
    ...options,
  });
}

export function useRollbackSetupImportMutation(
  options?: MutationOptions<SetupImportReceipt, string>,
) {
  const queryClient = useQueryClient();
  return useMutation<SetupImportReceipt, Error, string>({
    mutationFn: async (id) =>
      rollbackExistingSetupImport(await _getApiBase(), id),
    onSuccess: (data, id) => {
      queryClient.invalidateQueries({ queryKey: ['skills'] });
      options?.onSuccess?.(data, id);
    },
    onError: (error, id) => options?.onError?.(error, id),
  });
}
