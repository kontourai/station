import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import {
  parseHostedTenantRegistry,
  sessionReadAuthorityFromRequest,
  tenantExecutionContextFromRequest,
  tenantId,
} from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readStreamUntil } from '../../../__test-utils__/sse-helpers.js';
import { STATION_CONTROL_MCP_PATH } from '../../../routes/mcp/station-control-mcp-route.js';
import { assertRuntimeHttpRouteCoverage } from '../../../security/pairing-route-scopes.js';
import {
  RUNTIME_CREDENTIAL_AUTHORITY_VAR,
  type RuntimeCredentialAuthority,
} from '../../../security/runtime-request-security.js';
import { ApprovalRegistry } from '../../../services/approvals/approval-registry.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_TENANT_HEADER,
} from '../../../utils/internal-api-token.js';
import {
  buildRuntimeRouteVocabulary,
  labelRuntimeRoutePath,
} from '../../bootstrap/runtime-route-label.js';
import { withTenantExecutionContext } from '../../bootstrap/runtime-tenant-context.js';
import {
  __resetStationControlMcpTokensForTests,
  mintStationControlMcpToken,
} from '../../mcp/station-control-mcp-token.js';
import { configureRuntimeRoutes as configureRuntimeRoutesProduction } from '../runtime-routes.js';

async function configureRuntimeRoutes(
  context: Parameters<typeof configureRuntimeRoutesProduction>[0],
) {
  const result = configureRuntimeRoutesProduction(context);
  await result.kitLifecycleReady;
  return result;
}

const runtimeSupport = vi.hoisted(() => {
  const service = new Proxy({}, { get: () => () => undefined });
  return {
    notificationService: {
      list: vi.fn<() => Array<Record<string, unknown>>>(() => []),
    },
    service,
  };
});

vi.mock('../runtime-route-support.js', () => {
  return {
    configureRuntimeSupportServices: () => ({
      schedulerService: runtimeSupport.service,
      notificationService: runtimeSupport.notificationService,
      attentionProjection: runtimeSupport.service,
      webPushService: runtimeSupport.service,
      // The real support composition disables Web Push from the immutable
      // hosted registry. Model that resolved availability here so this route
      // composition test exercises the public-route wiring too.
      webPushEnabled: process.env[registryFileEnv] === undefined,
    }),
    createRuntimeSystemRouteDeps: () => runtimeSupport.service,
  };
});

// Runtime HTTP credential policy is covered by its own boundary suite. This
// composition test needs the real hosted ingress middleware but not a second
// credential harness between ingress and the route callback under test.
vi.mock('../../bootstrap/runtime-http.js', () => ({
  configureRuntimeHttp: () => undefined,
  configureRuntimeRouteClassificationGate: () => undefined,
  LOOPBACK_DEVICE_SESSION_COOKIE: 'station-device',
  SECURE_DEVICE_SESSION_COOKIE: '__Host-station-device',
}));

const registryFileEnv = 'STATION_HOSTED_TENANT_REGISTRY_FILE';

/**
 * A stand-in for an unstubbed member that is callable at EVERY depth.
 * A one-level proxy answers `deps.a.b()` but throws on `deps.a.b.c()`, so
 * adding a member to a production chain reds every fixture that never named
 * it (station#4283 did exactly that). Self-similarity makes chain depth a
 * non-event for fixtures that do not exercise the chain.
 */
function deepCallable(): unknown {
  const proxy: unknown = new Proxy(() => undefined, {
    // `then` must stay absent. A proxy that answers EVERY property is
    // THENABLE, so `await`ing an unstubbed member calls then(resolve,
    // reject), receives another proxy instead of a settled value, and hangs
    // forever — which is exactly how this shape failed CI at 4m57s against
    // the 5-minute lane budget while passing locally.
    get: (_target, property) => (property === 'then' ? undefined : proxy),
    apply: () => proxy,
  });
  return proxy;
}

