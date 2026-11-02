import { mutateJson, useTasksQuery } from '@kontourai/station-sdk';
import type { ApiRequestScope } from '@kontourai/station-sdk/client';
import { useMutation } from '@tanstack/react-query';
import { TaskPicker } from '../../components/chat/TaskPicker';
import { useScopedProjectsQuery } from '../../contexts/ProjectsContext';

export function DeviceReproductionPicker({
  scope,
  projectSlug,
  sourceSessionId,
  appId,
  returnFocusTarget,
  onClose,
}: {
  scope: ApiRequestScope;
  projectSlug: string;
  sourceSessionId: string;
  appId: string;
  returnFocusTarget: HTMLElement | null;
  onClose(): void;
}) {
  const projects = useScopedProjectsQuery();
  const projectId = projects.data?.find(
    (project) => project.slug === projectSlug,
  )?.id;
  const tasks = useTasksQuery(projectSlug, {
    requestScope: scope,
    enabled: !!projectId,
  });
  const capture = useMutation({
    mutationFn: async (taskId: string) => {
      const query = new URLSearchParams({ projectSlug });
      const response = await mutateJson(
        `${scope.apiBase}/api/tasks/${encodeURIComponent(taskId)}/review/device-repro-bundles?${query}`,
        'POST',
        { requestScope: scope, maxResponseBytes: 16 * 1024 },
        { sourceSessionId, appId },
      );
      const value: unknown = await response.json();
      if (
        !response.ok ||
        !value ||
        typeof value !== 'object' ||
        !('success' in value) ||
        value.success !== true
      )
        throw new Error('Reproduction could not be confirmed.');
    },
  });
  return (
    <TaskPicker
      target={{ sourceSessionId, projectSlug }}
      projectId={projectId}
      initiallyOpen
      hideTrigger
      returnFocusTarget={returnFocusTarget}
      triggerLabel="Save reproduction to Task"
      dialogTitle="Save reproduction to Task"
      eyebrow="Includes a screenshot and app logs"
      onClose={onClose}
      onAttached={onClose}
      adapter={{
        tasks: tasks.data,
        isLoading: projects.isLoading || (!!projectId && tasks.isLoading),
        error:
          projects.error ??
          tasks.error ??
          (projects.isSuccess && !projectId
            ? new Error('Project unavailable')
            : null),
        refetch: () => (projectId ? tasks.refetch() : projects.refetch()),
        isPending: capture.isPending,
      }}
      attach={async (taskId) => {
        await capture.mutateAsync(taskId);
      }}
      successMessage={(task) => `Reproduction saved to “${task.title}”.`}
      failureMessage="Check the Task before retrying, or update Station if it is unsupported."
      submitLabel="Save bundle"
      pendingLabel="Capturing…"
    />
  );
}
