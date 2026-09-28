/**
 * #2377 slice C2b: no HTTP route hands out an outbound peer bearer.
 *
 * The bearer this Station presents to a peer lives in `PeerCredentialStore`
 * and is read in-process only (the runtime's remote forwarder and a few
 * other server-side peer clients). C2b deleted the last route that returned
 * it (`GET /api/environments/peers/:id/credential`). This test does not
 * assert that one path is gone: it seeds a real credential in the real
 * store under the real `configureRuntimeRoutes` composition, requests EVERY
 * GET route the composition registers (path parameters bound to the seeded
 * Environment), as the operator, as this Station's internal caller, and as
 * a paired device, and asserts the secret never appears in any answer.
 * It also records which of those requests reached the store's raw read, so
 * the probe is shown to touch the read surface rather than pass vacuously.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_GRANT_PAIRING_SCOPE } from '@kontourai/station-contracts/environment-security';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { PeerCredentialStore } from '../../../services/peers/peer-credential-store.js';
import { DevicePairingService } from '../../../services/ssh/device-pairing-service.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
} from '../../../utils/internal-api-token.js';
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

const OPERATOR_SECRET = 'operator-secret-peer-bearer-fixture';
const PEER_ENV = 'environment-peer-bearer-probe';
// Synthetic bearer assembled from parts so no credential-shaped literal is
// committed (gitleaks generic-api-key); the test asserts it never leaks.
const PEER_SECRET = ['peer', 'bearer', 'fixture', '7f3a9c1e2b4d6f80'].join('-');
const LOOPBACK = {
  incoming: { socket: { remoteAddress: '127.0.0.1' } },
} as never;
const PER_REQUEST_MS = 1500;

async function bodyWithin(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + PER_REQUEST_MS;
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<'timeout'>((resolve) =>
          setTimeout(() => resolve('timeout'), remaining),
        ),
      ]);
      if (chunk === 'timeout' || chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  return text;
}

describe('no HTTP route returns an outbound peer bearer (#2377 C2b)', () => {
  const makeTempDir = trackTempDirs();
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('every GET route, as operator, internal caller and paired device, answers without the secret', async () => {
    const homeDir = makeTempDir('station-peer-bearer-');
    mkdirSync(join(homeDir, 'security'), { mode: 0o700 });
    await new PeerCredentialStore(homeDir).upsert({
      environmentId: PEER_ENV,
      apiBase: 'https://peer.example.test',
      scope: DEFAULT_GRANT_PAIRING_SCOPE,
      credential: PEER_SECRET,
      label: 'probe',
    });
    const reads: string[] = [];
    let currentRequest = '';
    const realGet = PeerCredentialStore.prototype.get;
    vi.spyOn(PeerCredentialStore.prototype, 'get').mockImplementation(function (
      this: PeerCredentialStore,
      environmentId: string,
    ) {
      reads.push(currentRequest);
      return realGet.call(this, environmentId);
    });

    const pairing = new DevicePairingService({
      homeDir,
      environmentId: '44444444-4444-4444-8444-444444444444',
    });
    const offer = pairing.createOffer({
      endpoint: 'https://station.example.test',
      scope: DEFAULT_GRANT_PAIRING_SCOPE,
      kind: 'device',
    });
    const request = pairing.requestPairing({
      requesterPosition: 'off-box',
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: 'probe device',
    });
    pairing.confirmRequest(request.requestId, {
      kind: 'presented-credential',
    });
    const device = pairing.exchange({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: request.requestId,
    });

    const app = new Hono();
    const context = deepStub({
      projectMembership: undefined,
      projectSharedTasks: undefined,
      deploymentAuthentication: undefined,
      localAccounts: undefined,
      applicationSessions: undefined,
      app,
      port: 4322,
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
      taskGraphService: { listTasks: () => [] },
      projectService: { listProjects: () => [] },
      sshEnvironmentService: deepStub({
        list: () => [],
      }),
      environmentSecurityService: deepStub({
        verifyCredential: (credential: string) =>
          credential === OPERATOR_SECRET ||
          pairing.verifyCredential(credential),
        authorizeCredential: (credential: string) =>
          credential === OPERATOR_SECRET ||
          pairing.verifyCredential(credential),
        verifyOperatorCredential: (credential: string) =>
          credential === OPERATOR_SECRET,
        resolveGrantedScope: (credential: string) =>
          credential === OPERATOR_SECRET
            ? DEFAULT_GRANT_PAIRING_SCOPE
            : pairing.identifyDevice(credential)?.scope,
        identifyDevice: (credential: string) =>
          pairing.identifyDevice(credential),
        credentialLocality: (credential: string) =>
          pairing.credentialLocality(credential),
        credentialMintKind: (credential: string) =>
          pairing.credentialMintKind(credential),
        devicePairing: pairing,
      }),
    });
    Reflect.set(context as object, 'buildRuntimeContext', () => context);
    const result = configureRuntimeRoutes(
      context as unknown as Parameters<typeof configureRuntimeRoutes>[0],
    );
    await result.kitLifecycleReady;

    const paths = [
      ...new Set(
        app.routes
          .filter((route) => route.method === 'GET' || route.method === 'ALL')
          .map((route) =>
            route.path
              .replace(/:[A-Za-z0-9_]+(\{[^}]*\})?\??/g, PEER_ENV)
              .replace(/\*/g, PEER_ENV),
          ),
      ),
    ];
    // Anchors: the composition really registered the peer surface, so an
    // empty or unrelated route table cannot pass this vacuously.
    expect(paths).toContain('/api/environments/peers');
    expect(paths.length).toBeGreaterThan(100);

    const callers: Array<[string, Record<string, string>]> = [
      ['operator', { Authorization: `Bearer ${OPERATOR_SECRET}` }],
      [
        'internal',
        {
          Authorization: `Bearer ${OPERATOR_SECRET}`,
          [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
        },
      ],
      ['device', { Authorization: `Bearer ${device.credential}` }],
    ];
    const leaks: string[] = [];
    for (const [caller, headers] of callers) {
      for (const path of [
        ...paths,
        `/api/environments/peers/${PEER_ENV}/credential`,
      ]) {
        currentRequest = `${caller} GET ${path}`;
        let response: Response;
        try {
          response = await Promise.race([
            Promise.resolve(app.request(path, { headers }, LOOPBACK)),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('timeout')), PER_REQUEST_MS),
            ),
          ]);
        } catch {
          continue; // a handler that never answers returned nothing
        }
        const text = `${[...response.headers.entries()].join('\n')}\n${await bodyWithin(response)}`;
        if (text.includes(PEER_SECRET)) leaks.push(currentRequest);
      }
    }
    expect(leaks).toEqual([]);
    // The removed leaf is not answered by anything else either.
    const leaf = await app.request(
      `/api/environments/peers/${PEER_ENV}/credential`,
      {
        headers: {
          Authorization: `Bearer ${OPERATOR_SECRET}`,
          [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
        },
      },
      LOOPBACK,
    );
    expect(leaf.status).not.toBe(200);
    // The probe reached the raw read (the peer-backed read routes do call
    // it), so "no leak" is about answers that held the secret in hand.
    expect(reads.length).toBeGreaterThan(0);
  }, 300_000);
});
