/**
 * #2377 slice D: Station's own engine run by an authenticated HTTP request
 * with no session — the invoke endpoints and the SDK's raw tool call — calls
 * station-control as that request's principal, through a per-run in-process
 * `bound` caller.
 *
 * Real pieces: the runtime auth boundary, the authority guard with the
 * production caller-record resolver, the production request-principal
 * resolver, the request-run middleware, the real invoke routes over a real
 * EventStore, the per-run in-process server serving the real station-control
 * registrations, and the tools' own `api()` loopback. The only stubs are the
 * Station routes the tool reaches, which record who the guard said called.
 */

import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { createInvokeRoutes } from '../../../routes/agents/invoke.js';
import { createStationControlAuthorityGuard } from '../../../security/station-control-authority-guard.js';
import { stationControlRequestAuthority } from '../../../security/station-control-request-authority.js';
import {
  __resetStationServerSelfAttestationForTests,
  runAsStationServer,
} from '../../../security/station-server-scope.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import type { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import {
  __resetStationControlStdioEntryForTests,
  api,
  setRuntimeControlApiBase,
} from '../../../tools/station-control-shared.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_PROXY_CALLER_HEADER,
} from '../../../utils/internal-api-token.js';
import type { Logger } from '../../../utils/logger.js';
import { createOrchestrationRequestPrincipalResolver } from '../../bootstrap/orchestration-request-principal.js';
import { configureRuntimeHttp } from '../../bootstrap/runtime-http.js';
import {
  createStationControlCallerRecordResolver,
  resolveStationControlCallerForRequest,
} from '../../mcp/station-control-caller.js';
import { __resetStationControlMcpTokensForTests } from '../../mcp/station-control-mcp-token.js';
import {
  __resetNativeStationControlForTests,
  callNativeStationControlTool,
} from '../../mcp/station-control-native-tools.js';
import { stationControlRequestRun } from '../../mcp/station-control-request-runs.js';
import { markTrustedNativeStationControlTool } from '../../tools/tool-provenance.js';
import {
  createRequestStationControlMiddleware,
  REQUEST_STATION_CONTROL_PATHS,
} from '../request-station-control.js';
import {
  createScheduledTurnAdapter,
  JOB_OWNER_NEEDED_MODEL_NOTE,
} from '../runtime-route-support.js';

const OPERATOR_CREDENTIAL = 'test-only-operator-credential-request-runs';
const makeTempDir = trackTempDirs();
let server: ReturnType<typeof serve>;
let base: string;
let store: EventStore;
const seen: Array<ReturnType<typeof stationControlRequestAuthority>> = [];

// What the loader builds for the built-in (`mcp-manager.ts`): a trusted
// native tool whose call goes to `callNativeStationControlTool`.
const updateConfig = markTrustedNativeStationControlTool({
  name: 'stationControl_updateConfig',
  description: 'Update app configuration',
  parameters: { type: 'object' },
  execute: (args: Record<string, unknown>) =>
    callNativeStationControlTool('update_config', args),
});

