import {
  useStartDeviceRecordingMutation,
  useTasksQuery,
} from '@kontourai/station-sdk';
import type { ApiRequestScope } from '@kontourai/station-sdk/client';
import { useRef } from 'react';
import { TaskPicker } from '../../components/chat/TaskPicker';
import { useScopedProjectsQuery } from '../../contexts/ProjectsContext';

export function DeviceRecordingPicker({
  scope,
  projectSlug,
  sourceSessionId,
  returnFocusTarget,
  onClose,
  onStarted,
}: {
  scope: ApiRequestScope;
  projectSlug: string;
  sourceSessionId: string;
  returnFocusTarget: HTMLElement | null;
  onClose(): void;
  onStarted(
    taskId: string,
    jobId: string,
    projectSlug: string,
    sourceSessionId: string,
  ): void;
}) {
  const projects = useScopedProjectsQuery();
  const projectId = projects.data?.find(
    (project) => project.slug === projectSlug,
  )?.id;
  const tasks = useTasksQuery(projectSlug, {
    requestScope: scope,
    enabled: !!projectId,
  });
  const start = useStartDeviceRecordingMutation(scope);
  const started = useRef<{
    taskId: string;
    jobId: string;
    projectSlug: string;
    sourceSessionId: string;
  } | null>(null);
  return (
    <TaskPicker
      target={{ sourceSessionId, projectSlug }}
      projectId={projectId}
      initiallyOpen
      hideTrigger
      returnFocusTarget={returnFocusTarget}
      triggerLabel="Record to Task"
      dialogTitle="Record to Task"
      eyebrow="Device recording"
      onClose={onClose}
      onAttached={() => {
        if (started.current)
          onStarted(
            started.current.taskId,
            started.current.jobId,
            started.current.projectSlug,
            started.current.sourceSessionId,
          );
      }}
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
        isPending: start.isPending,
      }}
      attach={async (taskId, target) => {
        const job = await start.mutateAsync({
          taskId,
          sourceSessionId: target.sourceSessionId,
          projectSlug: target.projectSlug,
          durationMs: 30000,
        });
        if (job.state === 'failed' || job.state === 'completed')
          throw new Error('Recording did not start.');
        started.current = {
          taskId,
          jobId: job.id,
          projectSlug: target.projectSlug,
          sourceSessionId: target.sourceSessionId,
        };
      }}
      successMessage={(task) => `Recording started for “${task.title}”.`}
      failureMessage="Could not start recording. Update Station or try again."
      submitLabel="Start recording"
      pendingLabel="Starting…"
    />
  );
}
