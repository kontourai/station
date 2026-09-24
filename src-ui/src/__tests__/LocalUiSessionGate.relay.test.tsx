/** @vitest-environment jsdom */

import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connection: {
    id: 'relay-station',
    url: 'https://station.example.test',
    brokerRoute: {
      brokerOrigin: 'https://broker.example.test',
      scope: {
        stationId: '11111111-1111-4111-8111-111111111111',
        enrollmentId: '22222222-2222-4222-8222-222222222222',
        routingGeneration: 1,
        browserOrigin: 'http://localhost:3000',
      },
    },
  },
  accountScope: null as {
    state: 'ready';
    authorityKey: string;
    scopeKey: string;
    version: number;
  } | null,
  listeners: new Set<() => void>(),
  probe: vi.fn(),
}));

vi.mock('@kontourai/station-connect', () => ({
  useConnections: () => ({
    activeConnection: mocks.connection,
  }),
}));
vi.mock('../lib/browserRelayAccountScope', () => ({
  browserRelayAccountScopeKey: () => 'selected-relay-route',
  getBrowserRelayAccountScope: () => mocks.accountScope,
  subscribeBrowserRelayAccountScope: (listener: () => void) => {
    mocks.listeners.add(listener);
    return () => mocks.listeners.delete(listener);
  },
}));
vi.mock('../lib/browserRelayRouteBinding', () => ({
  captureBrowserRelayRoute: () => ({ isCurrent: () => true }),
}));
vi.mock('../lib/serverHealth', () => ({
  probeServerConnection: mocks.probe,
}));
vi.mock('../lib/local-ui-bootstrap', () => ({
  resolveLocalUiSession: async () => ({ kind: 'access-required' }),
  recheckLocalUiSessionAfterPairing: async () => ({ kind: 'access-required' }),
  subscribeLocalUiSessionAttempt: () => () => {},
  getLocalUiSessionAttempt: () => 1,
}));
vi.mock('../platform/native/notify', () => ({
  primeNativeNotifications: vi.fn(),
}));
vi.mock('../components/GuidedConnect', () => ({
  GuidedConnect: () => <h1>Connect to a Station</h1>,
}));

import { LocalUiSessionGate } from '../components/LocalUiSessionGate';

function publishAccount(authorityKey: string, version: number) {
  act(() => {
    mocks.accountScope = {
      state: 'ready',
      authorityKey,
      scopeKey: `account:${authorityKey}:v${version}`,
      version,
    };
    for (const listener of mocks.listeners) listener();
  });
}

beforeEach(() => {
  mocks.accountScope = null;
  mocks.listeners.clear();
  mocks.probe.mockReset();
});

it('admits protected UI only after the selected relay account passes Station identity', async () => {
  mocks.probe.mockResolvedValue({ ok: true, bootId: 'verified-boot' });
  render(
    <LocalUiSessionGate apiBase="https://client.example.test">
      <div>Protected Project work</div>
    </LocalUiSessionGate>,
  );
  expect(await screen.findByText('Connect to a Station')).toBeTruthy();
  expect(screen.queryByText('Protected Project work')).toBeNull();

  publishAccount('account-A', 1);
  expect(await screen.findByText('Protected Project work')).toBeTruthy();
  expect(mocks.probe).toHaveBeenCalledWith(
    'https://station.example.test',
    undefined,
    null,
    expect.any(AbortSignal),
    expect.objectContaining({ brokerOrigin: 'https://broker.example.test' }),
  );
});

it('quarantines old Project UI immediately when account authority changes', async () => {
  let finishSecond:
    | ((value: { ok: false; reason: string }) => void)
    | undefined;
  mocks.probe
    .mockResolvedValueOnce({ ok: true, bootId: 'verified-boot' })
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSecond = resolve;
        }),
    );
  render(
    <LocalUiSessionGate apiBase="https://client.example.test">
      <div>Protected Project work</div>
    </LocalUiSessionGate>,
  );
  publishAccount('account-A', 1);
  expect(await screen.findByText('Protected Project work')).toBeTruthy();

  publishAccount('account-B', 2);
  expect(screen.queryByText('Protected Project work')).toBeNull();
  expect(await screen.findByText('Connect to a Station')).toBeTruthy();
  await act(async () => {
    finishSecond?.({ ok: false, reason: 'authentication-failed' });
  });
  await waitFor(() => expect(mocks.probe).toHaveBeenCalledTimes(2));
  expect(screen.queryByText('Protected Project work')).toBeNull();
});