beforeAll(async () => {
  __resetStationServerSelfAttestationForTests();
  __resetStationControlStdioEntryForTests();
  const home = makeTempDir('station-request-runs-');
  store = new EventStore(join(home, 'events.sqlite'));
  const app = new Hono();
  const security = {
    verifyCredential: (credential: string) =>
      credential === OPERATOR_CREDENTIAL,
    authorizeCredential: (credential: string) =>
      credential === OPERATOR_CREDENTIAL,
    verifyOperatorCredential: (credential: string) =>
      credential === OPERATOR_CREDENTIAL,
    // The operator's own credential, as the boundary classifies it.
    resolveCredentialAuthority: (credential: string) =>
      credential === OPERATOR_CREDENTIAL ? 'operator-credential' : undefined,
    resolveGrantedScope: (credential: string) =>
      credential === OPERATOR_CREDENTIAL
        ? 'orchestration:read orchestration:operate'
        : undefined,
    now: () => Date.now(),
    maxFailures: 100,
    windowMs: 60_000,
    audit: () => {},
    allowedOrigins: [],
  };
  configureRuntimeHttp({
    app: app as never,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger,
    eventBus: { emit: vi.fn() } as unknown as EventBus,
    security,
  } as Parameters<typeof configureRuntimeHttp>[0]);
  // The production record resolver; no session records exist here, so only
  // a request run can name a principal.
  const resolveRecord = createStationControlCallerRecordResolver({
    actingPrincipal: () => undefined,
    startedMetadata: () => undefined,
    localProjectId: () => undefined,
    conversationId: () => undefined,
  });
  app.use(
    '*',
    createStationControlAuthorityGuard({
      resolveCaller: (request) =>
        resolveStationControlCallerForRequest(request, resolveRecord),
      isOperatorPrincipal: (id) => id === LOCAL_OPERATOR_PRINCIPAL_ID,
    }),
  );
  const resolvePrincipal = createOrchestrationRequestPrincipalResolver({
    environmentSecurityService: { identifyDevice: () => null },
  });
  const middleware = createRequestStationControlMiddleware({
    resolvePrincipalId: (c) => resolvePrincipal(c as never).id,
    tenantFor: () => undefined,
  });
  for (const path of REQUEST_STATION_CONTROL_PATHS) app.use(path, middleware);
  // The Station route `update_config` reaches: a Station-wide write only a
  // bound operator caller may make.
  app.put('/config/app', (c) => {
    seen.push(stationControlRequestAuthority(c.req.raw));
    return c.json({ success: true });
  });
  const ctx = {
    activeAgents: new Map([
      [
        'helper',
        {
          // An invoke run whose model calls the tool once.
          generateText: async () => ({
            text: JSON.stringify(
              await updateConfig.execute({ updates: { theme: 'dark' } }),
            ),
          }),
        },
      ],
    ]),
    agentTools: new Map([['helper', [updateConfig]]]),
    agentSpecs: new Map(),
    getNormalizedToolName: (name: string) => name,
    getOriginalToolName: (name: string) => name,
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
    configLoader: { getLaunchabilityRevision: () => 0 },
    providerService: { getLaunchabilityRevision: () => 0 },
    getAgentConfigurationRevision: () => 1,
    commitAgentConfigurationRead: <T>(
      _revision: number,
      operation: () => Promise<T>,
    ) => operation(),
    orchestrationEventStore: store,
  };
  app.route('/', createInvokeRoutes(ctx as never));
  let resolvePort!: (value: number) => void;
  const listening = new Promise<number>((done) => {
    resolvePort = done;
  });
  server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, (info) =>
    resolvePort((info as AddressInfo).port),
  );
  const port = await listening;
  setRuntimeControlApiBase(port);
  base = `http://127.0.0.1:${port}`;
});

afterEach(() => {
  seen.length = 0;
});

afterAll(async () => {
  setRuntimeControlApiBase(undefined);
  await new Promise<void>((done) => server.close(() => done()));
  await __resetNativeStationControlForTests();
  __resetStationControlMcpTokensForTests();
  __resetStationServerSelfAttestationForTests();
  store.close();
});

const operator = {
  'content-type': 'application/json',
  authorization: `Bearer ${OPERATOR_CREDENTIAL}`,
};
/** The guard's record of a bound operator caller acting for a request run. */
function expectBoundOperator(authority: (typeof seen)[number]) {
  expect(authority).toMatchObject({
    kind: 'caller',
    boundOperator: true,
    caller: {
      assurance: 'bound',
      principal: { id: LOCAL_OPERATOR_PRINCIPAL_ID },
    },
  });
  expect(
    authority?.kind === 'caller' ? authority.caller.sessionId : undefined,
  ).toMatch(/^station-request-run:/);
}

test('the raw tool call acts for the request principal: an operator-only write reaches its route as a bound operator', async () => {
  const response = await fetch(
    `${base}/agents/helper/tools/stationControl_updateConfig`,
    {
      method: 'POST',
      headers: operator,
      body: JSON.stringify({ updates: { theme: 'dark' } }),
    },
  );
  expect(await response.json()).toMatchObject({
    success: true,
    response: { success: true },
  });
  expect(seen).toHaveLength(1);
  expectBoundOperator(seen[0]);
});

