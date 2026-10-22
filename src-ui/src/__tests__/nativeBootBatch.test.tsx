// @vitest-environment jsdom
import { useProjectsQuery } from '@kontourai/station-sdk';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { _setApiBase } from '../../../packages/sdk/src/api-core';
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
  useApiBase: () => ({ apiBase: host.scope.apiBase }),
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
  const query = useProjectsQuery();
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
  _setApiBase(host.scope.apiBase);
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

test('a refused native boot releases mounted queries to their individual reads', async () => {
  configureHost();
  host.invoke.mockImplementation(async (command: string, args) => {
    if (command !== 'station_native_http_request') return;
    const channel = host.channels.at(-1)!;
    queueMicrotask(() => {
      if (args.request.url.endsWith('/api/boot')) {
        channel({ type: 'response', status: 404, headers: {}, bodyLength: 0 });
        channel({ type: 'end' });
      } else if (args.request.url.endsWith('/api/projects')) {
        const bytes = new TextEncoder().encode(
          JSON.stringify({
            success: true,
            data: [{ id: 'individual-project' }],
          }),
        );
        const buffer = new ArrayBuffer(bytes.length);
        new Uint8Array(buffer).set(bytes);
        channel({
          type: 'response',
          status: 200,
          headers: {},
          bodyLength: bytes.length,
        });
        channel(buffer);
        channel({ type: 'end' });
      } else throw new Error(`unexpected native request: ${args.request.url}`);
    });
  });
  renderNative();
  await waitFor(() =>
    expect(screen.getByTestId('projects').textContent).toContain(
      'individual-project',
    ),
  );
  expect(host.invoke.mock.calls.map(([, args]) => args.request.url)).toEqual([
    `${host.scope.apiBase}/api/boot`,
    `${host.scope.apiBase}/api/projects`,
  ]);
});

test('a native boot that settles while the scope is briefly not current still releases the gate', async () => {
  configureHost();
  let current = true;
  host.scope.isCurrent = () => current;
  host.invoke.mockImplementation(async (command: string, args) => {
    if (command !== 'station_native_http_request') return;
    const channel = host.channels.at(-1)!;
    if (args.request.url.endsWith('/api/boot')) {
      current = false;
      setTimeout(() => {
        channel({ type: 'response', status: 503, headers: {}, bodyLength: 0 });
        channel({ type: 'end' });
        setTimeout(() => {
          current = true;
        }, 20);
      }, 0);
      return;
    }
    if (args.request.url.endsWith('/api/projects')) {
      const bytes = new TextEncoder().encode(
        JSON.stringify({ success: true, data: [{ id: 'after-blip' }] }),
      );
      const buffer = new ArrayBuffer(bytes.length);
      new Uint8Array(buffer).set(bytes);
      queueMicrotask(() => {
        channel({
          type: 'response',
          status: 200,
          headers: {},
          bodyLength: bytes.length,
        });
        channel(buffer);
        channel({ type: 'end' });
      });
      return;
    }
    throw new Error(`unexpected native request: ${args.request.url}`);
  });
  renderNative();
  await waitFor(() =>
    expect(screen.getByTestId('projects').textContent).toContain('after-blip'),
  );
});
