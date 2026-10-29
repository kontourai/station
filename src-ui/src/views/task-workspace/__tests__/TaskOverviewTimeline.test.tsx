/** @vitest-environment jsdom */
import {
  TASK_REVIEW_LIMITS,
  TASK_REVIEW_VERSION,
  type TaskReviewView,
} from '@kontourai/station-contracts/task-review';
import { _setApiBase } from '@kontourai/station-sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { capture, thread } from '../review/__tests__/review-fixtures';
import { TaskOverviewTimeline } from '../TaskOverviewTimeline';

vi.mock('../../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'https://timeline.test' }),
  useHostRequestAuthorityScope: () => ({ authorityKey: 'timeline-person' }),
}));
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setup(
  options: {
    failList?: boolean;
    failScreen?: boolean;
    empty?: boolean;
    partial?: boolean;
    mismatchedCommit?: boolean;
    count?: number;
    sameDigest?: boolean;
  } = {},
) {
  _setApiBase('https://timeline.test');
  const entries = [
    {
      ...capture,
      captureId: 'reproduced',
      label: 'Reproduced',
      createdAt: '2026-10-25T10:03:00Z',
    },
    {
      ...capture,
      captureId: 'verified',
      digest: `sha256:${'b'.repeat(64)}` as const,
      label: 'Refunds fixed',
      createdAt: '2026-10-25T11:20:00Z',
    },
    {
      ...capture,
      captureId: 'foreign',
      taskId: 'another-task',
      label: 'Other Task',
    },
  ];
  if (options.count) {
    entries.splice(
      0,
      entries.length,
      ...Array.from({ length: options.count }, (_, index) => ({
        ...capture,
        captureId: `screen-${index}`,
        label: `Screen ${index}`,
        digest: options.sameDigest
          ? capture.digest
          : (`sha256:${`${index}`.padStart(64, '0')}` as const),
        createdAt: new Date(Date.UTC(2026, 9, 25, 0, index)).toISOString(),
      })),
    );
  }
  const evidence = (captureId: string, gateVerified: boolean) => ({
    commit: capture.commit,
    commitVerified: true,
    captureId,
    gateVerified,
    gateRefs: [{ runId: 'run', gateId: 'replay', evaluationId: 'evaluation' }],
  });
  const replies = entries.slice(0, 2).map((entry, index) => {
    const view = thread(`thread-${index}`, index + 1, [
      'comment',
      'sent',
      'agent-reply',
    ]);
    return {
      ...view,
      status: 'available' as const,
      eventCount: view.events.length,
      openingEvent: {
        ...view.events[0]!,
        kind: 'comment' as const,
        author: { kind: 'person' as const, principalId: 'person-brian' },
        body: 'Review',
      },
      lastEvent: view.events.at(-1)!,
      lastDeliveryEvent: {
        ...view.events[2]!,
        kind: 'agent-reply' as const,
        author: { kind: 'session' as const, sessionId: 'lead' },
        body: 'Captured',
        deliveryKey: 'delivery',
        evidence: {
          ...evidence(entry.captureId, index === 1),
          commit: options.mismatchedCommit ? 'b'.repeat(40) : capture.commit,
        },
      },
    };
  });
  const data: TaskReviewView = {
    version: TASK_REVIEW_VERSION,
    taskCreatedAt: capture.taskCreatedAt,
    limits: TASK_REVIEW_LIMITS,
    taskId: capture.taskId,
    items: options.empty
      ? []
      : [...entries].reverse().map((entry) => ({
          kind: 'capture',
          id: entry.captureId,
          label: entry.label ?? 'Screen',
          status: 'available',
          artifact: {
            kind: 'capture',
            id: entry.captureId,
            revision: entry.commit,
            digest: entry.digest,
          },
          capture: entry,
          counts: { open: 0, outdated: 0, resolved: 0 },
        })),
    threads: replies,
    counts: { open: 0, outdated: 0, resolved: 0 },
  };
  const responseData: TaskReviewView = options.partial
    ? {
        ...data,
        items: [
          ...data.items,
          {
            kind: 'capture',
            id: 'unavailable',
            label: 'Unavailable Screen',
            status: 'unavailable',
            counts: { open: 0, outdated: 0, resolved: 0 },
          },
        ],
      }
    : data;
  const reads: string[] = [];
  let failList = options.failList;
  let failScreen = options.failScreen;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | Request | URL) => {
      const url = new URL(
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      reads.push(url.pathname);
      if (url.pathname === `/api/tasks/${capture.taskId}/review`)
        return Response.json(
          failList
            ? { success: false, code: 'unavailable', error: 'Offline' }
            : { success: true, data: responseData },
          { status: failList ? 503 : 200 },
        );
      if (
        entries.some(
          (entry) =>
            url.pathname ===
            `/api/tasks/${capture.taskId}/review/captures/${entry.captureId}/content`,
        )
      )
        return failScreen
          ? Response.json(
              { success: false, code: 'capture-unavailable', error: 'Offline' },
              { status: 503 },
            )
          : new Response(new Blob(['image'], { type: 'image/png' }));
      throw new Error(`Unexpected Timeline request: ${url.pathname}`);
    }),
  );
  let urlId = 0;
  const revoke = vi.fn();
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn(() => `blob:timeline-${++urlId}`);
      static revokeObjectURL = revoke;
    },
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  const onOpenCapture = vi.fn();
  const tree = (visible: boolean) => (
    <QueryClientProvider client={client}>
      <TaskOverviewTimeline
        taskId={capture.taskId}
        taskCreatedAt={capture.taskCreatedAt}
        visible={visible}
        onOpenCapture={onOpenCapture}
      />
    </QueryClientProvider>
  );
  return {
    tree,
    reads,
    onOpenCapture,
    revoke,
    recover: () => {
      failList = false;
      failScreen = false;
    },
  };
}

