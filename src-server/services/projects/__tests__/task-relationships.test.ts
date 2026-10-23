import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ProjectSharedTaskService } from '../project-shared-task-service.js';
import { ProjectSharedTaskStore } from '../project-shared-task-store.js';
import { TaskGraphService } from '../task-graph-service.js';
import {
  type TaskRelationshipAuthority,
  taskIdentity,
} from '../task-relationship-state.js';

const temp = trackTempDirs();
const project = { id: 'project-id', createdAt: '2026-10-01T00:00:00.000Z' };
function access(): TaskRelationshipAuthority {
  return {
    expectedProject: project,
    canonicalProject: (id) =>
      ['project-id', 'project-slug'].includes(id) ? project : undefined,
    canMutateTask: () => true,
    canReadTask: () => true,
    canReadConversation: (id) => id === 'canonical-conversation',
  };
}
async function fixture() {
  const home = temp('task-relationships-');
  const first = new TaskGraphService(home, {
    resolveProjectWorkspace: () => undefined,
  });
  const second = new TaskGraphService(home, {
    resolveProjectWorkspace: () => undefined,
  });
  const [a, b, child] = await Promise.all(
    ['A', 'B', 'child'].map((title) =>
      first.createTask({
        projectId: title === 'B' ? 'project-slug' : 'project-id',
        title,
      }),
    ),
  );
  return { home, first, second, a, b, child, authority: access() };
}
const attach = (
  child: TaskRecord,
  parent: TaskRecord | null,
  operationId: string,
  expectedRevision = 0,
) => ({
  child: taskIdentity(child),
  parent: parent && taskIdentity(parent),
  operationId,
  expectedRevision,
});

