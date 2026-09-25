/**
 * #2584 (S2 of #2582): `notify_user` end to end through a real listening
 * server — the production runtime security boundary (`configureRuntimeHttp`),
 * the production station-control MCP route and in-process Claude delivery
 * serving the REAL tool registrations, the production caller projection, the
 * agent notification route, the legacy notification routes, a real
 * NotificationService store, and the real Web Push fan-out listener on the
 * same EventBus. Only the push transport and the device list are fakes.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { readNotificationEnvelope } from '@kontourai/station-shared/notification-envelope';
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
import { configureRuntimeHttp } from '../../../runtime/bootstrap/runtime-http.js';
import {
  isAgentOriginatedRequest,
  resolveStationControlCallerForRequest,
  type StationControlCallerRecordResolver,
} from '../../../runtime/mcp/station-control-caller.js';
import { claudeInProcessStationControlOptions } from '../../../runtime/mcp/station-control-in-process.js';
import {
  __resetStationControlMcpTokensForTests,
  mintStationControlMcpHeaderAuth,
  mintStationControlMcpToken,
} from '../../../runtime/mcp/station-control-mcp-token.js';
import { isStationInternalRequest } from '../../../services/browser/browser-request-origin.js';
import {
  AgentNotificationGate,
  scheduleAgentNotificationVia,
} from '../../../services/notifications/agent-notification-gate.js';
import { NotificationService } from '../../../services/notifications/notification-service.js';
import { wireWebPushDelivery } from '../../../services/notifications/web-push-delivery.js';
import type { WebPushService } from '../../../services/notifications/web-push-service.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import {
  NOTIFY_USER_DESCRIPTION,
  notifyUser,
} from '../../../tools/station-control-notify-tools.js';
import {
  __resetStationControlStdioCallerCredentialForTests,
  installStationControlStdioCallerCredential,
  STATION_CONTROL_CALLER_TOKEN_HEADER,
  STATION_CONTROL_ORIGIN_AGENT_TOOL,
  STATION_CONTROL_ORIGIN_HEADER,
} from '../../../tools/station-control-shared.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_PROXY_CALLER_HEADER,
} from '../../../utils/internal-api-token.js';
import type { Logger } from '../../../utils/logger.js';
import { createStationControlCallerRoutes } from '../../mcp/station-control-caller-route.js';
import {
  createStationControlMcpRoutes,
  STATION_CONTROL_MCP_PATH,
} from '../../mcp/station-control-mcp-route.js';
import { createAgentNotificationRoutes } from '../agent-notifications.js';
import { createNotificationRoutes } from '../notifications.js';

const OPERATOR_CREDENTIAL = 'test-only-operator-credential-notify-suite';
const AGENT_PATH = '/api/notifications/agent';

const resolveRecord: StationControlCallerRecordResolver = (sessionId) => ({
  conversationId: `conversation-${sessionId}`,
  localProjectId: 'local-project-a',
  projectIdSource: 'session-record',
  projectSlug: 'project-a',
});

let server: ReturnType<typeof serve>;
let baseUrl: string;
let storeDir: string;
let service: NotificationService;
let gate: AgentNotificationGate;
const pushSend = vi.fn<WebPushService['send']>(async () => 'sent');

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
  storeDir = mkdtempSync(join(tmpdir(), 'agent-notifications-routes-'));
  const eventBus = new EventBus();
  service = new NotificationService(eventBus, storeDir, 999_999);
  wireWebPushDelivery(
    eventBus,
    {
      listPushSubscriptions: () => [
        {
          deviceId: 'phone',
          subscription: {
            endpoint: 'https://push.example.test/subscription/phone',
            keys: { p256dh: 'p256dh', auth: 'auth' },
          },
        },
      ],
      clearPushSubscription: () => {},
    },
    { send: pushSend },
    quietLogger(),
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
  process.env.STATION_API_BASE = baseUrl;
  // The production MCP server factory: every real station-control tool.
  app.route(
    '',
    createStationControlMcpRoutes({ port, resolveCallerRecord: resolveRecord }),
  );
  app.route(
    '/api/orchestration',
    createStationControlCallerRoutes({ resolveRecord }),
  );
  app.route(
    '/notifications',
    createNotificationRoutes(service, { isAgentOriginatedRequest }),
  );
  app.route(
    AGENT_PATH,
    createAgentNotificationRoutes({
      isInternalRequest: isStationInternalRequest,
      resolveCaller: (request) =>
        resolveStationControlCallerForRequest(request, resolveRecord),
      // Fresh per test (beforeEach), so one test's sends never rate-limit
      // another's.
      gate: { notify: (caller, request) => gate.notify(caller, request) },
    }),
  );
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await service.shutdown();
  rmSync(storeDir, { recursive: true, force: true });
  delete process.env.STATION_API_BASE;
});

beforeEach(async () => {
  __resetStationControlMcpTokensForTests();
  __resetStationControlStdioCallerCredentialForTests();
  await service.clearAll(() => true);
  pushSend.mockClear();
  gate = new AgentNotificationGate({
    schedule: scheduleAgentNotificationVia(service),
    isHosted: () => false,
  });
});

async function readJsonRpc(response: Response): Promise<any> {
  const text = await response.text();
  if ((response.headers.get('content-type') ?? '').includes('application/json'))
    return JSON.parse(text);
  const dataLine = text.split('\n').find((line) => line.startsWith('data: '));
  if (!dataLine) throw new Error(`No SSE data line: ${text}`);
  return JSON.parse(dataLine.slice('data: '.length));
}

/** An engine speaking HTTP MCP: Codex (`?token=`) or ACP (bearer header). */
function httpEngine(credential: { query?: string; bearer?: string }) {
  const url = `${baseUrl}${STATION_CONTROL_MCP_PATH}${
    credential.query ? `?token=${encodeURIComponent(credential.query)}` : ''
  }`;
  return async (id: number, method: string, params = {}) => {
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

/** The Claude Agent SDK's side of an in-process (`type: 'sdk'`) server. */
function sdkSideTransport() {
  const sent: any[] = [];
  const transport: any = {
    start: async () => {},
    close: async () => {},
    send: async (message: unknown) => {
      sent.push(message);
    },
  };
  const request = async (id: number, method: string, params = {}) => {
    setImmediate(() =>
      transport.onmessage({ jsonrpc: '2.0', id, method, params }),
    );
    for (let i = 0; i < 300; i += 1) {
      const found = sent.find((m) => m.id === id);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`no response for ${id}`);
  };
  return { transport, request };
}

type Engine = (id: number, method: string, params?: object) => Promise<any>;

async function listAndNotify(engine: Engine, title: string) {
  await engine(1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'engine', version: '1' },
  });
  const listed = await engine(2, 'tools/list');
  const tool = listed.result.tools.find(
    (candidate: { name: string }) => candidate.name === 'notify_user',
  );
  const call = await engine(3, 'tools/call', {
    name: 'notify_user',
    arguments: { title, urgency: 'attention' },
  });
  return { tool, result: JSON.parse(call.result.content[0].text) };
}

