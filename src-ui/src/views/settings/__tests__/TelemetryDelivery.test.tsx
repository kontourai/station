/** @vitest-environment jsdom */
import type { TelemetryDeliveryStatus } from '@kontourai/station-contracts/telemetry-delivery';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { TelemetryDelivery } from '../TelemetryDelivery';

const host = vi.hoisted(() => ({
  apiBase: 'https://station.example.test',
  authorityKey: 'operator-one',
  available: true,
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () =>
    host.available
      ? {
          apiBase: host.apiBase,
          authorityKey: host.authorityKey,
        }
      : undefined,
}));
const clients: QueryClient[] = [];
beforeEach(() => {
  host.available = true;
  host.authorityKey = 'operator-one';
  setClientCredentialResolver(() => {
    const authorityKey = host.authorityKey;
    return {
      origin: host.apiBase,
      requestAuthority: {
        apiBase: host.apiBase,
        authorityKey,
        isCurrent: () => host.available && host.authorityKey === authorityKey,
      },
    };
  });
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});
function delivery(): TelemetryDeliveryStatus {
  const at = '2026-10-10T12:00:00.000Z';
  const exportStatus = {
    lastResult: 'never' as const,
    attempts: 0,
    accepted: 0,
    failed: 0,
    lastAttemptAt: null,
    lastAcceptedAt: null,
    lastFailureAt: null,
  };
  return {
    protocol: 'station-telemetry-delivery/v1',
    product: {
      scope: 'current-process',
      observedAt: at,
      phase: 'acknowledged',
      endpointConfigured: true,
      keyConfigured: true,
      enabled: true,
      disclosureAcknowledged: true,
      sending: false,
      queued: 0,
      counts: {
        buffered: 5,
        acknowledged: 5,
        overflowDropped: 0,
        withdrawn: 0,
        shutdownDropped: 0,
        rejected: 0,
        attempts: 1,
        failedAttempts: 0,
      },
      lastAttemptAt: at,
      lastAcknowledged: { at, storedAt: at, eventCount: 5 },
      lastFailure: null,
      probe: { phase: 'never', checkedAt: null, scope: null, failure: null },
    },
    otel: {
      scope: 'current-process',
      observedAt: at,
      phase: 'initialized',
      endpointConfigured: true,
      identity: 'ready',
      downstreamDelivery: 'unverified',
      metrics: { ...exportStatus },
      traces: { ...exportStatus },
      probe: { phase: 'never', checkedAt: null, scope: null, failure: null },
    },
  };
}
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const tree = () => (
    <QueryClientProvider client={client}>
      <TelemetryDelivery />
    </QueryClientProvider>
  );
  return { ...render(tree()), tree };
}
const reply = (data: unknown) => Response.json({ success: true, data });

test('a saved collector change reports restart activation and cannot retain initialized health', async () => {
  const status = delivery();
  status.otel.phase = 'restart-required';
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(status)));
  mount();
  await screen.findByText(
    'Restart Station to apply the new collector settings.',
  );
  expect(
    screen.queryByText(/Exporter initialized; downstream delivery unverified/),
  ).toBeNull();
});

test('the operator checks a connection through the SDK and refreshes process counters without claiming downstream delivery', async () => {
  const status = delivery();
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async (_url, init) => {
      if (init?.method === 'POST') {
        status.product.probe = {
          phase: 'ready',
          checkedAt: status.product.observedAt,
          scope: 'postgres-schema-v1',
          failure: null,
        };
        return reply(status.product.probe);
      }
      return reply(status);
    });
  vi.stubGlobal('fetch', fetch);
  mount();
  await screen.findByText(/Receiver acknowledged 5 observations/);
  expect(
    screen.getByText(/Exporter initialized; downstream delivery unverified/),
  ).toBeTruthy();
  fireEvent.click(
    screen.getAllByRole('button', { name: 'Check connection' })[0],
  );
  await screen.findByText('Connection and storage check passed.');
  expect(
    fetch.mock.calls.some(
      ([url, init]) =>
        String(url) ===
          `${host.apiBase}/api/usage-telemetry/connection-checks/product` &&
        init?.method === 'POST' &&
        init.body === undefined,
    ),
  ).toBe(true);
  expect(screen.getAllByText(/Counts are for this process/)).toHaveLength(2);
});

test.each([403, 404, 503])(
  'a %i refresh hides cached acknowledgement while pending and after refusal',
  async (code) => {
    let release!: (response: Response) => void;
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(reply(delivery()))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      );
    vi.stubGlobal('fetch', fetch);
    mount();
    await screen.findByText(/Receiver acknowledged 5 observations/);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
    await screen.findByRole('status', { name: 'Refreshing delivery status' });
    expect(screen.queryByText(/Receiver acknowledged/)).toBeNull();
    await act(async () => {
      release(Response.json({ success: false }, { status: code }));
    });
    await screen.findByRole('alert');
    expect(screen.queryByText(/Receiver acknowledged/)).toBeNull();
    if (code === 404)
      expect(screen.getByRole('alert').textContent).toContain(
        "doesn't report delivery status yet",
      );
    else
      expect(screen.getByRole('alert').textContent).toContain(
        'Delivery status unavailable.',
      );
  },
);

