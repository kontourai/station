/** @vitest-environment jsdom */
import {
  TASK_REVIEW_LIMITS,
  TASK_REVIEW_VERSION,
  type TaskReviewThreadSummary,
  type TaskReviewThreadView,
  type TaskReviewView,
} from '@kontourai/station-contracts/task-review';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { _setApiBase } from '../api-core';
import { StationHttpError, setClientCredentialResolver } from '../client/http';
import {
  fetchTaskReview,
  taskReviewItemQueryKey,
  taskReviewQueryKey,
  taskReviewThreadQueryKey,
  useCreateReviewThreadMutation,
  useReopenReviewThreadMutation,
  useReplyReviewThreadMutation,
  useResolveReviewThreadMutation,
  useTaskReviewItemQuery,
  useTaskReviewQuery,
  useTaskReviewThreadQuery,
} from '../query-domains/taskReview';

const clients: QueryClient[] = [];
const author = { kind: 'person', principalId: 'owner' } as const;
const thread: TaskReviewThreadView = {
  threadId: 'thread/one',
  projectId: 'project',
  taskId: 'task/one',
  taskCreatedAt: '2026-10-24T00:00:00.000Z',
  ordinal: 1,
  artifact: {
    kind: 'plan',
    id: 'plan',
    revision: 'v1',
    digest: `sha256:${'a'.repeat(64)}`,
  },
  anchor: { kind: 'whole' },
  author,
  operationId: 'opening',
  createdAt: '2026-10-24T00:00:00.000Z',
  events: [
    {
      threadId: 'thread/one',
      ordinal: 1,
      kind: 'comment',
      author,
      body: 'Clarify',
      operationId: 'opening',
      createdAt: '2026-10-24T00:00:00.000Z',
    },
  ],
  state: 'sent',
  pendingFollowUp: false,
  baseState: 'sent',
  outdated: false,
};
const summary = ({
  events,
  ...view
}: TaskReviewThreadView): TaskReviewThreadSummary => ({
  ...view,
  status: 'available',
  eventCount: events.length,
  lastEvent: events[events.length - 1]!,
});
const view = (
  baseState: TaskReviewThreadView['baseState'] = 'sent',
): TaskReviewView => ({
  version: TASK_REVIEW_VERSION,
  taskId: 'task/one',
  taskCreatedAt: thread.taskCreatedAt,
  items: [],
  threads: [
    summary({
      ...thread,
      baseState,
      state: baseState,
      events: [
        thread.events[0]!,
        ...(baseState === 'sent' || baseState === 'agent-replied'
          ? [
              {
                threadId: thread.threadId,
                ordinal: 2,
                kind: 'sent' as const,
                author,
                deliveryKey: 'tr-delivery',
                operationId: 'send',
                createdAt: thread.createdAt,
              },
            ]
          : []),
        ...(baseState === 'agent-replied'
          ? [
              {
                threadId: thread.threadId,
                ordinal: 3,
                kind: 'agent-reply' as const,
                deliveryKey: 'tr-delivery',
                author: { kind: 'session' as const, sessionId: 'lead' },
                body: 'Done',
                operationId: 'answer',
                createdAt: thread.createdAt,
              },
            ]
          : []),
      ],
    }),
  ],
  counts: { open: 1, outdated: 0, resolved: 0 },
  limits: TASK_REVIEW_LIMITS,
});
const response = (data: unknown) =>
  new Response(JSON.stringify({ success: true, data }), {
    headers: { 'Content-Type': 'application/json' },
  });
