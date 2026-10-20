import {
  useCreateTaskReferenceMutation,
  useTasksQuery,
} from '@kontourai/station-sdk';
import { useAttachTaskUserInputReferenceMutation } from '@kontourai/station-sdk/task-user-input-references';
import { useMemo } from 'react';
import { requestTaskShaping } from '../../lib/task-shaping';
import {
  TaskPicker,
  type TaskPickerAdapter,
  type TaskPickerTask,
} from './TaskPicker';

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
  excerpt?: string;
  adapter: AttachAnswerToTaskAdapter;
  onOpen?: () => void;
  onClose?: () => void;
  returnFocusTarget?: HTMLElement | null;
  menuItem?: boolean;
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
  excerpt,
  adapter,
  onOpen,
  onClose,
  returnFocusTarget,
  menuItem,
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
      onNewTask={(source) =>
        requestTaskShaping({
          projectSlug: projectId,
          source: { ...source, excerpt },
        })
      }
      onOpen={onOpen}
      onClose={onClose}
      returnFocusTarget={returnFocusTarget}
      triggerRole={menuItem ? 'menuitem' : undefined}
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
  return { tasksQuery: useTasksQuery(projectId) };
}

/** SDK-connected completed-answer action. */
export function ConnectedAttachAnswerToTaskButton({
  sessionId,
  turnId,
  projectId,
  excerpt,
  menuItem,
  onOpen,
  onClose,
  returnFocusTarget,
}: Pick<
  AttachAnswerToTaskButtonProps,
  | 'sessionId'
  | 'turnId'
  | 'projectId'
  | 'excerpt'
  | 'menuItem'
  | 'onOpen'
  | 'onClose'
  | 'returnFocusTarget'
>) {
  const { tasksQuery } = useTaskPickerAdapter(projectId);
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
      excerpt={excerpt}
      menuItem={menuItem}
      onOpen={onOpen}
      onClose={onClose}
      returnFocusTarget={returnFocusTarget}
      adapter={adapter}
    />
  );
}

export function AttachUserInputToTaskButton({
  sessionId,
  eventId,
  projectId,
  excerpt,
  adapter,
  onOpen,
}: {
  sessionId: string;
  eventId: string;
  projectId?: string;
  excerpt?: string;
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
      onNewTask={(source) =>
        requestTaskShaping({
          projectSlug: projectId,
          source: { ...source, excerpt },
        })
      }
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
  excerpt,
}: {
  sessionId: string;
  eventId: string;
  projectId?: string;
  excerpt?: string;
}) {
  const { tasksQuery } = useTaskPickerAdapter(projectId);
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
      excerpt={excerpt}
      adapter={adapter}
    />
  );
}
