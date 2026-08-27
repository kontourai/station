import { expect, test } from 'vitest';
import {
  LIVE_ACTIVITY_MAX_CONNECTED_CLIENTS,
  LIVE_ACTIVITY_SCHEMA_VERSION,
  parseLiveActivityProjection,
} from '../live-activity.js';

function projection() {
  return {
    schemaVersion: LIVE_ACTIVITY_SCHEMA_VERSION,
    observedAt: 1,
    connectedClients: 2,
    participants: [
      {
        id: 'a'.repeat(24),
        actor: { kind: 'agent', label: 'Codex' },
        scope: {
          projectId: 'project-1',
          projectSlug: 'station',
          taskId: 'task-1',
        },
        work: {
          sessionId: 'session-1',
          runId: 'run-1',
          workName: 'Review auth',
          workState: 'reviewing',
          startedAt: 1,
        },
        watching: { state: 'following', targetLabel: 'Brian' },
      },
    ],
  };
}

test('accepts only the closed, bounded live-activity browser projection', () => {
  expect(parseLiveActivityProjection(projection())).toMatchObject({
    connectedClients: 2,
    participants: [{ actor: { label: 'Codex' } }],
  });
  expect(
    parseLiveActivityProjection({
      ...projection(),
      connectedClients: LIVE_ACTIVITY_MAX_CONNECTED_CLIENTS + 1,
    }),
  ).toBeUndefined();
  const human: any = projection();
  human.participants[0] = {
    ...human.participants[0]!,
    actor: { kind: 'human', label: 'Brian' },
    work: {
      workName: 'Review auth',
      workState: 'reviewing',
      startedAt: 1,
    },
  };
  const parsedHuman = parseLiveActivityProjection(human);
  expect(parsedHuman?.participants[0]?.actor.kind).toBe('human');
  expect(parsedHuman?.participants[0]?.work).not.toHaveProperty('sessionId');
  expect(
    parseLiveActivityProjection({ ...projection(), deviceId: 'must-not-leak' }),
  ).toBeUndefined();
  expect(
    parseLiveActivityProjection({
      ...projection(),
      participants: Array.from(
        { length: 257 },
        () => projection().participants[0],
      ),
    }),
  ).toBeUndefined();
  expect(
    parseLiveActivityProjection(
      Object.assign(Object.create({ inherited: true }), projection()),
    ),
  ).toBeUndefined();
  const accessor = projection();
  Object.defineProperty(accessor, 'participants', {
    enumerable: true,
    get: () => accessor.participants,
  });
  expect(parseLiveActivityProjection(accessor)).toBeUndefined();
  const unsafeHuman: any = projection();
  unsafeHuman.participants[0] = {
    ...unsafeHuman.participants[0],
    actor: { kind: 'human', label: 'Brian' },
  };
  expect(parseLiveActivityProjection(unsafeHuman)).toBeUndefined();
});
