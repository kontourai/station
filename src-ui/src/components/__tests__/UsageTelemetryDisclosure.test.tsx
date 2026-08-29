/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { expect, test, vi } from 'vitest';

const { authenticatedFetch } = vi.hoisted(() => ({
  authenticatedFetch: vi.fn(),
}));
vi.mock('@kontourai/station-sdk', () => ({ authenticatedFetch }));
vi.mock('../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));

import {
  resetUsageTelemetryDisclosureDismissal,
  USAGE_TELEMETRY_SNOOZE_STORAGE_KEY,
  UsageTelemetryDisclosure,
  UsageTelemetryDisclosureStep,
} from '../UsageTelemetryDisclosure';

test('DISCLOSURE CONTENT DRIFT DEFECT: Settings renders the server inventory and acknowledges it', async () => {
  authenticatedFetch.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        data: {
          acknowledged: false,
          inventoryRevision: 'rev',
          events: {
            station_started: {
              description: 'Station completed startup.',
              properties: { platform: { domain: ['linux'] } },
            },
          },
        },
      }),
      { status: 200 },
    ),
  );
  authenticatedFetch.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        data: {
          acknowledged: true,
          inventoryRevision: 'rev',
          events: {
            station_started: {
              description: 'Station completed startup.',
              properties: { platform: { domain: ['linux'] } },
            },
          },
        },
      }),
      { status: 200 },
    ),
  );
  render(
    <QueryClientProvider client={new QueryClient()}>
      <UsageTelemetryDisclosure />
    </QueryClientProvider>,
  );
  expect(
    await screen.findByText('station_started'),
    'Settings disclosure did not render the published event name',
  ).toBeTruthy();
  expect(
    screen.getByText('platform'),
    'Settings disclosure did not render the published property',
  ).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'I understand' }));
  await waitFor(() =>
    expect(
      authenticatedFetch,
      'Settings disclosure acknowledgement did not call the receipt endpoint',
    ).toHaveBeenLastCalledWith(
      'http://station.test/api/usage-telemetry/disclosure/acknowledgements',
      { method: 'POST' },
    ),
  );
});

test('a cold-boot 503 is a "not yet", not a cached terminal error', async () => {
  // The route is mounted before `StationRuntime` constructs the service behind
  // it, so a fresh boot answers 503 first. With the app's real query defaults
  // (`retry: 1`, `refetchOnMount: false`, five-minute `staleTime`) a cached
  // error here withholds the disclosure for the entire session — the panel
  // simply never appears.
  const ready = {
    data: {
      acknowledged: false,
      inventoryRevision: 'rev',
      events: {
        station_started: {
          description: 'Station completed startup.',
          properties: { platform: { domain: ['linux'] } },
        },
      },
    },
  };
  authenticatedFetch.mockReset();
  authenticatedFetch.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        success: false,
        error: { code: 'telemetry_not_ready' },
      }),
      { status: 503 },
    ),
  );
  authenticatedFetch.mockResolvedValue(
    new Response(JSON.stringify(ready), { status: 200 }),
  );

  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: {
              staleTime: 5 * 60 * 1000,
              refetchOnMount: false,
              refetchOnWindowFocus: false,
              retry: 1,
            },
          },
        })
      }
    >
      <UsageTelemetryDisclosure />
    </QueryClientProvider>,
  );

  expect(
    await screen.findByText('station_started', undefined, { timeout: 5000 }),
    'the disclosure never recovered from the cold-boot 503',
  ).toBeTruthy();
});

