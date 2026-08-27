import type { HttpBindings } from '@hono/node-server';
import {
  parseHostedTenantRegistry,
  tenantId,
} from '@kontourai/station-contracts/tenancy';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  __resetStationControlMcpTokensForTests,
  mintStationControlMcpToken,
} from '../../../runtime/mcp/station-control-mcp-token.js';
import {
  createStationControlMcpRoutes,
  STATION_CONTROL_MCP_PATH,
} from '../station-control-mcp-route.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  stationControlMcpHttpAuth: { add: vi.fn() },
  stationControlMcpTokenMinted: { add: vi.fn() },
  tenantExecutionContextAttributes: vi.fn((value) => value),
  tenantExecutionContextOutcomes: { add: vi.fn() },
}));

type TestBindings = HttpBindings & {
  incoming: HttpBindings['incoming'] & {
    socket: HttpBindings['incoming']['socket'] & { remoteAddress?: string };
  };
};

const hostedRegistry = parseHostedTenantRegistry({
  schemaVersion: 1,
  tenants: [{ id: 'alpha', authority: 'alpha.example.test' }],
});
const twoTenantRegistry = parseHostedTenantRegistry({
  schemaVersion: 1,
  tenants: [
    { id: 'alpha', authority: 'alpha.example.test' },
    { id: 'bravo', authority: 'bravo.example.test' },
  ],
});

const basisProjection = {
  version: 'surface.basis-projection/v1',
  answer: {
    owner: { authority: '@kontourai/thread' },
    state: 'available',
    observedAt: '2026-08-25T00:00:00.000Z',
    value: {
      ref: {
        authority: '@kontourai/thread',
        schemaVersion: '1.2.0',
        kind: 'assistant-message',
        standing: 'observed',
        threadId: 'session-a',
        messageId: 'message-a',
      },
      fact: 'answer-observed',
      observedAt: '2026-08-25T00:00:00.000Z',
    },
  },
  standing: 'execution-only',
  unresolvedReason: null,
  assessment: {
    owner: { authority: '@kontourai/surface' },
    state: 'not-captured',
    observedAt: '2026-08-25T00:00:00.000Z',
  },
  regions: {
    inputs: [],
    execution: [],
    process: [],
    outcomes: [],
    support: [],
    sources: [],
    live: [],
  },
  relationships: [],
  gaps: [],
};

function envFor(remoteAddress: string | undefined): TestBindings {
  return { incoming: { socket: { remoteAddress } } } as TestBindings;
}

/** Extract the first JSON-RPC payload from an SSE (`text/event-stream`) or
 * plain-JSON streamable-HTTP response body. */
async function readJsonRpcResult(response: Response): Promise<any> {
  const text = await response.text();
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return JSON.parse(text);
  }
  const dataLine = text.split('\n').find((line) => line.startsWith('data: '));
  if (!dataLine) {
    throw new Error(`No SSE data line in response body: ${text}`);
  }
  return JSON.parse(dataLine.slice('data: '.length));
}

async function initializeMcpSession(
  app: ReturnType<typeof createStationControlMcpRoutes>,
  url: string,
  env: TestBindings,
): Promise<{ result: any; response: Response }> {
  const response = await app.request(
    url,
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
          clientInfo: { name: 'test', version: '0' },
        },
      }),
    },
    env,
  );
  const result = await readJsonRpcResult(response);
  return { result, response };
}

async function callMcp(
  app: ReturnType<typeof createStationControlMcpRoutes>,
  url: string,
  env: TestBindings,
  id: number,
  method: string,
  params: Record<string, unknown> = {},
) {
  const response = await app.request(
    url,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    },
    env,
  );
  return readJsonRpcResult(response);
}

async function discoverModernMcpServer(
  app: ReturnType<typeof createStationControlMcpRoutes>,
  url: string,
  env: TestBindings,
): Promise<{ result: any; response: Response }> {
  const response = await app.request(
    url,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'server/discover',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'server/discover',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': {
              name: 'station-control-route-test',
              version: '1.0.0',
            },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    },
    env,
  );
  const result = await readJsonRpcResult(response);
  return { result, response };
}

