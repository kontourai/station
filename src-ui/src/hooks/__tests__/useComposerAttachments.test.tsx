/** @vitest-environment jsdom */

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type {
  ComposerAttachmentStageSnapshot,
  FileAttachment,
} from '../../types';

const stageComposerAttachments = vi.hoisted(() => vi.fn());
const readChatAttachmentFiles = vi.hoisted(() => vi.fn());
const { cancelAttachmentStage, reconcileAttachmentStages } = vi.hoisted(() => ({
  cancelAttachmentStage: vi.fn(),
  reconcileAttachmentStages: vi.fn(),
}));

vi.mock('../../lib/attachment-staging-queue', () => ({
  stageComposerAttachments,
}));
vi.mock('@kontourai/station-sdk/client', () => ({
  cancelAttachmentStage,
  reconcileAttachmentStages,
  xhrAttachmentStageUpload: vi.fn(),
}));
vi.mock('../../utils/chatAttachments', () => ({
  readChatAttachmentFiles,
}));

import { useComposerAttachments } from '../useComposerAttachments';

const attachment = (id: string): FileAttachment => ({
  id,
  name: `${id}.txt`,
  type: 'text/plain',
  size: 5,
  data: 'data:text/plain;base64,aGVsbG8=',
});

describe('useComposerAttachments', () => {
  beforeEach(() => {
    stageComposerAttachments.mockReset();
    readChatAttachmentFiles.mockReset();
    cancelAttachmentStage.mockReset();
    reconcileAttachmentStages.mockReset();
  });

  afterEach(() => vi.useRealTimers());
  test('cancelling either file leaves the other per-file task running', async () => {
    const first = attachment('first');
    const second = attachment('second');
    const controls = new Map<
      string,
      { signal: AbortSignal; resolve: () => void }
    >();
    stageComposerAttachments.mockImplementation(
      async (_apiBase, files, signal) =>
        await new Promise<void>((resolve, reject) => {
          controls.set(files[0].id, { signal, resolve });
          signal.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );
    readChatAttachmentFiles
      .mockResolvedValueOnce({ attachments: [first], errors: [] })
      .mockResolvedValueOnce({ attachments: [second], errors: [] });
    let stages: ComposerAttachmentStageSnapshot[] = [];
    const { result, rerender } = renderHook(
      ({ hookStages }) =>
        useComposerAttachments({
          apiBase: 'http://station.test',
          attachments: [],
          stages: hookStages,
          capabilities: { images: true, files: true },
          onAddAttachments: vi.fn(),
          onStagesChange: (next) => {
            stages = next;
          },
        }),
      { initialProps: { hookStages: stages } },
    );
    await act(async () => {
      await result.current.selectFiles([new File(['a'], 'first.txt')]);
    });
    rerender({ hookStages: stages });
    await act(async () => {
      await result.current.selectFiles([new File(['b'], 'second.txt')]);
    });
    await waitFor(() => expect(controls.size).toBe(2));
    expect(controls.get(first.id)?.signal.aborted).toBe(false);
    expect(controls.get(second.id)?.signal.aborted).toBe(false);
    await act(async () => {
      await result.current.cancel(first.id);
    });
    expect(controls.get(first.id)?.signal.aborted).toBe(true);
    expect(controls.get(second.id)?.signal.aborted).toBe(false);
    await act(async () => {
      await result.current.cancel(second.id);
    });
    expect(controls.get(second.id)?.signal.aborted).toBe(true);
  });

  test('reassociates a replacement File with the retained stable id', async () => {
    const original: ComposerAttachmentStageSnapshot = {
      clientAttachmentId: 'stable-file',
      name: 'expired.txt',
      mimeType: 'text/plain',
      size: 1,
      state: 'failed',
      progress: 0,
      needsFile: true,
    };
    const replacement = attachment('new-random-id');
    const onReplaceAttachment = vi.fn();
    readChatAttachmentFiles.mockResolvedValueOnce({
      attachments: [replacement],
      errors: [],
    });
    const { result } = renderHook(() =>
      useComposerAttachments({
        apiBase: 'http://station.test',
        attachments: [],
        stages: [original],
        capabilities: { images: true, files: true },
        onAddAttachments: vi.fn(),
        onReplaceAttachment,
        onStagesChange: vi.fn(),
      }),
    );
    await act(async () => {
      await result.current.replaceFile('stable-file', [
        new File(['new'], 'expired.txt'),
      ]);
    });
    expect(onReplaceAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'stable-file', data: replacement.data }),
    );
  });

  test('expires a completed reference into an actionable choose-file-again state', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T12:00:00.000Z'));
    let stages: ComposerAttachmentStageSnapshot[] = [
      {
        clientAttachmentId: 'expired-soon',
        name: 'soon.txt',
        mimeType: 'text/plain',
        size: 2,
        state: 'complete',
        progress: 1,
        delivery: 'staged',
        reference: {
          stageId: 'stage-soon',
          clientAttachmentId: 'expired-soon',
          source: 'current-composer',
          kind: 'file',
          name: 'soon.txt',
          mimeType: 'text/plain',
          size: 2,
          digest: `sha256-${'a'.repeat(64)}`,
          expiresAt: '2026-08-25T12:00:00.001Z',
        },
      },
    ];
    const onStagesChange = vi.fn((next) => {
      stages = next;
    });
    renderHook(() =>
      useComposerAttachments({
        apiBase: 'http://station.test',
        attachments: [],
        stages,
        capabilities: { images: true, files: true },
        onAddAttachments: vi.fn(),
        onStagesChange,
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(onStagesChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ state: 'failed', needsFile: true }),
    ]);
  });

  test('keeps an accepted tombstone non-sendable instead of offering a duplicate retry', async () => {
    const stage: ComposerAttachmentStageSnapshot = {
      clientAttachmentId: 'accepted-file',
      name: 'accepted.txt',
      mimeType: 'text/plain',
      size: 2,
      state: 'complete',
      progress: 1,
      stageId: 'stage-accepted',
      delivery: 'staged',
      reference: {
        stageId: 'stage-accepted',
        clientAttachmentId: 'accepted-file',
        source: 'current-composer',
        kind: 'file',
        name: 'accepted.txt',
        mimeType: 'text/plain',
        size: 2,
        digest: `sha256-${'a'.repeat(64)}`,
        expiresAt: '2030-01-01T00:00:00.000Z',
      },
    };
    reconcileAttachmentStages.mockResolvedValueOnce([
      {
        stageId: 'stage-accepted',
        state: 'accepted',
        expiresAt: '2030-01-01T00:00:00.000Z',
      },
    ]);
    let stages = [stage];
    const onStagesChange = vi.fn((next: ComposerAttachmentStageSnapshot[]) => {
      stages = next;
    });
    const { result, rerender } = renderHook(
      ({ hookStages }) =>
        useComposerAttachments({
          apiBase: 'http://station.test',
          attachments: [attachment('accepted-file')],
          stages: hookStages,
          capabilities: { images: true, files: true },
          onAddAttachments: vi.fn(),
          onStagesChange,
        }),
      { initialProps: { hookStages: stages } },
    );

    await waitFor(() =>
      expect(onStagesChange).toHaveBeenCalledWith([
        expect.objectContaining({
          state: 'accepted',
        }),
      ]),
    );
    expect(stages[0]).not.toHaveProperty('reference');
    rerender({ hookStages: stages });
    expect(result.current.sendBlockedReason).toContain('accepted');
  });

  test('keeps a committed sibling sendable when the same batch partially fails', async () => {
    const complete = attachment('complete');
    const retryable = attachment('retryable');
    let currentStages: ComposerAttachmentStageSnapshot[] = [];
    const onStagesChange = vi.fn((next: ComposerAttachmentStageSnapshot[]) => {
      currentStages = next;
    });
    stageComposerAttachments.mockImplementationOnce(
      async (_apiBase, _files, _signal, update) => {
        update({
          clientAttachmentId: complete.id,
          state: 'complete',
          progress: 1,
          delivery: 'staged',
          stageId: 'stage-complete',
          reference: {
            stageId: 'stage-complete',
            clientAttachmentId: complete.id,
            source: 'current-composer',
            kind: 'file',
            name: complete.name,
            mimeType: 'text/plain',
            size: complete.size,
            digest: `sha256-${'a'.repeat(64)}`,
            expiresAt: '2030-01-01T00:00:00.000Z',
          },
        });
        update({
          clientAttachmentId: retryable.id,
          state: 'retryable',
          progress: 0,
          error: 'network failed',
        });
        throw new AggregateError([new Error('network failed')], 'partial');
      },
    );
    readChatAttachmentFiles.mockResolvedValueOnce({
      attachments: [complete, retryable],
      errors: [],
    });
    const { result } = renderHook(() =>
      useComposerAttachments({
        apiBase: 'http://station.test',
        attachments: [],
        stages: currentStages,
        capabilities: { images: true, files: true },
        onAddAttachments: vi.fn(),
        onStagesChange,
      }),
    );

    await act(async () => {
      await result.current.selectFiles([new File(['x'], complete.name)]);
    });

    expect(onStagesChange).toHaveBeenLastCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          clientAttachmentId: complete.id,
          state: 'complete',
          stageId: 'stage-complete',
        }),
        expect.objectContaining({
          clientAttachmentId: retryable.id,
          state: 'retryable',
        }),
      ]),
    );
  });
});
