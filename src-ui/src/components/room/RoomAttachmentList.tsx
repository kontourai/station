import type { TaskRoomAttachment } from '@kontourai/station-contracts/project-task-room';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { DocumentGlyph } from '../icons/Glyph';

/** How a room reads one file's bytes, bound to that room's authority. */
export interface RoomAttachmentSource {
  /** Identifies the room in the cache: host, authority and room. */
  readonly key: readonly unknown[];
  readonly enabled: boolean;
  isCurrent(): boolean;
  load(attachment: TaskRoomAttachment, signal: AbortSignal): Promise<Response>;
}

function RoomAttachmentItem({
  attachment,
  source,
}: {
  attachment: TaskRoomAttachment;
  source: RoomAttachmentSource;
}) {
  const [preview, setPreview] = useState<{ blob: Blob; url: string }>();
  const query = useQuery({
    queryKey: ['room-attachment', ...source.key, attachment.id],
    enabled: source.enabled,
    retry: false,
    queryFn: async ({ signal }) => {
      if (!source.isCurrent()) throw new Error('Room connection changed.');
      const response = await source.load(attachment, signal);
      if (!response.ok) throw new Error('Attachment is unavailable.');
      const bytes = await response.arrayBuffer();
      if (!source.isCurrent()) throw new Error('Room connection changed.');
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
    preview?.blob === query.data && source.isCurrent()
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
      {attachment.kind === 'file' ? (
        url ? (
          <a
            className="room-attachments__file"
            href={url}
            download={attachment.name}
          >
            <DocumentGlyph />
            <span>{attachment.name}</span>
          </a>
        ) : (
          <span className="room-attachments__file">
            <DocumentGlyph />
            <span>{attachment.name}</span>
          </span>
        )
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

/**
 * A message's files, as both rooms show them: images as thumbnails that open
 * full size, other files as a download link named for the file.
 */
export function RoomAttachmentList({
  attachments,
  source,
}: {
  attachments?: readonly TaskRoomAttachment[];
  source: RoomAttachmentSource;
}) {
  return attachments?.length ? (
    <ul className="room-attachments" aria-label="Attached files">
      {attachments.map((attachment) => (
        <RoomAttachmentItem
          key={attachment.id}
          attachment={attachment}
          source={source}
        />
      ))}
    </ul>
  ) : null;
}
