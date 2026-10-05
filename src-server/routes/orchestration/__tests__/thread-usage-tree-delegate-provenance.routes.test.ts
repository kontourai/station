/**
 * #3323: a conversation's usage tree counts a delegate the reader cannot read
 * as "not visible" (the total is partial) only when Station itself derived or
 * attested the delegate's link to the conversation; a link a request merely
 * claimed is ignored, so no one can mark someone else's total partial.
 *
 * Everything real except the engine and Station's own HTTP discovery reads:
 * the runtime auth boundary tells Station's internal principal from an
 * operator credential, the real orchestration routes resolve the delegation
 * context with the production resolver (`createRequestDelegationResolver`)
 * and stamp its provenance, the production executors
 * (`station-control-delegation.ts`) start the delegate through the real
 * `OrchestrationService` into a real `EventStore`, and the usage-tree route
 * reads it back. The stand-ins are the station-control caller lookup (a
 * Codex session's URL token, whose `bearer-exposed` assurance makes its
 * dispatch unattributed, so the delegate is the operator's), and who each
 * request authenticates as (`getUserId`): the hosted tenant who owns the
 * conversation, the operator principal Station's own requests act as, or
 * another user.
 */
import { join } from 'node:path';
import type { AgentSpec } from '@kontourai/station-contracts/agent';
import {
  DELEGATION_PROVENANCE_METADATA_KEY,
  type ProviderSendTurnInput,
  type ProviderSessionStartInput,
} from '@kontourai/station-contracts/provider';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import type { ThreadUsageTree } from '@kontourai/station-contracts/thread-usage-tree';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type {
  ProviderAdapterMetadata,
  ProviderAdapterShape,
  ProviderSession,
} from '../../../providers/adapter-shape.js';
import type { IProviderAdapterRegistry } from '../../../providers/provider-interfaces.js';
import { AsyncEventQueue } from '../../../providers/sessions/async-event-queue.js';
import { createChildDelegationContext } from '../../../runtime/agents/delegation.js';
import { attestDelegationContext } from '../../../runtime/agents/delegation-attestation.js';
import { createRequestDelegationResolver } from '../../../runtime/agents/request-delegation.js';
import { configureRuntimeHttp } from '../../../runtime/bootstrap/runtime-http.js';
import { createAgentDispatchActorResolver } from '../../../runtime/mcp/station-control-caller.js';
import { isStationInternalRequest } from '../../../services/browser/browser-request-origin.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { EnvironmentSecurityService } from '../../../services/ssh/environment-security-service.js';
import type { StationControlCaller } from '../../../tools/station-control-shared.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_PROXY_CALLER_HEADER,
} from '../../../utils/internal-api-token.js';
import { createLogger } from '../../../utils/logger.js';
import { createOrchestrationRoutes } from '../orchestration.js';

const CURRENT_API = 'http://usage-provenance.test';
process.env.STATION_API_BASE = CURRENT_API;

const TENANT = 'tenant-user';
const OPERATOR = 'station-operator';
const MALLORY = 'other-user';
const CONVERSATION = 'conv-tenant';
const AGENT = 'codex-agent';
const PLANNER: AgentSpec = { name: 'Planner', prompt: 'Plan' };
/** Stand-in for a Codex session's verified URL token (`bearer-exposed`). */
const CALLER_HEADER = 'x-test-station-control-caller';
const TENANT_CODEX_CALLER: StationControlCaller = {
  sessionId: 'tenant-codex-session',
  assurance: 'bearer-exposed',
  conversationId: CONVERSATION,
  principal: {
    id: TENANT,
    source: 'session-owner',
    elevationEligible: true,
  },
};

const fetchMock = vi.fn<typeof fetch>();

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installStationDiscovery(): void {
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url === `${CURRENT_API}/.well-known/station/v1`)
      return json({ environmentId: 'environment-current' });
    if (url === `${CURRENT_API}/api/agents/${AGENT}`)
      return json({
        success: true,
        data: {
          slug: AGENT,
          name: AGENT,
          available: true,
          execution: { agentConnectionId: 'codex-connection' },
        },
      });
    if (url === `${CURRENT_API}/api/connections/codex-connection`)
      return json({
        success: true,
        data: {
          id: 'codex-connection',
          kind: 'agent',
          type: 'codex',
          enabled: true,
          status: 'ready',
          capabilities: ['agent-runtime'],
          config: { provider: 'codex' },
        },
      });
    throw new Error(`Unexpected request in usage provenance test: ${url}`);
  });
}

