/** @vitest-environment jsdom */
import type { CliSessionGroupView } from '@kontourai/station-contracts/delegation-group';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
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
import {
  NavigationProvider,
  navigationStore,
} from '../../contexts/NavigationContext';
import { CliSessionGroupsPanel } from '../CliSessionGroupsPanel';

const group: CliSessionGroupView = {
  version: 'station.cli-session-group/v1',
  groupId: 'cli-observed',
  revision: 4,
  supervision: 'not-running',
  cancelled: false,
  deadlineAt: 1792629000000,
  maxConcurrent: 2,
  dispatchCount: 5,
  maxDispatches: 5,
  admissionClosed: 'dispatch-limit-exhausted',
  preset: {
    presetId: 'team',
    name: 'Retained team',
    sha256: `sha256:${'b'.repeat(64)}`,
    stationmaster: 'first',
    members: [
      { seatId: 'first', codename: 'Rune', color: '#123ABC', role: 'Reviewer' },
      { seatId: 'second', codename: 'Flux', color: '#123ABC', role: 'Checker' },
      {
        seatId: 'not-started',
        codename: 'Nova',
        color: '#123ABC',
        role: 'Writer',
      },
      {
        seatId: 'failed-turn',
        codename: 'Mist',
        color: '#123ABC',
        role: 'Writer',
      },
      { seatId: 'join', codename: 'Join', color: '#123ABC', role: 'Merger' },
      {
        seatId: 'waiting',
        codename: 'Query',
        color: '#123ABC',
        role: 'Researcher',
      },
    ],
  },
  guarantees: {
    authority: 'station-session',
    portableFlowLineage: 'unbound',
    dollarCap: 'unavailable',
    tokenCap: 'unavailable',
    physicalAttemptCap: 'unavailable',
    deadline: 'stop-admission-and-request-interruption',
  },
  flow: {
    runId: 'cli-observed',
    definition: { id: 'team', version: '1', digest: 'digest' },
    status: 'active',
  },
  acceptance: 'unassessed',
  members: [
    {
      seatId: 'first',
      needs: [],
      state: 'terminal',
      outcome: 'completed',
      handle: {
        taskId: 'task:one',
        conversationId: 'task:one',
        sessionId: 'task:one',
        initialTurnId: 'turn-one',
      },
      terminalEvent: { eventId: 'complete-one', turnId: 'turn-one' },
    },
    {
      seatId: 'second',
      needs: [],
      state: 'launch-intent',
      dispatchFailure: { status: 400, code: 'delegation_refused' },
    },
    {
      seatId: 'not-started',
      needs: [],
      state: 'terminal',
      outcome: 'failed',
      dispatchFailure: {
        status: 403,
        code: 'approval-full-access-not-granted',
      },
    },
    {
      seatId: 'failed-turn',
      needs: [],
      state: 'terminal',
      outcome: 'failed',
      handle: {
        taskId: 'task:failed',
        conversationId: 'task:failed',
        sessionId: 'task:failed',
        initialTurnId: 'turn:failed',
      },
    },
    { seatId: 'join', needs: ['first', 'second'], state: 'pending' },
    {
      seatId: 'waiting',
      needs: [],
      state: 'started',
      attention: {
        kind: 'needs-input',
        observedAt: '2026-10-22T00:00:00.000Z',
        request: { id: 'question', eventId: 'question-event' },
      },
      handle: {
        taskId: 'task:waiting',
        conversationId: 'task:waiting',
        sessionId: 'task:waiting',
        initialTurnId: 'turn:waiting',
      },
    },
  ],
};
function mount() {
  let current = true;
  const scope = {
    apiBase: 'https://station.test',
    authorityKey: 'operator-view',
    isCurrent: () => current,
  };
  setClientCredentialResolver(() => ({
    origin: scope.apiBase,
    credential: 'fixture',
    requestAuthority: scope,
  }));
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const element = () => (
    <QueryClientProvider client={client}>
      <NavigationProvider>
        <CliSessionGroupsPanel scope={scope} />
      </NavigationProvider>
    </QueryClientProvider>
  );
  const view = render(element());
  return {
    client,
    loseAuthority() {
      current = false;
      view.rerender(element());
    },
  };
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setClientCredentialResolver(undefined);
});
function response(value: CliSessionGroupView = group) {
  return new Response(
    JSON.stringify({
      success: true,
      data: { groups: [value], hasMore: false, nextGroupId: null },
    }),
  );
}

