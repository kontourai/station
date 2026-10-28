import type { OrchestrationSequencedEvent } from '@kontourai/station-contracts/orchestration';
import { expect, test } from 'vitest';
import { stitchWindowWithLiveEvents } from '../hooks/orchestration/conversationTranscriptParts';

const frame = (
  sequence: number,
  turnId: string,
  eventId = `e${sequence}`,
): OrchestrationSequencedEvent =>
  ({
    sequence,
    event: {
      eventId,
      method: 'content.text-delta',
      provider: 'codex',
      threadId: 'thread',
      turnId,
      itemId: 'answer',
      delta: String(sequence),
      createdAt: '2026-09-12T00:00:00Z',
    },
  }) as OrchestrationSequencedEvent;

const stitch = (
  windowEvents: OrchestrationSequencedEvent[],
  liveEvents: OrchestrationSequencedEvent[],
) =>
  stitchWindowWithLiveEvents({
    windowEvents,
    watermark: 12,
    liveEvents,
    threadIds: new Set(['thread']),
  }).map((item) => item.sequence);

// A capped page: turn B's start (10) plus its tail (12), with 11 left out.
const page = [frame(10, 'turn-b'), frame(12, 'turn-b')];

test('a live frame of a shown turn fills the gap the capped page left', () => {
  expect(stitch(page, [frame(11, 'turn-b')])).toEqual([10, 11, 12]);
});

test('frames past the watermark join whatever turn they belong to', () => {
  expect(stitch(page, [frame(13, 'turn-c')])).toEqual([10, 12, 13]);
});

test('in-range frames of a turn the page does not show are left to paging', () => {
  // An older host numbering per thread would put an old turn's frames here.
  expect(stitch(page, [frame(11, 'turn-old')])).toEqual([10, 12]);
});

test('frames older than the whole page are left to paging', () => {
  expect(stitch(page, [frame(5, 'turn-b')])).toEqual([10, 12]);
});

test('a frame the page holds is not added twice, by id or by sequence', () => {
  expect(
    stitch(page, [frame(12, 'turn-b'), frame(12, 'turn-b', 'other-id')]),
  ).toEqual([10, 12]);
});
