// @vitest-environment jsdom

/**
 * Settings › Device hosts (#1973): the operator's list, add (with the
 * server's target refusal shown), the explicit hub consent, and the
 * step-by-step "Test connection". Mounted over a real QueryClient and the
 * SDK's own client, with only `fetch` stubbed.
 */

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
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: 'authority-1',
  }),
}));

import { DeviceHostsPanel } from '../DeviceHostsPanel';

const HOST = {
  hostId: 'ssh-0123456789ab',
  label: 'Studio Mac',
  sshTarget: 'me@studio-mac',
  hubEnabled: false,
  createdAt: '2026-09-22T00:00:00.000Z',
  updatedAt: '2026-09-22T00:00:00.000Z',
  hub: { state: 'stopped' },
  install: { state: 'unknown' },
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

type Handler = (method: string, path: string, body: unknown) => Response;

function stub(handler: Handler) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body });
      return handler(method, path, body);
    }),
  );
  return calls;
}

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <DeviceHostsPanel />
    </QueryClientProvider>,
  );
}

async function click(element: Element) {
  fireEvent.click(element);
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() =>
  setClientCredentialResolver(() => ({
    origin: 'http://station.test',
    requestAuthority: {
      apiBase: 'http://station.test',
      authorityKey: 'authority-1',
      isCurrent: () => true,
    },
  })),
);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setClientCredentialResolver();
});

