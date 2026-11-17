import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_LIBRARY_V1 } from '@kontourai/station-contracts/project-library';
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { composeProjectLibraryRoutes } from '../../../runtime/routes/runtime-project-library.js';
import { bindStationControlRequestAuthority } from '../../../security/station-control-request-authority.js';
import { TaskOutputModule } from '../../../services/projects/task-output-module.js';
import type { StationControlCaller } from '../../../tools/station-control-shared.js';

const makeTempDir = trackTempDirs();
const PROJECT = { id: 'project-uuid-1', slug: 'research' };

type Task = { id: string; projectId: string; createdAt: string; title: string };

/**
 * One Station: a real Task output store and a real Library folder over a Task
 * graph the test can delete from, mounted exactly as the runtime mounts them.
 */
function station() {
  const home = makeTempDir('station-library-home-');
  const workspace = makeTempDir('station-library-workspace-');
  const tasks = new Map<string, Task>();
  const taskGraph = {
    readTask: (taskId: string) => tasks.get(taskId) ?? null,
    readTaskForOpen: async (taskId: string) => {
      const task = tasks.get(taskId);
      return task
        ? {
            ...task,
            workspaceBinding: {
              availability: 'available' as const,
              workingDirectory: workspace,
            },
          }
        : null;
    },
  };
  const outputs = new TaskOutputModule({
    homeDir: home,
    taskGraphService: taskGraph,
  });
  const internal = new WeakSet<Request>();
  const preview = { enabled: true };
  const library = composeProjectLibraryRoutes({
    hosted: false,
    homeDir: home,
    preview: {
      select: (branches) =>
        preview.enabled ? branches.enabled() : branches.disabled(),
    },
    outputs,
    readTask: taskGraph.readTask,
    isInternalRequest: (request) => internal.has(request),
    projectById: (id) => (id === PROJECT.id ? PROJECT : undefined),
    authorize: async (_request, slug) =>
      slug === PROJECT.slug
        ? { project: PROJECT, isCurrent: () => true }
        : undefined,
  });
  if (!library) throw new Error('a personal Station composes the Library');
  const app = new Hono()
    .route('/api/projects', library.projectRoutes)
    .route('/api/orchestration', library.sessionRoutes);
  /** A station-control call from a Session, as the authority guard binds it. */
  const sessionRequest = (
    path: string,
    caller: Partial<StationControlCaller>,
  ) => {
    const request = new Request(`http://station.test${path}`);
    internal.add(request);
    bindStationControlRequestAuthority(request, {
      kind: 'caller',
      caller: { sessionId: 'session-new', assurance: 'bound', ...caller },
      boundOperator: true,
    });
    return app.fetch(request);
  };
  return { app, home, workspace, tasks, outputs, preview, sessionRequest };
}

async function json(response: Response) {
  return (await response.json()) as {
    success: boolean;
    data?: any;
    code?: string;
  };
}

