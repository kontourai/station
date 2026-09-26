/**
 * #2377 slice A: the table's routes are what the tools ACTUALLY call.
 *
 * The central guard fails closed for any internal request to a route the
 * table does not name, so a tool whose entry is missing a route stops working
 * for every agent. Reading the tool source to list routes is how the table
 * was written; this proves it. Every registered tool is called through the
 * real MCP server as a bound operator (so the tool-side check lets it
 * through), against a recording Station that answers every request with a
 * generic success, and every request the tool sends with the internal token
 * must resolve, through the same matcher the guard uses, to a leaf that tool
 * (or the caller projection) owns.
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
import {
  matchStationControlRoute,
  STATION_CONTROL_TOOL_POLICY,
} from '../station-control-policy.js';

const resolveRecord: StationControlCallerRecordResolver = () => ({
  principal: { id: LOCAL_OPERATOR_PRINCIPAL_ID, source: 'session-owner' },
  localProjectId: 'local-project-a',
  projectIdSource: 'session-record',
  projectSlug: 'project-a',
});

interface Recorded {
  method: string;
  path: string;
  internal: boolean;
}
const recorded: Recorded[] = [];
let server: ReturnType<typeof serve>;

beforeAll(async () => {
  const app = new Hono();
  app.all('*', (c) => {
    recorded.push({
      method: c.req.method,
      path: c.req.path,
      internal: c.req.header(INTERNAL_API_TOKEN_HEADER) !== undefined,
    });
    // The public handshake the dispatch code reads first to learn which
    // environment is "current".
    if (c.req.path === '/.well-known/station/v1')
      return c.json({ environmentId: 'environment-current' });
    return c.json({ success: true, data: {} });
  });
  let resolvePort!: (value: number) => void;
  const listening = new Promise<number>((resolve) => {
    resolvePort = resolve;
  });
  server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, (info) =>
    resolvePort((info as AddressInfo).port),
  );
  process.env.STATION_API_BASE = `http://127.0.0.1:${await listening}`;
  process.env.STATION_SSH_CONNECT_POLL_TIMEOUT_MS = '200';
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.STATION_API_BASE;
  delete process.env.STATION_SSH_CONNECT_POLL_TIMEOUT_MS;
});

beforeEach(() => {
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

const HEX64 = 'a'.repeat(64);

/** Arguments that pass each tool's own schema, so it reaches Station. */
const ARGS: Record<string, Record<string, unknown>> = {
  get_agent: { slug: 'a' },
  create_agent: { name: 'A', slug: 'a' },
  update_agent: { slug: 'a', name: 'A' },
  delete_agent: { slug: 'a' },
  list_conversations: { agent: 'a' },
  get_conversation_messages: { agent: 'a', conversationId: 'c' },
  delete_conversation: { agent: 'a', conversationId: 'c' },
  board_pin: {
    reference: { kind: 'session', id: 's' },
    name: 'w',
    block: { type: 'card', body: 'b' },
  },
  board_unpin: { reference: { kind: 'session', id: 's' }, name: 'w' },
  board_move: { reference: { kind: 'session', id: 's' }, name: 'w' },
  board_read: { reference: { kind: 'session', id: 's' } },
  install_skill: { id: 's' },
  uninstall_skill: { id: 's' },
  update_skill: { name: 's', description: 'd' },
  track_skill_run: { name: 's' },
  record_skill_outcome: { name: 's', outcome: 'success' },
  run_independent_review: {
    request: {
      requestId: 'request-1',
      mode: 'initial',
      target: {
        kind: 'git-range',
        projectSlug: 'p',
        baseRevision: 'origin/main',
        headRevision: 'HEAD',
      },
      implementerAgentSlug: 'terra',
      reviewers: [
        {
          reviewerId: 'sol-1',
          executorAgentSlug: 'reviewer-agent',
          lens: { id: 'failure-totality', instructions: 'Review.' },
        },
      ],
    },
  },
  get_review_request: { projectSlug: 'p', requestId: 'r' },
  list_review_receipts: { projectSlug: 'p' },
  get_review_receipt: { projectSlug: 'p', receiptId: HEX64 },
  add_job: { name: 'j', prompt: 'p', cron: '* * * * *' },
  preview_schedule: { cron: '* * * * *' },
  get_job_logs: { name: 'j' },
  update_job: { name: 'j', prompt: 'p' },
  run_job: { name: 'j' },
  enable_job: { name: 'j' },
  disable_job: { name: 'j' },
  delete_job: { name: 'j' },
  navigate_to: { path: '/agents/a' },
  get_project: { slug: 'p' },
  list_project_layouts: { slug: 'p' },
  send_message: { agent: 'a', message: 'm' },
  list_delegation_targets: {},
  create_ssh_environment: {
    name: 'box',
    hostAlias: 'box',
    remoteProjectPath: '/srv/p',
  },
  get_ssh_environment: { id: 'e' },
  connect_ssh_environment: { id: 'e' },
  disconnect_ssh_environment: { id: 'e' },
  remove_ssh_environment: { id: 'e' },
  delegate_task: { prompt: 'p', agent: 'a' },
  get_task: { taskId: 't' },
  get_task_events: { taskId: 't' },
  continue_task: { taskId: 't', message: 'm' },
  respond_to_task_request: {
    taskId: 't',
    requestId: 'r',
    decision: 'decline',
  },
  interrupt_task: { taskId: 't' },
  update_config: { updates: { theme: 'dark' } },
  reindex_knowledge: {},
  search_knowledge: { query: 'q' },
  migrate_knowledge: {},
  get_integration: { id: 'i' },
  delete_integration: { id: 'i' },
  install_plugin: { source: '/tmp/p' },
  propose_plugin_install: { source: '/tmp/p', rationale: 'r' },
  validate_plugin: { source: '/tmp/p' },
  update_plugin: { name: 'p' },
  remove_plugin: { name: 'p' },
  get_basis: { scope: 'answer', sessionId: 'session-1', turnId: 'turn-1' },
  get_task_basis: { taskId: 't' },
  get_session_inventory: {
    operation: 'open',
    scope: { kind: 'whole-session', sessionId: 'session-1' },
  },
  notify_user: { title: 't' },
};

