/**
 * #2377 slice A: the station-control authority guard through the REAL
 * boundary — a listening server with the production runtime security
 * boundary (`configureRuntimeHttp`), the production guard, the production
 * station-control MCP route and in-process Claude delivery serving the REAL
 * tool registrations, and real token mints for every delivery channel. Only
 * the Station routes the tools call are stubs, and each records whether it
 * was reached.
 *
 * Callers, as Station actually delivers them:
 *  - bound: Claude in-process (`type: 'sdk'`), the only `bound` channel;
 *  - delegated-custody: an ACP engine's header token over HTTP MCP;
 *  - bearer-exposed: Codex's URL token over HTTP MCP;
 *  - pooled child: a stdio station-control child with no caller credential;
 *  - raw token: anything holding the per-boot internal token, with no caller.
 */
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
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
import { createStationControlCallerRoutes } from '../../routes/mcp/station-control-caller-route.js';
import {
  createStationControlMcpRoutes,
  STATION_CONTROL_MCP_PATH,
} from '../../routes/mcp/station-control-mcp-route.js';
import { configureRuntimeHttp } from '../../runtime/bootstrap/runtime-http.js';
import {
  resolveStationControlCallerForRequest,
  type StationControlCallerRecordResolver,
} from '../../runtime/mcp/station-control-caller.js';
import { claudeInProcessStationControlOptions } from '../../runtime/mcp/station-control-in-process.js';
import {
  __resetStationControlMcpTokensForTests,
  mintStationControlMcpHeaderAuth,
  mintStationControlMcpToken,
} from '../../runtime/mcp/station-control-mcp-token.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../services/identity/principal-resolver.js';
import type { EventBus } from '../../services/orchestration/event-bus.js';
import { createStationControlMcpServer } from '../../tools/station-control-mcp-server.js';
import {
  STATION_CONTROL_TOOL_POLICY,
  type StationControlToolPolicy,
} from '../../tools/station-control-policy.js';
import {
  __resetStationControlStdioCallerCredentialForTests,
  api,
  installStationControlStdioCallerCredential,
  STATION_CONTROL_CALLER_PATH,
  STATION_CONTROL_CALLER_TOKEN_HEADER,
} from '../../tools/station-control-shared.js';
import {
  __resetStationServerSelfAttestationForTests,
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_PROXY_CALLER_HEADER,
  INTERNAL_SERVER_SELF_HEADER,
} from '../../utils/internal-api-token.js';
import type { Logger } from '../../utils/logger.js';
import {
  createStationControlAuthorityGuard,
  STATION_CONTROL_GUARD_CARVE_OUTS,
} from '../station-control-authority-guard.js';

const OPERATOR_CREDENTIAL = 'test-only-operator-credential-authority-guard';

/**
 * Session ids name the principal Station recorded for the session: the
 * operator as a recorded owner, another person, or the operator only by
 * inference (never elevation-eligible).
 */
const resolveRecord: StationControlCallerRecordResolver = (sessionId) => {
  const principal = sessionId.startsWith('op-')
    ? {
        id: LOCAL_OPERATOR_PRINCIPAL_ID,
        source: 'session-owner' as const,
      }
    : sessionId.startsWith('person-')
      ? { id: 'human:local:someone-else', source: 'session-owner' as const }
      : sessionId.startsWith('inferred-')
        ? {
            id: LOCAL_OPERATOR_PRINCIPAL_ID,
            source: 'ownerless-single-operator' as const,
          }
        : undefined;
  return {
    ...(principal ? { principal } : {}),
    localProjectId: 'local-project-a',
    projectIdSource: 'session-record',
    projectSlug: 'project-a',
  };
};

let server: ReturnType<typeof serve>;
let baseUrl: string;
let port: number;
const refusals: string[] = [];
const hits: string[] = [];

