// @vitest-environment jsdom

import { useConnections } from '@kontourai/station-connect';
import {
  AUTHORITY_OBSERVATION_SCHEMA_VERSION,
  type AuthorityObservation,
} from '@kontourai/station-contracts/authority-observation';
import { PUBLIC_HANDSHAKE_SCHEMA_VERSION } from '@kontourai/station-contracts/environment-security';
import {
  STATION_ENVELOPE_HEADER,
  STATION_ENVELOPE_HEADER_VALUE,
} from '@kontourai/station-contracts/http';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import { authenticatedFetch } from '@kontourai/station-sdk';
import { getJson } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiBaseProvider,
  useHostRequestAuthorityScope,
} from '../../contexts/ApiBaseContext';
import { AuthorityPersistenceContext } from '../../contexts/AuthorityPersistenceContext';
import {
  resolveStationConnection,
  type StationConnectionSource,
} from '../resolve-station-connection';
import {
  StationConnectionsProvider,
  useStationConnections,
} from '../StationConnectionsContext';
import {
  type ChatStationBindingV1,
  conversationCapabilitiesFromAuthority,
  effectiveConversationCapability,
} from '../station-connection';
import { captureStationConnectionAuthority } from '../station-connection-authority';
import {
  registerStationConnectionRegistry,
  retireStationConnectionRegistries,
  StationConnectionRegistry,
} from '../station-connection-registry';

vi.mock('../../platform/PlatformProfileContext', async () => {
  const { credentialRecoveryPlatformProfileContext } = await import(
    '../../contexts/__tests__/fixtures/credentialRecoveryPlatformProfileContext'
  );
  return credentialRecoveryPlatformProfileContext;
});
vi.mock('../../platform/useBundledServerStatus', () => ({
  useBundledServerStatus: () => null,
}));

function observation(
  environmentId: string,
  deviceId = environmentId,
): AuthorityObservation {
  const principal = humanPrincipal('test', environmentId, environmentId);
  return {
    schemaVersion: AUTHORITY_OBSERVATION_SCHEMA_VERSION,
    environmentId,
    principal: { kind: 'human', id: principal.id },
    grant: {
      kind: 'device',
      deviceId,
      grantedScopes: ['orchestration:read', 'orchestration:operate'],
    },
  };
}

function setup() {
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <ApiBaseProvider>{children}</ApiBaseProvider>
    </QueryClientProvider>
  );
  const hook = renderHook(
    () => ({
      connections: useConnections(),
      scope: useHostRequestAuthorityScope(),
    }),
    { wrapper },
  );
  const active = hook.result.current.connections.activeConnection;
  const scope = hook.result.current.scope;
  if (!active || !scope) throw new Error('missing source');
  const source: StationConnectionSource = {
    authorityNamespace: 'source-authority',
    observation: observation('host'),
    connectionId: active.id,
    stationName: 'Host',
    requestScope: scope,
    isCurrent: scope.isCurrent,
  };
  const registry = new StationConnectionRegistry(source.isCurrent);
  return { hook, source, registry, client };
}

type MountedConnections = {
  station: ReturnType<typeof useStationConnections>;
  profiles: ReturnType<typeof useConnections>;
};

function RegistryProbe({
  capture,
}: {
  capture(value: MountedConnections): void;
}) {
  capture({ station: useStationConnections(), profiles: useConnections() });
  return null;
}

