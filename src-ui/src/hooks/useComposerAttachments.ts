import { ATTACHMENT_STAGING_MAX_CONCURRENT_UPLOADS } from '@kontourai/station-contracts/attachment-staging';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ComposerAttachmentStageUpdate } from '../lib/attachment-staging-queue';
import type { ComposerAttachmentStageSnapshot, FileAttachment } from '../types';

interface ComposerAttachmentCapabilities {
  images: boolean;
  files: boolean;
  imageRefusal?: string;
}

type StageTask = { file: FileAttachment; controller: AbortController };

function snapshotFor(
  attachment: FileAttachment,
): ComposerAttachmentStageSnapshot {
  return {
    clientAttachmentId: attachment.id,
    name: attachment.name,
    mimeType: attachment.type,
    size: attachment.size,
    ...(attachment.transformation
      ? { transformation: attachment.transformation }
      : {}),
    state: 'queued',
    progress: 0,
  };
}

function applyUpdate(
  snapshots: readonly ComposerAttachmentStageSnapshot[],
  update: ComposerAttachmentStageUpdate,
): ComposerAttachmentStageSnapshot[] {
  return snapshots.map((snapshot) => {
    if (snapshot.clientAttachmentId !== update.clientAttachmentId)
      return snapshot;
    const { error: _error, ...withoutError } = snapshot;
    return {
      ...withoutError,
      state: update.state,
      progress: update.progress,
      ...(update.stageId ? { stageId: update.stageId } : {}),
      ...(update.reference ? { reference: update.reference } : {}),
      ...(update.delivery ? { delivery: update.delivery } : {}),
      ...(update.error ? { error: update.error } : {}),
      needsFile: false,
    };
  });
}

function unavailable(
  stage: ComposerAttachmentStageSnapshot,
  hasBytes: boolean,
  message: string,
): ComposerAttachmentStageSnapshot {
  const { reference: _reference, delivery: _delivery, ...rest } = stage;
  return {
    ...rest,
    state: hasBytes ? 'retryable' : 'failed',
    progress: 0,
    needsFile: !hasBytes,
    error: message,
  };
}

/**
 * A per-file scheduler for picker, paste, and drop. It retains File bytes in
 * refs only; the ActiveChats projection receives just its compact stage
 * descriptor and opaque committed reference.
 */
