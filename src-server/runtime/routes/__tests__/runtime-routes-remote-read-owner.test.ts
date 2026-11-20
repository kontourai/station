/**
 * Security review H1, through the real `configureRuntimeRoutes` composition:
 * every read of another Station through this one presents the Station-wide
 * outbound peer bearer, so only the bound owner may make one. A real
 * EnvironmentSecurityService pairs a real owner device and a real device
 * bound to another person; a real HTTP listener stands in for the remote
 * Station behind the SSH tunnel and records every request it receives, so
 * "refused" means no bearer left this Station.
 */

import { mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import {
  type PairedDevice,
  pairingScopePresetString,
} from '@kontourai/station-contracts/environment-security';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { PeerCredentialStore } from '../../../services/peers/peer-credential-store.js';
import { EnvironmentSecurityService } from '../../../services/ssh/environment-security-service.js';
import { configureRuntimeRoutes } from '../runtime-routes.js';

vi.mock('../runtime-route-support.js', () => {
  const runtimeSupportStub = new Proxy({}, { get: () => () => undefined });
  return {
    configureRuntimeSupportServices: () => ({
      schedulerService: runtimeSupportStub,
      notificationService: runtimeSupportStub,
      attentionProjection: runtimeSupportStub,
      webPushService: runtimeSupportStub,
      webPushEnabled: false,
    }),
    createRuntimeSystemRouteDeps: () => runtimeSupportStub,
  };
});

/** Answers every unlisted member with an inert, non-thenable proxy. */
function deepStub<T extends object>(overrides: T): T {
  return new Proxy(overrides, {
    get(target, property) {
      if (property in target) return Reflect.get(target, property);
      const proxy: unknown = new Proxy(() => undefined, {
        get: (_target, property) => (property === 'then' ? undefined : proxy),
      });
      return proxy;
    },
  }) as T;
}

const PEER_ENV = 'peer-environment-remote-read';
const PROFILE_ID = '22222222-2222-4222-8222-222222222222';
const THREAD = 'external:claude:0123456789abcdef0123456789abcdef';
const PEER_SECRET = ['peer', 'bearer', 'remote', 'read', '5d2c'].join('-');
const TAILNET = {
  incoming: { socket: { remoteAddress: '100.96.12.7' } },
} as never;

const makeTempDir = trackTempDirs();
const servers = new Set<Server>();
afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  servers.clear();
});

