import { afterEach, expect, test, vi } from 'vitest';
import {
  createReportGroup,
  ReportGroupProtocolError,
  readReportGroupEvents,
  readReportGroupResult,
  subscribeReportGroupEvents,
} from '../client/report-groups';

afterEach(() => vi.unstubAllGlobals());
const base = 'https://report.test';
function envelope(data: unknown) {
  return new Response(JSON.stringify({ success: true, data }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
const page = {
  groupId: 'g',
  afterRevision: 0,
  nextRevision: 2,
  revision: 2,
  events: [
    { revision: 1, kind: 'command', commandKind: 'create' },
    { revision: 2, kind: 'returned' },
  ],
  unavailable: [],
  hasMore: false,
};
test.each([
  ['foreign group', { ...page, groupId: 'foreign' }],
  ['gap', { ...page, events: [page.events[1]] }],
  ['hidden remainder', { ...page, nextRevision: 1, events: [page.events[0]] }],
  [
    'nonadvancing page',
    { ...page, nextRevision: 0, events: [], hasMore: true },
  ],
  ['backwards', { ...page, events: [...page.events].reverse() }],
  ['cursor beyond journal', { ...page, revision: 1 }],
  ['private payload', { ...page, root: { credential: 'must refuse' } }],
])('report reader refuses %s without retry', async (_name, data) => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => envelope(data));
  vi.stubGlobal('fetch', fetch);
  await expect(readReportGroupEvents(base, 'g')).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
});
test('report result reader binds identity and exact UTF-16 cursor before exposing text', async () => {
  const result = {
    kind: 'result',
    groupId: 'g',
    seatId: 'seat',
    invocationId: 'attempt',
    modelId: 'model',
    text: '😀',
    afterOffset: 4,
    nextOffset: 6,
    hasMore: false,
    usage: { inputTokens: 1, outputTokens: 1, costMicros: 1 },
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async () => envelope(result));
  vi.stubGlobal('fetch', fetch);
  expect(await readReportGroupResult(base, 'g', 'seat', 'attempt', 4)).toEqual(
    result,
  );
  fetch.mockImplementation(async () => envelope({ ...result, nextOffset: 5 }));
  await expect(
    readReportGroupResult(base, 'g', 'seat', 'attempt', 4),
  ).rejects.toThrow(ReportGroupProtocolError);
  fetch.mockImplementation(async () =>
    envelope({ ...result, invocationId: 'foreign' }),
  );
  await expect(
    readReportGroupResult(base, 'g', 'seat', 'attempt', 4),
  ).rejects.toThrow(ReportGroupProtocolError);
});
test('report create enforces canonical byte cap before any mutation', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  vi.stubGlobal('fetch', fetch);
  await expect(
    createReportGroup(base, {
      operationId: 'op',
      projectSlug: 'p',
      deadlineAt: 1,
      maxConcurrent: 1,
      budget: { inputTokens: 1, outputTokens: 1, costMicros: 1 },
      members: Array.from({ length: 16 }, (_, i) => ({
        seatId: `s${i}`,
        agentId: 'a',
        brief: '😀'.repeat(16000),
        maxOutputTokens: 1,
      })),
    }),
  ).rejects.toThrow('byte limit');
  expect(fetch).not.toHaveBeenCalled();
});
test.each(['foreign-checkpoint', 'malformed-json'] as const)(
  'report stream refuses %s without delivering or reconnecting',
  async (variant) => {
    const frame = `event: report-group-events\nid: ${variant === 'foreign-checkpoint' ? 'group:g:2' : 'report:g:2'}\ndata: ${variant === 'malformed-json' ? '{' : JSON.stringify(page)}\n\n`;
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(frame, {
          headers: { 'Content-Type': 'text/event-stream' },
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const onPage = vi.fn();
    let terminal: unknown;
    const stream = subscribeReportGroupEvents(base, 'g', 0, {
      onPage,
      onTerminal: (error) => {
        terminal = error;
      },
    });
    try {
      await stream.completed;
      expect(terminal).toBeInstanceOf(ReportGroupProtocolError);
      expect(onPage).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      stream.close();
    }
  },
);