describe('the authority table routes are the routes the tools call', () => {
  test('every internal request each tool sends resolves to a leaf that tool owns', async () => {
    const options = claudeInProcessStationControlOptions(() => resolveRecord);
    const instance = options.createInProcessStationControl('op-route-capture');
    const { transport, request } = memoryTransport();
    await instance.connect(transport);
    await request(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'engine', version: '1' },
    });
    const undeclared: string[] = [];
    const silent: string[] = [];
    let id = 10;
    for (const name of Object.keys(STATION_CONTROL_TOOL_POLICY)) {
      recorded.length = 0;
      id += 1;
      const result = await request(id, 'tools/call', {
        name,
        arguments: ARGS[name] ?? {},
      });
      const internal = recorded.filter((entry) => entry.internal);
      const policy =
        STATION_CONTROL_TOOL_POLICY[
          name as keyof typeof STATION_CONTROL_TOOL_POLICY
        ];
      // A person-only tool is refused before it calls anything.
      if (
        policy.routes.length > 0 &&
        policy.personOnly !== 'always' &&
        internal.length === 0
      )
        silent.push(`${name}: ${JSON.stringify(result).slice(0, 300)}`);
      for (const entry of internal) {
        const owners =
          matchStationControlRoute(entry.method, entry.path)?.owners ?? [];
        if (
          !owners.includes(name) &&
          !owners.includes('station-control-caller')
        )
          undeclared.push(`${name}: ${entry.method} ${entry.path}`);
      }
    }
    await instance.close();
    expect(undeclared).toEqual([]);
    // Tools the recording Station's generic answer cannot drive to a request:
    // their routes are proved by reading, not by this capture. Pinned so the
    // list only shrinks.
    expect(silent).toEqual([]);
  });
});
