import type {
  StationBasisPaneExecutionActionInput,
  StationBasisPaneRequestScope,
} from '@kontourai/station-basis-pane/station-basis-pane';
import { useTasksQuery } from '@kontourai/station-sdk';
import { useAttachTaskToolResultReferenceMutation } from '@kontourai/station-sdk/task-tool-results';
import { useMemo } from 'react';
import {
  TaskPicker,
  type TaskPickerAdapter,
  type TaskPickerTask,
} from '../components/chat/TaskPicker';

/** The Task list and dialog load only after the direct-answer Keep action. */
export function BasisTaskPicker({
  input,
  currentProjectId,
  requestScope,
  onClose,
}: {
  input: StationBasisPaneExecutionActionInput;
  currentProjectId?: string;
  requestScope?: StationBasisPaneRequestScope;
  onClose(): void;
}) {
  const tasks = useTasksQuery(currentProjectId, {
    enabled: true,
    requestScope,
  });
  const attach = useAttachTaskToolResultReferenceMutation({ requestScope });
  const adapter = useMemo<TaskPickerAdapter>(
    () => ({
      tasks: tasks.data,
      isLoading: tasks.isLoading,
      error: tasks.error,
      refetch: tasks.refetch,
      isPending: attach.isPending,
    }),
    [attach.isPending, tasks.data, tasks.error, tasks.isLoading, tasks.refetch],
  );
  return (
    <TaskPicker
      target={{
        ref: input.ref,
        scope: input.scope,
        occurrenceKey: input.occurrenceKey,
      }}
      triggerLabel="Keep in Task"
      triggerAriaLabel="Keep this tool result in a Task"
      dialogTitle="Keep result in Task"
      eyebrow="Tool result"
      projectId={currentProjectId}
      adapter={adapter}
      initiallyOpen
      hideTrigger
      onClose={onClose}
      attach={(taskId, target) =>
        attach.mutateAsync({
          taskId,
          sessionId: target.ref.threadId,
          eventId: target.ref.resultId,
          sourceSurface: 'nativeBasis',
        })
      }
      successMessage={(task: TaskPickerTask) =>
        `Tool result kept in Task “${task.title}”.`
      }
    />
  );
}
