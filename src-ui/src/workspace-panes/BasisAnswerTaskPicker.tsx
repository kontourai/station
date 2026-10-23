import { useTasksQuery } from '@kontourai/station-sdk';
import type { ApiRequestScope } from '@kontourai/station-sdk/client';
import { useKeepAnswerInTaskMutation } from '@kontourai/station-sdk/task-basis';
import { TaskPicker } from '../components/chat/TaskPicker';

export function BasisAnswerTaskPicker({
  target,
  currentProjectId,
  returnFocusTarget,
  onClose,
  onKept,
}: {
  target: { sessionId: string; turnId: string; requestScope: ApiRequestScope };
  currentProjectId?: string;
  returnFocusTarget: HTMLElement | null;
  onClose(): void;
  onKept(title: string): void;
}) {
  const tasks = useTasksQuery(currentProjectId, {
    requestScope: target.requestScope,
  });
  const keep = useKeepAnswerInTaskMutation();
  return (
    <TaskPicker
      target={target}
      projectId={currentProjectId}
      initiallyOpen
      hideTrigger
      triggerLabel="Keep in Task"
      dialogTitle="Keep answer in Task"
      eyebrow="Exact answer"
      returnFocusTarget={returnFocusTarget}
      onClose={onClose}
      onAttached={(task) => onKept(task.title)}
      adapter={{
        tasks: tasks.data,
        isLoading: tasks.isLoading,
        error: tasks.error,
        refetch: tasks.refetch,
        isPending: keep.isPending,
      }}
      attach={(taskId, captured) => keep.mutateAsync({ taskId, ...captured })}
      successMessage={(task) => `Answer kept in Task “${task.title}”.`}
    />
  );
}
