/** @vitest-environment jsdom */
import type { SecretBindingView } from '@kontourai/station-contracts/secret-binding';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import {
  observeClientProtocolSupport,
  resetClientProtocolObservations,
} from '@kontourai/station-shared/client-protocol';
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
import { TelemetryDestinationGrants } from '../TelemetryDestinationGrants';

const host = vi.hoisted(() => ({
  available: true,
  authorityKey: 'operator-one',
  apiBase: 'https://station.example.test',
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () =>
    host.available
      ? { apiBase: host.apiBase, authorityKey: host.authorityKey }
      : undefined,
}));
const clients: QueryClient[] = [];
beforeEach(() => {
  resetClientProtocolObservations();
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
  resetClientProtocolObservations();
  vi.unstubAllGlobals();
});
function binding(): SecretBindingView {
  return {
    id: 'collector-key',
    name: 'Collector key',
    revision: 4,
    authRef: { env: 'COLLECTOR_KEY' },
    owner: { kind: 'instance' },
    grants: [],
    availability: { backend: 'env', available: true },
    createdAt: '2026-10-10T12:00:00.000Z',
    updatedAt: '2026-10-10T12:00:00.000Z',
  };
}
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <TelemetryDestinationGrants />
      </QueryClientProvider>,
    ),
  };
}
const envelope = (data: unknown) =>
  new Response(JSON.stringify({ success: true, data }), {
    headers: { 'content-type': 'application/json' },
  });

test.each([false, true])(
  'grants and removes exact collector authority through the real SDK using current revisions (header advertised: %s)',
  async (advertised) => {
    if (advertised)
      observeClientProtocolSupport(host.apiBase, {
        capabilities: { clientProtocolHeader: 1 },
      });
    const initial = binding();
    const grant = {
      kind: 'instance-telemetry-destination' as const,
      transport: 'otel' as const,
      destination: 'https://collector.example.test',
    };
    const granted = {
      ...initial,
      revision: 5,
      telemetryDestinationGrants: [grant],
    };
    const removed = { ...initial, revision: 6 };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(envelope([initial]))
      .mockResolvedValueOnce(envelope(granted))
      .mockResolvedValueOnce(envelope([granted]))
      .mockResolvedValueOnce(envelope(removed))
      .mockResolvedValueOnce(envelope([removed]));
    vi.stubGlobal('fetch', fetch);
    mount();
    await screen.findByRole('option', {
      name: 'Collector key (collector-key)',
    });
    fireEvent.change(screen.getByLabelText('Key reference'), {
      target: { value: 'collector-key' },
    });
    fireEvent.change(screen.getByLabelText('Destination type'), {
      target: { value: 'otel' },
    });
    fireEvent.change(screen.getByLabelText('Exact destination address'), {
      target: { value: grant.destination },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Grant destination' }));
    await screen.findByText('Telemetry destination granted.');
    expect(fetch.mock.calls[1][0]).toBe(
      'https://station.example.test/api/secret-bindings/collector-key/bind',
    );
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({
      ...grant,
      expectedRevision: 4,
    });
    expect(
      new Headers(fetch.mock.calls[1][1].headers).get(
        'X-Station-Client-Protocol',
      ),
    ).toBe(advertised ? '3' : null);
    fireEvent.click(screen.getByRole('button', { name: 'Remove grant' }));
    await screen.findByText('Telemetry destination grant removed.');
    expect(fetch.mock.calls[3][0]).toBe(
      'https://station.example.test/api/secret-bindings/collector-key/unbind',
    );
    expect(JSON.parse(fetch.mock.calls[3][1].body)).toEqual({
      ...grant,
      expectedRevision: 5,
    });
    expect(
      new Headers(fetch.mock.calls[3][1].headers).get(
        'X-Station-Client-Protocol',
      ),
    ).toBe(advertised ? '3' : null);
    expect(screen.queryByRole('button', { name: 'Remove grant' })).toBeNull();
  },
);

test('omits person-owned and revoked references from destination grant choices', async () => {
  const instance = binding();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      envelope([
        instance,
        {
          ...instance,
          id: 'person-key',
          name: 'Person key',
          owner: { kind: 'principal', principalId: 'human-one' },
        },
        {
          ...instance,
          id: 'revoked-key',
          name: 'Revoked key',
          revokedAt: '2026-10-10T13:00:00.000Z',
        },
      ]),
    ),
  );
  mount();
  await screen.findByRole('option', { name: 'Collector key (collector-key)' });
  expect(screen.queryByRole('option', { name: /Person key/ })).toBeNull();
  expect(screen.queryByRole('option', { name: /Revoked key/ })).toBeNull();
});

