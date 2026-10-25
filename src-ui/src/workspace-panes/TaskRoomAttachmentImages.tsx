import type { TaskRoomAttachment } from '@kontourai/station-contracts/project-task-room';
import { fetchTaskRoomAttachment } from '@kontourai/station-sdk/project-task-rooms';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useHostRequestAuthorityScope } from '../contexts/ApiBaseContext';

function TaskAttachment({
  attachment,
  taskId,
  taskCreatedAt,
}: {
  attachment: TaskRoomAttachment;
  taskId: string;
  taskCreatedAt: string;
}) {
  const scope = useHostRequestAuthorityScope();
  const [preview, setPreview] = useState<{ blob: Blob; url: string }>();
  const query = useQuery({
    queryKey: [
      'task-room-attachment',
      scope?.apiBase,
      scope?.authorityKey,
      taskId,
      taskCreatedAt,
      attachment.id,
    ],
    enabled: !!scope && !!taskCreatedAt,
    retry: false,
    queryFn: async ({ signal }) => {
      if (!scope?.isCurrent()) throw new Error('Task connection changed.');
      const response = await fetchTaskRoomAttachment(
        scope.apiBase,
        taskId,
        taskCreatedAt,
        attachment.id,
        { requestScope: scope, signal },
      );
      if (!response.ok) throw new Error('Attachment is unavailable.');
      const bytes = await response.arrayBuffer();
      if (!scope.isCurrent()) throw new Error('Task connection changed.');
      return new Blob([bytes], { type: attachment.mimeType });
    },
  });
  useEffect(() => {
    setPreview(undefined);
    if (!query.data) return;
    const objectUrl = URL.createObjectURL(query.data);
    setPreview({ blob: query.data, url: objectUrl });
    return () => URL.revokeObjectURL(objectUrl);
  }, [query.data]);
  const url =
    preview?.blob === query.data && scope?.isCurrent()
      ? preview?.url
      : undefined;
  return (
    <li>
      {url && attachment.kind === 'image' ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open ${attachment.name}`}
        >
          <img src={url} alt={attachment.name} />
        </a>
      ) : null}
      {url && attachment.kind === 'file' ? (
        <a href={url} download={attachment.name}>
          {attachment.name}
        </a>
      ) : (
        <span>{attachment.name}</span>
      )}
      {query.isError && (
        <span role="status">
          Attachment unavailable. Choose the file again to resend it.
        </span>
      )}
    </li>
  );
}
export function TaskRoomAttachmentImages({
  attachments,
  taskId,
  taskCreatedAt,
}: {
  attachments?: TaskRoomAttachment[];
  taskId: string;
  taskCreatedAt: string;
}) {
  return attachments?.length ? (
    <ul className="task-room-attachment-images" aria-label="Attached files">
      {attachments.map((attachment) => (
        <TaskAttachment
          key={attachment.id}
          attachment={attachment}
          taskId={taskId}
          taskCreatedAt={taskCreatedAt}
        />
      ))}
    </ul>
  ) : null;
}
