/**
 * @vitest-environment jsdom
 *
 * The presence tray against the REAL query stack: a real `QueryClient`, the
 * real `useLiveActivityQuery`, the real `fetchLiveActivity` and the real
 * contract parser, with only the network stubbed.
 *
 * This file exists because the tray's sibling suite mocks the hook, and a
 * mocked hook cannot reproduce the defects these tests pin. TanStack RETAINS
 * the last successful `data` when a later fetch rejects, so reading `data`
 * alone keeps a roster on screen under copy asserting it is live — the list of
 * who WAS here, labelled as who IS here. And query-core REFUSES a `undefined`
 * result, which is how a 404 meaning "this Station does not publish live work"
 * used to arrive dressed as a failing Station. Both are properties of the real
 * cache; a mock can only assert what someone already believed.
 *
 * `retry: false` is the only production option overridden, and it is a test
 * harness choice, not the behaviour under test: it removes TanStack's default
 * three retries so a failing fetch reaches `status: 'error'` promptly. The
 * error propagation itself is entirely real.
 */

import { engineId } from '@kontourai/station-contracts/agent-identity';
import {
  _setApiBase,
  type OrchestrationSessionSummary,
} from '@kontourai/station-sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const showSurfaceStub = vi.hoisted(() => vi.fn());
vi.mock('../contexts/useShowSurface', () => ({
  useShowSurface: () => showSurfaceStub,
}));

import {
  LIVE_ACTIVITY_SCHEMA_VERSION,
  parseLiveActivityProjection,
} from '@kontourai/station-contracts/live-activity';
import { ProjectSidebarPresenceTray } from '../components/project-sidebar/ProjectSidebarPresenceTray';

/** The body `/api/live-activity` serves for one present participant. */
function onePresentBody() {
  const body = {
    schemaVersion: LIVE_ACTIVITY_SCHEMA_VERSION,
    observedAt: 1_700_000_000_000,
    connectedClients: 1,
    participants: [
      {
        id: '1'.padStart(24, '0'),
        actor: { kind: 'human', label: 'Participant 0123456789ab' },
        scope: { projectId: 'p1', projectSlug: 'station', taskId: '77' },
        work: {
          workName: 'Reviewing the panel',
          workState: 'reviewing',
          startedAt: 1_700_000_000_000,
        },
      },
    ],
  };
  // The fixture is what production parses, proven by parsing it here.
  if (!parseLiveActivityProjection(body))
    throw new Error(
      'fixture is not a projection the production parser accepts',
    );
  return body;
}

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installPresenceFetch(
  presence: () => Promise<Response>,
  sessions: () => Promise<Response> = async () =>
    jsonResponse({ success: true, data: [] }, 200),
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      if (url.pathname === '/api/live-activity') return presence();
      if (url.pathname === '/api/orchestration/sessions/read-model')
        return sessions();
      throw new Error(`Unexpected request: ${url.pathname}`);
    }),
  );
}

function renderTray() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <ProjectSidebarPresenceTray />
    </QueryClientProvider>,
  );
  return { client, ...view };
}

function trigger() {
  return screen.getByRole('button', { name: /^Who is here:/ });
}

beforeEach(() => {
  _setApiBase('http://station.test');
  showSurfaceStub.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

// The HIGH finding. A Station that stops answering must not leave its last
// roster on screen described as live.
test('a server that stops answering replaces the roster, it does not keep it', async () => {
  const fetchStub = vi.fn(async () =>
    jsonResponse({ success: true, data: onePresentBody() }, 200),
  );
  installPresenceFetch(fetchStub);
  const { client, container } = renderTray();

  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Who is here: 1 participant' }),
    ).toBeTruthy(),
  );
  fireEvent.click(trigger());
  expect(screen.getByText('Participant 0123456789ab')).toBeTruthy();

  // The server goes away. The cache still holds the good answer.
  fetchStub.mockImplementation(async () =>
    jsonResponse({ error: 'down' }, 503),
  );
  await client.refetchQueries();

  await waitFor(() =>
    expect(
      screen.getByRole('button', {
        name: 'Who is here: Station is not answering',
      }),
    ).toBeTruthy(),
  );
  // No count, and the rows the stale roster would have produced are gone.
  expect(container.querySelector('.sidebar__presence-count')).toBeNull();
  expect(screen.queryByText('Participant 0123456789ab')).toBeNull();
  expect(screen.queryByRole('list', { name: 'Participants here' })).toBeNull();
  // The cache really did keep the data — so the refusal above is the tray's
  // rule, not an empty cache doing the work for it.
  expect(
    client.getQueryData(['live-activity']) ??
      client
        .getQueryCache()
        .getAll()
        .find((entry) => entry.state.data !== undefined)?.state.data,
  ).toBeTruthy();
});

// MED-1: a transient failure on the FIRST read is not a capability gap.
test('a 503 on the first read says Station is not answering, not unavailable', async () => {
  installPresenceFetch(async () => jsonResponse({ error: 'down' }, 503));
  const { container } = renderTray();
  await waitFor(() =>
    expect(
      screen.getByRole('button', {
        name: 'Who is here: Station is not answering',
      }),
    ).toBeTruthy(),
  );
  expect(container.querySelector('.sidebar__presence-count')).toBeNull();
});