test('a persistently failing acknowledgement does not trap the user behind the first-run dialog', async () => {
  // The first-run disclosure covers the whole app, including the
  // connection-recovery UI. Its acknowledgement can fail persistently — a
  // revoked session, a 403, an unwritable receipt path — so the acknowledgement
  // must not be the only way out, or the app becomes unusable with no recourse
  //Dismissal is for this page only; the receipt is still
  // what stops the disclosure coming back.
  resetUsageTelemetryDisclosureDismissal();
  authenticatedFetch.mockReset();
  authenticatedFetch.mockImplementation(async (url: string) =>
    String(url).endsWith('/acknowledgements')
      ? new Response('{"success":false}', { status: 500 })
      : new Response(
          JSON.stringify({
            data: {
              acknowledged: false,
              inventoryRevision: 'rev',
              events: {
                station_started: {
                  description: 'Station completed startup.',
                  properties: { platform: { domain: ['linux'] } },
                },
              },
            },
          }),
          { status: 200 },
        ),
  );

  render(
    <QueryClientProvider client={new QueryClient()}>
      <UsageTelemetryDisclosure firstRun />
      <div>App behind the dialog</div>
    </QueryClientProvider>,
  );

  // Pin that there IS a dialog to be trapped by, so the dismissal assertion
  // below cannot pass by the dialog never having rendered.
  expect(await screen.findByRole('dialog')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'I understand' }));

  // The failure is disclosed and the action stays available as a retry.
  expect(
    await screen.findByRole('alert'),
    'a failed acknowledgement was not disclosed',
  ).toBeTruthy();
  expect(
    screen.getByRole('button', { name: 'Try again' }),
    'the retry affordance disappeared with the failure',
  ).toBeTruthy();

  // And there is a way out that does not depend on the write succeeding.
  fireEvent.click(screen.getByRole('button', { name: 'Not now' }));

  await waitFor(() =>
    expect(
      screen.queryByRole('dialog'),
      'the dialog survived an explicit dismissal, trapping the user',
    ).toBeNull(),
  );
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  expect(screen.getByText('App behind the dialog')).toBeTruthy();
  resetUsageTelemetryDisclosureDismissal();
});

/** The inventory the first-run step renders, answered from the server. */
function inventoryResponse(acknowledged: boolean) {
  return new Response(
    JSON.stringify({
      data: {
        acknowledged,
        inventoryRevision: 'rev',
        events: {
          station_started: {
            description: 'Station completed startup.',
            properties: { platform: { domain: ['linux'] } },
          },
        },
      },
    }),
    { status: 200 },
  );
}

const ACKNOWLEDGEMENTS_URL =
  'http://station.test/api/usage-telemetry/disclosure/acknowledgements';

test('the first-run STEP acknowledges through the same endpoint, then advances', async () => {
  // Same copy, same receipt: moving the disclosure into the first-run chapter
  // must not fork the acknowledgement into a second write path.
  resetUsageTelemetryDisclosureDismissal();
  authenticatedFetch.mockReset();
  authenticatedFetch.mockImplementation(async (url: string) =>
    String(url).endsWith('/acknowledgements')
      ? inventoryResponse(true)
      : inventoryResponse(false),
  );
  const advance = vi.fn();

  render(
    <QueryClientProvider client={new QueryClient()}>
      <UsageTelemetryDisclosureStep onAdvance={advance} onDefer={vi.fn()} />
    </QueryClientProvider>,
  );

  expect(
    await screen.findByText('station_started'),
    'the first-run step did not render the published event name',
  ).toBeTruthy();
  expect(screen.getByText('platform')).toBeTruthy();
  expect(
    advance,
    'the step advanced before anything was clicked',
  ).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: 'I understand' }));

  await waitFor(() =>
    expect(authenticatedFetch).toHaveBeenLastCalledWith(ACKNOWLEDGEMENTS_URL, {
      method: 'POST',
    }),
  );
  // And only AFTER the receipt landed: advancing on the click would leave a
  // failed write looking like an acknowledgement.
  await waitFor(() => expect(advance).toHaveBeenCalledTimes(1));
  resetUsageTelemetryDisclosureDismissal();
});

test('"Not now" in the step DEFERS — writes nothing, never advances (#765 B1)', async () => {
  // Same semantics as the standalone modal's "Not now": no receipt, the
  // dialog closes. It used to call `onAdvance`, which pushed the reader into
  // step 2 of the run they had just declined — reproduced live as the modal
  // refusing to be dismissed.
  resetUsageTelemetryDisclosureDismissal();
  authenticatedFetch.mockReset();
  authenticatedFetch.mockImplementation(async () => inventoryResponse(false));
  const advance = vi.fn();
  const defer = vi.fn();

  render(
    <QueryClientProvider client={new QueryClient()}>
      <UsageTelemetryDisclosureStep onAdvance={advance} onDefer={defer} />
      <UsageTelemetryDisclosure firstRun />
    </QueryClientProvider>,
  );

  // The standalone modal renders beside the step here on purpose — that is
  // what makes the dismissal assertion below observable — so every query is
  // scoped to the step rather than to the page.
  expect(await screen.findByRole('dialog')).toBeTruthy();
  const step = screen.getByTestId('first-run-disclosure');
  fireEvent.click(within(step).getByRole('button', { name: 'Not now' }));

  await waitFor(() => expect(defer).toHaveBeenCalledTimes(1));
  expect(
    advance,
    '"Not now" advanced the run instead of deferring it',
  ).not.toHaveBeenCalled();
  expect(
    authenticatedFetch.mock.calls.filter((call) =>
      String(call[0]).endsWith('/acknowledgements'),
    ),
    '"Not now" wrote an acknowledgement receipt',
  ).toEqual([]);
  // The standalone modal beside it stands down — the same dismissal the
  // modal's own "Not now" performs — rather than re-offering the moment the
  // run ends.
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  resetUsageTelemetryDisclosureDismissal();
});

