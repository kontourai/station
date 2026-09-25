/**
 * #2601: a delegated child's lineage comes from the VERIFIED caller, never
 * from the `_delegation` tool argument a model writes.
 *
 * Everything runs through a real listening server: the production runtime
 * security boundary (`configureRuntimeHttp`), the production station-control
 * MCP route serving the REAL `delegate_task`/`send_message` tools, and the
 * REAL orchestration dispatch routes with the production delegation resolver
 * (`createRequestDelegationResolver`) over real token verification, and Agent
 * policy read from a REAL `ConfigLoader` + `AgentService` on a fresh home
 * (where `station`, `claude` and `codex` are registry defaults with no stored
 * spec, as in production). The stand-ins are the session records the
 * resolver reads, a peer Station's two endpoints, and the two dispatch
 * effects, which record the `delegation` the child session would be started
 * with (`execution-target-execution.ts` and `delegateTask` both stamp exactly
 * `input.delegation` into `session.started` metadata).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import type {
  AgentDelegationContext,
  AgentSpec,
} from '@kontourai/station-contracts/agent';
import { McpServer } from '@modelcontextprotocol/server';
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
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  loadOrCreateAgentRegistry,
  registerEngineConnection,
} from '../../../domain/agent-registry.js';
import { ConfigLoader } from '../../../domain/config-loader.js';
import { createChildDelegationContext } from '../../../runtime/agents/delegation.js';
import { attestDelegationContext } from '../../../runtime/agents/delegation-attestation.js';
import {
  createCallerDelegationDeriver,
  createRequestDelegationResolver,
  type RequestDelegationSources,
} from '../../../runtime/agents/request-delegation.js';
import { configureRuntimeHttp } from '../../../runtime/bootstrap/runtime-http.js';
import { wrapDelegationAwareTools } from '../../../runtime/mcp/mcp-manager.js';
import {
  createAgentDispatchActorResolver,
  createStationControlCallerRecordResolver,
  resolveStationControlCallerForRequest,
  stationControlCallerRecordSources,
} from '../../../runtime/mcp/station-control-caller.js';
import {
  __resetStationControlMcpTokensForTests,
  mintStationControlMcpToken,
} from '../../../runtime/mcp/station-control-mcp-token.js';
import { AgentService } from '../../../services/agents/agent-service.js';
import { isStationInternalRequest } from '../../../services/browser/browser-request-origin.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { StationControlToolRegistry } from '../../../tools/station-control-mcp-server.js';
import { registerOperationsTools } from '../../../tools/station-control-operations-tools.js';
import {
  __resetStationControlStdioCallerCredentialForTests,
  STATION_CONTROL_CALLER_TOKEN_HEADER,
} from '../../../tools/station-control-shared.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_PROXY_CALLER_HEADER,
} from '../../../utils/internal-api-token.js';
import type { Logger } from '../../../utils/logger.js';
import { createOrchestrationRoutes } from '../../orchestration/orchestration.js';
import { createStationControlCallerRoutes } from '../station-control-caller-route.js';
import {
  createStationControlMcpRoutes,
  STATION_CONTROL_MCP_PATH,
} from '../station-control-mcp-route.js';

const ENVIRONMENT_ID = 'env-lineage-test';

const PEER_ENVIRONMENT_ID = 'env-lineage-peer';
const PEER_CREDENTIAL = 'test-only-peer-credential-lineage-suite';

// Every non-internal principal the runtime boundary accepts, for the
// caller-delegation route's auth boundary: an operator bearer, a paired
// person's device, another Station's delegation grant (a peer), and a
// browser's device-session cookie minted by the UI bootstrap.
const OPERATOR_CREDENTIAL = 'test-only-operator-credential-lineage-suite';
const DEVICE_CREDENTIAL = 'test-only-device-credential-lineage-suite';
const PEER_GRANT_CREDENTIAL = 'test-only-peer-grant-credential-lineage-suite';
// A device-session cookie value has the minted credential's exact shape.
const BROWSER_SESSION_CREDENTIAL = 'test-only-browser-session-lineage'.padEnd(
  43,
  'x',
);
const DEVICE_IDS: Record<string, string> = {
  [DEVICE_CREDENTIAL]: 'device-phone',
  [PEER_GRANT_CREDENTIAL]: 'device-peer-station',
  [BROWSER_SESSION_CREDENTIAL]: 'device-browser',
};

// The one stored Agent. Its spec carries no delegation policy: the agent
// schema has no such field, so a stored Agent's children are bounded by the
// default policy (maxDepth 2), as in `mcp-manager.ts`.
const SPECS: Record<string, AgentSpec> = {
  planner: { name: 'Planner', prompt: 'Plan' },
};

// What each calling session was started with, as Station recorded it.
const ROOT_CHILD: AgentDelegationContext = createChildDelegationContext({
  agentSlug: 'planner',
  conversationId: 'conversation-root',
  spec: SPECS.planner,
});
const STARTED: Record<string, Record<string, unknown>> = {
  // A top-level Codex-style session.
  'session-root': { agentSlug: 'planner' },
  // A child one hop below `conversation-root`.
  'session-child': { agentSlug: 'planner', delegation: ROOT_CHILD },
  // A child already at its tree's limit (maxDepth 2).
  'session-deep': {
    agentSlug: 'planner',
    delegation: { ...ROOT_CHILD, depth: 2 },
  },
  // Registry default Agents: no spec is ever stored for them.
  'session-station': { agentSlug: 'station' },
  'session-claude': { agentSlug: 'claude' },
  'session-codex': { agentSlug: 'codex' },
  // An Agent that is neither stored nor a registry default.
  'session-ghost': { agentSlug: 'ghost' },
  // A stored Agent whose spec cannot be read.
  'session-broken': { agentSlug: 'broken' },
  // An adopted session (`attached-session-adoption.ts`): no Agent, an engine.
  'session-adopted': { adoptedFromThreadId: 'thread-attached-1' },
  // Adopted sessions whose recorded engine is not a clean Agent id: a path
  // shape, and a trailing hyphen (the clean-identity contract refuses it).
  'session-adopted-unclean': { adoptedFromThreadId: 'thread-attached-2' },
  'session-adopted-trailing': { adoptedFromThreadId: 'thread-attached-3' },
  // A session with no recorded Agent that is not adopted either.
  'session-agentless': {},
  // Not adopted and no Agent, but WITH a known engine: only adoption lets an
  // engine name the caller, so this must be refused too.
  'session-engine-only': {},
  // A stored Agent whose spec carries a `delegation` policy.
  'session-policied': { agentSlug: 'policied' },
};
const ENGINES: Record<string, string> = {
  'session-adopted': 'codex',
  'session-adopted-unclean': 'Codex/../planner',
  'session-adopted-trailing': 'codex-',
  'session-engine-only': 'codex',
};
const CONVERSATIONS: Record<string, string> = {
  'session-root': 'conversation-root',
  'session-child': 'conversation-child',
  'session-deep': 'conversation-deep',
  'session-station': 'conversation-station',
  'session-claude': 'conversation-claude',
  'session-codex': 'conversation-codex',
  'session-ghost': 'conversation-ghost',
  'session-broken': 'conversation-broken',
  'session-adopted': 'conversation-adopted',
  'session-agentless': 'conversation-agentless',
  'session-adopted-unclean': 'conversation-adopted-unclean',
  'session-adopted-trailing': 'conversation-adopted-trailing',
  'session-engine-only': 'conversation-engine-only',
  'session-policied': 'conversation-policied',
};

const resolveRecord = createStationControlCallerRecordResolver(
  stationControlCallerRecordSources({
    orchestrationService: {
      resolveSessionActingPrincipal: () => undefined,
      firstStartedMetadataOfThread: (threadId) => STARTED[threadId],
    },
    eventStore: {
      conversationForSession: (sessionId) =>
        CONVERSATIONS[sessionId]
          ? { conversationId: CONVERSATIONS[sessionId] }
          : undefined,
    },
    getProject: () => {
      throw new Error('no projects in this suite');
    },
  }),
);

// The two dispatch effects: what the child session would be started with.
const delegateTask = vi.fn(async (input: { delegation?: unknown }) => ({
  taskId: 'task:1',
  sessionId: 'task:1',
  conversationId: 'task:1',
  status: 'dispatched',
  resumable: true,
  target: { kind: 'agent', id: 'writer' },
  observedDelegation: input.delegation ?? null,
}));
const executeForegroundMessage = vi.fn(
  async (_input: { delegation?: unknown }) => ({
    conversationId: 'conversation-new-child',
    sessionId: 'session-new-child',
    providerTurnId: 'turn-1',
    target: { kind: 'agent', id: 'writer' },
  }),
);

// What the peer Station received for each forward.
const peerReceived: Array<{
  path: string;
  authorization: string | null;
  body: Record<string, unknown>;
}> = [];
let peerServer: ReturnType<typeof serve>;
let peerBaseUrl: string;

// Created first, so its after-hook removes the home only after the servers
// that read it have closed (vitest runs after-hooks in reverse order).
const makeTempDir = trackTempDirs({ lifetime: 'file' });
let server: ReturnType<typeof serve>;
let baseUrl: string;
let home: string;
let agentService: AgentService;

beforeAll(async () => {
  const logger = {
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
  const app = new Hono();
  configureRuntimeHttp({
    app: app as never,
    logger,
    eventBus: { emit: vi.fn() } as unknown as EventBus,
    security: {
      verifyCredential: (candidate: string) =>
        candidate === OPERATOR_CREDENTIAL || candidate in DEVICE_IDS,
      resolveGrantedScope: () => 'orchestration:read orchestration:operate',
      resolveCredentialAuthority: (candidate: string) =>
        candidate === OPERATOR_CREDENTIAL
          ? 'operator-credential'
          : 'device-credential',
      resolveCredentialDeviceId: (candidate: string) => DEVICE_IDS[candidate],
      resolveCredentialDeviceKind: (candidate: string) =>
        candidate === PEER_GRANT_CREDENTIAL ? 'delegation' : 'device',
      resolvePairingSource: (candidate: string) =>
        candidate === BROWSER_SESSION_CREDENTIAL
          ? 'same-origin'
          : candidate === DEVICE_CREDENTIAL
            ? 'pairing-code'
            : undefined,
      resolveCredentialLocality: (candidate: string) =>
        candidate === BROWSER_SESSION_CREDENTIAL
          ? 'home-possession'
          : undefined,
      resolveCredentialMintKind: (candidate: string) =>
        candidate === BROWSER_SESSION_CREDENTIAL ? 'ui-bootstrap' : undefined,
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
  // The tools resolve the current Station through its public handshake.
  app.get('/.well-known/station/v1', (c) =>
    c.json({ environmentId: ENVIRONMENT_ID }),
  );
  // A saved peer Environment: no SSH profile, one paired peer credential.
  app.get('/api/environments/ssh', (c) => c.json({ success: true, data: [] }));
  app.get('/api/environments/peers/:id/credential', (c) =>
    c.req.param('id') === PEER_ENVIRONMENT_ID
      ? c.json({
          success: true,
          data: {
            apiBase: peerBaseUrl,
            credential: PEER_CREDENTIAL,
            label: 'Peer',
          },
        })
      : c.json({ success: false, error: 'not found' }, 404),
  );
  // The peer Station itself: a separate listener recording what arrives.
  const peerApp = new Hono();
  peerApp.post('/api/orchestration/*', async (c) => {
    peerReceived.push({
      path: c.req.path,
      authorization: c.req.header('authorization') ?? null,
      body: await c.req.json(),
    });
    return c.json({
      success: true,
      data: {
        taskId: 'task:peer',
        sessionId: 'task:peer',
        conversationId: 'conversation-peer-child',
        status: 'dispatched',
        resumable: true,
        providerTurnId: 'turn-peer',
        target: { kind: 'agent', id: 'writer' },
      },
    });
  });
  let resolvePeerPort!: (port: number) => void;
  const peerListening = new Promise<number>((resolve) => {
    resolvePeerPort = resolve;
  });
  peerServer = serve(
    { fetch: peerApp.fetch, hostname: '127.0.0.1', port: 0 },
    (info) => resolvePeerPort((info as AddressInfo).port),
  );
  peerBaseUrl = `http://127.0.0.1:${await peerListening}`;

  // A REAL home: stored Agents, plus `claude` and `codex` adopted as registry
  // defaults the way native engine adoption registers them.
  home = makeTempDir('station-2601-lineage-');
  const configLoader = new ConfigLoader({ projectHomeDir: home });
  // Seeds the home schema and the registry (`station` as its one default).
  await loadOrCreateAgentRegistry(configLoader);
  for (const [slug, spec] of Object.entries(SPECS))
    await configLoader.createAgent({ slug, ...spec } as never);
  await registerEngineConnection(configLoader, 'claude');
  await registerEngineConnection(configLoader, 'codex');
  const brokenDir = join(home, 'agents', 'broken');
  mkdirSync(brokenDir, { recursive: true });
  writeFileSync(join(brokenDir, 'agent.json'), '{ not json');
  // A stored spec naming a delegation policy, written as a hand edit would be.
  const policiedDir = join(home, 'agents', 'policied');
  mkdirSync(policiedDir, { recursive: true });
  writeFileSync(
    join(policiedDir, 'agent.json'),
    JSON.stringify({
      name: 'Policied',
      prompt: 'Plan',
      delegation: { maxDepth: 5 },
    }),
  );
  agentService = new AgentService(
    configLoader,
    { findLayoutsUsingAgent: () => [] } as never,
    new Map(),
    new Map(),
    new Map(),
    { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  );
  // The production sources (`runtime-routes.ts`) over this suite's records.
  const sources: RequestDelegationSources = {
    isInternalRequest: isStationInternalRequest,
    resolveCaller: (request) =>
      resolveStationControlCallerForRequest(request, resolveRecord),
    startedMetadata: (threadId) => STARTED[threadId],
    sessionEngine: (threadId) => ENGINES[threadId],
    loadAgentSpec: (slug) => agentService.getAgent(slug),
    isRegistryDefaultAgent: async (slug) =>
      (await loadOrCreateAgentRegistry(configLoader)).defaultAgents.some(
        (agent) => String(agent.id) === slug,
      ),
  };
  app.route(
    '/api/orchestration',
    createStationControlCallerRoutes({
      resolveRecord,
      deriveCallerDelegation: createCallerDelegationDeriver(sources),
    }),
  );
  app.route(
    '',
    createStationControlMcpRoutes({ port, resolveCallerRecord: resolveRecord }),
  );
  app.route(
    '/api/orchestration',
    createOrchestrationRoutes(
      { canUserReadSession: () => true } as never,
      {
        eventBus: new EventBus(),
        logger: {
          debug: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          info: vi.fn(),
        },
        getUserId: () => LOCAL_OPERATOR_PRINCIPAL_ID,
        delegateTask,
        executeForegroundMessage,
        resolveAgentDispatchActor:
          createAgentDispatchActorResolver(resolveRecord),
        resolveRequestDelegation: createRequestDelegationResolver(sources),
      } as never,
    ),
  );
  process.env.STATION_API_BASE = baseUrl;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => peerServer.close(() => resolve()));
  delete process.env.STATION_API_BASE;
});

beforeEach(() => {
  __resetStationControlMcpTokensForTests();
  __resetStationControlStdioCallerCredentialForTests();
  peerReceived.length = 0;
  delegateTask.mockClear();
  executeForegroundMessage.mockClear();
});

async function readJsonRpc(response: Response): Promise<any> {
  const text = await response.text();
  if ((response.headers.get('content-type') ?? '').includes('application/json'))
    return JSON.parse(text);
  const dataLine = text.split('\n').find((line) => line.startsWith('data: '));
  if (!dataLine) throw new Error(`No SSE data line: ${text}`);
  return JSON.parse(dataLine.slice('data: '.length));
}

async function mcp(token: string, id: number, method: string, params = {}) {
  return fetch(
    `${baseUrl}${STATION_CONTROL_MCP_PATH}?token=${encodeURIComponent(token)}`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    },
  );
}

/** Calls a REAL station-control tool as the session `sessionId`'s engine. */
async function callTool(
  sessionId: string,
  name: 'delegate_task' | 'send_message',
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string }> {
  // A Codex-style URL token: the engine's own verified connection.
  const { token } = mintStationControlMcpToken(sessionId, 'url-token');
  const init = await mcp(token, 1, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  });
  expect(init.status).toBe(200);
  await init.text();
  const response = await mcp(token, 2, 'tools/call', {
    name,
    arguments: args,
  });
  expect(response.status).toBe(200);
  const result = (await readJsonRpc(response)).result;
  return {
    isError: result.isError === true,
    text: result.content?.[0]?.text ?? '',
  };
}

