/** @vitest-environment jsdom */

import type { SavedConnection } from '@kontourai/station-connect';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  preview: true,
  publicationPreview: false,
  connections: {} as Record<string, unknown>,
  health: {} as Record<string, unknown>,
  fetch: vi.fn(),
  config: {} as Record<string, unknown>,
  update: {} as Record<string, unknown>,
  mutate: vi.fn(),
}));

vi.mock('@kontourai/station-connect', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-connect')>()),
  useConnections: () => state.connections,
  useConnectionStatus: () => state.health,
}));
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  authenticatedFetch: (...args: unknown[]) => state.fetch(...args),
  useConfigQuery: () => state.config,
  useUpdateConfigMutation: () => state.update,
}));
vi.mock('../../../hooks/useDeveloperFeatures', () => ({
  useDeveloperFeatures: () => ({ stationRoutes: state.preview }),
}));
vi.mock('../../../hooks/useSurfaceVisibilityFlags', () => ({
  useSurfaceVisibilityFlags: () =>
    new Set(state.publicationPreview ? ['dynamic-route-publications'] : []),
}));

import { StationRoutesSection } from '../StationRoutesSection';

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
  state.connections = { ...state.connections, activeConnection: connection };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <StationRoutesSection />
    </QueryClientProvider>,
  );
}

const addRoute = vi.fn(() => true);
const removeRoute = vi.fn(() => true);
const recheck = vi.fn();

beforeEach(() => {
  state.fetch.mockImplementation(async () =>
    Response.json({ environmentId: 'env-home', routes: [] }),
  );
  state.config = {
    data: { trustedConsentOrigin: '' },
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  };
  state.update = { mutate: state.mutate, isPending: false, isError: false };
  state.preview = true;
  state.publicationPreview = false;
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
  state.mutate.mockReset();
});

