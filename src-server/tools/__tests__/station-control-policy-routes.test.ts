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
  vi,
} from 'vitest';
import type { StationControlCallerRecordResolver } from '../../runtime/mcp/station-control-caller.js';
import {
  claudeInProcessStationControlOptions,
  type InProcessStationControlServer,
} from '../../runtime/mcp/station-control-in-process.js';
import {
  __resetStationControlMcpTokensForTests,
  revokeStationControlMcpToken,
} from '../../runtime/mcp/station-control-mcp-token.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../services/identity/principal-resolver.js';
import { INTERNAL_API_TOKEN_HEADER } from '../../utils/internal-api-token.js';
import {
  matchStationControlRoute,
  STATION_CONTROL_TOOL_POLICY,
} from '../station-control-policy.js';

let revokeAfterRoots = false;
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
  body?: unknown;
}
const recorded: Recorded[] = [];
let server: ReturnType<typeof serve>;

beforeAll(async () => {
  vi.stubEnv('STATION_EXPERIMENTAL_S3_SOURCES', '1');
  const app = new Hono();
  app.all('*', async (c) => {
    recorded.push({
      method: c.req.method,
      path: c.req.path,
      internal: c.req.header(INTERNAL_API_TOKEN_HEADER) !== undefined,
      ...(c.req.path.endsWith('/assessment') && c.req.method !== 'GET'
        ? { body: await c.req.json() }
        : {}),
    });
    // The public handshake the dispatch code reads first to learn which
    // environment is "current".
    if (c.req.path === '/.well-known/station/v1')
      return c.json({ environmentId: 'environment-current' });
    if (c.req.path === '/api/knowledge/roots') {
      if (revokeAfterRoots)
        revokeStationControlMcpToken(
          'op-route-capture-knowledge',
          'station-knowledge',
        );
      return c.json({
        success: true,
        data: [
          {
            id: 'other-root',
            displayName: 'Same policy',
            scope: { kind: 'project', projectSlug: 'other-project' },
            projectId: 'other-id',
            adapterId: 'kit-default-store',
            storeRoot: '/private/other',
          },
          {
            id: 'current-root',
            displayName: 'Same policy',
            scope: { kind: 'project', projectSlug: 'project-a' },
            projectId: 'local-project-a',
            adapterId: 'kit-default-store',
            storeRoot: '/private/current',
          },
        ],
      });
    }
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
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.STATION_API_BASE;
  delete process.env.STATION_SSH_CONNECT_POLL_TIMEOUT_MS;
});

beforeEach(() => {
  revokeAfterRoots = false;
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
const GUIDE_TARGET = {
  project: 'project-a',
  provider: 'github',
  host: 'github.com',
  owner: 'o',
  repository: 'r',
  ref: '1',
};

/** Arguments that pass each tool's own schema, so it reaches Station. */
const ARGS: Record<string, Record<string, unknown>> = {
  read_pull_request_guide: { target: GUIDE_TARGET },
  write_pull_request_guides: { targets: [GUIDE_TARGET] },
  device_open: { platform: 'android', deviceId: 'emulator-5554' },
  device_screenshot: { deviceSessionId: 'device-session' },
  device_snapshot: { deviceSessionId: 'device-session' },
  device_input: {
    deviceSessionId: 'device-session',
    events: [{ kind: 'text', text: 'hello' }],
  },
  device_close: { deviceSessionId: 'device-session' },

  get_personal_board: { slug: 'daily' },
  propose_personal_board: {
    slug: 'daily.v2',
    revision: null,
    definition: { version: 1, name: 'Daily', description: '', sections: [] },
  },
  get_agent: { slug: 'a' },
  create_agent: { name: 'A', slug: 'a' },
  update_agent: { slug: 'a', name: 'A' },
  delete_agent: { slug: 'a' },
  list_conversations: { agent: 'a' },
  get_conversation_messages: { agent: 'a', conversationId: 'c' },
  read_conversation: { conversationId: 'c', limit: 5 },
  delete_conversation: { agent: 'a', conversationId: 'c' },
  search_sessions: { query: 'cobalt' },
  search_conversations: { query: 'cobalt' },
  rename_session: { conversationId: 'c', title: 'A title' },
  board_pin: {
    reference: { kind: 'session', id: 's' },
    name: 'w',
    block: { type: 'card', body: 'b' },
  },
  board_unpin: { reference: { kind: 'session', id: 's' }, name: 'w' },
  board_move: { reference: { kind: 'session', id: 's' }, name: 'w' },
  board_read: { reference: { kind: 'session', id: 's' } },
  schedule_wake_up: { minutes: 5, note: 'check the build' },
  cancel_wake_up: { id: 'w' },
  propose_job: {
    name: 'nightly',
    schedule: { kind: 'every', everyMs: 3_600_000 },
    prompt: 'p',
  },
  declare_pull_request: {
    provider: 'github',
    host: 'github.com',
    repository: { owner: 'o', name: 'r' },
    ref: '1',
  },
  task_summary_update: { text: 'Now: tests pass.', baseRevision: 0 },
  task_record: { kind: 'decision', key: 'storage', text: 'Use SQLite.' },
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
  send_to_session: {
    sessionId: 'session-1',
    text: 'hello',
    requestKey: 'key-0000001',
  },
  interrupt_session: { sessionId: 'session-1', requestKey: 'key-0000002' },
  wait_session: { sessionId: 'session-1', until: 'idle' },
  list_project_activity: {},
  get_session_digest: { sessionId: 'session-1' },
  claim_work: { workItemRef: 'kontourai/station#3413', note: 'n' },
  renew_claim: { claimId: 'claim_1' },
  release_claim: { claimId: 'claim_1', note: 'n' },
  update_config: { updates: { theme: 'dark' } },
  reindex_knowledge: {},
  search_knowledge: { query: 'q' },
  list_knowledge_roots: {},
  list_project_s3_sources: { projectSlug: 'fixture' },
  list_project_s3_objects: {
    projectSlug: 'fixture',
    sourceId: '11111111-1111-4111-8111-111111111111',
  },
  read_project_s3_object: {
    projectSlug: 'fixture',
    sourceId: '11111111-1111-4111-8111-111111111111',
    key: 'selected/note.md',
    etag: '"etag"',
  },
  list_knowledge_records: { rootId: 'root-a', type: 'raw' },
  get_knowledge_record: { rootId: 'root-a', id: 'record-a' },
  add_knowledge_record: { rootId: 'root-a', title: 't', body: 'b' },
  migrate_knowledge: {},
  get_integration: { id: 'i' },
  delete_integration: { id: 'i' },
  install_plugin: { source: '/tmp/p' },
  propose_plugin_install: { source: '/tmp/p', rationale: 'r' },
  validate_plugin: { source: '/tmp/p' },
  update_plugin: { name: 'p' },
  remove_plugin: { name: 'p' },
  get_basis: { scope: 'answer', sessionId: 'session-1', turnId: 'turn-1' },
  get_answer_assessment_target: { sessionId: 'session-1', turnId: 'turn-1' },
  publish_answer_assessment: {
    sessionId: 'session-1',
    turnId: 'turn-1',
    publicationId: 'publish-1',
    expectedAnswer: {},
    bundle: {},
    claimId: 'claim-1',
    expectedRevision: 0,
  },
  remove_answer_assessment: {
    sessionId: 'session-1',
    turnId: 'turn-1',
    expectedRevision: 1,
  },
  get_task_basis: { taskId: 't' },
  get_session_inventory: {
    operation: 'open',
    scope: { kind: 'whole-session', sessionId: 'session-1' },
  },
  html_render: { html: '<h1>Test</h1>' },
  html_preview: { html: '<h1>Test</h1>' },
  notify_user: { title: 't' },
};

type PolicyServerId = 'station-control' | 'station-knowledge';

/**
 * The server(s) a tool is registered on. An entry without `serverIds` is a
 * station-control tool, the same default `qualifiedToolNamesOfClass` applies
 * (`runtime-control-tools.ts`); #3196 gave the Knowledge data tools
 * `serverIds: ['station-knowledge']` and removed them from station-control.
 */
function policyServerIds(name: string): readonly PolicyServerId[] {
  const policy = STATION_CONTROL_TOOL_POLICY[
    name as keyof typeof STATION_CONTROL_TOOL_POLICY
  ] as { serverIds?: readonly PolicyServerId[] };
  return policy.serverIds ?? ['station-control'];
}

describe('the authority table routes are the routes the tools call', () => {
  test('assessment producer tools carry exact CAS input and refuse oversized publication before owner I/O', async () => {
    const options = claudeInProcessStationControlOptions(() => resolveRecord);
    const instance = options.createInProcessStationControl(
      'assessment-producer',
    );
    const { transport, request } = memoryTransport();
    await instance.connect(transport);
    try {
      await request(1, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'engine', version: '1' },
      });
      const target = { sessionId: 'station:1792425046978', turnId: 'turn-a' };
      const publication = {
        expectedAnswer: { exact: 'answer' },
        publicationId: 'publish-a',
        bundle: { frozen: 'artifact' },
        claimId: 'claim-a',
        expectedRevision: 1,
      };
      recorded.length = 0;
      await request(2, 'tools/call', {
        name: 'get_answer_assessment_target',
        arguments: target,
      });
      expect(recorded).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            method: 'GET',
            path: '/api/orchestration/sessions/station%3A1792425046978/turns/turn-a/assessment/target',
            internal: true,
          }),
        ]),
      );
      await request(3, 'tools/call', {
        name: 'publish_answer_assessment',
        arguments: { ...target, ...publication },
      });
      expect(recorded).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            method: 'PUT',
            body: publication,
            internal: true,
          }),
        ]),
      );
      await request(4, 'tools/call', {
        name: 'remove_answer_assessment',
        arguments: { ...target, expectedRevision: 2 },
      });
      expect(recorded).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            method: 'DELETE',
            body: { expectedRevision: 2 },
            internal: true,
          }),
        ]),
      );
      recorded.length = 0;
      const refused = await request(5, 'tools/call', {
        name: 'publish_answer_assessment',
        arguments: { ...target, ...publication, bundle: 'x'.repeat(1_048_577) },
      });
      expect(refused).toMatchObject({ result: { isError: true } });
      expect(recorded.some((entry) => entry.path.endsWith('/assessment'))).toBe(
        false,
      );
    } finally {
      await instance.close();
    }
  });

  test('every internal request each tool sends resolves to a leaf that tool owns', async () => {
    const options = claudeInProcessStationControlOptions(() => resolveRecord);
    const servers: Record<PolicyServerId, () => InProcessStationControlServer> =
      {
        'station-control': () =>
          options.createInProcessStationControl('op-route-capture-control'),
        'station-knowledge': () =>
          options.createInProcessStationKnowledge('op-route-capture-knowledge'),
      };
    const undeclared: string[] = [];
    const silent: string[] = [];
    const driven = new Set<string>();
    let id = 10;
    for (const serverId of Object.keys(servers) as PolicyServerId[]) {
      const instance = servers[serverId]();
      const { transport, request } = memoryTransport();
      await instance.connect(transport);
      await request(1, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'engine', version: '1' },
      });
      // Drive each tool only through the server its policy says serves it: a
      // tool another server owns is "not found" here, which is not a route.
      for (const name of Object.keys(STATION_CONTROL_TOOL_POLICY)) {
        if (!policyServerIds(name).includes(serverId)) continue;
        driven.add(name);
        recorded.length = 0;
        id += 1;
        const result = await request(id, 'tools/call', {
          name,
          arguments: ARGS[name] ?? {},
        });
        if (name === 'list_knowledge_roots') {
          const envelope = JSON.parse(
            result.result.content.find(
              (part: { type: string }) => part.type === 'text',
            ).text,
          );
          expect(envelope.success).toBe(true);
          expect(envelope.data).toEqual([
            expect.objectContaining({
              id: 'other-root',
              projectId: 'other-id',
              isCurrentProject: false,
            }),
            expect.objectContaining({
              id: 'current-root',
              projectId: 'local-project-a',
              isCurrentProject: true,
              currentProjectId: 'local-project-a',
              currentProjectSlug: 'project-a',
            }),
          ]);
          expect(JSON.stringify(envelope)).not.toContain('/private/');
        }
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
          silent.push(
            `${serverId}/${name}: ${JSON.stringify(result).slice(0, 300)}`,
          );
        for (const entry of internal) {
          const owners =
            matchStationControlRoute(entry.method, entry.path)?.owners ?? [];
          if (
            !owners.includes(name) &&
            !owners.includes('station-control-caller')
          )
            undeclared.push(
              `${serverId}/${name}: ${entry.method} ${entry.path}`,
            );
        }
      }
      if (serverId === 'station-knowledge') {
        revokeAfterRoots = true;
        const revoked = await request(++id, 'tools/call', {
          name: 'list_knowledge_roots',
          arguments: {},
        });
        expect(JSON.stringify(revoked)).not.toContain('Same policy');
        expect(JSON.stringify(revoked)).not.toContain('current-root');
        const refusal = JSON.parse(
          revoked.result.content.find(
            (part: { type: string }) => part.type === 'text',
          ).text,
        );
        expect(refusal.success).toBe(false);
        revokeAfterRoots = false;
      }
      await instance.close();
    }
    expect(undeclared).toEqual([]);
    // Tools the recording Station's generic answer cannot drive to a request:
    // their routes are proved by reading, not by this capture. Pinned so the
    // list only shrinks.
    expect(silent).toEqual([]);
    // No policy entry is skipped because no server was asked for it.
    expect([...driven].sort()).toEqual(
      Object.keys(STATION_CONTROL_TOOL_POLICY).sort(),
    );
  });

  test('Knowledge source tools stay off station-control, and both servers drive search_knowledge', () => {
    const only = (serverId: PolicyServerId) =>
      Object.keys(STATION_CONTROL_TOOL_POLICY)
        .filter((name) => policyServerIds(name).includes(serverId))
        .filter((name) => policyServerIds(name).length === 1)
        .sort();
    expect(only('station-knowledge')).toEqual([
      'add_knowledge_record',
      'get_knowledge_record',
      'list_knowledge_records',
      'list_knowledge_roots',
      'list_project_s3_objects',
      'list_project_s3_sources',
      'read_project_s3_object',
    ]);
    expect(policyServerIds('search_knowledge')).toEqual([
      'station-control',
      'station-knowledge',
    ]);
  });
});
