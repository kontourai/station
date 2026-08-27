import type { WorkflowMetadata } from '@kontourai/station-contracts/runtime';
import { _getApiBase } from '../api';
import {
  type MutationOptions,
  type QueryConfig,
  useApiMutation,
  useApiQuery,
} from '../query-core';

export type { WorkflowMetadata } from '@kontourai/station-contracts/runtime';

export function useAgentWorkflowsQuery(
  agentSlug: string | undefined,
  config?: QueryConfig<WorkflowMetadata[]>,
) {
  return useApiQuery(
    ['workflows', agentSlug ?? ''],
    async () => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/agents/${encodeURIComponent(agentSlug!)}/workflows/files`,
      );
      const result = (await response.json()) as {
        success: boolean;
        data?: WorkflowMetadata[];
        error?: string;
      };
      if (!result.success) {
        throw new Error(apiErrorMessage(result, 'Failed to load workflows'));
      }
      return result.data ?? [];
    },
    { ...config, enabled: !!agentSlug && (config?.enabled ?? true) },
  );
}

export function useWorkflowContentQuery(
  agentSlug: string | undefined,
  workflowId: string | undefined,
  config?: QueryConfig<string>,
) {
  return useApiQuery(
    ['workflows', agentSlug ?? '', workflowId ?? ''],
    async () => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/agents/${encodeURIComponent(agentSlug!)}/workflows/${encodeURIComponent(workflowId!)}`,
      );
      const result = await response.json();
      if (!result.success) {
        throw new Error(
          apiErrorMessage(result, 'Failed to load workflow content'),
        );
      }
      return result.data?.content as string;
    },
    {
      ...config,
      enabled: !!agentSlug && !!workflowId && (config?.enabled ?? true),
    },
  );
}

export function useCreateWorkflowMutation(
  agentSlug: string,
  options?: MutationOptions<void, { filename: string; content: string }>,
) {
  return useApiMutation(
    async ({ filename, content }: { filename: string; content: string }) => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/agents/${encodeURIComponent(agentSlug)}/workflows`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename, content }),
        },
      );
      const result = await response.json();
      if (!result.success) {
        throw new Error(apiErrorMessage(result, 'Failed to create workflow'));
      }
    },
    {
      invalidateKeys: [['workflows', agentSlug]],
      onSuccess: options?.onSuccess,
      onError: options?.onError,
    },
  );
}

export function useUpdateWorkflowMutation(
  agentSlug: string,
  options?: MutationOptions<void, { workflowId: string; content: string }>,
) {
  return useApiMutation(
    async ({
      workflowId,
      content,
    }: {
      workflowId: string;
      content: string;
    }) => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/agents/${encodeURIComponent(agentSlug)}/workflows/${encodeURIComponent(workflowId)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content }),
        },
      );
      const result = await response.json();
      if (!result.success) {
        throw new Error(apiErrorMessage(result, 'Failed to update workflow'));
      }
    },
    {
      invalidateKeys: [['workflows', agentSlug]],
      onSuccess: options?.onSuccess,
      onError: options?.onError,
    },
  );
}

export function useDeleteWorkflowMutation(
  agentSlug: string,
  options?: MutationOptions<void, string>,
) {
  return useApiMutation(
    async (workflowId: string) => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/agents/${encodeURIComponent(agentSlug)}/workflows/${encodeURIComponent(workflowId)}`,
        { method: 'DELETE' },
      );
      const result = await response.json();
      if (!result.success) {
        throw new Error(apiErrorMessage(result, 'Failed to delete workflow'));
      }
    },
    {
      invalidateKeys: [['workflows', agentSlug]],
      onSuccess: options?.onSuccess,
      onError: options?.onError,
    },
  );
}

import { apiErrorMessage } from '../api-core';
import { authenticatedFetch } from '../client/http';
