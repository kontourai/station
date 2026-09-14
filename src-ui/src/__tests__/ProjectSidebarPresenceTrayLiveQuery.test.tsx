/**
 * @vitest-environment jsdom
 *
 * The presence tray against the REAL query stack: a real `QueryClient`, the
 * real `useLiveActivityQuery`, the real `fetchLiveActivity` and the real
 * contract parser, with only the network stubbed.
 *
 * This file exists because the tray's sibling suite mocks the hook, and a
 * mocked hook cannot reproduce the defect these tests pin: TanStack RETAINS
 * the last successful `data` when a later fetch rejects. Reading `data` alone
 * therefore keeps a roster on screen under copy asserting it is live — the
 * list of who WAS here, labelled as who IS here. Nothing short of a real cache
 * proves the tray refuses that.
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

// The disclosed gap, pinned so it stays visible. `fetchLiveActivity` maps a
// 404 — the hosted deployment that serves no projection at all — to
// `undefined`, and `useQuery` CANNOT carry an undefined value: it resolves to
// `status: 'error'` with TanStack's own `["live-activity"] data is undefined`.
// So the capability gap and the failing server are one state here, the tray
// claims neither, and a branch that once claimed to tell them apart was
// unreachable for every input. This test is what would go red if the fetcher
// were ever changed to return a value for "no projection on this host" —
// which is the fix, and belongs in the SDK.
test('a 404 and a 503 are the same state here, and it claims neither cause', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => jsonResponse({ error: 'unavailable' }, 404)),
  );
  renderTray();
  await waitFor(() =>
    expect(
      screen.getByRole('button', {
        name: 'Who is here: Station is not answering',
      }),
    ).toBeTruthy(),
  );
  fireEvent.click(trigger());
  const tray = screen.getByRole('dialog', { name: 'Who is here' });
  // It names both possibilities rather than picking one it cannot know.
  expect(tray.textContent).toMatch(
    /failing and one that does not offer presence/,
  );
  expect(tray.textContent).not.toMatch(/unavailable on this Station/);
});
