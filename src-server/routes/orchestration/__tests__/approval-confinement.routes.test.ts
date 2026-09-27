/**
 * #2493: confinement is a server-derived axis beside the approval mode. A
 * session reaches `host` (Codex `danger-full-access`, Claude
 * `bypassPermissions`) only when the caller that STARTED it may grant full
 * access: the operator in person or a device holding `approval:full-access`.
 * Any other starter that reaches `never` through an Agent or Station default
 * gets `workspace`: Codex keeps `never` inside its workspace sandbox, Claude
 * applies `auto`.
 *
 * Everything real except the engines and the Station's own HTTP discovery
 * reads: the security service pairs devices, the runtime auth boundary
 * stamps principal and scope, the orchestration routes mint (or do not mint)
 * the grant, the production foreground and delegation executors
 * (`station-control-delegation.ts`) carry it, and the real
 * `OrchestrationService` derives confinement and hands the engine its input.
 * The recording engines read exactly what an adapter would receive.
 */
import { join } from 'node:path';
import { agentId } from '@kontourai/station-contracts/agent-identity';
import {
  PAIRING_SCOPE_APPROVAL_FULL_ACCESS,
  PAIRING_SCOPE_PRESETS,
  pairingScopePresetString,
} from '@kontourai/station-contracts/environment-security';
import type {
  ApprovalMode,
  ProviderSendTurnInput,
  ProviderSessionStartInput,
} from '@kontourai/station-contracts/provider';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
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
import { configureRuntimeHttp } from '../../../runtime/bootstrap/runtime-http.js';
import { createAgentDispatchActorResolver } from '../../../runtime/mcp/station-control-caller.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { EnvironmentSecurityService } from '../../../services/ssh/environment-security-service.js';
import {
  STATION_CONTROL_ORIGIN_AGENT_TOOL,
  STATION_CONTROL_ORIGIN_HEADER,
} from '../../../tools/station-control-shared.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_PROXY_CALLER_HEADER,
} from '../../../utils/internal-api-token.js';
import { createLogger } from '../../../utils/logger.js';
import { createWebhookTurnStarter } from '../../webhooks/webhook-turn-starter.js';
import { createOrchestrationRoutes } from '../orchestration.js';

const CURRENT_API = 'http://confinement.test';
process.env.STATION_API_BASE = CURRENT_API;

const fetchMock = vi.fn<typeof fetch>();

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Two Agents on this Station, one per engine with an approval knob. */
const AGENTS = {
  'codex-agent': 'codex',
  'claude-agent': 'claude',
} as const;

function installStationDiscovery(): void {
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url === `${CURRENT_API}/.well-known/station/v1`)
      return json({ environmentId: 'environment-current' });
    for (const [slug, provider] of Object.entries(AGENTS)) {
      if (url === `${CURRENT_API}/api/agents/${slug}`)
        return json({
          success: true,
          data: {
            slug,
            name: slug,
            available: true,
            execution: { agentConnectionId: `${provider}-connection` },
          },
        });
      if (url === `${CURRENT_API}/api/connections/${provider}-connection`)
        return json({
          success: true,
          data: {
            id: `${provider}-connection`,
            kind: 'agent',
            type: provider,
            enabled: true,
            status: 'ready',
            capabilities: ['agent-runtime'],
            config: { provider },
          },
        });
    }
    throw new Error(`Unexpected request in confinement test: ${url}`);
  });
}

class RecordingEngine implements ProviderAdapterShape {
  readonly metadata: ProviderAdapterMetadata;
  readonly events = new AsyncEventQueue<CanonicalRuntimeEvent>();
  readonly starts: ProviderSessionStartInput[] = [];
  readonly turns: ProviderSendTurnInput[] = [];
  private readonly sessions = new Map<string, ProviderSession>();

  constructor(readonly provider: 'claude' | 'codex') {
    this.metadata = {
      displayName: provider,
      description: `${provider} confinement test engine`,
      capabilities: ['agent-runtime'],
    };
  }

