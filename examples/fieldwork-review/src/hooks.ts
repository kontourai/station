import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { PLUGIN_NAME, pluginUrl, type RunSummary, requestJson } from './api';

interface RunContext {
  apiBase: string;
  projectSlug: string;
}

export function useRuns(
  context: RunContext,
  selectedRunId: string | null,
  selectRun: (runId: string | null) => void,
) {
  const query = useQuery({
    queryKey: [PLUGIN_NAME, context.projectSlug, 'runs'],
    queryFn: async () => {
      const body = await requestJson<{ runs: RunSummary[] }>(
        pluginUrl(context.apiBase, context.projectSlug, '/runs'),
      );
      return body.runs;
    },
  });
  useEffect(() => {
    if (!selectedRunId && query.data?.[0]) selectRun(query.data[0].id);
  }, [query.data, selectRun, selectedRunId]);
  return query;
}

function useInvalidateRuns(projectSlug: string) {
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({
      queryKey: [PLUGIN_NAME, projectSlug, 'runs'],
    });
}

export function useLaunchRun(
  context: RunContext,
  taskPath: string,
  sourcePath: string,
  onSuccess: (run: RunSummary) => void,
) {
  const invalidateRuns = useInvalidateRuns(context.projectSlug);
  return useMutation({
    mutationFn: () =>
      requestJson<{ run: RunSummary }>(
        pluginUrl(context.apiBase, context.projectSlug, '/runs'),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            taskPath,
            sourcePath: sourcePath || undefined,
          }),
        },
      ),
    onSuccess: async ({ run }) => {
      onSuccess(run);
      await invalidateRuns();
    },
  });
}

export function useOpenReview(
  context: RunContext,
  onSuccess: (runId: string, reviewUrl: string) => void,
) {
  const invalidateRuns = useInvalidateRuns(context.projectSlug);
  return useMutation({
    mutationFn: (runId: string) =>
      requestJson<{ review: { url: string } }>(
        pluginUrl(
          context.apiBase,
          context.projectSlug,
          `/runs/${encodeURIComponent(runId)}/open`,
        ),
        { method: 'POST' },
      ),
    onSuccess: async ({ review }, runId) => {
      onSuccess(runId, review.url);
      await invalidateRuns();
    },
  });
}

export function useCloseReview(
  context: RunContext,
  onSuccess: (runId: string) => void,
) {
  const invalidateRuns = useInvalidateRuns(context.projectSlug);
  return useMutation({
    mutationFn: (runId: string) =>
      requestJson<unknown>(
        pluginUrl(
          context.apiBase,
          context.projectSlug,
          `/runs/${encodeURIComponent(runId)}/close`,
        ),
        { method: 'POST' },
      ),
    onSuccess: async (_, runId) => {
      onSuccess(runId);
      await invalidateRuns();
    },
  });
}

export function useReviewedOutput(
  context: RunContext,
  selectedRunId: string | null,
  reviewOpen: boolean,
) {
  return useQuery({
    queryKey: [
      PLUGIN_NAME,
      context.projectSlug,
      selectedRunId,
      'reviewed-output',
    ],
    enabled: Boolean(selectedRunId),
    retry: false,
    refetchInterval: reviewOpen ? 500 : false,
    queryFn: () =>
      requestJson<{ available: boolean }>(
        pluginUrl(
          context.apiBase,
          context.projectSlug,
          `/runs/${encodeURIComponent(selectedRunId!)}/reviewed-output`,
        ),
      ),
  });
}

export function useOpenedRunCleanup(
  context: RunContext,
  openedRunId: string | null,
) {
  useEffect(() => {
    if (!openedRunId) return;
    const closeUrl = pluginUrl(
      context.apiBase,
      context.projectSlug,
      `/runs/${encodeURIComponent(openedRunId)}/close`,
    );
    return () => {
      void fetch(closeUrl, { method: 'POST', keepalive: true });
    };
  }, [context.apiBase, context.projectSlug, openedRunId]);
}
