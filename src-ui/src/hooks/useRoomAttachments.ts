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

/** What one destination has staged: its files, whose room they are for, and its refusal. */
interface Staged {
  readonly files: FileAttachment[];
  /** The target owner the files were chosen under. */
  readonly owner?: string;
  readonly error: string | null;
}
const NOTHING: Staged = { files: [], error: null };

/**
 * Files a person picks, pastes or drops for their next room message: read
 * locally, uploaded once when sent, and bound to the room they were chosen in.
 *
 * `destination` names where the next message goes, the same key its draft is
 * kept under: a thread and its channel each keep their own files, so a file
 * chosen in a thread is never sent to the channel (#4812). `prepare` and
 * `clear` act on the destination they are asked for, which stays the one a
 * send started in even if the reader moves on before the upload finishes.
 */
export function useRoomAttachments(
  target: RoomAttachmentTarget | undefined,
  onChange: () => void,
  destination = '',
) {
  const [staged, setStaged] = useState<ReadonlyMap<string, Staged>>(
    () => new Map(),
  );
  const current = useRef(staged);
  current.current = staged;
  const [readingIn, setReadingIn] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );
  const here = staged.get(destination) ?? NOTHING;
  const owner = JSON.stringify(target?.owner ?? null);
  const label = target?.label ?? 'Room';
  const changed = `${label} connection changed.`;
  const choose = `${changed} Remove the files and choose them again.`;
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  const mounted = useRef(true);
  const cache = useRef(new WeakMap<FileAttachment[], TaskRoomAttachment[]>());
  const queue = useRef(Promise.resolve());
  const generations = useRef(new Map<string, number>());
  const generation = (to: string) => generations.current.get(to) ?? 0;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const update = (to: string, change: (entry: Staged) => Staged) => {
    const next = new Map(current.current);
    const entry = change(next.get(to) ?? NOTHING);
    if (entry.files.length || entry.error) next.set(to, entry);
    else next.delete(to);
    current.current = next;
    setStaged(next);
  };
  const reading = (to: string, by: number) =>
    setReadingIn((counts) => {
      const next = new Map(counts);
      const count = (next.get(to) ?? 0) + by;
      if (count > 0) next.set(to, count);
      else next.delete(to);
      return next;
    });
  const upload = useMutation({
    mutationFn: async (to: string) => {
      if (!target?.isCurrent()) throw new Error(changed);
      const entry = current.current.get(to) ?? NOTHING;
      const { files } = entry;
      if (!files.length) return [];
      if (entry.owner !== owner) throw new Error(choose);
      const uploadGeneration = generation(to);
      const cached = cache.current.get(files);
      if (cached) return cached;
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
        generation(to) !== uploadGeneration ||
        !target.isCurrent()
      )
        throw new Error(changed);
      cache.current.set(files, attachments);
      return attachments;
    },
    retry: false,
  });
  const selectFiles = (selected: File[]) => {
    onChange();
    const to = destination;
    const entry = current.current.get(to) ?? NOTHING;
    if (entry.owner && entry.owner !== owner) {
      update(to, (was) => ({ ...was, error: choose }));
      return Promise.resolve();
    }
    const readGeneration = generation(to);
    reading(to, 1);
    queue.current = queue.current
      .then(async () => {
        const live = () =>
          mounted.current &&
          generation(to) === readGeneration &&
          currentOwner.current === owner &&
          !!target?.isCurrent();
        if (!live()) return;
        const result = await readChatAttachmentFiles(
          selected,
          (current.current.get(to) ?? NOTHING).files,
          { images: true, files: true },
        );
        if (!live()) return;
        update(to, (was) => ({
          files: [...was.files, ...result.attachments],
          owner,
          error: result.errors.join(' ') || null,
        }));
      })
      .catch((cause: unknown) => {
        if (mounted.current && currentOwner.current === owner)
          update(to, (was) => ({
            ...was,
            error: describeStationFailure(cause).body,
          }));
      })
      .finally(() => {
        if (mounted.current) reading(to, -1);
      });
    return queue.current;
  };
  return {
    /** The destination these files and errors belong to. */
    destination,
    files: here.files,
    error: here.error,
    setError: (error: string | null, to = destination) =>
      update(to, (was) => ({ ...was, error })),
    selectFiles,
    busy:
      (readingIn.get(destination) ?? 0) > 0 ||
      (upload.isPending && upload.variables === destination),
    prepare: (to = destination) =>
      (current.current.get(to)?.files.length ?? 0)
        ? upload.mutateAsync(to)
        : Promise.resolve([]),
    remove: (id: string) => {
      onChange();
      update(destination, (was) => {
        const files = was.files.filter((file) => file.id !== id);
        return files.length ? { ...was, files } : { files, error: was.error };
      });
    },
    clear: (to = destination) => {
      generations.current.set(to, generation(to) + 1);
      update(to, () => NOTHING);
    },
  };
}