/** Persists what an adapter reports: its start echoes the prepared metadata. */
class RecordingEngine implements ProviderAdapterShape {
  readonly provider = 'codex' as const;
  readonly metadata: ProviderAdapterMetadata = {
    displayName: 'codex',
    description: 'usage provenance test engine',
    capabilities: ['agent-runtime'],
  };
  readonly events = new AsyncEventQueue<CanonicalRuntimeEvent>();
  readonly starts: ProviderSessionStartInput[] = [];
  private readonly sessions = new Map<string, ProviderSession>();

  async startSession(
    input: ProviderSessionStartInput,
  ): Promise<ProviderSession> {
    this.starts.push(input);
    const now = new Date().toISOString();
    this.events.push({
      eventId: `${input.threadId}:session.started:${this.starts.length}`,
      provider: this.provider,
      threadId: input.threadId,
      createdAt: now,
      method: 'session.started',
      sessionId: input.threadId,
      metadata: { ...input.metadata },
    } as CanonicalRuntimeEvent);
    const session: ProviderSession = {
      provider: this.provider,
      threadId: input.threadId,
      status: 'ready',
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(input.threadId, session);
    return session;
  }
  async sendTurn(input: ProviderSendTurnInput) {
    return { threadId: input.threadId, turnId: `turn-${input.threadId}` };
  }
  async steerTurn() {}
  async interruptTurn() {
    return { outcome: 'no-active-turn' } as const;
  }
  async respondToRequest(): Promise<void> {}
  async stopSession(threadId: string): Promise<void> {
    this.sessions.delete(threadId);
  }
  async listSessions(): Promise<ProviderSession[]> {
    return [...this.sessions.values()];
  }
  async hasSession(threadId: string): Promise<boolean> {
    return this.sessions.has(threadId);
  }
  async stopAll(): Promise<void> {}
  streamEvents(options?: {
    signal?: AbortSignal;
  }): AsyncIterable<CanonicalRuntimeEvent> {
    return this.events.iterable(options);
  }
}

const makeTempDir = trackTempDirs();
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  installStationDiscovery();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

let usageOrdinal = 0;
function appendUsage(store: EventStore, threadId: string, tokens: number) {
  store.appendEvent({
    eventId: `${threadId}:usage:${++usageOrdinal}`,
    threadId,
    turnId: `${threadId}:turn:${usageOrdinal}`,
    provider: 'codex',
    method: 'token-usage.updated',
    createdAt: new Date().toISOString(),
    promptTokens: tokens,
    completionTokens: tokens,
  } as CanonicalRuntimeEvent);
}

async function fixture() {
  vi.stubEnv('STATION_HOSTED_TENANT_REGISTRY_FILE', undefined);
  const root = makeTempDir('station-usage-provenance-');
  const security = new EnvironmentSecurityService({
    homeDir: join(root, 'home'),
  });
  const operator = await security.initialize();
  const store = new EventStore(join(root, 'orchestration.sqlite'));
  const eventBus = new EventBus();
  const engine = new RecordingEngine();
  const registry: IProviderAdapterRegistry = {
    register() {},
    get: (provider) => (provider === 'codex' ? engine : undefined),
    list: () => [engine],
  };
  const service = new OrchestrationService({
    adapterRegistry: registry,
    eventBus,
    eventStore: store,
    resolveSessionAgent: async (input: ProviderSessionStartInput) => ({
      ...input,
      agent: { slug: String(input.metadata?.agentSlug ?? 'agent') },
    }),
    logger: { debug: vi.fn(), warn: vi.fn() },
  } as never);
  cleanups.push(async () => {
    await service.shutdown();
    store.close();
  });

  // The tenant's conversation, with usage of its own.
  store.upsertSession({
    provider: 'codex',
    threadId: CONVERSATION,
    status: 'closed',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:01.000Z',
  });
  store.appendEvent({
    eventId: `${CONVERSATION}:start`,
    threadId: CONVERSATION,
    sessionId: CONVERSATION,
    provider: 'codex',
    method: 'session.started',
    createdAt: '2026-10-01T00:00:00.000Z',
    metadata: { userId: TENANT },
  } as CanonicalRuntimeEvent);
  appendUsage(store, CONVERSATION, 10);

  const { delegateTask, executeExecutionTargetMessage } = await import(
    '../../../tools/station-control-delegation.js'
  );
  const readAuthority = (userId: string) =>
    sessionReadAuthorityFromRequest(userId, undefined, undefined);
  let currentUser = TENANT;

  const app = new Hono();
  configureRuntimeHttp({
    app: app as never,
    logger: createLogger({ name: 'usage-provenance-test', level: 'error' }),
    eventBus: { emit() {} } as unknown as EventBus,
    security: {
      verifyCredential: (candidate, request) =>
        request !== undefined &&
        security.authorizeCredential(candidate, request),
      recognizeCredential: (candidate) => security.verifyCredential(candidate),
      resolveGrantedScope: (candidate) =>
        security.resolveGrantedScope(candidate),
      resolveCredentialAuthority: (candidate) =>
        security.verifyOperatorCredential(candidate)
          ? 'operator-credential'
          : undefined,
      resolveCredentialDeviceId: () => undefined,
      resolveCredentialLocality: (candidate) =>
        security.credentialLocality(candidate),
      resolveCredentialMintKind: (candidate) =>
        security.credentialMintKind(candidate),
      allowedOrigins: [],
    },
  });
  app.route(
    '/api/orchestration',
    createOrchestrationRoutes(service, {
      eventBus,
      logger: { debug: vi.fn() },
      getUserId: () => currentUser,
      isRequestPrincipalCurrent: () => true,
      resolveAgentDispatchActor: createAgentDispatchActorResolver(),
      // The production resolver over stand-in records of the caller.
      resolveRequestDelegation: createRequestDelegationResolver({
        isInternalRequest: isStationInternalRequest,
        resolveCaller: (request) =>
          request.headers.get(CALLER_HEADER) === TENANT_CODEX_CALLER.sessionId
            ? TENANT_CODEX_CALLER
            : null,
        startedMetadata: (sessionId) =>
          sessionId === TENANT_CODEX_CALLER.sessionId
            ? { agentSlug: 'planner' }
            : undefined,
        sessionEngine: () => 'codex',
        loadAgentSpec: async () => PLANNER,
        isRegistryDefaultAgent: async () => false,
      }),
      executeForegroundMessage: (input: { userId: string }) =>
        executeExecutionTargetMessage(
          { ...input, readAuthority: readAuthority(input.userId) } as never,
          service,
        ),
      delegateTask: (input: { userId: string }) =>
        delegateTask(
          { ...input, readAuthority: readAuthority(input.userId) } as never,
          service,
        ),
    } as never),
  );

  /** A session's start, as the engine's stream persisted it. */
  const startedMetadata = async (threadId: string) => {
    const started = await vi.waitFor(() => {
      const event = store
        .listSessionProjectionEvents(threadId)
        .find((row) => row.payload.method === 'session.started');
      expect(event).toBeDefined();
      return event!.payload as { metadata?: Record<string, unknown> };
    });
    return started.metadata ?? {};
  };

  const post = async (
    as: { user: string; internal?: boolean; caller?: boolean },
    path: string,
    body: unknown,
  ) => {
    currentUser = as.user;
    const response = await app.request(
      path,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(as.internal
            ? {
                [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
                [INTERNAL_PROXY_CALLER_HEADER]: 'local',
                ...(as.caller
                  ? { [CALLER_HEADER]: TENANT_CODEX_CALLER.sessionId }
                  : {}),
              }
            : { Authorization: `Bearer ${operator.credential}` }),
        },
        body: JSON.stringify(body),
      },
      as.internal
        ? ({ incoming: { socket: { remoteAddress: '127.0.0.1' } } } as never)
        : undefined,
    );
    const text = await response.text();
    expect(response.status, text).toBe(200);
    const data = JSON.parse(text).data as {
      taskId?: string;
      conversationId: string;
    };
    const threadId = data.taskId ?? data.conversationId;
    const metadata = await startedMetadata(threadId);
    // Usage the delegate ran, which no reader but its owner may see.
    appendUsage(store, threadId, 500);
    return { threadId, metadata };
  };

