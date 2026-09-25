/**
 * Station #90 lane D (station #122): a station-control tool learns its VERIFIED
 * caller, and a REST call it makes lets Station recover the same caller.
 *
 * Everything here runs through a real listening server: the production
 * runtime security boundary (`configureRuntimeHttp`), the production MCP
 * route, and the production caller route. The only substitute is the MCP
 * server factory, which registers one probe tool in place of the real
 * registrations, because no shipped tool reads the caller yet.
 */
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { McpServer } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { z } from 'zod';
import { configureRuntimeHttp } from '../../../runtime/bootstrap/runtime-http.js';
import {
  createAgentDispatchActorResolver,
  createStationControlCallerRecordResolver,
  isAgentOriginatedRequest,
  resolveStationControlCallerForRequest,
  stationControlCallerRecordSources,
} from '../../../runtime/mcp/station-control-caller.js';
import { claudeInProcessStationControlOptions } from '../../../runtime/mcp/station-control-in-process.js';
import {
  __resetStationControlMcpTokensForTests,
  DEFAULT_TTL_MS,
  mintStationControlMcpToken,
  mintStationControlStdioCallerToken,
  revokeStationControlMcpToken,
} from '../../../runtime/mcp/station-control-mcp-token.js';
import {
  createWorkspacePaneHostActorFor,
  executeWorkspacePaneHostAction,
} from '../../../runtime/routes/workspace-pane-host-actions.js';
import { isFullAccessGrant } from '../../../security/coding-authority.js';
import { resolveClientOriginForRequest } from '../../../security/runtime-request-security.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { SessionAuthorization } from '../../../services/orchestration/session-authorization.js';
import type { WorkspacePaneHostActionActor } from '../../../services/plugins/workspace-pane-host-actions.js';
import {
  __resetStationControlStdioCallerCredentialForTests,
  api,
  getStationControlCaller,
  installStationControlStdioCallerCredential,
  jsonToolResult,
  requireStationControlCaller,
  STATION_CONTROL_CALLER_PATH,
  STATION_CONTROL_CALLER_TOKEN_ENV,
  STATION_CONTROL_CALLER_TOKEN_HEADER,
  StationControlCallerRequiredError,
} from '../../../tools/station-control-shared.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_PROXY_CALLER_HEADER,
} from '../../../utils/internal-api-token.js';
import type { Logger } from '../../../utils/logger.js';
import { createOrchestrationRoutes } from '../../orchestration/orchestration.js';
import { createWorkspacePaneHostActionRoutes } from '../../orchestration/workspace-pane-host-actions.js';
import { createStationControlCallerRoutes } from '../station-control-caller-route.js';
import {
  createStationControlMcpRoutes,
  STATION_CONTROL_MCP_PATH,
} from '../station-control-mcp-route.js';

// S3: the Pane host bridge's one effect, recorded; the rest of the
// delegation module stays real.
const paneHostExecutions = vi.hoisted(() => [] as unknown[]);
vi.mock('../../../tools/station-control-delegation.js', async (original) => ({
  ...(await original<object>()),
  executeExecutionTargetMessage: async (input: unknown) => {
    paneHostExecutions.push(input);
    return {
      conversationId: 'pane-conversation',
      sessionId: 'pane-session',
      providerTurnId: 'pane-turn',
    };
  },
}));

const OPERATOR_CREDENTIAL = 'test-only-operator-credential-caller-suite';
const DELEGATION_BODY = {
  prompt: 'child work',
  target: { environment: { kind: 'current' }, agent: 'planner' },
  userId: 'human:test:mallory',
};
const continueDelegatedTask = vi.fn(async () => ({
  taskId: 'task:1',
  sessionId: 'task:1',
  status: 'dispatched',
  resumable: true,
}));
// `/commands` reaches the service's dispatch seam; record its context.
const dispatchWithReceipt = vi.fn(async () => ({
  receipt: { commandId: 'command-1' },
  result: { threadId: 'commands-child', status: 'ready' },
}));
const orchestrationServiceFake = {
  dispatchWithReceipt,
  canUserReadSession: () => true,
};
const delegateTask = vi.fn(async () => ({
  taskId: 'task:1',
  sessionId: 'task:1',
  status: 'dispatched',
  resumable: true,
}));
const ORIGIN_PROBE_PATH =
  '/api/orchestration/station-control/test-origin-probe';

