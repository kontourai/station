import { DatabaseSync } from 'node:sqlite';
import type { ProjectMembershipScope } from '@kontourai/station-contracts/project-membership';
import { readProjectSharedTaskHistory } from '@kontourai/station-sdk/project-shared-tasks';
import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';
import { ProjectMembershipRefusal } from '../../../services/projects/project-membership-store.js';
import { ProjectSharedTaskService } from '../../../services/projects/project-shared-task-service.js';
import {
  ProjectSharedTaskRefusal,
  ProjectSharedTaskStore,
} from '../../../services/projects/project-shared-task-store.js';
import { createProjectSharedTaskRoutes } from '../project-shared-tasks.js';

const scope: ProjectMembershipScope = {
  stationId: 'station-1',
  localProjectId: 'project-1',
  localProjectSlug: 'example',
  portableProjectId: 'portable-1',
};
const admission = {
  shareId: '11111111-1111-4111-8111-111111111111',
  scope,
  taskId: 'task-1',
  taskCreatedAt: '2026-09-20T00:00:00.000Z',
  sharedAt: '2026-09-20T01:00:00.000Z',
  sharedBy: 'human:owner',
};
function fixture() {
  const authority = {
    current: vi.fn(async () => ({ principalId: 'human:member' })),
    operator: vi.fn(async () => {}),
    requireProjectRead: vi.fn(async () => {}),
  };
  const service = {
    list: vi.fn(async () => []),
    share: vi.fn(async () => admission),
    unshare: vi.fn(async () => ({ unshared: true })),
    admitRead: vi.fn(async () => admission),
    revalidate: vi.fn(async () => {}),
    revalidateSummary: vi.fn(async () => {}),
  };
  const room = {
    sharedHistory: vi.fn(async () => ({
      kind: 'available',
      records: [
        {
          actor: { kind: 'human', label: 'Member' },
          sequence: 1,
          body: { kind: 'human-message', text: 'shared note' },
          digests: { proposal: 'a'.repeat(64), checkpoint: 'b'.repeat(64) },
          integrity: 'L0',
        },
        {
          actor: { kind: 'agent', label: 'Agent' },
          sequence: 2,
          body: { kind: 'live-work-started', sessionId: 'private-session' },
          digests: { proposal: 'c'.repeat(64), checkpoint: 'd'.repeat(64) },
          integrity: 'L0',
        },
      ],
      checkpoint: {
        throughSeq: 2,
        checkpointDigest: 'b'.repeat(64),
        retainedAnchorSeq: 0,
        retainedAnchorDigest: 'e'.repeat(64),
      },
      hasMore: false,
      integrity: 'L0',
    })),
    sharedDocument: vi.fn(async () => ({
      kind: 'snapshot',
      revision: 'revision-1',
      text: 'shared document',
    })),
  };
  const routes = createProjectSharedTaskRoutes({
    service: service as never,
    room: room as never,
    scope: vi.fn(async () => scope),
    authority: vi.fn(async () => authority),
  });
  const app = new Hono().route('/api/projects', routes);
  return { app, authority, service, room };
}
describe('project shared Task routes', () => {
  test('publishes only human room history and rechecks admission through delivery', async () => {
    const h = fixture();
    const response = await h.app.request(
      '/api/projects/example/shared-work/task-1/history',
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { records: unknown[] } };
    expect(body.data.records).toHaveLength(1);
    expect(JSON.stringify(body)).toContain('shared note');
    expect(JSON.stringify(body)).not.toContain('private-session');
    expect(h.room.sharedHistory).toHaveBeenCalledOnce();
    expect(h.service.admitRead).toHaveBeenCalledOnce();
    expect(h.service.revalidate).toHaveBeenCalledTimes(3);
  });
  test('revocation after worker read returns opaque 404 and no content', async () => {
    const h = fixture();
    h.service.revalidate.mockRejectedValue(
      new ProjectSharedTaskRefusal('not-found'),
    );
    const response = await h.app.request(
      '/api/projects/example/shared-work/task-1/document',
    );
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('shared document');
    expect(h.room.sharedDocument).toHaveBeenCalledOnce();
  });
  test('wrong Project membership remains an opaque 404', async () => {
    const h = fixture();
    h.service.admitRead.mockRejectedValue(
      new ProjectMembershipRefusal('forbidden'),
    );
    expect(
      (await h.app.request('/api/projects/example/shared-work/task-1/history'))
        .status,
    ).toBe(404);
  });
  test('operator share and exact unshare reach owning service callbacks', async () => {
    const h = fixture();
    expect(
      (
        await h.app.request('/api/projects/example/shared-work/task-1', {
          method: 'PUT',
        })
      ).status,
    ).toBe(201);
    expect(h.service.share).toHaveBeenCalledOnce();
    expect(
      (
        await h.app.request('/api/projects/example/shared-work/task-1', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shareId: admission.shareId }),
        })
      ).status,
    ).toBe(200);
    expect(h.service.unshare).toHaveBeenCalledOnce();
  });
  test('actual API/store defaults private, shares one Task and revokes it', async () => {
    const db = new DatabaseSync(':memory:');
    const tasks = new Map([
      [
        'task-1',
        {
          id: 'task-1',
          projectId: 'project-1',
          title: 'Shared',
          description: '',
          priority: 'normal',
          status: 'ready',
          createdBy: 'owner',
          createdAt: '2026-09-20T00:00:00.000Z',
          updatedAt: '2026-09-20T00:00:00.000Z',
        },
      ],
      [
        'private-task',
        {
          id: 'private-task',
          projectId: 'project-1',
          title: 'Private',
          description: '',
          priority: 'normal',
          status: 'ready',
          createdBy: 'owner',
          createdAt: '2026-09-20T00:00:00.000Z',
          updatedAt: '2026-09-20T00:00:00.000Z',
        },
      ],
    ]);
    const service = new ProjectSharedTaskService({
      store: new ProjectSharedTaskStore(db),
      readTask: (id) => tasks.get(id) as never,
      projectCandidates: () => [{ id: 'project-1', slug: 'example' }],
    });
    const owner = {
      current: vi.fn(async () => ({ principalId: 'human:owner' })),
      operator: vi.fn(async () => {}),
      requireProjectRead: vi.fn(async () => {}),
    };
    const routes = createProjectSharedTaskRoutes({
      service,
      room: fixture().room as never,
      scope: vi.fn(async () => scope),
      authority: vi.fn(async () => owner),
    });
    const app = new Hono().route('/api/projects', routes);
    expect(
      (await app.request('/api/projects/example/shared-work')).status,
    ).toBe(200);
    expect(
      (
        await app.request(
          '/api/projects/example/shared-work/private-task/history',
        )
      ).status,
    ).toBe(404);
    const shared = await app.request(
      '/api/projects/example/shared-work/task-1',
      { method: 'PUT' },
    );
    expect(shared.status).toBe(201);
    const shareId = ((await shared.json()) as { data: { shareId: string } })
      .data.shareId;
    expect(
      (await app.request('/api/projects/example/shared-work/task-1/history'))
        .status,
    ).toBe(200);
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request, init?: RequestInit) =>
        app.request(input instanceof Request ? input : String(input), init),
      ),
    );
    await expect(
      readProjectSharedTaskHistory('http://localhost', 'example', 'task-1', {
        authentication: 'omit',
      }),
    ).resolves.toMatchObject({ kind: 'available' });
    vi.unstubAllGlobals();
    expect(
      (
        await app.request('/api/projects/example/shared-work/task-1', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shareId }),
        })
      ).status,
    ).toBe(200);
    expect(
      (await app.request('/api/projects/example/shared-work/task-1/history'))
        .status,
    ).toBe(404);
    expect(owner.operator).toHaveBeenCalledTimes(4);
    db.close();
  });
});