function internalHeaders(extra: Record<string, string> = {}) {
  return {
    'content-type': 'application/json',
    [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
    [INTERNAL_PROXY_CALLER_HEADER]: 'local',
    ...extra,
  };
}

async function postAgentRoute(headers: Record<string, string>) {
  return fetch(`${baseUrl}${AGENT_PATH}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title: 'Forged', urgency: 'attention' }),
  });
}

describe('notify_user reaches every engine delivery path', () => {
  test('Codex (URL token over HTTP MCP): listed with the design description, and a call is stored as a bearer-exposed agent notification', async () => {
    const { token } = mintStationControlMcpToken('codex-session', 'url-token');
    const { tool, result } = await listAndNotify(
      httpEngine({ query: token }),
      'Need approval to run migration',
    );
    expect(tool).toMatchObject({
      name: 'notify_user',
      description: NOTIFY_USER_DESCRIPTION,
    });
    expect(Object.keys(tool.inputSchema.properties).sort()).toEqual([
      'body',
      'dedupeKey',
      'link',
      'title',
      'urgency',
    ]);
    expect(result).toEqual({
      status: 'sent',
      notificationId: expect.any(String),
    });
    const [stored] = await service.list();
    expect(stored.id).toBe(result.notificationId);
    expect(readNotificationEnvelope(stored)?.source).toEqual({
      kind: 'agent',
      sessionId: 'codex-session',
      projectId: 'local-project-a',
      conversationId: 'conversation-codex-session',
      assurance: 'bearer-exposed',
    });
  });

  test('ACP (header token over HTTP MCP): listed and delivered with its own session and assurance', async () => {
    const { token } = mintStationControlMcpHeaderAuth(4321, 'acp-session');
    const { tool, result } = await listAndNotify(
      httpEngine({ bearer: token }),
      'Tests failed on fix-login',
    );
    expect(tool?.name).toBe('notify_user');
    expect(result.status).toBe('sent');
    const [stored] = await service.list();
    expect(readNotificationEnvelope(stored)?.source).toMatchObject({
      sessionId: 'acp-session',
      assurance: 'delegated-custody',
    });
  });

  test('Claude (in-process SDK server): listed and delivered as a bound caller; after revocation the tool answers caller-required', async () => {
    const options = claudeInProcessStationControlOptions(() => resolveRecord);
    const instance = options.createInProcessStationControl('claude-session');
    const { transport, request } = sdkSideTransport();
    await instance.connect(transport);
    const { tool, result } = await listAndNotify(request, 'Build finished');
    expect(tool?.description).toBe(NOTIFY_USER_DESCRIPTION);
    expect(result.status).toBe('sent');
    expect(
      readNotificationEnvelope((await service.list())[0])?.source,
    ).toMatchObject({ sessionId: 'claude-session', assurance: 'bound' });

    options.revokeStationControlCallerToken('claude-session');
    const after = await request(4, 'tools/call', {
      name: 'notify_user',
      arguments: { title: 'After revoke' },
    });
    expect(JSON.parse(after.result.content[0].text)).toEqual({
      status: 'caller-required',
    });
    expect(await service.list()).toHaveLength(1);
    await instance.close();
  });

  test('a pooled stdio child (no per-session credential) gets caller-required and nothing is stored', async () => {
    installStationControlStdioCallerCredential({});
    expect(await notifyUser({ title: 'Anyone there?' })).toEqual({
      status: 'caller-required',
    });
    expect(await service.list()).toEqual([]);
  });
});

describe('the route re-verifies the forwarded caller', () => {
  test('a missing or forged caller credential is refused with caller-required, even from the internal principal', async () => {
    const missing = await postAgentRoute(internalHeaders());
    expect(missing.status).toBe(403);
    expect(await missing.json()).toEqual({ status: 'caller-required' });
    const forged = await postAgentRoute(
      internalHeaders({ [STATION_CONTROL_CALLER_TOKEN_HEADER]: 'forged' }),
    );
    expect(forged.status).toBe(403);
    expect(await forged.json()).toEqual({ status: 'caller-required' });
    expect(await service.list()).toEqual([]);
  });

  test('a live credential is accepted (control for the refusals above)', async () => {
    const { token } = mintStationControlMcpToken('route-session', 'url-token');
    const accepted = await postAgentRoute(
      internalHeaders({ [STATION_CONTROL_CALLER_TOKEN_HEADER]: token }),
    );
    expect(accepted.status).toBe(200);
    expect(((await accepted.json()) as { status: string }).status).toBe('sent');
  });

  test('an operator credential gets 404 even carrying a live caller credential', async () => {
    const { token } = mintStationControlMcpToken('route-session', 'url-token');
    const response = await postAgentRoute({
      'content-type': 'application/json',
      authorization: `Bearer ${OPERATOR_CREDENTIAL}`,
      [STATION_CONTROL_CALLER_TOKEN_HEADER]: token,
    });
    expect(response.status).toBe(404);
    expect(await service.list()).toEqual([]);
  });
});

describe('POST /notifications refuses agents and still serves people', () => {
  const body = JSON.stringify({
    category: 'job-failure',
    title: 'Nightly failed',
    source: 'scheduler',
  });

  test('an agent-originated request (origin marker or caller credential) gets 403 pointing at notify_user', async () => {
    const markers: Array<Record<string, string>> = [
      { [STATION_CONTROL_ORIGIN_HEADER]: STATION_CONTROL_ORIGIN_AGENT_TOOL },
      { [STATION_CONTROL_CALLER_TOKEN_HEADER]: 'anything' },
    ];
    for (const marker of markers) {
      const response = await fetch(`${baseUrl}/notifications`, {
        method: 'POST',
        headers: internalHeaders(marker),
        body,
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        code: 'agent_notification_requires_tool',
        error: expect.stringContaining('notify_user'),
      });
    }
    expect(await service.list()).toEqual([]);
  });

  test("the operator's own internal client and an operator credential still create notifications", async () => {
    const internal = await fetch(`${baseUrl}/notifications`, {
      method: 'POST',
      headers: internalHeaders(),
      body,
    });
    expect(internal.status).toBe(201);
    const operator = await fetch(`${baseUrl}/notifications`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${OPERATOR_CREDENTIAL}`,
      },
      body,
    });
    expect(operator.status).toBe(201);
    expect(await service.list()).toHaveLength(2);
  });
});

