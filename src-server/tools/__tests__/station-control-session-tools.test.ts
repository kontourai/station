/**
 * #3160: the Session tools' inputs. The schemas are strict and carry no
 * approval mode, model or environment, so the posture rule (a non-bound
 * caller may not carry one, #2377 C3b) can never apply to them: an extra
 * field is refused at the tool, before any request reaches Station.
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
import { stationControlToolCatalog } from '../station-control-mcp-server.js';
import {
  interruptSessionInputSchema,
  sendToSessionInputSchema,
  waitSessionInputSchema,
} from '../station-control-session-tools.js';

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
  const instance = options.createInProcessStationControl('op-session-tools');
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

const send = {
  sessionId: 'session-1',
  text: 'hello',
  mode: 'auto',
  requestKey: 'key-0000001',
};
const FORBIDDEN_FIELDS = [
  'approvalMode',
  'setApprovalMode',
  'setApprovalModeBasedOn',
  'model',
  'modelOptions',
  'environment',
  'environmentId',
  'permissionMode',
];

describe('the Session tool schemas are strict and carry no approval, model or environment', () => {
  const schemas = {
    send_to_session: sendToSessionInputSchema,
    interrupt_session: interruptSessionInputSchema,
    wait_session: waitSessionInputSchema,
  };
  const valid = {
    send_to_session: send,
    interrupt_session: { sessionId: 'session-1', requestKey: 'key-0000002' },
    wait_session: { sessionId: 'session-1', until: 'idle' },
  };

  test.each(Object.keys(schemas))('%s refuses every extra field', (name) => {
    const schema = schemas[name as keyof typeof schemas];
    const base = valid[name as keyof typeof valid];
    expect(schema.safeParse(base).success).toBe(true);
    for (const field of FORBIDDEN_FIELDS)
      expect([
        field,
        schema.safeParse({ ...base, [field]: 'auto' }).success,
      ]).toEqual([field, false]);
    expect(schema.safeParse({ ...base, anythingElse: 1 }).success).toBe(false);
  });

  test('the registered tools advertise a closed object with only their own fields', async () => {
    const { request, close } = await connect();
    const listed = await request(2, 'tools/list');
    const tools = listed.result.tools as {
      name: string;
      inputSchema: {
        properties: Record<string, unknown>;
        additionalProperties?: unknown;
      };
    }[];
    const expected: Record<string, string[]> = {
      send_to_session: ['mode', 'requestKey', 'sessionId', 'text'],
      interrupt_session: ['requestKey', 'sessionId', 'turnId'],
      wait_session: ['afterEventCursor', 'sessionId', 'timeoutMs', 'until'],
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

  test('a call carrying an approval mode, model or environment never reaches Station', async () => {
    const { call, close } = await connect();
    for (const field of FORBIDDEN_FIELDS) {
      const result = await call('send_to_session', {
        ...send,
        [field]: 'auto',
      });
      expect([field, requests.length]).toEqual([field, 0]);
      expect([
        field,
        result.error !== undefined || result.result?.isError === true,
      ]).toEqual([field, true]);
    }
    await close();
  });

  test('wait is capped at 50 s and text at the chat input limit', () => {
    expect(
      waitSessionInputSchema.safeParse({
        sessionId: 's',
        until: 'idle',
        timeoutMs: 50_000,
      }).success,
    ).toBe(true);
    expect(
      waitSessionInputSchema.safeParse({
        sessionId: 's',
        until: 'idle',
        timeoutMs: 50_001,
      }).success,
    ).toBe(false);
    expect(
      sendToSessionInputSchema.safeParse({ ...send, text: 'x'.repeat(200_000) })
        .success,
    ).toBe(true);
    expect(
      sendToSessionInputSchema.safeParse({ ...send, text: 'x'.repeat(200_001) })
        .success,
    ).toBe(false);
    expect(
      sendToSessionInputSchema.safeParse({ ...send, requestKey: 'short' })
        .success,
    ).toBe(false);
  });
});

describe('the Session tools are listed in the Chats group', () => {
  test('the catalog groups send, interrupt and wait with Chats, wait as read-only', () => {
    const catalog = stationControlToolCatalog();
    const entry = (name: string) => catalog.find((tool) => tool.name === name);
    for (const name of ['send_to_session', 'interrupt_session', 'wait_session'])
      expect([name, entry(name)?.group]).toEqual([name, 'Chats']);
    expect(entry('wait_session')?.readOnly).toBe(true);
    expect(entry('send_to_session')?.readOnly).toBe(false);
    expect(entry('interrupt_session')?.readOnly).toBe(false);
  });
});

describe('the Session tools call their own leaves with exactly their fields', () => {
  test('send, interrupt and wait', async () => {
    const { call, close } = await connect();
    await call('send_to_session', {
      sessionId: 'session-1',
      text: ' hello ',
      requestKey: 'key-0000001',
    });
    await call('interrupt_session', {
      sessionId: 'session-1',
      requestKey: 'key-0000002',
    });
    await call('wait_session', {
      sessionId: 'session/1',
      until: 'turn-settled',
      afterEventCursor: 4,
    });
    expect(requests).toEqual([
      {
        method: 'POST',
        path: '/api/orchestration/session-control/send',
        body: {
          sessionId: 'session-1',
          text: 'hello',
          mode: 'auto',
          requestKey: 'key-0000001',
        },
      },
      {
        method: 'POST',
        path: '/api/orchestration/session-control/interrupt',
        body: { sessionId: 'session-1', requestKey: 'key-0000002' },
      },
      {
        method: 'GET',
        path: '/api/orchestration/session-control/session%2F1/wait?until=turn-settled&timeoutMs=30000&afterEventCursor=4',
      },
    ]);
    await close();
  });
});

describe('wait_session answers a refusal as an MCP error and a timeout as a result (#2795)', () => {
  const wait = { sessionId: 'session-1', until: 'idle' };
  const toolResult = (response: any) => response.result;

  // A refusal the route words as `success: false` must be `isError`: the
  // native invoke route and every MCP host see a failed tool only by it.
  test.each([
    ['a Session the owner may not read', 404, 'not_found'],
    ['a station-wide wait capacity refusal', 429, 'wait_capacity'],
    ['a cancelled wait', 408, 'wait_aborted'],
    ['a rejected query', 400, 'invalid_request'],
  ] as const)(
    '%s is an MCP error carrying its code',
    async (_name, status, code) => {
      reply = { status, body: { success: false, code, error: 'refused' } };
      const { call, close } = await connect();
      const result = toolResult(await call('wait_session', wait));
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        success: false,
        code,
      });
      expect(requests).toHaveLength(1);
      await close();
    },
  );

  // A wait that ran its full time with the turn still running did what it was
  // asked: it observed the Session. `timedOut: true` is the answer, not a
  // failure, so it is NOT an error and carries its own flag.
  test('a timeout with the turn still running is a result, not an error', async () => {
    reply = {
      status: 200,
      body: {
        success: true,
        data: { sessionId: 'session-1', settled: false, timedOut: true },
      },
    };
    const { call, close } = await connect();
    const result = toolResult(await call('wait_session', wait));
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text).data).toMatchObject({
      settled: false,
      timedOut: true,
    });
    await close();
  });
});
