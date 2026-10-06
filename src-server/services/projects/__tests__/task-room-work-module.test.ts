import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { createTaskRoomContext } from '../task-room-context.js';
import {
  TaskRoomWorkModule,
  type TaskRoomWorkScope,
} from '../task-room-work-module.js';

const makeTempDir = trackTempDirs();
const scope: TaskRoomWorkScope = {
  projectId: 'project',
  projectSlug: 'demo',
  roomProjectId: 'room-project',
  taskCreatedAt: '2026-09-30T12:00:00.000Z',
  requesterId: 'alice',
};
const input = {
  operationId: 'request-1',
  agentId: 'researcher',
  prompt: 'Investigate the onboarding flow.',
};
async function file() {
  const root = makeTempDir('task-room-work-');
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

test('a lost acknowledgement preserves the selected brief across edits and stale new references never invoke', async () => {
  const path = await file();
  const bound = {
    taskId: 'task',
    projectId: scope.projectId,
    taskCreatedAt: scope.taskCreatedAt,
  };
  const original = createTaskRoomContext(bound, {
    title: 'Shared objective',
    description: 'Investigate onboarding',
    documentRevision: 'revision-1',
    text: 'Original agreed brief.',
  });
  if (!original) throw new Error('Missing context fixture');
  let current = original;
  const resolve = vi.fn(async () => current);
  const consumed: string[] = [];
  const start = vi.fn<Parameters<TaskRoomWorkModule['submit']>[4]>(
    async (_sessionId, _scope, _recheck, context) => {
      consumed.push(context?.text ?? '');
      throw new Error('lost acknowledgement after invocation');
    },
  );
  const intent = {
    ...input,
    context: { version: original.version, digest: original.digest },
  };
  const module = new TaskRoomWorkModule(path);
  const first = await module.submit(
    'task',
    'alice',
    intent,
    async () => scope,
    start,
    resolve,
  );
  expect(first).toMatchObject({
    kind: 'recorded',
    record: { state: 'indeterminate', context: original },
  });
  const edited = createTaskRoomContext(bound, {
    title: 'Shared objective',
    description: 'Investigate onboarding',
    documentRevision: 'revision-2',
    text: 'Changed brief after invocation.',
  });
  if (!edited) throw new Error('Missing edited context');
  current = edited;
  const replay = await new TaskRoomWorkModule(path).submit(
    'task',
    'alice',
    intent,
    async () => scope,
    start,
    resolve,
  );
  expect(replay).toMatchObject({
    kind: 'recorded',
    replayed: true,
    record: { context: original },
  });
  expect(resolve).toHaveBeenCalledOnce();
  expect(consumed).toEqual(['Original agreed brief.']);
  expect(
    await module.submit(
      'task',
      'alice',
      { ...intent, operationId: 'stale-new-request' },
      async () => scope,
      start,
      resolve,
    ),
  ).toEqual({ kind: 'refused', reason: 'context' });
  expect(start).toHaveBeenCalledOnce();
  expect(JSON.parse(await readFile(path, 'utf8')).records).toHaveLength(1);
});

test('settlement refuses a valid but substituted brief after invocation', async () => {
  const path = await file();
  const bound = {
    taskId: 'task',
    projectId: scope.projectId,
    taskCreatedAt: scope.taskCreatedAt,
  };
  const original = createTaskRoomContext(bound, {
    title: 'Objective',
    description: '',
    documentRevision: 'revision-1',
    text: 'Original brief.',
  });
  const replacement = createTaskRoomContext(bound, {
    title: 'Objective',
    description: '',
    documentRevision: 'revision-2',
    text: 'Substituted brief.',
  });
  if (!original || !replacement) throw new Error('Missing context fixture');
  const start = vi.fn<Parameters<TaskRoomWorkModule['submit']>[4]>(
    async (sessionId) => {
      const stored = JSON.parse(await readFile(path, 'utf8'));
      stored.records[0].context = replacement;
      await writeFile(path, JSON.stringify(stored));
      return { sessionId };
    },
  );
  await expect(
    new TaskRoomWorkModule(path).submit(
      'task',
      'alice',
      {
        ...input,
        context: { version: original.version, digest: original.digest },
      },
      async () => scope,
      start,
      async () => original,
    ),
  ).rejects.toThrow('identity changed before settlement');
  expect(start).toHaveBeenCalledOnce();
});