  const usageTree = async () => {
    currentUser = TENANT;
    const response = await app.request(
      `/api/orchestration/conversations/${CONVERSATION}/usage-tree`,
      { headers: { Authorization: `Bearer ${operator.credential}` } },
    );
    const text = await response.text();
    expect(response.status, text).toBe(200);
    return { tree: JSON.parse(text).data as ThreadUsageTree, text };
  };

  return { post, usageTree, service, store, startedMetadata };
}

const tenantChild = () =>
  createChildDelegationContext({
    agentSlug: 'planner',
    conversationId: CONVERSATION,
    spec: PLANNER,
  });
const delegateBody = (extra: Record<string, unknown> = {}) => ({
  prompt: 'Draft the plan',
  target: { environment: { kind: 'current' }, agent: AGENT },
  ...extra,
});

/** The tenant's own figures only: the delegate's 1,000 tokens never count. */
const OWN_TOKENS = 20;

describe('#3323 an unreadable delegate Station linked to the conversation makes its total partial', () => {
  test("an attested delegate of Station's own agent, owned by the operator, is counted as not visible", async () => {
    const f = await fixture();
    const delegation = tenantChild();
    const delegate = await f.post(
      { user: OPERATOR, internal: true },
      '/api/orchestration/delegations',
      delegateBody({
        delegation,
        delegationAttestation: attestDelegationContext(delegation),
      }),
    );
    expect(delegate.metadata).toMatchObject({
      userId: OPERATOR,
      delegation: { parentConversationId: CONVERSATION },
      [DELEGATION_PROVENANCE_METADATA_KEY]: 'runtime-attested',
    });

    const { tree, text } = await f.usageTree();
    expect(tree.total.tokens).toMatchObject({
      totalTokens: OWN_TOKENS,
      complete: false,
    });
    expect(tree.total.cost.complete).toBe(false);
    expect(tree.total.partialReasons).toEqual([
      "1 delegated task runs under an owner you can't read, so its usage is not counted.",
    ]);
    // Never named, never figured.
    expect(tree.root.children).toEqual([]);
    expect(text).not.toContain(delegate.threadId);
    expect(text).not.toContain('Draft the plan');
  });

  test("a delegate whose context Station derived from the calling session (a Codex caller's unattributed dispatch) is counted as not visible", async () => {
    const f = await fixture();
    const delegate = await f.post(
      { user: OPERATOR, internal: true, caller: true },
      '/api/orchestration/delegations',
      delegateBody(),
    );
    expect(delegate.metadata).toMatchObject({
      userId: OPERATOR,
      delegation: { parentConversationId: CONVERSATION },
      [DELEGATION_PROVENANCE_METADATA_KEY]: 'caller-derived',
    });
    const { tree } = await f.usageTree();
    expect(tree.total.tokens).toMatchObject({
      totalTokens: OWN_TOKENS,
      complete: false,
    });
    expect(tree.root.children).toEqual([]);
  });

  test('send_message: an attested foreground child, owned by the operator, is counted as not visible', async () => {
    const f = await fixture();
    const delegation = tenantChild();
    const child = await f.post(
      { user: OPERATOR, internal: true },
      '/api/orchestration/chat/delegated',
      {
        message: 'Draft the plan',
        target: { environment: { kind: 'current' }, agent: AGENT },
        delegation,
        delegationAttestation: attestDelegationContext(delegation),
      },
    );
    expect(child.metadata).toMatchObject({
      userId: OPERATOR,
      [DELEGATION_PROVENANCE_METADATA_KEY]: 'runtime-attested',
    });
    const { tree } = await f.usageTree();
    expect(tree.total.tokens.complete).toBe(false);
    expect(tree.total.partialReasons).toHaveLength(1);
  });
});

