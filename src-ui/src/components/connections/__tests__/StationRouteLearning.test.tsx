/** @vitest-environment jsdom */

import type { SavedConnection } from '@kontourai/station-connect';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  connections: {} as Record<string, unknown>,
  status: 'connected',
  fetch: vi.fn(),
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
  useDeveloperFeatures: () => ({ stationRoutes: true }),
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
};

function mount() {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <StationRouteLearning />
    </QueryClientProvider>,
  );
}

const applyAdvertisedRoutes = vi.fn(() => true);

beforeEach(() => {
  applyAdvertisedRoutes.mockClear();
  state.fetch.mockReset();
  state.fetch.mockImplementation(async () => Response.json(report));
  state.status = 'connected';
  state.connections = {
    activeConnection: station(),
    applyAdvertisedRoutes,
    apiBase: lanUrl,
  };
});

describe('StationRouteLearning', () => {
  it('applies what the connected Station reports', async () => {
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

  it('ignores an answer from a different Station', async () => {
    state.fetch.mockImplementation(async () =>
      Response.json({ ...report, environmentId: 'env-other' }),
    );
    mount();
    await waitFor(() => expect(state.fetch).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(applyAdvertisedRoutes).not.toHaveBeenCalled();
  });

  it('leaves a native shared profile alone', async () => {
    state.connections = {
      ...state.connections,
      activeConnection: station('station-profile:kontour'),
    };
    mount();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(state.fetch).not.toHaveBeenCalled();
    expect(applyAdvertisedRoutes).not.toHaveBeenCalled();
  });
});