describe('Settings › Device hosts (#1973)', () => {
  test('no hosts yet: an empty state and an Add button', async () => {
    stub(() => json({ success: true, data: { hosts: [] } }));
    mount();
    await screen.findByText('Add a machine to get started');
    expect(
      screen.getByRole('button', { name: 'Add device host' }),
    ).toBeTruthy();
  });

  test('a non-operator is told who manages hosts, and sees no controls', async () => {
    stub(() => json({ success: false, code: 'access-denied' }, 403));
    mount();
    await screen.findByText(/managed by the Station operator/);
    expect(
      screen.queryByRole('button', { name: 'Add device host' }),
    ).toBeNull();
  });

  test('adding: the server refuses an option-shaped target and the form says what to type', async () => {
    const calls = stub((method, path) => {
      if (method === 'POST' && path === '/api/mobile-devices/device-hosts')
        return json({ success: false, code: 'invalid-target' }, 400);
      return json({ success: true, data: { hosts: [] } });
    });
    mount();
    await click(await screen.findByRole('button', { name: 'Add device host' }));
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Mac' },
    });
    fireEvent.change(screen.getByLabelText('SSH target'), {
      target: { value: '-oProxyCommand=sh' },
    });
    await click(screen.getByRole('button', { name: 'Add host' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/user@host/);
    expect(calls.find((call) => call.method === 'POST')?.body).toEqual({
      label: 'Mac',
      sshTarget: '-oProxyCommand=sh',
    });
  });

  test('enabling the hub asks first, then sends the literal consent', async () => {
    const calls = stub((method, path) => {
      if (method === 'POST' && path.endsWith('/hub'))
        return json(
          { success: true, data: { ...HOST, hubEnabled: true } },
          202,
        );
      return json({ success: true, data: { hosts: [HOST] } });
    });
    mount();
    await click(
      await screen.findByRole('button', { name: 'Enable device hub' }),
    );
    expect(screen.getByText(/copy the device hub it verified/)).toBeTruthy();
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
    await click(screen.getByRole('button', { name: 'Install and enable' }));
    await waitFor(() =>
      expect(calls.find((call) => call.method === 'POST')).toEqual({
        method: 'POST',
        path: `/api/mobile-devices/device-hosts/${HOST.hostId}/hub`,
        body: { enabled: true, consent: true },
      }),
    );
  });

  test('sharing a device on an SSH host is keyed by that host (a local share of the same UDID does not count)', async () => {
    const UDID = '6E8C08FA-3A81-4347-90B9-AD41B7FAE876';
    const calls = stub((method, path) => {
      if (path === `/api/mobile-devices/hosts/${HOST.hostId}/devices`)
        return json({
          success: true,
          data: {
            hostId: HOST.hostId,
            state: 'ready',
            observedAt: '2026-09-22T00:00:00.000Z',
            devices: [
              {
                hostId: HOST.hostId,
                platform: 'ios',
                deviceId: UDID,
                name: 'Studio iPhone',
                runtime: 'iOS 26.5',
                booted: true,
              },
            ],
          },
        });
      if (path === '/api/mobile-devices/shares' && method === 'GET')
        return json({
          success: true,
          data: [
            {
              projectId: 'p-alpha',
              projectSlug: 'alpha',
              // Shared on THIS Station only.
              shares: [
                {
                  hostId: 'local',
                  platform: 'ios',
                  deviceId: UDID,
                  label: 'x',
                },
              ],
            },
          ],
        });
      if (path === '/api/mobile-devices/shares' && method === 'POST')
        return json({ success: true, data: {} }, 201);
      return json({
        success: true,
        data: { hosts: [{ ...HOST, hubEnabled: true }] },
      });
    });
    mount();
    await click(await screen.findByRole('button', { name: 'Share devices…' }));
    await screen.findByText('Studio iPhone');
    expect(screen.getByText('Not shared with any Project.')).toBeTruthy();
    await click(screen.getByRole('button', { name: 'Share with Project…' }));
    fireEvent.change(screen.getByLabelText('Project'), {
      target: { value: 'alpha' },
    });
    await click(screen.getByRole('button', { name: 'Share' }));
    await waitFor(() =>
      expect(
        calls.find(
          (call) =>
            call.method === 'POST' &&
            call.path === '/api/mobile-devices/shares',
        )?.body,
      ).toEqual({
        projectSlug: 'alpha',
        hostId: HOST.hostId,
        platform: 'ios',
        deviceId: UDID,
        label: 'Studio iPhone',
      }),
    );
  });

  test('M4: a host missing the current hub says so and offers a truthful Reinstall', async () => {
    const calls = stub((method, path) => {
      if (method === 'POST' && path.endsWith('/hub/start'))
        return json({
          success: true,
          data: {
            ...HOST,
            hubEnabled: true,
            hub: { state: 'running', startedAt: '2026-09-22T00:00:00.000Z' },
          },
        });
      return json({
        success: true,
        data: {
          hosts: [
            {
              ...HOST,
              hubEnabled: true,
              hub: {
                state: 'failed',
                failure: 'hub-not-installed',
                attempts: 1,
              },
            },
          ],
        },
      });
    });
    mount();
    await screen.findByText(/does not have this Station/);
    expect(screen.queryByRole('button', { name: 'Retry hub' })).toBeNull();
    await click(screen.getByRole('button', { name: 'Reinstall hub' }));
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.method === 'POST' &&
            call.path ===
              `/api/mobile-devices/device-hosts/${HOST.hostId}/hub/start`,
        ),
      ).toBe(true),
    );
  });

  test('Test connection shows every step, and an unknown host key says what to do', async () => {
    stub((method, path) => {
      if (method === 'POST' && path.endsWith('/check'))
        return json({
          success: true,
          data: {
            hostId: HOST.hostId,
            checkedAt: '2026-09-22T00:00:00.000Z',
            ok: false,
            failure: 'host-key-unverified',
            steps: [
              { id: 'ssh', state: 'pass', detail: 'The host answered.' },
              { id: 'host-key', state: 'fail' },
              { id: 'node', state: 'skipped' },
              { id: 'ios', state: 'skipped' },
              { id: 'android', state: 'skipped' },
              { id: 'hub-installed', state: 'skipped' },
              { id: 'hub-running', state: 'skipped' },
            ],
          },
        });
      return json({ success: true, data: { hosts: [HOST] } });
    });
    mount();
    await click(await screen.findByRole('button', { name: 'Test connection' }));
    const steps = await screen.findByRole('list', { name: 'Connection test' });
    expect(
      [...steps.querySelectorAll('li')].map((li) => li.textContent),
    ).toEqual([
      expect.stringContaining('Reach the host over sshOK'),
      expect.stringContaining('Host key is knownFailed'),
      expect.stringContaining('Not checked'),
      expect.stringContaining('Not checked'),
      expect.stringContaining('Not checked'),
      expect.stringContaining('Not checked'),
      expect.stringContaining('Not checked'),
    ]);
    expect(screen.getByText(/not in your known_hosts/)).toBeTruthy();
  });
});