test('an invoke run acts for the request principal for its whole run', async () => {
  const response = await fetch(`${base}/agents/helper/invoke`, {
    method: 'POST',
    headers: operator,
    body: JSON.stringify({ input: 'set the theme' }),
  });
  const body = (await response.json()) as {
    success: boolean;
    response?: string;
  };
  expect(body.success).toBe(true);
  const tool = JSON.parse(body.response ?? '{}') as {
    content: { text: string }[];
    isError?: boolean;
  };
  expect(tool.isError).toBeUndefined();
  expect(JSON.parse(tool.content[0]!.text)).toEqual({ success: true });
  expect(seen).toHaveLength(1);
  expectBoundOperator(seen[0]);
  // The run ended with its response: its record is gone.
  const runId =
    seen[0]?.kind === 'caller' ? seen[0].caller.sessionId : 'missing';
  await vi.waitFor(() =>
    expect(stationControlRequestRun(runId)).toBeUndefined(),
  );
});

test('outside a request run the tool acts for no one, and the raw internal token never reaches the invoke routes', async () => {
  // The control: the same tool with no run is refused before any route.
  const direct = (await updateConfig.execute({
    updates: { theme: 'dark' },
  })) as { content: { text: string }[] };
  expect(JSON.parse(direct.content[0]!.text)).toMatchObject({
    code: 'station_control_caller_required',
  });
  for (const path of [
    '/agents/helper/tools/stationControl_updateConfig',
    '/agents/helper/invoke',
    '/agents/helper/invoke/stream',
    '/invoke',
  ]) {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
        [INTERNAL_PROXY_CALLER_HEADER]: 'local',
      },
      body: JSON.stringify({ input: 'x', updates: {} }),
    });
    expect([
      path,
      response.status,
      ((await response.json()) as { code?: string }).code,
    ]).toEqual([path, 403, 'station_control_route_unmapped']);
  }
  expect(seen).toEqual([]);
});

test('an internal request never opens a run, even Station’s own server code', async () => {
  // Passes the guard as server code; the run middleware still gives it no
  // caller, so the tool it runs acts for no one.
  const answer = (await runAsStationServer(() =>
    api('/agents/helper/tools/stationControl_updateConfig', {
      method: 'POST',
      body: JSON.stringify({ updates: { theme: 'dark' } }),
    }),
  )) as { success: boolean; response?: { code?: string } };
  expect(answer).toMatchObject({
    success: false,
  });
  // The raw tool route answers a control tool's refusal with its message.
  expect(JSON.stringify(answer)).toContain(
    'Station tools need a verified calling session',
  );
  expect(seen).toEqual([]);
});

// #2377 slice D (owner decision 2026-11-16): an untargeted scheduled job runs
// as its recorded owner; one with no owner gets no caller and is told so.
describe('scheduled jobs', () => {
  const generateText = vi.fn(async (prompt: string) => ({
    text: JSON.stringify({
      prompt,
      tool: await updateConfig.execute({ updates: { theme: 'dark' } }),
    }),
  }));
  const adapter = createScheduledTurnAdapter(
    new Map([['helper', { generateText }]]) as never,
  );
  const runJob = async (createdBy?: { userId: string }) => {
    const outcome = await adapter.invoke({
      agentSlug: 'helper',
      prompt: 'tidy the config',
      receipt: {
        id: 'run-1',
        jobId: 'job-1',
        job: { name: 'nightly', ...(createdBy ? { createdBy } : {}) },
        startedAt: new Date().toISOString(),
        manual: true,
        missedCount: 0,
      } as never,
      approval: 'unattended-deny',
      principal: { kind: 'scheduled-job', jobId: 'job-1', runId: 'run-1' },
      signal: new AbortController().signal,
    });
    expect(outcome.kind).toBe('completed');
    const output = JSON.parse((outcome as { output: string }).output) as {
      prompt: string;
      tool: { content: { text: string }[] };
    };
    return {
      prompt: output.prompt,
      tool: JSON.parse(output.tool.content[0]!.text) as {
        success: boolean;
        code?: string;
      },
    };
  };

  test('an owned job runs as its owner: an operator-only write reaches its route as a bound operator', async () => {
    const { prompt, tool } = await runJob({
      userId: LOCAL_OPERATOR_PRINCIPAL_ID,
    });
    expect(prompt).toBe('tidy the config');
    expect(tool).toEqual({ success: true });
    expect(seen).toHaveLength(1);
    expectBoundOperator(seen[0]);
  });

  test('a job with no owner has no caller, and its model is told it has no Station tools', async () => {
    const { prompt, tool } = await runJob();
    expect(prompt).toContain(JOB_OWNER_NEEDED_MODEL_NOTE);
    expect(tool).toMatchObject({
      success: false,
      code: 'station_control_caller_required',
    });
    expect(seen).toEqual([]);
  });
});
