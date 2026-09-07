/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { expect, test, vi } from 'vitest';

const { authenticatedFetch, updateConfig, appConfig } = vi.hoisted(() => ({
  authenticatedFetch: vi.fn(),
  updateConfig: vi.fn(),
  /** The `['config']` snapshot the step reads its first precedence link from. */
  appConfig: {
    current: undefined as { telemetryEnabled?: boolean } | undefined,
  },
}));
/**
 * The SAME write path the Settings row uses: `useUpdateConfigMutation` is
 * `PUT /config/app` (`packages/sdk/.../agentAdmin.ts`), so a preference this
 * step records is a preference Settings shows. The spy stands in for the
 * mutation, and every assertion below is on what it was CALLED with.
 */
vi.mock('@kontourai/station-sdk', () => ({
  authenticatedFetch,
  useConfigQuery: () => ({ data: appConfig.current }),
  useUpdateConfigMutation: () => ({
    isPending: false,
    mutate: (
      variables: Record<string, unknown>,
      handlers?: {
        onSuccess?: (result: {
          ignoredKeys?: { key: string; reason: string }[];
        }) => void;
        onError?: (error: unknown) => void;
      },
    ) => updateConfig(variables, handlers),
  }),
}));
vi.mock('../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));

import {
  resetUsageTelemetryDisclosureDismissal,
  USAGE_TELEMETRY_SNOOZE_STORAGE_KEY,
  UsageTelemetryDisclosure,
  UsageTelemetryDisclosureStep,
  usageTelemetryDisclosureSummary,
} from '../UsageTelemetryDisclosure';

test('DISCLOSURE CONTENT DRIFT DEFECT: Settings renders the server inventory and acknowledges it', async () => {
  appConfig.current = undefined;
  authenticatedFetch.mockReset();
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
  // #1600: the action names the decision it makes, here and in the modal, and
  // keeping the state the host is already in writes only the receipt.
  fireEvent.click(
    screen.getByRole('button', { name: 'Keep usage telemetry on' }),
  );
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
  fireEvent.click(
    screen.getByRole('button', { name: 'Keep usage telemetry on' }),
  );

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
function inventoryResponse(
  acknowledged: boolean,
  derived: {
    endpointConfigured?: boolean;
    telemetryEnabled?: boolean;
    enabledSource?: 'config' | 'env' | 'default';
  } = {},
) {
  return new Response(
    JSON.stringify({
      data: {
        acknowledged,
        inventoryRevision: 'rev',
        endpointConfigured: derived.endpointConfigured ?? false,
        telemetryEnabled: derived.telemetryEnabled ?? true,
        enabledSource: derived.enabledSource ?? 'default',
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

/**
 * Every step test drives the same surface: the step alone, with the receipt
 * POST answering an acknowledged inventory.
 */
function renderStep(
  advance: () => void,
  derived: {
    endpointConfigured?: boolean;
    telemetryEnabled?: boolean;
    enabledSource?: 'config' | 'env' | 'default';
  } = {},
  config?: { telemetryEnabled?: boolean },
) {
  authenticatedFetch.mockReset();
  authenticatedFetch.mockImplementation(async (url: string) =>
    String(url).endsWith('/acknowledgements')
      ? inventoryResponse(true, derived)
      : inventoryResponse(false, derived),
  );
  updateConfig.mockReset();
  appConfig.current = config;
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <UsageTelemetryDisclosureStep onAdvance={advance} />
    </QueryClientProvider>,
  );
}

const ACKNOWLEDGEMENTS_URL =
  'http://station.test/api/usage-telemetry/disclosure/acknowledgements';

test('the first-run STEP acknowledges through the same endpoint, then advances', async () => {
  // Same copy, same receipt: moving the disclosure into the first-run chapter
  // must not fork the acknowledgement into a second write path.
  resetUsageTelemetryDisclosureDismissal();
  const advance = vi.fn();
  renderStep(advance);

  expect(
    await screen.findByText('station_started'),
    'the first-run step did not render the published event name',
  ).toBeTruthy();
  expect(screen.getByText('platform')).toBeTruthy();
  expect(
    advance,
    'the step advanced before anything was clicked',
  ).not.toHaveBeenCalled();

  fireEvent.click(
    screen.getByRole('button', { name: 'Keep usage telemetry on' }),
  );

  await waitFor(() =>
    expect(authenticatedFetch).toHaveBeenLastCalledWith(ACKNOWLEDGEMENTS_URL, {
      method: 'POST',
    }),
  );
  // And only AFTER the receipt landed: advancing on the click would leave a
  // failed write looking like an acknowledgement.
  await waitFor(() => expect(advance).toHaveBeenCalledTimes(1));
  // Keeping the current state is not a change, so it writes nothing.
  expect(
    updateConfig,
    'keeping the current setting still wrote to the config',
  ).not.toHaveBeenCalled();
  resetUsageTelemetryDisclosureDismissal();
});

test('#1582 A3: the step leads with a derived sentence and hides the schema behind a disclosure', async () => {
  // The first screen of the first run used to open with the whole generated
  // inventory. It is still there — the acknowledgement is worthless if the
  // reader cannot reach what they are acknowledging — but behind a summary.
  resetUsageTelemetryDisclosureDismissal();
  renderStep(vi.fn(), { endpointConfigured: false });

  expect(
    await screen.findByText(
      'Station can send anonymous usage events, only when a telemetry endpoint is configured; none is configured here, so nothing is sent.',
    ),
  ).toBeTruthy();
  const details = screen
    .getByTestId('first-run-disclosure')
    .querySelector('details');
  expect(details, 'the inventory is not behind a disclosure').toBeTruthy();
  expect(
    details?.hasAttribute('open'),
    'the inventory is expanded on the first screen',
  ).toBe(false);
  expect(details?.querySelector('summary')?.textContent).toBe(
    'See exactly what is sent',
  );
  // The schema is INSIDE the disclosure, not beside it.
  expect(details?.textContent).toContain('station_started');
  resetUsageTelemetryDisclosureDismissal();
});

test('#1582 A3: the summary is derived from the host, never asserted', () => {
  // "none is configured here" is a claim about THIS Station. A build that
  // cannot see the endpoint says less rather than guessing.
  expect(usageTelemetryDisclosureSummary(false)).toBe(
    'Station can send anonymous usage events, only when a telemetry endpoint is configured; none is configured here, so nothing is sent.',
  );
  expect(usageTelemetryDisclosureSummary(true)).toBe(
    'Station can send anonymous usage events, only when a telemetry endpoint is configured; one is configured on this Station.',
  );
  expect(usageTelemetryDisclosureSummary(undefined)).toBe(
    'Station can send anonymous usage events, only when a telemetry endpoint is configured.',
  );
});

test('#1582 A3: "Turn it off" writes the setting Settings reads, then acknowledges', async () => {
  // The button names a decision, so the decision has to happen: a label with
  // nothing behind it is the defect this change exists to remove. The write
  // is `telemetryEnabled` through `PUT /config/app` — the Settings row's own
  // key and the server's own emission gate.
  resetUsageTelemetryDisclosureDismissal();
  const advance = vi.fn();
  renderStep(advance, { telemetryEnabled: true });
  await screen.findByRole('button', { name: 'Turn it off' });

  fireEvent.click(screen.getByRole('button', { name: 'Turn it off' }));

  expect(updateConfig).toHaveBeenCalledTimes(1);
  expect(updateConfig.mock.calls[0][0]).toEqual({ telemetryEnabled: false });
  // Nothing is acknowledged until the setting has actually landed.
  expect(
    authenticatedFetch.mock.calls.filter((call) =>
      String(call[0]).endsWith('/acknowledgements'),
    ),
    'the receipt was written before the setting',
  ).toEqual([]);
  expect(advance).not.toHaveBeenCalled();

  await act(async () => {
    updateConfig.mock.calls[0][1]?.onSuccess?.({});
  });
  await waitFor(() =>
    expect(authenticatedFetch).toHaveBeenLastCalledWith(ACKNOWLEDGEMENTS_URL, {
      method: 'POST',
    }),
  );
  await waitFor(() => expect(advance).toHaveBeenCalledTimes(1));
  resetUsageTelemetryDisclosureDismissal();
});

test('#1582 A3: an already-off host is offered the decision it can actually make', async () => {
  // `telemetryEnabled` folds `STATION_TELEMETRY_ENABLED` and the default, so
  // a host the environment switched off reports off. Offering "Turn it off"
  // there would be an action with nothing behind it, and "Keep usage
  // telemetry on" would name a state that is not the case.
  resetUsageTelemetryDisclosureDismissal();
  const advance = vi.fn();
  renderStep(advance, { telemetryEnabled: false });

  expect(
    await screen.findByRole('button', { name: 'Keep usage telemetry off' }),
  ).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Turn it off' })).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Turn it on' }));
  expect(updateConfig.mock.calls[0][0]).toEqual({ telemetryEnabled: true });
  resetUsageTelemetryDisclosureDismissal();
});

test('#1582 A3 (M1): the label follows the config the Settings row writes, not a stale disclosure', async () => {
  // The scenario, end to end: the environment has telemetry OFF, the user
  // defers the run, turns it ON in Settings, and comes back. `['config']` is
  // invalidated by that write; `['usage-telemetry-disclosure']` is NOT, and
  // carries a five-minute staleTime with the chapter holding the observer —
  // so a step reading only the disclosure offered "Keep usage telemetry off"
  // over a host that was on, and "keeping" it wrote nothing while the receipt
  // went in.
  resetUsageTelemetryDisclosureDismissal();
  const advance = vi.fn();
  renderStep(
    advance,
    { telemetryEnabled: false, enabledSource: 'env' },
    { telemetryEnabled: true },
  );

  expect(
    await screen.findByRole('button', { name: 'Keep usage telemetry on' }),
    'the step named the stale disclosure state, not the recorded setting',
  ).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Turn it off' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Turn it on' })).toBeNull();
  resetUsageTelemetryDisclosureDismissal();
});

test('#1582 A3 (L1): keeping an ENV-held state writes it down; keeping a recorded one does not', async () => {
  // A value in force with nothing durable behind it is a decision that
  // evaporates the day the variable does. Keeping it is the moment to record
  // it — and only then: re-writing a value config or the default already
  // carries would put a stored field on every home that ever ran first run.
  for (const [label, derived, config, expected] of [
    [
      'env-held off, nothing recorded',
      { telemetryEnabled: false, enabledSource: 'env' as const },
      undefined,
      [{ telemetryEnabled: false }],
    ],
    [
      'env-held on, nothing recorded',
      { telemetryEnabled: true, enabledSource: 'env' as const },
      undefined,
      [{ telemetryEnabled: true }],
    ],
    [
      'the default',
      { telemetryEnabled: true, enabledSource: 'default' as const },
      undefined,
      [],
    ],
    [
      'already recorded in config',
      { telemetryEnabled: true, enabledSource: 'config' as const },
      { telemetryEnabled: true },
      [],
    ],
    [
      'recorded since the disclosure was fetched',
      { telemetryEnabled: true, enabledSource: 'env' as const },
      { telemetryEnabled: true },
      [],
    ],
  ] as const) {
    resetUsageTelemetryDisclosureDismissal();
    const advance = vi.fn();
    const view = renderStep(advance, derived, config);
    const keep = await screen.findByRole('button', {
      name: /^Keep usage telemetry (on|off)$/,
    });
    fireEvent.click(keep);
    expect(
      updateConfig.mock.calls.map((call) => call[0]),
      `keeping ${label} wrote the wrong thing`,
    ).toEqual(expected);
    view.unmount();
    resetUsageTelemetryDisclosureDismissal();
  }
});

test('#1582 A3: a REFUSED setting write neither acknowledges nor advances', async () => {
  // `PUT /config/app` answers 2xx and reports a key it declined in
  // `ignoredKeys`, so the obvious success path would write the receipt, move
  // the run on, and leave the reader told telemetry was turned off while it
  // is still on.
  resetUsageTelemetryDisclosureDismissal();
  const advance = vi.fn();
  renderStep(advance, { telemetryEnabled: true });
  await screen.findByRole('button', { name: 'Turn it off' });

  fireEvent.click(screen.getByRole('button', { name: 'Turn it off' }));
  await act(async () => {
    updateConfig.mock.calls[0][1]?.onSuccess?.({
      ignoredKeys: [{ key: 'telemetryEnabled', reason: 'unknown' }],
    });
  });

  expect(
    authenticatedFetch.mock.calls.filter((call) =>
      String(call[0]).endsWith('/acknowledgements'),
    ),
    'a refused setting write still wrote an acknowledgement receipt',
  ).toEqual([]);
  expect(
    advance,
    'a refused setting write still advanced the run',
  ).not.toHaveBeenCalled();
  expect(screen.getByRole('alert').textContent).toBe(
    'The usage telemetry setting could not be saved.',
  );
  resetUsageTelemetryDisclosureDismissal();
});

/**
 * The standalone surface, driven the same way the step is: the real component,
 * the real query hooks, mocked only at the SDK boundary.
 */
function renderModal(
  derived: {
    endpointConfigured?: boolean;
    telemetryEnabled?: boolean;
    enabledSource?: 'config' | 'env' | 'default';
  } = {},
  config?: { telemetryEnabled?: boolean },
) {
  resetUsageTelemetryDisclosureDismissal();
  authenticatedFetch.mockReset();
  authenticatedFetch.mockImplementation(async (url: string) =>
    String(url).endsWith('/acknowledgements')
      ? inventoryResponse(true, derived)
      : inventoryResponse(false, derived),
  );
  updateConfig.mockReset();
  appConfig.current = config;
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <UsageTelemetryDisclosure firstRun />
    </QueryClientProvider>,
  );
}