describe('Task relationships under the real cross-process store lock', () => {
  test('two service instances racing opposite parents admit exactly one revision; retry cannot resurrect a detached parent', async () => {
    const { first, second, a, b, child, authority } = await fixture();
    const inputs = [attach(child, a, 'first'), attach(child, b, 'second')];
    const results = await Promise.allSettled([
      first.setTaskParent(inputs[0], authority),
      second.setTaskParent(inputs[1], authority),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    const winner = results[0].status === 'fulfilled' ? inputs[0] : inputs[1];
    await second.setTaskParent(attach(child, null, 'detach', 1), authority);
    await expect(first.setTaskParent(winner, authority)).resolves.toMatchObject(
      { revision: 1 },
    );
    expect(second.readTask(child.id)?.parent).toBeUndefined();
    expect(second.readTask(child.id)?.relationshipRevision).toBe(2);
    await expect(
      first.setTaskParent({ ...winner, parent: null }, authority),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  test('actual opposite-direction race rejects the cycle after reloading the winning ancestor', async () => {
    const { first, second, a, b, authority } = await fixture();
    const results = await Promise.allSettled([
      first.setTaskParent(attach(a, b, 'a-b'), authority),
      second.setTaskParent(attach(b, a, 'b-a'), authority),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === 'rejected'),
    ).toMatchObject({ reason: { code: 'invalid' } });
  });

  test.each(['parent', 'chat'])(
    'lock-wait %s revocation is rechecked before mutation and leaves bytes untouched',
    async (kind) => {
      const { home, first, a, child, authority } = await fixture();
      const path = join(home, 'task-graph.json');
      const release = await acquireFileMutationLockAsync(`${path}.mutation`);
      const before = readFileSync(path, 'utf8');
      const pending =
        kind === 'parent'
          ? first.setTaskParent(attach(child, a, 'revoked'), authority)
          : first.setTaskWorkChat(
              {
                operationId: 'revoked',
                task: taskIdentity(child),
                conversationId: 'canonical-conversation',
                expectedRevision: 0,
                linked: true,
              },
              authority,
            );
      if (kind === 'parent') authority.canMutateTask = () => false;
      else authority.canReadConversation = () => false;
      await release();
      await expect(pending).rejects.toMatchObject({ code: 'unavailable' });
      expect(readFileSync(path, 'utf8')).toBe(before);
    },
  );

  test('atomic child create retries after restart, leaves parent status alone, and filters private children', async () => {
    const { home, first, a, authority } = await fixture();
    const input = {
      operationId: 'create',
      parent: taskIdentity(a),
      task: { projectId: 'project-slug', title: 'deliverable' },
    };
    const db = new DatabaseSync(':memory:');
    const store = new ProjectSharedTaskStore(db);
    const sharedScope = {
      stationId: 'test-station',
      localProjectId: project.id,
      localProjectSlug: 'project-slug',
      portableProjectId: 'portable',
    };
    store.share({
      scope: sharedScope,
      taskId: a.id,
      taskCreatedAt: a.createdAt,
      sharedBy: 'owner',
    });
    const publication = new ProjectSharedTaskService({
      store,
      readTask: (id) => first.readTask(id),
      projectCandidates: () => [{ id: project.id, slug: 'project-slug' }],
    });
    const created = await first.createChildTask(input, authority);
    try {
      const shared = await publication.list(sharedScope, {
        current: async () => ({ principalId: 'member' }),
        operator: async () => {
          throw new Error('member is not operator');
        },
        requireProjectRead: async () => {},
      });
      expect(shared).toHaveLength(1);
      expect(JSON.stringify(shared)).not.toContain(created.task.id);
      expect(store.admission(created.task.id)).toBeUndefined();
    } finally {
      db.close();
    }

    const restarted = new TaskGraphService(home, {
      resolveProjectWorkspace: () => undefined,
    });
    expect((await restarted.createChildTask(input, authority)).task.id).toBe(
      created.task.id,
    );
    await restarted.updateTaskStatus(created.task.id, 'in_progress');
    await restarted.updateTaskStatus(created.task.id, 'done');
    expect(first.readTask(a.id)?.status).toBe('todo');
    authority.canReadTask = (task) => task.id !== created.task.id;
    expect(first.listTaskChildren(taskIdentity(a), authority)).toEqual([]);
  });

  test('replacement Task and malformed ancestor fail closed without repairing persisted references', async () => {
    const { home, first, a, child, authority } = await fixture();
    await first.setTaskParent(attach(child, a, 'attach'), authority);
    const path = join(home, 'task-graph.json');
    const data = JSON.parse(readFileSync(path, 'utf8'));
    data.tasks.find((task: TaskRecord) => task.id === a.id).createdAt =
      '2026-10-02T00:00:00.000Z';
    writeFileSync(path, JSON.stringify(data));
    await expect(
      first.setTaskParent(attach(child, null, 'detach', 1), authority),
    ).rejects.toMatchObject({ code: 'unavailable' });
    data.tasks.find((task: TaskRecord) => task.id === child.id).parent = {
      taskId: a.id,
    };
    writeFileSync(path, JSON.stringify(data));
    const before = readFileSync(path, 'utf8');
    await expect(
      first.setTaskParent(attach(child, a, 'repair', 1), authority),
    ).rejects.toThrow('unavailable');
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  test('Project replacement during lock wait and cross-Project association refuse without writes', async () => {
    const { home, first, a, child, authority } = await fixture();
    const path = join(home, 'task-graph.json');
    const before = readFileSync(path, 'utf8');
    const release = await acquireFileMutationLockAsync(`${path}.mutation`);
    const pending = first.setTaskParent(
      attach(child, a, 'project-replaced'),
      authority,
    );
    authority.canonicalProject = () => ({
      ...project,
      createdAt: '2026-10-02T00:00:00.000Z',
    });
    await release();
    await expect(pending).rejects.toMatchObject({ code: 'unavailable' });
    expect(readFileSync(path, 'utf8')).toBe(before);
    authority.canonicalProject = (id) =>
      id === child.projectId ? project : { ...project, id: 'other-project' };
    const other = await first.createTask({
      projectId: 'other-project',
      title: 'other',
    });
    await expect(
      first.setTaskParent(attach(child, other, 'cross-project'), authority),
    ).rejects.toMatchObject({ code: 'unavailable' });
  });

  test('canonical work-chat link is unique, durable, private, and never starts execution or publishes', async () => {
    const { home, first, second, child, authority } = await fixture();
    const dispatch = vi.spyOn(first, 'createTaskDispatchAdapters');
    const input = {
      operationId: 'link',
      task: taskIdentity(child),
      conversationId: 'canonical-conversation',
      expectedRevision: 0,
      linked: true,
    };
    await first.setTaskWorkChat(input, authority);
    await second.setTaskWorkChat(
      { ...input, operationId: 'same-link', expectedRevision: 1 },
      authority,
    );
    expect(first.listTaskWorkChats(taskIdentity(child), authority)).toEqual([
      { conversationId: 'canonical-conversation', revision: 2 },
    ]);
    await second.setTaskWorkChat(
      { ...input, operationId: 'unlink', expectedRevision: 2, linked: false },
      authority,
    );
    await expect(
      new TaskGraphService(home, {
        resolveProjectWorkspace: () => undefined,
      }).setTaskWorkChat(input, authority),
    ).resolves.toMatchObject({ linked: true, revision: 1 });
    expect(first.listTaskWorkChats(taskIdentity(child), authority)).toEqual([]);
    expect(first.readTask(child.id)).toMatchObject({ status: 'todo' });
    expect(first.readTask(child.id)?.sessionId).toBeUndefined();
    const data = JSON.parse(
      readFileSync(join(home, 'task-graph.json'), 'utf8'),
    );
    expect(data.dispatches).toEqual([]);
    expect(data.links).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
    authority.canReadConversation = () => false;
    await expect(
      first.setTaskWorkChat(
        { ...input, operationId: 'denied', expectedRevision: 3 },
        authority,
      ),
    ).rejects.toMatchObject({ code: 'unavailable' });
  });
});