function quietLogger(): Logger {
  return {
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
}

beforeAll(async () => {
  __resetStationServerSelfAttestationForTests();
  const app = new Hono();
  configureRuntimeHttp({
    app: app as never,
    logger: quietLogger(),
    eventBus: { emit: vi.fn() } as unknown as EventBus,
    security: {
      verifyCredential: (candidate: string) =>
        candidate === OPERATOR_CREDENTIAL,
      resolveGrantedScope: () => 'orchestration:read orchestration:operate',
      resolveCredentialAuthority: () => 'operator-credential',
      now: () => Date.now(),
      maxFailures: 1_000,
      windowMs: 60_000,
      audit: () => {},
      allowedOrigins: [],
    },
  } as Parameters<typeof configureRuntimeHttp>[0]);
  // The production guard, registered where `configureRuntimeRoutes` does:
  // after the boundary, before every route.
  app.use(
    '*',
    createStationControlAuthorityGuard({
      resolveCaller: (request) =>
        resolveStationControlCallerForRequest(request, resolveRecord),
      isOperatorPrincipal: (id) => id === LOCAL_OPERATOR_PRINCIPAL_ID,
      onRefusal: (refusal) => refusals.push(refusal.code),
    }),
  );
  let resolvePort!: (value: number) => void;
  const listening = new Promise<number>((resolve) => {
    resolvePort = resolve;
  });
  server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, (info) =>
    resolvePort((info as AddressInfo).port),
  );
  port = await listening;
  baseUrl = `http://127.0.0.1:${port}`;
  process.env.STATION_API_BASE = baseUrl;
  app.route(
    '',
    createStationControlMcpRoutes({ port, resolveCallerRecord: resolveRecord }),
  );
  app.route(
    '/api/orchestration',
    createStationControlCallerRoutes({ resolveRecord }),
  );
  // Stubs for the Station routes the representative tools call. Each records
  // that it was reached, so "allowed" means the request got through.
  const record = (label: string, body: unknown) => (c: any) => {
    hits.push(label);
    return c.json(body);
  };
  const ok = { success: true, data: { ok: true } };
  app.get('/agents', record('GET /agents', []));
  app.put('/config/app', record('PUT /config/app', { success: true }));
  app.put(
    '/scheduler/jobs/:target/disable',
    record('PUT /scheduler/jobs/:target/disable', ok),
  );
  app.post('/scheduler/jobs', record('POST /scheduler/jobs', ok));
  app.post('/api/providers', record('POST /api/providers', ok));
  app.post('/api/board/pin', record('POST /api/board/pin', ok));
  app.post(
    '/api/notifications/agent',
    record('POST /api/notifications/agent', { status: 'sent' }),
  );
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.STATION_API_BASE;
  __resetStationControlStdioCallerCredentialForTests();
  __resetStationServerSelfAttestationForTests();
});

beforeEach(() => {
  __resetStationControlMcpTokensForTests();
  __resetStationControlStdioCallerCredentialForTests();
  hits.length = 0;
  refusals.length = 0;
});

async function readJsonRpc(response: Response): Promise<any> {
  const text = await response.text();
  if ((response.headers.get('content-type') ?? '').includes('application/json'))
    return JSON.parse(text);
  const dataLine = text.split('\n').find((line) => line.startsWith('data: '));
  if (!dataLine) throw new Error(`No SSE data line: ${text}`);
  return JSON.parse(dataLine.slice('data: '.length));
}

type Engine = (id: number, method: string, params?: object) => Promise<any>;

/** Codex (`?token=`) or ACP (bearer header) over the real HTTP MCP route. */
function httpEngine(credential: { query?: string; bearer?: string }): Engine {
  const url = `${baseUrl}${STATION_CONTROL_MCP_PATH}${
    credential.query ? `?token=${encodeURIComponent(credential.query)}` : ''
  }`;
  return async (id, method, params = {}) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(credential.bearer
          ? { authorization: `Bearer ${credential.bearer}` }
          : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    expect(response.status).toBe(200);
    return readJsonRpc(response);
  };
}

/** The engine's side of an in-memory MCP connection. */
function memoryTransport() {
  const sent: any[] = [];
  const transport: any = {
    start: async () => {},
    close: async () => {},
    send: async (message: unknown) => {
      sent.push(message);
    },
  };
  const request: Engine = async (id, method, params = {}) => {
    setImmediate(() =>
      transport.onmessage({ jsonrpc: '2.0', id, method, params }),
    );
    for (let i = 0; i < 500; i += 1) {
      const found = sent.find((m) => m.id === id);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`no response for ${id}`);
  };
  return { transport, request };
}

