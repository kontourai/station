import { join } from 'node:path';
import { parseProjectTaskRoomBrowserHistory } from '@kontourai/station-contracts/project-task-room-browser';
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import { expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventStore } from '../event-store.js';
import { ProjectTaskRoomRuntime } from '../project-task-room-runtime.js';

const makeTempDir = trackTempDirs();

test('shared human pages preserve every message and skip private presence-only pages', async () => {
  const task: TaskRecord = {
    id: 'task',
    projectId: 'project',
    title: 'Shared room',
    description: '',
    priority: 'normal',
    status: 'todo',
    createdBy: 'operator',
    createdAt: '2026-10-15T00:00:00.000Z',
    updatedAt: '2026-10-15T00:00:00.000Z',
  };
  const store = new EventStore(
    join(makeTempDir('shared-room-pages-'), 'events.sqlite'),
  );
  const runtime = new ProjectTaskRoomRuntime({
    taskGraph: { readTaskView: () => task },
    projectForId: (id) => ({ id, slug: id }),
    working: store.createProjectTaskRoomWorkingState(),
    history: (authority) => {
      const history = store.createProjectTaskRoomHistory(authority);
      // Real worker pages are deliberately small; no record or cursor is fabricated.
      return {
        ...history,
        read: (input) => history.read({ ...input, limit: 3 }),
      };
    },
    requestAuthority: {
      resolve: async () => ({
        kind: 'granted',
        operatorId: 'owner',
        deviceId: 'device',
        policyRevision: 'pairing-v1',
      }),
    },
  });
  const request = new Request('http://station');
  const read = (cursor?: string) =>
    runtime.sharedHistory({
      taskId: task.id,
      request,
      current: async () => true,
      ...(cursor
        ? {
            cursor: JSON.parse(
              Buffer.from(cursor, 'base64url').toString('utf8'),
            ),
          }
        : {}),
    });
  const presence = async () => {
    for (const command of ['join', 'announce', 'depart'] as const)
      await runtime.live({ taskId: task.id, request, command });
  };
  try {
    await runtime.discover({ taskId: task.id, request });
    await presence();
    await presence();
    const empty = parseProjectTaskRoomBrowserHistory(await read());
    expect(empty).toMatchObject({
      kind: 'available',
      records: [],
      hasMore: false,
    });
    for (let i = 0; i < 105; i++)
      expect(
        (
          await runtime.message({
            taskId: task.id,
            request,
            proposalId: `note-${i}`,
            text: `Human note ${i}`,
          })
        ).kind,
      ).toBe('committed');
    await presence();
    await presence();
    await presence();
    const first = parseProjectTaskRoomBrowserHistory(await read());
    expect(first?.kind).toBe('available');
    if (first?.kind !== 'available')
      throw new Error('Missing first shared page');
    expect(first.hasMore).toBe(true);
    expect(first.records.length).toBeLessThanOrEqual(100);
    expect(first.nextCursor).toBeTruthy();
    const second = parseProjectTaskRoomBrowserHistory(
      await read(first.nextCursor),
    );
    expect(second?.kind).toBe('available');
    if (second?.kind !== 'available')
      throw new Error('Missing second shared page');
    expect(second.hasMore).toBe(false);
    const records = [...first.records, ...second.records];
    expect(
      records.map((record) =>
        record.body.kind === 'human-message' ? record.body.text : 'private',
      ),
    ).toEqual(Array.from({ length: 105 }, (_, i) => `Human note ${i}`));
  } finally {
    await runtime.close();
    store.close();
  }
});