test('renders only this Task’s captures in time order, with authorized thumbnails, commits and verified or claimed gates', async () => {
  const h = setup();
  render(h.tree(true));
  const first = await screen.findByRole('button', {
    name: 'Review Reproduced',
  });
  await screen.findByRole('button', { name: 'Review Refunds fixed' });
  const rows = screen.getAllByRole('listitem');
  expect(within(rows[0]).getByText('Reproduced')).toBeTruthy();
  expect(within(rows[0]).getByText('claimed')).toBeTruthy();
  expect(within(rows[1]).getByText('Verified')).toBeTruthy();
  expect(within(rows[1]).getByText(capture.commit.slice(0, 7))).toBeTruthy();
  expect(screen.queryByText('Other Task')).toBeNull();
  expect(h.reads.some((path) => path.includes('/foreign/'))).toBe(false);
  fireEvent.click(first);
  expect(h.onOpenCapture).toHaveBeenCalledWith('reproduced');
});

test('does not read while hidden and revokes private thumbnails when leaving Overview', async () => {
  const h = setup();
  const view = render(h.tree(false));
  expect(h.reads).toEqual([]);
  view.rerender(h.tree(true));
  await screen.findByRole('button', { name: 'Review Refunds fixed' });
  view.rerender(h.tree(false));
  expect(screen.queryByRole('region', { name: 'Timeline' })).toBeNull();
  expect(h.revoke).toHaveBeenCalledTimes(2);
});

test('shows loading and recovers a failed list through Retry Timeline', async () => {
  const h = setup({ failList: true });
  render(h.tree(true));
  expect(screen.getByRole('status', { name: 'Loading Timeline' })).toBeTruthy();
  const retry = await screen.findByRole('button', { name: 'Retry Timeline' });
  h.recover();
  fireEvent.click(retry);
  await screen.findByRole('button', { name: 'Review Reproduced' });
});

test('retains captions when an image fails and retries that authorized content read', async () => {
  const h = setup({ failScreen: true });
  render(h.tree(true));
  await waitFor(() =>
    expect(
      screen.getAllByRole('button', { name: 'Retry Screen' }),
    ).toHaveLength(2),
  );
  expect(screen.getByText('Refunds fixed')).toBeTruthy();
  h.recover();
  fireEvent.click(screen.getAllByRole('button', { name: 'Retry Screen' })[0]);
  await screen.findByRole('button', { name: 'Review Reproduced' });
});

