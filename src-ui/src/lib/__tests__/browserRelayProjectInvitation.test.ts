/** @vitest-environment jsdom */

import type { SavedConnection } from '@kontourai/station-connect';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  credential: vi.fn(),
  transport: vi.fn(),
  accountUnauthorized: vi.fn(),
  deviceUnauthorized: vi.fn(),
}));

vi.mock('../browserRelayRouteBinding', () => ({
  captureBrowserRelayRoute: mocks.capture,
}));
vi.mock('../browserRelayApplicationAuthority', () => ({
  createBrowserRelayApplicationCredential: mocks.credential,
}));

import { acceptBrowserRelayProjectInvitation } from '../browserRelayProjectInvitation';

const stationId = '11111111-1111-4111-8111-111111111111';
const connection = {
  id: 'saved-relay-route',
  url: 'https://station.example.test',
  brokerRoute: {
    brokerOrigin: 'https://broker.example.test',
    scope: {
      stationId,
      enrollmentId: '22222222-2222-4222-8222-222222222222',
      routingGeneration: 1,
      browserOrigin: window.location.origin,
    },
  },
} as SavedConnection;
const token = 'T'.repeat(43);

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.capture.mockReturnValue({
    transport: vi.fn(),
    isCurrent: () => true,
  });
  mocks.credential.mockResolvedValue({
    transport: mocks.transport,
    transportBindingIsCurrent: () => true,
    onAccountUnauthorized: mocks.accountUnauthorized,
    onUnauthorized: mocks.deviceUnauthorized,
  });
});
afterEach(() => vi.unstubAllGlobals());

it('accepts the Project through the encrypted Device/account transport without direct HTTP', async () => {
  const direct = vi.fn().mockRejectedValue(new Error('direct HTTP forbidden'));
  vi.stubGlobal('fetch', direct);
  mocks.transport.mockResolvedValue(
    Response.json({
      data: {
        grantsDeviceAccess: false,
        scope: { stationId, localProjectSlug: 'relay-shared' },
      },
    }),
  );

  await expect(
    acceptBrowserRelayProjectInvitation({ connection, token }),
  ).resolves.toEqual({ projectSlug: 'relay-shared' });
  expect(mocks.transport).toHaveBeenCalledOnce();
  const [url, init] = mocks.transport.mock.calls[0] as [string, RequestInit];
  expect(url).toBe(
    'https://station.example.test/api/account-auth/accept-invitation',
  );
  expect(init.method).toBe('POST');
  expect(new Headers(init.headers).get('Origin')).toBe(window.location.origin);
  expect(JSON.parse(String(init.body))).toEqual({ token });
  expect(direct).not.toHaveBeenCalled();
});

it('refuses an invitation result that names another Station or grants Device access', async () => {
  mocks.transport.mockResolvedValue(
    Response.json({
      data: {
        grantsDeviceAccess: true,
        scope: { stationId: 'different-station', localProjectSlug: 'other' },
      },
    }),
  );
  await expect(
    acceptBrowserRelayProjectInvitation({ connection, token }),
  ).rejects.toThrow('did not confirm this Project membership');
});

it('does not dispatch a bad token or a route without current encryption', async () => {
  await expect(
    acceptBrowserRelayProjectInvitation({ connection, token: 'short' }),
  ).rejects.toThrow('valid Project invitation token');
  mocks.capture.mockReturnValue(null);
  await expect(
    acceptBrowserRelayProjectInvitation({ connection, token }),
  ).rejects.toThrow('Reconnect to this Station');
  expect(mocks.transport).not.toHaveBeenCalled();
});

it('retires only account proof material on an account-specific 401', async () => {
  mocks.transport.mockResolvedValue(
    Response.json(
      { error: { code: 'account_authentication_required' } },
      {
        status: 401,
        headers: { 'X-Station-Authentication-Failure': 'account' },
      },
    ),
  );
  await expect(
    acceptBrowserRelayProjectInvitation({ connection, token }),
  ).rejects.toThrow('account_authentication_required');
  expect(mocks.accountUnauthorized).toHaveBeenCalledOnce();
  expect(mocks.deviceUnauthorized).not.toHaveBeenCalled();
});

it('cancels promptly while browser authority storage is stalled', async () => {
  mocks.credential.mockImplementation(() => new Promise(() => {}));
  const controller = new AbortController();
  const pending = acceptBrowserRelayProjectInvitation({
    connection,
    token,
    signal: controller.signal,
  });
  controller.abort(new Error('Invitation closed'));
  await expect(pending).rejects.toThrow('Invitation closed');
  expect(mocks.transport).not.toHaveBeenCalled();
});

it('cancels promptly while a virtual response is stalled', async () => {
  mocks.transport.mockImplementation(() => new Promise(() => {}));
  const controller = new AbortController();
  const pending = acceptBrowserRelayProjectInvitation({
    connection,
    token,
    signal: controller.signal,
  });
  await vi.waitFor(() => expect(mocks.transport).toHaveBeenCalledOnce());
  controller.abort(new Error('Route retired'));
  await expect(pending).rejects.toThrow('Route retired');
});

it('does not wait indefinitely for account-401 cleanup after cancellation', async () => {
  mocks.transport.mockResolvedValue(
    Response.json(
      { error: { code: 'account_authentication_required' } },
      {
        status: 401,
        headers: { 'X-Station-Authentication-Failure': 'account' },
      },
    ),
  );
  mocks.accountUnauthorized.mockImplementation(() => new Promise(() => {}));
  const controller = new AbortController();
  const pending = acceptBrowserRelayProjectInvitation({
    connection,
    token,
    signal: controller.signal,
  });
  await vi.waitFor(() =>
    expect(mocks.accountUnauthorized).toHaveBeenCalledOnce(),
  );
  controller.abort(new Error('Invitation closed'));
  await expect(pending).rejects.toThrow('Invitation closed');
  expect(mocks.deviceUnauthorized).not.toHaveBeenCalled();
});