async function initialized(engine: Engine): Promise<Engine> {
  await engine(1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'engine', version: '1' },
  });
  return engine;
}

type Channel = 'bound' | 'delegated-custody' | 'bearer-exposed' | 'pooled';

/** One engine per channel, acting for the session `sessionId` names. */
async function engineFor(
  channel: Channel,
  sessionId: string,
): Promise<{ call: Engine; close: () => Promise<void> }> {
  if (channel === 'bound') {
    const options = claudeInProcessStationControlOptions(() => resolveRecord);
    const instance = options.createInProcessStationControl(sessionId);
    const { transport, request } = memoryTransport();
    await instance.connect(transport);
    return {
      call: await initialized(request),
      close: () => instance.close(),
    };
  }
  if (channel === 'pooled') {
    // A pooled stdio child: the stdio entry ran with no per-session caller
    // credential, and the server has no caller context for it.
    installStationControlStdioCallerCredential({});
    const pooled = createStationControlMcpServer();
    const { transport, request } = memoryTransport();
    await pooled.connect(transport);
    return {
      call: await initialized(request),
      close: () => pooled.close(),
    };
  }
  const token =
    channel === 'delegated-custody'
      ? mintStationControlMcpHeaderAuth(port, sessionId).token
      : mintStationControlMcpToken(sessionId, 'url-token').token;
  return {
    call: await initialized(
      httpEngine(
        channel === 'delegated-custody' ? { bearer: token } : { query: token },
      ),
    ),
    close: async () => {},
  };
}

async function callTool(
  channel: Channel,
  sessionId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ result: any; hits: string[] }> {
  hits.length = 0;
  const engine = await engineFor(channel, sessionId);
  try {
    const response = await engine.call(9, 'tools/call', {
      name,
      arguments: args,
    });
    const text = response.result?.content?.[0]?.text;
    return {
      result: typeof text === 'string' ? JSON.parse(text) : response,
      hits: [...hits],
    };
  } finally {
    await engine.close();
    __resetStationControlStdioCallerCredentialForTests();
  }
}

function internalHeaders(extra: Record<string, string> = {}) {
  return {
    'content-type': 'application/json',
    [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
    [INTERNAL_PROXY_CALLER_HEADER]: 'local',
    ...extra,
  };
}

/** The credential a tool of this channel forwards on its REST calls. */
function forwardedCaller(
  channel: Channel,
  sessionId: string,
): string | undefined {
  switch (channel) {
    case 'bound':
      return mintStationControlMcpToken(sessionId, 'sdk-in-process').token;
    case 'delegated-custody':
      return mintStationControlMcpHeaderAuth(port, sessionId).token;
    case 'bearer-exposed':
      return mintStationControlMcpToken(sessionId, 'url-token').token;
    case 'pooled':
      return undefined;
  }
}

async function rest(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; code?: string }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let code: string | undefined;
  try {
    code = (JSON.parse(text) as { code?: string }).code;
  } catch {
    code = undefined;
  }
  return { status: response.status, ...(code ? { code } : {}) };
}

// ── representative tools, one per policy class, end to end ───────────────

interface Row {
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly route: string;
  /** Per caller: `allowed` or the exact typed refusal. */
  readonly expect: Record<string, 'allowed' | string>;
}

