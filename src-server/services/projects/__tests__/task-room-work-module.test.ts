import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import {
  TaskRoomWorkModule,
  type TaskRoomWorkScope,
} from '../task-room-work-module.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const scope: TaskRoomWorkScope = {
  projectId: 'project',
  projectSlug: 'demo',
  taskCreatedAt: '2026-09-30T12:00:00.000Z',
  requesterId: 'alice',
};
const input = {
  operationId: 'request-1',
  agentId: 'researcher',
  prompt: 'Investigate the onboarding flow.',
};
async function file() {
  const root = await mkdtemp(join(tmpdir(), 'task-room-work-'));
  roots.push(root);
  return join(root, 'requests.json');
}

test('concurrent submissions through independent store instances start one execution and retain its identity after restart', async () => {
  const path = await file();
  const a = new TaskRoomWorkModule(path),
    b = new TaskRoomWorkModule(path);
  const start = vi.fn(async (sessionId: string) => ({ sessionId }));
  const authorize = async () => scope;
  const results = await Promise.all([
    a.submit('task', 'alice', input, authorize, start),
    b.submit('task', 'alice', input, authorize, start),
  ]);
  expect(start).toHaveBeenCalledOnce();
  expect(results.every((r) => r.kind === 'recorded')).toBe(true);
  const stored = JSON.parse(await readFile(path, 'utf8'));
  expect(stored.records).toHaveLength(1);
  expect(stored.records[0].state).toBe('dispatched');
  const restarted = new TaskRoomWorkModule(path);
  expect(
    await restarted.submit('task', 'alice', input, authorize, start),
  ).toMatchObject({
    kind: 'recorded',
    replayed: true,
    record: { sessionId: stored.records[0].sessionId },
  });
  expect(start).toHaveBeenCalledOnce();
  expect(
    await restarted.submit(
      'task',
      'alice',
      { ...input, agentId: 'builder' },
      authorize,
      start,
    ),
  ).toEqual({ kind: 'refused', reason: 'conflict' });
});

test('a lost execution acknowledgement remains indeterminate and is not reinvoked', async () => {
  const path = await file();
  const start = vi.fn(async () => {
    throw new Error('response lost after execution started');
  });
  const module = new TaskRoomWorkModule(path);
  expect(
    await module.submit('task', 'alice', input, async () => scope, start),
  ).toMatchObject({ kind: 'recorded', record: { state: 'indeterminate' } });
  const replay = await new TaskRoomWorkModule(path).submit(
    'task',
    'alice',
    input,
    async () => scope,
    start,
  );
  expect(replay).toMatchObject({
    kind: 'recorded',
    replayed: true,
    record: { state: 'indeterminate' },
  });
  expect(start).toHaveBeenCalledOnce();
});

test('permission loss after reservation prevents execution and cannot expose a replayed request', async () => {
  const path = await file();
  const start = vi.fn(async (sessionId: string) => ({ sessionId }));
  const authorize = vi
    .fn()
    .mockResolvedValueOnce(scope)
    .mockResolvedValueOnce(undefined);
  const module = new TaskRoomWorkModule(path);
  expect(await module.submit('task', 'alice', input, authorize, start)).toEqual(
    { kind: 'refused', reason: 'access' },
  );
  expect(start).not.toHaveBeenCalled();
  expect(JSON.parse(await readFile(path, 'utf8')).records[0].state).toBe(
    'refused',
  );
  expect(
    await module.submit('task', 'alice', input, async () => undefined, start),
  ).toEqual({ kind: 'refused', reason: 'access' });
  expect(await module.list('task', async () => undefined)).toEqual({
    kind: 'refused',
  });
});

test('corrupt history fails closed before the provider is invoked', async () => {
  const path = await file();
  await writeFile(path, '{broken');
  const start = vi.fn(async (sessionId: string) => ({ sessionId }));
  await expect(
    new TaskRoomWorkModule(path).submit(
      'task',
      'alice',
      input,
      async () => scope,
      start,
    ),
  ).rejects.toThrow();
  expect(start).not.toHaveBeenCalled();
});

test('revocation during execution hides the reply while retaining the execution record', async () => {
  const path = await file();
  let granted = true;
  const authorize = async () => (granted ? scope : undefined);
  const start = vi.fn(async (sessionId: string) => {
    granted = false;
    return { sessionId };
  });
  const module = new TaskRoomWorkModule(path);
  expect(await module.submit('task', 'alice', input, authorize, start)).toEqual(
    { kind: 'refused', reason: 'access' },
  );
  expect(start).toHaveBeenCalledOnce();
  expect(JSON.parse(await readFile(path, 'utf8')).records[0].state).toBe(
    'dispatched',
  );
  expect(await module.list('task', authorize)).toEqual({ kind: 'refused' });
});
