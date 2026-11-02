import {
  WALKTHROUGH_SCHEMA,
  type Walkthrough,
} from '@kontourai/station-contracts/walkthrough';
import { expect, test, vi } from 'vitest';
import type { TaskReviewAccess } from '../../orchestration/project-task-room-runtime.js';
import type { TaskBrowserRecording } from '../task-browser-recording.js';
import { TaskDeviceRecording } from '../task-device-recording.js';

const access = (principalId: string): TaskReviewAccess => ({
  kind: 'granted',
  staleOutcome: { kind: 'not-found' },
  write: {
    projectId: 'project',
    taskId: 'task',
    taskCreatedAt: '2026-01-01T00:00:00.000Z',
    author: { kind: 'person', principalId },
    beforeCommit: () => true,
  },
});

test('a human recording can be stopped only by the same Task author and publishes its result', async () => {
  let onStop!: () => void;
  const stopped = new Promise<void>((resolve) => {
    onStop = resolve;
  });
  const recordSource = vi.fn(
    async (
      _access: TaskReviewAccess,
      input: Parameters<TaskBrowserRecording['recordSource']>[1],
    ): Promise<Walkthrough> => {
      input.onStarted?.();
      await new Promise<void>((resolve, reject) => {
        input.stopSignal?.addEventListener(
          'abort',
          () => {
            onStop();
            resolve();
          },
          { once: true },
        );
        input.signal?.addEventListener(
          'abort',
          () => reject(new Error('cancelled')),
          { once: true },
        );
      });
      return {
        schema: WALKTHROUGH_SCHEMA,
        id: 'clip',
        createdAt: '2026-01-01T00:00:00.000Z',
        source: {
          adapter: 'test',
          adapterVersion: '1',
          durationMs: 1000,
          commit: 'a'.repeat(40),
          recording: {
            file: 'recording.webm',
            mediaType: 'video/webm',
            byteLength: 1,
            digest: `sha256:${'b'.repeat(64)}`,
          },
        },
        capture: { platform: 'ios' },
        coverage: {
          transcript: 'absent',
          frames: 'absent',
          marks: 'absent',
          elements: 'absent',
          route: 'absent',
          console: 'absent',
          network: 'absent',
        },
        events: [],
      };
    },
  );
  const owner = new TaskDeviceRecording({ recordSource });
  const job = owner.start(access('alice'), { durationMs: 1000 }, async () => {
    throw new Error('not used by fixture');
  });
  expect(owner.status(access('alice'), job.id).state).toBe('recording');
  expect(() => owner.status(access('bob'), job.id)).toThrow(
    'Recording not found',
  );
  expect(() => owner.stop(access('bob'), job.id)).toThrow(
    'Recording not found',
  );
  const result = owner.stop(access('alice'), job.id);
  expect(result.state).toBe('stopping');
  await stopped;
  await vi.waitFor(() =>
    expect(owner.status(access('alice'), job.id)).toMatchObject({
      state: 'completed',
      result: { walkthroughId: 'clip' },
    }),
  );
  await owner.dispose();
});

test('disposing the recording owner cancels in-flight work', async () => {
  let cancelled = false;
  const recordSource = vi.fn(
    async (
      _access: TaskReviewAccess,
      input: Parameters<TaskBrowserRecording['recordSource']>[1],
    ): Promise<Walkthrough> => {
      await new Promise<void>((_resolve, reject) =>
        input.signal?.addEventListener(
          'abort',
          () => {
            cancelled = true;
            reject(new Error('cancelled'));
          },
          { once: true },
        ),
      );
      throw new Error('unexpected completion');
    },
  );
  const owner = new TaskDeviceRecording({ recordSource });
  owner.start(access('alice'), { durationMs: 1000 }, async () => {
    throw new Error('not used by fixture');
  });
  await owner.dispose();
  expect(cancelled).toBe(true);
});
