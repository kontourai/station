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

/** A browser on this machine, dialling its loopback directly. */
const SAME_MACHINE = {
  incoming: { socket: { remoteAddress: '127.0.0.1' } },
} as never;
/** A phone reaching this host over the tailnet. */
const REMOTE_PHONE = {
  incoming: { socket: { remoteAddress: '100.96.12.7' } },
} as never;

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
    configLoader: {
      getProjectHomeDir: () => home,
      loadAppConfig: () => ({}),
      loadStoredAppConfig: async () => ({}),
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
    const response = await app.request(
      path,
      { headers: { Authorization: `Bearer ${operator}` } },
      SAME_MACHINE,
    );
    expect(response.status).toBe(200);
    const responseSchema = z.object({
      data: z.object({ html: z.string() }),
      frameOrigin: z.string(),
    });
    const body = responseSchema.parse(await response.json());
    expect(body.data.html).toBe('<h1>Authorized page</h1>');
    expect(body.frameOrigin).toBe(frameOrigin);
    frameOrigin = 'http://sandbox-two.test';
    const afterRestart = await app.request(
      path,
      { headers: { Authorization: `Bearer ${operator}` } },
      SAME_MACHINE,
    );
    expect(responseSchema.parse(await afterRestart.json()).frameOrigin).toBe(
      frameOrigin,
    );
    // The frame listener binds the host's loopback: a phone would dial its
    // own and be refused, so it is offered no frame origin and renders the
    // page in the opaque-origin sandbox instead.
    const remote = await app.request(
      path,
      { headers: { Authorization: `Bearer ${operator}` } },
      REMOTE_PHONE,
    );
    expect(remote.status).toBe(200);
    const remoteBody = (await remote.json()) as {
      data: { html: string };
      frameOrigin?: string;
    };
    expect(remoteBody.data.html).toBe('<h1>Authorized page</h1>');
    expect(remoteBody.frameOrigin).toBeUndefined();
    // Nor does the app config hand it one for MCP Apps, whether read
    // directly or through the boot payload.
    for (const [read, config] of [
      ['/config/app', (body: any) => body.data],
      ['/api/boot', (body: any) => body.sections.config.data.data],
    ] as const) {
      const local = config(
        await (
          await app.request(
            read,
            { headers: { Authorization: `Bearer ${operator}` } },
            SAME_MACHINE,
          )
        ).json(),
      );
      expect(local.mcpUiFrameOrigin).toBe(frameOrigin);
      const phone = config(
        await (
          await app.request(
            read,
            { headers: { Authorization: `Bearer ${operator}` } },
            REMOTE_PHONE,
          )
        ).json(),
      );
      expect(phone.mcpUiFrameOrigin).toBeUndefined();
    }
    expect(canRead).toHaveBeenCalledWith(
      'publisher',
      expect.objectContaining({ userId: LOCAL_OPERATOR_PRINCIPAL_ID }),
    );
    allow = false;
    expect(
      (
        await app.request(
          path,
          { headers: { Authorization: `Bearer ${operator}` } },
          SAME_MACHINE,
        )
      ).status,
    ).toBe(404);
  } finally {
    store.close();
  }
});
