/**
 * #3161: the `declare_pull_request` tool through the real MCP server (an
 * in-process station-control connection, as an engine holds), against a
 * recording Station. What is proved is what the tool sends and what it will
 * not: the exact identity and nothing that names a session, a turn or a call,
 * and the group the tool is listed under.
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
import { INTERNAL_API_TOKEN_HEADER } from '../../utils/internal-api-token.js';
import { stationControlToolCatalog } from '../station-control-mcp-server.js';

const resolveRecord: StationControlCallerRecordResolver = () => ({
  principal: { id: LOCAL_OPERATOR_PRINCIPAL_ID, source: 'session-owner' },
  localProjectId: 'local-project-a',
  projectIdSource: 'session-record',
  projectSlug: 'project-a',
});

const LEAF = '/api/orchestration/station-control/declare-pull-request';
const recorded: { path: string; body: unknown; internal: boolean }[] = [];
let answer: unknown = { status: 'declared' };
let server: ReturnType<typeof serve>;

beforeAll(async () => {
  const app = new Hono();
  app.all('*', async (c) => {
    recorded.push({
      path: c.req.path,
      internal: c.req.header(INTERNAL_API_TOKEN_HEADER) !== undefined,
      body: c.req.method === 'POST' ? await c.req.json() : undefined,
    });
    return c.json(answer as never);
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
  __resetStationControlMcpTokensForTests();
  recorded.length = 0;
  answer = { status: 'declared' };
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
  const instance = options.createInProcessStationControl('op-declare-tool');
  const { transport, request } = memoryTransport();
  await instance.connect(transport);
  await request(1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'engine', version: '1' },
  });
  let id = 10;
  return {
    close: () => instance.close(),
    call: (args: Record<string, unknown>) => {
      id += 1;
      return request(id, 'tools/call', {
        name: 'declare_pull_request',
        arguments: args,
      });
    },
    list: () => {
      id += 1;
      return request(id, 'tools/list');
    },
  };
}

const PR = {
  provider: 'github',
  host: 'github.com',
  repository: { owner: 'owner', name: 'repo' },
  ref: '42',
};

describe('declare_pull_request tool', () => {
  test('sends the identity to its own leaf, and returns the answer as the tool result', async () => {
    const client = await connect();
    const reply = await client.call({ ...PR, label: 'The fix' });
    expect(recorded.filter((entry) => entry.internal)).toEqual([
      {
        path: LEAF,
        internal: true,
        body: { ...PR, label: 'The fix' },
      },
    ]);
    expect(reply.result.isError).not.toBe(true);
    expect(JSON.parse(reply.result.content[0].text)).toEqual({
      status: 'declared',
    });
    await client.close();
  });

  // The model names a pull request, never a session, turn or call: whatever
  // else it writes is dropped before the request leaves.
  test('never forwards a session, turn or call a model writes into its arguments', async () => {
    const client = await connect();
    await client.call({
      ...PR,
      sessionId: 'someone-elses',
      threadId: 'someone-elses',
      turnId: 'turn-9',
      callId: 'call-9',
      nativeId: '42',
    });
    const [sent] = recorded.filter((entry) => entry.internal);
    expect(sent?.body).toEqual(PR);
    await client.close();
  });

  test.each([
    ['a zero ref', { ...PR, ref: '0' }],
    ['a ref with a leading zero', { ...PR, ref: '07' }],
    ['a ref that is not a number', { ...PR, ref: '42abc' }],
    ['a repository as one string', { ...PR, repository: 'owner/repo' }],
    ['no host', { ...PR, host: undefined }],
    ['an empty label', { ...PR, label: '' }],
  ])('refuses %s before it calls Station', async (_case, args) => {
    const client = await connect();
    const reply = await client.call(args as Record<string, unknown>);
    expect(reply.error !== undefined || reply.result?.isError === true).toBe(
      true,
    );
    expect(recorded.filter((entry) => entry.internal)).toEqual([]);
    await client.close();
  });

  test.each(['already-declared', 'no-active-turn'])(
    'hands %s back as the result, not an error',
    async (status) => {
      answer = { status };
      const client = await connect();
      const reply = await client.call(PR);
      expect(reply.result.isError).not.toBe(true);
      expect(JSON.parse(reply.result.content[0].text)).toEqual({ status });
      await client.close();
    },
  );

  test('a refusal from Station is a tool error', async () => {
    answer = {
      success: false,
      error: 'The pull request could not be read.',
    };
    const client = await connect();
    const reply = await client.call(PR);
    expect(reply.result.isError).toBe(true);
    await client.close();
  });

  test('is listed with the Tasks tools and is not marked read-only', async () => {
    const tool = stationControlToolCatalog().find(
      (entry) => entry.name === 'declare_pull_request',
    );
    expect(tool).toMatchObject({ group: 'Tasks', readOnly: false });
    const client = await connect();
    const listed = await client.list();
    const entry = listed.result.tools.find(
      (item: { name: string }) => item.name === 'declare_pull_request',
    );
    expect(entry._meta['ai.kontour/tool-group']).toBe('Tasks');
    expect(entry.annotations.readOnlyHint).toBe(false);
    await client.close();
  });
});
