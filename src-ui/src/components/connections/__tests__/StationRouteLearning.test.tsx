/** @vitest-environment jsdom */

import type { SavedConnection } from '@kontourai/station-connect';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  connections: {} as Record<string, unknown>,
  status: 'connected',
  devicePreview: true,
  publicationPreview: false,
  isTauri: false,
  nativeRepositoryAccess: vi.fn(),
  fetch: vi.fn(),
  refreshNativeRoutes: vi.fn(),
}));

vi.mock('../../../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => ({ isTauri: state.isTauri }),
  nativeProfileRepository: () => {
    state.nativeRepositoryAccess();
    if (!state.isTauri)
      throw new Error('native repository is unavailable in the browser');
    return {
      refreshNativeRoutes: state.refreshNativeRoutes,
      captureNativeRequestBinding: () => ({ bindingId: 'native-binding' }),
    };
  },
}));

vi.mock('@kontourai/station-connect', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-connect')>()),
  useConnections: () => state.connections,
  useConnectionStatus: () => ({ status: state.status, routes: [] }),
}));
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  authenticatedFetch: (...args: unknown[]) => state.fetch(...args),
}));
vi.mock('../../../hooks/useDeveloperFeatures', () => ({
  useDeveloperFeatures: () => ({ stationRoutes: state.devicePreview }),
}));
vi.mock('../../../hooks/useSurfaceVisibilityFlags', () => ({
  useSurfaceVisibilityFlags: () =>
    new Set(state.publicationPreview ? ['dynamic-route-publications'] : []),
}));

import { StationRouteLearning } from '../useStationRoutes';

const lanUrl = 'http://192.168.50.16:3774';
const lanId = `endpoint:lan-http:${encodeURIComponent(lanUrl)}`;

function station(id = 'home'): SavedConnection {
  return {
    profileVersion: 4,
    id,
    name: 'Kontour',
    url: lanUrl,
    endpoints: [
      {
        endpointVersion: 1,
        id: lanId,
        url: lanUrl,
        kind: 'lan-http',
        priority: 100,
      },
    ],
    selectedEndpointId: lanId,
    accessMethods: [
      {
        accessVersion: 1,
        id: `access:direct:${lanId}`,
        kind: 'direct-http',
        endpointId: lanId,
      },
    ],
    selectedAccessMethodId: `access:direct:${lanId}`,
    environmentId: 'env-home',
    authProtocolVersion: 1,
    credentialRef: { credentialVersion: 1, kind: 'connection', id },
    capabilities: null,
    credentialState: 'saved',
  };
}

const report = {
  environmentId: 'env-home',
  routes: [{ kind: 'tailscale', url: 'http://100.77.142.114:3774' }],
  publication: {
    consentOrigin: 'https://approval.example.com',
    source: 'tailscale',
    appOrigins: ['http://100.77.142.114:3774'],
    status: 'ready',
  },
};

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <StationRouteLearning />
    </QueryClientProvider>,
  );
  return client;
}

const applyAdvertisedRoutes = vi.fn(() => true);

beforeEach(() => {
  state.isTauri = false;
  state.nativeRepositoryAccess.mockClear();
  state.refreshNativeRoutes.mockReset().mockResolvedValue(undefined);
  applyAdvertisedRoutes.mockClear();
  state.fetch.mockReset();
  state.fetch.mockImplementation(async () => Response.json(report));
  state.status = 'connected';
  state.devicePreview = true;
  state.publicationPreview = false;
  state.connections = {
    activeConnection: station(),
    applyAdvertisedRoutes,
    apiBase: lanUrl,
  };
});

describe('StationRouteLearning', () => {
  it('learns routes with only the Station-wide publication preview enabled', async () => {
    state.devicePreview = false;
    state.publicationPreview = true;
    mount();
    await waitFor(() =>
      expect(applyAdvertisedRoutes).toHaveBeenCalledWith(
        'home',
        'env-home',
        report.routes,
      ),
    );
  });

  it('does not fetch or learn routes when both previews are off', () => {
    state.devicePreview = false;
    mount();
    expect(state.fetch).not.toHaveBeenCalled();
    expect(applyAdvertisedRoutes).not.toHaveBeenCalled();
    expect(state.refreshNativeRoutes).not.toHaveBeenCalled();
  });

  it('learns only app routes, not the approval publication', async () => {
    mount();
    await waitFor(() =>
      expect(applyAdvertisedRoutes).toHaveBeenCalledWith(
        'home',
        'env-home',
        report.routes,
      ),
    );
  });

  it('does not ask while the Station is not connected', async () => {
    state.status = 'error';
    mount();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(state.fetch).not.toHaveBeenCalled();
  });

  it.each(['home', 'station-profile:kontour'])(
    'ignores an answer from a different Station for %s',
    async (connectionId) => {
      state.isTauri = connectionId.startsWith('station-profile:');
      state.connections = {
        ...state.connections,
        activeConnection: station(connectionId),
      };
      state.fetch.mockImplementation(async () =>
        Response.json({ ...report, environmentId: 'env-other' }),
      );
      const client = mount();
      await waitFor(() => expect(state.fetch).toHaveBeenCalled());
      await waitFor(() => expect(client.isFetching()).toBe(0));
      expect(applyAdvertisedRoutes).not.toHaveBeenCalled();
      expect(state.refreshNativeRoutes).not.toHaveBeenCalled();
    },
  );

  it('refreshes native routes through the host without applying renderer advertisements', async () => {
    state.isTauri = true;
    state.connections = {
      ...state.connections,
      activeConnection: station('station-profile:kontour'),
    };
    const client = mount();
    await waitFor(() =>
      expect(state.fetch).toHaveBeenCalledWith(
        `${lanUrl}/api/system/routes`,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(state.refreshNativeRoutes).toHaveBeenCalledExactlyOnceWith(
      'station-profile:kontour',
    );
    expect(applyAdvertisedRoutes).not.toHaveBeenCalled();
    await client.invalidateQueries({ queryKey: ['station-routes'] });
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(state.refreshNativeRoutes).toHaveBeenCalledTimes(2);
  });

  it('queries a native-shaped profile in the browser without accessing native authority', async () => {
    state.connections = {
      ...state.connections,
      activeConnection: station('station-profile:kontour'),
    };
    const client = mount();
    await waitFor(() => expect(state.fetch).toHaveBeenCalled());
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(state.nativeRepositoryAccess).not.toHaveBeenCalled();
    expect(state.refreshNativeRoutes).not.toHaveBeenCalled();
    expect(applyAdvertisedRoutes).not.toHaveBeenCalled();
  });
});