// The principal mapping is the production one: a real SessionAuthorization
// over a fake ownership store, configured as a personal host is.
const OWNERS: Record<string, string | undefined> = {
  'session-a': 'human:test:alice',
  'session-b': 'human:test:bob',
  'session-c': undefined,
  // A row whose recorded owner is an OS display alias rather than a
  // principal id: it names only itself, never the local operator.
  'session-d': 'released-os-alias',
};
const sessionAuthorization = new SessionAuthorization({
  eventStore: {
    findSessionOwnerAttribution: (threadId: string) => ({
      ...(OWNERS[threadId] ? { ownerUserId: OWNERS[threadId] } : {}),
      unattributedAgent: false,
    }),
  } as never,
  ownerlessSessionAccess: 'single-user-compat',
});
// Session start metadata and projects as the production sources read them;
// the resolver is the production composition over those sources.
const STARTED: Record<string, Record<string, unknown>> = {
  // Stamped at start (`session-record`); session-b predates the stamp.
  'session-a': { projectSlug: 'project-a', localProjectId: 'local-project-a' },
  'session-b': { delegation: { projectSlug: 'project-b' }, projectSlug: 'x' },
};
const PROJECT_IDS: Record<string, string> = {
  'project-a': 'local-project-a',
  'project-b': 'local-project-b',
};
const CONVERSATIONS: Record<string, string> = {
  'session-a': 'conversation-a',
  'session-b': 'conversation-b',
};
const productionResolver = createStationControlCallerRecordResolver(
  stationControlCallerRecordSources({
    orchestrationService: {
      resolveSessionActingPrincipal: (threadId) =>
        sessionAuthorization.sessionActingPrincipal(threadId),
      firstStartedMetadataOfThread: (threadId) => STARTED[threadId],
    },
    eventStore: {
      conversationForSession: (sessionId) =>
        CONVERSATIONS[sessionId]
          ? { conversationId: CONVERSATIONS[sessionId] }
          : undefined,
    },
    getProject: (slug) => {
      const id = PROJECT_IDS[slug];
      if (!id) throw new Error(`no project ${slug}`);
      return { id };
    },
  }),
);
const resolveRecord = vi.fn((sessionId: string) =>
  productionResolver(sessionId),
);
// A Codex-style url-token caller: its credential sits in engine argv.
const SESSION_A = {
  sessionId: 'session-a',
  assurance: 'bearer-exposed',
  principal: {
    id: 'human:test:alice',
    source: 'session-owner',
    elevationEligible: true,
  },
  localProjectId: 'local-project-a',
  projectIdSource: 'session-record',
  projectSlug: 'project-a',
  conversationId: 'conversation-a',
};

function createProbeServer(): McpServer {
  const server = new McpServer({ name: 'caller-probe', version: '0.0.0' });
  server.registerTool(
    'probe_caller',
    {
      description: 'Reports the verified caller as the tool and REST see it.',
      inputSchema: z.object({
        // A caller-shaped argument the tool must never treat as authority.
        sessionId: z.string().optional(),
        userId: z.string().optional(),
        principal: z.string().optional(),
        revokeSessionFirst: z.string().optional(),
        delegate: z.boolean().optional(),
        continueTask: z.boolean().optional(),
      }),
    },
    async (args) => {
      if (args.continueTask) {
        const continued = await api(
          '/api/orchestration/delegations/task:1/continue',
          { method: 'POST', body: JSON.stringify({ message: 'follow up' }) },
        );
        return jsonToolResult({ continued });
      }
      if (args.delegate) {
        // An agent-started child session, through the REAL dispatch route.
        const delegated = await api('/api/orchestration/delegations', {
          method: 'POST',
          body: JSON.stringify(DELEGATION_BODY),
        });
        return jsonToolResult({ delegated });
      }
      if (args.revokeSessionFirst)
        revokeStationControlMcpToken(args.revokeSessionFirst);
      const inProcess = await getStationControlCaller();
      // Identity-shaped headers a tool (or an agent steering one) could add.
      const rest = await api(STATION_CONTROL_CALLER_PATH, {
        headers: {
          'x-user-id': 'human:test:mallory',
          'x-station-principal': 'human:test:mallory',
          'x-station-session-id': 'session-b',
        },
      });
      const origin = await api(ORIGIN_PROBE_PATH);
      let required: unknown;
      try {
        required = await requireStationControlCaller();
      } catch (error) {
        required = {
          name: (error as Error).name,
          code: (error as StationControlCallerRequiredError).code,
        };
      }
      return jsonToolResult({
        argumentSessionId: args.sessionId ?? null,
        inProcess,
        rest: rest.caller,
        origin,
        required,
      });
    },
  );
  return server;
}

let server: ReturnType<typeof serve>;
let baseUrl: string;