test('a dismissal survives a full remount, as a reload does not resurrect the modal (#765 B1)', async () => {
  // The dismissal used to be a module-level flag, which every full page load
  // reset — so the modal re-opened on every visit to `/` and followed the
  // user to `/agents` (3/3 reloads in the live re-verification). The snooze
  // is persisted; here the reload is simulated faithfully: module state is
  // reset (a fresh page's module scope) while localStorage keeps what the
  // dismissal wrote.
  resetUsageTelemetryDisclosureDismissal();
  authenticatedFetch.mockReset();
  authenticatedFetch.mockImplementation(async () => inventoryResponse(false));

  const firstPage = render(
    <QueryClientProvider client={new QueryClient()}>
      <UsageTelemetryDisclosure firstRun />
    </QueryClientProvider>,
  );
  expect(await screen.findByRole('dialog')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

  const persisted = localStorage.getItem(USAGE_TELEMETRY_SNOOZE_STORAGE_KEY);
  expect(persisted, 'the dismissal wrote no snooze record').toBeTruthy();

  // The "reload": fresh module state, surviving storage.
  firstPage.unmount();
  resetUsageTelemetryDisclosureDismissal();
  localStorage.setItem(USAGE_TELEMETRY_SNOOZE_STORAGE_KEY, persisted!);

  render(
    <QueryClientProvider client={new QueryClient()}>
      {/* The Settings presentation shares the query and renders regardless of
          the dismissal — its inventory appearing proves the query settled, so
          the no-dialog assertion below cannot pass vacuously. */}
      <UsageTelemetryDisclosure />
      <UsageTelemetryDisclosure firstRun />
    </QueryClientProvider>,
  );
  expect(await screen.findByText('station_started')).toBeTruthy();
  expect(
    screen.queryByRole('dialog'),
    'the modal re-opened on the next load despite an explicit dismissal',
  ).toBeNull();
  resetUsageTelemetryDisclosureDismissal();
});

test('a lapsed snooze, or a changed inventory, re-offers the disclosure', async () => {
  // The snooze is a deferral, not a substitute for the receipt: after its
  // window — or the moment the server publishes an inventory the user has
  // not seen — the disclosure comes back.
  resetUsageTelemetryDisclosureDismissal();
  authenticatedFetch.mockReset();
  authenticatedFetch.mockImplementation(async () => inventoryResponse(false));

  // Snoozed in the past: the window has lapsed.
  localStorage.setItem(
    USAGE_TELEMETRY_SNOOZE_STORAGE_KEY,
    JSON.stringify({ until: Date.now() - 1000, inventoryRevision: 'rev' }),
  );
  const lapsed = render(
    <QueryClientProvider client={new QueryClient()}>
      <UsageTelemetryDisclosure firstRun />
    </QueryClientProvider>,
  );
  expect(
    await screen.findByRole('dialog'),
    'a lapsed snooze still suppressed the disclosure',
  ).toBeTruthy();
  lapsed.unmount();

  // Snoozed for a DIFFERENT revision than the server now publishes ('rev').
  resetUsageTelemetryDisclosureDismissal();
  localStorage.setItem(
    USAGE_TELEMETRY_SNOOZE_STORAGE_KEY,
    JSON.stringify({
      until: Date.now() + 60 * 60 * 1000,
      inventoryRevision: 'an-older-inventory',
    }),
  );
  render(
    <QueryClientProvider client={new QueryClient()}>
      <UsageTelemetryDisclosure firstRun />
    </QueryClientProvider>,
  );
  expect(
    await screen.findByRole('dialog'),
    'a snooze for an older inventory suppressed a changed one',
  ).toBeTruthy();
  resetUsageTelemetryDisclosureDismissal();
});
