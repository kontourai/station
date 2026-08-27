import {
  useCreateTaskReferenceMutation,
  useTasksQuery,
} from '@kontourai/station-sdk';
import { useAttachTaskUserInputReferenceMutation } from '@kontourai/station-sdk/task-user-input-references';
import { useMemo, useState } from 'react';
import {
  TaskPicker,
  type TaskPickerAdapter,
  type TaskPickerTask,
} from './TaskPicker';

export { ConnectedAnswerBasisAffordance } from './ConnectedAnswerBasisAffordance';

/** The exact, non-content identity carried by an answer attachment. */
export interface AttachAnswerToTaskInput {
  taskId: string;
  kind: 'turn';
  sessionId: string;
  turnId: string;
  sourceSurface: 'chat';
}

export interface AttachAnswerToTaskAdapter extends TaskPickerAdapter {
  attach: (input: AttachAnswerToTaskInput) => Promise<unknown>;
}

export interface AttachAnswerToTaskButtonProps {
  sessionId: string;
  turnId: string;
  projectId?: string;
  adapter: AttachAnswerToTaskAdapter;
  onOpen?: () => void;
}

export interface AttachUserInputToTaskAdapter extends TaskPickerAdapter {
  attach: (input: {
    taskId: string;
    sessionId: string;
    eventId: string;
    sourceSurface: 'chat';
  }) => Promise<unknown>;
}

function answerSuccess(task: TaskPickerTask) {
  return `Answer reference added to Task “${task.title}”.`;
}

/** Adds an exact completed assistant turn to an explicitly selected Task. */
export function AttachAnswerToTaskButton({
  sessionId,
  turnId,
  projectId,
  adapter,
  onOpen,
}: AttachAnswerToTaskButtonProps) {
  return (
    <TaskPicker
      target={{ sessionId, turnId }}
      triggerLabel="Add to Task"
      triggerAriaLabel={`Add this answer to a Task (turn ${turnId})`}
      dialogTitle="Add answer to Task"
      eyebrow="Answer reference"
      projectId={projectId}
      adapter={adapter}
      onOpen={onOpen}
      attach={(taskId, target) =>
        adapter.attach({
          taskId,
          kind: 'turn',
          sessionId: target.sessionId,
          turnId: target.turnId,
          sourceSurface: 'chat',
        })
      }
      successMessage={answerSuccess}
    />
  );
}

function useTaskPickerAdapter(projectId?: string) {
  const [queryEnabled, setQueryEnabled] = useState(false);
  const tasksQuery = useTasksQuery(projectId, { enabled: queryEnabled });
  return { tasksQuery, enableQuery: () => setQueryEnabled(true) };
}

/** SDK-connected completed-answer action. */
export function ConnectedAttachAnswerToTaskButton({
  sessionId,
  turnId,
  projectId,
}: Pick<AttachAnswerToTaskButtonProps, 'sessionId' | 'turnId' | 'projectId'>) {
  const { tasksQuery, enableQuery } = useTaskPickerAdapter(projectId);
  const attachMutation = useCreateTaskReferenceMutation();
  const adapter = useMemo<AttachAnswerToTaskAdapter>(
    () => ({
      tasks: tasksQuery.data,
      isLoading: tasksQuery.isLoading,
      error: tasksQuery.error,
      refetch: tasksQuery.refetch,
      isPending: attachMutation.isPending,
      attach: (input) => attachMutation.mutateAsync(input),
    }),
    [
      attachMutation.isPending,
      attachMutation.mutateAsync,
      tasksQuery.data,
      tasksQuery.error,
      tasksQuery.isLoading,
      tasksQuery.refetch,
    ],
  );
  return (
    <AttachAnswerToTaskButton
      sessionId={sessionId}
      turnId={turnId}
      projectId={projectId}
      adapter={adapter}
      onOpen={enableQuery}
    />
  );
}

export function AttachUserInputToTaskButton({
  sessionId,
  eventId,
  projectId,
  adapter,
  onOpen,
}: {
  sessionId: string;
  eventId: string;
  projectId?: string;
  adapter: AttachUserInputToTaskAdapter;
  onOpen?: () => void;
}) {
  return (
    <TaskPicker
      target={{ sessionId, eventId }}
      triggerLabel="Add input to Task"
      dialogTitle="Add input to Task"
      eyebrow="Pinned input"
      projectId={projectId}
      adapter={adapter}
      onOpen={onOpen}
      attach={(taskId, target) =>
        adapter.attach({
          taskId,
          sessionId: target.sessionId,
          eventId: target.eventId,
          sourceSurface: 'chat',
        })
      }
      successMessage={(task) => `Input added to Task “${task.title}”.`}
    />
  );
}

/** SDK-connected durable user-input action; optimistic rows cannot reach it. */
export function ConnectedAttachUserInputToTaskButton({
  sessionId,
  eventId,
  projectId,
}: {
  sessionId: string;
  eventId: string;
  projectId?: string;
}) {
  const { tasksQuery, enableQuery } = useTaskPickerAdapter(projectId);
  const attachMutation = useAttachTaskUserInputReferenceMutation();
  const adapter = useMemo<AttachUserInputToTaskAdapter>(
    () => ({
      tasks: tasksQuery.data,
      isLoading: tasksQuery.isLoading,
      error: tasksQuery.error,
      refetch: tasksQuery.refetch,
      isPending: attachMutation.isPending,
      attach: (input) => attachMutation.mutateAsync(input),
    }),
    [
      attachMutation.isPending,
      attachMutation.mutateAsync,
      tasksQuery.data,
      tasksQuery.error,
      tasksQuery.isLoading,
      tasksQuery.refetch,
    ],
  );
  return (
    <AttachUserInputToTaskButton
      sessionId={sessionId}
      eventId={eventId}
      projectId={projectId}
      adapter={adapter}
      onOpen={enableQuery}
    />
  );
}