function runtimeContext(
  app: Hono,
  homeDir: string,
  overrides: Record<string, unknown> = {},
) {
  const fallback = new Proxy(
    {
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
      // Route composition now starts the boot-only completed-dispatch repair.
      // This fixture owns no durable dispatches, but it must explicitly model
      // the available empty authority rather than let the generic callable
      // fallback turn `sessionTurnBoundaryAuthority()` into undefined.
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
      taskGraphService: { listTasks: () => [] },
      environmentSecurityService: {
        devicePairing: { environmentId: () => 'test-environment' },
      },
      ...overrides,
    },
    {
      get(target, property) {
        if (property in target) return Reflect.get(target, property);
        return deepCallable();
      },
    },
  );
  // The /api/runs mount reads buildRuntimeContext().orchestrationEventStore
  // eagerly at registration (attribution lane); the composition fixture must
  // answer that chain without providing real stores — the same deep-callable
  // fallback serves.
  Reflect.set(fallback as object, 'buildRuntimeContext', () => fallback);
  return fallback as never;
}

function hostedHeaders(tenantId: string): Record<string, string> {
  return {
    [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
    [INTERNAL_TENANT_HEADER]: tenantId,
  };
}

function loopbackEnv() {
  return {
    incoming: { socket: { remoteAddress: '127.0.0.1' } },
  } as never;
}

async function initialize(app: Hono, token: string) {
  return app.request(
    `${STATION_CONTROL_MCP_PATH}?token=${encodeURIComponent(token)}`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'runtime-composition-test', version: '1' },
        },
      }),
    },
    loopbackEnv(),
  );
}

