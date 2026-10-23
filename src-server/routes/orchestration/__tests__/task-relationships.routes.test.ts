import { Hono } from 'hono';
import { expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { TaskGraphService } from '../../../services/projects/task-graph-service.js';
import {
  type TaskRelationshipAuthority,
  taskIdentity,
} from '../../../services/projects/task-relationship-state.js';
import { createTaskRelationshipRoutes } from '../task-relationships.js';

const temp = trackTempDirs();
test('mounted dedicated routes persist real hierarchy/chat mutations and deny stale or private projections', async () => {
  const graph = new TaskGraphService(temp('task-relationship-routes-'), {
    resolveProjectWorkspace: () => undefined,
  });
  const parent = await graph.createTask({
    projectId: 'project',
    title: 'outcome',
  });
  let current = true;
  let readable = true;
  let chatReadable = true;
  const access: TaskRelationshipAuthority = {
    expectedProject: { id: 'project', createdAt: '2026-10-01T00:00:00.000Z' },
    canonicalProject: (id) =>
      id === 'project'
        ? { id, createdAt: '2026-10-01T00:00:00.000Z' }
        : undefined,
    canMutateTask: () => current,
    canReadTask: (task) => current && (task.id === parent.id || readable),
    canReadConversation: (id) =>
      current && chatReadable && id === 'conversation',
  };
  const app = new Hono().route(
    '/api/tasks',
    createTaskRelationshipRoutes(graph, {
      authorityForRequest: async () => access,
      isCurrent: () => current,
    }),
  );
  const request = (path: string, method: string, input: unknown) =>
    app.request(`/api/tasks/${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
  const created = await request(`${parent.id}/children`, 'POST', {
    operationId: 'create',
    parent: taskIdentity(parent),
    task: { projectId: 'project', title: 'private deliverable' },
  });
  expect(created.status).toBe(200);
  const { data } = (await created.json()) as { data: { task: typeof parent } };
  const child = taskIdentity(data.task);
  expect(graph.readTask(child.taskId)?.parent).toEqual(taskIdentity(parent));
  const link = {
    operationId: 'link',
    task: child,
    conversationId: 'conversation',
    expectedRevision: 0,
  };
  expect(
    (await request(`${child.taskId}/work-chats`, 'POST', link)).status,
  ).toBe(200);
  const list = `/api/tasks/${child.taskId}/work-chats?taskCreatedAt=${encodeURIComponent(child.taskCreatedAt)}`;
  expect(
    ((await (await app.request(list)).json()) as { data: { chats: unknown[] } })
      .data.chats,
  ).toEqual([{ conversationId: 'conversation', revision: 1 }]);
  chatReadable = false;
  expect(
    ((await (await app.request(list)).json()) as { data: { chats: unknown[] } })
      .data.chats,
  ).toEqual([]);
  chatReadable = true;
  readable = false;
  const children = await app.request(
    `/api/tasks/${parent.id}/children?taskCreatedAt=${encodeURIComponent(parent.createdAt)}`,
  );
  expect(await children.json()).toEqual({
    success: true,
    data: { task: taskIdentity(parent), children: [] },
  });
  expect((await app.request(list)).status).toBe(404);
  readable = true;
  expect(
    (
      await request(`${child.taskId}/work-chats`, 'DELETE', {
        ...link,
        operationId: 'unlink',
        expectedRevision: 1,
      })
    ).status,
  ).toBe(200);
  expect(graph.listTaskWorkChats(child, access)).toEqual([]);
  const status = await app.request(
    `/api/tasks/${child.taskId}/work-chats/conversation?taskCreatedAt=${encodeURIComponent(child.taskCreatedAt)}`,
  );
  expect(((await status.json()) as { data: unknown }).data).toMatchObject({
    revision: 2,
    linked: false,
  });

  expect(
    (
      await request(`${child.taskId}/parent`, 'PUT', {
        operationId: 'detach',
        child,
        parent: null,
        expectedRevision: 1,
      })
    ).status,
  ).toBe(200);
  expect(graph.readTask(child.taskId)?.parent).toBeUndefined();
  current = false;
  expect(
    (
      await request(`${child.taskId}/parent`, 'PUT', {
        operationId: 'denied',
        child,
        parent: taskIdentity(parent),
        expectedRevision: 2,
      })
    ).status,
  ).toBe(404);
});

test('final delivery revocation withholds a committed child title', async () => {
  const graph = new TaskGraphService(temp('task-delivery-revocation-'), {
    resolveProjectWorkspace: () => undefined,
  });
  const parent = await graph.createTask({
    projectId: 'project',
    title: 'outcome',
  });
  const access: TaskRelationshipAuthority = {
    expectedProject: { id: 'project', createdAt: '2026-10-01T00:00:00.000Z' },
    canonicalProject: () => ({
      id: 'project',
      createdAt: '2026-10-01T00:00:00.000Z',
    }),
    canMutateTask: () => true,
    canReadTask: () => true,
    canReadConversation: () => true,
  };
  let deliveries = 0;
  const app = new Hono().route(
    '/api/tasks',
    createTaskRelationshipRoutes(graph, {
      authorityForRequest: async () => access,
      isCurrent: () => ++deliveries === 1,
    }),
  );
  const response = await app.request(`/api/tasks/${parent.id}/children`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      operationId: 'create',
      parent: taskIdentity(parent),
      task: { projectId: 'project', title: 'withheld private title' },
    }),
  });
  expect(response.status).toBe(404);
  expect(await response.text()).not.toContain('withheld private title');
  expect(graph.listTaskChildren(taskIdentity(parent), access)).toHaveLength(1);
});