beforeAll(async () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
    setLevel: vi.fn(),
    getLevel: vi.fn(() => 'info' as const),
  } as unknown as Logger;
  const app = new Hono();
  configureRuntimeHttp({
    app: app as never,
    logger,
    eventBus: { emit: vi.fn() } as unknown as EventBus,
    security: {
      verifyCredential: (candidate: string) =>
        candidate === OPERATOR_CREDENTIAL,
      resolveGrantedScope: () => 'orchestration:read orchestration:operate',
      resolveCredentialAuthority: () => 'operator-credential',
      now: () => Date.now(),
      maxFailures: 100,
      windowMs: 60_000,
      audit: () => {},
      allowedOrigins: [],
    },
  } as Parameters<typeof configureRuntimeHttp>[0]);
  let resolvePort!: (port: number) => void;
  const listening = new Promise<number>((resolve) => {
    resolvePort = resolve;
  });
  server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, (info) =>
    resolvePort((info as AddressInfo).port),
  );
  const port = await listening;
  baseUrl = `http://127.0.0.1:${port}`;
  app.route(
    '',
    createStationControlMcpRoutes({
      port,
      resolveCallerRecord: resolveRecord,
      createServer: createProbeServer,
    }),
  );
  app.route(
    '/api/orchestration',
    createStationControlCallerRoutes({ resolveRecord }),
  );
  // The REAL orchestration dispatch routes with the production agent
  // dispatch resolver; `delegateTask` records what the child would be
  // stamped with.
  app.route(
    '/api/orchestration',
    createOrchestrationRoutes(
      orchestrationServiceFake as never,
      {
        eventBus: new EventBus(),
        logger: {
          debug: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          info: vi.fn(),
        },
        getUserId: () => LOCAL_OPERATOR_PRINCIPAL_ID,
        delegateTask,
        continueDelegatedTask,
        resolveAgentDispatchActor:
          createAgentDispatchActorResolver(resolveRecord),
      } as never,
    ),
  );
  // The REAL Pane host route and actor factory; only the ticket/admission
  // service is a stand-in that hands the actor to the real runtime bridge.
  app.route(
    '/api/orchestration/pane-host',
    createWorkspacePaneHostActionRoutes({
      service: {
        execute: async (actor: WorkspacePaneHostActionActor) => ({
          state: 'accepted',
          ...(await executeWorkspacePaneHostAction({} as never, actor, {
            agentId: 'planner',
            message: 'pane action',
            project: { slug: 'project-a' },
          } as never)),
        }),
      } as never,
      actorFor: createWorkspacePaneHostActorFor({
        resolvePrincipal: () =>
          ({
            id: LOCAL_OPERATOR_PRINCIPAL_ID,
            kind: 'human',
            display: 'Operator',
          }) as never,
        readAuthorityFor: () => ({}) as never,
        resolveClientOrigin: (request) =>
          resolveClientOriginForRequest(request),
        isRequestPrincipalCurrent: () => true,
        resolveAgentDispatchActor:
          createAgentDispatchActorResolver(resolveRecord),
        fullAccessGrantFor: () => null,
      }),
    }),
  );
  // Test-only probe route: what a route using the helpers sees.
  app.get(ORIGIN_PROBE_PATH, (c) =>
    c.json({
      agentOriginated: isAgentOriginatedRequest(c.req.raw),
      caller: resolveStationControlCallerForRequest(c.req.raw, resolveRecord),
    }),
  );
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.STATION_API_BASE;
  delete process.env.STATION_PORT;
});

beforeEach(() => {
  __resetStationControlMcpTokensForTests();
  __resetStationControlStdioCallerCredentialForTests();
  resolveRecord.mockClear();
  delegateTask.mockClear();
  continueDelegatedTask.mockClear();
  dispatchWithReceipt.mockClear();
  paneHostExecutions.length = 0;
});

async function readJsonRpc(response: Response): Promise<any> {
  const text = await response.text();
  if ((response.headers.get('content-type') ?? '').includes('application/json'))
    return JSON.parse(text);
  const dataLine = text.split('\n').find((line) => line.startsWith('data: '));
  if (!dataLine) throw new Error(`No SSE data line: ${text}`);
  return JSON.parse(dataLine.slice('data: '.length));
}

async function mcp(token: string, id: number, method: string, params = {}) {
  const response = await fetch(
    `${baseUrl}${STATION_CONTROL_MCP_PATH}?token=${encodeURIComponent(token)}`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    },
  );
  return response;
}

async function probe(token: string, args: Record<string, unknown> = {}) {
  const init = await mcp(token, 1, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  });
  expect(init.status).toBe(200);
  await init.text();
  const response = await mcp(token, 2, 'tools/call', {
    name: 'probe_caller',
    arguments: args,
  });
  expect(response.status).toBe(200);
  const result = await readJsonRpc(response);
  return JSON.parse(result.result.content[0].text);
}

async function callerRoute(
  headers: Record<string, string>,
  expectedStatus = 200,
) {
  const response = await fetch(`${baseUrl}${STATION_CONTROL_CALLER_PATH}`, {
    headers,
  });
  expect(response.status).toBe(expectedStatus);
  return (await response.json()) as { caller: unknown };
}

