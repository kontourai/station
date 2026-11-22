/**
 * #5063: the coordinator's HTTP leaves. The Project's limits are written
 * through `PUT /:slug/room-coordinator` into the real Project store, and the
 * `#general` leaves refuse with the preview's 404 while it is off.
 */
import type { ProjectConfig } from '@kontourai/station-contracts/project';
import { DEFAULT_PROJECT_ROOM_COORDINATOR_SETTINGS } from '@kontourai/station-contracts/project-room-coordinator';
import { describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import type { FeaturePreviewSelector } from '../../../services/feature-previews/feature-preview-registry.js';
import { ProjectRoomService } from '../../../services/projects/project-room-service.js';
import { createProjectRoomRuntime } from '../../../services/projects/project-room-store.js';
import { ProjectService } from '../../../services/projects/project-service.js';
import { createProjectRoomRoutes } from '../project-room-routes.js';
import { createProjectRoutes } from '../projects.js';

const NOW = '2026-11-17T00:00:00.000Z';
const makeTempDir = trackTempDirs();

function preview(on: { value: boolean }): FeaturePreviewSelector {
  return {
    select: (branches) => (on.value ? branches.enabled() : branches.disabled()),
  } as FeaturePreviewSelector;
}

describe('PUT /:slug/room-coordinator', () => {
  async function harness() {
    const home = makeTempDir('room-coordinator-settings-');
    const store = new FileStorageAdapter(home);
    const project: ProjectConfig = {
      id: 'p-id',
      slug: 'p',
      name: 'Project',
      createdAt: NOW,
      updatedAt: NOW,
    };
    await store.createProject(project);
    const on = { value: true };
    const app = createProjectRoutes(new ProjectService(store), store, home, {
      listAgents: async () => [],
      roomCoordinatorPreview: preview(on),
    });
    const put = (body: unknown) =>
      app.request('/p/room-coordinator', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    return { store, on, put };
  }

  it('stores the limits the coordinator then enforces', async () => {
    const { store, put } = await harness();
    const settings = {
      startWithoutAsking: true,
      maxConcurrentTasks: 3,
      pullRequests: 'when-asked',
    };
    expect((await put(settings)).status).toBe(200);
    expect(store.getProject('p').roomCoordinator).toEqual(settings);
  });

  it('refuses a limit outside 1–10 and unknown fields, and stores nothing', async () => {
    const { store, put } = await harness();
    expect(
      (
        await put({
          ...DEFAULT_PROJECT_ROOM_COORDINATOR_SETTINGS,
          maxConcurrentTasks: 0,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await put({
          ...DEFAULT_PROJECT_ROOM_COORDINATOR_SETTINGS,
          maxConcurrentTasks: 11,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await put({
          ...DEFAULT_PROJECT_ROOM_COORDINATOR_SETTINGS,
          unlimited: true,
        })
      ).status,
    ).toBe(400);
    expect(store.getProject('p').roomCoordinator).toBeUndefined();
  });

  it('refuses with the preview off and stores nothing', async () => {
    const { store, on, put } = await harness();
    on.value = false;
    const response = await put(DEFAULT_PROJECT_ROOM_COORDINATOR_SETTINGS);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      code: 'feature_preview_disabled',
      previewId: 'project-room-coordinator',
    });
    expect(store.getProject('p').roomCoordinator).toBeUndefined();
  });
});

describe('the #general coordinator leaves', () => {
  function harness() {
    const runtime = createProjectRoomRuntime(
      makeTempDir('room-coordinator-routes-'),
    );
    const scope = {
      stationId: 'station',
      localProjectId: 'project-id',
      portableProjectId: 'portable',
      localProjectSlug: 'project',
    };
    const actor = { id: 'ada', displayName: 'Ada', kind: 'person' as const };
    const caps = { view: true, discuss: true, edit: true, execute: true };
    const service = new ProjectRoomService(runtime.store, {
      withAction: async (_request, _slug, _action, _actorId, operation) =>
        operation(scope, actor, caps, () => {}),
      current: async () => true,
    });
    const { roomId } = runtime.store.ensureRoom(scope, () => {});
    const on = { value: true };
    const view = {
      projectSlug: 'project',
      settings: { ...DEFAULT_PROJECT_ROOM_COORDINATOR_SETTINGS },
      working: 0,
      waiting: 0,
      proposals: [],
    };
    const coordinator = {
      view: vi.fn(() => view),
      start: vi.fn(async () => view),
      sweep: vi.fn(async (input: { post(text: string): string }) => ({
        messageId: input.post('**Status:** nothing open.'),
        tasks: 0,
      })),
    };
    const posted: string[] = [];
    const routes = createProjectRoomRoutes(service, {
      module: {} as never,
      withAuthority: async (_request, _slug, action, guard, operation) => {
        if (action === 'execute' && guard?.expectedRoomId !== roomId)
          throw new Error('guard not passed');
        return operation({
          scope,
          requester: actor,
          executionRoot: '',
          assertCurrent: () => {},
        });
      },
      coordinator: {
        enabled: () => on.value,
        service: coordinator as never,
        roomId: () => roomId,
        post: (_authority, text) => {
          posted.push(text);
          return 'sweep-message';
        },
      },
    });
    const post = (path: string, body: unknown) =>
      routes.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const guards = {
      expectedRoomId: roomId,
      expectedProjectId: scope.localProjectId,
      expectedActorId: actor.id,
    };
    return {
      runtime,
      routes,
      on,
      coordinator,
      posted,
      post,
      guards,
      scope,
      roomId,
    };
  }

  it('answers the card view, and starts rows as the requesting person', async () => {
    const h = harness();
    try {
      expect((await h.routes.request('/project/room/coordinator')).status).toBe(
        200,
      );
      const started = await h.post(
        '/project/room/coordinator/proposals/card-1/start',
        { ...h.guards, rowIds: ['row-1'] },
      );
      expect(started.status).toBe(200);
      expect(h.coordinator.start).toHaveBeenCalledWith({
        scope: h.scope,
        roomId: h.roomId,
        proposalId: 'card-1',
        rowIds: ['row-1'],
        starter: { id: 'ada', displayName: 'Ada' },
      });
      // Start all names no rows.
      await h.post(
        '/project/room/coordinator/proposals/card-1/start',
        h.guards,
      );
      expect(h.coordinator.start).toHaveBeenNthCalledWith(2, {
        scope: h.scope,
        roomId: h.roomId,
        proposalId: 'card-1',
        starter: { id: 'ada', displayName: 'Ada' },
      });
    } finally {
      h.runtime.close();
    }
  });

  it('posts the status sweep to the room', async () => {
    const h = harness();
    try {
      const response = await h.post(
        '/project/room/coordinator/sweep',
        h.guards,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        data: { messageId: 'sweep-message', tasks: 0 },
      });
      expect(h.posted).toEqual(['**Status:** nothing open.']);
    } finally {
      h.runtime.close();
    }
  });

  it('refuses every leaf with the preview off, and starts nothing', async () => {
    const h = harness();
    h.on.value = false;
    try {
      for (const response of [
        await h.routes.request('/project/room/coordinator'),
        await h.post(
          '/project/room/coordinator/proposals/card-1/start',
          h.guards,
        ),
        await h.post('/project/room/coordinator/sweep', h.guards),
      ]) {
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({
          code: 'feature_preview_disabled',
          previewId: 'project-room-coordinator',
        });
      }
      expect(h.coordinator.start).not.toHaveBeenCalled();
      expect(h.coordinator.sweep).not.toHaveBeenCalled();
    } finally {
      h.runtime.close();
    }
  });
});
