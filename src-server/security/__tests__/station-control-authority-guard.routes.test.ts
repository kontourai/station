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
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { StationAgentAdapter } from '../../providers/adapters/station-agent-adapter.js';
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
import { jobEditRetargetsGrantedWork } from '../../runtime/routes/runtime-routes.js';
import {
  principalKey,
  UnattendedGrantStore,
} from '../../services/agents/unattended-grant-store.js';
import { ApprovalRegistry } from '../../services/approvals/approval-registry.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../services/identity/principal-resolver.js';
import type { EventBus } from '../../services/orchestration/event-bus.js';
import { EventBus as RealEventBus } from '../../services/orchestration/event-bus.js';
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
  stationControlCallerPrincipal,
  withStationControlCallerContext,
} from '../../tools/station-control-shared.js';
import {
  __resetStationServerSelfAttestationForTests,
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_PROXY_CALLER_HEADER,
  INTERNAL_SERVER_SELF_HEADER,
  runAsStationServer,
} from '../../utils/internal-api-token.js';
import type { Logger } from '../../utils/logger.js';
import {
  createStationControlAuthorityGuard,
  STATION_CONTROL_GUARD_CARVE_OUTS,
} from '../station-control-authority-guard.js';

const OPERATOR_CREDENTIAL = 'test-only-operator-credential-authority-guard';

/**
 * Session ids name the principal Station recorded for the session: the
 * operator as a recorded owner, another person, or no recorded owner at all
 * (since #2662 a session without a recorded owner has no acting principal).
 */