describe('Project Library routes', () => {
  test('a kept Task output is listed with its Task, and shows as orphaned once the Task is deleted', async () => {
    const { app, workspace, tasks, outputs } = station();
    // Tasks name their Project by slug (the Project page's own create path).
    tasks.set('task-a', {
      id: 'task-a',
      projectId: PROJECT.slug,
      createdAt: '2026-11-01T00:00:00.000Z',
      title: 'Write the report',
    });
    writeFileSync(join(workspace, 'report.txt'), 'quarterly findings');
    const kept = await outputs.create('task-a', {
      operationId: 'keep-report',
      relativePath: 'report.txt',
      title: 'Report',
      declaredMediaType: 'text/plain',
    });

    const before = await json(
      await app.request('/api/projects/research/library'),
    );
    expect(before.success).toBe(true);
    expect(before.data.version).toBe(PROJECT_LIBRARY_V1);
    expect(before.data.items).toEqual([
      expect.objectContaining({
        kind: 'task-output',
        outputId: kept.id,
        taskId: 'task-a',
        task: { state: 'present', title: 'Write the report' },
      }),
    ]);

    tasks.delete('task-a');
    const after = await json(
      await app.request('/api/projects/research/library'),
    );
    expect(after.data.items).toEqual([
      expect.objectContaining({
        kind: 'task-output',
        outputId: kept.id,
        task: { state: 'orphaned' },
      }),
    ]);
    // Orphaned, not gone: its bytes are still readable from the Library.
    const content = await app.request(
      `/api/projects/research/library/outputs/${kept.id}/content`,
    );
    expect(content.status).toBe(200);
    expect(await content.text()).toBe('quarterly findings');
  });

  test('a Task recreated under a reused id does not adopt the deleted Task’s files', async () => {
    const { app, workspace, tasks, outputs } = station();
    tasks.set('task-a', {
      id: 'task-a',
      projectId: PROJECT.slug,
      createdAt: '2026-11-01T00:00:00.000Z',
      title: 'First',
    });
    writeFileSync(join(workspace, 'a.txt'), 'a');
    await outputs.create('task-a', {
      operationId: 'keep-a',
      relativePath: 'a.txt',
      title: 'A',
    });
    tasks.set('task-a', {
      id: 'task-a',
      projectId: PROJECT.slug,
      createdAt: '2026-11-02T00:00:00.000Z',
      title: 'Second',
    });
    const page = await json(
      await app.request('/api/projects/research/library'),
    );
    expect(page.data.items[0].task).toEqual({ state: 'orphaned' });
  });

  test('uploads keep a folder layout, skip hidden files and node_modules, and can be removed', async () => {
    const { app } = station();
    const put = (path: string, body: string) =>
      app.request(
        `/api/projects/research/library/uploads?path=${encodeURIComponent(path)}`,
        { method: 'PUT', body },
      );
    expect((await put('notes/brief.md', '# Brief')).status).toBe(201);
    expect((await put('notes/.env', 'SECRET=1')).status).toBe(400);
    expect((await put('app/node_modules/x/index.js', 'x')).status).toBe(400);
    expect((await put('../escape.txt', 'x')).status).toBe(400);

    const page = await json(
      await app.request('/api/projects/research/library'),
    );
    expect(page.data.items).toEqual([
      expect.objectContaining({
        kind: 'upload',
        relativePath: 'notes/brief.md',
      }),
    ]);
    const content = await app.request(
      '/api/projects/research/library/uploads/content?path=notes%2Fbrief.md',
    );
    expect(await content.text()).toBe('# Brief');

    const removed = await app.request(
      '/api/projects/research/library/uploads?path=notes%2Fbrief.md',
      { method: 'DELETE' },
    );
    expect(removed.status).toBe(200);
    const empty = await json(
      await app.request('/api/projects/research/library'),
    );
    expect(empty.data.items).toEqual([]);
  });

  test('a link placed in the Library folder is never followed', async (context) => {
    const { app, home } = station();
    const outside = makeTempDir('station-library-outside-');
    writeFileSync(join(outside, 'secret.txt'), 'outside');
    const folder = join(home, 'project-library', PROJECT.id);
    mkdirSync(folder, { recursive: true });
    try {
      symlinkSync(outside, join(folder, 'linked'), 'junction');
    } catch {
      context.skip();
    }
    const page = await json(
      await app.request('/api/projects/research/library'),
    );
    expect(page.data.items).toEqual([]);
    const read = await app.request(
      '/api/projects/research/library/uploads/content?path=linked%2Fsecret.txt',
    );
    expect(read.status).not.toBe(200);
  });

  test('a Project the caller cannot open is not found', async () => {
    const { app } = station();
    expect((await app.request('/api/projects/other/library')).status).toBe(404);
  });

  test('a new Session in the Project reads an uploaded file through station-control', async () => {
    const { app, sessionRequest } = station();
    await app.request(
      '/api/projects/research/library/uploads?path=data%2Fplan.txt',
      {
        method: 'PUT',
        body: 'ship the library',
      },
    );
    const caller = {
      localProjectId: PROJECT.id,
      projectIdSource: 'session-record' as const,
    };
    const listed = await json(
      await sessionRequest(
        '/api/orchestration/station-control/project-library',
        caller,
      ),
    );
    expect(listed.data.items).toEqual([
      expect.objectContaining({
        kind: 'upload',
        relativePath: 'data/plan.txt',
      }),
    ]);
    const read = await json(
      await sessionRequest(
        '/api/orchestration/station-control/project-library/file?path=data%2Fplan.txt',
        caller,
      ),
    );
    expect(read.data).toEqual(
      expect.objectContaining({ encoding: 'utf-8', text: 'ship the library' }),
    );
  });

  test('a Session whose Project was only looked up by slug, or that has none, is refused', async () => {
    const { sessionRequest } = station();
    const lookedUp = await sessionRequest(
      '/api/orchestration/station-control/project-library',
      { localProjectId: PROJECT.id, projectIdSource: 'slug-lookup' },
    );
    expect(lookedUp.status).toBe(409);
    expect((await json(lookedUp)).code).toBe('no_project');
    const none = await sessionRequest(
      '/api/orchestration/station-control/project-library',
      {},
    );
    expect(none.status).toBe(409);
  });

  test('the Session route answers only Station’s own internal requests', async () => {
    const { app } = station();
    const response = await app.request(
      '/api/orchestration/station-control/project-library',
    );
    expect(response.status).toBe(404);
  });

  test('with the preview off, every route refuses before doing anything', async () => {
    const { app, home, preview, sessionRequest } = station();
    preview.enabled = false;
    const refusals = [
      await app.request('/api/projects/research/library'),
      await app.request('/api/projects/research/library/uploads?path=a.txt', {
        method: 'PUT',
        body: 'a',
      }),
      await app.request(
        '/api/projects/research/library/uploads/content?path=a.txt',
      ),
      await sessionRequest(
        '/api/orchestration/station-control/project-library',
        {
          localProjectId: PROJECT.id,
          projectIdSource: 'session-record',
        },
      ),
    ];
    for (const response of refusals) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual(
        expect.objectContaining({
          code: 'feature_preview_disabled',
          previewId: 'project-library',
        }),
      );
    }
    // The refused upload wrote nothing; turning the preview on shows that.
    preview.enabled = true;
    const page = await json(
      await app.request('/api/projects/research/library'),
    );
    expect(page.data.items).toEqual([]);
    expect(existsSync(join(home, 'project-library', PROJECT.id))).toBe(false);
  });

  test('a hosted Station composes no Library', () => {
    expect(
      composeProjectLibraryRoutes({
        hosted: true,
        homeDir: makeTempDir('station-library-hosted-'),
        preview: { select: (branches) => branches.enabled() },
        readTask: () => null,
        isInternalRequest: () => false,
        projectById: () => undefined,
        authorize: async () => undefined,
      }),
    ).toBeUndefined();
  });
});
