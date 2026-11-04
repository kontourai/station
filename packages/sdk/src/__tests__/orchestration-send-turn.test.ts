import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  getChildWorkInstructions,
  getOrchestrationConversationEventWindow,
  getOrchestrationSessionDetailWindow,
  getOrchestrationSessionEventPage,
  interruptTurn,
  steerChildWork,
  steerTurn,
} from '../client/orchestration';
import { sentTurnKey } from '../client/sent-turn-key';

const capability = vi.hoisted(() => vi.fn());
vi.mock('../client/publicStationCapabilities', () => ({
  fetchPublicStationCapabilities: capability,
}));

describe('orchestration lifecycle-control client', () => {
  test('steer selects and retains one input key across an uncertain retry', async () => {
    const failure = Object.freeze(new TypeError('Lost steer response.'));
    const bodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        throw failure;
      }),
    );
    const send = (clientInputId?: string) =>
      steerTurn('http://station.test', {
        threadId: 'existing-thread',
        turnId: 'existing-turn',
        text: 'same input',
        clientInputId,
      });
    const first = await send().catch((error: unknown) => error);
    expect(first).toBe(failure);
    const key = sentTurnKey(first);
    expect(key).toEqual(expect.any(String));
    const second = await send(key).catch((error: unknown) => error);
    expect(second).toBe(failure);
    expect(sentTurnKey(second)).toBe(key);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({
      type: 'steerTurnOnce',
      clientInputId: key,
    });
    expect(bodies[1]).toEqual(bodies[0]);
  });

  afterEach(() => vi.unstubAllGlobals());

  test('child command and history are gated by the host capability and retain the exact target', async () => {
    capability.mockResolvedValue({
      capabilities: { childWorkSteering: false },
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ success: true, data: { outcome: 'steered' } }),
          { headers: { 'content-type': 'application/json' } },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const input = {
      threadId: 'parent',
      childId: 'child',
      turnId: 'turn',
      input: 'hello',
      clientInputId: 'key',
    };
    await expect(steerChildWork('http://station.test', input)).rejects.toThrow(
      'does not support',
    );
    expect(fetchMock).not.toHaveBeenCalled();
    capability.mockResolvedValue({ capabilities: { childWorkSteering: true } });
    await steerChildWork('http://station.test', input);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://station.test/api/orchestration/commands',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ type: 'steerChildWork', ...input }),
      }),
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          data: { entries: [], nextOffset: 10 },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    );
    expect(
      await getChildWorkInstructions(
        'http://station.test',
        'parent/one',
        'child/one',
        { offset: 10, limit: 10 },
      ),
    ).toEqual({ entries: [], nextOffset: 10 });
    expect(fetchMock).toHaveBeenLastCalledWith(
      'http://station.test/api/orchestration/sessions/parent%2Fone/child-work/child%2Fone/instructions?offset=10&limit=10',
      expect.anything(),
    );
  });

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