describe('configureRuntimeRoutes hosted station-control MCP composition', () => {
  const directories: string[] = [];
  const originalRegistry = process.env[registryFileEnv];

  afterEach(() => {
    __resetStationControlMcpTokensForTests();
    runtimeSupport.notificationService.list.mockReset();
    runtimeSupport.notificationService.list.mockReturnValue([]);
    if (originalRegistry === undefined) delete process.env[registryFileEnv];
    else process.env[registryFileEnv] = originalRegistry;
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('runtime-enumerates every Station HTTP/SSE/MCP route against the central capability table', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'station-runtime-routes-'));
    directories.push(homeDir);
    const app = new Hono();

    await configureRuntimeRoutes(runtimeContext(app, homeDir));

    expect(() => assertRuntimeHttpRouteCoverage(app.routes)).not.toThrow();
    const vocabulary = buildRuntimeRouteVocabulary(app.routes);
    expect(labelRuntimeRoutePath('/api/notifications', vocabulary)).toBe(
      'api/notifications',
    );
    expect(labelRuntimeRoutePath('/config/app', vocabulary)).toBe('config/app');
  });

  test('bypasses only generic internal-header ingress for an immutable token-bound tenant', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'station-runtime-routes-'));
    directories.push(homeDir);
    const registryPath = join(homeDir, 'tenants.json');
    writeFileSync(
      registryPath,
      JSON.stringify({
        schemaVersion: 1,
        tenants: [{ id: 'alpha', authority: 'alpha.example.test' }],
      }),
    );
    process.env[registryFileEnv] = registryPath;

    const app = new Hono();
    await configureRuntimeRoutes(runtimeContext(app, homeDir));

    const { token: tokenOnly } = mintStationControlMcpToken(
      'token-only',
      'url-token',
    );
    const { token: unknown } = mintStationControlMcpToken(
      'unknown-tenant',
      'url-token',
      undefined,
      { tenantId: 'bravo' as any, source: 'session' },
    );
    const { token: valid } = mintStationControlMcpToken(
      'alpha-tenant',
      'url-token',
      undefined,
      { tenantId: 'alpha' as any, source: 'session' },
    );

    expect(
      (
        await app.request(
          STATION_CONTROL_MCP_PATH,
          { method: 'POST' },
          loopbackEnv(),
        )
      ).status,
    ).toBe(401);
    expect((await initialize(app, tokenOnly)).status).toBe(421);
    expect((await initialize(app, unknown)).status).toBe(421);
    const accepted = await initialize(app, valid);
    expect(accepted.status).toBe(200);
    expect(await accepted.text()).toContain('station-control');
  });

  test('does not mount setup import for a hosted operator', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'station-runtime-routes-'));
    directories.push(homeDir);
    const registryPath = join(homeDir, 'tenants.json');
    writeFileSync(
      registryPath,
      JSON.stringify({
        schemaVersion: 1,
        tenants: [{ id: 'alpha', authority: 'alpha.example.test' }],
      }),
    );
    process.env[registryFileEnv] = registryPath;
    const app = new Hono();
    app.use('*', async (c, next) => {
      (
        c as unknown as {
          set: (
            key: typeof RUNTIME_CREDENTIAL_AUTHORITY_VAR,
            value: RuntimeCredentialAuthority,
          ) => void;
        }
      ).set(RUNTIME_CREDENTIAL_AUTHORITY_VAR, 'operator-credential');
      await next();
    });
    await configureRuntimeRoutes(runtimeContext(app, homeDir));
    const response = await app.request(
      '/api/setup-imports/sources',
      {
        headers: hostedHeaders('alpha'),
      },
      loopbackEnv(),
    );
    expect(response.status).toBe(404);
  });

  test('retains personal token-only MCP behavior when the runtime has no registry', async () => {
    delete process.env[registryFileEnv];
    const homeDir = mkdtempSync(join(tmpdir(), 'station-runtime-routes-'));
    directories.push(homeDir);
    const app = new Hono();
    await configureRuntimeRoutes(
      runtimeContext(app, homeDir, {
        getLiveAppConfig: () => ({ firstRun: { status: 'completed' } }),
      }),
    );
    const { token } = mintStationControlMcpToken(
      'personal-token-only',
      'url-token',
    );

    expect((await initialize(app, token)).status).toBe(200);
  });

  test('constructs independent alpha and bravo authorities for concurrent route reads', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'station-runtime-routes-'));
    directories.push(homeDir);
    const registryPath = join(homeDir, 'tenants.json');
    writeFileSync(
      registryPath,
      JSON.stringify({
        schemaVersion: 1,
        tenants: [
          { id: 'alpha', authority: 'alpha.example.test' },
          { id: 'bravo', authority: 'bravo.example.test' },
        ],
      }),
    );
    process.env[registryFileEnv] = registryPath;

    const observed: unknown[] = [];
    let release: (() => void) | undefined;
    const bothArrived = new Promise<void>((resolve) => {
      release = resolve;
    });
    const orchestrationService = new Proxy(
      {
        listSessions: async (authority: unknown) => {
          observed.push(authority);
          if (observed.length === 2) release?.();
          await bothArrived;
          return [];
        },
      },
      {
        get: (target, property) =>
          property in target ? Reflect.get(target, property) : () => undefined,
      },
    );
    const app = new Hono();
    await configureRuntimeRoutes(
      runtimeContext(app, homeDir, { orchestrationService }),
    );

    const [alpha, bravo] = await Promise.all([
      app.request(
        '/api/orchestration/sessions',
        { headers: hostedHeaders('alpha') },
        loopbackEnv(),
      ),
      app.request(
        '/api/orchestration/sessions',
        { headers: hostedHeaders('bravo') },
        loopbackEnv(),
      ),
    ]);

    expect(alpha.status, await alpha.text()).toBe(200);
    expect(bravo.status).toBe(200);
    expect(observed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          mode: 'hosted',
          tenantExecutionContext: expect.objectContaining({
            tenantId: 'alpha',
          }),
        }),
        expect.objectContaining({
          mode: 'hosted',
          tenantExecutionContext: expect.objectContaining({
            tenantId: 'bravo',
          }),
        }),
      ]),
    );
    expect(observed[0]).not.toBe(observed[1]);
  });

  test('never resolves hosted Task-answer initial results through the personal Task graph', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'station-runtime-routes-'));
    directories.push(homeDir);
    const registryPath = join(homeDir, 'tenants.json');
    writeFileSync(
      registryPath,
      JSON.stringify({
        schemaVersion: 1,
        tenants: [
          { id: 'alpha', authority: 'alpha.example.test' },
          { id: 'bravo', authority: 'bravo.example.test' },
        ],
      }),
    );
    process.env[registryFileEnv] = registryPath;
    const taskGraphAccess = vi.fn(() => []);
    const taskGraphService = new Proxy(
      { listTasks: taskGraphAccess },
      { get: (target, property) => Reflect.get(target, property) },
    );
    const mcpService = new Proxy(
      {
        getMCPUIToolCatalog: vi.fn().mockResolvedValue({
          available: true,
          tools: [
            {
              originalName: 'get_basis',
              annotations: { readOnlyHint: true },
            },
          ],
        }),
      },
      { get: (target, property) => Reflect.get(target, property) },
    );
    const app = new Hono();
    await configureRuntimeRoutes(
      runtimeContext(app, homeDir, { mcpService, taskGraphService }),
    );
    const accessesBefore = taskGraphAccess.mock.calls.length;

    const responses = await Promise.all(
      ['alpha', 'bravo'].map((tenant) =>
        app.request(
          '/integrations/station-control/ui/get_basis/initial-result',
          {
            method: 'POST',
            headers: {
              ...hostedHeaders(tenant),
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              arguments: {
                scope: 'task-answer',
                taskId: 'personal-task',
                answerReferenceId: 'personal-answer',
              },
            }),
          },
          loopbackEnv(),
        ),
      ),
    );

    for (const response of responses) {
      expect(response.status, await response.text()).toBe(200);
    }
    expect(taskGraphAccess).toHaveBeenCalledTimes(accessesBefore);
  });

  test('uses fresh alpha/bravo authorities for canonical monitoring reads and suppresses only hosted scheduler APIs', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'station-runtime-routes-'));
    directories.push(homeDir);
    const registryPath = join(homeDir, 'tenants.json');
    writeFileSync(
      registryPath,
      JSON.stringify({
        schemaVersion: 1,
        tenants: [
          { id: 'alpha', authority: 'alpha.example.test' },
          { id: 'bravo', authority: 'bravo.example.test' },
        ],
      }),
    );
    process.env[registryFileEnv] = registryPath;

    const observedAuthorities: unknown[] = [];
    const orchestrationService = new Proxy(
      {
        canUserReadSession: (sessionId: string, authority: any) => {
          observedAuthorities.push(authority);
          return (
            sessionId ===
            `${authority.tenantExecutionContext?.tenantId}-session`
          );
        },
      },
      {
        get: (target, property) =>
          property in target ? Reflect.get(target, property) : () => undefined,
      },
    );
    const app = new Hono();
    await configureRuntimeRoutes(
      runtimeContext(app, homeDir, {
        orchestrationService,
        queryEventsFromDisk: async () => [
          { 'gen_ai.conversation.id': 'alpha-session', body: 'alpha-only' },
          { 'gen_ai.conversation.id': 'bravo-session', body: 'bravo-only' },
        ],
      }),
    );

    const [alpha, bravo] = await Promise.all([
      app.request(
        '/monitoring/events?start=2026-01-01',
        { headers: hostedHeaders('alpha') },
        loopbackEnv(),
      ),
      app.request(
        '/monitoring/events?start=2026-01-01',
        { headers: hostedHeaders('bravo') },
        loopbackEnv(),
      ),
    ]);
    const alphaBody = await alpha.json();
    const bravoBody = await bravo.json();
    expect(alphaBody).toMatchObject({
      success: true,
      data: [{ 'gen_ai.conversation.id': 'alpha-session' }],
    });
    expect(JSON.stringify(alphaBody)).not.toContain('bravo');
    expect(bravoBody).toMatchObject({
      success: true,
      data: [{ 'gen_ai.conversation.id': 'bravo-session' }],
    });
    expect(JSON.stringify(bravoBody)).not.toContain('alpha');
    expect(observedAuthorities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tenantExecutionContext: expect.objectContaining({
            tenantId: 'alpha',
          }),
        }),
        expect.objectContaining({
          tenantExecutionContext: expect.objectContaining({
            tenantId: 'bravo',
          }),
        }),
      ]),
    );
    const alphaAuthority = observedAuthorities.find(
      (authority: any) =>
        authority.tenantExecutionContext?.tenantId === 'alpha',
    );
    const bravoAuthority = observedAuthorities.find(
      (authority: any) =>
        authority.tenantExecutionContext?.tenantId === 'bravo',
    );
    expect(alphaAuthority).toBeDefined();
    expect(bravoAuthority).toBeDefined();
    expect(alphaAuthority).not.toBe(bravoAuthority);

    for (const tenant of ['alpha', 'bravo']) {
      const scheduler = await app.request(
        '/scheduler/providers',
        { headers: hostedHeaders(tenant) },
        loopbackEnv(),
      );
      expect(scheduler.status).toBe(404);
    }

    delete process.env[registryFileEnv];
    const personalApp = new Hono();
    await configureRuntimeRoutes(runtimeContext(personalApp, homeDir));
    expect((await personalApp.request('/scheduler/providers')).status).toBe(
      200,
    );
  });

  test('suppresses hosted task/workflow aliases and board intents before their local dependencies run', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'station-runtime-routes-'));
    directories.push(homeDir);
    const registryPath = join(homeDir, 'tenants.json');
    writeFileSync(
      registryPath,
      JSON.stringify({
        schemaVersion: 1,
        tenants: [
          { id: 'alpha', authority: 'alpha.example.test' },
          { id: 'bravo', authority: 'bravo.example.test' },
        ],
      }),
    );
    process.env[registryFileEnv] = registryPath;

    const app = new Hono();
    await configureRuntimeRoutes(
      runtimeContext(app, homeDir, {
        projectService: {
          getProject: () => ({ workingDirectory: homeDir }),
        },
      }),
    );

    for (const tenant of ['alpha', 'bravo']) {
      const headers = hostedHeaders(tenant);
      const [
        workItems,
        workflow,
        operatingState,
        intent,
        starterCatalog,
        starterCandidate,
        starterLaunch,
        spatialBoard,
        spatialBoardMutation,
      ] = await Promise.all([
        app.request(
          '/api/projects/project/work-items',
          { headers },
          loopbackEnv(),
        ),
        app.request(
          '/api/projects/project/workflow/tasks',
          { headers },
          loopbackEnv(),
        ),
        app.request(
          '/api/projects/project/operating-state',
          { headers },
          loopbackEnv(),
        ),
        app.request(
          '/api/projects/project/operating-state/intent',
          {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({
              intent: { id: 'task-status', kind: 'station' },
            }),
          },
          loopbackEnv(),
        ),
        app.request('/api/starter-work', { headers }, loopbackEnv()),
        app.request(
          '/api/starter-work/inspect-approval/candidate',
          { headers },
          loopbackEnv(),
        ),
        app.request(
          '/api/starter-work/launch',
          {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({
              starterId: 'start-task',
              operationId: 'hosted-must-not-run',
              task: { projectId: 'project', title: 'private task' },
            }),
          },
          loopbackEnv(),
        ),
        app.request('/api/spatial-board', { headers }, loopbackEnv()),
        app.request(
          '/api/spatial-board/undo',
          {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({ expectedRevision: 0 }),
          },
          loopbackEnv(),
        ),
      ]);

      expect(workItems.status).toBe(200);
      expect(await workItems.json()).toEqual({
        success: true,
        data: { providers: [] },
      });
      expect(workflow.status).toBe(200);
      expect(await workflow.json()).toEqual({ success: true, data: [] });
      expect(operatingState.status).toBe(404);
      expect(intent.status).toBe(404);
      expect(starterCatalog.status).toBe(404);
      expect(starterCandidate.status).toBe(404);
      expect(starterLaunch.status).toBe(404);
      expect(spatialBoard.status).toBe(404);
      expect(spatialBoardMutation.status).toBe(404);
    }
  });

  test('composes personal Session Starter continuation through the orchestration owner', async () => {
    delete process.env[registryFileEnv];
    const homeDir = mkdtempSync(join(tmpdir(), 'station-runtime-routes-'));
    directories.push(homeDir);
    const readSession = vi.fn(async (threadId: string) => ({
      session: {
        threadId,
        controlMode:
          threadId === 'external-session'
            ? 'read-only-attached'
            : 'station-owned',
      },
    }));
    const dispatchWithReceipt = vi.fn(async () => ({
      receipt: { commandId: 'command-receipt-1' },
      result: {
        threadId: 'continued-session',
        provider: 'claude',
        controlMode: 'station-owned',
        status: 'idle',
        createdAt: '2026-08-24T00:00:00.000Z',
        updatedAt: '2026-08-24T00:00:00.000Z',
      },
    }));
    const orchestrationService = new Proxy(
      { readSession, dispatchWithReceipt },
      {
        get: (target, property) =>
          property in target
            ? Reflect.get(target, property)
            : vi.fn(() => undefined),
      },
    );
    const app = new Hono();
    await configureRuntimeRoutes(
      runtimeContext(app, homeDir, {
        orchestrationService,
        getLiveAppConfig: () => ({ firstRun: { status: 'completed' } }),
      }),
    );
    const response = await app.request(
      '/api/starter-work/launch',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          starterId: 'continue-session',
          operationId: 'continue-op-1',
          sourceSessionId: 'external-session',
        }),
      },
      loopbackEnv(),
    );
    expect(response.status).toBe(201);
    expect(dispatchWithReceipt).toHaveBeenCalledWith({
      type: 'adoptSession',
      sourceThreadId: 'external-session',
      idempotencyKey: 'continue-op-1',
    });
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        state: 'continued',
        session: { threadId: 'continued-session' },
        receipt: { id: 'command-receipt-1' },
      },
    });
  });

  test('composes personal inspection candidates through their real owner modules', async () => {
    delete process.env[registryFileEnv];
    const homeDir = mkdtempSync(join(tmpdir(), 'station-runtime-routes-'));
    directories.push(homeDir);
    const app = new Hono();
    await configureRuntimeRoutes(
      runtimeContext(app, homeDir, {
        getLiveAppConfig: () => ({ firstRun: { status: 'completed' } }),
      }),
    );
    const approval = await app.request(
      '/api/starter-work/inspect-approval/candidate',
      {},
      loopbackEnv(),
    );
    const receipt = await app.request(
      '/api/starter-work/inspect-receipt/candidate',
      {},
      loopbackEnv(),
    );
    const approvalBody = await approval.json();
    expect(approval.status).toBe(200);
    expect(receipt.status).toBe(200);
    expect(approvalBody).toMatchObject({
      success: true,
      data: { starterId: 'inspect-approval', state: 'missing' },
    });
    await expect(receipt.json()).resolves.toMatchObject({
      success: true,
      // Without a personal Starter Work registry there is no receipt target
      // to inspect. `missing` is the owner result; `unavailable` would imply
      // a known target whose inspection cannot currently proceed.
      data: { starterId: 'inspect-receipt', state: 'missing' },
    });
  });

  test('admits a same-tenant hosted session-resume intent through the existing fresh-authority binder', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'station-runtime-routes-'));
    directories.push(homeDir);
    const registryPath = join(homeDir, 'tenants.json');
    writeFileSync(
      registryPath,
      JSON.stringify({
        schemaVersion: 1,
        tenants: [
          { id: 'alpha', authority: 'alpha.example.test' },
          { id: 'bravo', authority: 'bravo.example.test' },
        ],
      }),
    );
    process.env[registryFileEnv] = registryPath;

    const readSession = vi.fn(async (threadId: string, authority: any) =>
      threadId === 'alpha-session' &&
      authority.tenantExecutionContext?.tenantId === 'alpha'
        ? { session: { provider: 'station-agent', resumeCursor: 'cursor-1' } }
        : null,
    );
    const dispatch = vi.fn(async () => undefined);
    const orchestrationService = new Proxy(
      { canUserReadSession: () => true, dispatch, readSession },
      {
        get: (target, property) =>
          Reflect.get(target, property) ?? (() => undefined),
      },
    );
    const app = new Hono();
    await configureRuntimeRoutes(
      runtimeContext(app, homeDir, {
        orchestrationService,
        projectService: {
          getProject: () => ({ workingDirectory: homeDir }),
        },
      }),
    );

    const response = await app.request(
      '/api/projects/project/operating-state/intent',
      {
        method: 'POST',
        headers: {
          ...hostedHeaders('alpha'),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          consent: true,
          intent: {
            id: 'resume-alpha',
            kind: 'session resume',
            authority: { product: 'station', command: 'session resume' },
            subjectRefs: [
              { product: 'station', kind: 'session', id: 'alpha-session' },
            ],
          },
        }),
      },
      loopbackEnv(),
    );

    expect(response.status).toBe(200);
    expect(readSession).toHaveBeenCalledWith(
      'alpha-session',
      expect.objectContaining({
        mode: 'hosted',
        tenantExecutionContext: expect.objectContaining({ tenantId: 'alpha' }),
      }),
    );
    expect(dispatch).toHaveBeenCalledWith(
      {
        type: 'startSession',
        input: {
          threadId: 'alpha-session',
          provider: 'station-agent',
          resumeCursor: 'cursor-1',
        },
      },
      expect.objectContaining({
        tenantExecutionContext: expect.objectContaining({ tenantId: 'alpha' }),
      }),
    );
  });

  test('binds hosted approval events and direct resolution while Web Push stays unavailable', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'station-runtime-routes-'));
    directories.push(homeDir);
    const registryPath = join(homeDir, 'tenants.json');
    writeFileSync(
      registryPath,
      JSON.stringify({
        schemaVersion: 1,
        tenants: [
          { id: 'alpha', authority: 'alpha.example.test' },
          { id: 'bravo', authority: 'bravo.example.test' },
        ],
      }),
    );
    process.env[registryFileEnv] = registryPath;

    const eventBus = new EventBus();
    const approvalRegistry = new ApprovalRegistry(
      {
        debug() {},
        info() {},
        warn() {},
        error() {},
      },
      { eventBus },
    );
    const app = new Hono();
    await configureRuntimeRoutes(
      runtimeContext(app, homeDir, {
        eventBus,
        approvalRegistry,
        buildRuntimeContext: () => ({
          approvalRegistry,
          logger: { debug() {}, info() {}, warn() {}, error() {} },
        }),
        acpBridge: { getStatus: () => ({ connections: [] }) },
        orchestrationService: {
          canUserReadSession: (sessionId: string, authority: any) =>
            sessionId ===
            `${authority.tenantExecutionContext?.tenantId}-session`,
        },
      }),
    );

    const registry = parseHostedTenantRegistry({
      schemaVersion: 1,
      tenants: [
        { id: tenantId('alpha'), authority: 'alpha.example.test' },
        { id: tenantId('bravo'), authority: 'bravo.example.test' },
      ],
    });
    const bravoAuthority = sessionReadAuthorityFromRequest(
      'user',
      { tenantId: tenantId('bravo') },
      registry,
    );

    const events = await app.request(
      '/events',
      { headers: hostedHeaders('alpha') },
      loopbackEnv(),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const alphaPending = withTenantExecutionContext(
      tenantExecutionContextFromRequest({ tenantId: tenantId('alpha') }),
      () =>
        approvalRegistry.register('alpha-approval', {
          metadata: {
            conversationId: 'alpha-session',
            source: 'runtime',
            title: 'alpha',
          },
        }),
    );
    const alphaTimedOut = withTenantExecutionContext(
      tenantExecutionContextFromRequest({ tenantId: tenantId('alpha') }),
      () =>
        approvalRegistry.register('alpha-timeout', {
          metadata: {
            conversationId: 'alpha-session',
            source: 'runtime',
            title: 'alpha timeout',
          },
          timeoutMs: 1,
        }),
    );
    const bravoPending = approvalRegistry.register('bravo-approval', {
      authority: bravoAuthority,
      metadata: { source: 'runtime', title: 'bravo' },
    });
    const denied = await app.request(
      '/tool-approval/alpha-approval',
      {
        method: 'POST',
        headers: {
          ...hostedHeaders('bravo'),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ approved: true }),
      },
      loopbackEnv(),
    );
    expect(denied.status).toBe(404);
    expect(approvalRegistry.has('alpha-approval')).toBe(true);

    const resolved = await app.request(
      '/tool-approval/alpha-approval',
      {
        method: 'POST',
        headers: {
          ...hostedHeaders('alpha'),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ approved: true }),
      },
      loopbackEnv(),
    );
    expect(resolved.status).toBe(200);
    await expect(alphaPending).resolves.toBe(true);
    await expect(alphaTimedOut).resolves.toBe(false);
    // Resolution deletes the pending entry before emitting its lifecycle
    // event. The live SSE callback must still authorize it from immutable
    // conversation metadata through `canUserReadSession`.
    eventBus.emit(SERVER_EVENTS.CONFIG_CHANGED, { marker: 'liveness' });
    const payload = await readStreamUntil(events.body!, (text) =>
      text.includes('"marker":"liveness"'),
    );
    expect(payload).toContain('alpha-approval');
    expect(payload).toContain('"status":"approved"');
    expect(payload).toContain('alpha-timeout');
    expect(payload).toContain('"status":"expired"');
    expect(payload).not.toContain('bravo-approval');
    approvalRegistry.cancelAll();
    await expect(bravoPending).resolves.toBe(false);

    for (const path of [
      '/api/system/vapid-public-key',
      '/api/system/push-subscribe',
      '/api/system/push-unsubscribe',
    ]) {
      const response = await app.request(
        path,
        {
          method: path.endsWith('vapid-public-key') ? 'GET' : 'POST',
          headers: hostedHeaders('alpha'),
        },
        loopbackEnv(),
      );
      expect(response.status).toBe(404);
    }
  });

  test('retains personal Web Push availability when no hosted registry is configured', async () => {
    delete process.env[registryFileEnv];
    const homeDir = mkdtempSync(join(tmpdir(), 'station-runtime-routes-'));
    directories.push(homeDir);
    const app = new Hono();
    await configureRuntimeRoutes(runtimeContext(app, homeDir));

    expect((await app.request('/api/system/vapid-public-key')).status).toBe(
      200,
    );
  });

  test('filters hosted bare SSE notification content, ids, and counts through request authority', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'station-runtime-routes-'));
    directories.push(homeDir);
    const registryPath = join(homeDir, 'tenants.json');
    writeFileSync(
      registryPath,
      JSON.stringify({
        schemaVersion: 1,
        tenants: [
          { id: 'alpha', authority: 'alpha.example.test' },
          { id: 'bravo', authority: 'bravo.example.test' },
        ],
      }),
    );
    process.env[registryFileEnv] = registryPath;

    runtimeSupport.notificationService.list.mockReturnValue([
      { id: 'alpha-id', metadata: { sessionId: 'alpha-session' } },
      { id: 'bravo-id', metadata: { sessionId: 'bravo-session' } },
    ]);
    const eventBus = new EventBus();
    const app = new Hono();
    await configureRuntimeRoutes(
      runtimeContext(app, homeDir, {
        eventBus,
        acpBridge: { getStatus: () => ({ connections: [] }) },
        orchestrationService: new Proxy(
          {
            canUserReadSession: (sessionId: string, authority: any) =>
              sessionId ===
              `${authority.tenantExecutionContext?.tenantId}-session`,
          },
          { get: (target, property) => Reflect.get(target, property) },
        ),
      }),
    );

    const response = await app.request(
      '/events',
      { headers: hostedHeaders('alpha') },
      loopbackEnv(),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    eventBus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, {
      id: 'alpha-id',
      metadata: { sessionId: 'alpha-session' },
      body: 'alpha-only',
    });
    eventBus.emit(SERVER_EVENTS.NOTIFICATION_UPDATED, { id: 'bravo-id' });
    eventBus.emit(SERVER_EVENTS.NOTIFICATION_CLEARED, { clearedCount: 2 });
    eventBus.emit(SERVER_EVENTS.CONFIG_CHANGED, { marker: 'liveness' });
    const payload = await readStreamUntil(response.body!, (text) =>
      text.includes('"marker":"liveness"'),
    );

    expect(payload).toContain('alpha-id');
    expect(payload).toContain('alpha-only');
    expect(payload).not.toContain('bravo-id');
    expect(payload).not.toContain('clearedCount');
  });
});
