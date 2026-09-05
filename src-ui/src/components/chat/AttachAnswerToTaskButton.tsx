import {
  useCreateTaskReferenceMutation,
  useTasksQuery,
} from '@kontourai/station-sdk';
import { useAttachTaskUserInputReferenceMutation } from '@kontourai/station-sdk/task-user-input-references';
import { useMemo } from 'react';
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
  adapter,
  onOpen,
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
      onOpen={onOpen}
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

/**
 * The Task catalog for this conversation, plus the ONE fact that decides
 * whether the affordance is offered at all: does a Task exist to attach to.
 *
 * That is the same fact the picker's own empty state speaks — "Tasks are not
 * available" — and it used to be unknowable until after the click, because the
 * query was deferred until the dialog opened. So every user bubble in a chat
 * with no Tasks advertised a control whose only outcome was a dead end. React
 * Query keys this per project, so asking eagerly costs one request per
 * conversation however many bubbles ask it.
 *
 * `hasNoTasks` is true ONLY for a settled, genuinely empty catalog. A query in
 * flight or errored proves nothing, and withdrawing an affordance on no
 * information is the same defect facing the other way.
 */
function useTaskPickerAdapter(projectId?: string) {
  const tasksQuery = useTasksQuery(projectId);
  return {
    tasksQuery,
    hasNoTasks: tasksQuery.isSuccess && (tasksQuery.data?.length ?? 0) === 0,
  };
}

/** SDK-connected completed-answer action. */
export function ConnectedAttachAnswerToTaskButton({
  sessionId,
  turnId,
  projectId,
  menuItem,
}: Pick<
  AttachAnswerToTaskButtonProps,
  'sessionId' | 'turnId' | 'projectId' | 'menuItem'
>) {
  const { tasksQuery, hasNoTasks } = useTaskPickerAdapter(projectId);
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
  if (hasNoTasks) return null;
  return (
    <AttachAnswerToTaskButton
      sessionId={sessionId}
      turnId={turnId}
      projectId={projectId}
      menuItem={menuItem}
      adapter={adapter}
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
  const { tasksQuery, hasNoTasks } = useTaskPickerAdapter(projectId);
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
  if (hasNoTasks) return null;
  return (
    <AttachUserInputToTaskButton
      sessionId={sessionId}
      eventId={eventId}
      projectId={projectId}
      adapter={adapter}
    />
  );
}