describe('StationRoutesSection', () => {
  it('shows the failure once and notes only what differs on each route', () => {
    renderPanel(station());
    expect(screen.getByText("Can't reach Kontour.").getAttribute('role')).toBe(
      'status',
    );
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

  it('marks the route in use and shows no status line when connected', async () => {
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
    await waitFor(() =>
      expect(screen.queryByLabelText('Reading published routes')).toBeNull(),
    );
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
    expect(state.fetch).not.toHaveBeenCalled();
  });

  it('reveals Routes with only the Station-wide publication preview enabled', async () => {
    state.preview = false;
    state.publicationPreview = true;
    renderPanel(station());
    expect(screen.getByText('Routes')).toBeTruthy();
    await waitFor(() => expect(state.fetch).toHaveBeenCalled());
  });

  it('keeps the approval editor absent when the server omits publication', async () => {
    renderPanel(station());
    await waitFor(() =>
      expect(screen.queryByLabelText('Reading published routes')).toBeNull(),
    );
    expect(screen.queryByLabelText('Approval HTTPS origin')).toBeNull();
    expect(state.mutate).not.toHaveBeenCalled();
  });

  it('retries a failed publication read without changing configuration', async () => {
    state.fetch.mockRejectedValueOnce(new Error('offline'));
    renderPanel(station());
    expect(
      await screen.findByText('Published routes could not be refreshed'),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'Retry published routes' }),
    );
    await waitFor(() =>
      expect(
        screen.queryByText('Published routes could not be refreshed'),
      ).toBeNull(),
    );
    expect(state.fetch).toHaveBeenCalledTimes(2);
    expect(state.mutate).not.toHaveBeenCalled();
  });

  it.each(['unsafe-origin', 'different-station'])(
    'hides publication controls for a %s response',
    async (scenario) => {
      state.fetch.mockImplementation(async () =>
        Response.json({
          environmentId:
            scenario === 'different-station' ? 'env-other' : 'env-home',
          routes: [],
          publication: {
            consentOrigin:
              scenario === 'unsafe-origin'
                ? 'https://approval.example.com/path'
                : 'https://approval.example.com',
            source: 'configured',
            appOrigins: [],
            status: 'ready',
          },
        }),
      );
      renderPanel(station());
      await waitFor(() =>
        expect(screen.queryByLabelText('Reading published routes')).toBeNull(),
      );
      expect(screen.queryByLabelText('Approval HTTPS origin')).toBeNull();
      expect(state.mutate).not.toHaveBeenCalled();
    },
  );

  it('renders parsed publication for editable connections and saves origin choices through config', async () => {
    state.fetch.mockImplementation(async () =>
      Response.json({
        environmentId: 'env-home',
        routes: [],
        publication: {
          consentOrigin: 'https://approval.example.com',
          source: 'tailscale',
          appOrigins: ['http://100.77.142.114:3774'],
          status: 'ready',
        },
      }),
    );
    renderPanel(station());
    const input = await screen.findByLabelText('Approval HTTPS origin');
    expect(screen.getByText('Approval HTTPS route ready')).toBeTruthy();
    expect(screen.getByText('http://100.77.142.114:3774')).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: /configure tailscale/i }),
    ).toBeNull();
    fireEvent.change(input, {
      target: { value: 'https://chosen.example.com' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Save approval origin' }),
    );
    expect(state.mutate).toHaveBeenCalledWith(
      { trustedConsentOrigin: 'https://chosen.example.com' },
      expect.anything(),
    );
  });

  it('replaces an absent saved choice and legacy startup fallback with automatic discovery', async () => {
    state.config = { ...state.config, data: {} };
    state.fetch.mockImplementation(async () =>
      Response.json({
        environmentId: 'env-home',
        routes: [],
        publication: {
          consentOrigin: 'https://legacy.example.com',
          source: 'configured',
          appOrigins: [],
          status: 'ready',
        },
      }),
    );
    renderPanel(station());
    await screen.findByLabelText('Approval HTTPS origin');
    const save = screen.getByRole('button', { name: 'Save approval origin' });
    expect(save.hasAttribute('disabled')).toBe(true);
    fireEvent.click(
      screen.getByRole('button', { name: 'Use automatic discovery' }),
    );
    expect(save.hasAttribute('disabled')).toBe(false);
    fireEvent.click(save);
    expect(state.mutate).toHaveBeenCalledWith(
      { trustedConsentOrigin: '' },
      expect.anything(),
    );
  });

  it('blocks unsafe origin edits and persists empty as automatic discovery', async () => {
    state.config = {
      ...state.config,
      data: { trustedConsentOrigin: 'https://saved.example.com' },
    };
    state.fetch.mockImplementation(async () =>
      Response.json({
        environmentId: 'env-home',
        routes: [],
        publication: {
          consentOrigin: null,
          source: 'unavailable',
          appOrigins: [],
          status: 'ambiguous',
        },
      }),
    );
    renderPanel(station());
    const input = await screen.findByLabelText('Approval HTTPS origin');
    fireEvent.change(input, {
      target: { value: 'https://user:secret@approval.example.com' },
    });
    expect(screen.getByRole('alert').textContent).toMatch(
      /exact HTTPS DNS origin/,
    );
    expect(
      screen
        .getByRole('button', { name: 'Save approval origin' })
        .hasAttribute('disabled'),
    ).toBe(true);
    expect(state.mutate).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.click(
      screen.getByRole('button', { name: 'Save approval origin' }),
    );
    expect(state.mutate).toHaveBeenCalledWith(
      { trustedConsentOrigin: '' },
      expect.anything(),
    );
  });

  it.each([
    ['unavailable', 'Approval HTTPS route unavailable'],
    ['ambiguous', 'Multiple approval HTTPS routes found; choose an origin'],
    ['disabled', 'Approval HTTPS publication disabled'],
  ])('shows %s and keeps manual setup explicit', async (status, message) => {
    state.fetch.mockImplementation(async () =>
      Response.json({
        environmentId: 'env-home',
        routes: [],
        publication: {
          consentOrigin: null,
          source: 'unavailable',
          appOrigins: [],
          status,
        },
      }),
    );
    renderPanel(station());
    expect(await screen.findByText(message)).toBeTruthy();
    if (status === 'unavailable') {
      expect(
        screen.getByText(/Manually configure an HTTPS mapping/),
      ).toBeTruthy();
    }
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
