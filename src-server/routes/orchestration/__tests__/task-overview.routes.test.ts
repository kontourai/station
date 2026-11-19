/**
 * #5064: the two Task routes the Project Overview reads and writes, over the
 * REAL `TaskGraphService` store: the reopen mark (`POST /:taskId/overview-reopen`)
 * and the one-line latest report on `GET /`.
 */
import { describe, expect, test, vi } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { TaskGraphService } from '../../../services/projects/task-graph-service.js';
import { createTaskRoutes } from '../tasks.js';

const makeTempDir = trackTempDirs();

const inertTaskDispatcher = {
  dispatch: vi.fn(async () => ({
    kind: 'failed' as const,
    reason: 'task dispatch is unavailable in this route fixture',
  })),
};

function service(home = makeTempDir('station-task-overview-')) {
  const workspace = makeTempDir('station-task-overview-workspace-');
  return {
    home,
    graph: new TaskGraphService(home, {
      projectService: {
        getProject: (slug: string) => {
          if (slug !== 'project-alpha') throw new Error('missing project');
          return {
            id: slug,
            slug,
            name: 'Project alpha',
            workingDirectory: workspace,
            createdAt: '2026-05-03T00:00:00.000Z',
            updatedAt: '2026-05-03T00:00:00.000Z',
          };
        },
      },
    }),
  };
}

describe('POST /:taskId/overview-reopen', () => {
  test('marks the Task reopened, durably, without editing it', async () => {
    const { home, graph } = service();
    const task = await graph.createTask({
      projectId: 'project-alpha',
      title: 'Ship it',
    });
    const app = createTaskRoutes(graph, {
      taskDispatcher: inertTaskDispatcher,
    });
    const before = Date.now();
    const response = await app.request(`/${task.id}/overview-reopen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(200);
    const body = (await readJson(response)) as {
      data: { overviewReopenedAt?: string; updatedAt: string };
    };
    const reopenedAt = Date.parse(body.data.overviewReopenedAt ?? '');
    expect(reopenedAt).toBeGreaterThanOrEqual(before - 1000);
    expect(body.data.updatedAt).toBe(task.updatedAt);
    // A second service reading the same store sees the mark.
    const reread = service(home).graph.readTask(task.id);
    expect(reread?.overviewReopenedAt).toBe(body.data.overviewReopenedAt);
  });

  test('refuses a settled Task, an unknown Task and an unexpected body', async () => {
    const { graph } = service();
    const task = await graph.createTask({
      projectId: 'project-alpha',
      title: 'Ship it',
    });
    await graph.updateTaskStatus(task.id, 'canceled');
    const app = createTaskRoutes(graph, {
      taskDispatcher: inertTaskDispatcher,
    });
    const post = (id: string, body = '{}') =>
      app.request(`/${id}/overview-reopen`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
    expect((await post(task.id)).status).toBe(400);
    expect(graph.readTask(task.id)?.overviewReopenedAt).toBeUndefined();
    expect((await post('missing')).status).toBe(400);
    expect(
      (await post(task.id, '{"at":"2020-01-01T00:00:00.000Z"}')).status,
    ).toBe(400);
  });
});

test('with the Project Overview preview off, reopen refuses and writes nothing', async () => {
  const { graph } = service();
  const task = await graph.createTask({
    projectId: 'project-alpha',
    title: 'Ship it',
  });
  let enabled = false;
  const app = createTaskRoutes(graph, {
    taskDispatcher: inertTaskDispatcher,
    overviewPreview: {
      select: (branches) =>
        enabled ? branches.enabled() : branches.disabled(),
    },
  });
  const post = () =>
    app.request(`/${task.id}/overview-reopen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
  const refused = await post();
  expect(refused.status).toBe(404);
  await expect(readJson(refused)).resolves.toMatchObject({
    success: false,
    code: 'feature_preview_disabled',
    previewId: 'project-overview',
  });
  expect(graph.readTask(task.id)?.overviewReopenedAt).toBeUndefined();
  // The choice is read per request, not at composition.
  enabled = true;
  expect((await post()).status).toBe(200);
  expect(graph.readTask(task.id)?.overviewReopenedAt).toBeDefined();
});

describe('GET / latestReport', () => {
  test('carries each summary’s first line and when it was written', async () => {
    const { graph } = service();
    const reported = await graph.createTask({
      projectId: 'project-alpha',
      title: 'Reported',
    });
    const quiet = await graph.createTask({
      projectId: 'project-alpha',
      title: 'Quiet',
    });
    const currentSummaries = vi.fn(
      () =>
        new Map([
          [
            reported.id,
            {
              text: '\n## Fixed the flaky login test\n\nDetails follow.',
              createdAt: '2026-11-15T10:00:00.000Z',
            },
          ],
        ]),
    );
    const app = createTaskRoutes(graph, {
      taskDispatcher: inertTaskDispatcher,
      currentSummaries,
    });
    const response = await app.request('/?projectId=project-alpha');
    const body = (await readJson(response)) as {
      data: { id: string; latestReport?: { text: string; at: string } }[];
    };
    const byId = new Map(body.data.map((task) => [task.id, task]));
    expect(byId.get(reported.id)?.latestReport).toEqual({
      text: 'Fixed the flaky login test',
      at: '2026-11-15T10:00:00.000Z',
    });
    expect(byId.get(quiet.id)?.latestReport).toBeUndefined();
    // The batch is read once for the whole list.
    expect(currentSummaries).toHaveBeenCalledTimes(1);
  });

  test('a summary read that throws leaves the list intact', async () => {
    const { graph } = service();
    await graph.createTask({ projectId: 'project-alpha', title: 'Listed' });
    const app = createTaskRoutes(graph, {
      taskDispatcher: inertTaskDispatcher,
      currentSummaries: () => {
        throw new Error('task memory unavailable');
      },
    });
    const response = await app.request('/?projectId=project-alpha');
    expect(response.status).toBe(200);
    const body = (await readJson(response)) as { data: unknown[] };
    expect(body.data).toHaveLength(1);
  });
});