test('#1600: the standalone modal leads with the derived sentence, not the inventory', async () => {
  // The population that meets THIS surface — every home that upgraded into the
  // disclosure, plus Settings — used to get the whole generated schema and two
  // buttons that named neither choice, while the first-run step had already
  // moved to a summary. Same disclosure, one presentation of its copy.
  const view = renderModal({ endpointConfigured: false });

  const modal = await screen.findByTestId('usage-telemetry-disclosure-modal');
  expect(
    screen.getByText(
      'Station can send anonymous usage events, only when a telemetry endpoint is configured; none is configured here, so nothing is sent.',
    ),
    'the modal did not lead with the derived summary',
  ).toBeTruthy();
  const details = modal.querySelector('details');
  expect(
    details,
    'the modal inventory is not behind a disclosure',
  ).toBeTruthy();
  expect(
    details?.hasAttribute('open'),
    'the modal still opens expanded on the inventory',
  ).toBe(false);
  expect(details?.querySelector('summary')?.textContent).toBe(
    'See exactly what is sent',
  );
  // The schema is still reachable — an acknowledgement of something the reader
  // cannot get to is worthless — just not what the surface leads with.
  expect(details?.textContent).toContain('station_started');
  expect(details?.textContent).toContain('platform');
  // And the copy that named no decision is gone.
  expect(
    screen.queryByRole('button', { name: 'I understand' }),
    'the modal still offers the acknowledgement that names no choice',
  ).toBeNull();
  view.unmount();
  resetUsageTelemetryDisclosureDismissal();
});

