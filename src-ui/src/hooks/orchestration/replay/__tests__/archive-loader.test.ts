// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';

const page = vi.hoisted(() => vi.fn());
vi.mock('@kontourai/station-sdk/client', async (original) => ({
  ...(await original<typeof import('@kontourai/station-sdk/client')>()),
  getOrchestrationSessionEventPage: page,
}));

import { closeActiveReplay, openReplayFromThread } from '../controller';

const input = {
  apiBase: 'http://station.test',
  sourceThreadId: 'source',
  agentSlug: 'codex',
  agentName: 'Codex',
};
const event = (eventId: string) => ({
  eventId,
  threadId: 'source',
  provider: 'codex',
  createdAt: '2026-09-12T00:00:00Z',
  method: 'turn.started',
  turnId: eventId,
  prompt: eventId,
});
afterEach(() => {
  closeActiveReplay();
  page.mockReset();
});
test('reads bounded session pages with a response ceiling and preserves exact event order', async () => {
  page
    .mockResolvedValueOnce({
      session: { model: 'model' },
      events: [{ sequence: 1, event: event('one') }],
      nextSequence: 1,
      hasMore: true,
    })
    .mockResolvedValueOnce({
      session: {},
      events: [{ sequence: 4, event: event('two') }],
      nextSequence: 4,
      hasMore: false,
    });
  const replay = await openReplayFromThread(input);
  expect(replay.player.tape.events.map((item) => item.eventId)).toEqual([
    'one',
    'two',
  ]);
  expect(page).toHaveBeenNthCalledWith(
    2,
    input.apiBase,
    'source',
    { afterSequence: 1, limit: 100 },
    { maxResponseBytes: 8 * 1024 * 1024, timeoutMs: 10000 },
  );
});
test('rejects non-progressing cursors and foreign-session pages instead of looping or rebinding them', async () => {
  page.mockResolvedValueOnce({
    session: {},
    events: [],
    nextSequence: 1,
    hasMore: true,
  });
  await expect(openReplayFromThread(input)).rejects.toThrow(
    'invalid archive page',
  );
  page.mockResolvedValueOnce({
    session: {},
    events: [
      { sequence: 1, event: { ...event('foreign'), threadId: 'other' } },
    ],
    nextSequence: 1,
    hasMore: false,
  });
  await expect(openReplayFromThread(input)).rejects.toThrow('identity');
  expect(page).toHaveBeenCalledTimes(2);
});