  async startSession(
    input: ProviderSessionStartInput,
  ): Promise<ProviderSession> {
    this.starts.push(input);
    const now = new Date().toISOString();
    for (const method of ['session.started', 'session.configured'] as const)
      this.events.push({
        eventId: `${input.threadId}:${method}:${this.starts.length}`,
        provider: this.provider,
        threadId: input.threadId,
        createdAt: now,
        method,
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

  /** When set, every turn completes (the session goes idle and is reused, #2540). */
  completeTurns = false;

  async sendTurn(input: ProviderSendTurnInput) {
    this.turns.push(input);
    const turnId = `${this.provider}-turn-${this.turns.length}`;
    if (this.completeTurns) {
      const base = {
        provider: this.provider,
        threadId: input.threadId,
        turnId,
        createdAt: new Date().toISOString(),
      } as const;
      this.events.push({
        ...base,
        eventId: `${turnId}:started`,
        method: 'turn.started',
        prompt: input.input,
      } as CanonicalRuntimeEvent);
      this.events.push({
        ...base,
        eventId: `${turnId}:completed`,
        method: 'turn.completed',
        outputText: 'done',
      } as CanonicalRuntimeEvent);
    }
    return { threadId: input.threadId, turnId };
  }

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

// Registered before this file's own afterEach, so (after-hooks run last
// registered first) the services below are disposed before their home goes.
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

async function fixture(
  defaults: {
    station?: ApprovalMode;
    agents?: Partial<Record<keyof typeof AGENTS, ApprovalMode>>;
  } = { station: 'never' },
) {
  vi.stubEnv('STATION_HOSTED_TENANT_REGISTRY_FILE', undefined);
  const root = makeTempDir('station-confinement-');
  const security = new EnvironmentSecurityService({
    homeDir: join(root, 'home'),
  });
  const operator = await security.initialize();
  const pair = (name: string, fullAccess = false) => {
    const offer = security.devicePairing.createOffer({
      endpoint: 'https://station.example.test',
      scope: pairingScopePresetString('standard'),
    });
    const requested = security.devicePairing.requestPairing({
      requesterPosition: 'off-box',
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: name,
    });
    security.devicePairing.confirmRequest(requested.requestId, {
      kind: 'presented-credential',
    });
    const paired = security.devicePairing.exchange({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: requested.requestId,
    });
    if (fullAccess)
      security.devicePairing.setDeviceScope(
        paired.device.id,
        [...PAIRING_SCOPE_PRESETS.standard, PAIRING_SCOPE_APPROVAL_FULL_ACCESS],
        { kind: 'presented-credential' },
      );
    return paired;
  };

  const store = new EventStore(join(root, 'orchestration.sqlite'));
  const eventBus = new EventBus();
  const codex = new RecordingEngine('codex');
  const claude = new RecordingEngine('claude');
  const registry: IProviderAdapterRegistry = {
    register() {},
    get: (provider) => [codex, claude].find((a) => a.provider === provider),
    list: () => [codex, claude],
  };
  const service = new OrchestrationService({
    adapterRegistry: registry,
    eventBus,
    eventStore: store,
    resolveStationDefaultApprovalMode: async () => defaults.station,
    loadAgentExecutionConfig: async (slug: string) => {
      const mode = defaults.agents?.[slug as keyof typeof AGENTS];
      return mode ? { approvalMode: mode } : undefined;
    },
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

  const {
    continueExecutionTargetMessage,
    delegateTask,
    executeExecutionTargetMessage,
    handoffExecutionTargetMessage,
  } = await import('../../../tools/station-control-delegation.js');
  const readAuthority = (userId: string) =>
    sessionReadAuthorityFromRequest(userId, undefined, undefined);

  const app = new Hono();
  configureRuntimeHttp({
    app: app as never,
    logger: createLogger({ name: 'confinement-test', level: 'error' }),
    eventBus: { emit() {} } as unknown as EventBus,
    security: {
      verifyCredential: (candidate, request) =>
        request !== undefined &&
        security.authorizeCredential(candidate, request),
      resolveGrantedScope: (candidate) =>
        security.resolveGrantedScope(candidate),
      resolveCredentialAuthority: (candidate) =>
        security.verifyOperatorCredential(candidate)
          ? 'operator-credential'
          : security.identifyDevice(candidate)
            ? 'device-credential'
            : undefined,
      resolveCredentialDeviceId: (candidate) =>
        security.identifyDevice(candidate)?.id,
      resolveCredentialLocality: (candidate) =>
        security.credentialLocality(candidate),
      resolveCredentialMintKind: (candidate) =>
        security.credentialMintKind(candidate),
      allowedOrigins: [],
    },
  });
  // The runtime's own composition (runtime-routes.ts): each executor gets
  // the route's request object spread into it, plus the read authority.
  app.route(
    '/api/orchestration',
    createOrchestrationRoutes(service, {
      eventBus,
      logger: { debug: vi.fn() },
      getUserId: () => 'operator',
      resolveAgentDispatchActor: createAgentDispatchActorResolver(),
      executeForegroundMessage: (input: { userId: string }) =>
        executeExecutionTargetMessage(
          { ...input, readAuthority: readAuthority(input.userId) } as never,
          service,
        ),
      continueForegroundMessage: (input: { userId: string }) =>
        continueExecutionTargetMessage(
          { ...input, readAuthority: readAuthority(input.userId) } as never,
          service,
        ),
      delegateTask: (input: { userId: string }) =>
        delegateTask(
          { ...input, readAuthority: readAuthority(input.userId) } as never,
          service,
        ),
      handoffConversation: (input: { userId: string }) =>
        handoffExecutionTargetMessage(
          { ...input, readAuthority: readAuthority(input.userId) } as never,
          service,
        ),
    } as never),
  );

  const request = async (
    headers: Record<string, string>,
    path: string,
    body: unknown,
    env?: unknown,
  ) => {
    const res = await app.request(
      path,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      },
      env as never,
    );
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) as any };
  };
  const bearer = (credential: string) => ({
    Authorization: `Bearer ${credential}`,
  });
  /**
   * Station's own internal principal: the per-boot token, the `local`
   * caller marker and a loopback socket. An agent's station-control tool
   * arrives this way; with or without its origin marker, it may be an agent.
   */
  const internal = (marked: boolean) =>
    [
      {
        [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
        [INTERNAL_PROXY_CALLER_HEADER]: 'local',
        ...(marked
          ? {
              [STATION_CONTROL_ORIGIN_HEADER]:
                STATION_CONTROL_ORIGIN_AGENT_TOOL,
            }
          : {}),
      },
      { incoming: { socket: { remoteAddress: '127.0.0.1' } } },
    ] as const;

  const chat = async (
    headers: Record<string, string>,
    agent: keyof typeof AGENTS,
    env?: unknown,
  ) => {
    const response = await request(
      headers,
      '/api/orchestration/chat',
      {
        message: 'go',
        target: { environment: { kind: 'current' }, agent },
      },
      env,
    );
    expect(response.status, response.text).toBe(200);
    return response.body.data as { conversationId: string };
  };

  return {
    operator,
    pair,
    service,
    store,
    codex,
    claude,
    request,
    bearer,
    internal,
    chat,
    readAuthority,
    delegateTask,
    executeExecutionTargetMessage,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function engineFor(f: Fixture, agent: keyof typeof AGENTS): RecordingEngine {
  return AGENTS[agent] === 'codex' ? f.codex : f.claude;
}

/** The start the engine received and the stamp its start event persisted. */
function lastStart(f: Fixture, agent: keyof typeof AGENTS) {
  const start = engineFor(f, agent).starts.at(-1);
  expect(start).toBeDefined();
  return {
    confinement: start!.confinement,
    approvalMode: start!.modelOptions?.approvalMode,
    stamp: start!.metadata?.stationConfinement,
  };
}

describe('#2493: who may start a session unconfined', () => {
  test('the operator in person starting at the Station default never is host on both engines', async () => {
    const f = await fixture();
    for (const agent of ['codex-agent', 'claude-agent'] as const) {
      await f.chat(f.bearer(f.operator.credential), agent);
      expect(lastStart(f, agent)).toEqual({
        confinement: 'host',
        approvalMode: 'never',
        stamp: 'host',
      });
    }
  });

  test('a device holding approval:full-access is host', async () => {
    const f = await fixture();
    const granted = f.pair('Laptop', true);
    await f.chat(f.bearer(granted.credential), 'codex-agent');
    expect(lastStart(f, 'codex-agent')).toEqual({
      confinement: 'host',
      approvalMode: 'never',
      stamp: 'host',
    });
  });

  test('a device without the grant reaching never through the Station default is confined: Codex keeps never, Claude applies auto', async () => {
    const f = await fixture();
    const phone = f.pair('Phone');
    await f.chat(f.bearer(phone.credential), 'codex-agent');
    expect(lastStart(f, 'codex-agent')).toEqual({
      confinement: 'workspace',
      approvalMode: 'never',
      stamp: 'workspace',
    });
    expect(f.codex.turns.at(-1)?.confinement).toBe('workspace');

    await f.chat(f.bearer(phone.credential), 'claude-agent');
    expect(lastStart(f, 'claude-agent')).toEqual({
      confinement: 'workspace',
      approvalMode: 'auto',
      stamp: 'workspace',
    });
  });

  test("a device without the grant reaching never through an Agent's own default is confined", async () => {
    const f = await fixture({ agents: { 'claude-agent': 'never' } });
    const phone = f.pair('Phone');
    await f.chat(f.bearer(phone.credential), 'claude-agent');
    expect(lastStart(f, 'claude-agent')).toEqual({
      confinement: 'workspace',
      approvalMode: 'auto',
      stamp: 'workspace',
    });
    // The operator starting the same Agent is not.
    await f.chat(f.bearer(f.operator.credential), 'claude-agent');
    expect(lastStart(f, 'claude-agent')).toMatchObject({
      confinement: 'host',
      approvalMode: 'never',
    });
  });

  test.each([
    ['with', true],
    ['without', false],
  ] as const)(
    "an agent's station-control call %s its origin marker is confined",
    async (_label, marked) => {
      const f = await fixture();
      const [headers, env] = f.internal(marked);
      await f.chat(headers, 'claude-agent', env);
      expect(lastStart(f, 'claude-agent')).toEqual({
        confinement: 'workspace',
        approvalMode: 'auto',
        stamp: 'workspace',
      });
    },
  );

  test('a delegation is host only for a caller that may grant it', async () => {
    const f = await fixture();
    const phone = f.pair('Phone');
    const delegate = (credential: string) =>
      f.request(f.bearer(credential), '/api/orchestration/delegations', {
        prompt: 'go',
        target: { environment: { kind: 'current' }, agent: 'codex-agent' },
      });
    const byOperator = await delegate(f.operator.credential);
    expect(byOperator.status, byOperator.text).toBe(200);
    expect(lastStart(f, 'codex-agent')).toMatchObject({
      confinement: 'host',
      stamp: 'host',
    });
    const byPhone = await delegate(phone.credential);
    expect(byPhone.status, byPhone.text).toBe(200);
    expect(lastStart(f, 'codex-agent')).toMatchObject({
      confinement: 'workspace',
      stamp: 'workspace',
    });
  });

  test('in-process starters carry no grant: delegateTask and executeExecutionTargetMessage called without one start confined', async () => {
    const f = await fixture();
    // Driven here: the two in-process entry points, called exactly as the
    // delegate_task and send_message tools call them (no grant field at all).
    // Not driven: the webhook seam and Discord. They are covered
    // structurally: they reach executeExecutionTargetMessage /
    // continueExecutionTargetMessage with an input that has no
    // `fullAccessGrant` (runtime-routes.ts, station-runtime.ts), and a start
    // without a grant is confined in `prepareStart` whoever called it.
    await f.delegateTask(
      {
        prompt: 'go',
        target: {
          environment: { kind: 'current' },
          agent: agentId('codex-agent'),
        },
        userId: 'operator',
      },
      f.service,
    );
    expect(lastStart(f, 'codex-agent')).toMatchObject({
      confinement: 'workspace',
      approvalMode: 'never',
    });
    await f.executeExecutionTargetMessage(
      {
        message: 'go',
        target: {
          environment: { kind: 'current' },
          agent: agentId('claude-agent'),
        },
        userId: 'operator',
        readAuthority: f.readAuthority('operator'),
      },
      f.service,
    );
    expect(lastStart(f, 'claude-agent')).toMatchObject({
      confinement: 'workspace',
      approvalMode: 'auto',
    });
  });

  test("a webhook turn's session is readable by the operator only and acts for no one", async () => {
    const f = await fixture();
    const startTurn = createWebhookTurnStarter({
      readAuthorityFor: f.readAuthority,
      orchestrationService: f.service,
    });
    const started = await startTurn({
      target: {
        environment: { kind: 'current' },
        agent: agentId('claude-agent'),
      },
      message: 'from a webhook',
      ephemeral: true,
      webhookTokenId: 'token-1',
    });
    const sessionId = f.claude.starts.at(-1)!.threadId;
    expect(started.conversationId).toEqual(expect.any(String));
    expect(f.store.findSessionOwnerUserId(sessionId)).toBe(
      LOCAL_OPERATOR_PRINCIPAL_ID,
    );
    expect(
      f.service.canUserReadSession(
        sessionId,
        f.readAuthority(LOCAL_OPERATOR_PRINCIPAL_ID),
      ),
    ).toBe(true);
    expect(
      f.service.canUserReadSession(sessionId, f.readAuthority('stranger')),
    ).toBe(false);
    // An external sender drives it: it must never act (or elevate) as the
    // operator.
    expect(f.service.resolveSessionActingPrincipal(sessionId)).toBeUndefined();
  });

  test('a caller-supplied confinement, stamp or grant in the body is ignored', async () => {
    const f = await fixture();
    const phone = f.pair('Phone');
    const response = await f.request(
      f.bearer(phone.credential),
      '/api/orchestration/chat',
      {
        message: 'go',
        target: { environment: { kind: 'current' }, agent: 'claude-agent' },
        confinement: 'host',
        stationConfinement: 'host',
        fullAccessGrant: {},
      },
    );
    expect(response.status, response.text).toBe(200);
    expect(lastStart(f, 'claude-agent')).toEqual({
      confinement: 'workspace',
      approvalMode: 'auto',
      stamp: 'workspace',
    });

    // On the options bag it is not an option any engine takes.
    const options = await f.request(
      f.bearer(phone.credential),
      '/api/orchestration/chat',
      {
        message: 'go',
        target: {
          environment: { kind: 'current' },
          agent: 'claude-agent',
          model: { options: { confinement: 'host' } },
        },
      },
    );
    expect(options.status).not.toBe(200);
    expect(f.claude.starts).toHaveLength(1);
  });

  test('the operator recording never on a confined conversation makes its next turn host', async () => {
    const f = await fixture();
    const phone = f.pair('Phone');
    const { conversationId } = await f.chat(
      f.bearer(phone.credential),
      'claude-agent',
    );
    expect(lastStart(f, 'claude-agent').confinement).toBe('workspace');
    const threadId = f.claude.starts.at(-1)!.threadId;

    const decided = await f.request(
      f.bearer(f.operator.credential),
      '/api/orchestration/commands',
      {
        type: 'setApprovalMode',
        threadId,
        approvalMode: 'never',
        basedOnSequence: null,
      },
    );
    expect(decided.status, decided.text).toBe(200);
    await f.service.dispatch({
      type: 'sendTurn',
      input: { threadId, input: 'again' },
    });
    expect(f.claude.turns.at(-1)).toMatchObject({
      confinement: 'host',
      modelOptions: { approvalMode: 'never' },
    });
    expect(conversationId).toBeDefined();
  });

  test('the start stamp records the starter grant, not the derived confinement (#2493 review F4)', async () => {
    const f = await fixture();
    f.claude.completeTurns = true;
    const phone = f.pair('Phone');
    const { conversationId } = await f.chat(
      f.bearer(phone.credential),
      'claude-agent',
    );
    const root = f.claude.starts.at(-1)!.threadId;
    const latestSequence = () => {
      const sequences = f.store
        .conversationSessions(conversationId)
        .flatMap(({ sessionId }) => f.store.listEvents(sessionId))
        .concat(f.store.listEvents(root))
        .filter((row) => row.payload.method === 'session.approval-mode-set')
        .map((row) => row.globalSequence);
      return sequences.length > 0 ? Math.max(...sequences) : null;
    };
    const decide = async (
      credential: string,
      threadId: string,
      approvalMode: ApprovalMode,
    ) => {
      const decided = await f.request(
        f.bearer(credential),
        '/api/orchestration/commands',
        {
          type: 'setApprovalMode',
          threadId,
          approvalMode,
          basedOnSequence: latestSequence(),
        },
      );
      expect(decided.status, decided.text).toBe(200);
      expect(decided.body.data.recorded).toBe(true);
    };

    // The operator records never, and the root's binding is stopped. Since
    // #2540 an idle session is reused for a follow-up, so only an ended
    // binding makes the phone's continuation start a new child.
    await decide(f.operator.credential, root, 'never');
    const stopped = await f.request(
      f.bearer(f.operator.credential),
      '/api/orchestration/commands',
      { type: 'stopSession', threadId: root },
    );
    expect(stopped.status, stopped.text).toBe(200);
    // The child's own turn stays open, so it can still take the last turn.
    f.claude.completeTurns = false;
    const starts = f.claude.starts.length;
    await vi.waitFor(async () => {
      const continued = await f.request(
        f.bearer(phone.credential),
        `/api/orchestration/chat/${encodeURIComponent(conversationId)}/continue`,
        { message: 'again' },
      );
      expect(continued.status, continued.text).toBe(200);
    });
    // A new engine start. Since #2540 the successor may keep the
    // conversation's thread id; what matters is that it is a new start,
    // stamped afresh.
    expect(f.claude.starts.length).toBe(starts + 1);
    const child = f.claude.starts.at(-1)!;
    // Host through the recorded never; the stamp is the phone's own grant.
    // Soft, so a wrong stamp also shows its consequence below.
    expect.soft(lastStart(f, 'claude-agent')).toEqual({
      confinement: 'host',
      approvalMode: 'never',
      stamp: 'workspace',
    });

    // The phone tightens to Ask, then picks Default, which resolves to the
    // Station default never. Nothing the phone did grants host, so the child
    // runs confined.
    await decide(phone.credential, child.threadId, 'ask');
    await decide(phone.credential, child.threadId, 'connection-default');
    await f.service.dispatch({
      type: 'sendTurn',
      input: { threadId: child.threadId, input: 'after default' },
    });
    expect(f.claude.turns.at(-1)).toMatchObject({
      threadId: child.threadId,
      confinement: 'workspace',
      modelOptions: { approvalMode: 'auto' },
    });
  });

  test('a handoff started by a device without the grant records its own grant, not the recorded never (#2493 round 7)', async () => {
    // Since #2540 an ordinary follow-up reuses or respawns the conversation's
    // session (carry-forward stamp). An explicit Agent/engine handoff is a
    // real `prepareStart` of a NEW session inside a conversation that may
    // already hold a recorded concrete never.
    const f = await fixture();
    f.claude.completeTurns = true;
    const phone = f.pair('Phone');
    const { conversationId } = await f.chat(
      f.bearer(phone.credential),
      'claude-agent',
    );
    const root = f.claude.starts.at(-1)!.threadId;
    const latestSequence = () => {
      const sequences = [
        root,
        ...f.store.conversationSessions(conversationId).map((s) => s.sessionId),
      ]
        .flatMap((sessionId) => f.store.listEvents(sessionId))
        .filter((row) => row.payload.method === 'session.approval-mode-set')
        .map((row) => row.globalSequence);
      return sequences.length > 0 ? Math.max(...sequences) : null;
    };
    const decide = async (
      credential: string,
      threadId: string,
      approvalMode: ApprovalMode,
    ) => {
      const decided = await f.request(
        f.bearer(credential),
        '/api/orchestration/commands',
        {
          type: 'setApprovalMode',
          threadId,
          approvalMode,
          basedOnSequence: latestSequence(),
        },
      );
      expect(decided.status, decided.text).toBe(200);
      expect(decided.body.data.recorded).toBe(true);
    };
    await decide(f.operator.credential, root, 'never');
    await vi.waitFor(async () => {
      expect(
        (
          await f.service.readCurrentConversationSession(
            conversationId,
            f.readAuthority('operator'),
          )
        )?.session.lifecycleState,
      ).toBe('idle');
    });

    const codexStarts = f.codex.starts.length;
    const handoff = await f.request(
      f.bearer(phone.credential),
      `/api/orchestration/conversations/${encodeURIComponent(conversationId)}/handoff`,
      {
        message: 'Take it from here.',
        idempotencyKey: 'handoff-confinement',
        target: { environment: { kind: 'current' }, agent: 'codex-agent' },
      },
    );
    expect(handoff.status, handoff.text).toBe(200);
    expect(f.codex.starts.length).toBe(codexStarts + 1);
    const child = f.codex.starts.at(-1)!;
    expect(child.threadId).not.toBe(root);
    // Host through the recorded never; the stamp is the phone's own grant.
    expect.soft(lastStart(f, 'codex-agent')).toEqual({
      confinement: 'host',
      approvalMode: 'never',
      stamp: 'workspace',
    });

    // The phone tightens to Ask, then picks Default (the Station default
    // never). Nothing the phone did grants host: the new session is
    // confined.
    await decide(phone.credential, child.threadId, 'ask');
    await decide(phone.credential, child.threadId, 'connection-default');
    await f.service.dispatch({
      type: 'sendTurn',
      input: { threadId: child.threadId, input: 'after default' },
    });
    expect(f.codex.turns.at(-1)).toMatchObject({
      threadId: child.threadId,
      confinement: 'workspace',
      modelOptions: { approvalMode: 'never' },
    });
  });

  /**
   * #2493 review F1: a recorded concrete never makes a conversation host, so
   * recording one must need the same authority as starting host. Station's
   * internal principal without the station-control origin marker is still a
   * request any holder of the per-boot token (an agent's tool among them)
   * can make: it may not record never on any path that records a pick.
   */
  test.each([
    ['the command route', 'commands'],
    ['a pick carried on /chat', 'chat'],
    ['a pick carried on /chat/:id/continue', 'continue'],
  ] as const)(
    'an unmarked internal-token request cannot record never through %s; the conversation stays workspace',
    async (_label, via) => {
      const f = await fixture();
      const phone = f.pair('Phone');
      const { conversationId } = await f.chat(
        f.bearer(phone.credential),
        'claude-agent',
      );
      const threadId = f.claude.starts.at(-1)!.threadId;
      const [headers, env] = f.internal(false);
      const pick = { setApprovalMode: 'never', setApprovalModeBasedOn: null };
      const refused =
        via === 'commands'
          ? await f.request(
              headers,
              '/api/orchestration/commands',
              {
                type: 'setApprovalMode',
                threadId,
                approvalMode: 'never',
                basedOnSequence: null,
              },
              env,
            )
          : via === 'chat'
            ? await f.request(
                headers,
                '/api/orchestration/chat',
                {
                  message: 'again',
                  conversationId,
                  target: {
                    environment: { kind: 'current' },
                    agent: 'claude-agent',
                  },
                  ...pick,
                },
                env,
              )
            : await f.request(
                headers,
                `/api/orchestration/chat/${encodeURIComponent(conversationId)}/continue`,
                { message: 'again', ...pick },
                env,
              );
      expect(refused.status, refused.text).toBe(403);
      expect(refused.body.code).toBe('approval-full-access-not-granted');
      expect(
        f.store
          .listEvents(threadId)
          .filter((row) => row.payload.method === 'session.approval-mode-set'),
      ).toEqual([]);

      const turns = f.claude.turns.length;
      await f.service.dispatch({
        type: 'sendTurn',
        input: {
          threadId,
          input: 'after',
          modelOptions: { approvalMode: 'never' },
        },
      });
      expect(f.claude.turns).toHaveLength(turns + 1);
      expect(f.claude.turns.at(-1)).toMatchObject({
        confinement: 'workspace',
        modelOptions: { approvalMode: 'auto' },
      });
    },
  );
});

/**
 * #2377 slice C1: a Default pick (`connection-default`) is checked by what it
 * would run, resolved as a turn resolves it (the Agent's default, then the
 * Station's). On a `host`-stamped session a Default that resolves to `never`
 * runs the engine unconfined, so recording it needs the same grant as
 * `never`, on every path that records a pick. On a session a member started
 * confined, the owner's 2026-09-23 decision (fork 1) stands: no grant needed.
 */
describe('#2377 slice C1: a Default pick is checked by what it would run', () => {
  const approvalEvents = (f: Fixture, threadId: string) =>
    f.store
      .listEvents(threadId)
      .filter((row) => row.payload.method === 'session.approval-mode-set')
      .map((row) => (row.payload as { approvalMode: string }).approvalMode);

  /** A session the operator started unconfined, idle, standing at Ask. */
  async function hostSessionAtAsk(f: Fixture) {
    f.claude.completeTurns = true;
    const { conversationId } = await f.chat(
      f.bearer(f.operator.credential),
      'claude-agent',
    );
    const threadId = f.claude.starts.at(-1)!.threadId;
    expect(lastStart(f, 'claude-agent').confinement).toBe('host');
    const asked = await f.request(
      f.bearer(f.operator.credential),
      '/api/orchestration/commands',
      {
        type: 'setApprovalMode',
        threadId,
        approvalMode: 'ask',
        basedOnSequence: null,
      },
    );
    expect(asked.status, asked.text).toBe(200);
    await vi.waitFor(async () => {
      expect(
        (
          await f.service.readCurrentConversationSession(
            conversationId,
            f.readAuthority('operator'),
          )
        )?.session.lifecycleState,
      ).toBe('idle');
    });
    return {
      conversationId,
      threadId,
      sequence: asked.body.data.sequence as number,
    };
  }

  const pickDefault = (
    f: Fixture,
    credential: string,
    via: 'commands' | 'chat' | 'continue',
    session: { threadId: string; conversationId: string; sequence: number },
  ) => {
    const carried = {
      setApprovalMode: 'connection-default',
      setApprovalModeBasedOn: session.sequence,
    };
    return via === 'commands'
      ? f.request(f.bearer(credential), '/api/orchestration/commands', {
          type: 'setApprovalMode',
          threadId: session.threadId,
          approvalMode: 'connection-default',
          basedOnSequence: session.sequence,
        })
      : via === 'chat'
        ? f.request(f.bearer(credential), '/api/orchestration/chat', {
            message: 'again',
            conversationId: session.conversationId,
            target: { environment: { kind: 'current' }, agent: 'claude-agent' },
            ...carried,
          })
        : f.request(
            f.bearer(credential),
            `/api/orchestration/chat/${encodeURIComponent(session.conversationId)}/continue`,
            { message: 'again', ...carried },
          );
  };

  test.each(['commands', 'chat', 'continue'] as const)(
    'on a host session, a device without the grant cannot pick a Default that resolves to the Station default never (via %s)',
    async (via) => {
      const f = await fixture({ station: 'never' });
      const session = await hostSessionAtAsk(f);
      const turns = f.claude.turns.length;
      const phone = f.pair('Phone');

      const refused = await pickDefault(f, phone.credential, via, session);

      expect(refused.status, refused.text).toBe(403);
      expect(refused.body.code).toBe('approval-full-access-not-granted');
      expect(approvalEvents(f, session.threadId)).toEqual(['ask']);
      // Refused before the send's turn: the session never ran unconfined.
      expect(f.claude.turns).toHaveLength(turns);
      await f.service.dispatch({
        type: 'sendTurn',
        input: { threadId: session.threadId, input: 'after the phone' },
      });
      expect(f.claude.turns.at(-1)).toMatchObject({
        confinement: 'host',
        modelOptions: { approvalMode: 'ask' },
      });
    },
  );

  test.each(['commands', 'chat', 'continue'] as const)(
    'on a host session, a device holding the grant may pick it (via %s)',
    async (via) => {
      const f = await fixture({ station: 'never' });
      const session = await hostSessionAtAsk(f);
      const phone = f.pair('Phone', true);

      const picked = await pickDefault(f, phone.credential, via, session);

      expect(picked.status, picked.text).toBe(200);
      expect(approvalEvents(f, session.threadId)).toEqual([
        'ask',
        'connection-default',
      ]);
    },
  );

  test("an Agent's own default never counts the same; a Default that resolves to Ask needs nothing", async () => {
    const agentNever = await fixture({
      station: 'ask',
      agents: { 'claude-agent': 'never' },
    });
    const refused = await pickDefault(
      agentNever,
      agentNever.pair('Phone').credential,
      'commands',
      await hostSessionAtAsk(agentNever),
    );
    expect(refused.status, refused.text).toBe(403);

    const stationAsk = await fixture({ station: 'ask' });
    const session = await hostSessionAtAsk(stationAsk);
    const allowed = await pickDefault(
      stationAsk,
      stationAsk.pair('Phone').credential,
      'commands',
      session,
    );
    expect(allowed.status, allowed.text).toBe(200);
    expect(approvalEvents(stationAsk, session.threadId)).toEqual([
      'ask',
      'connection-default',
    ]);
  });

  test('on a session a device started confined, its Default needs no grant and still runs confined (fork 1)', async () => {
    const f = await fixture({ station: 'never' });
    const phone = f.pair('Phone');
    await f.chat(f.bearer(phone.credential), 'claude-agent');
    const threadId = f.claude.starts.at(-1)!.threadId;
    expect(lastStart(f, 'claude-agent').confinement).toBe('workspace');

    const picked = await f.request(
      f.bearer(phone.credential),
      '/api/orchestration/commands',
      {
        type: 'setApprovalMode',
        threadId,
        approvalMode: 'connection-default',
        basedOnSequence: null,
      },
    );
    expect(picked.status, picked.text).toBe(200);
    await f.service.dispatch({
      type: 'sendTurn',
      input: { threadId, input: 'after default' },
    });
    expect(f.claude.turns.at(-1)).toMatchObject({
      confinement: 'workspace',
      modelOptions: { approvalMode: 'auto' },
    });
  });
});

/**
 * #2377 slice C1 review: a decision governs every session of its
 * conversation, so a Default is checked against all of them, and sessions
 * added later take their own starter's confinement.
 */
describe('#2377 slice C1: a Default pick is checked against the whole conversation', () => {
  async function idle(f: Fixture, conversationId: string) {
    await vi.waitFor(async () => {
      expect(
        (
          await f.service.readCurrentConversationSession(
            conversationId,
            f.readAuthority('operator'),
          )
        )?.session.lifecycleState,
      ).toBe('idle');
    });
  }
  const approvalEvents = (f: Fixture, threadIds: readonly string[]) =>
    threadIds.flatMap((threadId) =>
      f.store
        .listEvents(threadId)
        .filter((row) => row.payload.method === 'session.approval-mode-set')
        .map((row) => (row.payload as { approvalMode: string }).approvalMode),
    );
  const latestSequence = (f: Fixture, threadIds: readonly string[]) => {
    const sequences = threadIds
      .flatMap((threadId) => f.store.listEvents(threadId))
      .filter((row) => row.payload.method === 'session.approval-mode-set')
      .map((row) => row.globalSequence);
    return sequences.length > 0 ? Math.max(...sequences) : null;
  };
  const handoff = (
    f: Fixture,
    credential: string,
    conversationId: string,
    key: string,
  ) =>
    f.request(
      f.bearer(credential),
      `/api/orchestration/conversations/${encodeURIComponent(conversationId)}/handoff`,
      {
        message: 'Take it from here.',
        idempotencyKey: key,
        target: { environment: { kind: 'current' }, agent: 'codex-agent' },
      },
    );

  test('a device without the grant cannot reach a host session by naming a workspace sibling (review repro)', async () => {
    const f = await fixture({ station: 'never' });
    f.claude.completeTurns = true;
    f.codex.completeTurns = true;
    const phone = f.pair('Phone');
    const { conversationId } = await f.chat(
      f.bearer(phone.credential),
      'claude-agent',
    );
    const root = f.claude.starts.at(-1)!.threadId;
    expect(lastStart(f, 'claude-agent').stamp).toBe('workspace');
    await idle(f, conversationId);
    const handedOff = await handoff(
      f,
      f.operator.credential,
      conversationId,
      'sibling-handoff',
    );
    expect(handedOff.status, handedOff.text).toBe(200);
    const child = f.codex.starts.at(-1)!.threadId;
    expect(lastStart(f, 'codex-agent').stamp).toBe('host');
    const threads = [root, child];
    const decide = (credential: string, threadId: string, mode: string) =>
      f.request(f.bearer(credential), '/api/orchestration/commands', {
        type: 'setApprovalMode',
        threadId,
        approvalMode: mode,
        basedOnSequence: latestSequence(f, threads),
      });
    expect((await decide(f.operator.credential, child, 'ask')).status).toBe(
      200,
    );

    for (const named of [child, root]) {
      const refused = await decide(
        phone.credential,
        named,
        'connection-default',
      );
      expect([named, refused.status, refused.body.code]).toEqual([
        named,
        403,
        'approval-full-access-not-granted',
      ]);
    }
    expect(approvalEvents(f, threads)).toEqual(['ask']);

    await f.service.dispatch({
      type: 'sendTurn',
      input: { threadId: child, input: 'after the phone' },
    });
    expect(f.codex.turns.at(-1)).toMatchObject({
      confinement: 'host',
      modelOptions: { approvalMode: 'ask' },
    });
  });

  test('a session added after a Default is recorded starts in its own starter’s confinement', async () => {
    const f = await fixture({ station: 'never' });
    f.claude.completeTurns = true;
    f.codex.completeTurns = true;
    const phone = f.pair('Phone');
    const { conversationId } = await f.chat(
      f.bearer(phone.credential),
      'claude-agent',
    );
    const root = f.claude.starts.at(-1)!.threadId;
    // Fork 1: on an all-workspace conversation the phone may pick Default.
    const picked = await f.request(
      f.bearer(phone.credential),
      '/api/orchestration/commands',
      {
        type: 'setApprovalMode',
        threadId: root,
        approvalMode: 'connection-default',
        basedOnSequence: null,
      },
    );
    expect(picked.status, picked.text).toBe(200);
    await idle(f, conversationId);

    // The phone hands off: the successor inherits the Default, not host.
    const byPhone = await handoff(
      f,
      phone.credential,
      conversationId,
      'phone-handoff',
    );
    expect(byPhone.status, byPhone.text).toBe(200);
    expect(lastStart(f, 'codex-agent')).toEqual({
      confinement: 'workspace',
      approvalMode: 'never',
      stamp: 'workspace',
    });
    expect(f.codex.turns.at(-1)).toMatchObject({ confinement: 'workspace' });
  });

  test('a check that cannot decide counts as full access (the route’s fail-closed catch)', async () => {
    const f = await fixture({ station: 'never' });
    const phone = f.pair('Phone');
    await f.chat(f.bearer(phone.credential), 'claude-agent');
    const threadId = f.claude.starts.at(-1)!.threadId;
    const spy = vi
      .spyOn(f.service, 'approvalPickReachesFullAccess')
      .mockRejectedValue(new Error('agent store unreadable'));
    const refused = await f.request(
      f.bearer(phone.credential),
      '/api/orchestration/commands',
      {
        type: 'setApprovalMode',
        threadId,
        approvalMode: 'connection-default',
        basedOnSequence: null,
      },
    );
    expect(spy).toHaveBeenCalled();
    expect(refused.status, refused.text).toBe(403);
    expect(refused.body.code).toBe('approval-full-access-not-granted');
  });

  test.each(['chat', 'continue'] as const)(
    'fork 1 through the executor: a carried Default on a workspace conversation needs no grant (via %s)',
    async (via) => {
      const f = await fixture({ station: 'never' });
      f.claude.completeTurns = true;
      const phone = f.pair('Phone');
      const { conversationId } = await f.chat(
        f.bearer(phone.credential),
        'claude-agent',
      );
      const root = f.claude.starts.at(-1)!.threadId;
      await idle(f, conversationId);
      const carried = {
        setApprovalMode: 'connection-default',
        setApprovalModeBasedOn: null,
      };
      const sent =
        via === 'chat'
          ? await f.request(
              f.bearer(phone.credential),
              '/api/orchestration/chat',
              {
                message: 'again',
                conversationId,
                target: {
                  environment: { kind: 'current' },
                  agent: 'claude-agent',
                },
                ...carried,
              },
            )
          : await f.request(
              f.bearer(phone.credential),
              `/api/orchestration/chat/${encodeURIComponent(conversationId)}/continue`,
              { message: 'again', ...carried },
            );
      expect(sent.status, sent.text).toBe(200);
      const threads = [
        root,
        ...f.store.conversationSessions(conversationId).map((s) => s.sessionId),
      ];
      expect(approvalEvents(f, [...new Set(threads)])).toEqual([
        'connection-default',
      ]);
      expect(f.claude.turns.at(-1)).toMatchObject({ confinement: 'workspace' });
    },
  );
});

/**
 * #2377 slice C1: the steer and adopt scope reads a thread's confinement
 * through `sessionRunsHost`, which must agree with what its next turn runs.
 */
test('sessionRunsHost reads the start stamp and a recorded never, as a turn does', async () => {
  const f = await fixture({ station: 'never' });
  await f.chat(f.bearer(f.operator.credential), 'claude-agent');
  const operatorThread = f.claude.starts.at(-1)!.threadId;
  const phone = f.pair('Phone');
  await f.chat(f.bearer(phone.credential), 'claude-agent');
  const phoneThread = f.claude.starts.at(-1)!.threadId;
  expect(f.service.sessionRunsHost(operatorThread)).toBe(true);
  expect(f.service.sessionRunsHost(phoneThread)).toBe(false);
  expect(f.service.sessionRunsHost('no-such-thread')).toBe(false);

  const decided = await f.request(
    f.bearer(f.operator.credential),
    '/api/orchestration/commands',
    {
      type: 'setApprovalMode',
      threadId: phoneThread,
      approvalMode: 'never',
      basedOnSequence: null,
    },
  );
  expect(decided.status, decided.text).toBe(200);
  expect(f.service.sessionRunsHost(phoneThread)).toBe(true);
  await f.service.dispatch({
    type: 'sendTurn',
    input: { threadId: phoneThread, input: 'again' },
  });
  expect(f.claude.turns.at(-1)).toMatchObject({ confinement: 'host' });
});
