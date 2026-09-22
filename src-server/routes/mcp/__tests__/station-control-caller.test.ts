/**
 * Lane D of #90 (archive#122): a station-control tool learns its VERIFIED
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
  __resetStationControlMcpTokensForTests,
  mintStationControlMcpToken,
  mintStationControlStdioCallerToken,
  revokeStationControlMcpToken,
} from '../../../runtime/mcp/station-control-mcp-token.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import type { EventBus } from '../../../services/orchestration/event-bus.js';
import { SessionAuthorization } from '../../../services/orchestration/session-authorization.js';
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
import { createStationControlCallerRoutes } from '../station-control-caller-route.js';
import {
  createStationControlMcpRoutes,
  STATION_CONTROL_MCP_PATH,
} from '../station-control-mcp-route.js';

const OPERATOR_CREDENTIAL = 'test-only-operator-credential-caller-suite';

// The principal mapping is the production one: a real SessionAuthorization
// over a fake ownership store, configured as a personal host is.
const OWNERS: Record<string, string | undefined> = {
  'session-a': 'human:test:alice',
  'session-b': 'released-os-alias',
  'session-c': undefined,
};
const sessionAuthorization = new SessionAuthorization({
  eventStore: {
    findSessionOwnerUserId: (threadId: string) => OWNERS[threadId],
  } as never,
  ownerlessSessionAccess: 'single-user-compat',
  legacyPersonalOwner: 'released-os-alias',
});
const PROJECTS: Record<
  string,
  { projectSlug: string; conversationId: string }
> = {
  'session-a': { projectSlug: 'project-a', conversationId: 'conversation-a' },
  'session-b': { projectSlug: 'project-b', conversationId: 'conversation-b' },
};
const resolveRecord = vi.fn((sessionId: string) => {
  const principal = sessionAuthorization.sessionActingPrincipal(sessionId);
  return {
    ...(principal ? { principal } : {}),
    ...PROJECTS[sessionId],
  };
});
const SESSION_A = {
  sessionId: 'session-a',
  principal: { id: 'human:test:alice', source: 'session-owner' },
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
      }),
    },
    async (args) => {
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

async function callerRoute(headers: Record<string, string>) {
  const response = await fetch(`${baseUrl}${STATION_CONTROL_CALLER_PATH}`, {
    headers,
  });
  expect(response.status).toBe(200);
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

  test('the principal comes from the session ownership record: forged identity headers are ignored, a legacy owner and an ownerless personal session map to the local operator with their derivation named', async () => {
    const a = mintStationControlMcpToken('session-a', 'url-token');
    const forged = await callerRoute({
      ...internalHeaders(),
      'x-user-id': LOCAL_OPERATOR_PRINCIPAL_ID,
      'x-station-principal': LOCAL_OPERATOR_PRINCIPAL_ID,
      [STATION_CONTROL_CALLER_TOKEN_HEADER]: a.token,
    });
    expect(forged.caller).toEqual(SESSION_A);

    const b = mintStationControlMcpToken('session-b', 'url-token');
    const legacy = await callerRoute({
      ...internalHeaders(),
      [STATION_CONTROL_CALLER_TOKEN_HEADER]: b.token,
    });
    expect(legacy.caller).toMatchObject({
      sessionId: 'session-b',
      principal: {
        id: LOCAL_OPERATOR_PRINCIPAL_ID,
        source: 'legacy-personal-owner',
      },
    });

    const c = mintStationControlMcpToken('session-c', 'url-token');
    const ownerless = await callerRoute({
      ...internalHeaders(),
      [STATION_CONTROL_CALLER_TOKEN_HEADER]: c.token,
    });
    expect(ownerless.caller).toEqual({
      sessionId: 'session-c',
      principal: {
        id: LOCAL_OPERATOR_PRINCIPAL_ID,
        source: 'ownerless-single-operator',
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

  test('a live token presented by a non-internal principal (operator bearer) yields no caller', async () => {
    const { token } = mintStationControlMcpToken('session-a', 'url-token');
    const response = await callerRoute({
      authorization: `Bearer ${OPERATOR_CREDENTIAL}`,
      [STATION_CONTROL_CALLER_TOKEN_HEADER]: token,
    });
    expect(response.caller).toBeNull();
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
      principal: {
        id: LOCAL_OPERATOR_PRINCIPAL_ID,
        source: 'legacy-personal-owner',
      },
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
});