const ROWS: readonly Row[] = [
  {
    tool: 'list_agents',
    args: {},
    route: 'GET /agents',
    expect: {
      'bound op-': 'allowed',
      'delegated-custody op-': 'allowed',
      'bearer-exposed op-': 'allowed',
      'pooled none': 'allowed',
    },
  },
  {
    tool: 'update_config',
    args: { updates: { theme: 'dark' } },
    route: 'PUT /config/app',
    expect: {
      'bound op-': 'allowed',
      'bound person-': 'station_control_role_required',
      'bound inferred-': 'station_control_role_required',
      'delegated-custody op-': 'station_control_assurance_insufficient',
      'bearer-exposed op-': 'station_control_assurance_insufficient',
      'pooled none': 'station_control_caller_required',
    },
  },
  {
    tool: 'disable_job',
    args: { name: 'nightly' },
    route: 'PUT /scheduler/jobs/:target/disable',
    expect: {
      'bound op-': 'allowed',
      'delegated-custody op-': 'allowed',
      'delegated-custody person-': 'station_control_role_required',
      'bearer-exposed op-': 'station_control_assurance_insufficient',
      'pooled none': 'station_control_caller_required',
    },
  },
  {
    tool: 'create_provider',
    args: { type: 'ollama', name: 'local', config: {} },
    route: 'POST /api/providers',
    expect: {
      'bound op-': 'station_control_person_only',
      'delegated-custody op-': 'station_control_person_only',
      'bearer-exposed op-': 'station_control_person_only',
      'pooled none': 'station_control_person_only',
    },
  },
  {
    tool: 'add_job',
    args: { name: 'j', prompt: 'p', trustAllTools: true },
    route: 'POST /scheduler/jobs',
    expect: {
      'bound op-': 'station_control_person_only',
      'bearer-exposed op-': 'station_control_person_only',
      'pooled none': 'station_control_person_only',
    },
  },
  {
    tool: 'add_job',
    args: { name: 'j', prompt: 'p' },
    route: 'POST /scheduler/jobs',
    expect: {
      'bound op-': 'allowed',
      'delegated-custody op-': 'station_control_assurance_insufficient',
      'pooled none': 'station_control_caller_required',
    },
  },
  {
    tool: 'board_pin',
    args: {
      reference: { kind: 'session', id: 's' },
      name: 'w',
      block: { type: 'card', body: 'hello' },
    },
    route: 'POST /api/board/pin',
    expect: {
      'bound person-': 'allowed',
      'delegated-custody person-': 'allowed',
      'bearer-exposed person-': 'allowed',
      'pooled none': 'station_control_caller_required',
    },
  },
];

let sessionCounter = 0;
function nextSession(prefix: string): string {
  sessionCounter += 1;
  return `${prefix === 'none' ? 'x-' : prefix}${sessionCounter}`;
}
function cases(row: Row) {
  return Object.entries(row.expect).map(([key, outcome]) => {
    const [channel, prefix] = key.split(' ') as [Channel, string];
    return { channel, prefix, outcome };
  });
}

describe('each policy class through the real tools, per delivery channel', () => {
  for (const row of ROWS)
    for (const { channel, prefix, outcome } of cases(row))
      test(`${row.tool}${row.args.trustAllTools ? ' (trustAllTools)' : ''} via ${channel} (${prefix}) → ${outcome}`, async () => {
        const sessionId = nextSession(prefix);
        const { result, hits: reached } = await callTool(
          channel,
          sessionId,
          row.tool,
          row.args,
        );
        if (outcome === 'allowed') {
          expect(reached).toEqual([row.route]);
          expect(result?.code).toBeUndefined();
        } else {
          expect(reached).toEqual([]);
          expect(result).toMatchObject({ success: false, code: outcome });
          expect(typeof result.error).toBe('string');
        }
      });
});

