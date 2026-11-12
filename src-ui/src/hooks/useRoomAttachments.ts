import type { ChatAttachmentInput } from '@kontourai/station-contracts/chat-attachment';
import type { TaskRoomAttachment } from '@kontourai/station-contracts/project-task-room';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { inlineComposerAttachments } from '../lib/attachment-staging-queue';
import type { FileAttachment } from '../types';
import { readChatAttachmentFiles } from '../utils/chatAttachments';
import { describeStationFailure } from '../utils/stationFailure';

/** The connection a room's files go to, and how they are stored there. */
export interface RoomAttachmentTarget {
  /** Host, authority and room: files chosen for one never go to another. */
  readonly owner: readonly unknown[];
  /** Names the room in refusals ("Task connection changed."). */
  readonly label: string;
  isCurrent(): boolean;
  upload(inputs: ChatAttachmentInput[]): Promise<TaskRoomAttachment[]>;
}

/**
 * Files a person picks, pastes or drops for their next room message: read
 * locally, uploaded once when sent, and bound to the room they were chosen in.
 */
export function useRoomAttachments(
  target: RoomAttachmentTarget | undefined,
  onChange: () => void,
) {
  const [files, setFiles] = useState<FileAttachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const currentFiles = useRef(files);
  currentFiles.current = files;
  const owner = JSON.stringify(target?.owner ?? null);
  const label = target?.label ?? 'Room';
  const changed = `${label} connection changed.`;
  const choose = `${changed} Remove the files and choose them again.`;
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  const mounted = useRef(true);
  const cache = useRef<
    { files: FileAttachment[]; attachments: TaskRoomAttachment[] } | undefined
  >(undefined);
  const queue = useRef(Promise.resolve());
  const pendingReads = useRef(0);
  const generation = useRef(0);
  const fileOwner = useRef<string | undefined>(undefined);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const upload = useMutation({
    mutationFn: async () => {
      if (!target?.isCurrent()) throw new Error(changed);
      if (!files.length) return [];
      if (fileOwner.current !== owner) throw new Error(choose);
      const uploadGeneration = generation.current;
      if (cache.current?.files === files) return cache.current.attachments;
      const attachments = await target.upload(
        inlineComposerAttachments(files).map(
          ({ kind, name, mimeType, size, dataUrl }) => ({
            kind,
            name,
            mimeType,
            size,
            dataUrl,
          }),
        ),
      );
      if (
        !mounted.current ||
        currentOwner.current !== owner ||
        generation.current !== uploadGeneration ||
        !target.isCurrent()
      )
        throw new Error(changed);
      cache.current = { files, attachments };
      return attachments;
    },
    retry: false,
  });
  const selectFiles = (selected: File[]) => {
    onChange();
    if (fileOwner.current && fileOwner.current !== owner) {
      setError(choose);
      return Promise.resolve();
    }
    fileOwner.current = owner;
    const readGeneration = generation.current;
    setReading(true);
    pendingReads.current += 1;
    queue.current = queue.current
      .then(async () => {
        if (
          !mounted.current ||
          generation.current !== readGeneration ||
          currentOwner.current !== owner ||
          !target?.isCurrent()
        )
          return;
        const result = await readChatAttachmentFiles(
          selected,
          currentFiles.current,
          { images: true, files: true },
        );
        if (
          !mounted.current ||
          generation.current !== readGeneration ||
          currentOwner.current !== owner ||
          !target.isCurrent()
        )
          return;
        const next = [...currentFiles.current, ...result.attachments];
        currentFiles.current = next;
        setFiles(next);
        setError(result.errors.join(' ') || null);
      })
      .catch((cause: unknown) => {
        if (mounted.current && currentOwner.current === owner)
          setError(describeStationFailure(cause).body);
      })
      .finally(() => {
        pendingReads.current -= 1;
        if (mounted.current) setReading(pendingReads.current > 0);
      });
    return queue.current;
  };
  return {
    files,
    error,
    setError,
    selectFiles,
    busy: reading || upload.isPending,
    prepare: () => (files.length ? upload.mutateAsync() : Promise.resolve([])),
    remove: (id: string) => {
      onChange();
      const next = currentFiles.current.filter((file) => file.id !== id);
      currentFiles.current = next;
      setFiles(next);
      if (!next.length) fileOwner.current = undefined;
    },
    clear: () => {
      generation.current += 1;
      fileOwner.current = undefined;
      setFiles([]);
      currentFiles.current = [];
      cache.current = undefined;
      setError(null);
    },
  };
}
