import type { TaskRoomAttachment } from '@kontourai/station-contracts/project-task-room';
import type { TaskRoomWorkRequestScope } from '@kontourai/station-sdk/project-task-rooms';
import { uploadTaskRoomAttachments } from '@kontourai/station-sdk/project-task-rooms';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { inlineComposerAttachments } from '../lib/attachment-staging-queue';
import type { FileAttachment } from '../types';
import { readChatAttachmentFiles } from '../utils/chatAttachments';

export function useTaskRoomAttachments(
  taskId: string,
  taskCreatedAt: string,
  scope: TaskRoomWorkRequestScope | undefined,
  onChange: () => void,
) {
  const [files, setFiles] = useState<FileAttachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const currentFiles = useRef(files);
  currentFiles.current = files;
  const owner = JSON.stringify([
    scope?.apiBase,
    scope?.authorityKey,
    taskId,
    taskCreatedAt,
  ]);
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
      if (!scope?.isCurrent()) throw new Error('Task connection changed.');
      if (!files.length) return [];
      if (fileOwner.current !== owner)
        throw new Error(
          'Task connection changed. Remove the files and choose them again.',
        );
      const uploadGeneration = generation.current;
      if (cache.current?.files === files) return cache.current.attachments;
      const attachments = await uploadTaskRoomAttachments(
        scope.apiBase,
        taskId,
        taskCreatedAt,
        inlineComposerAttachments(files).map(
          ({ kind, name, mimeType, size, dataUrl }) => ({
            kind,
            name,
            mimeType,
            size,
            dataUrl,
          }),
        ),
        { requestScope: scope },
      );
      if (
        !mounted.current ||
        currentOwner.current !== owner ||
        generation.current !== uploadGeneration ||
        !scope.isCurrent()
      )
        throw new Error('Task connection changed.');
      cache.current = { files, attachments };
      return attachments;
    },
    retry: false,
  });
  const selectFiles = (selected: File[]) => {
    onChange();
    if (fileOwner.current && fileOwner.current !== owner) {
      setError(
        'Task connection changed. Remove the files and choose them again.',
      );
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
          !scope?.isCurrent()
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
          !scope.isCurrent()
        )
          return;
        const next = [...currentFiles.current, ...result.attachments];
        currentFiles.current = next;
        setFiles(next);
        setError(result.errors.join(' ') || null);
      })
      .catch((cause: unknown) => {
        if (mounted.current && currentOwner.current === owner)
          setError(
            cause instanceof Error ? cause.message : 'Files could not be read.',
          );
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