test('explicit inspection uses real SDK inventory, shows actual dependencies and unresolved starts, and opens the canonical member session', async () => {
  const fetch = vi.fn(async (_input: RequestInfo | URL) => response());
  vi.stubGlobal('fetch', fetch);
  mount();
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Show session groups' }));
  await screen.findByRole('table', {
    name: 'Members and dependencies for cli-observed',
  });
  expect(screen.getByRole('heading', { name: 'Retained team' })).toBeDefined();
  const tableRegion = screen.getByRole('region', {
    name: 'Scrollable member table for cli-observed',
  });
  expect(tableRegion.tabIndex).toBe(0);
  const graph = screen.getByRole('region', {
    name: 'Dependency graph for cli-observed',
  });
  expect(graph.tabIndex).toBe(0);
  graph.focus();
  expect(document.activeElement).toBe(graph);
  expect(within(graph).getByText('first → join')).toBeDefined();
  expect(within(graph).getByText('second → join')).toBeDefined();
  expect(within(graph).queryByText('waiting → join')).toBeNull();
  expect(within(graph).getByText('Start outcome unresolved')).toBeDefined();
  expect(within(graph).getByText('Needs input · last observed')).toBeDefined();
  expect(screen.getByText('Dependency graph · Revision 4')).toBeDefined();
  tableRegion.focus();
  expect(document.activeElement).toBe(tableRegion);

  expect(screen.getByText(group.preset!.sha256)).toBeDefined();
  const named = within(screen.getByRole('row', { name: /Rune/ }));
  expect(
    named.getByText('Reviewer · Seat first · Color #123ABC'),
  ).toBeDefined();

  expect(String(fetch.mock.calls[0]?.[0])).toBe(
    'https://station.test/api/orchestration/session-groups',
  );
  expect(screen.getByText('first, second')).toBeTruthy();
  expect(screen.getByText(/5 of 5 starts reserved/)).toBeDefined();
  expect(screen.getByText(/Dispatch allowance exhausted/)).toBeDefined();
  expect(
    within(tableRegion).getByText('Start outcome unresolved'),
  ).toBeTruthy();
  expect(
    within(tableRegion).getByText('Needs input · last observed'),
  ).toBeDefined();
  expect(
    screen.getByText(/This observation grants no response permission/),
  ).toBeDefined();
  expect(screen.getAllByText('No accepted session handle')).toHaveLength(3);
  const refused = within(screen.getByRole('row', { name: /not-started/ }));
  expect(refused.getByText('Launch refused')).toBeDefined();
  expect(refused.queryByRole('button')).toBeNull();
  expect(
    within(screen.getByRole('row', { name: /failed-turn/ })).getByText(
      'Turn failed',
    ),
  ).toBeDefined();
  expect(screen.queryByText('Work accepted')).toBeNull();
  expect(
    screen.getByText(
      /Hard dollar, token and physical-attempt caps are unavailable/,
    ),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Open first session' }));
  expect(navigationStore.getSnapshot().pathname).toBe('/');
  expect(new URLSearchParams(window.location.search).get('surface')).toBe(
    'activity',
  );
  expect(new URLSearchParams(window.location.search).get('session')).toBe(
    'task:one',
  );
});

test('legacy preset records render seat IDs without inventing retained names', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      response({
        ...group,
        preset: { ...group.preset!, members: undefined },
      }),
    ),
  );
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Show session groups' }));
  await screen.findByRole('table');
  expect(screen.getByRole('rowheader', { name: /^first$/ })).toBeDefined();
  expect(screen.queryByText('Rune')).toBeNull();
  expect(
    screen.queryByText('Reviewer · Seat first · Color #123ABC'),
  ).toBeNull();
});

test('incomplete context sync discloses each retained receipt without an automatic resend action', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      response({
        ...group,
        contextSync: {
          operationId: 'sync-one',
          runId: 'folded-run',
          contentHash: `sha256:${'a'.repeat(64)}`,
          timestamp: new Date().toISOString(),
          status: 'incomplete',
          members: [
            {
              seatId: 'first',
              status: 'acknowledged',
              attempts: 1,
              toolCalls: 0,
              turnId: 'turn-one',
              terminalEventId: 'terminal-one',
              nativeIdentityHash: `sha256:${'b'.repeat(64)}`,
            },
            { seatId: 'second', status: 'unknown', attempts: 1 },
          ],
        },
      }),
    ),
  );
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Show session groups' }));
  await screen.findByText('Context sync: incomplete · folded-run');
  const receipts = within(
    screen.getByRole('list', { name: 'Context sync receipts' }),
  );
  expect(
    receipts.getByText('first: acknowledged · 1 attempts reserved'),
  ).toBeDefined();
  expect(
    receipts.getByText('second: unknown · 1 attempts reserved'),
  ).toBeDefined();
  expect(
    screen.getByText(/Unknown attempts are never resent automatically/),
  ).toBeDefined();
  expect(
    screen.queryByRole('button', { name: /resend|retry sync/i }),
  ).toBeNull();
});

test('lost authority withholds both a late response and its query cache entry', async () => {
  let resolve!: (value: Response) => void;
  const fetch = vi.fn(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  vi.stubGlobal('fetch', fetch);
  const view = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Show session groups' }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  view.loseAuthority();
  resolve(response());
  await screen.findByRole('alert');
  await waitFor(() =>
    expect(
      view.client
        .getQueryCache()
        .findAll({ queryKey: ['cli-session-groups'] })
        .every((query) => query.state.fetchStatus === 'idle'),
    ).toBe(true),
  );
  expect(screen.queryByRole('table')).toBeNull();
  expect(
    screen.queryByRole('img', { name: /Declared dependencies/ }),
  ).toBeNull();
  expect(
    view.client.getQueryData([
      'cli-session-groups',
      'https://station.test',
      'operator-view',
      null,
    ]),
  ).toBeUndefined();
});

test('an authority refusal on refresh hides an earlier successful group observation', async () => {
  let allowed = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      allowed
        ? response()
        : new Response(JSON.stringify({ success: false }), { status: 403 }),
    ),
  );
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Show session groups' }));
  await screen.findByRole('table');
  allowed = false;
  fireEvent.click(
    screen.getByRole('button', { name: 'More session group actions' }),
  );
  fireEvent.click(screen.getByRole('menuitem', { name: 'Refresh groups' }));
  await screen.findByRole('alert');
  expect(screen.queryByRole('table')).toBeNull();
  expect(
    screen.queryByRole('img', { name: /Declared dependencies/ }),
  ).toBeNull();
});
