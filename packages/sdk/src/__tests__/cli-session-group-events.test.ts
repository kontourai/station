import type { CliSessionGroupView } from '@kontourai/station-contracts/delegation-group';
import { afterEach, expect, test, vi } from 'vitest';
import {
  readCliSessionGroupEvents,
  subscribeCliSessionGroupEvents,
  syncCliSessionGroup,
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

test.each(['dispatch-limit-exhausted', 'unknown-policy'])(
  'event pages validate the closed dispatch allowance reason %s',
  async (reason) => {
    const value = page();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: true,
              data: {
                ...value,
                events: [{ ...value.events[0], admissionClosed: reason }],
              },
            }),
          ),
      ),
    );
    const read = readCliSessionGroupEvents('https://station.test', 'cli-test');
    if (reason === 'dispatch-limit-exhausted')
      expect((await read).events[0].admissionClosed).toBe(
        'dispatch-limit-exhausted',
      );
    else await expect(read).rejects.toThrow();
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

test.each([262_144, 262_145])(
  'stream enforces the page budget separately from framing at %i bytes',
  async (bytes) => {
    const value = {
      ...page(0, 16),
      events: Array.from({ length: 16 }, (_, index) => ({
        revision: index + 1,
        members: [],
        schedule: Array.from({ length: 32 }, () => ({
          kind: 'claimed',
          stepId: 'seat',
          claimId: '',
        })),
      })),
    };
    let remaining =
      bytes - new TextEncoder().encode(JSON.stringify(value)).byteLength;
    for (const event of value.events) {
      for (const entry of event.schedule) {
        const length = Math.min(512, remaining);
        entry.claimId = 'x'.repeat(length);
        remaining -= length;
      }
    }
    expect(remaining).toBe(0);
    const data = JSON.stringify(value);
    expect(new TextEncoder().encode(data).byteLength).toBe(bytes);
    const frame = `event: cli-group-events\nid: cli-group:cli-test:16\ndata: ${data}\n\n`;
    expect(new TextEncoder().encode(frame).byteLength).toBeGreaterThan(262_144);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(frame));
              },
            }),
            { headers: { 'Content-Type': 'text/event-stream' } },
          ),
      ),
    );
    const onPage = vi.fn();
    const onTerminal = vi.fn();
    let observed!: () => void;
    const outcome = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const stream = subscribeCliSessionGroupEvents(
      'https://station.test',
      'cli-test',
      0,
      {
        onPage(value) {
          onPage(value);
          observed();
        },
        onTerminal(error) {
          onTerminal(error);
          observed();
        },
      },
    );
    try {
      await outcome;
      if (bytes === 262_144) {
        expect(onPage).toHaveBeenCalledOnce();
        expect(onPage.mock.calls[0][0]).toEqual(value);
        expect(onTerminal).not.toHaveBeenCalled();
      } else {
        expect(onPage).not.toHaveBeenCalled();
        expect(onTerminal).toHaveBeenCalledOnce();
      }
    } finally {
      stream.close();
      await stream.completed;
    }
  },
);

test.each([
  'valid',
  'missing-sync',
  'wrong-operation',
  'wrong-run',
  'wrong-group',
] as const)(
  'sync response binds its requested operation: %s',
  async (defect) => {
    const value: CliSessionGroupView = {
      version: 'station.cli-session-group/v1',
      groupId: 'sync-group',
      revision: 5,
      supervision: 'not-running',
      cancelled: false,
      deadlineAt: 4070908800000,
      maxConcurrent: 1,
      dispatchCount: 1,
      flow: null,
      acceptance: 'unassessed',
      guarantees: {
        authority: 'station-session',
        portableFlowLineage: 'unbound',
        dollarCap: 'unavailable',
        tokenCap: 'unavailable',
        physicalAttemptCap: 'unavailable',
        deadline: 'stop-admission-and-request-interruption',
      },
      members: [
        { seatId: 'lead', needs: [], state: 'terminal', outcome: 'completed' },
      ],
      contextSync: {
        operationId: 'requested-op',
        runId: 'requested-run',
        contentHash: `sha256:${'a'.repeat(64)}`,
        timestamp: '2026-10-24T00:00:00.000Z',
        status: 'incomplete',
        members: [{ seatId: 'lead', status: 'unknown', attempts: 1 }],
      },
    };
    if (defect === 'missing-sync') delete value.contextSync;
    if (defect === 'wrong-operation' && value.contextSync)
      value.contextSync.operationId = 'later-op';
    if (defect === 'wrong-run' && value.contextSync)
      value.contextSync.runId = 'later-run';
    if (defect === 'wrong-group') value.groupId = 'foreign-group';
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ success: true, data: value })),
    );
    vi.stubGlobal('fetch', fetch);
    const request = syncCliSessionGroup('https://sdk.test', 'sync-group', {
      operationId: 'requested-op',
      runId: 'requested-run',
      content: 'private folded result',
      deadlineAt: 4070908800000,
    });
    if (defect === 'valid') expect(await request).toEqual(value);
    else
      await expect(request).rejects.toThrow(
        'Unexpected session group sync operation.',
      );
    expect(fetch).toHaveBeenCalledOnce();
  },
);