describe('the server enforces the same refusal for each channel’s forwarded credential', () => {
  // The tool-side check answered first above. This drives the REST route
  // with exactly what each channel's tool forwards, so the server guard —
  // the enforcement point — is what decides.
  for (const row of ROWS)
    for (const { channel, prefix, outcome } of cases(row))
      test(`${row.route}${row.args.trustAllTools ? ' (trustAllTools)' : ''} with a ${channel} (${prefix}) caller → ${outcome}`, async () => {
        const sessionId = nextSession(prefix);
        const caller = forwardedCaller(channel, sessionId);
        const [method, pattern] = row.route.split(' ') as [string, string];
        const path = pattern.replace(':target', 'nightly');
        const body =
          method === 'GET'
            ? undefined
            : row.tool === 'update_config'
              ? row.args.updates
              : row.args;
        hits.length = 0;
        const response = await rest(
          method,
          path,
          internalHeaders(
            caller ? { [STATION_CONTROL_CALLER_TOKEN_HEADER]: caller } : {},
          ),
          body,
        );
        if (outcome === 'allowed') {
          expect(response.status).toBe(200);
          expect(hits).toEqual([row.route]);
        } else {
          expect(response).toEqual({ status: 403, code: outcome });
          expect(hits).toEqual([]);
        }
      });

  test('the raw internal token (no caller) reaches only reads', async () => {
    expect(await rest('GET', '/agents', internalHeaders())).toEqual({
      status: 200,
    });
    expect(
      await rest('PUT', '/config/app', internalHeaders(), { theme: 'x' }),
    ).toEqual({ status: 403, code: 'station_control_caller_required' });
    expect(await rest('POST', '/api/providers', internalHeaders(), {})).toEqual(
      { status: 403, code: 'station_control_person_only' },
    );
    expect(hits).toEqual(['GET /agents']);
  });

  test('a pooled child’s own REST call carries no caller and no server attestation', async () => {
    installStationControlStdioCallerCredential({});
    expect(
      await api('/config/app', { method: 'PUT', body: '{}' }),
    ).toMatchObject({
      success: false,
      code: 'station_control_caller_required',
    });
    expect(await api('/agents')).toEqual([]);
    expect(hits).toEqual(['GET /agents']);
  });

  test('a forged or revoked caller credential is no caller at all', async () => {
    expect(
      await rest(
        'PUT',
        '/config/app',
        internalHeaders({ [STATION_CONTROL_CALLER_TOKEN_HEADER]: 'forged' }),
        {},
      ),
    ).toEqual({ status: 403, code: 'station_control_caller_required' });
    expect(hits).toEqual([]);
  });

  test('a route handler that authorizes the caller itself (notify_user) is left to it', async () => {
    expect(
      await rest('POST', '/api/notifications/agent', internalHeaders(), {}),
    ).toEqual({ status: 200 });
    expect(hits).toEqual(['POST /api/notifications/agent']);
  });

  test('the stdio caller projection stays reachable for a child to learn its caller', async () => {
    const response = await rest(
      'GET',
      STATION_CONTROL_CALLER_PATH,
      internalHeaders(),
    );
    expect(response.status).toBe(200);
  });
});

describe('who the guard does not decide', () => {
  test('the operator UI (a credential, never kind:internal) is unchanged on a guarded mutation', async () => {
    const response = await rest(
      'PUT',
      '/config/app',
      {
        'content-type': 'application/json',
        authorization: `Bearer ${OPERATOR_CREDENTIAL}`,
      },
      { theme: 'dark' },
    );
    expect(response).toEqual({ status: 200 });
    expect(hits).toEqual(['PUT /config/app']);
    expect(refusals).toEqual([]);
  });

  test('Station’s own server code (outside any tool call) carries the server attestation and is not refused', async () => {
    // No caller context and no stdio entry: this is how the in-process
    // execution-target dispatch calls its own API.
    expect(await api('/config/app', { method: 'PUT', body: '{}' })).toEqual({
      success: true,
    });
    expect(hits).toEqual(['PUT /config/app']);
  });

  test('a forged server attestation is refused like any caller-less request', async () => {
    expect(
      await rest(
        'PUT',
        '/config/app',
        internalHeaders({ [INTERNAL_SERVER_SELF_HEADER]: 'forged' }),
        {},
      ),
    ).toEqual({ status: 403, code: 'station_control_caller_required' });
    expect(hits).toEqual([]);
  });

  test('a tool running inside Station’s process never borrows the server attestation', async () => {
    // In-process Claude runs in this very process; acting for someone who is
    // not the operator it must still be refused, not waved through.
    const { result, hits: reached } = await callTool(
      'bound',
      'person-borrow',
      'update_config',
      { updates: { theme: 'dark' } },
    );
    expect(result).toMatchObject({ code: 'station_control_role_required' });
    expect(reached).toEqual([]);
  });

  test('the carve-outs are exactly the agent relay and the readiness reads', async () => {
    expect(
      STATION_CONTROL_GUARD_CARVE_OUTS.map(
        (carveOut) => `${carveOut.method} ${carveOut.pattern.source}`,
      ),
    ).toEqual([
      'POST ^\\/api\\/agents\\/[^/]+\\/chat$',
      'GET ^\\/api\\/system\\/identity$',
      'GET ^\\/api\\/system\\/instance$',
    ]);
    // Carved out: reaches routing (404 here, no handler mounted).
    for (const [method, path] of [
      ['POST', '/api/agents/default/chat'],
      ['GET', '/api/system/identity'],
      ['GET', '/api/system/instance'],
    ] as const)
      expect(await rest(method, path, internalHeaders(), undefined)).toEqual({
        status: 404,
      });
    // Exact, not a prefix.
    for (const [method, path] of [
      ['POST', '/api/agents/default/chat/extra'],
      ['GET', '/api/system/identity/extra'],
      ['POST', '/api/system/identity'],
    ] as const)
      expect(
        await rest(
          method,
          path,
          internalHeaders(),
          method === 'GET' ? undefined : {},
        ),
      ).toEqual({
        status: 403,
        code: 'station_control_route_unmapped',
      });
  });
});

