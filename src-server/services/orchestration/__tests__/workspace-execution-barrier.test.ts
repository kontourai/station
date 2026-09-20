import { expect, test, vi } from 'vitest';
import {
  WorkspaceExecutionBarrier,
  WorkspaceExecutionBusyError,
} from '../workspace-execution-barrier.js';

test('refuses restore while any same-workspace turn is active and admits another workspace', async () => {
  const barrier = new WorkspaceExecutionBarrier();
  const started = await barrier.runTurnStart('/repo', 'thread-a', async () =>
    Promise.resolve('started'),
  );
  expect(started).toBe('started');
  await expect(
    barrier.runExclusive('/repo', async () => 'restore'),
  ).rejects.toBeInstanceOf(WorkspaceExecutionBusyError);
  await expect(
    barrier.runExclusive('/other', async () => 'parallel'),
  ).resolves.toBe('parallel');
  barrier.releaseThread('thread-a');
  await expect(
    barrier.runExclusive('/repo', async () => 'restore'),
  ).resolves.toBe('restore');
});

test('blocks a new second-session start for the entire restore transaction', async () => {
  const barrier = new WorkspaceExecutionBarrier();
  let finishRestore!: () => void;
  const restore = barrier.runExclusive(
    '/repo',
    () => new Promise<void>((resolve) => (finishRestore = resolve)),
  );
  const start = vi.fn(async () => 'started');
  const pendingStart = barrier.runTurnStart('/repo', 'thread-b', start);
  await Promise.resolve();
  expect(start).not.toHaveBeenCalled();
  finishRestore();
  await restore;
  await expect(pendingStart).resolves.toBe('started');
});

test('terminal and runtime-error release the workspace reservation', async () => {
  const barrier = new WorkspaceExecutionBarrier();
  await barrier.runTurnStart('/repo', 'thread-a', async () => undefined);
  barrier.releaseThread('thread-a');
  await expect(
    barrier.runExclusive('/repo', async () => 'released'),
  ).resolves.toBe('released');
});

test('does not resurrect a turn that terminates before start acknowledgement', async () => {
  const barrier = new WorkspaceExecutionBarrier();
  let acknowledge!: () => void;
  const starting = barrier.runTurnStart(
    '/repo',
    'thread-fast',
    () => new Promise<void>((resolve) => (acknowledge = resolve)),
  );
  barrier.releaseThread('thread-fast');
  acknowledge();
  await starting;
  await expect(
    barrier.runExclusive('/repo', async () => 'restore'),
  ).resolves.toBe('restore');
});
