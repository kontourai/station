import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  getOrchestrationSessionEventPage,
  interruptTurn,
} from '../client/orchestration';

describe('orchestration lifecycle-control client', () => {
  afterEach(() => vi.unstubAllGlobals());

  test('interrupts a turn without closing its session', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      interruptTurn(
        'http://station.test',
        { threadId: 'task-1', turnId: 'turn-1' },
        { headers: { 'x-station-test': 'trusted' } },
      ),
    ).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://station.test/api/orchestration/commands',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-station-test': 'trusted' }),
        body: JSON.stringify({
          type: 'interruptTurn',
          threadId: 'task-1',
          turnId: 'turn-1',
        }),
      }),
    );
  });

  test('reads an encoded bounded session event page', async () => {
    const page = { events: [], hasMore: false, nextSequence: 7 };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: page }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      getOrchestrationSessionEventPage(
        'http://station.test',
        'task/with spaces',
        { afterSequence: 7, limit: 25 },
        { headers: { 'x-station-test': 'trusted' } },
      ),
    ).resolves.toEqual(page);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://station.test/api/orchestration/sessions/task%2Fwith%20spaces/event-page?afterSequence=7&limit=25',
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-station-test': 'trusted' }),
      }),
    );
  });
});
