import type { SavedConnection } from '@kontourai/station-connect';
import { mergeKnownEnvironments } from '@kontourai/station-connect/known-environment';
import type { SshEnvironmentView } from '@kontourai/station-sdk';
import { sshEnvironmentToKnownEnvironment } from '@kontourai/station-sdk';
import { describe, expect, it } from 'vitest';
import {
  savedConnectionsToKnownEnvironments,
  savedConnectionToKnownEnvironment,
} from '../views/connections-hub/knownEnvironmentAdapters';

function makeConnection(
  overrides: Partial<SavedConnection> = {},
): SavedConnection {
  return {
    profileVersion: 4,
    id: 'conn-1',
    name: 'Box B',
    url: 'https://box-b.tailnet.ts.net',
    endpoints: [
      {
        endpointVersion: 1,
        id: 'endpoint-1',
        url: 'https://box-b.tailnet.ts.net',
        kind: 'tailnet-https',
        priority: 100,
      },
    ],
    selectedEndpointId: 'endpoint-1',
    accessMethods: [
      {
        accessVersion: 1,
        id: 'access-1',
        kind: 'direct-http',
        endpointId: 'endpoint-1',
      },
    ],
    selectedAccessMethodId: 'access-1',
    environmentId: null,
    authProtocolVersion: null,
    credentialRef: { credentialVersion: 1, kind: 'connection', id: 'conn-1' },
    capabilities: null,
    credentialState: 'not-required',
    ...overrides,
  };
}

describe('savedConnectionToKnownEnvironment', () => {
  it('adapts a direct-http connection as source paired', () => {
    const environment = savedConnectionToKnownEnvironment(makeConnection());
    expect(environment?.label).toBe('Box B');
    expect(environment?.source).toBe('paired');
    expect(environment?.endpoints).toHaveLength(1);
    expect(environment?.endpoints[0].httpBaseUrl).toBe(
      'https://box-b.tailnet.ts.net',
    );
    expect(environment?.endpoints[0].preferred).toBe(true);
  });

  it('carries a learned environmentId', () => {
    const environment = savedConnectionToKnownEnvironment(
      makeConnection({ environmentId: 'environment-box-b' }),
    );
    expect(environment?.environmentId).toBe('environment-box-b');
  });

  it('tags a host-tunnel-only connection as source ssh', () => {
    const environment = savedConnectionToKnownEnvironment(
      makeConnection({
        endpoints: [],
        selectedEndpointId: '',
        accessMethods: [
          {
            accessVersion: 1,
            id: 'access-ssh',
            kind: 'host-tunnel',
            adapter: 'ssh',
            hostAlias: 'build-box',
            remoteProjectPath: '/home/dev/project',
          },
        ],
        selectedAccessMethodId: 'access-ssh',
      }),
    );
    expect(environment?.source).toBe('ssh');
    expect(environment?.endpoints).toHaveLength(0);
  });

  it('excludes a host-injected connection (returns null)', () => {
    expect(
      savedConnectionToKnownEnvironment(makeConnection({ injected: true })),
    ).toBeNull();
  });
});

describe('savedConnectionsToKnownEnvironments', () => {
  it('drops injected connections while adapting the rest', () => {
    const environments = savedConnectionsToKnownEnvironments([
      makeConnection({ id: 'conn-1' }),
      makeConnection({ id: 'conn-2', injected: true, name: 'Loopback' }),
    ]);
    expect(environments).toHaveLength(1);
    expect(environments[0].id).toBe('paired:conn-1');
  });
});

function makeSshView(
  overrides: Partial<SshEnvironmentView> = {},
): SshEnvironmentView {
  return {
    profile: {
      schemaVersion: 1,
      id: 'ssh-env-1',
      name: 'Box B via SSH',
      hostAlias: 'box-b',
      remoteProjectPath: '/home/dev/project',
      remotePort: 22,
      launchMode: 'attach',
      environmentId: 'environment-box-b',
      hostIdentity: null,
      verifiedProjectPath: null,
      remoteHome: null,
      workerProtocolVersion: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      lastConnectedAt: null,
    },
    state: {
      phase: 'connected',
      localUrl: 'https://box-b.tailnet.ts.net',
      instanceId: 'i',
      sha: 's',
      bootId: 'b',
      connectedAt: '2026-01-01T00:05:00.000Z',
    },
    ...overrides,
  };
}

describe('cross-adapter endpoint dedup (station#1096 fix round 1, item 4)', () => {
  it('a trailing-slash paired endpoint and a bare ssh endpoint for the same station normalize to one URL and merge into one endpoint', () => {
    const paired = savedConnectionToKnownEnvironment(
      makeConnection({
        environmentId: 'environment-box-b',
        endpoints: [
          {
            endpointVersion: 1,
            id: 'endpoint-1',
            // Trailing slash, unlike the ssh adapter's bare origin below —
            // both producers must normalize through the same function
            // (`normalizeBaseUrl`) for the merge below to dedup correctly.
            url: 'https://box-b.tailnet.ts.net/',
            kind: 'tailnet-https',
            priority: 100,
          },
        ],
      }),
    );
    const ssh = sshEnvironmentToKnownEnvironment(makeSshView());

    expect(paired?.endpoints[0].httpBaseUrl).toBe(
      'https://box-b.tailnet.ts.net',
    );
    expect(ssh.endpoints[0].httpBaseUrl).toBe('https://box-b.tailnet.ts.net');

    const merged = mergeKnownEnvironments([paired!], ssh);
    expect(merged).toHaveLength(1);
    expect(merged[0].endpoints).toHaveLength(1);
  });
});