test('shows the empty state', async () => {
  const h = setup({ empty: true });
  render(h.tree(true));
  expect(
    await screen.findByText(
      'Capture a Screen in Review to start the Timeline.',
    ),
  ).toBeTruthy();
});

test('keeps available Screens visible alongside an unavailable item', async () => {
  const h = setup({ partial: true });
  render(h.tree(true));
  await screen.findByRole('button', { name: 'Review Refunds fixed' });
  expect(
    screen.getByRole('button', { name: 'Retry unavailable Screens' }),
  ).toBeTruthy();
  expect(
    screen.queryByText('Capture a Screen in Review to start the Timeline.'),
  ).toBeNull();
});

test('a verified gate for another commit stays claimed for this Screen', async () => {
  const h = setup({ mismatchedCommit: true });
  render(h.tree(true));
  await screen.findByRole('button', { name: 'Review Refunds fixed' });
  expect(screen.queryByText('Verified')).toBeNull();
  expect(screen.getAllByText('claimed')).toHaveLength(2);
});

test('bounds initial requests and admits more only after Show more and viewport entry', async () => {
  const callbacks = new Map<Element, IntersectionObserverCallback>();
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(private callback: IntersectionObserverCallback) {}
      observe(element: Element) {
        callbacks.set(element, this.callback);
      }
      disconnect() {}
    },
  );
  const h = setup({ count: 200 });
  render(h.tree(true));
  await screen.findByRole('button', { name: 'Show more' });
  expect(screen.getAllByRole('listitem')).toHaveLength(12);
  expect(h.reads.filter((path) => path.endsWith('/content'))).toHaveLength(0);
  for (const [element, callback] of callbacks)
    callback(
      [{ target: element, isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
  await waitFor(() =>
    expect(h.reads.filter((path) => path.endsWith('/content'))).toHaveLength(
      12,
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
  expect(screen.getAllByRole('listitem')).toHaveLength(24);
  expect(h.reads.filter((path) => path.endsWith('/content'))).toHaveLength(12);
  const more = [...callbacks].filter(([element]) =>
    element.textContent?.includes('Screen 176'),
  )[0]!;
  more[1](
    [{ target: more[0], isIntersecting: true } as IntersectionObserverEntry],
    {} as IntersectionObserver,
  );
  await waitFor(() =>
    expect(h.reads.filter((path) => path.endsWith('/content'))).toHaveLength(
      13,
    ),
  );
});

test('shares one content read for captures with the same digest', async () => {
  const h = setup({ count: 4, sameDigest: true });
  render(h.tree(true));
  await screen.findByRole('button', { name: 'Review Screen 3' });
  expect(h.reads.filter((path) => path.endsWith('/content'))).toHaveLength(1);
});

test('limits concurrent content reads and releases a slot when one completes', async () => {
  const h = setup({ count: 12 });
  const fetchContent = globalThis.fetch;
  const releases: Array<() => void> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | Request | URL, init?: RequestInit) => {
      if (!String(input).endsWith('/content')) return fetchContent(input, init);
      return new Promise<Response>((resolve, reject) => {
        releases.push(() => {
          void fetchContent(input, init).then(resolve, reject);
        });
      });
    }),
  );
  render(h.tree(true));
  await waitFor(() => expect(releases).toHaveLength(4));
  releases[0]!();
  await waitFor(() => expect(releases).toHaveLength(5));
});

test('revokes an image when its entry leaves the viewport', async () => {
  let callback: IntersectionObserverCallback = () => {};
  let element: Element;
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(onChange: IntersectionObserverCallback) {
        callback = onChange;
      }
      observe(target: Element) {
        element = target;
      }
      disconnect() {}
    },
  );
  const h = setup({ count: 1 });
  render(h.tree(true));
  await screen.findByText('Screen 0');
  callback(
    [{ target: element!, isIntersecting: true } as IntersectionObserverEntry],
    {} as IntersectionObserver,
  );
  await screen.findByRole('button', { name: 'Review Screen 0' });
  callback(
    [{ target: element!, isIntersecting: false } as IntersectionObserverEntry],
    {} as IntersectionObserver,
  );
  await waitFor(() => expect(h.revoke).toHaveBeenCalledTimes(1));
});