const internalHeaders = () => ({
  [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
  [INTERNAL_PROXY_CALLER_HEADER]: 'local',
});

describe('station-control verified caller (HTTP MCP)', () => {
  test('an HTTP-MCP tool call observes the verified caller, and a REST call made from inside it observes the same caller; forged sessionId/userId/principal arguments and identity headers are ignored', async () => {
    const { token } = mintStationControlMcpToken('session-a', 'url-token');

    const observed = await probe(token, {
      sessionId: 'session-b',
      userId: 'human:test:mallory',
      principal: LOCAL_OPERATOR_PRINCIPAL_ID,
    });

    // The argument arrived and was not used.
    expect(observed.argumentSessionId).toBe('session-b');
    expect(observed.inProcess).toEqual(SESSION_A);
    expect(observed.rest).toEqual(SESSION_A);
    expect(observed.required).toEqual(SESSION_A);
    // A route can tell this is an agent's tool call, and whose.
    expect(observed.origin).toEqual({
      agentOriginated: true,
      caller: SESSION_A,
    });
    // Everything came from the server record for the TOKEN's session.
    expect(resolveRecord).toHaveBeenCalledWith('session-a');
    expect(resolveRecord).not.toHaveBeenCalledWith('session-b');
  });

  test('a token revoked during the tool call yields no caller in-process or over REST, and requireStationControlCaller fails closed with a typed error', async () => {
    const { token } = mintStationControlMcpToken('session-a', 'url-token');

    const observed = await probe(token, { revokeSessionFirst: 'session-a' });

    expect(observed.inProcess).toBeNull();
    expect(observed.rest).toBeNull();
    expect(observed.required).toEqual({
      name: 'StationControlCallerRequiredError',
      code: 'station_control_caller_required',
    });
  });

  test('the MCP route refuses stdio-env and in-process tokens: neither channel ever dials it', async () => {
    const stdio = mintStationControlStdioCallerToken('session-a');
    expect((await mcp(stdio, 1, 'initialize')).status).toBe(401);
    const inProcess = mintStationControlMcpToken('session-b', 'sdk-in-process');
    expect((await mcp(inProcess.token, 1, 'initialize')).status).toBe(401);
  });

  test('a revoked or expired token is refused at the MCP route', async () => {
    const { token } = mintStationControlMcpToken('session-a', 'url-token');
    revokeStationControlMcpToken('session-a');
    const revoked = await mcp(token, 1, 'initialize');
    expect(revoked.status).toBe(401);

    const expired = mintStationControlMcpToken('session-b', 'url-token', 0);
    const expiredResponse = await mcp(expired.token, 1, 'initialize');
    expect(expiredResponse.status).toBe(401);
  });
});

describe('station-control verified caller (REST side)', () => {
  test('Station internal caller + live token resolves the caller (control for the forged cases)', async () => {
    const { token } = mintStationControlMcpToken('session-a', 'url-token');
    const response = await callerRoute({
      ...internalHeaders(),
      [STATION_CONTROL_CALLER_TOKEN_HEADER]: token,
    });
    expect(response.caller).toEqual(SESSION_A);
  });

  test('the principal comes from the session ownership record: forged identity headers are ignored, an alias-owned row names only its alias, and an ownerless personal session maps to the local operator with its derivation named', async () => {
    const a = mintStationControlMcpToken('session-a', 'url-token');
    const forged = await callerRoute({
      ...internalHeaders(),
      'x-user-id': LOCAL_OPERATOR_PRINCIPAL_ID,
      'x-station-principal': LOCAL_OPERATOR_PRINCIPAL_ID,
      [STATION_CONTROL_CALLER_TOKEN_HEADER]: a.token,
    });
    expect(forged.caller).toEqual(SESSION_A);

    const b = mintStationControlMcpToken('session-b', 'url-token');
    const recorded = await callerRoute({
      ...internalHeaders(),
      [STATION_CONTROL_CALLER_TOKEN_HEADER]: b.token,
    });
    expect(recorded.caller).toMatchObject({
      sessionId: 'session-b',
      principal: {
        id: 'human:test:bob',
        source: 'session-owner',
        elevationEligible: true,
      },
      // The delegation-scoped slug wins over the plain one.
      localProjectId: 'local-project-b',
      projectIdSource: 'slug-lookup',
      projectSlug: 'project-b',
    });

    // No alias-to-operator bridge: the alias is the recorded owner, and it
    // is not the local operator.
    const d = mintStationControlMcpToken('session-d', 'url-token');
    const aliasOwned = await callerRoute({
      ...internalHeaders(),
      [STATION_CONTROL_CALLER_TOKEN_HEADER]: d.token,
    });
    expect(aliasOwned.caller).toMatchObject({
      principal: {
        id: 'released-os-alias',
        source: 'session-owner',
        elevationEligible: true,
      },
    });

    const c = mintStationControlMcpToken('session-c', 'url-token');
    const ownerless = await callerRoute({
      ...internalHeaders(),
      [STATION_CONTROL_CALLER_TOKEN_HEADER]: c.token,
    });
    expect(ownerless.caller).toEqual({
      sessionId: 'session-c',
      assurance: 'bearer-exposed',
      // Names the operator by inference only: never eligible to elevate.
      principal: {
        id: LOCAL_OPERATOR_PRINCIPAL_ID,
        source: 'ownerless-single-operator',
        elevationEligible: false,
      },
    });
  });

  test('a forged caller-token header yields no caller', async () => {
    mintStationControlMcpToken('session-a', 'url-token');
    const response = await callerRoute({
      ...internalHeaders(),
      [STATION_CONTROL_CALLER_TOKEN_HEADER]: 'session-a',
    });
    expect(response.caller).toBeNull();
  });

  test('the caller route is internal-only: an operator bearer gets 404 even with a live token, and resolveStationControlCallerForRequest yields no caller for it', async () => {
    const { token } = mintStationControlMcpToken('session-a', 'url-token');
    const response = await callerRoute(
      {
        authorization: `Bearer ${OPERATOR_CREDENTIAL}`,
        [STATION_CONTROL_CALLER_TOKEN_HEADER]: token,
      },
      404,
    );
    expect(response.caller).toBeUndefined();
    // The helper itself refuses the same request (probe route has no gate).
    const probed = await fetch(`${baseUrl}${ORIGIN_PROBE_PATH}`, {
      headers: {
        authorization: `Bearer ${OPERATOR_CREDENTIAL}`,
        [STATION_CONTROL_CALLER_TOKEN_HEADER]: token,
      },
    });
    expect(((await probed.json()) as { caller: unknown }).caller).toBeNull();
  });

  test('a tenant-bound token resolves only with its own tenant header, and the public caller never carries the tenant', async () => {
    const { token } = mintStationControlMcpToken(
      'session-a',
      'url-token',
      undefined,
      { tenantId: 'alpha' as never, source: 'request' },
    );
    const matching = await callerRoute({
      ...internalHeaders(),
      'x-station-internal-tenant': 'alpha',
      [STATION_CONTROL_CALLER_TOKEN_HEADER]: token,
    });
    expect(matching.caller).toEqual(SESSION_A);
    expect(matching.caller).not.toHaveProperty('tenant');
    const missing = await callerRoute({
      ...internalHeaders(),
      [STATION_CONTROL_CALLER_TOKEN_HEADER]: token,
    });
    expect(missing.caller).toBeNull();
    const wrong = await callerRoute({
      ...internalHeaders(),
      'x-station-internal-tenant': 'bravo',
      [STATION_CONTROL_CALLER_TOKEN_HEADER]: token,
    });
    expect(wrong.caller).toBeNull();
  });

  test('a record resolver that throws yields no caller rather than a caller missing its project', async () => {
    const { token } = mintStationControlMcpToken('session-a', 'url-token');
    resolveRecord.mockImplementationOnce(() => {
      throw new Error('store unavailable');
    });
    const response = await callerRoute({
      ...internalHeaders(),
      [STATION_CONTROL_CALLER_TOKEN_HEADER]: token,
    });
    expect(response.caller).toBeNull();
  });

  test('assurance comes from the mint channel: header and in-process tokens are bound, url and stdio tokens are bearer-exposed', async () => {
    const cases = [
      ['http-header-token', 'delegated-custody'],
      ['sdk-in-process', 'bound'],
      ['url-token', 'bearer-exposed'],
      ['stdio-env-token', 'bearer-exposed'],
    ] as const;
    for (const [channel, assurance] of cases) {
      const { token } = mintStationControlMcpToken('session-a', channel);
      const response = await callerRoute({
        ...internalHeaders(),
        [STATION_CONTROL_CALLER_TOKEN_HEADER]: token,
      });
      expect(response.caller, channel).toMatchObject({ assurance });
    }
  });

  test('a tenant header that disagrees with the token tenant yields no caller', async () => {
    const { token } = mintStationControlMcpToken('session-a', 'url-token');
    const response = await callerRoute({
      ...internalHeaders(),
      'x-station-internal-tenant': 'alpha',
      [STATION_CONTROL_CALLER_TOKEN_HEADER]: token,
    });
    expect(response.caller).toBeNull();
  });

  test('a revoked or expired token yields no caller', async () => {
    const { token } = mintStationControlMcpToken('session-a', 'url-token');
    revokeStationControlMcpToken('session-a');
    const revoked = await callerRoute({
      ...internalHeaders(),
      [STATION_CONTROL_CALLER_TOKEN_HEADER]: token,
    });
    expect(revoked.caller).toBeNull();

    const expired = mintStationControlMcpToken('session-b', 'url-token', 0);
    const expiredResponse = await callerRoute({
      ...internalHeaders(),
      [STATION_CONTROL_CALLER_TOKEN_HEADER]: expired.token,
    });
    expect(expiredResponse.caller).toBeNull();
  });
});

describe('station-control verified caller (stdio child path)', () => {
  test('a stdio child holding its spawn-env credential resolves its caller through the REST projection, and the credential leaves process.env', async () => {
    // Runs the exact module code a stdio child runs: no AsyncLocalStorage
    // context, credential installed from the spawn env.
    process.env.STATION_API_BASE = baseUrl;
    const token = mintStationControlStdioCallerToken('session-b');
    const env: NodeJS.ProcessEnv = {
      [STATION_CONTROL_CALLER_TOKEN_ENV]: token,
    };
    installStationControlStdioCallerCredential(env);
    expect(env[STATION_CONTROL_CALLER_TOKEN_ENV]).toBeUndefined();

    await expect(requireStationControlCaller()).resolves.toEqual({
      sessionId: 'session-b',
      assurance: 'bearer-exposed',
      principal: {
        id: 'human:test:bob',
        source: 'session-owner',
        elevationEligible: true,
      },
      localProjectId: 'local-project-b',
      projectIdSource: 'slug-lookup',
      projectSlug: 'project-b',
      conversationId: 'conversation-b',
    });

    revokeStationControlMcpToken('session-b');
    await expect(getStationControlCaller()).resolves.toBeNull();
  });

  test('a stdio child with no credential (a pooled child) has no caller and fails closed', async () => {
    process.env.STATION_API_BASE = baseUrl;
    installStationControlStdioCallerCredential({});
    await expect(getStationControlCaller()).resolves.toBeNull();
    await expect(requireStationControlCaller()).rejects.toBeInstanceOf(
      StationControlCallerRequiredError,
    );
  });

  test('a pooled child (no credential) is still agent-originated, with no caller', async () => {
    process.env.STATION_API_BASE = baseUrl;
    installStationControlStdioCallerCredential({});
    expect(await api(ORIGIN_PROBE_PATH)).toEqual({
      agentOriginated: true,
      caller: null,
    });
  });
});

describe('isAgentOriginatedRequest', () => {
  async function origin(headers: Record<string, string>) {
    const response = await fetch(`${baseUrl}${ORIGIN_PROBE_PATH}`, {
      headers,
    });
    expect(response.status).toBe(200);
    return response.json();
  }

  test("the operator's own internal client (no marker, no credential) is not agent-originated", async () => {
    expect(await origin(internalHeaders())).toEqual({
      agentOriginated: false,
      caller: null,
    });
  });

  test('a forged caller credential still reads as agent-originated (restrictive) but names no caller', async () => {
    expect(
      await origin({
        ...internalHeaders(),
        [STATION_CONTROL_CALLER_TOKEN_HEADER]: 'forged',
      }),
    ).toEqual({ agentOriginated: true, caller: null });
  });
});

describe('stdio caller token lifetime', () => {
  test('the stdio token stops resolving once its TTL has elapsed', async () => {
    process.env.STATION_API_BASE = baseUrl;
    const minted = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(minted);
    try {
      const token = mintStationControlStdioCallerToken('session-a');
      installStationControlStdioCallerCredential({
        [STATION_CONTROL_CALLER_TOKEN_ENV]: token,
      });
      now.mockReturnValue(minted + DEFAULT_TTL_MS - 1);
      await expect(getStationControlCaller()).resolves.toMatchObject({
        sessionId: 'session-a',
      });
      now.mockReturnValue(minted + DEFAULT_TTL_MS);
      await expect(getStationControlCaller()).resolves.toBeNull();
    } finally {
      now.mockRestore();
    }
  });
});

/**
 * The Claude Agent SDK's side of an in-process (`type: 'sdk'`) server: it
 * calls `instance.connect(transport)` and then feeds messages into
 * `transport.onmessage` from its own control-pipe reader, outside any
 * Station async context. This fake does exactly that.
 */
function sdkSideTransport() {
  const sent: any[] = [];
  const transport: any = {
    start: async () => {},
    close: async () => {},
    send: async (message: unknown) => {
      sent.push(message);
    },
  };
  const waitFor = async (id: number) => {
    for (let i = 0; i < 200; i += 1) {
      const found = sent.find((m) => m.id === id);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`no response for ${id}`);
  };
  const request = async (id: number, method: string, params = {}) => {
    // Detached from the test's own async context, as the SDK's reader is.
    setImmediate(() =>
      transport.onmessage({ jsonrpc: '2.0', id, method, params }),
    );
    return waitFor(id);
  };
  return { transport, request };
}

describe('station-control verified caller (in-process Claude delivery)', () => {
  test('a tool served in-process sees a bound caller for its session, the REST call it makes sees the same, and revoking the session removes both', async () => {
    process.env.STATION_API_BASE = baseUrl;
    const options = claudeInProcessStationControlOptions(
      () => resolveRecord,
      createProbeServer,
    );
    const instance = options.createInProcessStationControl('session-a');
    const { transport, request } = sdkSideTransport();
    await instance.connect(transport);

    const init = await request(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'claude-code', version: '2' },
    });
    expect(init.result.protocolVersion).toBe('2025-06-18');
    const call = await request(2, 'tools/call', {
      name: 'probe_caller',
      arguments: { sessionId: 'session-b' },
    });
    const observed = JSON.parse(call.result.content[0].text);
    const bound = { ...SESSION_A, assurance: 'bound' };
    expect(observed.inProcess).toEqual(bound);
    expect(observed.rest).toEqual(bound);

    options.revokeStationControlCallerToken('session-a');
    const after = await request(3, 'tools/call', {
      name: 'probe_caller',
      arguments: {},
    });
    const revoked = JSON.parse(after.result.content[0].text);
    expect(revoked.inProcess).toBeNull();
    expect(revoked.rest).toBeNull();
  });

  test('#90 D14: the station-browser server shares the session credential with station-control; revoking the session removes both', async () => {
    process.env.STATION_API_BASE = baseUrl;
    const options = claudeInProcessStationControlOptions(
      () => resolveRecord,
      createProbeServer,
      createProbeServer,
    );
    const control = sdkSideTransport();
    const browser = sdkSideTransport();
    await options
      .createInProcessStationControl('session-a')
      .connect(control.transport);
    // Created second, as the Claude adapter does: it must not replace (and
    // so revoke) the credential station-control already holds.
    await options
      .createInProcessStationBrowser('session-a')
      .connect(browser.transport);
    const bound = { ...SESSION_A, assurance: 'bound' };
    for (const side of [control, browser]) {
      await side.request(1, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'claude-code', version: '2' },
      });
      const call = await side.request(2, 'tools/call', {
        name: 'probe_caller',
        arguments: {},
      });
      const observed = JSON.parse(call.result.content[0].text);
      expect(observed.inProcess).toEqual(bound);
      expect(observed.rest).toEqual(bound);
    }
    options.revokeStationControlCallerToken('session-a');
    for (const side of [control, browser]) {
      const after = await side.request(3, 'tools/call', {
        name: 'probe_caller',
        arguments: {},
      });
      expect(JSON.parse(after.result.content[0].text).inProcess).toBeNull();
    }
    // A later session start mints afresh: nothing revoked is reused.
    const again = sdkSideTransport();
    await options
      .createInProcessStationBrowser('session-a')
      .connect(again.transport);
    await again.request(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'claude-code', version: '2' },
    });
    const renewed = await again.request(2, 'tools/call', {
      name: 'probe_caller',
      arguments: {},
    });
    expect(JSON.parse(renewed.result.content[0].text).inProcess).toEqual(bound);
    options.revokeStationControlCallerToken('session-a');
  });

  test('#90 D14: the real station-browser server serves the browser tools and nothing else', async () => {
    const options = claudeInProcessStationControlOptions(() => resolveRecord);
    const side = sdkSideTransport();
    await options
      .createInProcessStationBrowser('session-a')
      .connect(side.transport);
    await side.request(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'claude-code', version: '2' },
    });
    const listed = await side.request(2, 'tools/list', {});
    const names = (listed.result.tools as Array<{ name: string }>)
      .map((tool) => tool.name)
      .sort();
    expect(names).toEqual([
      'browser_click',
      'browser_evaluate',
      'browser_navigate',
      'browser_open',
      'browser_press',
      'browser_resize',
      'browser_scroll',
      'browser_snapshot',
      'browser_status',
      'browser_type',
      'browser_wait_for',
    ]);
    options.revokeStationControlCallerToken('session-a');
  });

  test('two in-process sessions with interleaved tool calls each see only their own caller, in-process and over REST', async () => {
    process.env.STATION_API_BASE = baseUrl;
    const options = claudeInProcessStationControlOptions(
      () => resolveRecord,
      createProbeServer,
    );
    const a = sdkSideTransport();
    const b = sdkSideTransport();
    await options
      .createInProcessStationControl('session-a')
      .connect(a.transport);
    await options
      .createInProcessStationControl('session-b')
      .connect(b.transport);
    const init = {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'claude-code', version: '2' },
    };
    await Promise.all([
      a.request(1, 'initialize', init),
      b.request(1, 'initialize', init),
    ]);
    // Fired together: each tool awaits its own REST round trip, so the two
    // callbacks interleave on the event loop.
    const calls = await Promise.all(
      [a, b, a, b].map((side, index) =>
        side.request(10 + index, 'tools/call', {
          name: 'probe_caller',
          arguments: {},
        }),
      ),
    );
    const seen = calls.map((call) => JSON.parse(call.result.content[0].text));
    for (const [index, expected] of [
      'session-a',
      'session-b',
      'session-a',
      'session-b',
    ].entries()) {
      expect(seen[index].inProcess.sessionId, `call ${index}`).toBe(expected);
      expect(seen[index].rest.sessionId, `call ${index}`).toBe(expected);
    }
  });

  test('the production in-process server serves the real station-control registrations over the CLI legacy protocol', async () => {
    const options = claudeInProcessStationControlOptions(() => resolveRecord);
    const instance = options.createInProcessStationControl('session-c');
    const { transport, request } = sdkSideTransport();
    await instance.connect(transport);
    await request(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'claude-code', version: '2' },
    });
    const listed = await request(2, 'tools/list');
    const names = listed.result.tools.map(
      (tool: { name: string }) => tool.name,
    );
    expect(names).toEqual(
      expect.arrayContaining(['list_agents', 'delegate_task']),
    );
    await instance.close();
  });
});