describe('station-control-mcp-route', () => {
  const LOOPBACK = '127.0.0.1';
  const TEST_PORT = 4321;
  let originalStationApiBase: string | undefined;
  let originalStationPort: string | undefined;
  let originalPort: string | undefined;

  beforeEach(() => {
    __resetStationControlMcpTokensForTests();
    originalStationApiBase = process.env.STATION_API_BASE;
    originalStationPort = process.env.STATION_PORT;
    originalPort = process.env.PORT;
  });
  afterEach(() => {
    __resetStationControlMcpTokensForTests();
    vi.unstubAllGlobals();
    // The route deliberately sets these two on every request (review fix,
    // station#1195 round 1, MEDIUM) — restore whatever this suite's OTHER
    // tests (or a sibling test file sharing this worker) expect.
    if (originalStationApiBase === undefined) {
      delete process.env.STATION_API_BASE;
    } else {
      process.env.STATION_API_BASE = originalStationApiBase;
    }
    if (originalStationPort === undefined) {
      delete process.env.STATION_PORT;
    } else {
      process.env.STATION_PORT = originalStationPort;
    }
    if (originalPort === undefined) {
      delete process.env.PORT;
    } else {
      process.env.PORT = originalPort;
    }
  });

  test('rejects a request with no token', async () => {
    const app = createStationControlMcpRoutes({ port: TEST_PORT });
    const response = await app.request(
      STATION_CONTROL_MCP_PATH,
      { method: 'POST' },
      envFor(LOOPBACK),
    );
    expect(response.status).toBe(401);
  });

  test('rejects a request with an invalid token', async () => {
    mintStationControlMcpToken('thread-1', 'url-token');
    const app = createStationControlMcpRoutes({ port: TEST_PORT });
    const response = await app.request(
      `${STATION_CONTROL_MCP_PATH}?token=wrong-token`,
      { method: 'POST' },
      envFor(LOOPBACK),
    );
    expect(response.status).toBe(401);
  });

  test('rejects a request from a non-loopback peer even with a valid token', async () => {
    const { token } = mintStationControlMcpToken('thread-1', 'url-token');
    const app = createStationControlMcpRoutes({ port: TEST_PORT });
    const response = await app.request(
      `${STATION_CONTROL_MCP_PATH}?token=${token}`,
      { method: 'POST' },
      envFor('203.0.113.5'),
    );
    expect(response.status).toBe(404);
  });

  test('accepts a valid token from loopback and completes MCP initialize', async () => {
    const { token } = mintStationControlMcpToken('thread-1', 'url-token');
    const app = createStationControlMcpRoutes({ port: TEST_PORT });
    const { result, response } = await initializeMcpSession(
      app,
      `${STATION_CONTROL_MCP_PATH}?token=${token}`,
      envFor(LOOPBACK),
    );
    expect(response.status).toBe(200);
    expect(result.result.serverInfo.name).toBe('station-control');
  });

  test('natively discovers as a 2026-07-28 server while retaining legacy initialize', async () => {
    const { token } = mintStationControlMcpToken('thread-modern', 'url-token');
    const app = createStationControlMcpRoutes({ port: TEST_PORT });
    const { result, response } = await discoverModernMcpServer(
      app,
      `${STATION_CONTROL_MCP_PATH}?token=${token}`,
      envFor(LOOPBACK),
    );

    expect(response.status).toBe(200);
    expect(result.result).toMatchObject({
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: { listChanged: true } },
      _meta: {
        'io.modelcontextprotocol/serverInfo': {
          name: 'station-control',
          version: '2.0.0',
        },
      },
    });
  });

  test('accepts a valid token presented as an Authorization bearer header', async () => {
    const { token } = mintStationControlMcpToken('thread-1', 'url-token');
    const app = createStationControlMcpRoutes({ port: TEST_PORT });
    const response = await app.request(
      STATION_CONTROL_MCP_PATH,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'test', version: '0' },
          },
        }),
      },
      envFor(LOOPBACK),
    );
    expect(response.status).toBe(200);
  });

  test('a real station-control tool (list_agents) is reachable and reflects Station API data through the HTTP MCP endpoint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/agents')) {
          return new Response(
            JSON.stringify([{ slug: 'writer', name: 'Writer' }]),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('{}', { status: 200 });
      }),
    );

    const { token } = mintStationControlMcpToken('thread-1', 'url-token');
    const app = createStationControlMcpRoutes({ port: TEST_PORT });

    await initializeMcpSession(
      app,
      `${STATION_CONTROL_MCP_PATH}?token=${token}`,
      envFor(LOOPBACK),
    );

    const callResponse = await app.request(
      `${STATION_CONTROL_MCP_PATH}?token=${token}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'list_agents', arguments: {} },
        }),
      },
      envFor(LOOPBACK),
    );
    const result = await readJsonRpcResult(callResponse);
    const text = result.result.content[0].text;
    expect(JSON.parse(text)).toEqual([{ slug: 'writer', name: 'Writer' }]);
  });

  test('SECURITY/review fix (station#1195 MEDIUM): resolves the in-process tool call against the ACTUAL bound port, never DEFAULT_SERVER_PORT (3141), even when process.env.PORT/STATION_PORT are absent or wrong (desktop-spawner PORT=0/STATION_PORT_MODE=auto path)', async () => {
    // Simulate index.ts's auto-allocate path exactly: PORT/STATION_PORT are
    // never written back to process.env once the real port is resolved
    // (index.ts keeps it in a local variable) — and, for good measure,
    // simulate a stale/wrong PORT value too, proving STATION_API_BASE
    // (highest priority in resolveControlApiBase's fallback chain) wins
    // regardless.
    delete process.env.STATION_API_BASE;
    delete process.env.STATION_PORT;
    process.env.PORT = '3141'; // DEFAULT_SERVER_PORT — deliberately wrong.

    const ACTUAL_BOUND_PORT = 58231;
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/agents')) {
        return new Response('[]', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { token } = mintStationControlMcpToken('thread-1', 'url-token');
    const app = createStationControlMcpRoutes({ port: ACTUAL_BOUND_PORT });

    await initializeMcpSession(
      app,
      `${STATION_CONTROL_MCP_PATH}?token=${token}`,
      envFor(LOOPBACK),
    );
    const callResponse = await app.request(
      `${STATION_CONTROL_MCP_PATH}?token=${token}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'list_agents', arguments: {} },
        }),
      },
      envFor(LOOPBACK),
    );
    await readJsonRpcResult(callResponse);

    expect(fetchMock).toHaveBeenCalled();
    const calledUrl = fetchMock.mock.calls[0][0].toString();
    expect(calledUrl).toContain(`127.0.0.1:${ACTUAL_BOUND_PORT}`);
    expect(calledUrl).not.toContain(':3141');
  });

  test('a same-id impostor is never reachable via this route: it only ever serves the real registered station-control tools, regardless of the caller', async () => {
    const { token } = mintStationControlMcpToken('thread-1', 'url-token');
    const app = createStationControlMcpRoutes({ port: TEST_PORT });
    const { result } = await initializeMcpSession(
      app,
      `${STATION_CONTROL_MCP_PATH}?token=${token}`,
      envFor(LOOPBACK),
    );
    // The endpoint always connects the SAME McpServer built from Station's
    // own registerAgentTools/etc — there is no way for a caller to make it
    // serve a different tool set, so an "impostor" tool identity is
    // structurally impossible at this layer (the impostor-rejection gate
    // this ticket's AC5 names lives at resolution, session-agent-resolution
    // .test.ts covers it; this route has no server identity input at all).
    expect(result.result.serverInfo.name).toBe('station-control');
  });

  test('requires a registry-valid token-bound tenant in hosted mode but retains personal token-only behavior', async () => {
    const { token: unboundToken } = mintStationControlMcpToken(
      'thread-1',
      'url-token',
    );
    const hosted = createStationControlMcpRoutes({
      port: TEST_PORT,
      hostedTenantRegistry: hostedRegistry,
    });
    const denied = await hosted.request(
      `${STATION_CONTROL_MCP_PATH}?token=${unboundToken}`,
      {},
      envFor(LOOPBACK),
    );
    expect(denied.status).toBe(421);

    const { token: boundToken } = mintStationControlMcpToken(
      'thread-2',
      'url-token',
      undefined,
      { tenantId: 'alpha' as any, source: 'request' },
    );
    const allowed = await hosted.request(
      `${STATION_CONTROL_MCP_PATH}?token=${boundToken}`,
      {},
      envFor(LOOPBACK),
    );
    expect(allowed.status).not.toBe(421);

    const personal = createStationControlMcpRoutes({ port: TEST_PORT });
    const allowedPersonal = await personal.request(
      `${STATION_CONTROL_MCP_PATH}?token=${unboundToken}`,
      {},
      envFor(LOOPBACK),
    );
    expect(allowedPersonal.status).not.toBe(421);
  });

  test('publishes the official Basis App resource and keeps concurrent tenant tool calls isolated', async () => {
    const tenantHeaders: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        tenantHeaders.push(headers.get('x-station-internal-tenant') ?? 'none');
        return new Response(
          JSON.stringify({ success: true, data: basisProjection }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const app = createStationControlMcpRoutes({
      port: TEST_PORT,
      hostedTenantRegistry: twoTenantRegistry,
    });
    const tokenFor = (tenant: 'alpha' | 'bravo') =>
      mintStationControlMcpToken(`thread-${tenant}`, 'url-token', undefined, {
        tenantId: tenantId(tenant),
        source: 'request',
      }).token;
    const alphaUrl = `${STATION_CONTROL_MCP_PATH}?token=${tokenFor('alpha')}`;
    const tools = await callMcp(
      app,
      alphaUrl,
      envFor(LOOPBACK),
      40,
      'tools/list',
    );
    expect(tools.result.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'get_basis',
          annotations: expect.objectContaining({ readOnlyHint: true }),
          _meta: expect.objectContaining({
            ui: expect.objectContaining({
              resourceUri: 'ui://station/basis/v1',
              visibility: ['model'],
            }),
            'ui/resourceUri': 'ui://station/basis/v1',
          }),
        }),
      ]),
    );
    const resources = await callMcp(
      app,
      alphaUrl,
      envFor(LOOPBACK),
      41,
      'resources/list',
    );
    expect(resources.result.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          uri: 'ui://station/basis/v1',
          mimeType: 'text/html;profile=mcp-app',
          _meta: expect.objectContaining({ ui: expect.any(Object) }),
        }),
      ]),
    );
    const read = await callMcp(
      app,
      alphaUrl,
      envFor(LOOPBACK),
      42,
      'resources/read',
      { uri: 'ui://station/basis/v1' },
    );
    expect(read.result.contents[0]).toMatchObject({
      uri: 'ui://station/basis/v1',
      mimeType: 'text/html;profile=mcp-app',
    });
    expect(
      Buffer.byteLength(read.result.contents[0].text, 'utf8'),
    ).toBeLessThanOrEqual(500 * 1024);

    await Promise.all(
      (['alpha', 'bravo'] as const).map((tenant, index) =>
        callMcp(
          app,
          `${STATION_CONTROL_MCP_PATH}?token=${tokenFor(tenant)}`,
          envFor(LOOPBACK),
          50 + index,
          'tools/call',
          {
            name: 'get_basis',
            arguments: {
              scope: 'answer',
              sessionId: `session-${tenant}`,
              turnId: `turn-${tenant}`,
            },
          },
        ),
      ),
    );
    expect(tenantHeaders.sort()).toEqual(['alpha', 'bravo']);
  });
});