test('a refused refresh withdraws cached grant controls and does not claim current authority', async () => {
  const record = {
    ...binding(),
    telemetryDestinationGrants: [
      {
        kind: 'instance-telemetry-destination' as const,
        transport: 'product' as const,
        destination: 'https://receiver.example.test/v1/product/events',
      },
    ],
  };
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(envelope([record]))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: false,
          error: 'Operator authority required.',
        }),
        { status: 403 },
      ),
    );
  vi.stubGlobal('fetch', fetch);
  mount();
  await screen.findByRole('option', { name: 'Collector key (collector-key)' });
  fireEvent.change(screen.getByLabelText('Key reference'), {
    target: { value: 'collector-key' },
  });
  expect(screen.getByRole('button', { name: 'Remove grant' })).toBeTruthy();
  fireEvent.click(
    screen.getByRole('button', { name: 'Refresh key references' }),
  );
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toContain('unavailable'),
  );
  expect(screen.queryByRole('button', { name: 'Remove grant' })).toBeNull();
  expect(
    screen.queryByRole('button', { name: 'Grant destination' }),
  ).toBeNull();
});

test('an unsupported successful response cannot confirm a telemetry grant', async () => {
  const record = binding();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(envelope([record]))
    .mockResolvedValueOnce(envelope({ outcome: 'complete', binding: record }))
    .mockResolvedValueOnce(envelope([record]));
  vi.stubGlobal('fetch', fetch);
  mount();
  await screen.findByRole('option', { name: 'Collector key (collector-key)' });
  fireEvent.change(screen.getByLabelText('Key reference'), {
    target: { value: 'collector-key' },
  });
  fireEvent.change(screen.getByLabelText('Exact destination address'), {
    target: { value: 'https://receiver.example.test/v1/product/events' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Grant destination' }));
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toContain('invalid metadata'),
  );
  expect(screen.queryByText('Telemetry destination granted.')).toBeNull();
});

test('no host authority dispatches no key-reference query', () => {
  host.available = false;
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  mount();
  expect(screen.getByRole('status').textContent).toContain(
    'Connect to this Station',
  );
  expect(fetch).not.toHaveBeenCalled();
});

test('an old grant response cannot confirm or replace the new same-origin authority cache', async () => {
  const initial = binding();
  const replacement = { ...binding(), revision: 9, name: 'Replacement key' };
  const grant = {
    kind: 'instance-telemetry-destination' as const,
    transport: 'product' as const,
    destination: 'https://receiver.example.test/v1/product/events',
  };
  let releaseResponse: (response: Response) => void = () => {};
  const delayed = new Promise<Response>((resolve) => {
    releaseResponse = resolve;
  });
  const fetch = vi
    .fn()
    .mockImplementation((_url, options) =>
      options.method === 'POST'
        ? delayed
        : Promise.resolve(
            envelope([
              host.authorityKey === 'operator-one' ? initial : replacement,
            ]),
          ),
    );
  vi.stubGlobal('fetch', fetch);
  const { client, rerender } = mount();
  await screen.findByRole('option', { name: 'Collector key (collector-key)' });
  fireEvent.change(screen.getByLabelText('Key reference'), {
    target: { value: 'collector-key' },
  });
  fireEvent.change(screen.getByLabelText('Exact destination address'), {
    target: { value: grant.destination },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Grant destination' }));
  await waitFor(() =>
    expect(fetch.mock.calls.some((call) => call[1].method === 'POST')).toBe(
      true,
    ),
  );
  const oldMutation = client.getMutationCache().getAll()[0];
  await act(async () => {
    host.authorityKey = 'operator-two';
    rerender(
      <QueryClientProvider client={client}>
        <TelemetryDestinationGrants />
      </QueryClientProvider>,
    );
  });
  await screen.findByRole('option', {
    name: 'Replacement key (collector-key)',
  });
  await act(async () => {
    releaseResponse(
      envelope({
        ...initial,
        revision: 5,
        telemetryDestinationGrants: [grant],
      }),
    );
  });
  await waitFor(() => expect(oldMutation.state.status).toBe('error'));
  expect(
    client.getQueryData([
      'secret-bindings',
      'telemetry',
      host.apiBase,
      'operator-two',
    ]),
  ).toEqual([replacement]);
  expect(screen.queryByText('Telemetry destination granted.')).toBeNull();
  expect(
    (screen.getByLabelText('Exact destination address') as HTMLInputElement)
      .value,
  ).toBe('');
});
