import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { createTaskWriteBackRoutes } from '../task-write-back.js';

const makeTempDir = trackTempDirs();
const closers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});
test('the Task read route returns only the authorized incarnation and refuses revoked or absent authority', async () => {
  const events = new EventStore(
    join(makeTempDir('station-write-back-route-'), 'orchestration.sqlite'),
  );
  closers.push(async () => {
    await events.close();
  });
  const store = events.taskWriteBackStore();
  const scope = {
    projectId: 'project',
    taskId: 'one',
    taskCreatedAt: '2026-10-24T00:00:00.000Z',
  };
  const admission = {
    ...scope,
    initiatedBy: { kind: 'person', id: 'owner' } as const,
    beforeCommit: () => true,
  };
  const target = {
    kind: 'chat',
    system: 'discord',
    destination: 'channel-1',
    action: 'message',
  } as const;
  expect(store.start({ ...admission, target }).ok).toBe(true);
  expect(store.start({ ...admission, taskId: 'two', target }).ok).toBe(true);
  let current = true;
  let revokeOnDelivery = false;
  let checks = 0;
  const app = new Hono();
  app.route(
    '/api/tasks',
    createTaskWriteBackRoutes({
      store,
      logger: { warn() {} },
      runtime: {
        personTaskReviewAccess: async ({ taskId, request }) => {
          if (request.headers.get('authorization') !== 'allowed')
            return { kind: 'not-found' as const };
          return {
            kind: 'granted' as const,
            staleOutcome: { kind: 'not-found' as const },
            write: {
              ...admission,
              taskId,
              author: { kind: 'person' as const, principalId: 'owner' },
              beforeCommit: () =>
                current && (!revokeOnDelivery || ++checks === 1),
            },
          };
        },
      },
    }),
  );
  const response = await app.request('/api/tasks/one/write-back', {
    headers: { authorization: 'allowed' },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toMatchObject({
    success: true,
    data: { entries: [{ taskId: 'one', target }] },
  });
  expect((await app.request('/api/tasks/one/write-back')).status).toBe(404);
  revokeOnDelivery = true;
  expect(
    (
      await app.request('/api/tasks/one/write-back', {
        headers: { authorization: 'allowed' },
      })
    ).status,
  ).toBe(404);
  revokeOnDelivery = false;
  current = false;
  expect(
    (
      await app.request('/api/tasks/one/write-back', {
        headers: { authorization: 'allowed' },
      })
    ).status,
  ).toBe(404);
});
