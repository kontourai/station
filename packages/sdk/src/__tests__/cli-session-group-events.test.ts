import { afterEach, expect, test, vi } from 'vitest';
import {
  readCliSessionGroupEvents,
  subscribeCliSessionGroupEvents,
} from '../client/cli-session-groups';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const page = (afterRevision = 0, nextRevision = 1) => ({
  groupId: 'cli-test',
  afterRevision,
  nextRevision,
  events: [{ revision: nextRevision, members: [], schedule: [] }],
  hasMore: false,
  unavailable: [],
});

test.each([
  'wrong-group',
  'missing-revision',
  'reordered-events',
  'duplicate-revision',
] as const)(
  'event-page parser refuses %s rather than advancing the cursor',
  async (defect) => {
    const value = page();
    if (defect === 'wrong-group') value.groupId = 'other';
    if (defect === 'missing-revision') {
      value.nextRevision = 2;
      value.events[0].revision = 2;
    }
    if (defect === 'reordered-events') {
      value.nextRevision = 2;
      value.events = [
        value.events[0],
        { ...value.events[0], revision: 2 },
      ].reverse();
    }
    if (defect === 'duplicate-revision') value.events.push(value.events[0]);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ success: true, data: value })),
      ),
    );
    await expect(
      readCliSessionGroupEvents('https://station.test', 'cli-test'),
    ).rejects.toThrow();
  },
);

test('an id-only frame cannot skip undisclosed history or enter the retained checkpoint', async () => {
  const onPage = vi.fn();
  const onTerminal = vi.fn();
  const fetch = vi.fn(
    async () =>
      new Response('id: cli-group:cli-test:9\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      }),
  );
  vi.stubGlobal('fetch', fetch);
  const stream = subscribeCliSessionGroupEvents(
    'https://station.test',
    'cli-test',
    0,
    { onPage, onTerminal },
  );
  await stream.completed;
  expect(onPage).not.toHaveBeenCalled();
  expect(onTerminal).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledOnce();
});

test('normal stream rotation resumes at the accepted revision and ignores duplicate pages', async () => {
  vi.useFakeTimers();
  const requests: Headers[] = [];
  const onPage = vi.fn();
  const cancelled = vi.fn();
  const frame = (value: ReturnType<typeof page>) =>
    `event: cli-group-events\nid: cli-group:cli-test:${value.nextRevision}\ndata: ${JSON.stringify(value)}\n\n`;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init) => {
      requests.push(new Headers(init?.headers));
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                requests.length === 1
                  ? frame(page())
                  : frame(page()) + frame(page(1, 2)),
              ),
            );
            if (requests.length === 1) controller.close();
          },
          cancel: cancelled,
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    }),
  );
  const stream = subscribeCliSessionGroupEvents(
    'https://station.test',
    'cli-test',
    0,
    { onPage },
  );
  try {
    await vi.advanceTimersByTimeAsync(1100);
    expect(requests).toHaveLength(2);
    expect(requests[1].get('Last-Event-ID')).toBe('cli-group:cli-test:1');
    expect(onPage.mock.calls.map(([value]) => value.nextRevision)).toEqual([
      1, 2,
    ]);
  } finally {
    stream.close();
    await stream.completed;
  }
  expect(cancelled).toHaveBeenCalledOnce();
});