describe('#3323 an unreadable session that only claims the conversation is ignored', () => {
  test("another user's direct request naming the tenant's conversation leaves the total complete", async () => {
    const f = await fixture();
    const forged = await f.post(
      { user: MALLORY },
      '/api/orchestration/delegations',
      delegateBody({ delegation: tenantChild() }),
    );
    // The claim is stamped as it arrived, and marked as a claim.
    expect(forged.metadata).toMatchObject({
      userId: MALLORY,
      delegation: { parentConversationId: CONVERSATION },
      [DELEGATION_PROVENANCE_METADATA_KEY]: 'direct-claim',
    });
    const { tree, text } = await f.usageTree();
    expect(tree.total.tokens).toMatchObject({
      totalTokens: OWN_TOKENS,
      complete: true,
    });
    expect(tree.total.cost.complete).toBe(true);
    expect(tree.total.partialReasons).toEqual([]);
    expect(text).not.toContain(forged.threadId);
  });

  test('a provenance a request body supplies is never what is stamped', async () => {
    const f = await fixture();
    const forged = await f.post(
      { user: MALLORY },
      '/api/orchestration/delegations',
      delegateBody({
        delegation: {
          ...tenantChild(),
          [DELEGATION_PROVENANCE_METADATA_KEY]: 'caller-derived',
        },
        delegationProvenance: 'runtime-attested',
        [DELEGATION_PROVENANCE_METADATA_KEY]: 'caller-derived',
        metadata: { [DELEGATION_PROVENANCE_METADATA_KEY]: 'caller-derived' },
      }),
    );
    expect(forged.metadata[DELEGATION_PROVENANCE_METADATA_KEY]).toBe(
      'direct-claim',
    );
    expect(forged.metadata.delegation).not.toHaveProperty(
      DELEGATION_PROVENANCE_METADATA_KEY,
    );
    const { tree } = await f.usageTree();
    expect(tree.total.tokens.complete).toBe(true);
    expect(tree.total.partialReasons).toEqual([]);
  });
});

