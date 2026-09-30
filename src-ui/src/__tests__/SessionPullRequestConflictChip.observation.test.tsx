/**
 * @vitest-environment jsdom
 *
 * #2937: with the Sessions view open, every row's conflict chip polled the
 * full-field open pull-request list, so the forge cost scaled with rows and
 * exhausted the operator's GitHub quota. These drive the real SDK hooks and a
 * real QueryClient with the app's query defaults against a counting fetch.
 */

import { _setApiBase } from '@kontourai/station-sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  OBSERVATION_INTERVAL_MS,
  SessionPullRequestConflictChip,
} from '../components/session/SessionPullRequestConflictChip';
import { stationQueryDefaults } from '../lib/queryDefaults';

const ORIGIN = 'https://station.example.test';

const repositoryOf = (thread: string) =>
  thread.startsWith('other-') ? 'other' : 'station';

let requests: URL[] = [];

function respond(url: URL) {
  const json = (data: unknown) =>
    new Response(JSON.stringify({ success: true, data }));
  if (url.pathname === '/api/pull-requests/context') {
    const thread = url.searchParams.get('thread') ?? '';
    return json({
      available: true,
      provider: 'github',
      host: 'github.com',
      repository: { owner: 'kontourai', name: repositoryOf(thread) },
      branch: `feat/${thread}`,
    });
  }
  const mergeability =
    /^\/api\/pull-requests\/github\/github\.com\/kontourai\/(station|other)\/mergeability$/.exec(
      url.pathname,
    );
  if (mergeability)
    return json({
      available: true,
      effectiveCapabilities: {},
      effectiveMergeMethods: [],
      mergeMethodsSource: 'provider-default',
      data: [
        { ref: '7', sourceBranch: 'feat/t1', mergeability: 'conflicting' },
        { ref: '8', sourceBranch: 'feat/t2', mergeability: 'mergeable' },
      ],
    });
  return new Response(JSON.stringify({ success: false }), { status: 404 });
}

const count = (predicate: (url: URL) => boolean) =>
  requests.filter(predicate).length;
const mergeabilityReads = (repository: string) =>
  count((url) =>
    url.pathname.endsWith(`/kontourai/${repository}/mergeability`),
  );
const contextReads = () =>
  count((url) => url.pathname === '/api/pull-requests/context');
const fullListReads = () =>
  count((url) =>
    /^\/api\/pull-requests\/github\/github\.com\/kontourai\/[^/]+$/.test(
      url.pathname,
    ),
  );

const session = (threadId: string) =>
  ({ threadId, projectSlug: 'station' }) as any;

function Rows({ threads }: { threads: string[] }) {
  return (
    <>
      {threads.map((thread) => (
        <div key={thread} data-testid={`row-${thread}`}>
          <SessionPullRequestConflictChip session={session(thread)} />
        </div>
      ))}
    </>
  );
}

function withClient(client: QueryClient, children: ReactNode) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

// Only the polling clock is fake: TanStack's refetch interval and the Date
// it judges staleness by. Fetch settlement and render notification run on
// real timers, so `settle` lets them land.
async function settle() {
  for (let turn = 0; turn < 5; turn += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
}

// Steps in quarter intervals, settling between, so a fetch completes before
// the next timer fires: one big jump would let a second observer's timer
// join the first's in-flight fetch and hide a per-row poll.
async function advance(ms: number) {
  const step = OBSERVATION_INTERVAL_MS / 4;
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    act(() => {
      vi.advanceTimersByTime(Math.min(step, ms - elapsed));
    });
    await settle();
  }
}

function setVisibility(state: 'hidden' | 'visible') {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
}

const stationRows = ['t1', 't2', 't3', 't4', 't5'];
const otherRows = ['other-1', 'other-2'];

describe('session conflict chips observe once per repository (#2937)', () => {
  let client: QueryClient;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    requests = [];
    _setApiBase(ORIGIN);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : input);
        requests.push(url);
        return respond(url);
      }),
    );
    client = new QueryClient({
      defaultOptions: { queries: { ...stationQueryDefaults(), retry: false } },
    });
  });
  afterEach(() => {
    client.clear();
    setVisibility('visible');
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test('N rows of one repository make one narrow read per interval, never the full list', async () => {
    const rendered = render(
      withClient(client, <Rows threads={[...stationRows, ...otherRows]} />),
    );
    await settle();

    expect(mergeabilityReads('station')).toBe(1);
    expect(mergeabilityReads('other')).toBe(1);
    // Pinned literal, independent of the imported constant: two minutes.
    expect(OBSERVATION_INTERVAL_MS).toBe(120_000);
    // The narrow read is repository-scoped: it names the project only.
    const read = requests.find((url) => url.pathname.endsWith('/mergeability'));
    expect([...read!.searchParams.keys()]).toEqual(['project']);
    // Only t1's branch is conflicting; t2's pull request merges cleanly.
    expect(screen.getAllByText('PR conflict')).toHaveLength(1);
    expect(
      screen.getByTestId('row-t1').textContent?.includes('PR conflict'),
    ).toBe(true);

    // A row mounted mid-interval joins the repository's query; its interval
    // re-arms with the others' on each update rather than firing on its own.
    await advance(OBSERVATION_INTERVAL_MS / 2);
    rendered.rerender(
      withClient(
        client,
        <Rows threads={[...stationRows, 't6', ...otherRows]} />,
      ),
    );
    await settle();
    expect(mergeabilityReads('station')).toBe(1);

    for (let interval = 1; interval <= 3; interval += 1) {
      await advance(OBSERVATION_INTERVAL_MS);
      expect(mergeabilityReads('station')).toBe(interval + 1);
      expect(mergeabilityReads('other')).toBe(interval + 1);
    }
    expect(fullListReads()).toBe(0);
  });

  test('the old 30 s cadence makes no read; two minutes makes one', async () => {
    render(withClient(client, <Rows threads={stationRows} />));
    await settle();
    expect(mergeabilityReads('station')).toBe(1);
    // Literal durations, not the imported constant.
    for (let step = 0; step < 3; step += 1) {
      act(() => {
        vi.advanceTimersByTime(30_000);
      });
      await settle();
    }
    expect(mergeabilityReads('station')).toBe(1);
    expect(contextReads()).toBe(stationRows.length);
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    await settle();
    expect(mergeabilityReads('station')).toBe(2);
  });

  test('a hidden window does not poll, and returning refetches the stale answer', async () => {
    render(withClient(client, <Rows threads={stationRows} />));
    await settle();
    expect(mergeabilityReads('station')).toBe(1);
    const contextsBefore = contextReads();
    expect(contextsBefore).toBe(stationRows.length);

    setVisibility('hidden');
    await advance(OBSERVATION_INTERVAL_MS * 3);
    expect(mergeabilityReads('station')).toBe(1);
    expect(contextReads()).toBe(contextsBefore);

    setVisibility('visible');
    await settle();
    expect(mergeabilityReads('station')).toBe(2);
    expect(fullListReads()).toBe(0);
  });

  test('the last row of a repository unmounting stops its observation', async () => {
    const rendered = render(withClient(client, <Rows threads={stationRows} />));
    await settle();
    rendered.rerender(withClient(client, <Rows threads={[]} />));
    await settle();
    const before = mergeabilityReads('station');
    await advance(OBSERVATION_INTERVAL_MS * 2);
    expect(mergeabilityReads('station')).toBe(before);
  });
});
