/**
 * #5063: a settled Task's result is posted with no request behind it. The
 * publisher's authority is the recorded starter, checked against the real
 * room store's write transaction.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { createProjectRoomRuntime } from '../../../services/projects/project-room-store.js';
import { coordinatorRoomPublisher } from '../project-room-coordinator-runtime.js';

const makeTempDir = trackTempDirs();

function harness() {
  const room = createProjectRoomRuntime(makeTempDir('coordinator-publisher-'));
  const scope = {
    stationId: 'station',
    localProjectId: 'project-id',
    portableProjectId: 'portable',
    localProjectSlug: 'project',
  };
  const { roomId } = room.store.ensureRoom(scope, () => {});
  const world = {
    scope: { ...scope } as typeof scope | undefined,
    mayStart: true,
  };
  const publish = coordinatorRoomPublisher({
    rooms: room.store,
    currentScope: () => world.scope,
    mayStart: () => world.mayStart,
  });
  const messages = () =>
    room.store
      .history(scope, 0, 100)
      .messages.filter((m) => m.actor.id === 'station-coordinator');
  return { room, scope, roomId, world, publish, messages };
}

describe('coordinatorRoomPublisher', () => {
  it('posts a result once per intent as the coordinator', () => {
    const h = harness();
    try {
      const intentId = randomUUID();
      const input = {
        scope: h.scope,
        roomId: h.roomId,
        starterId: 'ada',
        intentId,
        text: '**Task finished:** [Fix](/tasks/t1)',
      };
      const first = h.publish(input);
      // A restart between the post and the row's settle posts again.
      expect(h.publish(input)).toBe(first);
      expect(h.messages()).toHaveLength(1);
      expect(h.messages()[0]!.actor.displayName).toBe('Coordinator');
    } finally {
      h.room.close();
    }
  });

  it.each([
    [
      'the starter may no longer start work',
      (w: { mayStart: boolean }) => {
        w.mayStart = false;
      },
    ],
    [
      'the Project was replaced (a new incarnation)',
      (w: { scope?: object }) => {
        w.scope = { ...(w.scope as object), localProjectId: 'project-id-2' };
      },
    ],
    [
      'the Project is gone',
      (w: { scope?: object }) => {
        w.scope = undefined;
      },
    ],
  ])('posts nothing when %s', (_label, change) => {
    const h = harness();
    try {
      change(h.world as never);
      expect(() =>
        h.publish({
          scope: h.scope,
          roomId: h.roomId,
          starterId: 'ada',
          intentId: randomUUID(),
          text: 'result',
        }),
      ).toThrow();
      expect(h.messages()).toEqual([]);
    } finally {
      h.room.close();
    }
  });

  it('posts nothing into a room that is not the recorded #general', () => {
    const h = harness();
    try {
      expect(() =>
        h.publish({
          scope: h.scope,
          roomId: randomUUID(),
          starterId: 'ada',
          intentId: randomUUID(),
          text: 'result',
        }),
      ).toThrow();
      expect(h.messages()).toEqual([]);
    } finally {
      h.room.close();
    }
  });
});
