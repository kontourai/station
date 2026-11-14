import type { TaskRoomWorkRequestScope } from '@kontourai/station-sdk/project-task-rooms';
import { uploadTaskRoomAttachments } from '@kontourai/station-sdk/project-task-rooms';
import { useMemo } from 'react';
import { useRoomAttachments } from './useRoomAttachments';

/** A Task room's files, uploaded under this Task incarnation. */
export function useTaskRoomAttachments(
  taskId: string,
  taskCreatedAt: string,
  scope: TaskRoomWorkRequestScope | undefined,
  onChange: () => void,
) {
  const target = useMemo(
    () =>
      scope
        ? {
            owner: [scope.apiBase, scope.authorityKey, taskId, taskCreatedAt],
            label: 'Task',
            isCurrent: () => scope.isCurrent(),
            upload: (inputs: Parameters<typeof uploadTaskRoomAttachments>[3]) =>
              uploadTaskRoomAttachments(
                scope.apiBase,
                taskId,
                taskCreatedAt,
                inputs,
                { requestScope: scope },
              ),
          }
        : undefined,
    [scope, taskId, taskCreatedAt],
  );
  return useRoomAttachments(target, onChange);
}
