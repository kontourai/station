import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { expect, test } from 'vitest';
import { settledChildWorkFromHistory } from '../child-work-history.js';

test('cold child-work history ignores a late settle after exit until a new session starts', () => {
  const threadId = 'thread-1';
  const at = '2026-09-24T00:00:00.000Z';
  const event = (
    eventId: string,
    method: string,
    extra: Record<string, unknown> = {},
  ) =>
    ({
      eventId,
      provider: 'claude',
      threadId,
      createdAt: at,
      method,
      ...extra,
    }) as CanonicalRuntimeEvent;
  const upsert = (childId: string) =>
    event(`upsert-${childId}`, 'child-work.updated', {
      delta: {
        kind: 'upsert',
        item: {
          producer: 'engine-subagent',
          reporterThreadId: threadId,
          childId,
          status: 'running',
          title: 'Explore',
        },
      },
    });
  const settle = (childId: string) =>
    event(`settle-${childId}`, 'child-work.updated', {
      delta: {
        kind: 'settle',
        producer: 'engine-subagent',
        reporterThreadId: threadId,
        childId,
        status: 'completed',
      },
    });
  const exited = event('exit', 'session.exited', { sessionId: threadId });
  const started = event('restart', 'session.started', { sessionId: threadId });

  expect(
    settledChildWorkFromHistory(threadId, [
      upsert('old'),
      exited,
      settle('old'),
    ]).settlements,
  ).toEqual([]);
  expect(
    settledChildWorkFromHistory(threadId, [
      upsert('old'),
      exited,
      settle('old'),
      started,
      upsert('new'),
      settle('new'),
    ]).settlements,
  ).toMatchObject([{ childId: 'new', status: 'completed' }]);
});