// A 404 is an ANSWER. The route returns it for a hosted Station, for a Station
// with no room runtime, and for a runtime whose activity is not available —
// three ways of saying "this Station does not publish live work", none of them
// a failure. It used to reach the tray as an error, because `fetchLiveActivity`
// maps 404 to `undefined` and query-core throws on a queryFn that resolves
// `undefined`; the whole of that path is real here, with only the network
// stubbed, so this test is the proof the fix holds end to end rather than a
// statement about the mapping in isolation.
test('a 404 says this Station does not publish live work, not that it is failing', async () => {
  installPresenceFetch(async () => jsonResponse({ error: 'unavailable' }, 404));
  const { client, container } = renderTray();
  await waitFor(() =>
    expect(
      screen.getByRole('button', {
        name: 'Who is here: not published by this Station',
      }),
    ).toBeTruthy(),
  );
  // No count, and no claim about people either way.
  expect(container.querySelector('.sidebar__presence-count')).toBeNull();
  fireEvent.click(trigger());
  const tray = screen.getByRole('dialog', { name: 'Who is here' });
  expect(tray.textContent).toMatch(/does not publish live work/);
  expect(tray.textContent).not.toMatch(/did not answer/);
  // The seam itself: absence survived as a VALUE the query can hold. If this
  // is `undefined` again the query is in error and the copy above is a lie
  // about a Station that answered.
  expect(client.getQueryData(['live-activity'])).toBeNull();
});

// The anti-conflation test. These two are the states this component has most
// reason to confuse — neither produces a roster, and for a while both arrived
// as `status: 'error'` — so they are driven through the same real cache in one
// test and required to DIFFER. A future change that collapses them fails here
// whichever direction it collapses in.
test('a 404 and a 503 are different states, and neither is described as the other', async () => {
  installPresenceFetch(async () => jsonResponse({ error: 'unavailable' }, 404));
  const absent = renderTray();
  await waitFor(() =>
    expect(trigger().getAttribute('aria-label')).toBeTruthy(),
  );
  await waitFor(() =>
    expect(trigger().getAttribute('aria-label')).toBe(
      'Who is here: not published by this Station',
    ),
  );
  const absentName = trigger().getAttribute('aria-label');
  absent.unmount();

  installPresenceFetch(async () => jsonResponse({ error: 'down' }, 503));
  renderTray();
  await waitFor(() =>
    expect(trigger().getAttribute('aria-label')).toBe(
      'Who is here: Station is not answering',
    ),
  );
  const failingName = trigger().getAttribute('aria-label');

  expect(absentName).toBe('Who is here: not published by this Station');
  expect(failingName).toBe('Who is here: Station is not answering');
  expect(absentName).not.toBe(failingName);
});

function session(
  threadId: string,
  overrides: Partial<OrchestrationSessionSummary> = {},
): OrchestrationSessionSummary {
  return {
    provider: engineId('codex'),
    threadId,
    status: 'running',
    controlMode: 'station-owned',
    answerability: { answerable: true },
    isLoaded: true,
    isPersisted: true,
    eventCount: 2,
    createdAt: '2026-10-02T18:00:00Z',
    updatedAt: '2026-10-02T18:01:00Z',
    lifecycleState: 'running',
    hasActiveTurn: true,
    displayTitle: threadId,
    ...overrides,
  };
}

test('ordinary running and attention sessions are visible and Follow carries the exact session', async () => {
  installPresenceFetch(
    async () =>
      jsonResponse(
        {
          success: true,
          data: {
            ...onePresentBody(),
            participants: [],
            connectedClients: 5,
          },
        },
        200,
      ),
    async () =>
      jsonResponse(
        {
          success: true,
          data: [
            session('ordinary-chat'),
            session('approval-chat', { pendingReview: true }),
            session('idle-chat', { hasActiveTurn: false }),
            session('finished-chat', {
              lifecycleState: 'completed',
              hasActiveTurn: false,
            }),
            session('external-chat', { controlMode: 'read-only-attached' }),
          ],
        },
        200,
      ),
  );
  const { container } = renderTray();
  await waitFor(() =>
    expect(trigger().getAttribute('aria-label')).toBe(
      'Who is here: 2 active sessions',
    ),
  );
  expect(
    container.querySelector('.sidebar__presence-work-count')?.textContent,
  ).toBe('2 active');
  expect(container.querySelector('.sidebar__presence-count')).toBeNull();
  fireEvent.click(trigger());
  const active = screen.getByRole('list', { name: 'Active sessions' });
  expect(within(active).getAllByRole('listitem')).toHaveLength(2);
  expect(within(active).getByText('Running')).toBeTruthy();
  expect(within(active).getByText('Needs attention')).toBeTruthy();
  fireEvent.click(
    within(active).getByRole('button', { name: 'Follow approval-chat' }),
  );
  expect(showSurfaceStub).toHaveBeenCalledWith('activity', {
    session: 'approval-chat',
  });
  expect(screen.queryByRole('dialog', { name: 'Who is here' })).toBeNull();
  fireEvent.click(trigger());
  fireEvent.click(screen.getByRole('button', { name: 'Open Activity' }));
  expect(showSurfaceStub).toHaveBeenLastCalledWith('activity');
});

