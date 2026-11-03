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
  const owner = new TaskDeviceRecording({
    admit: () => () => {},
    recordSource,
  });
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
  const owner = new TaskDeviceRecording({
    admit: () => () => {},
    recordSource,
  });
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
  const recorder = new TaskBrowserRecording({
    preview: { select: ({ enabled }: { enabled: () => boolean }) => enabled() },
  } as never);
  // The real shared limiter decides capacity; only the recording is stubbed.
  const owner = new TaskDeviceRecording({
    admit: (task) => recorder.admit(task),
    recordSource,
  });
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
  await recorder.dispose();
});

test('finished jobs do not consume recording capacity', async () => {
  const recorder = new TaskBrowserRecording({
    preview: { select: ({ enabled }: { enabled: () => boolean }) => enabled() },
  } as never);
  // The real shared limiter (two active per author) decides capacity; only
  // the recording itself is stubbed to fail.
  const owner = new TaskDeviceRecording({
    admit: (task) => recorder.admit(task),
    recordSource: async () => {
      throw new Error('failure');
    },
  });
  const source = async (): Promise<never> => {
    throw new Error('unused');
  };
  const failed = [
    owner.start(access('alice'), { durationMs: 1000 }, source),
    owner.start(access('alice'), { durationMs: 1000 }, source),
  ];
  for (const job of failed)
    await vi.waitFor(() =>
      expect(owner.status(access('alice'), job.id).state).toBe('failed'),
    );
  // Both slots came back: a third start is admitted, not refused.
  expect(owner.start(access('alice'), { durationMs: 1000 }, source).state).toBe(
    'starting',
  );
  await owner.dispose();
  await recorder.dispose();
});

test('device jobs report the shared recorder capacity refusal', async () => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const recorder = new TaskBrowserRecording({
    preview: { select: ({ enabled }: { enabled: () => boolean }) => enabled() },
  } as never);
  const owner = new TaskDeviceRecording(recorder);
  const source = vi.fn(async (): Promise<never> => {
    await waiting;
    throw new Error('released');
  });
  const first = owner.start(access('alice', 'a'), { durationMs: 1000 }, source);
  const second = owner.start(
    access('alice', 'b'),
    { durationMs: 1000 },
    source,
  );
  expect(() =>
    owner.start(access('alice', 'c'), { durationMs: 1000 }, source),
  ).toThrow('Recording capacity is exhausted.');
  expect(source).toHaveBeenCalledTimes(2);
  release();
  await vi.waitFor(() =>
    expect(owner.status(access('alice', 'a'), first.id).state).toBe('failed'),
  );
  await vi.waitFor(() =>
    expect(owner.status(access('alice', 'b'), second.id).state).toBe('failed'),
  );
  await owner.dispose();
  await recorder.dispose();
});

test('pre-admitted slots release after cancellation and source failure', async () => {
  const recorder = new TaskBrowserRecording({
    preview: { select: ({ enabled }: { enabled: () => boolean }) => enabled() },
  } as never);
  const task = access('alice');
  const hold = recorder.admit(task);
  const cancelled = recorder.admit(task);
  expect(() => recorder.admit(task)).toThrow('capacity');
  const controller = new AbortController();
  controller.abort();
  await expect(
    recorder.recordSource(
      task,
      {
        durationMs: 1000,
        signal: controller.signal,
        releaseAdmission: cancelled,
      },
      async () => {
        throw new Error('unused');
      },
    ),
  ).rejects.toMatchObject({ code: 'cancelled' });
  const failed = recorder.admit(task);
  await expect(
    recorder.recordSource(
      task,
      { durationMs: 1000, releaseAdmission: failed },
      async () => {
        throw new Error('source failed');
      },
    ),
  ).rejects.toThrow('source failed');
  const recovered = recorder.admit(task);
  recovered();
  hold();
  await recorder.dispose();
});

test('disabled Walkthroughs takes precedence over recording capacity and releases a reserved slot', async () => {
  let enabled = true;
  const recorder = new TaskBrowserRecording({
    preview: {
      select: (choices: { enabled: () => boolean; disabled: () => boolean }) =>
        enabled ? choices.enabled() : choices.disabled(),
    },
  } as never);
  const task = access('alice');
  const first = recorder.admit(task);
  const second = recorder.admit(task);
  enabled = false;
  const source = vi.fn(async (): Promise<never> => {
    throw new Error('unexpected');
  });
  await expect(
    recorder.recordSource(task, { durationMs: 1000 }, source),
  ).rejects.toMatchObject({ code: 'feature_preview_disabled' });
  await expect(
    recorder.recordSource(
      task,
      { durationMs: 1000, releaseAdmission: second },
      source,
    ),
  ).rejects.toMatchObject({ code: 'feature_preview_disabled' });
  expect(source).not.toHaveBeenCalled();
  enabled = true;
  const replacement = recorder.admit(task);
  replacement();
  first();
  await recorder.dispose();
});

test('shared recorder bounds active recordings Station-wide across owners', async () => {
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
  const active = ['alice', 'bob', 'carol', 'dave'].map((owner) =>
    recorder.recordSource(access(owner), { durationMs: 1000 }, source),
  );
  const extra = recorder.recordSource(
    access('erin'),
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

test('an out-of-bounds recording is refused as invalid even when capacity is full', async () => {
  const recorder = new TaskBrowserRecording({
    preview: { select: ({ enabled }: { enabled: () => boolean }) => enabled() },
  } as never);
  const task = access('alice');
  const holds = [recorder.admit(task), recorder.admit(task)];
  expect(() => recorder.admit(task)).toThrow('capacity');
  const resolveSource = vi.fn(async (): Promise<never> => {
    throw new Error('unused');
  });
  await expect(
    recorder.recordSource(task, { durationMs: 0 }, resolveSource),
  ).rejects.toMatchObject({ code: 'invalid-request' });
  expect(resolveSource).not.toHaveBeenCalled();
  for (const release of holds) release();
  await recorder.dispose();
});
