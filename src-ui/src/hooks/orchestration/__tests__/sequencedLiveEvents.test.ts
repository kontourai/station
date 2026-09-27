import { expect, test } from 'vitest';
import {
  clearSequencedLiveEvents,
  readSequencedLiveEvents,
  readSequencedLiveTruncation,
  recordSequencedLiveEvent,
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
