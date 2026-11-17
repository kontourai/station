/**
 * #5069: the lifecycle route, Delete's preview, and Delete itself, over real
 * Project storage and the real `ProjectLifecycleService`. The orchestration
 * is a fake set of running turns that only `interruptTurn` empties.
 */
import { describe, expect, test } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { putProject } from '../../../domain/__tests__/file-storage-test-helpers.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import { ProjectLifecycleService } from '../../../services/projects/project-lifecycle-service.js';
import { ProjectService } from '../../../services/projects/project-service.js';
import { createProjectRoutes } from '../projects.js';

const temp = trackTempDirs();

async function harness(options: { previewOn?: boolean } = {}) {
  let previewOn = options.previewOn ?? true;
  const home = temp('station-lifecycle-routes-');
  const storage = new FileStorageAdapter(home);
  const projects = new ProjectService(storage);
  await putProject(storage, {
    id: 'id-atlas',
    slug: 'atlas',
    name: 'Atlas',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  });
  const running = new Set(['a1', 'a2', 'a3']);
  const interrupted: string[] = [];
  const lifecycle = new ProjectLifecycleService({
    readProject: (slug) => projects.getProject(slug),
    listProjects: () => projects.listProjects(),
    writeLifecycle: (slug, next) => projects.setProjectLifecycle(slug, next),
    listActiveTurnThreadIds: () => [...running],
    resolveSessionProjectSlug: () => 'atlas',
    interruptTurn: async (threadId) => {
      interrupted.push(threadId);
      running.delete(threadId);
    },
    pollMs: 1,
  });
  const jobs = new Map([
    ['digest', 'id-atlas'],
    ['report', 'id-atlas'],
    ['elsewhere', 'id-birch'],
  ]);
  const app = createProjectRoutes(projects, storage, home, {
    listAgents: async () => [],
    projectLifecycle: lifecycle,
    projectLifecyclePreview: {
      select: (branches) =>
        previewOn ? branches.enabled() : branches.disabled(),
    },
    projectSchedules: {
      count: async (projectId) =>
        [...jobs.values()].filter((id) => id === projectId).length,
      removeAll: async (projectId) => {
        let removed = 0;
        for (const [name, id] of jobs)
          if (id === projectId) {
            jobs.delete(name);
            removed += 1;
          }
        return removed;
      },
    },
    countProjectTasks: () => 7,
    countProjectSessions: () => 12,
  });
  return {
    app,
    storage,
    running,
    interrupted,
    jobs,
    lifecycle,
    setPreview: (on: boolean) => {
      previewOn = on;
    },
  };
}

const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('POST /:slug/lifecycle', () => {
  test('Pause stops every running chat, stores the state, and Resume clears it', async () => {
    const { app, running, interrupted, storage, lifecycle } = await harness();

    const paused = await app.request(
      '/atlas/lifecycle',
      post({ action: 'pause' }),
    );
    expect(paused.status).toBe(200);
    expect(await json(paused)).toMatchObject({
      success: true,
      data: {
        lifecycle: { state: 'paused' },
        interrupted: 3,
        stillRunning: 0,
      },
    });
    expect(interrupted.sort()).toEqual(['a1', 'a2', 'a3']);
    expect(running.size).toBe(0);
    expect(storage.getProject('atlas').lifecycle?.state).toBe('paused');
    expect(lifecycle.admitTurn({ threadId: 'a1' }).allowed).toBe(false);
    // The Project list carries it, so the sidebar and banner can read it.
    expect(
      storage.listProjects().find((p) => p.slug === 'atlas')?.lifecycle,
    ).toMatchObject({ state: 'paused' });

    const resumed = await app.request(
      '/atlas/lifecycle',
      post({ action: 'resume' }),
    );
    expect(resumed.status).toBe(200);
    expect(storage.getProject('atlas').lifecycle).toBeUndefined();
    expect(lifecycle.admitTurn({ threadId: 'a1' }).allowed).toBe(true);
  });

  test('with the preview off, Pause and Archive are refused and stop nothing; Resume still lifts a hold', async () => {
    const { app, running, interrupted, storage, setPreview } = await harness();
    await app.request('/atlas/lifecycle', post({ action: 'pause' }));
    running.add('a1');
    interrupted.length = 0;
    setPreview(false);

    for (const action of ['pause', 'archive']) {
      const refused = await app.request('/atlas/lifecycle', post({ action }));
      expect(refused.status).toBe(404);
      expect(await json(refused)).toMatchObject({
        code: 'feature_preview_disabled',
        previewId: 'project-pause-archive',
      });
    }
    expect(interrupted).toEqual([]);
    expect(storage.getProject('atlas').lifecycle?.state).toBe('paused');

    const resumed = await app.request(
      '/atlas/lifecycle',
      post({ action: 'resume' }),
    );
    expect(resumed.status).toBe(200);
    expect(storage.getProject('atlas').lifecycle).toBeUndefined();
  });

  test('refuses an unknown action and an unknown Project', async () => {
    const { app } = await harness();
    expect(
      (await app.request('/atlas/lifecycle', post({ action: 'freeze' })))
        .status,
    ).toBe(400);
    expect(
      (await app.request('/nowhere/lifecycle', post({ action: 'pause' })))
        .status,
    ).toBe(404);
  });

  test('the ordinary update and create cannot write the state', async () => {
    const { app, storage } = await harness();
    const update = await app.request('/atlas', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lifecycle: { state: 'paused', changedAt: '2026-11-01T00:00:00.000Z' },
      }),
    });
    expect(update.status).toBe(400);
    expect(storage.getProject('atlas').lifecycle).toBeUndefined();
    const create = await app.request(
      '/',
      post({
        name: 'Birch',
        lifecycle: { state: 'archived', changedAt: '2026-11-01T00:00:00.000Z' },
      }),
    );
    expect(create.status).toBe(400);
  });
});

describe('Delete', () => {
  test('the preview counts what the delete then removes, stops and keeps', async () => {
    const { app, jobs, running } = await harness();
    const layout = await app.request(
      '/atlas/layouts',
      post({ slug: 'main', name: 'Main', type: 'chat' }),
    );
    expect(layout.status).toBe(201);

    const preview = await app.request('/atlas/deletion-preview');
    expect(preview.status).toBe(200);
    expect((await json(preview)).data).toEqual({
      removes: { layouts: 1, knowledgeDocuments: 0, schedules: 2 },
      stops: { runningSessions: 3 },
      keeps: { tasks: 7, sessions: 12 },
    });

    const deleted = await app.request('/atlas', { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    // Exactly the counted schedules are gone; another Project's stays.
    expect([...jobs.keys()]).toEqual(['elsewhere']);
    // Exactly the counted running chats were stopped.
    expect(running.size).toBe(0);
    expect((await app.request('/atlas')).status).toBe(404);
  });
});