describe('agent notifications stay out of the legacy Web Push fan-out (#2586)', () => {
  test('an agent notification is delivered in-app but never pushed; a classified system notification on the same bus still is', async () => {
    for (const urgency of ['info', 'attention', 'done', 'failed']) {
      // One session per urgency: a root's burst is three.
      const { token } = mintStationControlMcpToken(
        `push-${urgency}`,
        'url-token',
      );
      const response = await fetch(`${baseUrl}${AGENT_PATH}`, {
        method: 'POST',
        headers: internalHeaders({
          [STATION_CONTROL_CALLER_TOKEN_HEADER]: token,
        }),
        body: JSON.stringify({ title: `Agent ${urgency}`, urgency }),
      });
      expect(((await response.json()) as { status: string }).status).toBe(
        'sent',
      );
    }
    const control = await fetch(`${baseUrl}/notifications`, {
      method: 'POST',
      headers: internalHeaders(),
      body: JSON.stringify({
        category: 'job-failure',
        title: 'Nightly failed',
      }),
    });
    expect(control.status).toBe(201);
    await vi.waitFor(() => expect(pushSend).toHaveBeenCalledTimes(1));
    // Let any late agent push surface before asserting there was none.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pushSend).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(pushSend.mock.calls[0])).toContain('Nightly failed');
    expect(JSON.stringify(pushSend.mock.calls)).not.toContain('Agent');
  });
});