export function useComposerAttachments(options: {
  apiBase: string;
  attachments: FileAttachment[];
  stages: ComposerAttachmentStageSnapshot[];
  capabilities: ComposerAttachmentCapabilities;
  onAddAttachments: (attachments: FileAttachment[]) => void;
  onReplaceAttachment?: (attachment: FileAttachment) => void;
  onStagesChange: (stages: ComposerAttachmentStageSnapshot[]) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const filesById = useRef(new Map<string, FileAttachment>());
  const tasks = useRef(new Map<string, StageTask>());
  const pending = useRef<string[]>([]);
  const running = useRef(new Set<string>());
  const stagesRef = useRef(options.stages);
  const pumpRef = useRef<() => void>(() => {});
  stagesRef.current = options.stages;

  const replaceStages = useCallback(
    (next: ComposerAttachmentStageSnapshot[]) => {
      stagesRef.current = next;
      options.onStagesChange(next);
    },
    [options],
  );
  const update = useCallback(
    (stageUpdate: ComposerAttachmentStageUpdate) =>
      replaceStages(applyUpdate(stagesRef.current, stageUpdate)),
    [replaceStages],
  );

  const pump = useCallback(() => {
    while (
      running.current.size < ATTACHMENT_STAGING_MAX_CONCURRENT_UPLOADS &&
      pending.current.length > 0
    ) {
      const clientAttachmentId = pending.current.shift()!;
      const task = tasks.current.get(clientAttachmentId);
      if (!task || task.controller.signal.aborted) continue;
      running.current.add(clientAttachmentId);
      void (async () => {
        try {
          // The SDK and queue are requested only by attachment interaction.
          const [{ stageComposerAttachments }, { xhrAttachmentStageUpload }] =
            await Promise.all([
              import('../lib/attachment-staging-queue'),
              import('@kontourai/station-sdk/client'),
            ]);
          await stageComposerAttachments(
            options.apiBase,
            [task.file],
            task.controller.signal,
            update,
            xhrAttachmentStageUpload,
          );
        } catch (failure) {
          if (!task.controller.signal.aborted) {
            const message =
              failure instanceof Error
                ? failure.message
                : 'Attachment staging failed.';
            const current = stagesRef.current.find(
              (stage) => stage.clientAttachmentId === clientAttachmentId,
            );
            if (current?.state !== 'complete') {
              update({
                clientAttachmentId,
                state: message.includes('does not advertise')
                  ? 'failed'
                  : 'retryable',
                progress: 0,
                error: message,
              });
            }
            setError(message);
          }
        } finally {
          running.current.delete(clientAttachmentId);
          tasks.current.delete(clientAttachmentId);
          pumpRef.current();
        }
      })();
    }
  }, [options.apiBase, update]);
  pumpRef.current = pump;

  const enqueue = useCallback((files: readonly FileAttachment[]) => {
    for (const file of files) {
      filesById.current.set(file.id, file);
      tasks.current.set(file.id, {
        file,
        controller: new AbortController(),
      });
      pending.current.push(file.id);
    }
    pumpRef.current();
  }, []);

  const selectFiles = useCallback(
    async (files: File[]) => {
      const { readChatAttachmentFiles } = await import(
        '../utils/chatAttachments'
      );
      const result = await readChatAttachmentFiles(
        files,
        options.attachments,
        options.capabilities,
      );
      if (result.attachments.length > 0) {
        replaceStages([
          ...stagesRef.current,
          ...result.attachments.map(snapshotFor),
        ]);
        options.onAddAttachments(result.attachments);
        enqueue(result.attachments);
      }
      setError(result.errors[0] ?? null);
    },
    [enqueue, options, replaceStages],
  );

  const replaceFile = useCallback(
    async (clientAttachmentId: string, files: File[]) => {
      const { readChatAttachmentFiles } = await import(
        '../utils/chatAttachments'
      );
      const result = await readChatAttachmentFiles(
        files,
        [],
        options.capabilities,
      );
      const replacement = result.attachments[0];
      if (!replacement) {
        setError(result.errors[0] ?? 'Choose a supported file to retry.');
        return;
      }
      const stable = { ...replacement, id: clientAttachmentId };
      options.onReplaceAttachment?.(stable);
      replaceStages(
        stagesRef.current.map((stage) =>
          stage.clientAttachmentId !== clientAttachmentId
            ? stage
            : { ...snapshotFor(stable) },
        ),
      );
      enqueue([stable]);
      setError(result.errors[0] ?? null);
    },
    [enqueue, options, replaceStages],
  );

  const retry = useCallback(
    async (clientAttachmentId: string) => {
      const file = filesById.current.get(clientAttachmentId);
      if (!file) {
        replaceStages(
          stagesRef.current.map((stage) =>
            stage.clientAttachmentId === clientAttachmentId
              ? unavailable(stage, false, 'Choose this file again to retry.')
              : stage,
          ),
        );
        return;
      }
      update({ clientAttachmentId, state: 'queued', progress: 0 });
      enqueue([file]);
    },
    [enqueue, replaceStages, update],
  );

  const cancel = useCallback(
    async (clientAttachmentId: string) => {
      const task = tasks.current.get(clientAttachmentId);
      task?.controller.abort();
      tasks.current.delete(clientAttachmentId);
      pending.current = pending.current.filter(
        (id) => id !== clientAttachmentId,
      );
      const stage = stagesRef.current.find(
        (entry) => entry.clientAttachmentId === clientAttachmentId,
      );
      if (stage?.stageId) {
        const { cancelAttachmentStage } = await import(
          '@kontourai/station-sdk/client'
        );
        await cancelAttachmentStage(options.apiBase, stage.stageId).catch(
          () => undefined,
        );
      }
      update({
        clientAttachmentId,
        state: 'cancelled',
        progress: 0,
        stageId: stage?.stageId,
      });
    },
    [options.apiBase, update],
  );

  const remove = useCallback(
    async (clientAttachmentId: string) => {
      await cancel(clientAttachmentId);
      filesById.current.delete(clientAttachmentId);
      replaceStages(
        stagesRef.current.filter(
          (stage) => stage.clientAttachmentId !== clientAttachmentId,
        ),
      );
    },
    [cancel, replaceStages],
  );

  // Reconcile at most five opaque ids on mount/reconnect, including completed
  // refs: completion is temporary authority, not a forever-ready claim.
  useEffect(() => {
    const stageIds = options.stages
      .filter((stage) => stage.stageId && stage.state !== 'cancelled')
      .slice(0, 5)
      .map((stage) => stage.stageId!);
    if (stageIds.length === 0) return;
    void import('@kontourai/station-sdk/client')
      .then(({ reconcileAttachmentStages }) =>
        reconcileAttachmentStages(options.apiBase, stageIds),
      )
      .then((statuses) => {
        for (const status of statuses) {
          const current = stagesRef.current.find(
            (stage) => stage.stageId === status.stageId,
          );
          if (!current) continue;
          if (status.state === 'complete') {
            update({
              clientAttachmentId: current.clientAttachmentId,
              state: 'complete',
              progress: 1,
              stageId: status.stageId,
              reference: status.reference,
              delivery: 'staged',
            });
          } else if (status.state === 'accepted') {
            // The exact bound turn was accepted and the server released its
            // bytes. This is not an expired upload the user may re-stage: a
            // retry here could create a second turn after an uncertain reply.
            replaceStages(
              stagesRef.current.map((stage) => {
                if (stage.clientAttachmentId !== current.clientAttachmentId)
                  return stage;
                const { reference: _reference, error: _error, ...rest } = stage;
                return {
                  ...rest,
                  state: 'accepted' as const,
                  progress: 1,
                  delivery: 'staged' as const,
                  needsFile: false,
                };
              }),
            );
          } else if (status.state === 'pending') {
            replaceStages(
              stagesRef.current.map((stage) =>
                stage.clientAttachmentId === current.clientAttachmentId
                  ? unavailable(
                      stage,
                      filesById.current.has(stage.clientAttachmentId),
                      'Attachment upload did not finish. Retry or choose the file again.',
                    )
                  : stage,
              ),
            );
          } else {
            replaceStages(
              stagesRef.current.map((stage) =>
                stage.clientAttachmentId === current.clientAttachmentId
                  ? unavailable(
                      stage,
                      filesById.current.has(stage.clientAttachmentId),
                      'Attachment stage expired. Retry or choose the file again.',
                    )
                  : stage,
              ),
            );
          }
        }
      })
      .catch(() => undefined);
  }, [options.apiBase, options.stages, replaceStages, update]);

  // Expiry gets an active timer as well as reconciliation, so a visible
  // complete chip never keeps claiming it is sendable after its TTL lapses.
  useEffect(() => {
    const now = Date.now();
    const deadlines = options.stages
      .filter((stage) => stage.state === 'complete' && stage.reference)
      .map((stage) => Date.parse(stage.reference!.expiresAt))
      .filter(Number.isFinite);
    if (deadlines.length === 0) return;
    const next = Math.min(...deadlines);
    const delay = Math.max(0, next - now);
    const timer = setTimeout(
      () => {
        const current = Date.now();
        replaceStages(
          stagesRef.current.map((stage) =>
            stage.state === 'complete' &&
            stage.reference &&
            Date.parse(stage.reference.expiresAt) <= current
              ? unavailable(
                  stage,
                  filesById.current.has(stage.clientAttachmentId),
                  'Attachment stage expired. Retry or choose the file again.',
                )
              : stage,
          ),
        );
      },
      Math.min(delay, 2_147_483_647),
    );
    return () => clearTimeout(timer);
  }, [options.stages, replaceStages]);

  const hasStages = options.stages.length > 0;
  const sendBlockedReason = !hasStages
    ? undefined
    : options.stages.some((stage) => stage.state === 'accepted')
      ? 'An attachment was accepted with its prior message. Wait for that turn before sending again.'
      : options.stages.some((stage) => stage.state !== 'complete')
        ? 'Wait until every selected file finishes staging before sending.'
        : undefined;

  return {
    error,
    selectFiles,
    replaceFile,
    setError,
    retry,
    cancel,
    remove,
    sendBlockedReason,
  };
}
