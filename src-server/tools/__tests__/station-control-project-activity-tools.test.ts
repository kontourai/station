/**
 * station#3413: the inputs and requests of `list_project_activity` and
 * `get_session_digest`. The schemas are strict and name no Project, owner or
 * host (authority is the verified caller's, never an argument), a bound is
 * refused at the tool before any request is sent, and each tool calls exactly
 * its own leaf with exactly its fields.
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
} from 'vitest';
import type { StationControlCallerRecordResolver } from '../../runtime/mcp/station-control-caller.js';
import { claudeInProcessStationControlOptions } from '../../runtime/mcp/station-control-in-process.js';
import { __resetStationControlMcpTokensForTests } from '../../runtime/mcp/station-control-mcp-token.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../services/identity/principal-resolver.js';

const resolveRecord: StationControlCallerRecordResolver = () => ({
  principal: { id: LOCAL_OPERATOR_PRINCIPAL_ID, source: 'session-owner' },
  localProjectId: 'local-project-a',
  projectIdSource: 'session-record',
  projectSlug: 'project-a',
});

const requests: { method: string; path: string; body?: unknown }[] = [];
type Reply = { status: number; body: unknown };
const OK_REPLY: Reply = { status: 200, body: { success: true, data: {} } };
let reply: Reply = OK_REPLY;
let server: ReturnType<typeof serve>;

beforeAll(async () => {
  const app = new Hono();
  app.all('*', async (c) => {
    const text = await c.req.text();
    requests.push({
      method: c.req.method,
      path: `${c.req.path}${new URL(c.req.url).search}`,
      ...(text ? { body: JSON.parse(text) } : {}),
    });
    return c.json(reply.body as object, reply.status as 200);
  });
  let resolvePort!: (value: number) => void;
  const listening = new Promise<number>((resolve) => {
    resolvePort = resolve;
  });
  server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, (info) =>
    resolvePort((info as AddressInfo).port),
  );
  process.env.STATION_API_BASE = `http://127.0.0.1:${await listening}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.STATION_API_BASE;
});
beforeEach(() => {
  requests.length = 0;
  reply = OK_REPLY;
  __resetStationControlMcpTokensForTests();
});

function memoryTransport() {
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
    for (let i = 0; i < 1_000; i += 1) {
      const found = sent.find((m) => m.id === id);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`no response for ${id}`);
  };
  return { transport, request };
}

async function connect() {
  const options = claudeInProcessStationControlOptions(() => resolveRecord);
  const instance = options.createInProcessStationControl(
    'op-project-activity-tools',
  );
  const { transport, request } = memoryTransport();
  await instance.connect(transport);
  await request(1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'engine', version: '1' },
  });
  let id = 10;
  const call = (name: string, args: Record<string, unknown>) => {
    id += 1;
    return request(id, 'tools/call', { name, arguments: args });
  };
  return { call, request, close: () => instance.close() };
}

const LEAF = '/api/orchestration/session-activity';

describe('the Project activity tools', () => {
  test('are advertised as closed objects with only their own fields', async () => {
    const { request, close } = await connect();
    const listed = await request(2, 'tools/list');
    const tools = listed.result.tools as {
      name: string;
      inputSchema: {
        properties: Record<string, unknown>;
        additionalProperties?: unknown;
        required?: string[];
      };
    }[];
    const expected: Record<string, string[]> = {
      list_project_activity: ['cursor', 'limit'],
      get_session_digest: ['cursor', 'sessionId', 'turnLimit'],
    };
    for (const [name, fields] of Object.entries(expected)) {
      const tool = tools.find((candidate) => candidate.name === name)!;
      expect([name, tool.inputSchema.additionalProperties]).toEqual([
        name,
        false,
      ]);
      expect([name, Object.keys(tool.inputSchema.properties).sort()]).toEqual([
        name,
        fields,
      ]);
    }
    await close();
  });

  test('refuse an unknown or authority-shaped field, and a bound past the maximum, before any request', async () => {
    const { call, close } = await connect();
    const refused: Array<[string, Record<string, unknown>]> = [
      ['list_project_activity', { projectId: 'other-project' }],
      ['list_project_activity', { host: 'another-station' }],
      ['list_project_activity', { limit: 51 }],
      ['list_project_activity', { limit: 0 }],
      ['get_session_digest', { sessionId: 's', ownerId: 'someone' }],
      ['get_session_digest', { sessionId: 's', turnLimit: 26 }],
      ['get_session_digest', { sessionId: 's', turnLimit: 0 }],
      ['get_session_digest', {}],
      ['get_session_digest', { sessionId: 'x'.repeat(513) }],
    ];
    for (const [name, args] of refused) {
      const result = await call(name, args);
      expect([
        name,
        JSON.stringify(args),
        result.error !== undefined || result.result?.isError === true,
      ]).toEqual([name, JSON.stringify(args), true]);
    }
    expect(requests).toEqual([]);
    await close();
  });

  test('call their own leaves with exactly their fields, and the bounds themselves are admitted', async () => {
    const { call, close } = await connect();
    await call('list_project_activity', {});
    await call('list_project_activity', { limit: 50, cursor: 'c1' });
    await call('get_session_digest', { sessionId: 'a/b' });
    await call('get_session_digest', {
      sessionId: 'session-1',
      turnLimit: 25,
      cursor: 'c2',
    });
    expect(requests.map(({ method, path }) => [method, path])).toEqual([
      ['GET', LEAF],
      ['GET', `${LEAF}?limit=50&cursor=c1`],
      ['GET', `${LEAF}/a%2Fb/digest`],
      ['GET', `${LEAF}/session-1/digest?turnLimit=25&cursor=c2`],
    ]);
    await close();
  });

  test('a refusal from Station is an MCP error carrying its code', async () => {
    const { call, close } = await connect();
    reply = {
      status: 404,
      body: {
        success: false,
        code: 'session_not_found',
        error: 'Session not found',
      },
    };
    const result = await call('get_session_digest', { sessionId: 'gone' });
    expect(result.result.isError).toBe(true);
    expect(JSON.parse(result.result.content[0].text)).toMatchObject({
      code: 'session_not_found',
    });
    await close();
  });
});