// ── every tool, table-driven through the same boundary ───────────────────

/** Every (method, concrete path) any tool reaches, with its owners. */
function everyToolRoute() {
  const routes = new Map<
    string,
    { method: string; path: string; owners: StationControlToolPolicy[] }
  >();
  for (const policy of Object.values(
    STATION_CONTROL_TOOL_POLICY,
  ) as StationControlToolPolicy[])
    for (const route of policy.routes) {
      const path = route.path.replace(/:[A-Za-z]+/g, 'zz');
      const key = `${route.method} ${path}`;
      const entry = routes.get(key) ?? {
        method: route.method,
        path,
        owners: [],
      };
      entry.owners.push(policy);
      routes.set(key, entry);
    }
  return [...routes.values()];
}

describe('every tool route, table-driven through the real boundary', () => {
  test('the raw internal token: reads and route-enforced leaves pass, every other leaf refuses', async () => {
    const outcomes: Record<string, string> = {};
    const expected: Record<string, string> = {};
    for (const { method, path, owners } of everyToolRoute()) {
      const key = `${method} ${path}`;
      // Independent of the evaluator: the rule as decision 4 states it.
      expected[key] = owners.some(
        (owner) =>
          owner.toolClass === 'read-only' || owner.enforcedBy === 'route',
      )
        ? 'passed'
        : owners.every((owner) => owner.personOnly === 'always')
          ? 'station_control_person_only'
          : 'station_control_caller_required';
      const response = await rest(
        method,
        path,
        internalHeaders(),
        method === 'GET' ? undefined : {},
      );
      outcomes[key] =
        response.status === 403 && response.code?.startsWith('station_control_')
          ? response.code
          : 'passed';
    }
    expect(outcomes).toEqual(expected);
  });

  test('a bound operator caller passes every leaf except a person’s step', async () => {
    const caller = mintStationControlMcpToken(
      'op-table',
      'sdk-in-process',
    ).token;
    const outcomes: Record<string, string> = {};
    const expected: Record<string, string> = {};
    for (const { method, path, owners } of everyToolRoute()) {
      const key = `${method} ${path}`;
      expected[key] = owners.every((owner) => owner.personOnly === 'always')
        ? 'station_control_person_only'
        : 'passed';
      const response = await rest(
        method,
        path,
        internalHeaders({ [STATION_CONTROL_CALLER_TOKEN_HEADER]: caller }),
        method === 'GET' ? undefined : {},
      );
      outcomes[key] =
        response.status === 403 && response.code?.startsWith('station_control_')
          ? response.code
          : 'passed';
    }
    expect(outcomes).toEqual(expected);
  });

  test('a bearer-exposed operator caller passes only leaves some tool opens to any caller', async () => {
    const caller = mintStationControlMcpToken('op-bearer', 'url-token').token;
    const outcomes: Record<string, string> = {};
    const expected: Record<string, string> = {};
    for (const { method, path, owners } of everyToolRoute()) {
      const key = `${method} ${path}`;
      expected[key] = owners.some(
        (owner) =>
          owner.enforcedBy === 'route' ||
          (owner.assurance === 'any' && owner.personOnly !== 'always'),
      )
        ? 'passed'
        : owners.every((owner) => owner.personOnly === 'always')
          ? 'station_control_person_only'
          : 'station_control_assurance_insufficient';
      const response = await rest(
        method,
        path,
        internalHeaders({ [STATION_CONTROL_CALLER_TOKEN_HEADER]: caller }),
        method === 'GET' ? undefined : {},
      );
      outcomes[key] =
        response.status === 403 && response.code?.startsWith('station_control_')
          ? response.code
          : 'passed';
    }
    expect(outcomes).toEqual(expected);
  });
});