function setup() {
  vi.useFakeTimers();
  _setApiBase('https://review.test');
  setClientCredentialResolver(() => ({
    origin: 'https://review.test',
    credential: 'test-only-review-credential',
  }));
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
  clients.push(client);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const tick = async (ms = 0) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

test('poll is opt-in, runs at three seconds only for sent threads, and stops after a reply or tab hide', async () => {
  const { client, wrapper } = setup();
  let reads = 0;
  const fetcher = vi.fn<typeof fetch>(async () => {
    reads++;
    return response(view(reads === 1 ? 'sent' : 'agent-replied'));
  });
  vi.stubGlobal('fetch', fetcher);
  const { result, rerender } = renderHook(
    ({ poll }) => useTaskReviewQuery('task/one', { poll }),
    { initialProps: { poll: false }, wrapper },
  );
  await tick();
  expect(result.current.data?.threads[0]?.state).toBe('sent');
  await tick(9000);
  expect(reads).toBe(1);
  rerender({ poll: true });
  await tick(2999);
  expect(reads).toBe(1);
  await tick(1);
  expect(client.getQueryData(taskReviewQueryKey('task/one'))).toEqual(
    view('agent-replied'),
  );
  await tick(1);
  expect(result.current.data?.threads[0]?.state).toBe('agent-replied');
  expect(reads).toBe(2);
  await tick(9000);
  expect(reads).toBe(2);
  act(() => client.setQueryData(taskReviewQueryKey('task/one'), view()));
  await tick();
  rerender({ poll: false });
  await tick(9000);
  expect(reads).toBe(2);
});

test('person mutations encode task/thread ids, preserve operation ids, refresh the real query cache, and surface refusals', async () => {
  const { client, wrapper } = setup();
  const detailKey = taskReviewThreadQueryKey(
    'task/one',
    thread.threadId,
    1,
    'v1',
  );
  client.setQueryData(detailKey, { thread });
  let reads = 0;
  let refuse = false;
  const writes: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (url, init) => {
      if (init?.method === 'POST') {
        writes.push({ url: String(url), body: JSON.parse(String(init.body)) });
        return refuse
          ? new Response(
              JSON.stringify({
                success: false,
                code: 'event-limit',
                error: 'Full',
              }),
              { status: 409 },
            )
          : response({ thread });
      }
      reads++;
      return response(view('open'));
    }),
  );
  const { result } = renderHook(
    () => ({
      query: useTaskReviewQuery('task/one'),
      create: useCreateReviewThreadMutation('task/one'),
      reply: useReplyReviewThreadMutation('task/one'),
      resolve: useResolveReviewThreadMutation('task/one'),
      reopen: useReopenReviewThreadMutation('task/one'),
    }),
    { wrapper },
  );
  await tick();
  expect(reads).toBe(1);
  const opening = {
    artifact: thread.artifact,
    anchor: thread.anchor,
    body: 'Clarify',
    operationId: 'create',
  };
  await act(async () => {
    expect(await result.current.create.mutateAsync(opening)).toEqual({
      thread,
    });
  });
  await act(async () => {
    await result.current.reply.mutateAsync({
      threadId: thread.threadId,
      body: 'Reply',
      operationId: 'reply',
    });
  });
  await act(async () => {
    await result.current.resolve.mutateAsync({
      threadId: thread.threadId,
      operationId: 'resolve',
    });
  });
  await act(async () => {
    await result.current.reopen.mutateAsync({
      threadId: thread.threadId,
      reason: 'More work',
      operationId: 'reopen',
    });
  });
  await tick();
  expect(writes).toEqual([
    {
      url: 'https://review.test/api/tasks/task%2Fone/review/threads',
      body: opening,
    },
    {
      url: 'https://review.test/api/tasks/task%2Fone/review/threads/thread%2Fone/replies',
      body: { body: 'Reply', operationId: 'reply' },
    },
    {
      url: 'https://review.test/api/tasks/task%2Fone/review/threads/thread%2Fone/resolve',
      body: { operationId: 'resolve' },
    },
    {
      url: 'https://review.test/api/tasks/task%2Fone/review/threads/thread%2Fone/reopen',
      body: { reason: 'More work', operationId: 'reopen' },
    },
  ]);
  expect(reads).toBe(5);
  expect(client.getQueryData(taskReviewQueryKey('task/one'))).toEqual(
    view('open'),
  );
  refuse = true;
  await act(async () => {
    await expect(
      result.current.reply.mutateAsync({
        threadId: thread.threadId,
        body: 'Over cap',
        operationId: 'refused',
      }),
    ).rejects.toBeInstanceOf(StationHttpError);
  });
  expect(reads).toBe(5);
});