describe('#3323 the provenance stamp is reserved', () => {
  test('a start whose caller metadata carries the stamp has it stripped; only the dispatch seam writes it', async () => {
    const f = await fixture();
    // The public command seam: the same untyped metadata bag any caller's
    // start could carry.
    const forged = await f.service.sessionCommands.execute(
      {
        type: 'start-session',
        input: {
          threadId: 'forged-stamp',
          provider: 'codex',
          metadata: {
            userId: MALLORY,
            delegation: tenantChild(),
            [DELEGATION_PROVENANCE_METADATA_KEY]: 'caller-derived',
          },
        },
      },
      { userId: MALLORY },
    );
    expect(forged.status).toBe('accepted');
    const forgedMetadata = await f.startedMetadata('forged-stamp');
    expect(forgedMetadata.delegation).toMatchObject({
      parentConversationId: CONVERSATION,
    });
    expect(forgedMetadata).not.toHaveProperty(
      DELEGATION_PROVENANCE_METADATA_KEY,
    );

    // The internal seam re-stamps its own value over a forged one.
    const restamped = await f.service.startSessionInternal(
      {
        type: 'start-session',
        input: {
          threadId: 'restamped',
          provider: 'codex',
          metadata: {
            userId: MALLORY,
            delegation: tenantChild(),
            [DELEGATION_PROVENANCE_METADATA_KEY]: 'caller-derived',
          },
        },
      },
      { userId: MALLORY },
      {
        delegationProvenance: {
          context: tenantChild(),
          provenance: 'direct-claim',
        },
      },
    );
    expect(restamped.status).toBe('accepted');
    expect(
      (await f.startedMetadata('restamped'))[
        DELEGATION_PROVENANCE_METADATA_KEY
      ],
    ).toBe('direct-claim');

    const { tree } = await f.usageTree();
    expect(tree.total.tokens.complete).toBe(true);
    expect(tree.total.partialReasons).toEqual([]);
  });

  test('the stamp travels with the context the route resolved: a start carrying any other context is never stamped', async () => {
    const f = await fixture();
    const other = createChildDelegationContext({
      agentSlug: 'planner',
      conversationId: 'conv-other',
      spec: PLANNER,
    });
    const outcome = await f.service.startSessionInternal(
      {
        type: 'start-session',
        input: {
          threadId: 'mismatched-context',
          provider: 'codex',
          metadata: { userId: OPERATOR, delegation: tenantChild() },
        },
      },
      { userId: OPERATOR },
      {
        delegationProvenance: {
          context: other,
          provenance: 'runtime-attested',
        },
      },
    );
    expect(outcome.status).toBe('accepted');
    const metadata = await f.startedMetadata('mismatched-context');
    expect(metadata.delegation).toMatchObject({
      parentConversationId: CONVERSATION,
    });
    expect(metadata).not.toHaveProperty(DELEGATION_PROVENANCE_METADATA_KEY);
    // Unreadable to the tenant and unstamped, so it stays ignored.
    const { tree } = await f.usageTree();
    expect(tree.total.tokens.complete).toBe(true);
    expect(tree.total.partialReasons).toEqual([]);
  });
});
