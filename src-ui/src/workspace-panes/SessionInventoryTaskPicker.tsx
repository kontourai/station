import type { StationSessionOutputRow } from '@kontourai/station-contracts/session-inventory';
import { useTasksQuery } from '@kontourai/station-sdk';
import { useKeepSessionOutputMutation } from '@kontourai/station-sdk/session-output-actions';
import { TaskPicker } from '../components/chat/TaskPicker';

/** Loaded only after a user explicitly chooses to keep a Session output. */
export function SessionInventoryTaskPicker({
  row,
  currentProjectId,
  requestScope,
  onClose,
}: {
  row: StationSessionOutputRow;
  currentProjectId?: string;
  requestScope: { apiBase: string; authorityKey: string };
  onClose(): void;
}) {
  const tasks = useTasksQuery(currentProjectId, {
    enabled: true,
    requestScope,
  });
  const keep = useKeepSessionOutputMutation();
  return (
    <TaskPicker
      target={row}
      triggerLabel="Keep output"
      dialogTitle="Keep output in Task"
      eyebrow="Session inventory"
      projectId={currentProjectId}
      adapter={{
        tasks: tasks.data,
        isLoading: tasks.isLoading,
        error: tasks.error,
        refetch: tasks.refetch,
        isPending: keep.isPending,
      }}
      initiallyOpen
      hideTrigger
      onClose={onClose}
      attach={(taskId, target) =>
        keep.mutateAsync({
          taskId,
          sessionId: target.output.ref.sessionId,
          eventId: target.output.ref.eventId,
          operationId: crypto.randomUUID(),
          requestScope,
        })
      }
      successMessage={() => 'Kept'}
    />
  );
}