test('#1600: the modal offers the turn-it-off decision, and writes it', async () => {
  // The whole point of the issue: this population was never offered the
  // decision at all. The write is `telemetryEnabled` through `PUT /config/app`
  // — the Settings row's own key and the server's own emission gate — and the
  // receipt follows the write rather than the click.
  const view = renderModal({ telemetryEnabled: true });
  await screen.findByRole('button', { name: 'Turn it off' });

  fireEvent.click(screen.getByRole('button', { name: 'Turn it off' }));

  expect(updateConfig).toHaveBeenCalledTimes(1);
  expect(updateConfig.mock.calls[0][0]).toEqual({ telemetryEnabled: false });
  expect(
    authenticatedFetch.mock.calls.filter((call) =>
      String(call[0]).endsWith('/acknowledgements'),
    ),
    'the modal wrote the receipt before the setting',
  ).toEqual([]);

  await act(async () => {
    updateConfig.mock.calls[0][1]?.onSuccess?.({});
  });
  await waitFor(() =>
    expect(authenticatedFetch).toHaveBeenLastCalledWith(ACKNOWLEDGEMENTS_URL, {
      method: 'POST',
    }),
  );
  view.unmount();
  resetUsageTelemetryDisclosureDismissal();
});

test('#1600: an already-off host is offered the decision it can make, and keeping an env-held state records it', async () => {
  // Both derivations the step already had, reached through the modal: the
  // labels follow the EFFECTIVE setting, and keeping a state only the
  // environment holds writes it down, because a decision resting on
  // `STATION_TELEMETRY_ENABLED` disappears the day that variable does.
  const view = renderModal({ telemetryEnabled: false, enabledSource: 'env' });

  expect(
    await screen.findByRole('button', { name: 'Keep usage telemetry off' }),
  ).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Turn it off' })).toBeNull();

  fireEvent.click(
    screen.getByRole('button', { name: 'Keep usage telemetry off' }),
  );
  expect(
    updateConfig.mock.calls.map((call) => call[0]),
    'keeping an env-held state recorded nothing',
  ).toEqual([{ telemetryEnabled: false }]);
  view.unmount();
  resetUsageTelemetryDisclosureDismissal();
});

