/**
 * The open read's `callerAccess` through the PRODUCTION composition:
 * `configureRuntimeRoutes` must hand the conversation routes the runtime's
 * own `environmentSecurityService`, or the field is silently omitted and the
 * chat dock falls back to offering every action. The route-level suite
 * (`conversation-open-caller-access.test.ts`) proves the gate; this proves
 * the wiring, with the real gate evaluating the context's security service.
 */
import {
  DEFAULT_GRANT_PAIRING_SCOPE,
  pairingScopePresetString,
} from '@kontourai/station-contracts';
import { agentId } from '@kontourai/station-contracts/agent-identity';
import type { ConversationOpenResolution } from '@kontourai/station-contracts/orchestration';
import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { setRuntimeAuthenticatedRequestPrincipal } from '../../../security/runtime-request-security.js';
import { configureRuntimeRoutes } from '../runtime-routes.js';

const runtimeSupport = vi.hoisted(() => {
  const service = new Proxy({}, { get: () => () => undefined });
  return {
    notificationService: { list: vi.fn(() => [] as unknown[]) },
    service,
  };
});

vi.mock('../runtime-route-support.js', () => ({
  configureRuntimeSupportServices: () => ({
    schedulerService: runtimeSupport.service,
    notificationService: runtimeSupport.notificationService,
    attentionProjection: runtimeSupport.service,
    webPushService: runtimeSupport.service,
    webPushEnabled: true,
  }),
  createRuntimeSystemRouteDeps: () => runtimeSupport.service,
}));

// Ingress has its own boundary suite; the test middleware below stands in
// for its one output this test needs, the authenticated request principal.
vi.mock('../../bootstrap/runtime-http.js', async (importOriginal) => ({
  configureRuntimeHttp: () => undefined,
  configureRuntimeRouteClassificationGate: () => undefined,
  installStationEnvelopeMarker: (
    await importOriginal<typeof import('../../bootstrap/runtime-http.js')>()
  ).installStationEnvelopeMarker,
  LOOPBACK_DEVICE_SESSION_COOKIE: 'station-device',
  SECURE_DEVICE_SESSION_COOKIE: '__Host-station-device',
}));

/** Callable at every depth, never thenable (see the late-binding suite). */
function deepCallable(): unknown {
  const proxy: unknown = new Proxy(() => undefined, {
    get: (_target, property) => (property === 'then' ? undefined : proxy),
    apply: () => proxy,
  });
  return proxy;
}

const READ_ONLY_CREDENTIAL = 'device-credential-read-only-scope';
const OPERATOR_CREDENTIAL = 'operator-credential-full-authority';

function scopeFor(credential: string): string | undefined {
  if (credential === OPERATOR_CREDENTIAL) return DEFAULT_GRANT_PAIRING_SCOPE;
  if (credential === READ_ONLY_CREDENTIAL)
    return pairingScopePresetString('read-only');
  return undefined;
}

const RESOLUTION: ConversationOpenResolution = {
  status: 'unavailable',
  conversation: {
    id: 'conv-1',
    source: 'runtime',
    agentSlug: agentId('codex'),
    title: 'New chat',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:01:00.000Z',
    messageCount: 0,
    mutable: false,
    answerability: { answerable: true },
  } as ConversationOpenResolution['conversation'],
  transcript: { available: false, owner: 'runtime' },
  canContinue: false,
  answerability: { answerable: true },
  recoveryActions: ['retry', 'start-new'],
};

function runtimeContext(app: Hono, homeDir: string) {
  const fallback = new Proxy(
    {
      deploymentAuthentication: undefined,
      app,
      port: 4321,
      host: '127.0.0.1',
      appConfig: {},
      configLoader: {
        getProjectHomeDir: () => homeDir,
        loadAppConfig: () => ({}),
      },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      activeAgents: new Map(),
      agentMetadataMap: new Map(),
      agentFixedTokens: new Map(),
      agentTools: new Map(),
      agentStats: new Map(),
      agentStatus: new Map(),
      memoryAdapters: new Map(),
      metricsLog: [],
      monitoringEvents: [],
      orchestrationEventStore: new Proxy(
        {
          sessionTurnBoundaryAuthority: () => ({
            reconcile: () => ({ kind: 'available', interrupted: [] }),
          }),
        },
        {
          get(target, property) {
            if (property in target) return Reflect.get(target, property);
            return deepCallable();
          },
        },
      ),
      orchestrationService: new Proxy(
        { resolveConversationOpen: vi.fn(async () => RESOLUTION) },
        {
          get(target, property) {
            if (property in target) return Reflect.get(target, property);
            return deepCallable();
          },
        },
      ),
      environmentSecurityService: new Proxy(
        {
          authorizeCredential: (candidate: string) =>
            scopeFor(candidate) !== undefined,
          resolveGrantedScope: (candidate: string) => scopeFor(candidate),
          verifyOperatorCredential: (candidate: string) =>
            candidate === OPERATOR_CREDENTIAL,
        },
        {
          get(target, property) {
            if (property in target) return Reflect.get(target, property);
            return deepCallable();
          },
        },
      ),
      taskGraphService: { listTasks: () => [] },
    },
    {
      get(target, property) {
        if (property in target) return Reflect.get(target, property);
        return deepCallable();
      },
    },
  );
  Reflect.set(fallback as object, 'buildRuntimeContext', () => fallback);
  return fallback as never;
}

describe('configureRuntimeRoutes — conversation open callerAccess wiring', () => {
  const tempDir = trackTempDirs();

  test("the open read reports each caller's access from the runtime's own security service", async () => {
    const homeDir = tempDir('station-open-access-');
    const app = new Hono();
    app.use('*', async (c, next) => {
      const credential = c.req.header('authorization')?.slice('Bearer '.length);
      if (credential)
        setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
          kind: 'credential',
          credential,
          authority: undefined,
          source: 'bearer',
          // Lets the personal-mode conversation authority resolve without
          // the real ingress. It does not change either answer below: the
          // gate consults locality only for relay-management leaves, and the
          // read-only scope cannot reach the operate-tier chat routes.
          locality: 'home-possession',
        });
      await next();
    });
    const result = configureRuntimeRoutes(runtimeContext(app, homeDir));
    await result.kitLifecycleReady;

    const read = async (credential: string) => {
      const response = await app.request(
        '/api/conversations/conv-1/open',
        { headers: { Authorization: `Bearer ${credential}` } },
        { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as never,
      );
      expect(response.status, credential).toBe(200);
      const body = (await response.json()) as {
        data: ConversationOpenResolution;
      };
      return body.data.callerAccess;
    };

    await expect(read(READ_ONLY_CREDENTIAL)).resolves.toEqual({
      continue: false,
      startChat: false,
    });
    await expect(read(OPERATOR_CREDENTIAL)).resolves.toEqual({
      continue: true,
      startChat: true,
    });
  });
});
