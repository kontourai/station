/**
 * #2601: a delegated child's lineage comes from the VERIFIED caller, never
 * from the `_delegation` tool argument a model writes.
 *
 * Everything runs through a real listening server: the production runtime
 * security boundary (`configureRuntimeHttp`), the production station-control
 * MCP route serving the REAL `delegate_task`/`send_message` tools, and the
 * REAL orchestration dispatch routes with the production delegation resolver
 * (`createRequestDelegationResolver`) over real token verification. The only
 * stand-ins are the records the resolver reads (session start metadata and
 * Agent specs) and the two dispatch effects, which record the `delegation`
 * the child session would be started with (`execution-target-execution.ts`
 * and `delegateTask` both stamp exactly `input.delegation` into
 * `session.started` metadata).
 */
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import type {
  AgentDelegationContext,
  AgentSpec,
} from '@kontourai/station-contracts/agent';
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
import { createChildDelegationContext } from '../../../runtime/agents/delegation.js';
import { attestDelegationContext } from '../../../runtime/agents/delegation-attestation.js';
import { createRequestDelegationResolver } from '../../../runtime/agents/request-delegation.js';
import { configureRuntimeHttp } from '../../../runtime/bootstrap/runtime-http.js';
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
import { isStationInternalRequest } from '../../../services/browser/browser-request-origin.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_PROXY_CALLER_HEADER,
} from '../../../utils/internal-api-token.js';
import type { Logger } from '../../../utils/logger.js';
import { createOrchestrationRoutes } from '../../orchestration/orchestration.js';
import {
  createStationControlMcpRoutes,
  STATION_CONTROL_MCP_PATH,
} from '../station-control-mcp-route.js';

const ENVIRONMENT_ID = 'env-lineage-test';

// The delegation policy each Agent's spec declares.
const SPECS: Record<string, AgentSpec> = {
  planner: { name: 'Planner', prompt: 'Plan', delegation: { maxDepth: 2 } },
  shallow: { name: 'Shallow', prompt: 'One hop', delegation: { maxDepth: 1 } },
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
  // A root whose Agent allows one hop only: its child sits at the limit.
  'session-shallow': { agentSlug: 'shallow' },
  // A one-hop Agent's child: at ITS Agent's limit, though a planner child
  // at the same depth (`session-child`) may still delegate.
  'session-shallow-child': {
    agentSlug: 'shallow',
    delegation: { ...ROOT_CHILD, depth: 1 },
  },
  // A session with no recorded Agent: nothing to derive from.
  'session-agentless': {},
};
const CONVERSATIONS: Record<string, string> = {
  'session-root': 'conversation-root',
  'session-child': 'conversation-child',
  'session-deep': 'conversation-deep',
  'session-shallow': 'conversation-shallow',
  'session-shallow-child': 'conversation-shallow-child',
  'session-agentless': 'conversation-agentless',
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

let server: ReturnType<typeof serve>;
let baseUrl: string;

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
      verifyCredential: () => false,
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
  // The tools resolve the current Station through its public handshake.
  app.get('/.well-known/station/v1', (c) =>
    c.json({ environmentId: ENVIRONMENT_ID }),
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
        // The production composition (`runtime-routes.ts`) over this suite's
        // records.
        resolveRequestDelegation: createRequestDelegationResolver({
          isInternalRequest: isStationInternalRequest,
          resolveCaller: (request) =>
            resolveStationControlCallerForRequest(request, resolveRecord),
          startedMetadata: (threadId) => STARTED[threadId],
          loadAgentSpec: async (slug) => {
            const spec = SPECS[slug];
            if (!spec) throw new Error(`no agent ${slug}`);
            return spec;
          },
        }),
      } as never,
    ),
  );
  process.env.STATION_API_BASE = baseUrl;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.STATION_API_BASE;
});

beforeEach(() => {
  __resetStationControlMcpTokensForTests();
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

  test("the limit is the calling session's own Agent policy", async () => {
    const first = await callTool(
      'session-shallow',
      'delegate_task',
      DELEGATE_ARGS,
    );
    expect(first.isError).toBe(false);
    expect(stampedDelegation(delegateTask)).toMatchObject({
      depth: 1,
      maxDepth: 1,
    });
    delegateTask.mockClear();
    const refused = await callTool(
      'session-shallow-child',
      'delegate_task',
      DELEGATE_ARGS,
    );
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('Delegation depth limit reached (1)');
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
