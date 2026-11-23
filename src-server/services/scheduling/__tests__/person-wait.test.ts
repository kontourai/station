import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { expect, test } from 'vitest';
import { foldPersonWait } from '../person-wait.js';

const T0 = Date.parse('2026-11-22T00:00:00.000Z');
const MINUTE = 60_000;

const at = (minutes: number) => new Date(T0 + minutes * MINUTE).toISOString();
const request = (
  method: 'request.opened' | 'request.resolved',
  requestId: string,
  minutes: number,
  extra: Record<string, unknown> = {},
) =>
  ({
    method,
    eventId: `${method}-${requestId}`,
    provider: 'claude',
    threadId: 'session',
    turnId: 'turn',
    createdAt: at(minutes),
    requestId,
    ...(method === 'request.opened'
      ? { requestType: 'approval', title: 'Run a command' }
      : { status: 'approved' }),
    ...extra,
  }) as CanonicalRuntimeEvent;

test('two overlapping requests count their overlap once', () => {
  // A open 0-20, B open 10-30: waiting from 0 to 30.
  const wait = foldPersonWait(
    [
      request('request.opened', 'a', 0),
      request('request.opened', 'b', 10),
      request('request.resolved', 'a', 20),
      request('request.resolved', 'b', 30),
    ],
    T0 + 60 * MINUTE,
  );
  expect(wait).toEqual({ waitedMs: 30 * MINUTE });
});

test('an open request is still waiting, from when it opened until now', () => {
  expect(
    foldPersonWait([request('request.opened', 'a', 5)], T0 + 15 * MINUTE),
  ).toEqual({ waitedMs: 10 * MINUTE, waitingSince: T0 + 5 * MINUTE });
});

test('an asynchronous question is not waiting', () => {
  expect(
    foldPersonWait(
      [request('request.opened', 'a', 0, { blocking: false })],
      T0 + 15 * MINUTE,
    ),
  ).toEqual({ waitedMs: 0 });
});
