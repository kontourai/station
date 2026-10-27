/** @vitest-environment jsdom */

import type { SavedConnection } from '@kontourai/station-connect';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  preview: true,
  connections: {} as Record<string, unknown>,
  health: {} as Record<string, unknown>,
  fetch: vi.fn(),
}));

vi.mock('@kontourai/station-connect', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-connect')>()),
  useConnections: () => state.connections,
  useConnectionStatus: () => state.health,
}));
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  authenticatedFetch: (...args: unknown[]) => state.fetch(...args),
}));
vi.mock('../../../hooks/useDeveloperFeatures', () => ({
  useDeveloperFeatures: () => ({ stationRoutes: state.preview }),
}));

import { StationRoutesPanel } from '../StationRoutesPanel';

function endpoint(
  url: string,
  extra: Partial<SavedConnection['endpoints'][number]> = {},
) {
  return {
    endpointVersion: 1 as const,
    id: `endpoint:manual:${encodeURIComponent(url)}`,
    url,
    kind: 'manual' as const,
    priority: 100,
    ...extra,
  };
}

const lan = endpoint('http://192.168.50.16:3774');
const tailscale = endpoint('http://100.77.142.114:3774', {
  source: 'advertised',
});
const https = endpoint('https://kontour.python-smelt.ts.net', {
  source: 'advertised',
});

function station(overrides: Partial<SavedConnection> = {}): SavedConnection {
  return {
    profileVersion: 4,
    id: 'home',
    name: 'Kontour',
    url: lan.url,
    endpoints: [lan, tailscale, https],
    selectedEndpointId: lan.id,
    accessMethods: [lan, tailscale, https].map((item) => ({
      accessVersion: 1 as const,
      id: `access:direct:${item.id}`,
      kind: 'direct-http' as const,
      endpointId: item.id,
    })),
    selectedAccessMethodId: `access:direct:${lan.id}`,
    environmentId: 'env-home',
    authProtocolVersion: 1,
    credentialRef: { credentialVersion: 1, kind: 'connection', id: 'home' },
    capabilities: null,
    credentialState: 'saved',
    ...overrides,
  };
}

function renderPanel(connection: SavedConnection) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <StationRoutesPanel connection={connection} />
    </QueryClientProvider>,
  );
}

const addRoute = vi.fn(() => true);
const removeRoute = vi.fn(() => true);
const recheck = vi.fn();

beforeEach(() => {
  state.preview = true;
  state.connections = {
    activeConnection: station(),
    addRoute,
    removeRoute,
    apiBase: 'http://192.168.50.16:3774',
  };
  state.health = {
    status: 'error',
    reason: 'unreachable',
    routes: [
      { endpointId: lan.id, state: 'failed', reason: 'unreachable' },
      {
        endpointId: tailscale.id,
        state: 'failed',
        reason: 'identity-mismatch',
      },
      { endpointId: https.id, state: 'not-checked' },
    ],
    recheck,
  };
});

afterEach(() => {
  addRoute.mockClear();
  removeRoute.mockClear();
  recheck.mockClear();
  state.fetch.mockReset();
});

describe('StationRoutesPanel', () => {
  it('shows the failure once and notes only what differs on each route', () => {
    renderPanel(station());
    expect(screen.getByRole('status').textContent).toBe("Can't reach Kontour.");
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText('Local network')).toBeTruthy();
    expect(within(rows[0]!).getByText(`${lan.url} · unreachable`)).toBeTruthy();
    expect(within(rows[1]!).getByText('Tailscale')).toBeTruthy();
    expect(
      within(rows[1]!).getByText(
        `${tailscale.url} · found automatically · different Station`,
      ),
    ).toBeTruthy();
    expect(within(rows[2]!).getByText('Tailscale HTTPS')).toBeTruthy();
    expect(
      within(rows[2]!).getByText(`${https.url} · found automatically`),
    ).toBeTruthy();
  });

  it('marks the route in use and shows no status line when connected', () => {
    state.health = {
      ...state.health,
      status: 'connected',
      reason: null,
      routes: [
        { endpointId: lan.id, state: 'failed', reason: 'unreachable' },
        { endpointId: https.id, state: 'in-use' },
      ],
    };
    renderPanel(station());
    expect(screen.queryByRole('status')).toBeNull();
    const inUse = screen.getByText('In use').closest('li');
    expect(within(inUse!).getByText('Tailscale HTTPS')).toBeTruthy();
  });

  it('offers remove only for routes the user added, after Edit', () => {
    renderPanel(station());
    expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const remove = screen.getAllByRole('button', { name: /^Remove / });
    expect(remove).toHaveLength(1);
    expect(remove[0]!.getAttribute('aria-label')).toBe(
      `Remove Local network route ${lan.url}`,
    );
    fireEvent.click(remove[0]!);
    expect(removeRoute).toHaveBeenCalledWith('home', lan.id);
    expect(recheck).toHaveBeenCalled();
  });

  it('adds a typed route and reports an unusable address', () => {
    renderPanel(station());
    fireEvent.click(screen.getByRole('button', { name: '+ Add route' }));
    const input = screen.getByLabelText('Route address');
    fireEvent.change(input, { target: { value: 'http://10.0.0.4:3774' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(addRoute).toHaveBeenCalledWith('home', 'http://10.0.0.4:3774');
    expect(screen.queryByLabelText('Route address')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '+ Add route' }));
    addRoute.mockImplementationOnce(() => {
      throw new Error('Enter an address that starts with http:// or https://.');
    });
    fireEvent.change(screen.getByLabelText('Route address'), {
      target: { value: 'ftp://box' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('alert').textContent).toMatch(/http:\/\//);
  });

  it('renders nothing while the preview is off', () => {
    state.preview = false;
    const { container } = renderPanel(station());
    expect(container.textContent).toBe('');
  });

  it('lists what a native profile’s Station reports without changing it', async () => {
    const native = station({
      id: 'station-profile:kontour',
      endpoints: [lan],
      accessMethods: [
        {
          accessVersion: 1,
          id: `access:direct:${lan.id}`,
          kind: 'direct-http',
          endpointId: lan.id,
        },
      ],
    });
    state.connections = { ...state.connections, activeConnection: native };
    state.fetch.mockResolvedValue(
      Response.json({
        environmentId: 'env-home',
        routes: [
          { kind: 'lan', url: lan.url },
          { kind: 'tailscale', url: 'http://100.77.142.114:3774' },
        ],
      }),
    );
    renderPanel(native);
    expect(
      await screen.findByText(
        'http://100.77.142.114:3774 · found automatically · not used by this app yet',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: '+ Add route' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(state.fetch).toHaveBeenCalledWith(
      'http://192.168.50.16:3774/api/system/routes',
      expect.anything(),
    );
  });
});
