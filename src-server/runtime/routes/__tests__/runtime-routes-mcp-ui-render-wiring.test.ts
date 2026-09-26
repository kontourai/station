/**
 * MCP-UI per-server render permission, through the REAL composition.
 *
 * `tools.routes.test.ts` hands the route its `isRenderRevoked` and
 * `setRenderAllowed` callbacks, and `mcp-ui-permissions.test.ts` exercises the
 * store directly. Neither sees `configureRuntimeRoutes` supply them, and the
 * route ALLOWS render when `isRenderRevoked` is absent. This drives the real
 * composition: an operator revoke through the settings route must block the
 * embedded UI read, and an allow must restore it.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_GRANT_PAIRING_SCOPE } from '@kontourai/station-contracts';
import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { isMcpUiRenderRevoked } from '../../../services/plugins/mcp-ui-permissions.js';
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

const SERVER_ID = 'ui-server';
const OPERATOR_SECRET = 'operator-secret-mcp-ui-render-fixture';
const isOperator = (credential: string) => credential === OPERATOR_SECRET;
const EMBEDDED_UI = { uri: 'ui://ui-server/panel', mimeType: 'text/html' };

describe('runtime routes: MCP-UI render permission wiring', () => {
  const makeTempDir = trackTempDirs();

  test('an operator revoke blocks the embedded UI read and an allow restores it', async () => {
    const homeDir = makeTempDir('station-mcp-ui-render-wiring-');
    mkdirSync(join(homeDir, 'security'), { mode: 0o700 });
    const readMCPUIResourceFromTool = vi.fn(async () => EMBEDDED_UI);
    const app = new Hono();
    const context = deepStub({
      projectMembership: undefined,
      projectSharedTasks: undefined,
      deploymentAuthentication: undefined,
      localAccounts: undefined,
      applicationSessions: undefined,
      relayEnrollment: undefined,
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
      mcpService: deepStub({ readMCPUIResourceFromTool }),
      orchestrationEventStore: deepStub({
        sessionTurnBoundaryAuthority: () => ({
          reconcile: () => ({ kind: 'available', interrupted: [] }),
        }),
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
    Reflect.set(context as object, 'buildRuntimeContext', () => context);
    const result = configureRuntimeRoutes(
      context as unknown as Parameters<typeof configureRuntimeRoutes>[0],
    );
    await result.kitLifecycleReady;
    // The operator's credential, through the runtime authentication composed
    // here: render permission is a person's setting, not a tool's.
    const request = (path: string, init: RequestInit = {}) =>
      app.request(
        path,
        {
          ...init,
          headers: {
            ...(init.headers as Record<string, string> | undefined),
            Authorization: `Bearer ${OPERATOR_SECRET}`,
          },
        },
        { incoming: { socket: { remoteAddress: '127.0.0.1' } } },
      );
    const setAllowed = (allowRender: boolean) =>
      request(`/integrations/${SERVER_ID}/ui/permissions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowRender }),
      });
    const readEmbedded = () =>
      request(`/integrations/${SERVER_ID}/ui/panel/embedded`);

    try {
      // Default allow: the embedded UI is read from the server.
      const initial = await readEmbedded();
      expect(initial.status).toBe(200);
      expect(await initial.json()).toMatchObject({ data: EMBEDDED_UI });

      expect((await setAllowed(false)).status).toBe(200);
      expect(isMcpUiRenderRevoked(homeDir, SERVER_ID)).toBe(true);
      const revoked = await readEmbedded();
      expect(revoked.status).toBe(403);
      expect(await revoked.json()).toMatchObject({ status: 'render_revoked' });

      expect((await setAllowed(true)).status).toBe(200);
      expect(isMcpUiRenderRevoked(homeDir, SERVER_ID)).toBe(false);
      expect((await readEmbedded()).status).toBe(200);
      expect(readMCPUIResourceFromTool).toHaveBeenCalledTimes(2);
    } finally {
      await result.browserService?.shutdown();
      await result.deviceHosts?.dispose();
      await result.deviceToolchainService?.shutdown();
    }
  });
});