const resolveRecord: StationControlCallerRecordResolver = (sessionId) => {
  const principal = sessionId.startsWith('op-')
    ? {
        id: LOCAL_OPERATOR_PRINCIPAL_ID,
        source: 'session-owner' as const,
      }
    : sessionId.startsWith('person-')
      ? { id: 'human:local:someone-else', source: 'session-owner' as const }
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
/** The headers each stub route last received, by its label. */
const lastHeaders = new Map<string, Headers>();
const makeTempDir = trackTempDirs({ lifetime: 'file' });
let grants: UnattendedGrantStore;
/** The jobs the scheduler would list; `granted` has a live grant. */
const JOBS = [
  {
    name: 'granted',
    provider: 'builtin',
    prompt: 'the reviewed prompt',
    agent: 'reviewer',
    enabled: true,
    monitor: {
      kind: 'github-pull-request' as const,
      objective: 'review-ready' as const,
      target: 'https://github.com/org/repo/pull/1',
      agentId: 'reviewer',
      projectId: 'project-a',
    },
    unattendedPrincipal: {
      kind: 'scheduled-job' as const,
      jobId: 'job-granted',
    },
  },
  {
    name: 'plain',
    provider: 'builtin',
    prompt: 'p',
    enabled: true,
    unattendedPrincipal: { kind: 'scheduled-job' as const, jobId: 'job-plain' },
  },
];

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
  grants = new UnattendedGrantStore(makeTempDir('authority-guard-grants-'));
  await grants.grantTool(
    principalKey({ kind: 'scheduled-job', jobId: 'job-granted' }),
    'station-control_update_config',
    'human:local:operator',
  );
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
      // The production check, over a real grant store.
      retargetsGrantedJob: (jobName, changes) =>
        jobEditRetargetsGrantedWork(jobName, changes, async () => JOBS, grants),
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
    lastHeaders.set(label, new Headers(c.req.raw.headers));
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
  app.put('/scheduler/jobs/:target', record('PUT /scheduler/jobs/:target', ok));
  app.post(
    '/api/orchestration/commands',
    record('POST /api/orchestration/commands', ok),
  );
  // The Station agent relay's target: answers one finished turn.
  app.post('/api/agents/:id/chat', (c) => {
    hits.push('POST /api/agents/:id/chat');
    lastHeaders.set(
      'POST /api/agents/:id/chat',
      new Headers(c.req.raw.headers),
    );
    return new Response(
      `data: ${JSON.stringify({ type: 'finish', finishReason: 'stop' })}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  });
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
  lastHeaders.clear();
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
  /** The job a scheduler row edits, when it matters (grants are per job). */
  readonly job?: string;
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
      'bound ownerless-': 'station_control_role_required',
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
      'bound person-': 'station_control_role_required',
      'delegated-custody op-': 'station_control_assurance_insufficient',
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
    tool: 'update_job',
    args: { name: 'nightly', trustAllTools: true },
    route: 'PUT /scheduler/jobs/:target',
    expect: {
      'bound op-': 'station_control_person_only',
      'delegated-custody op-': 'station_control_person_only',
      'bearer-exposed op-': 'station_control_person_only',
      'pooled none': 'station_control_person_only',
    },
  },
  {
    // M1: `granted` holds a person's unattended grant, so changing what it
    // runs is a person's step — decided by the server (the tool cannot read
    // the grant store), and the typed code reaches the agent.
    tool: 'update_job',
    args: { name: 'granted', prompt: 'run something else' },
    job: 'granted',
    route: 'PUT /scheduler/jobs/:target',
    expect: {
      'bound op-': 'station_control_person_only',
      'delegated-custody op-': 'station_control_assurance_insufficient',
      'pooled none': 'station_control_caller_required',
    },
  },
  {
    tool: 'update_job',
    args: { name: 'plain', prompt: 'run something else' },
    job: 'plain',
    route: 'PUT /scheduler/jobs/:target',
    expect: {
      'bound op-': 'allowed',
      'bound person-': 'station_control_role_required',
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
      test(`${row.tool}${row.args.trustAllTools ? ' (trustAllTools)' : ''}${row.job ? ` (${row.job} job)` : ''} via ${channel} (${prefix}) → ${outcome}`, async () => {
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
      test(`${row.route}${row.args.trustAllTools ? ' (trustAllTools)' : ''}${row.job ? ` (${row.job} job)` : ''} with a ${channel} (${prefix}) caller → ${outcome}`, async () => {
        const sessionId = nextSession(prefix);
        const caller = forwardedCaller(channel, sessionId);
        const [method, pattern] = row.route.split(' ') as [string, string];
        const path = pattern.replace(':target', row.job ?? 'nightly');
        // What each tool actually sends: update_config its `updates`,
        // update_job every field but the route's `name`.
        const { name: _jobName, ...jobEdit } = row.args;
        const body =
          method === 'GET'
            ? undefined
            : row.tool === 'update_config'
              ? row.args.updates
              : row.tool === 'update_job'
                ? jobEdit
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

  test('Station’s own server code, inside an explicit server scope, carries the attestation and is not refused', async () => {
    // How an entry point (a person's chat, a webhook, the relay) calls its
    // own API: no caller context, inside `runAsStationServer`.
    expect(
      await runAsStationServer(() =>
        api('/config/app', { method: 'PUT', body: '{}' }),
      ),
    ).toEqual({ success: true });
    expect(hits).toEqual(['PUT /config/app']);
    expect(
      lastHeaders.get('PUT /config/app')?.has(INTERNAL_SERVER_SELF_HEADER),
    ).toBe(true);
  });

  test('an in-process call with no caller context and no server scope is refused: a lost context is no authority', async () => {
    expect(
      await api('/config/app', { method: 'PUT', body: '{}' }),
    ).toMatchObject({
      success: false,
      code: 'station_control_caller_required',
    });
    expect(hits).toEqual([]);
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

  // H1: a station-control tool call never carries the server attestation,
  // on any delivery channel, for an allowed mutation or a read — even when
  // the engine was driven from inside a server scope. The stub records the
  // headers the tool's REST call actually carried.
  for (const channel of [
    'bound',
    'delegated-custody',
    'bearer-exposed',
  ] as const)
    for (const [tool, args, label] of [
      [
        'board_pin',
        {
          reference: { kind: 'session', id: 's' },
          name: 'w',
          block: { type: 'card', body: 'hello' },
        },
        'POST /api/board/pin',
      ],
      ['list_agents', {}, 'GET /agents'],
    ] as const)
      test(`a ${channel} tool call (${tool}) carries its caller token and never the server attestation`, async () => {
        const { hits: reached } = await runAsStationServer(() =>
          callTool(channel, nextSession('op-'), tool, args),
        );
        expect(reached).toEqual([label]);
        const headers = lastHeaders.get(label);
        expect(headers?.has(STATION_CONTROL_CALLER_TOKEN_HEADER)).toBe(true);
        expect(headers?.has(INTERNAL_SERVER_SELF_HEADER)).toBe(false);
      });

  test('the carve-outs are exactly the readiness reads', async () => {
    expect(
      STATION_CONTROL_GUARD_CARVE_OUTS.map(
        (carveOut) => `${carveOut.method} ${carveOut.pattern.source}`,
      ),
    ).toEqual([
      'GET ^\\/api\\/system\\/identity$',
      'GET ^\\/api\\/system\\/instance$',
    ]);
    // Carved out: reaches routing (404 here, no handler mounted).
    for (const path of ['/api/system/identity', '/api/system/instance'])
      expect(await rest('GET', path, internalHeaders(), undefined)).toEqual({
        status: 404,
      });
    // Exact, not a prefix.
    for (const [method, path] of [
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

describe('the server guard alone gives agents a typed refusal (F2)', () => {
  // The tool-side check is switched off by handing the tool a caller context
  // that claims a bound operator while forwarding no credential: the tool
  // lets the call through, and only the server guard decides.
  const toolSideOff = <T>(operation: () => T): T =>
    withStationControlCallerContext(
      {
        token: undefined,
        resolve: () => ({
          sessionId: 'claims-operator',
          assurance: 'bound',
          principal: stationControlCallerPrincipal(
            LOCAL_OPERATOR_PRINCIPAL_ID,
            'session-owner',
          ),
        }),
      },
      operation,
    );
  const handlers = () =>
    (
      createStationControlMcpServer() as unknown as {
        _registeredTools: Record<
          string,
          { handler: (args: unknown, extra?: unknown) => Promise<any> }
        >;
      }
    )._registeredTools;

  test.each([
    ['disable_job', { name: 'nightly' }],
    [
      'board_pin',
      {
        reference: { kind: 'session', id: 's' },
        name: 'w',
        block: { type: 'card', body: 'hello' },
      },
    ],
  ] as const)('%s keeps the server’s code and error', async (name, args) => {
    const handler = handlers()[name]?.handler;
    const result = await toolSideOff(() => handler!(args, {}));
    expect(JSON.parse(result.content[0].text)).toEqual({
      success: false,
      code: 'station_control_caller_required',
      error: expect.stringContaining('verified calling session'),
    });
    expect(hits).toEqual([]);
    expect(refusals).toEqual(['station_control_caller_required']);
  });
});

describe('the Station agent relay (M2): server code, not a carve-out', () => {
  test('a bare internal token on the relay path is refused', async () => {
    expect(
      await rest('POST', '/api/agents/default/chat', internalHeaders(), {
        input: 'hi',
      }),
    ).toEqual({ status: 403, code: 'station_control_route_unmapped' });
    expect(hits).toEqual([]);
  });

  test('the relay itself reaches /chat with the server attestation', async () => {
    const eventBus = new RealEventBus();
    const adapter = new StationAgentAdapter({
      apiBase: baseUrl,
      hasAgent: () => true,
      eventBus,
      approvalRegistry: new ApprovalRegistry(
        { info: vi.fn(), warn: vi.fn() },
        { eventBus },
      ),
    });
    await adapter.startSession({
      threadId: 'relay-thread',
      provider: 'station-agent',
      metadata: { agentId: 'reviewer' },
    });
    await adapter.sendTurn({ threadId: 'relay-thread', input: 'hello' });
    await vi.waitFor(() => expect(hits).toEqual(['POST /api/agents/:id/chat']));
    expect(
      lastHeaders
        .get('POST /api/agents/:id/chat')
        ?.has(INTERNAL_SERVER_SELF_HEADER),
    ).toBe(true);
    expect(refusals).toEqual([]);
  });
});

describe('answering a pending request (M4): only the bound operator', () => {
  const respond = { type: 'respondToRequest', threadId: 't', requestId: 'r' };
  test.each([
    ['bound', 'op-', 'allowed'],
    ['bound', 'person-', 'station_control_role_required'],
    ['delegated-custody', 'op-', 'station_control_assurance_insufficient'],
    ['bearer-exposed', 'op-', 'station_control_assurance_insufficient'],
    ['pooled', 'none', 'station_control_caller_required'],
  ] as const)(
    'a %s (%s) caller answering with acceptForSession → %s',
    async (channel, prefix, outcome) => {
      const caller = forwardedCaller(channel, nextSession(prefix));
      const response = await rest(
        'POST',
        '/api/orchestration/commands',
        internalHeaders(
          caller ? { [STATION_CONTROL_CALLER_TOKEN_HEADER]: caller } : {},
        ),
        { ...respond, decision: 'acceptForSession' },
      );
      if (outcome === 'allowed') {
        expect(response).toEqual({ status: 200 });
        expect(hits).toEqual(['POST /api/orchestration/commands']);
      } else {
        expect(response).toEqual({ status: 403, code: outcome });
        expect(hits).toEqual([]);
      }
    },
  );

  // M-2: setting a session's approval mode to ANY value is an approval
  // decision (`auto` or a reset loosen it as surely as `never`).
  test.each([
    ['bound', 'op-', 'allowed'],
    ['bound', 'person-', 'station_control_role_required'],
    ['delegated-custody', 'op-', 'station_control_assurance_insufficient'],
    ['bearer-exposed', 'op-', 'station_control_assurance_insufficient'],
    ['pooled', 'none', 'station_control_caller_required'],
  ] as const)(
    'a %s (%s) caller setting any approval mode → %s',
    async (channel, prefix, outcome) => {
      for (const mode of ['auto', 'connection-default', 'never']) {
        hits.length = 0;
        const caller = forwardedCaller(channel, nextSession(prefix));
        const response = await rest(
          'POST',
          '/api/orchestration/commands',
          internalHeaders(
            caller ? { [STATION_CONTROL_CALLER_TOKEN_HEADER]: caller } : {},
          ),
          { type: 'setApprovalMode', threadId: 't', mode },
        );
        if (outcome === 'allowed') {
          expect([mode, response]).toEqual([mode, { status: 200 }]);
          expect(hits).toEqual(['POST /api/orchestration/commands']);
        } else {
          expect([mode, response]).toEqual([
            mode,
            { status: 403, code: outcome },
          ]);
          expect(hits).toEqual([]);
        }
      }
    },
  );

  test('the operator UI still sets an approval mode', async () => {
    expect(
      await rest(
        'POST',
        '/api/orchestration/commands',
        {
          'content-type': 'application/json',
          authorization: `Bearer ${OPERATOR_CREDENTIAL}`,
        },
        { type: 'setApprovalMode', threadId: 't', mode: 'auto' },
      ),
    ).toEqual({ status: 200 });
    expect(refusals).toEqual([]);
  });

  test('other commands keep the dispatch policy, and the operator UI still answers', async () => {
    const bearer = forwardedCaller('bearer-exposed', nextSession('op-'));
    expect(
      await rest(
        'POST',
        '/api/orchestration/commands',
        internalHeaders({ [STATION_CONTROL_CALLER_TOKEN_HEADER]: bearer! }),
        { type: 'interruptTurn', threadId: 't' },
      ),
    ).toEqual({ status: 200 });
    expect(
      await rest(
        'POST',
        '/api/orchestration/commands',
        {
          'content-type': 'application/json',
          authorization: `Bearer ${OPERATOR_CREDENTIAL}`,
        },
        { ...respond, decision: 'accept' },
      ),
    ).toEqual({ status: 200 });
    expect(refusals).toEqual([]);
  });
});

describe('a job a person granted (M1): an agent cannot change what it runs', () => {
  const bound = () =>
    internalHeaders({
      [STATION_CONTROL_CALLER_TOKEN_HEADER]: forwardedCaller(
        'bound',
        nextSession('op-'),
      )!,
    });
  test.each([
    ['prompt', { prompt: 'something else' }],
    ['agent', { agent: 'another-agent' }],
    ['provider', { provider: 'elsewhere' }],
  ] as const)(
    'changing a granted job’s %s is a person’s step even for the bound operator',
    async (_field, change) => {
      expect(
        await rest('PUT', '/scheduler/jobs/granted', bound(), change),
      ).toEqual({ status: 403, code: 'station_control_person_only' });
      expect(hits).toEqual([]);
    },
  );

  test.each([
    ['agentId', { agentId: 'another-agent' }],
    ['projectId', { projectId: 'another-project' }],
    ['target', { target: 'https://github.com/org/other/pull/2' }],
  ] as const)(
    'changing a granted job’s monitor %s is a person’s step even for the bound operator',
    async (_field, change) => {
      const monitor = { ...JOBS[0]!.monitor, ...change };
      expect(
        await rest('PUT', '/scheduler/jobs/granted', bound(), { monitor }),
      ).toEqual({ status: 403, code: 'station_control_person_only' });
      expect(hits).toEqual([]);
    },
  );

  test('other edits, unchanged values, and ungranted jobs stay the operator’s', async () => {
    for (const [target, body] of [
      ['granted', { enabled: false }],
      ['granted', { prompt: 'the reviewed prompt' }],
      ['granted', { monitor: JOBS[0]!.monitor }],
      ['plain', { prompt: 'something else' }],
    ] as const)
      expect(
        await rest('PUT', `/scheduler/jobs/${target}`, bound(), body),
      ).toEqual({ status: 200 });
    expect(hits).toHaveLength(4);
  });

  test('a revoked grant no longer holds the job', async () => {
    const store = new UnattendedGrantStore(makeTempDir('authority-revoked-'));
    const key = principalKey({ kind: 'scheduled-job', jobId: 'job-granted' });
    await store.grantTool(key, 'tool', 'human:local:operator');
    expect(
      await jobEditRetargetsGrantedWork(
        'granted',
        { prompt: 'x' },
        async () => JOBS,
        store,
      ),
    ).toBe(true);
    await store.revokeGrant(key, 'tool');
    expect(
      await jobEditRetargetsGrantedWork(
        'granted',
        { prompt: 'x' },
        async () => JOBS,
        store,
      ),
    ).toBe(false);
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
  test('the raw internal token: reads of nobody’s data and route-enforced leaves pass, every other leaf refuses', async () => {
    const outcomes: Record<string, string> = {};
    const expected: Record<string, string> = {};
    for (const { method, path, owners } of everyToolRoute()) {
      const key = `${method} ${path}`;
      // Independent of the evaluator: the rule as decision 4 states it, read
      // with decision 2 (slice B): a caller-less request acts for no one, so
      // it reads only what no person's view scopes.
      expected[key] = owners.some(
        (owner) =>
          (owner.toolClass === 'read-only' && owner.role === 'none') ||
          owner.enforcedBy === 'route',
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