test('a malformed successful status cannot render a receiver acknowledgement', async () => {
  const status = delivery();
  status.product.lastAcknowledged = null;
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(status)));
  mount();
  await screen.findByRole('alert');
  expect(screen.queryByText(/Receiver acknowledged/)).toBeNull();
});

test('same-origin authority replacement discards pending probe and cached success from the previous operator', async () => {
  let release!: (response: Response) => void;
  const status = delivery();
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
      if (init?.method === 'POST')
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      if (host.authorityKey === 'operator-one') return reply(status);
      const replacement = delivery();
      replacement.product.phase = 'awaiting-disclosure';
      replacement.product.disclosureAcknowledged = false;
      replacement.product.lastAcknowledged = null;
      replacement.product.counts.acknowledged = 0;
      return reply(replacement);
    }),
  );
  const rendered = mount();
  await screen.findByText(/Receiver acknowledged 5 observations/);
  fireEvent.click(
    screen.getAllByRole('button', { name: 'Check connection' })[0],
  );
  await waitFor(() => expect(release).toBeTypeOf('function'));
  host.authorityKey = 'operator-two';
  rendered.rerender(rendered.tree());
  expect(screen.queryByText(/Receiver acknowledged/)).toBeNull();
  await screen.findByText(/Review and acknowledge the disclosure/);
  await act(async () => {
    release(
      reply({
        phase: 'ready',
        checkedAt: status.product.observedAt,
        scope: 'postgres-schema-v1',
        failure: null,
      }),
    );
  });
  expect(screen.queryByText('Connection and storage check passed.')).toBeNull();
  expect(screen.queryByText(/Receiver acknowledged/)).toBeNull();
});

test('missing Station authority sends no status or connection request', () => {
  host.available = false;
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  mount();
  expect(
    screen.getByText('Connect to this Station to see delivery status.'),
  ).toBeTruthy();
  expect(fetch).not.toHaveBeenCalled();
});

test('#4521: under the managed limit the product check is disabled and sends nothing', async () => {
  const denial =
    "Acme's policy manages usage sharing: it is turned off. Contact your administrator for help.";
  const status = delivery();
  status.product.phase = 'disabled';
  status.product.managedDenial = denial;
  status.otel.phase = 'unconfigured';
  status.otel.endpointConfigured = false;
  status.otel.managedDenial = denial;
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async () => reply(status));
  vi.stubGlobal('fetch', fetch);
  mount();
  await waitFor(() => expect(screen.getAllByText(denial)).toHaveLength(2));
  expect(screen.getAllByText('Off: managed policy.')).toHaveLength(2);
  const [productCheck, otelCheck] = screen.getAllByRole('button', {
    name: 'Check connection',
  }) as HTMLButtonElement[];
  expect(productCheck?.disabled).toBe(true);
  expect(otelCheck?.disabled).toBe(true);
  // Neither a click nor Enter on the focused button sends the check.
  fireEvent.click(productCheck!);
  productCheck!.focus();
  fireEvent.keyDown(productCheck!, { key: 'Enter' });
  fireEvent.keyUp(productCheck!, { key: 'Enter' });
  await act(async () => {});
  expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(
    false,
  );
});

// An older host reports no product `managedDenial`, so the check stays
// enabled; its 403 still shows the policy sentence, not a generic error.
test('#4521: a managed policy explains OTel and a refused connection check in its own words', async () => {
  const denial =
    "Acme's policy manages usage sharing: it is turned off. Contact your administrator for help.";
  const status = delivery();
  status.otel.phase = 'unconfigured';
  status.otel.endpointConfigured = false;
  status.otel.managedDenial = denial;
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) =>
      init?.method === 'POST'
        ? Response.json(
            {
              success: false,
              code: 'managed-policy-capability-disabled',
              error: denial,
              retryable: false,
            },
            { status: 403 },
          )
        : reply(status),
    ),
  );
  mount();
  await screen.findByText(denial);
  const [productCheck, otelCheck] = screen.getAllByRole('button', {
    name: 'Check connection',
  }) as HTMLButtonElement[];
  expect(otelCheck?.disabled).toBe(true);
  fireEvent.click(productCheck!);
  await waitFor(() => expect(screen.getAllByText(denial)).toHaveLength(2));
  expect(
    screen.queryByText('Only the Station operator can check this connection.'),
  ).toBeNull();
});