test('task-room agents share one session row and completion removes their active badge', async () => {
  let summaries = [session('task-agent')];
  installPresenceFetch(
    async () =>
      jsonResponse(
        {
          success: true,
          data: {
            ...onePresentBody(),
            participants: [
              ...onePresentBody().participants,
              {
                id: '2'.padStart(24, '0'),
                actor: { kind: 'agent', label: 'Codex' },
                scope: {
                  projectId: 'p1',
                  projectSlug: 'station',
                  taskId: '77',
                },
                work: {
                  sessionId: 'task-agent',
                  workName: 'Room task',
                  workState: 'working',
                  startedAt: 1_700_000_000_000,
                },
              },
            ],
          },
        },
        200,
      ),
    async () => jsonResponse({ success: true, data: summaries }, 200),
  );
  const { client, container } = renderTray();
  await waitFor(() =>
    expect(trigger().getAttribute('aria-label')).toBe(
      'Who is here: 1 participant; 1 active session',
    ),
  );
  fireEvent.click(trigger());
  expect(screen.getAllByRole('button', { name: /^Follow/ })).toHaveLength(1);
  expect(screen.queryByRole('list', { name: 'Agent workers here' })).toBeNull();
  summaries = [
    session('task-agent', {
      lifecycleState: 'completed',
      hasActiveTurn: false,
    }),
  ];
  await client.refetchQueries();
  await waitFor(() =>
    expect(screen.queryByRole('list', { name: 'Active sessions' })).toBeNull(),
  );
  expect(screen.queryByRole('button', { name: /^Follow/ })).toBeNull();
  expect(container.querySelector('.sidebar__presence-work-count')).toBeNull();
  expect(screen.getByText('Participant 0123456789ab')).toBeTruthy();
});

test('presence and session failures hide only their own stale rows', async () => {
  let presenceStatus = 200;
  let sessionsStatus = 200;
  installPresenceFetch(
    async () =>
      presenceStatus === 200
        ? jsonResponse({ success: true, data: onePresentBody() }, 200)
        : jsonResponse({ error: 'unavailable' }, presenceStatus),
    async () =>
      sessionsStatus === 200
        ? jsonResponse({ success: true, data: [session('ordinary-chat')] }, 200)
        : jsonResponse({ error: 'down' }, sessionsStatus),
  );
  const { client, container } = renderTray();
  await waitFor(() =>
    expect(trigger().getAttribute('aria-label')).toBe(
      'Who is here: 1 participant; 1 active session',
    ),
  );
  fireEvent.click(trigger());
  presenceStatus = 404;
  await client.refetchQueries();
  await waitFor(() =>
    expect(screen.queryByText('Participant 0123456789ab')).toBeNull(),
  );
  expect(screen.getByText('ordinary-chat')).toBeTruthy();
  expect(screen.getByText(/does not publish live work/)).toBeTruthy();

  presenceStatus = 200;
  sessionsStatus = 503;
  await client.refetchQueries();
  await waitFor(() =>
    expect(screen.getByText('Participant 0123456789ab')).toBeTruthy(),
  );
  await waitFor(() => expect(screen.queryByText('ordinary-chat')).toBeNull());
  expect(screen.getByText(/Activity is unavailable/)).toBeTruthy();
  expect(container.querySelector('.sidebar__presence-work-count')).toBeNull();
  expect(
    client.getQueryData<OrchestrationSessionSummary[]>([
      'orchestration-sessions',
    ])?.[0]?.threadId,
  ).toBe('ordinary-chat');
});

test('pending sessions stay unknown while task-room participants are available', async () => {
  let finishSessions: ((response: Response) => void) | undefined;
  const sessionsResponse = new Promise<Response>((resolve) => {
    finishSessions = resolve;
  });
  installPresenceFetch(
    async () => jsonResponse({ success: true, data: onePresentBody() }, 200),
    () => sessionsResponse,
  );
  const { container } = renderTray();
  await waitFor(() =>
    expect(trigger().getAttribute('aria-label')).toBe(
      'Who is here: 1 participant; activity not read yet',
    ),
  );
  fireEvent.click(trigger());
  expect(screen.getByText('Activity has not been read yet.')).toBeTruthy();
  expect(
    screen.queryByText('No sessions are running or need attention.'),
  ).toBeNull();
  expect(container.querySelector('.sidebar__presence-work-count')).toBeNull();
  finishSessions?.(
    jsonResponse({ success: true, data: [session('ordinary-chat')] }, 200),
  );
  await waitFor(() => expect(screen.getByText('ordinary-chat')).toBeTruthy());
});
