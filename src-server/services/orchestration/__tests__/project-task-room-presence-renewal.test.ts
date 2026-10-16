import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  DEFAULT_LIVE_WORK_BOUNDS,
  type LiveWorkRecoveryState,
} from '../../../domain/live-work-session.js';
import { EventStore } from '../event-store.js';
import { ProjectTaskRoomRuntime } from '../project-task-room-runtime.js';

const makeTempDir = trackTempDirs();
afterEach(() => vi.restoreAllMocks());
const task: TaskRecord = {
  id: 'task',
  projectId: 'project',
  title: 'Room',
  description: '',
  priority: 'normal',
  status: 'todo',
  createdBy: 'operator',
  createdAt: '2026-10-15T00:00:00.000Z',
  updatedAt: '2026-10-15T00:00:00.000Z',
};
const principal = {
  kind: 'granted' as const,
  operatorId: 'owner',
  deviceId: 'viewer',
  policyRevision: 'pairing-v1',
};
function open(path: string) {
  const store = new EventStore(path);
  const runtime = new ProjectTaskRoomRuntime({
    taskGraph: { readTaskView: () => task },
    projectForId: (id) => ({ id, slug: id }),
    working: store.createProjectTaskRoomWorkingState(),
    history: (authority) => store.createProjectTaskRoomHistory(authority),
    requestAuthority: { resolve: async () => principal },
  });
  return { store, runtime };
}
const request = new Request('http://station');

test('an expired viewer rejoins and announces before and after a runtime restart', async () => {
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const path = join(makeTempDir('presence-renewal-'), 'events.sqlite');
  let owner = open(path);
  try {
    await owner.runtime.discover({ taskId: task.id, request });
    for (let i = 0; i < 3; i++) {
      await expect(
        owner.runtime.live({ taskId: task.id, request, command: 'join' }),
      ).resolves.toMatchObject({
        kind: 'available',
        result: { outcome: 'joined' },
      });
      await expect(
        owner.runtime.live({ taskId: task.id, request, command: 'announce' }),
      ).resolves.toMatchObject({
        kind: 'available',
        result: { outcome: 'updated' },
      });
      now += DEFAULT_LIVE_WORK_BOUNDS.ttlMs + 1;
    }
    await owner.runtime.close();
    owner.store.close();
    owner = open(path);
    await expect(
      owner.runtime.live({ taskId: task.id, request, command: 'join' }),
    ).resolves.toMatchObject({
      kind: 'available',
      result: { outcome: 'joined' },
    });
    await expect(
      owner.runtime.live({ taskId: task.id, request, command: 'announce' }),
    ).resolves.toMatchObject({
      kind: 'available',
      result: { outcome: 'updated' },
    });
  } finally {
    await owner.runtime.close();
    owner.store.close();
  }
});

type RecoveryImage = {
  schemaVersion: string;
  state: LiveWorkRecoveryState;
  armedIntentIds: string[];
  authorities: { token: string; principal: typeof principal }[];
};
test.each([false, true])(
  'legacy departure recovery requires the original captured principal receipt (rotated=%s)',
  async (rotated) => {
    const path = join(makeTempDir('presence-legacy-'), 'events.sqlite');
    let owner = open(path);
    let image: RecoveryImage;
    try {
      await owner.runtime.discover({ taskId: task.id, request });
      await owner.runtime.live({ taskId: task.id, request, command: 'join' });
      await owner.runtime.live({
        taskId: task.id,
        request,
        command: 'announce',
      });
      const db = new DatabaseSync(path);
      try {
        const row = db
          .prepare(
            'SELECT recovery_json FROM project_task_room_live_recovery WHERE task_id=?',
          )
          .get(task.id);
        if (typeof row?.recovery_json !== 'string')
          throw new Error('Missing actual recovery image');
        image = JSON.parse(row.recovery_json);
      } finally {
        db.close();
      }
      const departure = image.state.pending.find(
        (item) => item.intent.kind === 'departure',
      );
      if (!departure) throw new Error('Missing actual departure intent');
      const captured = image.authorities.find(
        (item) => item.token === departure.intent.requestId,
      );
      if (!captured) throw new Error('Missing original captured authority');
      image.authorities = image.authorities.filter(
        (item) => item.token !== captured.token,
      );
      image.authorities.push({
        token: 'legacy-retained-capture',
        principal: {
          ...captured.principal,
          ...(rotated ? { policyRevision: 'pairing-v2' } : {}),
        },
      });
      await owner.runtime.close();
      owner.store.close();
      const db2 = new DatabaseSync(path);
      try {
        db2
          .prepare(
            'UPDATE project_task_room_live_recovery SET recovery_json=? WHERE task_id=?',
          )
          .run(JSON.stringify(image), task.id);
      } finally {
        db2.close();
      }
      owner = open(path);
      const joined = await owner.runtime.live({
        taskId: task.id,
        request,
        command: 'join',
      });
      expect(joined).toMatchObject(
        rotated
          ? { kind: 'unavailable' }
          : { kind: 'available', result: { outcome: 'joined' } },
      );
      if (rotated) {
        image.authorities = image.authorities.map((authority) =>
          authority.token === 'legacy-retained-capture'
            ? { ...authority, principal: captured.principal }
            : authority,
        );
        const repaired = new DatabaseSync(path);
        try {
          repaired
            .prepare(
              'UPDATE project_task_room_live_recovery SET recovery_json=? WHERE task_id=?',
            )
            .run(JSON.stringify(image), task.id);
        } finally {
          repaired.close();
        }
        await expect(
          owner.runtime.live({ taskId: task.id, request, command: 'join' }),
        ).resolves.toMatchObject({
          kind: 'available',
          result: { outcome: 'joined' },
        });
      }
      if (!rotated)
        await expect(
          owner.runtime.live({ taskId: task.id, request, command: 'announce' }),
        ).resolves.toMatchObject({
          kind: 'available',
          result: { outcome: 'updated' },
        });
    } finally {
      await owner.runtime.close();
      owner.store.close();
    }
  },
);
