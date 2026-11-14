import type { TaskRoomAttachment } from '@kontourai/station-contracts/project-task-room';
import { fetchTaskRoomAttachment } from '@kontourai/station-sdk/project-task-rooms';
import { useMemo } from 'react';
import {
  RoomAttachmentList,
  type RoomAttachmentSource,
} from '../components/room/RoomAttachmentList';
import { useHostRequestAuthorityScope } from '../contexts/ApiBaseContext';

/** A Task room message's files, read under this Task incarnation. */
export function TaskRoomAttachmentImages({
  attachments,
  taskId,
  taskCreatedAt,
}: {
  attachments?: TaskRoomAttachment[];
  taskId: string;
  taskCreatedAt: string;
}) {
  const scope = useHostRequestAuthorityScope();
  const source = useMemo<RoomAttachmentSource>(
    () => ({
      key: ['task', scope?.apiBase, scope?.authorityKey, taskId, taskCreatedAt],
      enabled: !!scope && !!taskCreatedAt,
      isCurrent: () => !!scope?.isCurrent(),
      load: (attachment, signal) => {
        if (!scope) throw new Error('Task connection changed.');
        return fetchTaskRoomAttachment(
          scope.apiBase,
          taskId,
          taskCreatedAt,
          attachment.id,
          { requestScope: scope, signal },
        );
      },
    }),
    [scope, taskId, taskCreatedAt],
  );
  return <RoomAttachmentList attachments={attachments} source={source} />;
}
