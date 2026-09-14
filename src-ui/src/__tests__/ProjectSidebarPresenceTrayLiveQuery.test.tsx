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

import { _setApiBase } from '@kontourai/station-sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  vi.stubGlobal('fetch', fetchStub);
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
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => jsonResponse({ error: 'down' }, 503)),
  );
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
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => jsonResponse({ error: 'unavailable' }, 404)),
  );
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
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => jsonResponse({ error: 'unavailable' }, 404)),
  );
  const absent = renderTray();
  await waitFor(() =>
    expect(trigger().getAttribute('aria-label')).toBeTruthy(),
  );
  await waitFor(() =>
    expect(trigger().getAttribute('aria-label')).not.toBe(
      'Who is here: not read yet',
    ),
  );
  const absentName = trigger().getAttribute('aria-label');
  absent.unmount();

  vi.stubGlobal(
    'fetch',
    vi.fn(async () => jsonResponse({ error: 'down' }, 503)),
  );
  renderTray();
  await waitFor(() =>
    expect(trigger().getAttribute('aria-label')).not.toBe(
      'Who is here: not read yet',
    ),
  );
  const failingName = trigger().getAttribute('aria-label');

  expect(absentName).toBe('Who is here: not published by this Station');
  expect(failingName).toBe('Who is here: Station is not answering');
  expect(absentName).not.toBe(failingName);
});