test('a failed list refresh stops interval polling and item content never polls', async () => {
  const { client, wrapper } = setup();
  let listReads = 0,
    itemReads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes('/items/')) {
        itemReads++;
        return response({
          kind: 'plan',
          id: 'plan/one',
          label: 'Plan',
          status: 'available',
          counts: { open: 1, outdated: 0, resolved: 0 },
          artifact: thread.artifact,
          text: 'Selected text',
        });
      }
      listReads++;
      return listReads === 1
        ? response(view())
        : new Response('<html>Unavailable</html>', { status: 503 });
    }),
  );
  const { result } = renderHook(
    () => ({
      list: useTaskReviewQuery('task/one', { poll: true }),
      item: useTaskReviewItemQuery('task/one', 'plan', 'plan/one'),
    }),
    { wrapper },
  );
  await tick();
  expect(result.current.item.data).toMatchObject({ text: 'Selected text' });
  expect(
    client.getQueryData(taskReviewItemQueryKey('task/one', 'plan', 'plan/one')),
  ).toMatchObject({ text: 'Selected text' });
  await tick(3001);
  expect(result.current.list.error).toBeInstanceOf(StationHttpError);
  expect(client.getQueryData(taskReviewQueryKey('task/one'))).toEqual(view());
  await tick(15000);
  expect(listReads).toBe(2);
  expect(itemReads).toBe(1);
});

test('non-JSON and malformed envelopes reject callers with StationHttpError and the HTTP status', async () => {
  setup();
  for (const [body, status] of [
    ['Bad gateway', 502],
    ['null', 200],
    ['{}', 200],
  ] as const) {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => new Response(body, { status })),
    );
    await expect(fetchTaskReview('task/one')).rejects.toMatchObject({
      name: 'StationHttpError',
      status,
    });
  }
});

test('a revision change fetches fresh item text and preserves each revision cache and caller result', async () => {
  const { client, wrapper } = setup();
  let reads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async () =>
      response({
        kind: 'plan',
        id: 'plan',
        status: 'available',
        text: `Text ${++reads}`,
      }),
    ),
  );
  const { result, rerender } = renderHook(
    ({ revision }) =>
      useTaskReviewItemQuery('task/one', 'plan', 'plan', { revision }),
    { initialProps: { revision: 'v1' }, wrapper },
  );
  await tick();
  expect(result.current.data).toMatchObject({ text: 'Text 1' });
  rerender({ revision: 'v2' });
  await tick();
  expect(result.current.data).toMatchObject({ text: 'Text 2' });
  expect(
    client.getQueryData(
      taskReviewItemQueryKey('task/one', 'plan', 'plan', 'v1'),
    ),
  ).toMatchObject({ text: 'Text 1' });
  expect(
    client.getQueryData(
      taskReviewItemQueryKey('task/one', 'plan', 'plan', 'v2'),
    ),
  ).toMatchObject({ text: 'Text 2' });
  expect(reads).toBe(2);
});

test('expanded cards fetch full events on demand, refresh by summary event count, and never poll', async () => {
  const { client, wrapper } = setup();
  const fetcher = vi.fn<typeof fetch>(async () => response({ thread }));
  vi.stubGlobal('fetch', fetcher);
  const { result, rerender } = renderHook(
    ({ expanded, eventCount }) =>
      useTaskReviewThreadQuery('task/one', thread.threadId, {
        enabled: expanded,
        eventCount,
        revision: 'v1',
      }),
    { initialProps: { expanded: false, eventCount: 1 }, wrapper },
  );
  await tick();
  expect(fetcher).not.toHaveBeenCalled();
  rerender({ expanded: true, eventCount: 1 });
  await tick();
  expect(result.current.data).toEqual({ thread });
  expect(
    client.getQueryData(
      taskReviewThreadQueryKey('task/one', thread.threadId, 1, 'v1'),
    ),
  ).toEqual({ thread });
  expect(String(fetcher.mock.calls[0]![0])).toBe(
    'https://review.test/api/tasks/task%2Fone/review/threads/thread%2Fone',
  );
  await tick(9000);
  expect(fetcher).toHaveBeenCalledTimes(1);
  rerender({ expanded: true, eventCount: 2 });
  await tick();
  expect(result.current.data).toEqual({ thread });
  expect(
    client.getQueryData(
      taskReviewThreadQueryKey('task/one', thread.threadId, 2, 'v1'),
    ),
  ).toEqual({ thread });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
