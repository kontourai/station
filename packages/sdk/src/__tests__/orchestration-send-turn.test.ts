import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  getOrchestrationConversationEventWindow,
  getOrchestrationSessionDetailWindow,
  getOrchestrationSessionEventPage,
  interruptTurn,
} from '../client/orchestration';

describe('orchestration lifecycle-control client', () => {
  afterEach(() => vi.unstubAllGlobals());

  test('requests newest-first conversation hydration without decoding its opaque cursor', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { events: [] } }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await getOrchestrationConversationEventWindow(
      'http://station.test',
      'conversation/one',
      { direction: 'newest', cursor: 'opaque+', turnLimit: 10 },
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'http://station.test/api/orchestration/conversations/conversation%2Fone/event-window?cursor=opaque%2B&direction=newest&turnLimit=10',
      expect.anything(),
    );
  });

  test('session detail windows retain their opaque cursor and paging envelope', async () => {
    const data = {
      protocolVersion: 1,
      session: { threadId: 'task' },
      events: [],
      hasMore: true,
      nextCursor: 'older+',
      watermark: 9,
    };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      getOrchestrationSessionDetailWindow(
        'http://station.test',
        'task/one',
        { cursor: 'current+', turnLimit: 3 },
        { headers: { 'x-station-test': 'trusted' } },
      ),
    ).resolves.toEqual(data);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://station.test/api/orchestration/sessions/task%2Fone?view=window-v1&cursor=current%2B&turnLimit=3',
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-station-test': 'trusted' }),
      }),
    );
  });

  test('refuses a legacy full-detail envelope when an older server ignores the window view', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            data: { session: { threadId: 'task' }, events: [] },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    await expect(
      getOrchestrationSessionDetailWindow('http://station.test', 'task'),
    ).rejects.toThrow('does not support bounded session detail');
  });

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
