import { ATTACHMENT_STAGING_MAX_CONCURRENT_UPLOADS } from '@kontourai/station-contracts/attachment-staging';
import {
  CHAT_ATTACHMENT_MAX_COUNT,
  CHAT_ATTACHMENT_MAX_TOTAL_BYTES,
} from '@kontourai/station-contracts/chat-attachment';
import type { ApiRequestScope } from '@kontourai/station-sdk/client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComposerAttachmentStageUpdate } from '../lib/attachment-staging-queue';
import type {
  FileIntakeOperation,
  FileIntakeResult,
} from '../lib/conversation-file-intake';
import type { ComposerAttachmentStageSnapshot, FileAttachment } from '../types';

interface ComposerAttachmentCapabilities {
  images: boolean;
  files: boolean;
  imageRefusal?: string;
}

type StageTask = {
  file: FileAttachment;
  controller: AbortController;
  requestScope?: ApiRequestScope & { isCurrent?: () => boolean };
};

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
  ownerKey?: string;
  requestScope?: ApiRequestScope & { isCurrent?: () => boolean };
  cancelOnUnmount?: boolean;
  attachments: FileAttachment[];
  getCurrentAttachments?: () => FileAttachment[];
  getCurrentStages?: () => ComposerAttachmentStageSnapshot[];
  stages: ComposerAttachmentStageSnapshot[];
  capabilities: ComposerAttachmentCapabilities;
  onAddAttachments: (attachments: FileAttachment[]) => void;
  onReplaceAttachment?: (attachment: FileAttachment) => void;
  onStagesChange: (stages: ComposerAttachmentStageSnapshot[]) => void;
}) {
  const ownerKey = JSON.stringify([
    options.apiBase,
    options.ownerKey ?? '',
    options.requestScope?.authorityKey,
  ]);
  const currentOwner = useRef(ownerKey);
  currentOwner.current = ownerKey;
  const [errorState, setErrorState] = useState<{
    key: string;
    message: string | null;
  }>({ key: ownerKey, message: null });
  const error = errorState.key === ownerKey ? errorState.message : null;
  const setError = useCallback(
    (message: string | null) => {
      if (currentOwner.current === ownerKey)
        setErrorState({ key: ownerKey, message });
    },
    [ownerKey],
  );
  const owned = useMemo(
    () => ({
      key: ownerKey,
      generation: { current: 0 },
      filesById: { current: new Map<string, FileAttachment>() },
      tasks: { current: new Map<string, StageTask>() },
      fileScopes: { current: new Map<string, StageTask['requestScope']>() },
      pending: { current: [] as string[] },
      running: { current: new Set<string>() },
      reconciledStageIds: { current: new Set<string>() },
      stagesRef: { current: [] as ComposerAttachmentStageSnapshot[] },
      lastStages: {
        current: undefined as ComposerAttachmentStageSnapshot[] | undefined,
      },
      pumpRef: { current: () => {} },
    }),
    [ownerKey],
  );
  if (owned.lastStages.current !== options.stages) {
    owned.lastStages.current = options.stages;
    owned.stagesRef.current = options.stages;
  }
  for (const file of options.attachments) {
    if (
      typeof file.data === 'string' &&
      file.data.startsWith('data:') &&
      !owned.filesById.current.has(file.id)
    ) {
      owned.filesById.current.set(file.id, file);
      owned.fileScopes.current.set(file.id, options.requestScope);
    }
  }
  for (const id of owned.filesById.current.keys()) {
    if (
      !options.attachments.some((file) => file.id === id) &&
      !owned.tasks.current.has(id) &&
      !owned.pending.current.includes(id)
    ) {
      owned.filesById.current.delete(id);
      owned.fileScopes.current.delete(id);
    }
  }
  const currentStages = useCallback(
    () => options.getCurrentStages?.() ?? owned.stagesRef.current,
    [options.getCurrentStages, owned],
  );

  useEffect(
    () => () => {
      if (!options.cancelOnUnmount) return;
      owned.generation.current += 1;
      for (const task of owned.tasks.current.values()) task.controller.abort();
      owned.pending.current = [];
    },
    [options.cancelOnUnmount, owned],
  );

  const replaceStages = useCallback(
    (next: ComposerAttachmentStageSnapshot[]) => {
      owned.stagesRef.current = next;
      options.onStagesChange(next);
    },
    [options, owned],
  );
  const update = useCallback(
    (stageUpdate: ComposerAttachmentStageUpdate) =>
      replaceStages(applyUpdate(currentStages(), stageUpdate)),
    [replaceStages, currentStages],
  );

  const pump = useCallback(() => {
    while (
      owned.running.current.size < ATTACHMENT_STAGING_MAX_CONCURRENT_UPLOADS &&
      owned.pending.current.length > 0
    ) {
      const clientAttachmentId = owned.pending.current.shift()!;
      const task = owned.tasks.current.get(clientAttachmentId);
      if (!task || task.controller.signal.aborted) continue;
      owned.running.current.add(clientAttachmentId);
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
            (value) => {
              if (task.requestScope?.isCurrent?.() !== false) update(value);
            },
            xhrAttachmentStageUpload,
            task.requestScope,
          );
        } catch (failure) {
          if (
            !task.controller.signal.aborted &&
            task.requestScope?.isCurrent?.() !== false
          ) {
            const message =
              failure instanceof Error
                ? failure.message
                : 'Attachment staging failed.';
            const current = currentStages().find(
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
          owned.running.current.delete(clientAttachmentId);
          owned.tasks.current.delete(clientAttachmentId);
          owned.pumpRef.current();
        }
      })();
    }
  }, [options.apiBase, update, owned, setError, currentStages]);
  owned.pumpRef.current = pump;

  const enqueue = useCallback(
    (
      files: readonly FileAttachment[],
      requestScope?: StageTask['requestScope'],
    ) => {
      for (const file of files) {
        owned.filesById.current.set(file.id, file);
        owned.fileScopes.current.set(file.id, requestScope);
        owned.tasks.current.set(file.id, {
          file,
          controller: new AbortController(),
          requestScope,
        });
        owned.pending.current.push(file.id);
      }
      owned.pumpRef.current();
    },
    [owned],
  );

  const selectFilesWithResult = useCallback(
    async (
      files: File[],
      operation?: FileIntakeOperation,
    ): Promise<FileIntakeResult> => {
      const epoch = owned.generation.current;
      const scope = operation?.requestScope ?? options.requestScope;
      const current = () =>
        owned.generation.current === epoch &&
        !operation?.signal.aborted &&
        operation?.isCurrent?.() !== false &&
        scope?.isCurrent?.() !== false;
      if (!current())
        return {
          added: 0,
          errors: ['Station access changed before file intake.'],
        };
      const { readChatAttachmentFiles } = await import(
        '../utils/chatAttachments'
      );
      const result = await readChatAttachmentFiles(
        files,
        options.getCurrentAttachments?.() ?? options.attachments,
        options.capabilities,
      );
      if (!current())
        return {
          added: 0,
          errors: ['The target changed before file intake completed.'],
        };
      const existing = options.getCurrentAttachments?.() ?? options.attachments;
      if (
        existing.length + result.attachments.length >
          CHAT_ATTACHMENT_MAX_COUNT ||
        [...existing, ...result.attachments].reduce(
          (sum, file) => sum + file.size,
          0,
        ) > CHAT_ATTACHMENT_MAX_TOTAL_BYTES
      ) {
        const message =
          'The destination attachments changed while reading these files. Check its current files and try again.';
        setError(message);
        return { added: 0, errors: [message] };
      }
      if (result.attachments.length) {
        replaceStages([
          ...currentStages(),
          ...result.attachments.map(snapshotFor),
        ]);
        options.onAddAttachments(result.attachments);
        enqueue(result.attachments, scope);
      }
      setError(result.errors[0] ?? null);
      return { added: result.attachments.length, errors: result.errors };
    },
    [enqueue, options, replaceStages, owned, setError, currentStages],
  );
  const selectFiles = useCallback(
    async (files: File[]) => {
      await selectFilesWithResult(files);
    },
    [selectFilesWithResult],
  );

  const replaceFile = useCallback(
    async (clientAttachmentId: string, files: File[]) => {
      const epoch = owned.generation.current;
      if (options.requestScope?.isCurrent?.() === false) return;
      const { readChatAttachmentFiles } = await import(
        '../utils/chatAttachments'
      );
      const result = await readChatAttachmentFiles(
        files,
        [],
        options.capabilities,
      );
      if (
        owned.generation.current !== epoch ||
        options.requestScope?.isCurrent?.() === false
      )
        return;
      const replacement = result.attachments[0];
      if (!replacement) {
        setError(result.errors[0] ?? 'Choose a supported file to retry.');
        return;
      }
      const stable = { ...replacement, id: clientAttachmentId };
      options.onReplaceAttachment?.(stable);
      replaceStages(
        currentStages().map((stage) =>
          stage.clientAttachmentId !== clientAttachmentId
            ? stage
            : { ...snapshotFor(stable) },
        ),
      );
      enqueue([stable], options.requestScope);
      setError(result.errors[0] ?? null);
    },
    [enqueue, options, replaceStages, owned, setError, currentStages],
  );

  const retry = useCallback(
    async (clientAttachmentId: string) => {
      const scope =
        owned.fileScopes.current.get(clientAttachmentId) ??
        options.requestScope;
      if (scope?.isCurrent?.() === false) {
        setError(
          'The original Station access changed. Choose the files again after reconnecting.',
        );
        return;
      }
      const file = owned.filesById.current.get(clientAttachmentId);
      if (!file) {
        replaceStages(
          currentStages().map((stage) =>
            stage.clientAttachmentId === clientAttachmentId
              ? unavailable(stage, false, 'Choose this file again to retry.')
              : stage,
          ),
        );
        return;
      }
      setError(null);
      update({ clientAttachmentId, state: 'queued', progress: 0 });
      enqueue([file], scope);
    },
    [
      enqueue,
      options.requestScope,
      replaceStages,
      update,
      owned,
      setError,
      currentStages,
    ],
  );

  const cancel = useCallback(
    async (clientAttachmentId: string) => {
      const task = owned.tasks.current.get(clientAttachmentId);
      task?.controller.abort();
      owned.tasks.current.delete(clientAttachmentId);
      owned.pending.current = owned.pending.current.filter(
        (id) => id !== clientAttachmentId,
      );
      const stage = currentStages().find(
        (entry) => entry.clientAttachmentId === clientAttachmentId,
      );
      if (stage?.stageId) {
        const { cancelAttachmentStage } = await import(
          '@kontourai/station-sdk/client'
        );
        await cancelAttachmentStage(options.apiBase, stage.stageId, {
          requestScope:
            owned.fileScopes.current.get(clientAttachmentId) ??
            options.requestScope,
        }).catch(() => undefined);
      }
      update({
        clientAttachmentId,
        state: 'cancelled',
        progress: 0,
        stageId: stage?.stageId,
      });
    },
    [options.apiBase, options.requestScope, update, owned, currentStages],
  );

  const remove = useCallback(
    async (clientAttachmentId: string) => {
      await cancel(clientAttachmentId);
      owned.filesById.current.delete(clientAttachmentId);
      owned.fileScopes.current.delete(clientAttachmentId);
      replaceStages(
        currentStages().filter(
          (stage) => stage.clientAttachmentId !== clientAttachmentId,
        ),
      );
    },
    [cancel, replaceStages, owned, currentStages],
  );

  // Reconcile at most five opaque ids on mount/reconnect, including completed
  // refs: completion is temporary authority, not a forever-ready claim. An
  // uploading stage is still owned by this mount's transfer supervisor; its
  // prepared id is not yet a reconnect-recovery candidate.
  useEffect(() => {
    const stageIds = options.stages
      .filter(
        (stage) =>
          stage.stageId &&
          stage.state !== 'uploading' &&
          stage.state !== 'cancelled' &&
          !owned.reconciledStageIds.current.has(stage.stageId),
      )
      .slice(0, 5)
      .map((stage) => stage.stageId!);
    if (stageIds.length === 0) return;
    for (const stageId of stageIds)
      owned.reconciledStageIds.current.add(stageId);
    void import('@kontourai/station-sdk/client')
      .then(({ reconcileAttachmentStages }) =>
        reconcileAttachmentStages(options.apiBase, stageIds, {
          requestScope: options.requestScope,
        }),
      )
      .then((statuses) => {
        for (const status of statuses) {
          const current = currentStages().find(
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
              currentStages().map((stage) => {
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
              currentStages().map((stage) =>
                stage.clientAttachmentId === current.clientAttachmentId
                  ? unavailable(
                      stage,
                      owned.filesById.current.has(stage.clientAttachmentId),
                      'Attachment upload did not finish. Retry or choose the file again.',
                    )
                  : stage,
              ),
            );
          } else {
            replaceStages(
              currentStages().map((stage) =>
                stage.clientAttachmentId === current.clientAttachmentId
                  ? unavailable(
                      stage,
                      owned.filesById.current.has(stage.clientAttachmentId),
                      'Attachment stage expired. Retry or choose the file again.',
                    )
                  : stage,
              ),
            );
          }
        }
      })
      .catch(() => undefined);
  }, [
    options.apiBase,
    options.requestScope,
    options.stages,
    owned,
    currentStages,
    replaceStages,
    update,
  ]);

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
          currentStages().map((stage) =>
            stage.state === 'complete' &&
            stage.reference &&
            Date.parse(stage.reference.expiresAt) <= current
              ? unavailable(
                  stage,
                  owned.filesById.current.has(stage.clientAttachmentId),
                  'Attachment stage expired. Retry or choose the file again.',
                )
              : stage,
          ),
        );
      },
      Math.min(delay, 2_147_483_647),
    );
    return () => clearTimeout(timer);
  }, [options.stages, replaceStages, owned, currentStages]);

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
    selectFilesWithResult,
    replaceFile,
    setError,
    retry,
    cancel,
    remove,
    sendBlockedReason,
  };
}
