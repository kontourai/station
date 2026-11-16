import { expect, test } from 'vitest';
import {
  clearSequencedLiveEvents,
  raiseSequencedLiveFloor,
  readSequencedLiveEvents,
  readSequencedLiveFloor,
  readSequencedLiveTruncation,
  recordSequencedLiveEvent,
  subscribeSequencedLiveEvents,
} from '../sequencedLiveEvents';

test('a bounded live window reports the exact sequence it evicted', () => {
  const apiBase = 'http://live-window-overflow.test';
  for (let sequence = 1; sequence <= 2049; sequence++) {
    recordSequencedLiveEvent(
      apiBase,
      {
        eventId: `event-${sequence}`,
        provider: 'claude',
        threadId: 'conversation',
        createdAt: '2026-09-24T00:00:00.000Z',
        method: 'content.text-delta',
        itemId: 'answer',
        delta: 'x',
      },
      sequence,
    );
  }
  expect(readSequencedLiveEvents(apiBase)).toHaveLength(2048);
  expect(readSequencedLiveTruncation(apiBase)).toBe(1);
  clearSequencedLiveEvents(apiBase);
  expect(readSequencedLiveTruncation(apiBase)).toBe(0);
});

// The floor is the Station's head at a stream snapshot. A window's watermark
// is one conversation's newest event, so the floor must never become the
// truncation mark a reader holds its transcript against.
test('a snapshot cursor raises the live floor without evicting or truncating', () => {
  const apiBase = 'http://live-window-floor.test';
  let notified = 0;
  const unsubscribe = subscribeSequencedLiveEvents(apiBase, () => {
    notified++;
  });
  recordSequencedLiveEvent(
    apiBase,
    {
      eventId: 'event-3',
      provider: 'claude',
      threadId: 'conversation',
      createdAt: '2026-09-24T00:00:00.000Z',
      method: 'content.text-delta',
      itemId: 'answer',
      delta: 'x',
    },
    3,
  );
  notified = 0;

  raiseSequencedLiveFloor(apiBase, 5_000);
  expect(readSequencedLiveFloor(apiBase)).toBe(5_000);
  expect(notified).toBe(1);
  expect(readSequencedLiveTruncation(apiBase)).toBe(0);
  expect(readSequencedLiveEvents(apiBase)).toHaveLength(1);

  // It only rises, and a frame without a sequence changes nothing.
  raiseSequencedLiveFloor(apiBase, 10);
  raiseSequencedLiveFloor(apiBase, undefined);
  expect(readSequencedLiveFloor(apiBase)).toBe(5_000);
  expect(notified).toBe(1);

  clearSequencedLiveEvents(apiBase);
  expect(readSequencedLiveFloor(apiBase)).toBe(0);
  unsubscribe();
});
