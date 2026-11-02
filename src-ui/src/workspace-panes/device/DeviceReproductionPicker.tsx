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
  onSaved,
}: {
  scope: ApiRequestScope;
  projectSlug: string;
  sourceSessionId: string;
  appId: string;
  returnFocusTarget: HTMLElement | null;
  onClose(): void;
  onSaved(taskTitle: string): void;
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
    mutationFn: async ({
      taskId,
      target,
    }: {
      taskId: string;
      target: { projectSlug: string; sourceSessionId: string; appId: string };
    }) => {
      const query = new URLSearchParams({ projectSlug: target.projectSlug });
      const response = await mutateJson(
        `${scope.apiBase}/api/tasks/${encodeURIComponent(taskId)}/review/device-repro-bundles?${query}`,
        'POST',
        { requestScope: scope, maxResponseBytes: 16 * 1024 },
        { sourceSessionId: target.sourceSessionId, appId: target.appId },
      );
      const value: unknown = await response.json();
      if (
        !response.ok ||
        !value ||
        typeof value !== 'object' ||
        !('success' in value) ||
        value.success !== true ||
        !('data' in value) ||
        !value.data ||
        typeof value.data !== 'object' ||
        !('attachment' in value.data) ||
        !value.data.attachment ||
        typeof value.data.attachment !== 'object' ||
        !('id' in value.data.attachment) ||
        typeof value.data.attachment.id !== 'string'
      )
        throw new Error('Reproduction could not be confirmed.');
    },
  });
  return (
    <TaskPicker
      target={{ sourceSessionId, projectSlug, appId }}
      projectId={projectId}
      initiallyOpen
      hideTrigger
      returnFocusTarget={returnFocusTarget}
      triggerLabel="Save reproduction to Task"
      dialogTitle="Save reproduction to Task"
      eyebrow="Includes a screenshot and app logs"
      onClose={onClose}
      onAttached={(task) => onSaved(task.title)}
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
      attach={async (taskId, target) => {
        await capture.mutateAsync({ taskId, target });
      }}
      successMessage={(task) => `Reproduction saved to “${task.title}”.`}
      failureMessage="Check the Task before retrying, or update Station if it is unsupported."
      submitLabel="Save bundle"
      pendingLabel="Capturing…"
    />
  );
}