describe('agent-started child sessions (security review B2, D1, D2, D3)', () => {
  const delegatedInput = () =>
    (delegateTask.mock.calls[0] as unknown as [Record<string, unknown>])[0];
  const continuedInput = () =>
    (
      continueDelegatedTask.mock.calls[0] as unknown as [
        Record<string, unknown>,
      ]
    )[0];

  async function inProcessCall(
    sessionId: string,
    args: Record<string, unknown>,
  ) {
    process.env.STATION_API_BASE = baseUrl;
    const instance = claudeInProcessStationControlOptions(
      () => resolveRecord,
      createProbeServer,
    ).createInProcessStationControl(sessionId);
    const { transport, request } = sdkSideTransport();
    await instance.connect(transport);
    await request(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'claude-code', version: '2' },
    });
    const call = await request(2, 'tools/call', {
      name: 'probe_caller',
      arguments: args,
    });
    return JSON.parse(call.result.content[0].text);
  }

  test("a BOUND (in-process) caller acting for its session owner dispatches as that owner with that owner's PrincipalRef; a forged body userId is ignored", async () => {
    await inProcessCall('session-a', { delegate: true });
    expect(delegateTask).toHaveBeenCalledTimes(1);
    expect(delegatedInput()).toMatchObject({
      userId: 'human:test:alice',
      principal: { id: 'human:test:alice', kind: 'human' },
    });
    expect(delegatedInput().ownerAttribution).toBe('verified-bound');
  });

  test.each([
    ['url-token (Codex argv)', 'url-token'],
    ['http-header-token (ACP delegated custody)', 'http-header-token'],
  ] as const)(
    'D1: a %s caller for the same owner is NOT trusted to own a child: unattributed',
    async (_name, channel) => {
      const { token } = mintStationControlMcpToken('session-a', channel);
      await probe(token, { delegate: true });
      expect(delegatedInput()).toMatchObject({
        userId: LOCAL_OPERATOR_PRINCIPAL_ID,
        ownerAttribution: 'unattributed-agent',
      });
    },
  );

  test('D1: a stdio-env-token caller for the same owner is unattributed', async () => {
    process.env.STATION_API_BASE = baseUrl;
    installStationControlStdioCallerCredential({
      [STATION_CONTROL_CALLER_TOKEN_ENV]:
        mintStationControlStdioCallerToken('session-a'),
    });
    await api('/api/orchestration/delegations', {
      method: 'POST',
      body: JSON.stringify(DELEGATION_BODY),
    });
    expect(delegatedInput()).toMatchObject({
      userId: LOCAL_OPERATOR_PRINCIPAL_ID,
      ownerAttribution: 'unattributed-agent',
    });
  });

  test('a bound caller whose principal is only inferred (ownerless session) is unattributed', async () => {
    await inProcessCall('session-c', { delegate: true });
    expect(delegatedInput()).toMatchObject({
      userId: LOCAL_OPERATOR_PRINCIPAL_ID,
      ownerAttribution: 'unattributed-agent',
    });
  });

  test('a pooled child (origin marker, no credential) and a forged credential both mark the child unattributed', async () => {
    process.env.STATION_API_BASE = baseUrl;
    installStationControlStdioCallerCredential({});
    await api('/api/orchestration/delegations', {
      method: 'POST',
      body: JSON.stringify(DELEGATION_BODY),
    });
    await api('/api/orchestration/delegations', {
      method: 'POST',
      body: JSON.stringify(DELEGATION_BODY),
      headers: { [STATION_CONTROL_CALLER_TOKEN_HEADER]: 'forged' },
    });
    expect(delegateTask).toHaveBeenCalledTimes(2);
    for (const [input] of delegateTask.mock.calls as unknown as [
      Record<string, unknown>,
    ][])
      expect(input).toMatchObject({
        userId: LOCAL_OPERATOR_PRINCIPAL_ID,
        ownerAttribution: 'unattributed-agent',
      });
  });

  test('D3: an internal-token request with NO station-control headers at all is still unattributed (headers prove nothing)', async () => {
    const response = await fetch(`${baseUrl}/api/orchestration/delegations`, {
      method: 'POST',
      headers: { ...internalHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify(DELEGATION_BODY),
    });
    expect(response.status).toBe(200);
    expect(delegatedInput()).toMatchObject({
      userId: LOCAL_OPERATOR_PRINCIPAL_ID,
      ownerAttribution: 'unattributed-agent',
    });
  });

  test('an operator credential (not the internal principal) dispatches exactly as before: no marker', async () => {
    const response = await fetch(`${baseUrl}/api/orchestration/delegations`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${OPERATOR_CREDENTIAL}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(DELEGATION_BODY),
    });
    expect(response.status).toBe(200);
    expect(delegatedInput()).toMatchObject({
      userId: LOCAL_OPERATOR_PRINCIPAL_ID,
    });
    expect(delegatedInput().ownerAttribution).toBeUndefined();
  });

  test('D2: a delegated-task follow-up carries the same attribution: unattributed for a url-token caller, owner for a bound one', async () => {
    const { token } = mintStationControlMcpToken('session-a', 'url-token');
    await probe(token, { continueTask: true });
    expect(continuedInput()).toMatchObject({
      taskId: 'task:1',
      userId: LOCAL_OPERATOR_PRINCIPAL_ID,
      ownerAttribution: 'unattributed-agent',
    });
    continueDelegatedTask.mockClear();
    await inProcessCall('session-a', { continueTask: true });
    expect(continuedInput()).toMatchObject({
      taskId: 'task:1',
      userId: 'human:test:alice',
    });
    expect(continuedInput().ownerAttribution).toBe('verified-bound');
  });
});