function RegistryTree({
  client,
  namespace,
  capture,
}: {
  client: QueryClient;
  namespace: string;
  capture(value: MountedConnections): void;
}) {
  return (
    <QueryClientProvider client={client}>
      <ApiBaseProvider>
        <AuthorityPersistenceContext.Provider
          value={{
            status: 'verified',
            namespace,
            observation: observation('host'),
          }}
        >
          <StationConnectionsProvider>
            <RegistryProbe capture={capture} />
          </StationConnectionsProvider>
        </AuthorityPersistenceContext.Provider>
      </ApiBaseProvider>
    </QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Station connection registry', () => {
  it('refuses non-host operations when the chat preview is disabled while host remains usable', async () => {
    const { source, registry } = setup();
    source.remoteIsCurrent = () => false;
    const host = await resolveStationConnection({
      source,
      registry,
      profiles: [],
    });
    expect(host.connection.isCurrent()).toBe(true);
    await expect(
      resolveStationConnection({
        source,
        registry,
        profiles: [],
        environmentId: 'receiver',
      }),
    ).rejects.toMatchObject({ reason: 'authority-unavailable' });
    expect(host.connection.isCurrent()).toBe(true);
    host.release();
  });
  it('shares preparation, releases individual readers and retires all connections with the source client', async () => {
    const { source, registry, client } = setup();
    const unregister = registerStationConnectionRegistry(client, registry);
    const options = { source, registry, profiles: [] };
    const [a, b] = await Promise.all([
      resolveStationConnection(options),
      resolveStationConnection(options),
    ]);
    expect(a.connection.routeKind).toBe('host');
    expect(a.connection.runtimeKey).toBe(b.connection.runtimeKey);
    a.release();
    expect(a.connection.isCurrent()).toBe(false);
    expect(b.connection.isCurrent()).toBe(true);
    retireStationConnectionRegistries(client);
    expect(b.connection.isCurrent()).toBe(false);
    await expect(resolveStationConnection(options)).rejects.toMatchObject({
      name: 'StationRequestAuthorityError',
    });
    unregister();
  });

  it('verifies a directly paired target and sends through its profile while the host remains selected', async () => {
    const { hook, source, registry } = setup();
    let targetId = '';
    act(() => {
      const connections = hook.result.current.connections;
      targetId = connections.addConnection('Target', 'https://target.test').id;
      connections.setCredential(targetId, 'target-secret');
      connections.reconcileHandshake(targetId, {
        environmentId: 'target',
        authentication: { scheme: 'bearer', protocolVersion: 1 },
      });
    });
    const requests: { url: string; authorization: string | null }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input, init) => {
        requests.push({
          url: String(input),
          authorization: new Headers(init?.headers).get('Authorization'),
        });
        return new Response(
          JSON.stringify(
            String(input).endsWith('/api/auth/authority')
              ? observation('target')
              : { data: 'target-content' },
          ),
        );
      }),
    );
    const lease = await resolveStationConnection({
      source,
      registry,
      profiles: hook.result.current.connections.connections,
      environmentId: 'target',
    });
    expect(lease.connection.routeKind).toBe('direct');
    expect(lease.connection.binding.affinity).toMatchObject({
      kind: 'device',
      connectionId: targetId,
    });
    const response = await getJson(
      `${lease.connection.targetApiBase}/api/orchestration/sessions`,
      { requestScope: lease.connection.requestScope },
    );
    expect(await response.json()).toEqual({ data: 'target-content' });
    expect(requests).toEqual([
      {
        url: 'https://target.test/api/auth/authority',
        authorization: 'Bearer target-secret',
      },
      {
        url: 'https://target.test/api/orchestration/sessions',
        authorization: 'Bearer target-secret',
      },
    ]);
    expect(hook.result.current.connections.activeConnection?.id).toBe(
      source.connectionId,
    );
    registry.retire();
    await expect(
      authenticatedFetch('https://target.test/api/orchestration/sessions', {
        requestScope: lease.connection.requestScope,
      }),
    ).rejects.toMatchObject({ name: 'StationRequestAuthorityError' });
    expect(requests).toHaveLength(2);
  });

  it('rejects a saved label/endpoint without verified identity and never falls back from a peer affinity to host', async () => {
    const { source, registry } = setup();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => Response.json({}));
    vi.stubGlobal('fetch', fetch);
    const binding: ChatStationBindingV1 = {
      version: 1,
      environmentId: 'target',
      stationName: 'Host',
      affinity: {
        kind: 'peer',
        sourceEnvironmentId: 'host',
        sourceConnectionId: source.connectionId,
        principalNamespace: 'peer-principal',
      },
    };
    await expect(
      resolveStationConnection({ source, registry, profiles: [], binding }),
    ).rejects.toMatchObject({ reason: 'protocol-unavailable' });
    await expect(
      resolveStationConnection({
        source,
        registry,
        profiles: [],
        environmentId: 'target',
      }),
    ).rejects.toMatchObject({ reason: 'protocol-unavailable' });
    expect(
      fetch.mock.calls.every(([url]) =>
        String(url).endsWith('/.well-known/station/v1'),
      ),
    ).toBe(true);
    registry.retire();
  });

  it('resolves a negotiated relay with source credential scope and descriptor ceilings, retaining principal lineage', async () => {
    const { source, registry } = setup();
    let lineage = 'receiver-principal-one';
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (String(url).endsWith('/.well-known/station/v1'))
        return Response.json({
          schemaVersion: PUBLIC_HANDSHAKE_SCHEMA_VERSION,
          environmentId: 'host',
          authentication: { scheme: 'bearer', protocolVersion: 1 },
          transports: { http: 1, sse: 1, websocket: 1 },
          compatibility: {
            serverVersion: '0.1.11',
            protocolVersion: 4,
            minClientProtocol: 1,
          },
          capabilities: { peerChatTunnelV1: true },
        });
      return Response.json(
        {
          success: true,
          data: {
            version: 1,
            environmentId: 'receiver',
            stationName: 'Receiver',
            principalNamespace: lineage,
            receiver: { delegationLocalConversationV1: true },
            ceiling: { read: true, operate: true, localConversation: true },
          },
        },
        {
          headers: { [STATION_ENVELOPE_HEADER]: STATION_ENVELOPE_HEADER_VALUE },
        },
      );
    });
    vi.stubGlobal('fetch', fetcher);
    const lease = await resolveStationConnection({
      source,
      registry,
      profiles: [],
      environmentId: 'receiver',
    });
    expect(lease.connection.routeKind).toBe('relay');
    expect(lease.connection.requestScope).toEqual(source.requestScope);
    expect(lease.connection.targetApiBase).toBe(
      `${source.requestScope.apiBase}/api/environments/peers/receiver/chat-api`,
    );
    expect(lease.connection.capabilities.liveEvents.state).toBe('allowed');
    expect(lease.connection.capabilities.folderSelect.state).toBe('denied');
    expect(lease.connection.capabilities.fullAccess.state).toBe('denied');
    const binding = lease.connection.binding;
    lineage = 'receiver-principal-two';
    const recovered = await resolveStationConnection({
      source,
      registry,
      profiles: [],
      environmentId: 'receiver',
      legacyPeer: true,
    });
    expect(recovered.connection.runtimeKey).not.toBe(
      lease.connection.runtimeKey,
    );
    expect(recovered.connection.binding.affinity).toMatchObject({
      kind: 'peer',
      principalNamespace: lineage,
    });
    expect(binding.affinity).toMatchObject({
      kind: 'peer',
      principalNamespace: 'receiver-principal-one',
    });
    const pinned = await resolveStationConnection({
      source,
      registry,
      profiles: [],
      binding: recovered.connection.binding,
    });
    expect(pinned.connection.binding).toEqual(recovered.connection.binding);
    pinned.release();
    recovered.release();
    lease.release();
    await expect(
      resolveStationConnection({ source, registry, profiles: [], binding }),
    ).rejects.toMatchObject({ reason: 'authority-unavailable' });
    registry.retire();
  });

  it('keeps the resolver stable across a health tick that only refreshes profile timestamps', () => {
    const client = new QueryClient();
    const seen: MountedConnections[] = [];
    render(
      <RegistryTree
        client={client}
        namespace="source-authority"
        capture={(value) => seen.push(value)}
      />,
    );
    const before = seen.at(-1)!;
    const active = before.profiles.activeConnection!;
    // What the 10s health probe does: re-create the active profile with a new
    // success time. Remote chats re-resolve whenever this value changes.
    act(() => {
      before.profiles.recordEndpointSuccess(
        active.id,
        active.url,
        (active.lastSuccessAt ?? 0) + 10_000,
      );
    });
    const after = seen.at(-1)!;
    expect(after.profiles.activeConnection).not.toBe(active);
    expect(after.profiles.activeConnection?.lastSuccessAt).toBe(
      (active.lastSuccessAt ?? 0) + 10_000,
    );
    expect(after.station).toBe(before.station);
  });

  it('retires pending direct verification before it can publish after source replacement', async () => {
    const { source, registry, hook } = setup();
    let targetId = '';
    act(() => {
      const connections = hook.result.current.connections;
      targetId = connections.addConnection(
        'Pending',
        'https://pending.test',
      ).id;
      connections.setCredential(targetId, 'pending-secret');
      connections.reconcileHandshake(targetId, {
        environmentId: 'pending',
        authentication: { scheme: 'bearer', protocolVersion: 1 },
      });
    });
    let complete: (response: Response) => void = () => {
      throw new Error('fetch not started');
    };
    let dispatched: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      dispatched = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(
        () =>
          new Promise((resolve) => {
            complete = resolve;
            dispatched();
          }),
      ),
    );
    const pending = resolveStationConnection({
      source,
      registry,
      profiles: hook.result.current.connections.connections,
      environmentId: 'pending',
    });
    const result = expect(pending).rejects.toMatchObject({
      name: expect.stringMatching(/Station.*(Error)/),
    });
    await started;
    registry.retire();
    complete(new Response(JSON.stringify(observation('pending'))));
    await result;
    const authority = await captureStationConnectionAuthority(targetId);
    expect(authority.isCurrent()).toBe(true);
    authority.release();
  });

  it('retires direct and host leases when the mounted authority namespace is replaced', async () => {
    const client = new QueryClient();
    client.setQueryData(['system-status'], {
      devicePresentation: { hostName: 'Development workstation' },
    });
    client.setQueryData(
      ['feature-previews', 'default'],
      [
        {
          id: 'paired-station-chats',
          label: 'Paired Station chats',
          description: '',
          enabled: true,
        },
      ],
    );
    let connections: MountedConnections | null = null;
    const capture = (value: MountedConnections) => {
      connections = value;
    };
    const mounted = render(
      <RegistryTree client={client} namespace="first" capture={capture} />,
    );
    const connectionApi = (): MountedConnections => {
      if (!connections) throw new Error('provider not mounted');
      return connections;
    };
    const profiles = connectionApi().profiles;
    act(() => {
      const target = profiles.addConnection(
        'Namespace target',
        'https://namespace-target.test',
      );
      profiles.setCredential(target.id, 'namespace-secret');
      profiles.reconcileHandshake(target.id, {
        environmentId: 'namespace-target',
        authentication: { scheme: 'bearer', protocolVersion: 1 },
      });
    });
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(
        async (input) =>
          new Response(
            JSON.stringify(
              String(input).endsWith('/api/auth/authority')
                ? observation('namespace-target')
                : { private: 'old-namespace' },
            ),
          ),
      ),
    );
    const lease = await connectionApi().station.resolve();
    expect(connectionApi().profiles.activeConnection?.name).toBe('Default');
    expect(lease.connection.stationName).toBe('Development workstation');
    const direct = await connectionApi().station.resolve({
      environmentId: 'namespace-target',
    });
    const body = await getJson(
      `${direct.connection.targetApiBase}/api/orchestration/sessions`,
      { requestScope: direct.connection.requestScope },
    );
    expect(lease.connection.isCurrent()).toBe(true);
    mounted.rerender(
      <RegistryTree client={client} namespace="second" capture={capture} />,
    );
    expect(lease.connection.isCurrent()).toBe(false);
    expect(direct.connection.isCurrent()).toBe(false);
    await expect(body.json()).rejects.toMatchObject({
      name: 'StationRequestAuthorityError',
    });
    const replacement = await connectionApi().station.resolve();
    expect(replacement.connection.stationKey).not.toBe(
      lease.connection.stationKey,
    );
    expect(replacement.connection.runtimeKey).not.toBe(
      lease.connection.runtimeKey,
    );
    mounted.rerender(
      <RegistryTree
        client={new QueryClient()}
        namespace="second"
        capture={capture}
      />,
    );
    expect(replacement.connection.isCurrent()).toBe(false);
    const newClientLease = await connectionApi().station.resolve();
    expect(newClientLease.connection.isCurrent()).toBe(true);
    mounted.unmount();
    expect(newClientLease.connection.isCurrent()).toBe(false);
  });

  it('never widens a broker or permission ceiling with a request decision', () => {
    const capabilities = conversationCapabilitiesFromAuthority(
      observation('target'),
      { remote: true, mutationAllowed: false },
    );
    expect(capabilities.send).toEqual({
      state: 'denied',
      reason: 'broker-read-only',
    });
    expect(capabilities.historyRead).toEqual({
      state: 'denied',
      reason: 'protocol-unavailable',
    });
    expect(capabilities.offlineRead.state).toBe('denied');
    expect(
      effectiveConversationCapability(capabilities.send, { state: 'allowed' }),
    ).toEqual(capabilities.send);
  });
});
