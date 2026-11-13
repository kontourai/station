/**
 * #4886: troubleshooting seeds say when the seeded conversation is not stored
 * on this Station, through the REAL composition.
 *
 * `troubleshoot-prepare.routes.test.ts` hands `TroubleshootService` its
 * conversation store directly. Neither it nor the service tests see
 * `configureRuntimeRoutes` supply the orchestration event store, and the
 * service says nothing either way when the store is absent. This drives the
 * real composition with a real `EventStore`: a conversation opened from a
 * paired Station (no lineage here) must get the location line, and one that
 * ran here must not.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_GRANT_PAIRING_SCOPE } from '@kontourai/station-contracts';
import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
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

// The doctor probes the host's engines and config; it is not the seam here.
vi.mock(
  '../../../../packages/cli/src/commands/lifecycle-doctor.js',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('../../../../packages/cli/src/commands/lifecycle-doctor.js')
    >()),
    collectDoctorReport: async () => ({
      checks: [],
      recommendation: '',
      chatReady: true,
      runtimeReady: true,
    }),
  }),
);

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

const OPERATOR_SECRET = 'operator-secret-troubleshoot-store-fixture';
const isOperator = (credential: string) => credential === OPERATOR_SECRET;
const SEED_LINE = '- Conversation location: not on this Station.';

describe('runtime routes: troubleshoot seed reads this Station conversation store', () => {
  const makeTempDir = trackTempDirs();

  test('a paired Station conversation is flagged and a local one is not', async () => {
    const homeDir = makeTempDir('station-troubleshoot-store-wiring-');
    mkdirSync(join(homeDir, 'security'), { mode: 0o700 });
    const store = new EventStore(join(homeDir, 'events.sqlite'));
    const now = new Date().toISOString();
    store.upsertSession({
      provider: 'claude',
      threadId: 'claude:local-1',
      status: 'ready',
      createdAt: now,
      updatedAt: now,
    });
    // The real store, with the one member the stubbed route surface would
    // otherwise need from it answered inertly.
    const orchestrationEventStore = new Proxy(store, {
      get(target, property, receiver) {
        if (property === 'sessionTurnBoundaryAuthority')
          return () => ({
            reconcile: () => ({ kind: 'available', interrupted: [] }),
          });
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const app = new Hono();
    const context = deepStub({
      projectMembership: undefined,
      projectSharedTasks: undefined,
      deploymentAuthentication: undefined,
      localAccounts: undefined,
      applicationSessions: undefined,
      relayEnrollment: undefined,
      readConfinementPreflight: undefined,
      buildProvenanceSnapshot: undefined,
      app,
      host: '127.0.0.1',
      port: 4321,
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
      orchestrationEventStore,
      taskGraphService: { listTasks: () => [] },
      projectService: { listProjects: () => [] },
      environmentSecurityService: deepStub({
        verifyCredential: isOperator,
        authorizeCredential: isOperator,
        verifyOperatorCredential: isOperator,
        resolveGrantedScope: (credential: string) =>
          isOperator(credential) ? DEFAULT_GRANT_PAIRING_SCOPE : undefined,
        identifyDevice: () => undefined,
        credentialLocality: () => undefined,
        credentialMintKind: () => undefined,
        getPublicHandshake: async () => ({ environmentId: 'env-fixture' }),
      }),
    });
    Reflect.set(context as object, 'buildRuntimeContext', () => context);
    const result = configureRuntimeRoutes(
      context as unknown as Parameters<typeof configureRuntimeRoutes>[0],
    );
    await result.kitLifecycleReady;
    const ambient = async (conversationId: string) => {
      const response = await app.request(
        '/api/diagnostics/troubleshoot/prepare',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            Authorization: `Bearer ${OPERATOR_SECRET}`,
          },
          body: JSON.stringify({
            seed: { conversationId, errorSummary: 'engine-turn-failed: Boom' },
          }),
        },
        { incoming: { socket: { remoteAddress: '127.0.0.1' } } },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        runId: string;
        ambientContext: string;
      };
      // The run landed under this Station's home, as the composition says.
      expect(
        readFileSync(
          join(homeDir, 'cache', 'triage', body.runId, 'seed.md'),
          'utf8',
        ),
      ).toBe(`${body.ambientContext}\n`);
      return body.ambientContext;
    };

    try {
      const local = await ambient('claude:local-1');
      expect(local).toContain('- Conversation: claude:local-1');
      expect(local).not.toContain(SEED_LINE);
      const peer = await ambient('claude:1794521333066');
      expect(peer).toContain(SEED_LINE);
      expect(peer).toContain('paired Station');
    } finally {
      await result.browserService?.shutdown();
      await result.deviceHosts?.dispose();
      await result.deviceToolchainService?.shutdown();
      store.close();
    }
  });
});
