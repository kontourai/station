import { DatabaseSync } from 'node:sqlite';
import type { ProjectMembershipScope } from '@kontourai/station-contracts/project-membership';
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import { describe, expect, test, vi } from 'vitest';
import { ProjectSharedTaskService } from '../project-shared-task-service.js';
import {
  ProjectSharedTaskRefusal,
  ProjectSharedTaskStore,
} from '../project-shared-task-store.js';

const scope: ProjectMembershipScope = {
  stationId: 'station-1',
  localProjectId: 'project-1',
  localProjectSlug: 'example',
  portableProjectId: 'portable-1',
};
const task = (overrides: Partial<TaskRecord> = {}): TaskRecord => ({
  id: 'task-1',
  projectId: 'project-1',
  title: 'Shared task',
  description: 'private',
  priority: 'normal',
  status: 'ready',
  createdBy: 'owner',
  createdAt: '2026-09-20T00:00:00.000Z',
  updatedAt: '2026-09-20T00:00:00.000Z',
  ...overrides,
});
function fixture() {
  const db = new DatabaseSync(':memory:');
  const tasks = new Map([['task-1', task()]]);
  const projects = new Map<string, { id: string; slug: string }[]>([
    ['project-1', [{ id: 'project-1', slug: 'example' }]],
    ['example', [{ id: 'project-1', slug: 'example' }]],
  ]);
  const callbacks: string[] = [];
  let principalId = 'human:owner';
  const authority = {
    current: vi.fn(async () => {
      callbacks.push('current');
      return { principalId };
    }),
    operator: vi.fn(async () => {
      callbacks.push('operator');
    }),
    requireProjectRead: vi.fn(async () => {
      callbacks.push('read');
    }),
  };
  const store = new ProjectSharedTaskStore(db, () =>
    Date.parse('2026-09-20T01:00:00.000Z'),
  );
  const service = new ProjectSharedTaskService({
    store,
    readTask: (id) => tasks.get(id) ?? null,
    projectCandidates: (id) => projects.get(id) ?? [],
  });
  return {
    db,
    tasks,
    projects,
    callbacks,
    authority,
    store,
    service,
    setPrincipal: (value: string) => {
      principalId = value;
    },
  };
}
describe('ProjectSharedTaskService', () => {
  test('defaults private and rechecks operator, member, principal and Task before publication', async () => {
    const h = fixture();
    await expect(
      h.service.admitRead(scope, 'task-1', h.authority),
    ).rejects.toBeInstanceOf(ProjectSharedTaskRefusal);
    const shared = await h.service.share(scope, 'task-1', h.authority);
    expect(shared.scope).toEqual(scope);
    expect(h.callbacks).toEqual([
      'read',
      'current',
      'operator',
      'read',
      'operator',
      'current',
      'read',
    ]);
    expect((await h.service.list(scope, h.authority))[0]?.task).toMatchObject({
      id: 'task-1',
      title: 'Shared task',
    });
    h.db.close();
  });
  test('normal progress remains shared while Task incarnation, Project binding and ambiguity fail closed', async () => {
    const h = fixture();
    const shared = await h.service.share(scope, 'task-1', h.authority);
    h.tasks.set(
      'task-1',
      task({ status: 'in_progress', updatedAt: '2026-09-20T02:00:00.000Z' }),
    );
    await expect(
      h.service.revalidate(shared, h.authority),
    ).resolves.toBeUndefined();
    h.tasks.set('task-1', task({ createdAt: '2026-09-20T03:00:00.000Z' }));
    await expect(
      h.service.revalidate(shared, h.authority),
    ).rejects.toBeInstanceOf(ProjectSharedTaskRefusal);
    h.tasks.set('task-1', task());
    h.projects.set('project-1', [
      { id: 'project-1', slug: 'example' },
      { id: 'other', slug: 'project-1' },
    ]);
    await expect(
      h.service.revalidate(shared, h.authority),
    ).rejects.toBeInstanceOf(ProjectSharedTaskRefusal);
    h.db.close();
  });
  test('unshare and reshare rotates share incarnation so an in-flight admission stays revoked', async () => {
    const h = fixture();
    const first = await h.service.share(scope, 'task-1', h.authority);
    await h.service.unshare(scope, 'task-1', first.shareId, h.authority);
    const second = await h.service.share(scope, 'task-1', h.authority);
    expect(second.shareId).not.toBe(first.shareId);
    await expect(
      h.service.revalidate(first, h.authority),
    ).rejects.toBeInstanceOf(ProjectSharedTaskRefusal);
    await expect(
      h.service.revalidate(second, h.authority),
    ).resolves.toBeUndefined();
    h.db.close();
  });
  test('principal change before synchronous commit refuses publication', async () => {
    const h = fixture();
    h.authority.operator
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(async () => h.setPrincipal('human:other'));
    await expect(
      h.service.share(scope, 'task-1', h.authority),
    ).rejects.toBeInstanceOf(ProjectSharedTaskRefusal);
    expect(h.store.admission('task-1')).toBeUndefined();
    h.db.close();
  });
  test('stale entries do not hide valid neighbors and unshare works after Task deletion', async () => {
    const h = fixture();
    h.tasks.set('task-2', task({ id: 'task-2', title: 'Neighbor' }));
    const stale = await h.service.share(scope, 'task-1', h.authority);
    await h.service.share(scope, 'task-2', h.authority);
    h.tasks.delete('task-1');
    expect(
      (await h.service.list(scope, h.authority)).map((item) => item.task.id),
    ).toEqual(['task-2']);
    await expect(
      h.service.unshare(scope, 'task-1', stale.shareId, h.authority),
    ).resolves.toEqual({ unshared: true });
    h.db.close();
  });
  test('unshare and reshare during list recheck cannot authorize the old summary', async () => {
    const h = fixture();
    const first = await h.service.share(scope, 'task-1', h.authority);
    let checks = 0;
    h.authority.requireProjectRead.mockClear();
    h.authority.requireProjectRead.mockImplementation(async () => {
      checks += 1;
      if (checks !== 2) return;
      h.store.unshare('task-1', first.shareId);
      h.store.share({
        scope,
        taskId: 'task-1',
        taskCreatedAt: task().createdAt,
        sharedBy: 'human:owner',
      });
    });
    expect(await h.service.list(scope, h.authority)).toEqual([]);
    h.db.close();
  });
});
