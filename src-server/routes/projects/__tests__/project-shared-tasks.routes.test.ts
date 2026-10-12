import { DatabaseSync } from 'node:sqlite';
import type { ProjectMembershipScope } from '@kontourai/station-contracts/project-membership';
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import {
  getProjectSharedTaskPublication,
  listProjectSharedTasks,
  readProjectSharedTaskDocument,
  readProjectSharedTaskHistory,
} from '@kontourai/station-sdk/project-shared-tasks';
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
    publication: vi.fn(async () => ({
      kind: 'unshared',
      project: scope,
      task: { id: admission.taskId, createdAt: admission.taskCreatedAt },
    })),
    share: vi.fn(async () => admission),
    unshare: vi.fn(async () => ({ unshared: true })),
    admitRead: vi.fn(async () => admission),
    revalidate: vi.fn(async () => {}),
    revalidateSummary: vi.fn(async () => {}),
  };
  const room = {
    sharedHistory: vi.fn(async (_input?: { current(): Promise<boolean> }) => ({
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
  test('rejects history records carrying fields outside the closed projection', async () => {
    const h = fixture();
    h.room.sharedHistory.mockResolvedValueOnce({
      kind: 'available',
      records: [
        {
          actor: { kind: 'human', label: 'Member' },
          sequence: 1,
          body: {
            kind: 'human-message',
            text: 'public text',
            attachmentPath: '/private/member/upload.txt',
          },
          digests: { proposal: 'a'.repeat(64), checkpoint: 'b'.repeat(64) },
          integrity: 'L0',
        },
      ],
      checkpoint: {
        throughSeq: 1,
        checkpointDigest: 'b'.repeat(64),
        retainedAnchorSeq: 0,
        retainedAnchorDigest: 'e'.repeat(64),
      },
      hasMore: false,
      integrity: 'L0',
    } as never);
    const response = await h.app.request(
      '/api/projects/example/shared-work/task-1/history',
    );
    expect(response.status).toBe(404);
    expect(await response.text()).not.toMatch(/public text|upload\.txt/);
  });
  test('reports an incomplete bounded room page as unavailable', async () => {
    const h = fixture();
    h.room.sharedHistory.mockResolvedValueOnce({
      ...(await h.room.sharedHistory()),
      hasMore: true,
      nextCursor: 'next-page',
    } as never);
    const response = await h.app.request(
      '/api/projects/example/shared-work/task-1/history',
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { kind: 'unavailable' },
    });
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
  test('revocation while room admission waits returns opaque 404', async () => {
    const h = fixture();
    h.room.sharedHistory.mockImplementationOnce(async (input) => {
      h.service.revalidate.mockRejectedValueOnce(
        new ProjectSharedTaskRefusal('not-found'),
      );
      return (await input!.current())
        ? ({ kind: 'available' } as never)
        : ({ kind: 'not-found' } as never);
    });
    const response = await h.app.request(
      '/api/projects/example/shared-work/task-1/history',
    );
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('shared note');
  });
  test('empty list still rechecks Project authority at response release', async () => {
    const h = fixture();
    h.authority.requireProjectRead.mockRejectedValueOnce(
      new ProjectMembershipRefusal('forbidden'),
    );
    const response = await h.app.request('/api/projects/example/shared-work');
    expect(response.status).toBe(404);
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
      await (
        await h.app.request('/api/projects/example/shared-work/task-1', {
          method: 'PUT',
        })
      ).json(),
    ).toMatchObject({
      data: { shareId: admission.shareId, taskId: admission.taskId },
    });
    const reviewed = await h.app.request(
      '/api/projects/example/shared-work/task-1',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project: scope,
          task: {
            id: admission.taskId,
            createdAt: admission.taskCreatedAt,
          },
        }),
      },
    );
    expect(reviewed.status).toBe(201);
    expect(await reviewed.json()).toMatchObject({ data: { kind: 'unshared' } });
    expect(h.service.share).toHaveBeenCalledTimes(2);
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
  test('operator-only publication status returns exact Project and Task identity', async () => {
    const h = fixture();
    const response = await h.app.request(
      '/api/projects/example/shared-work/task-1/publication',
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        kind: 'unshared',
        project: scope,
        task: { id: admission.taskId, createdAt: admission.taskCreatedAt },
      },
    });
    expect(h.service.publication).toHaveBeenCalledTimes(3);
  });
  test('publication authority ending before response release hides management state', async () => {
    const h = fixture();
    h.service.publication
      .mockResolvedValueOnce({
        kind: 'unshared',
        project: scope,
        task: { id: admission.taskId, createdAt: admission.taskCreatedAt },
      })
      .mockRejectedValueOnce(new ProjectMembershipRefusal('forbidden'));
    const response = await h.app.request(
      '/api/projects/example/shared-work/task-1/publication',
    );
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(admission.taskId);
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

// #3193: the member read path that MemberProjectPage depends on, through the
// real service, store and routes. Only the room producer is a stand-in.
function memberFixture() {
  const db = new DatabaseSync(':memory:');
  const record = (id: string, createdAt = '2026-09-20T00:00:00.000Z') =>
    ({
      id,
      projectId: 'project-1',
      title: `Task ${id}`,
      description: 'private description',
      priority: 'normal',
      status: 'ready',
      createdBy: 'owner',
      createdAt,
      updatedAt: createdAt,
    }) satisfies TaskRecord;
  const tasks = new Map<string, TaskRecord>(
    ['task-1', 'private-task', 'elsewhere-task', 'stale-task'].map((id) => [
      id,
      record(id),
    ]),
  );
  const store = new ProjectSharedTaskStore(db);
  const service = new ProjectSharedTaskService({
    store,
    readTask: (id) => tasks.get(id) ?? null,
    projectCandidates: () => [{ id: 'project-1', slug: 'example' }],
  });
  const owner = {
    current: vi.fn(async () => ({ principalId: 'human:owner' })),
    operator: vi.fn(async () => {}),
    requireProjectRead: vi.fn(async () => {}),
  };
  const member = {
    current: vi.fn(async () => ({ principalId: 'human:member' })),
    operator: vi.fn(async () => {
      throw new ProjectMembershipRefusal('forbidden');
    }),
    requireProjectRead: vi.fn(async (_scope: ProjectMembershipScope) => {}),
  };
  const app = (authority: typeof owner | typeof member) =>
    new Hono().route(
      '/api/projects',
      createProjectSharedTaskRoutes({
        service,
        room: fixture().room as never,
        scope: vi.fn(async () => scope),
        authority: vi.fn(async () => authority),
      }),
    );
  return {
    db,
    tasks,
    record,
    store,
    service,
    owner,
    member,
    ownerApp: app(owner),
    memberApp: app(member),
  };
}
async function exactResponse(response: Response) {
  return {
    status: response.status,
    headers: [...response.headers.entries()].sort(),
    body: await response.text(),
  };
}
describe('member publication read over the real service', () => {
  test('a member reads the shared summary, and history and document then open', async () => {
    const h = memberFixture();
    const shared = await h.ownerApp.request(
      '/api/projects/example/shared-work/task-1',
      { method: 'PUT' },
    );
    expect(shared.status).toBe(201);
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request, init?: RequestInit) =>
        h.memberApp.request(
          input instanceof Request ? input : String(input),
          init,
        ),
      ),
    );
    try {
      const options = { authentication: 'omit' as const };
      const [listed] = await listProjectSharedTasks(
        'http://localhost',
        'example',
        options,
      );
      expect(listed?.task.id).toBe('task-1');
      const publication = await getProjectSharedTaskPublication(
        'http://localhost',
        'example',
        'task-1',
        options,
      );
      // The member sees exactly the summary the shared-work list already
      // gives them; nothing more (no sharer, no description).
      expect(publication).toEqual({ kind: 'shared', publication: listed });
      // MemberProjectPage's gate (ProjectsContext `publicationIsCurrent`)
      // opens history and document only for a current shared publication.
      const gateOpens =
        publication.kind === 'shared' &&
        publication.publication.shareId === listed!.shareId &&
        publication.publication.task.createdAt === listed!.task.createdAt;
      expect(gateOpens).toBe(true);
      await expect(
        readProjectSharedTaskHistory(
          'http://localhost',
          'example',
          'task-1',
          options,
        ),
      ).resolves.toMatchObject({ kind: 'available' });
      await expect(
        readProjectSharedTaskDocument(
          'http://localhost',
          'example',
          'task-1',
          options,
        ),
      ).resolves.toMatchObject({ kind: 'snapshot', text: 'shared document' });
    } finally {
      vi.unstubAllGlobals();
    }
    const raw = (await (
      await h.memberApp.request(
        '/api/projects/example/shared-work/task-1/publication',
      )
    ).json()) as {
      data: { publication: { task: Record<string, unknown> } };
    };
    expect(Object.keys(raw.data.publication).sort()).toEqual([
      'project',
      'shareId',
      'sharedAt',
      'task',
      'version',
    ]);
    expect(Object.keys(raw.data.publication.task).sort()).toEqual([
      'createdAt',
      'id',
      'status',
      'title',
    ]);
    expect(JSON.stringify(raw)).not.toMatch(/human:owner|private description/);
    h.db.close();
  });
  test('a member cannot tell unshared, elsewhere, stale and missing Tasks apart', async () => {
    const h = memberFixture();
    await h.service.share(scope, 'task-1', h.owner);
    await h.service.share(
      { ...scope, portableProjectId: 'portable-elsewhere' },
      'elsewhere-task',
      h.owner,
    );
    await h.service.share(scope, 'stale-task', h.owner);
    h.tasks.set(
      'stale-task',
      h.record('stale-task', '2026-09-21T00:00:00.000Z'),
    );
    const read = async (taskId: string) =>
      exactResponse(
        await h.memberApp.request(
          `/api/projects/example/shared-work/${taskId}/publication`,
        ),
      );
    const missing = await read('no-such-task');
    expect(missing).toEqual({
      status: 404,
      headers: [
        ['cache-control', 'no-store'],
        ['content-type', 'application/json'],
      ],
      body: JSON.stringify({ success: false, error: 'Shared Task not found' }),
    });
    expect(await read('private-task')).toEqual(missing);
    expect(await read('elsewhere-task')).toEqual(missing);
    expect(await read('stale-task')).toEqual(missing);
    const shareId = h.store.admission('task-1')!.shareId;
    expect((await read('task-1')).status).toBe(200);
    await h.service.unshare(scope, 'task-1', shareId, h.owner);
    expect(await read('task-1')).toEqual(missing);
    // The operator still reviews the private state the share control needs.
    const review = await h.ownerApp.request(
      '/api/projects/example/shared-work/private-task/publication',
    );
    expect(review.status).toBe(200);
    expect(await review.json()).toMatchObject({
      data: { kind: 'unshared', task: { id: 'private-task' } },
    });
    h.db.close();
  });
  test('share and unshare stay operator-only for a member', async () => {
    const h = memberFixture();
    const refused = await h.memberApp.request(
      '/api/projects/example/shared-work/private-task',
      { method: 'PUT' },
    );
    expect(refused.status).toBe(404);
    expect(h.store.admission('private-task')).toBeUndefined();
    const admission = await h.service.share(scope, 'task-1', h.owner);
    const unshare = await h.memberApp.request(
      '/api/projects/example/shared-work/task-1',
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shareId: admission.shareId }),
      },
    );
    expect(unshare.status).toBe(404);
    expect(h.store.admission('task-1')?.shareId).toBe(admission.shareId);
    h.db.close();
  });
  test('membership or publication ending mid-read withholds the summary', async () => {
    const h = memberFixture();
    const admission = await h.service.share(scope, 'task-1', h.owner);
    let reads = 0;
    h.member.requireProjectRead.mockImplementation(async () => {
      reads += 1;
      if (reads === 2) throw new ProjectMembershipRefusal('forbidden');
    });
    const revoked = await h.memberApp.request(
      '/api/projects/example/shared-work/task-1/publication',
    );
    expect(revoked.status).toBe(404);
    expect(await revoked.text()).not.toContain(admission.shareId);
    reads = 0;
    h.member.requireProjectRead.mockImplementation(async () => {
      reads += 1;
      if (reads === 2) h.store.unshare('task-1', admission.shareId);
    });
    const unshared = await h.memberApp.request(
      '/api/projects/example/shared-work/task-1/publication',
    );
    expect(unshared.status).toBe(404);
    expect(await unshared.text()).not.toContain(admission.shareId);
    h.db.close();
  });
});