/** The remote Station: answers its list, window and search reads. */
async function remoteStation() {
  const received: string[] = [];
  const bearers: Array<string | undefined> = [];
  const server = createServer((request, response) => {
    received.push(`${request.method} ${request.url}`);
    bearers.push(request.headers.authorization);
    response.setHeader('Content-Type', 'application/json');
    const url = new URL(request.url ?? '/', 'http://remote');
    if (url.pathname === '/api/orchestration/sessions/read-model')
      return response.end(
        JSON.stringify({ success: true, data: [{ threadId: THREAD }] }),
      );
    if (url.pathname === '/api/conversations/search')
      return response.end(
        JSON.stringify({
          success: true,
          data: [
            {
              conversationId: 'remote-conversation',
              messageId: 'remote-message',
              role: 'assistant',
              excerpt: 'remote cobalt albatross',
            },
          ],
        }),
      );
    if (url.pathname.startsWith('/api/orchestration/sessions/'))
      return response.end(
        JSON.stringify({
          success: true,
          data: {
            protocolVersion: 1,
            session: { threadId: THREAD },
            events: [],
            hasMore: false,
            watermark: 0,
          },
        }),
      );
    response.statusCode = 404;
    response.end(JSON.stringify({ success: false, error: 'Not found' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.add(server);
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, received, bearers };
}

async function composedStation() {
  const homeDir = makeTempDir('station-remote-read-owner-');
  mkdirSync(join(homeDir, 'security'), { recursive: true, mode: 0o700 });
  const security = new EnvironmentSecurityService({ homeDir, environment: {} });
  await security.initialize();
  await new PeerCredentialStore(homeDir).upsert({
    environmentId: PEER_ENV,
    apiBase: 'https://peer.example.test',
    scope: pairingScopePresetString('delegation'),
    credential: PEER_SECRET,
    label: 'remote',
  });
  const remote = await remoteStation();
  const pair = (
    person?: string,
  ): { credential: string; device: PairedDevice } => {
    const pairing = security.devicePairing;
    const offer = pairing.createOffer({
      endpoint: 'https://station.example.test',
      scope: pairingScopePresetString('standard'),
      kind: 'device',
    });
    const request = pairing.requestPairing({
      requesterPosition: 'off-box',
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: person ? 'Guest phone' : 'Owner phone',
      ...(person
        ? {
            source: 'tailnet' as const,
            requester: { provider: 'tailscale-serve' as const, login: person },
          }
        : { source: 'pairing-code' as const }),
    });
    pairing.confirmRequest(
      request.requestId,
      { kind: 'presented-credential' },
      person
        ? {
            principalId: humanPrincipal('tailscale-serve', person, person).id,
            kind: 'verified-ingress',
          }
        : undefined,
    );
    return pairing.exchange({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: request.requestId,
    });
  };

  const app = new Hono();
  const context = deepStub({
    projectMembership: undefined,
    projectSharedTasks: undefined,
    deploymentAuthentication: undefined,
    localAccounts: undefined,
    applicationSessions: undefined,
    app,
    port: 4323,
    appConfig: {},
    configLoader: {
      getProjectHomeDir: () => homeDir,
      loadAppConfig: () => ({}),
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    activeAgents: new Map(),
    agentService: { listAgents: () => [] },
    agentMetadataMap: new Map(),
    agentFixedTokens: new Map(),
    agentTools: new Map(),
    agentStats: new Map(),
    agentStatus: new Map(),
    memoryAdapters: new Map(),
    metricsLog: [],
    monitoringEvents: [],
    orchestrationEventStore: deepStub({
      sessionTurnBoundaryAuthority: () => ({
        reconcile: () => ({ kind: 'available', interrupted: [] }),
      }),
    }),
    orchestrationService: deepStub({
      searchSessionMessages: () => [
        {
          conversationId: 'local-conversation',
          messageId: 'local-message',
          role: 'user',
          excerpt: 'local cobalt albatross',
        },
      ],
    }),
    taskGraphService: { listTasks: () => [] },
    projectService: { listProjects: () => [] },
    sshEnvironmentService: deepStub({
      list: () => [
        {
          profile: {
            id: PROFILE_ID,
            name: 'Home media',
            environmentId: PEER_ENV,
          },
          state: { phase: 'connected', localUrl: remote.url },
        },
      ],
    }),
    environmentSecurityService: security,
  });
  Reflect.set(context as object, 'buildRuntimeContext', () => context);
  const result = configureRuntimeRoutes(
    context as unknown as Parameters<typeof configureRuntimeRoutes>[0],
  );
  await result.kitLifecycleReady;
  const call = (path: string, credential: string) =>
    app.request(
      path,
      { headers: { Authorization: `Bearer ${credential}` } },
      TAILNET,
    );
  return { call, pair, remote };
}

const LIST = '/api/environments/ssh/sessions';
const HISTORY = `/api/environments/ssh/sessions/${PROFILE_ID}/${encodeURIComponent(THREAD)}/history`;
const SEARCH = '/api/conversations/search?query=cobalt%20albatross';

describe('remote reads through the real runtime composition', () => {
  test('the bound owner reaches the remote Station on all three reads', async () => {
    const { call, pair, remote } = await composedStation();
    const owner = pair();
    expect((await call(LIST, owner.credential)).status).toBe(200);
    expect((await call(HISTORY, owner.credential)).status).toBe(200);
    const search = await call(SEARCH, owner.credential);
    expect(search.status).toBe(200);
    const body = (await search.json()) as {
      data: Array<{ conversationId: string }>;
    };
    expect(body.data.map((match) => match.conversationId)).toContain(
      'remote-conversation',
    );
    // Positive control: each read really went to the remote Station.
    expect(remote.received.some((line) => line.includes('read-model'))).toBe(
      true,
    );
    expect(
      remote.received.some((line) => line.includes('view=window-v1')),
    ).toBe(true);
    expect(
      remote.received.some((line) =>
        line.includes('/api/conversations/search'),
      ),
    ).toBe(true);
    // Every one of those reads carried the stored outbound peer bearer.
    expect(remote.bearers).toHaveLength(remote.received.length);
    expect(new Set(remote.bearers)).toEqual(new Set([`Bearer ${PEER_SECRET}`]));
  }, 120_000);

  test('a device bound to another person is refused on the list and history, and gets only local search results', async () => {
    const { call, pair, remote } = await composedStation();
    const guest = pair('guest@example.test');
    expect((await call(LIST, guest.credential)).status).toBe(403);
    expect((await call(HISTORY, guest.credential)).status).toBe(403);
    const search = await call(SEARCH, guest.credential);
    expect(search.status).toBe(200);
    const body = (await search.json()) as {
      data: Array<{ conversationId: string }>;
      instances: Array<{ instanceId: string }>;
    };
    expect(body.data.map((match) => match.conversationId)).toEqual([
      'local-conversation',
    ]);
    expect(body.instances.map((instance) => instance.instanceId)).toEqual([
      'local',
    ]);
    // No request, and so no bearer, reached the remote Station.
    expect(remote.received).toEqual([]);
  }, 120_000);
});