// The public `/commands` schema admits no startSession; adoptSession is the
// session-creating command it carries.
describe('/commands adoptSession (review R1)', () => {
  const startCommand = {
    type: 'adoptSession',
    sourceThreadId: 'attached-source',
  };
  const dispatchContext = () =>
    (
      dispatchWithReceipt.mock.calls[0] as unknown as [
        unknown,
        Record<string, unknown>,
      ]
    )[1];

  test('an internal-token /commands adoptSession carries unattributed-agent to the service', async () => {
    const response = await fetch(`${baseUrl}/api/orchestration/commands`, {
      method: 'POST',
      headers: { ...internalHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify(startCommand),
    });
    expect(response.status).toBe(200);
    expect(dispatchContext()).toMatchObject({
      userId: LOCAL_OPERATOR_PRINCIPAL_ID,
      ownerAttribution: 'unattributed-agent',
    });
    // #2493 Q2: an agent-capable caller's adoption carries no grant.
    expect(dispatchContext()).not.toHaveProperty('fullAccessGrant');
  });

  test('an operator-credential /commands adoptSession carries no marker', async () => {
    const response = await fetch(`${baseUrl}/api/orchestration/commands`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${OPERATOR_CREDENTIAL}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(startCommand),
    });
    expect(response.status).toBe(200);
    expect(dispatchContext()).not.toHaveProperty('ownerAttribution');
    // #2493 Q2: the operator's adoption carries the operator's grant, so
    // the child starts host exactly as before.
    expect(isFullAccessGrant(dispatchContext().fullAccessGrant)).toBe(true);
  });
});

describe('Pane host actions (review S3)', () => {
  const ticket = 'a'.repeat(43);
  async function execute(headers: Record<string, string>) {
    const response = await fetch(
      `${baseUrl}/api/orchestration/pane-host/project-a/execute`,
      {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ ticket }),
      },
    );
    expect(response.status).toBe(200);
    return paneHostExecutions[0] as Record<string, unknown>;
  }

  test('an internal-credential Pane action reaches executeExecutionTargetMessage marked unattributed-agent', async () => {
    expect(await execute(internalHeaders())).toMatchObject({
      message: 'pane action',
      ownerAttribution: 'unattributed-agent',
    });
  });

  test('an operator-credential Pane action carries no marker', async () => {
    const input = await execute({
      authorization: `Bearer ${OPERATOR_CREDENTIAL}`,
    });
    expect(input.message).toBe('pane action');
    expect(input).not.toHaveProperty('ownerAttribution');
  });
});
