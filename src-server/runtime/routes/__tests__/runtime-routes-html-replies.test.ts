import { join } from 'node:path';
import { DEFAULT_GRANT_PAIRING_SCOPE } from '@kontourai/station-contracts';
import { Hono } from 'hono';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { configureRuntimeRoutes } from '../runtime-routes.js';

vi.mock('../runtime-route-support.js', () => {
  const stub = new Proxy({}, { get: () => () => undefined });
  return {
    configureRuntimeSupportServices: () => ({
      schedulerService: stub,
      notificationService: stub,
      attentionProjection: stub,
      webPushService: stub,
      webPushEnabled: false,
    }),
    createRuntimeSystemRouteDeps: () => stub,
  };
});

/** Composition prerequisites only; HTTP requests still use the real auth/routes. */
function deepStub<T extends object>(overrides: T): T {
  return new Proxy(overrides, {
    get(target, property) {
      if (property in target) return Reflect.get(target, property);
      const stub: unknown = new Proxy(() => undefined, {
        get: (_target, key) => (key === 'then' ? undefined : stub),
      });
      return stub;
    },
  });
}

const makeTempDir = trackTempDirs();
test('runtime composition binds page reads to current session authority before reading persisted bytes', async () => {
  const home = makeTempDir('html-reply-runtime-auth-');
  const store = new EventStore(join(home, 'events.sqlite'));
  store.upsertSession({
    provider: 'codex',
    threadId: 'publisher',
    cwd: home,
    status: 'running',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const reference = store.htmlReplyPages().publish('publisher', 'publisher', {
    version: 1,
    html: '<h1>Authorized page</h1>',
    height: 400,
  });
  const app = new Hono();
  let allow = true;
  const canRead = vi.fn(
    (sessionId: string, authority: { userId: string }) =>
      sessionId === 'publisher' &&
      authority.userId === LOCAL_OPERATOR_PRINCIPAL_ID &&
      allow,
  );
  const operator = 'html-reply-test-operator';
  const isOperator = (credential: string) => credential === operator;
  let frameOrigin = 'http://sandbox-one.test';
  const context = deepStub({
    getMcpUiFrameOrigin: () => frameOrigin,
    projectMembership: undefined,
    projectSharedTasks: undefined,
    deploymentAuthentication: undefined,
    localAccounts: undefined,
    applicationSessions: undefined,
    app,
    port: 4321,
    appConfig: {},
    configLoader: { getProjectHomeDir: () => home, loadAppConfig: () => ({}) },
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
    orchestrationEventStore: store,
    orchestrationService: deepStub({
      resolveSessionActingPrincipal: () => undefined,
      canUserReadSession: canRead,
      firstStartedMetadataOfThread: () => undefined,
    }),
    storageAdapter: deepStub({
      getProject: () => {
        throw new Error('No project');
      },
    }),
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
    }),
  });
  Reflect.set(context, 'buildRuntimeContext', () => context);
  try {
    const runtime = configureRuntimeRoutes(
      context as unknown as Parameters<typeof configureRuntimeRoutes>[0],
    );
    await runtime.kitLifecycleReady;
    const path = `/api/html-replies/publisher/${reference.pageId}`;
    const response = await app.request(path, {
      headers: { Authorization: `Bearer ${operator}` },
    });
    expect(response.status).toBe(200);
    const responseSchema = z.object({
      data: z.object({ html: z.string() }),
      frameOrigin: z.string(),
    });
    const body = responseSchema.parse(await response.json());
    expect(body.data.html).toBe('<h1>Authorized page</h1>');
    expect(body.frameOrigin).toBe(frameOrigin);
    frameOrigin = 'http://sandbox-two.test';
    const afterRestart = await app.request(path, {
      headers: { Authorization: `Bearer ${operator}` },
    });
    expect(responseSchema.parse(await afterRestart.json()).frameOrigin).toBe(
      frameOrigin,
    );
    expect(canRead).toHaveBeenCalledWith(
      'publisher',
      expect.objectContaining({ userId: LOCAL_OPERATOR_PRINCIPAL_ID }),
    );
    allow = false;
    expect(
      (
        await app.request(path, {
          headers: { Authorization: `Bearer ${operator}` },
        })
      ).status,
    ).toBe(404);
  } finally {
    store.close();
  }
});
