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
    authorityKey: string | null;
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
  recheckLocalUiSession: async () => ({ kind: 'access-required' }),
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
import { deviceSettingsStore } from '../lib/device-settings-store';

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

it('keeps the cached account appearance while the relay account is still being checked', async () => {
  // The signed-in relay boot: the gate shows the connect screen until the
  // account scope and the Station identity check answer. That is "not
  // checked yet"; releasing here repainted every relay user in the device's
  // appearance and recorded it for the next launch.
  const release = vi.spyOn(deviceSettingsStore, 'releaseBootAppearance');
  let finish: ((value: { ok: true; bootId: string }) => void) | undefined;
  mocks.probe.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(
    <LocalUiSessionGate apiBase="https://client.example.test">
      <div>Protected Project work</div>
    </LocalUiSessionGate>,
  );
  expect(await screen.findByText('Connect to a Station')).toBeTruthy();
  publishAccount('account-A', 1);
  await waitFor(() => expect(finish).toBeDefined());
  expect(release).not.toHaveBeenCalled();
  await act(async () => finish!({ ok: true, bootId: 'verified-boot' }));
  expect(await screen.findByText('Protected Project work')).toBeTruthy();
  expect(release).not.toHaveBeenCalled();
  release.mockRestore();
});

it.each([
  'unreachable',
  'timeout',
  'identity-mismatch',
  'unsupported-capability-version',
  'unexpected-response',
])(
  'keeps it when the relay identity check fails without a refusal (%s)',
  async (reason) => {
    const release = vi.spyOn(deviceSettingsStore, 'releaseBootAppearance');
    mocks.probe.mockResolvedValue({ ok: false, reason });
    render(
      <LocalUiSessionGate apiBase="https://client.example.test">
        <div>Protected Project work</div>
      </LocalUiSessionGate>,
    );
    publishAccount('account-A', 1);
    await waitFor(() => expect(mocks.probe).toHaveBeenCalled());
    // Let the probe's answer land and the gate re-render.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(release).not.toHaveBeenCalled();
    release.mockRestore();
  },
);

it('releases it when the relay account scope settles with no account (signed out)', async () => {
  const release = vi.spyOn(deviceSettingsStore, 'releaseBootAppearance');
  render(
    <LocalUiSessionGate apiBase="https://client.example.test">
      <div>Protected Project work</div>
    </LocalUiSessionGate>,
  );
  expect(release).not.toHaveBeenCalled();
  act(() => {
    mocks.accountScope = {
      state: 'ready',
      authorityKey: null,
      scopeKey: 'no-account:page:2',
      version: 2,
    };
    for (const listener of mocks.listeners) listener();
  });
  await waitFor(() => expect(release).toHaveBeenCalled());
  release.mockRestore();
});

it('releases it once the relay identity check refuses the current account', async () => {
  const release = vi.spyOn(deviceSettingsStore, 'releaseBootAppearance');
  mocks.probe.mockResolvedValue({
    ok: false,
    reason: 'authentication-failed',
  });
  render(
    <LocalUiSessionGate apiBase="https://client.example.test">
      <div>Protected Project work</div>
    </LocalUiSessionGate>,
  );
  publishAccount('account-A', 1);
  await waitFor(() => expect(release).toHaveBeenCalled());
  expect(screen.queryByText('Protected Project work')).toBeNull();
  release.mockRestore();
});