test('#1600: a REFUSED setting write neither acknowledges nor closes the modal', async () => {
  // `PUT /config/app` answers 2xx and reports a key it declined in
  // `ignoredKeys`, so the obvious success path would write the receipt, close
  // the modal, and leave the reader told telemetry was turned off while it is
  // still on.
  const view = renderModal({ telemetryEnabled: true });
  await screen.findByRole('button', { name: 'Turn it off' });

  fireEvent.click(screen.getByRole('button', { name: 'Turn it off' }));
  await act(async () => {
    updateConfig.mock.calls[0][1]?.onSuccess?.({
      ignoredKeys: [{ key: 'telemetryEnabled', reason: 'unknown' }],
    });
  });

  expect(
    authenticatedFetch.mock.calls.filter((call) =>
      String(call[0]).endsWith('/acknowledgements'),
    ),
    'a refused setting write still wrote an acknowledgement receipt',
  ).toEqual([]);
  expect(screen.getByRole('alert').textContent).toBe(
    'The usage telemetry setting could not be saved.',
  );
  expect(
    screen.queryByRole('dialog'),
    'the modal closed over a refused write',
  ).toBeTruthy();
  view.unmount();
  resetUsageTelemetryDisclosureDismissal();
});

test('#1600: the modal keeps its own dismissal beside the decision', async () => {
  // The step's exit that decides nothing is the chapter dialog's close; this
  // surface carries its own "Not now", and it must survive gaining two named
  // actions — it is the only way out that does not depend on a write.
  const view = renderModal({ telemetryEnabled: true });
  expect(await screen.findByRole('dialog')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Turn it off' })).toBeTruthy();
  expect(
    screen.getByRole('button', { name: 'Keep usage telemetry on' }),
  ).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Not now' }));

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(
    updateConfig,
    'dismissing the modal wrote the telemetry setting',
  ).not.toHaveBeenCalled();
  expect(
    authenticatedFetch.mock.calls.filter((call) =>
      String(call[0]).endsWith('/acknowledgements'),
    ),
    'dismissing the modal wrote an acknowledgement receipt',
  ).toEqual([]);
  expect(
    localStorage.getItem(USAGE_TELEMETRY_SNOOZE_STORAGE_KEY),
    'the dismissal wrote no snooze record',
  ).toBeTruthy();
  view.unmount();
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
