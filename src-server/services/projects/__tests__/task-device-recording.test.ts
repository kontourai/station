import {
  WALKTHROUGH_SCHEMA,
  type Walkthrough,
} from '@kontourai/station-contracts/walkthrough';
import { expect, test, vi } from 'vitest';
import type { TaskReviewAccess } from '../../orchestration/project-task-room-runtime.js';
import { TaskBrowserRecording } from '../task-browser-recording.js';
import { TaskDeviceRecording } from '../task-device-recording.js';

const access = (principalId: string, taskId = 'task'): TaskReviewAccess => ({
  kind: 'granted',
  staleOutcome: { kind: 'not-found' },
  write: {
    projectId: 'project',
    taskId,
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

test('starting jobs are cancellable and capacity is scoped to the Task and author', async () => {
  const recordSource = vi.fn(
    async (
      _access: TaskReviewAccess,
      input: Parameters<TaskBrowserRecording['recordSource']>[1],
    ): Promise<Walkthrough> => {
      await new Promise<void>((_resolve, reject) => {
        if (input.signal?.aborted) return reject(new Error('cancelled'));
        input.signal?.addEventListener(
          'abort',
          () => reject(new Error('cancelled')),
          { once: true },
        );
      });
      throw new Error('unexpected');
    },
  );
  const owner = new TaskDeviceRecording({ recordSource });
  const source = async (): Promise<never> => {
    throw new Error('unused');
  };
  const first = owner.start(access('alice'), { durationMs: 1000 }, source);
  owner.start(access('alice'), { durationMs: 1000 }, source);
  expect(() =>
    owner.start(access('alice'), { durationMs: 1000 }, source),
  ).toThrow('capacity');
  expect(owner.start(access('bob'), { durationMs: 1000 }, source).state).toBe(
    'starting',
  );
  expect(owner.stop(access('alice'), first.id).state).toBe('cancelled');
  await vi.waitFor(() =>
    expect(owner.status(access('alice'), first.id).state).toBe('cancelled'),
  );
  await owner.dispose();
});

test('finished jobs do not consume recording capacity', async () => {
  const owner = new TaskDeviceRecording({
    recordSource: async () => {
      throw new Error('failure');
    },
  });
  for (let i = 0; i < 12; i++) {
    const job = owner.start(access('alice'), { durationMs: 1000 }, async () => {
      throw new Error('unused');
    });
    await vi.waitFor(() =>
      expect(owner.status(access('alice'), job.id).state).toBe('failed'),
    );
  }
  await owner.dispose();
});

test('device job capacity is bounded across distinct Tasks and releases finished jobs', async () => {
  const pending: Array<() => void> = [];
  const owner = new TaskDeviceRecording({
    recordSource: async () => {
      await new Promise<void>((resolve) => pending.push(resolve));
      throw new Error('finished');
    },
  });
  const source = async (): Promise<never> => {
    throw new Error('unused');
  };
  const jobs = ['a', 'b', 'c', 'd'].map((taskId) =>
    owner.start(access('alice', taskId), { durationMs: 1000 }, source),
  );
  expect(() =>
    owner.start(access('alice', 'e'), { durationMs: 1000 }, source),
  ).toThrow('capacity');
  pending[0]!();
  await vi.waitFor(() =>
    expect(owner.status(access('alice', 'a'), jobs[0]!.id).state).toBe(
      'failed',
    ),
  );
  const next = owner.start(access('alice', 'e'), { durationMs: 1000 }, source);
  expect(next.state).toBe('starting');
  for (const finish of pending.slice(1)) finish();
  await owner.dispose();
});

test('shared recorder bounds active recordings across different Task keys', async () => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const recorder = new TaskBrowserRecording({
    preview: { select: ({ enabled }: { enabled: () => boolean }) => enabled() },
  } as never);
  const source = async (): Promise<never> => {
    await waiting;
    throw new Error('fixture released');
  };
  const active = ['a', 'b', 'c', 'd'].map((taskId) =>
    recorder.recordSource(
      access('alice', taskId),
      { durationMs: 1000 },
      source,
    ),
  );
  const extra = recorder.recordSource(
    access('alice', 'e'),
    { durationMs: 1000 },
    source,
  );
  const settled = Promise.allSettled([...active, extra]);
  release();
  const results = await settled;
  await recorder.dispose();
  expect(results[4]).toMatchObject({
    status: 'rejected',
    reason: {
      code: 'recording-unavailable',
      message: 'Recording capacity is exhausted.',
    },
  });
});