function stampedDelegation(
  recorder: typeof delegateTask | typeof executeForegroundMessage,
): unknown {
  expect(recorder).toHaveBeenCalledTimes(1);
  return recorder.mock.calls[0]![0].delegation;
}

const DELEGATE_ARGS = { prompt: 'Draft the plan', agent: 'writer' };
const SEND_ARGS = { agent: 'writer', message: 'Draft the plan' };

// A context a model wrote to put its child under another tree's root, free
// of the child tool denials, at depth 1 of a limit it chose.
const FORGED: AgentDelegationContext = {
  mode: 'isolated-child',
  depth: 1,
  maxDepth: 64,
  parentAgentSlug: 'victim' as AgentDelegationContext['parentAgentSlug'],
  parentConversationId: 'conversation-victim',
  rootAgentSlug: 'victim' as AgentDelegationContext['rootAgentSlug'],
  rootConversationId: 'conversation-victim-root',
  blockedTools: [],
};

describe('#2601 delegate_task stamps lineage from the verified caller', () => {
  test('a verified root session that omits _delegation still starts a child of ITS conversation, with the child tool denials', async () => {
    const result = await callTool(
      'session-root',
      'delegate_task',
      DELEGATE_ARGS,
    );
    expect(result.isError).toBe(false);
    expect(stampedDelegation(delegateTask)).toEqual(
      createChildDelegationContext({
        agentSlug: 'planner',
        conversationId: 'conversation-root',
        spec: SPECS.planner,
      }),
    );
    expect(stampedDelegation(delegateTask)).toMatchObject({
      depth: 1,
      parentConversationId: 'conversation-root',
      rootConversationId: 'conversation-root',
      blockedTools: expect.arrayContaining(['station-control_delegate_task']),
    });
  });

  test('a verified child session that omits _delegation starts a grandchild under the TRUE root', async () => {
    const result = await callTool(
      'session-child',
      'delegate_task',
      DELEGATE_ARGS,
    );
    expect(result.isError).toBe(false);
    expect(stampedDelegation(delegateTask)).toMatchObject({
      depth: 2,
      parentAgentSlug: 'planner',
      parentConversationId: 'conversation-child',
      rootAgentSlug: 'planner',
      rootConversationId: 'conversation-root',
    });
  });

  test('a forged _delegation naming another tree is ignored', async () => {
    const result = await callTool('session-child', 'delegate_task', {
      ...DELEGATE_ARGS,
      _delegation: FORGED,
    });
    expect(result.isError).toBe(false);
    const stamped = stampedDelegation(delegateTask) as AgentDelegationContext;
    expect(stamped.rootConversationId).toBe('conversation-root');
    expect(stamped.parentConversationId).toBe('conversation-child');
    expect(stamped.maxDepth).toBe(2);
    expect(JSON.stringify(stamped)).not.toContain('victim');
  });

  test('a session already at its maxDepth is refused before any child starts', async () => {
    const result = await callTool('session-deep', 'delegate_task', {
      ...DELEGATE_ARGS,
      // A model claiming a shallow depth does not lift the limit.
      _delegation: { ...ROOT_CHILD, depth: 0 },
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Delegation depth limit reached (2)');
    expect(delegateTask).not.toHaveBeenCalled();
  });

  test('a verified session with no recorded Agent is refused rather than starting a root', async () => {
    const result = await callTool(
      'session-agentless',
      'delegate_task',
      DELEGATE_ARGS,
    );
    expect(result.isError).toBe(true);
    expect(result.text).toContain('the session has no recorded Agent');
    expect(delegateTask).not.toHaveBeenCalled();
  });
});

describe('#2601 send_message stamps lineage from the verified caller', () => {
  test('omitted _delegation: the child still names its true parent and root', async () => {
    const result = await callTool('session-child', 'send_message', SEND_ARGS);
    expect(result.isError).toBe(false);
    expect(stampedDelegation(executeForegroundMessage)).toMatchObject({
      depth: 2,
      parentConversationId: 'conversation-child',
      rootConversationId: 'conversation-root',
    });
  });

  test('a forged _delegation (with a forged attestation) is ignored', async () => {
    const result = await callTool('session-root', 'send_message', {
      ...SEND_ARGS,
      _delegation: FORGED,
      _delegationAttestation: 'forged',
    });
    expect(result.isError).toBe(false);
    expect(stampedDelegation(executeForegroundMessage)).toMatchObject({
      depth: 1,
      parentConversationId: 'conversation-root',
      rootConversationId: 'conversation-root',
      maxDepth: 2,
    });
  });

  test('beyond maxDepth is refused for an external engine', async () => {
    const result = await callTool('session-deep', 'send_message', SEND_ARGS);
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Delegation depth limit reached (2)');
    expect(executeForegroundMessage).not.toHaveBeenCalled();
  });
});

describe('#2601 a request with no verified caller claims no lineage', () => {
  const internalHeaders = () => ({
    'content-type': 'application/json',
    [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
    [INTERNAL_PROXY_CALLER_HEADER]: 'local',
  });
  const body = {
    message: 'Draft the plan',
    target: { environment: { kind: 'current' }, agent: 'writer' },
  };

  test("Station's own engine: a context its runtime attested is kept as derived", async () => {
    // What `mcp-manager.ts` sends through the pooled station-control child.
    const delegation = createChildDelegationContext({
      agentSlug: 'planner',
      conversationId: 'conversation-in-process',
      spec: SPECS.planner,
    });
    const response = await fetch(
      `${baseUrl}/api/orchestration/chat/delegated`,
      {
        method: 'POST',
        headers: internalHeaders(),
        body: JSON.stringify({
          ...body,
          delegation,
          delegationAttestation: attestDelegationContext(delegation),
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(stampedDelegation(executeForegroundMessage)).toEqual(delegation);
  });

  test('an unattested context, or one whose attestation vouches for a different context, is dropped: the session starts as a root', async () => {
    const genuine = createChildDelegationContext({
      agentSlug: 'planner',
      conversationId: 'conversation-in-process',
      spec: SPECS.planner,
    });
    for (const claim of [
      { delegation: FORGED },
      { delegation: FORGED, delegationAttestation: 'forged' },
      // A genuine attestation replayed onto another tree's root.
      {
        delegation: { ...genuine, rootConversationId: 'conversation-victim' },
        delegationAttestation: attestDelegationContext(genuine),
      },
    ]) {
      executeForegroundMessage.mockClear();
      const response = await fetch(
        `${baseUrl}/api/orchestration/chat/delegated`,
        {
          method: 'POST',
          headers: internalHeaders(),
          body: JSON.stringify({ ...body, ...claim }),
        },
      );
      expect(response.status).toBe(200);
      expect(stampedDelegation(executeForegroundMessage)).toBeUndefined();
    }
  });
});

describe('#2601 registry default Agents delegate under the default policy', () => {
  const defaultPolicyChild = (agentSlug: string, conversationId: string) =>
    createChildDelegationContext({ agentSlug, conversationId });

  test.each([
    ['station', 'session-station', 'conversation-station'],
    ['claude', 'session-claude', 'conversation-claude'],
    ['codex', 'session-codex', 'conversation-codex'],
  ])(
    'a session on the default %s Agent (no stored spec) delegates with the default policy',
    async (agentSlug, sessionId, conversationId) => {
      const delegated = await callTool(
        sessionId,
        'delegate_task',
        DELEGATE_ARGS,
      );
      expect(delegated.isError).toBe(false);
      expect(stampedDelegation(delegateTask)).toEqual(
        defaultPolicyChild(agentSlug, conversationId),
      );
      const sent = await callTool(sessionId, 'send_message', SEND_ARGS);
      expect(sent.isError).toBe(false);
      expect(stampedDelegation(executeForegroundMessage)).toEqual(
        defaultPolicyChild(agentSlug, conversationId),
      );
    },
  );

  test('an absent spec for an Agent the registry does not list, and an unreadable stored spec, are refused', async () => {
    for (const [sessionId, agentSlug] of [
      ['session-ghost', 'ghost'],
      ['session-broken', 'broken'],
    ]) {
      delegateTask.mockClear();
      const result = await callTool(sessionId!, 'delegate_task', DELEGATE_ARGS);
      expect(result.isError).toBe(true);
      expect(result.text).toContain(
        `its Agent '${agentSlug}' could not be read`,
      );
      expect(delegateTask).not.toHaveBeenCalled();
    }
  });

  test('an adopted session (no Agent) is named by its engine and bounded by the default policy', async () => {
    const result = await callTool(
      'session-adopted',
      'delegate_task',
      DELEGATE_ARGS,
    );
    expect(result.isError).toBe(false);
    expect(stampedDelegation(delegateTask)).toEqual(
      defaultPolicyChild('codex', 'conversation-adopted'),
    );
  });

  test.each(['session-adopted-unclean', 'session-adopted-trailing'])(
    'an adopted session whose recorded engine is not a clean Agent id (%s) gets the typed refusal, not named by it',
    async (sessionId) => {
      const result = await callTool(sessionId, 'delegate_task', DELEGATE_ARGS);
      expect(result.isError).toBe(true);
      expect(result.text).toContain('the session has no recorded Agent');
      expect(delegateTask).not.toHaveBeenCalled();
    },
  );

  test('a session with a known engine but no Agent and no adoption record is refused: only adoption lets an engine name the caller', async () => {
    const result = await callTool(
      'session-engine-only',
      'delegate_task',
      DELEGATE_ARGS,
    );
    expect(result.isError).toBe(true);
    expect(result.text).toContain('the session has no recorded Agent');
    expect(delegateTask).not.toHaveBeenCalled();
  });

  test('a stored spec that names a delegation policy is unreadable today (the agent schema has no such field), so its sessions are refused rather than defaulted', async () => {
    await expect(agentService.getAgent('policied')).rejects.toThrow(
      /Invalid agent configuration/,
    );
    const result = await callTool(
      'session-policied',
      'delegate_task',
      DELEGATE_ARGS,
    );
    expect(result.isError).toBe(true);
    expect(result.text).toContain("its Agent 'policied' could not be read");
    expect(delegateTask).not.toHaveBeenCalled();
  });
});

describe('#2601 send_message continuing a conversation', () => {
  test('a verified caller continuing an existing conversation still stamps the context derived from ITS session, not the model claim', async () => {
    const result = await callTool('session-child', 'send_message', {
      ...SEND_ARGS,
      conversationId: 'conversation-existing',
      _delegation: FORGED,
    });
    expect(result.isError).toBe(false);
    expect(executeForegroundMessage.mock.calls[0]![0]).toMatchObject({
      conversationId: 'conversation-existing',
    });
    expect(stampedDelegation(executeForegroundMessage)).toMatchObject({
      depth: 2,
      parentConversationId: 'conversation-child',
      rootConversationId: 'conversation-root',
    });
  });
});

describe('#2601 forwards to a saved Environment carry the derived context', () => {
  const peerArgs = { environmentId: PEER_ENVIRONMENT_ID };

  test('delegate_task: the peer receives THIS Station’s derivation, not the forged claim, and no attestation', async () => {
    const result = await callTool('session-child', 'delegate_task', {
      ...DELEGATE_ARGS,
      ...peerArgs,
      _delegation: FORGED,
      _delegationAttestation: 'forged',
    });
    expect(result.isError).toBe(false);
    expect(delegateTask).not.toHaveBeenCalled();
    expect(peerReceived).toHaveLength(1);
    expect(peerReceived[0]!.path).toBe('/api/orchestration/delegations');
    expect(peerReceived[0]!.body.delegation).toMatchObject({
      depth: 2,
      parentConversationId: 'conversation-child',
      rootConversationId: 'conversation-root',
      maxDepth: 2,
    });
    expect(peerReceived[0]!.authorization).toBe(`Bearer ${PEER_CREDENTIAL}`);
    expect(peerReceived[0]!.body).not.toHaveProperty('delegationAttestation');
  });

  test('send_message: an omitted _delegation still reaches the peer as the derived context', async () => {
    const result = await callTool('session-root', 'send_message', {
      ...SEND_ARGS,
      ...peerArgs,
    });
    expect(result.isError).toBe(false);
    expect(executeForegroundMessage).not.toHaveBeenCalled();
    expect(peerReceived).toHaveLength(1);
    expect(peerReceived[0]!.path).toBe('/api/orchestration/chat/delegated');
    expect(peerReceived[0]!.body.delegation).toMatchObject({
      depth: 1,
      parentConversationId: 'conversation-root',
      rootConversationId: 'conversation-root',
    });
  });

  test('a caller at its depth limit is refused before anything reaches the peer, for both tools', async () => {
    for (const [name, args] of [
      ['delegate_task', DELEGATE_ARGS],
      ['send_message', SEND_ARGS],
    ] as const) {
      const result = await callTool('session-deep', name, {
        ...args,
        ...peerArgs,
        _delegation: { ...ROOT_CHILD, depth: 0 },
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('Delegation depth limit reached (2)');
    }
    expect(peerReceived).toHaveLength(0);
  });
});

describe("#2601 Station's own engine: the attested context survives the real tool forward", () => {
  type Handler = (args: Record<string, unknown>) => Promise<{
    isError?: boolean;
    content: Array<{ text: string }>;
  }>;

  /**
   * The REAL tool handlers behind Station's own engine's `mcp-manager.ts`
   * wrapper, with no per-session caller (the pooled child has none), so the
   * route's only reason to keep a context is its attestation.
   */
  function stationEngineTool(name: 'send_message' | 'delegate_task') {
    const server = new McpServer({ name: 'lineage-e2e', version: '0.0.0' });
    registerOperationsTools(new StationControlToolRegistry(server));
    const handler = (
      server as unknown as {
        _registeredTools: Record<string, { handler: Handler }>;
      }
    )._registeredTools[name]!.handler;
    const [wrapped] = wrapDelegationAwareTools(
      [
        {
          name: `station-control_${name}`,
          description: name,
          parameters: {},
          execute: (args: Record<string, unknown>) => handler(args),
        } as never,
      ],
      {
        agentSlug: 'planner',
        toolId: 'station-control',
        spec: SPECS.planner,
      },
    );
    return (args: Record<string, unknown>) =>
      wrapped!.execute!(args, {
        conversationId: 'conversation-in-process',
      } as never) as ReturnType<Handler>;
  }

  const expected = () =>
    createChildDelegationContext({
      agentSlug: 'planner',
      conversationId: 'conversation-in-process',
      spec: SPECS.planner,
    });

  test('send_message: tool → /chat/delegated keeps the attested context', async () => {
    const result = await stationEngineTool('send_message')(SEND_ARGS);
    expect(result.isError).not.toBe(true);
    expect(stampedDelegation(executeForegroundMessage)).toEqual(expected());
  });

  test('delegate_task: tool → /delegations keeps the attested context (deliberate: its children now carry lineage and the child denials)', async () => {
    const result = await stationEngineTool('delegate_task')(DELEGATE_ARGS);
    expect(result.isError).not.toBe(true);
    expect(stampedDelegation(delegateTask)).toEqual(expected());
    expect(delegateTask.mock.calls[0]![0]).toMatchObject({
      parentTaskId: 'conversation-in-process',
    });
  });
});

describe('#2601 the caller-delegation route is internal-only', () => {
  const PATH = '/api/orchestration/station-control/caller/delegation';
  const internalHeaders = () => ({
    [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
    [INTERNAL_PROXY_CALLER_HEADER]: 'local',
  });

  test('an internal request with a verified per-session token gets ITS OWN session’s child context; with none, or a forged one, null', async () => {
    for (const [sessionId, expected] of [
      [
        'session-child',
        { depth: 2, parentConversationId: 'conversation-child' },
      ],
      ['session-root', { depth: 1, parentConversationId: 'conversation-root' }],
    ] as const) {
      const { token } = mintStationControlMcpToken(sessionId, 'url-token');
      const response = await fetch(`${baseUrl}${PATH}`, {
        headers: {
          ...internalHeaders(),
          [STATION_CONTROL_CALLER_TOKEN_HEADER]: token,
        },
      });
      expect(response.status).toBe(200);
      expect(
        ((await response.json()) as { delegation: unknown }).delegation,
      ).toMatchObject({ ...expected, rootConversationId: 'conversation-root' });
    }
    for (const headers of [
      internalHeaders(),
      { ...internalHeaders(), [STATION_CONTROL_CALLER_TOKEN_HEADER]: 'forged' },
    ]) {
      const response = await fetch(`${baseUrl}${PATH}`, { headers });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ delegation: null });
    }
  });

  test.each([
    ['an operator bearer', { authorization: `Bearer ${OPERATOR_CREDENTIAL}` }],
    ['a paired device', { authorization: `Bearer ${DEVICE_CREDENTIAL}` }],
    [
      "a peer Station's delegation grant",
      { authorization: `Bearer ${PEER_GRANT_CREDENTIAL}` },
    ],
    [
      'a browser session',
      { cookie: `station-device=${BROWSER_SESSION_CREDENTIAL}` },
    ],
  ])(
    '%s gets 404 even when it presents a live per-session token',
    async (_principal, credentialHeaders) => {
      const { token } = mintStationControlMcpToken(
        'session-child',
        'url-token',
      );
      const response = await fetch(`${baseUrl}${PATH}`, {
        headers: {
          ...credentialHeaders,
          [STATION_CONTROL_CALLER_TOKEN_HEADER]: token,
        },
      });
      // The boundary ACCEPTED the credential (a refused one is 401/403), so
      // this 404 is the route's own internal-only gate.
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: { code: 'not_found' } });
    },
  );
});

describe('#2601 forwards to a saved Environment with no verified caller', () => {
  type Handler = (args: Record<string, unknown>) => Promise<{
    isError?: boolean;
    content: Array<{ text: string }>;
  }>;
  function rawTool(name: 'send_message' | 'delegate_task'): Handler {
    const server = new McpServer({ name: 'lineage-raw', version: '0.0.0' });
    registerOperationsTools(new StationControlToolRegistry(server));
    return (
      server as unknown as {
        _registeredTools: Record<string, { handler: Handler }>;
      }
    )._registeredTools[name]!.handler;
  }
  const peerArgs = { environmentId: PEER_ENVIRONMENT_ID };

  test('pre-#2601 behaviour kept: an unverified, unattested send_message forwards its claim to the peer as it was given', async () => {
    const result = await rawTool('send_message')({
      ...SEND_ARGS,
      ...peerArgs,
      _delegation: FORGED,
    });
    expect(result.isError).not.toBe(true);
    expect(peerReceived).toHaveLength(1);
    expect(peerReceived[0]!.path).toBe('/api/orchestration/chat/delegated');
    expect(peerReceived[0]!.body.delegation).toEqual(FORGED);
    expect(peerReceived[0]!.body).not.toHaveProperty('delegationAttestation');
  });

  test('pre-#2601 behaviour kept: an unverified, unattested delegate_task forwards no context', async () => {
    const result = await rawTool('delegate_task')({
      ...DELEGATE_ARGS,
      ...peerArgs,
      _delegation: FORGED,
    });
    expect(result.isError).not.toBe(true);
    expect(peerReceived).toHaveLength(1);
    expect(peerReceived[0]!.path).toBe('/api/orchestration/delegations');
    expect(peerReceived[0]!.body).not.toHaveProperty('delegation');
  });
});

describe("#2601 Station's own engine forwarding to a saved Environment", () => {
  type Handler = (args: Record<string, unknown>) => Promise<{
    isError?: boolean;
    content: Array<{ text: string }>;
  }>;
  /** The REAL tools behind the real `mcp-manager.ts` attesting wrapper. */
  function stationEngineTool(name: 'send_message' | 'delegate_task') {
    const server = new McpServer({ name: 'lineage-peer', version: '0.0.0' });
    registerOperationsTools(new StationControlToolRegistry(server));
    const handler = (
      server as unknown as {
        _registeredTools: Record<string, { handler: Handler }>;
      }
    )._registeredTools[name]!.handler;
    const [wrapped] = wrapDelegationAwareTools(
      [
        {
          name: `station-control_${name}`,
          description: name,
          parameters: {},
          execute: (args: Record<string, unknown>) => handler(args),
        } as never,
      ],
      { agentSlug: 'planner', toolId: 'station-control', spec: SPECS.planner },
    );
    return (args: Record<string, unknown>) =>
      wrapped!.execute!(args, {
        conversationId: 'conversation-in-process',
      } as never) as ReturnType<Handler>;
  }
  const expected = () =>
    createChildDelegationContext({
      agentSlug: 'planner',
      conversationId: 'conversation-in-process',
      spec: SPECS.planner,
    });

  test.each([
    ['delegate_task', DELEGATE_ARGS, '/api/orchestration/delegations'],
    ['send_message', SEND_ARGS, '/api/orchestration/chat/delegated'],
  ] as const)(
    '%s: the peer receives the attested derived context, without the attestation',
    async (name, args, path) => {
      const result = await stationEngineTool(name)({
        ...args,
        environmentId: PEER_ENVIRONMENT_ID,
      });
      expect(result.isError).not.toBe(true);
      expect(peerReceived).toHaveLength(1);
      expect(peerReceived[0]!.path).toBe(path);
      expect(peerReceived[0]!.body.delegation).toEqual(expected());
      expect(peerReceived[0]!.body).not.toHaveProperty('delegationAttestation');
    },
  );
});
