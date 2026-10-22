// @vitest-environment jsdom
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { AuthorityQueryProvider } from '../contexts/AuthorityQueryContext';
import { nativeAuthenticatedTransport } from '../platform/native/authenticatedTransport';

const host = vi.hoisted(() => ({
  generation: 1,
  scope: {
    apiBase: 'https://native-station.example.test',
    authorityKey: 'native-1',
    requiresEnrolledCredential: true,
    isCurrent: () => true,
  },
  invoke: vi.fn(),
  channels: [] as Array<(message: unknown) => void>,
}));
vi.mock('@tauri-apps/api/core', () => ({
  Channel: class {
    constructor(callback: (message: unknown) => void) {
      host.channels.push(callback);
    }
  },
  invoke: host.invoke,
}));
vi.mock('@kontourai/station-connect', async (original) => ({
  ...(await original<typeof import('@kontourai/station-connect')>()),
  useConnections: () => ({
    apiBase: host.scope.apiBase,
    activeConnection: { id: 'native-home', credentialState: 'configured' },
    credentialAuthorityGeneration: () => host.generation,
  }),
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => host.scope,
}));
vi.mock('../platform/PlatformProfileContext', async (original) => ({
  ...(await original<typeof import('../platform/PlatformProfileContext')>()),
  usePlatformProfile: () => ({ isTauri: true }),
}));
vi.mock('../lib/local-ui-bootstrap', () => ({
  resolveLocalUiSession: () => {
    throw new Error('native must use its captured host credential');
  },
}));
vi.mock('../hooks/useInvalidateCachesOnConnectionSwitch', () => ({
  useConnectionSwitchScope: () => ({
    apiBase: host.scope.apiBase,
    hasActiveConnection: true,
    connectionScope: 'native',
  }),
  useInvalidateCachesOnConnectionSwitch: () => {},
}));

function Projects() {
  const query = useQuery({
    queryKey: ['projects'],
    queryFn: async () => {
      throw new Error('individual read must not run');
    },
    enabled: false,
  });
  return (
    <output data-testid="projects">{JSON.stringify(query.data ?? [])}</output>
  );
}

function renderNative() {
  const bootstrap = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const tree = () => (
    <QueryClientProvider client={bootstrap}>
      <AuthorityQueryProvider
        localUiApiBase="http://tauri.localhost"
        storage={{
          getItem: async () => null,
          setItem: async () => {},
          removeItem: async () => {},
        }}
        fetchObservation={async () => ({
          schemaVersion: 'station.authority-observation/v1',
          environmentId: 'native-environment',
          principal: { kind: 'human', id: `human:native-${host.generation}` },
          grant: { kind: 'operator' },
        })}
      >
        <Projects />
      </AuthorityQueryProvider>
    </QueryClientProvider>
  );
  const mounted = render(tree());
  return () => mounted.rerender(tree());
}

function answer(channel: (message: unknown) => void, project: string) {
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      sections: {
        projects: { data: { success: true, data: [{ id: project }] } },
      },
    }),
  );
  channel({
    type: 'response',
    status: 200,
    headers: {},
    bodyLength: bytes.length,
  });
  const buffer = new ArrayBuffer(bytes.length);
  new Uint8Array(buffer).set(bytes);
  channel(buffer);
  channel({ type: 'end' });
}

function configureHost() {
  host.generation = 1;
  host.scope = {
    apiBase: 'https://native-station.example.test',
    authorityKey: 'native-1',
    requiresEnrolledCredential: true,
    isCurrent: () => host.generation === 1,
  };
  host.channels = [];
  host.invoke.mockReset();
  setClientCredentialResolver(() => {
    const scope = host.scope;
    return {
      origin: scope.apiBase,
      requestAuthority: scope,
      transportBindingIsCurrent: scope.isCurrent,
      transport: (input, init) =>
        nativeAuthenticatedTransport(input, {
          ...init,
          expectedBindingId: scope.authorityKey,
        } as RequestInit),
    };
  });
}

afterEach(() => {
  cleanup();
  setClientCredentialResolver(undefined);
});

test('native verified boot uses one scoped broker request and seeds its query client', async () => {
  configureHost();
  host.invoke.mockImplementation(async (command: string) => {
    if (command === 'station_native_http_request') {
      const channel = host.channels.at(-1)!;
      queueMicrotask(() => answer(channel, 'batched-native-project'));
    }
  });
  const fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('direct WebView fetch is forbidden'));
  try {
    renderNative();
    await waitFor(() =>
      expect(screen.getByTestId('projects').textContent).toContain(
        'batched-native-project',
      ),
    );
    const requests = host.invoke.mock.calls.filter(
      ([command]) => command === 'station_native_http_request',
    );
    expect(requests).toHaveLength(1);
    expect(requests[0][1].request).toMatchObject({
      url: `${host.scope.apiBase}/api/boot`,
      method: 'GET',
      expectedBindingId: 'native-1',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    fetchSpy.mockRestore();
  }
});

test('native boot drops a late binary payload across a same-origin authorization change', async () => {
  configureHost();
  const rerender = renderNative();
  await waitFor(() => expect(host.invoke).toHaveBeenCalledTimes(1));
  const oldChannel = host.channels[0];
  await act(async () => {
    host.generation = 2;
    host.scope = {
      ...host.scope,
      authorityKey: 'native-2',
      isCurrent: () => host.generation === 2,
    };
    rerender();
  });
  await waitFor(() => expect(host.invoke).toHaveBeenCalledTimes(2));
  await act(async () => {
    answer(host.channels[1], 'current-project');
    answer(oldChannel, 'stale-project');
  });
  await waitFor(() =>
    expect(screen.getByTestId('projects').textContent).toContain(
      'current-project',
    ),
  );
  expect(screen.getByTestId('projects').textContent).not.toContain(
    'stale-project',
  );
});
