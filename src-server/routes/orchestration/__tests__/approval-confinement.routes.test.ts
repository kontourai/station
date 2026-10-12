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
import { configureDevicePairingHostRoutes } from '../../../runtime/routes/runtime-routes.js';
import { fullAccessGrantForTesting } from '../../../security/coding-authority.js';
import { isRuntimeRequestPrincipalCurrent } from '../../../security/runtime-request-security.js';
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
      ...(this.resumable ? { resumeCursor: { threadId: input.threadId } } : {}),
    };
    this.sessions.set(input.threadId, session);
    return session;
  }

  /** When set, every turn completes (the session goes idle and is reused, #2540). */
  completeTurns = false;
  /** When set, every turn starts and stays open (#2898 steering). */
  openTurns = false;
  readonly steers: Array<{ threadId: string; input: string; turnId?: string }> =
    [];

  async steerTurn(threadId: string, input: string, turnId?: string) {
    this.steers.push({ threadId, input, ...(turnId ? { turnId } : {}) });
  }

  /** Ends the open turn `turnId` on `threadId`. */
  completeTurn(threadId: string, turnId: string) {
    this.events.push({
      provider: this.provider,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
      eventId: `${turnId}:completed`,
      method: 'turn.completed',
      outputText: 'done',
    } as CanonicalRuntimeEvent);
  }

  async sendTurn(input: ProviderSendTurnInput) {
    this.turns.push(input);
    const turnId = `${this.provider}-turn-${this.turns.length}`;
    if (this.openTurns)
      this.events.push({
        provider: this.provider,
        threadId: input.threadId,
        turnId,
        createdAt: new Date().toISOString(),
        eventId: `${turnId}:started`,
        method: 'turn.started',
        prompt: input.input,
      } as CanonicalRuntimeEvent);
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
  /** When set, sessions carry a resume cursor (parkable, #2540). */
  resumable = false;
  /** When set, `stopSession` reports the engine's exit, as a real one does. */
  exitOnStop = false;
  async stopSession(threadId: string): Promise<void> {
    this.sessions.delete(threadId);
    if (this.exitOnStop)
      this.events.push({
        eventId: `${threadId}:exited:${Date.now()}`,
        provider: this.provider,
        threadId,
        createdAt: new Date().toISOString(),
        method: 'session.exited',
      } as CanonicalRuntimeEvent);
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
  /** #1796: whether the service reads a device grantor's full access live. */
  liveGrantCheck = true,
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
    ...(liveGrantCheck
      ? {
          isFullAccessGrantorCurrent: (deviceId: string) =>
            security.deviceHoldsFullAccess(deviceId),
        }
      : {}),
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
      recognizeCredential: (candidate) => security.verifyCredential(candidate),
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

  // #1796 G3: the operator's device-access routes, wired as runtime-routes
  // wires them, so a revocation resets what the device had granted.
  configureDevicePairingHostRoutes(app as never, security.devicePairing, {
    verifyOperatorCredential: (candidate) =>
      security.verifyOperatorCredential(candidate),
    isApprovalCurrent: (req) => isRuntimeRequestPrincipalCurrent(req, security),
    isRequestPrincipalCurrent: (req) =>
      isRuntimeRequestPrincipalCurrent(req, security),
    resetFullAccessGrantedBy: (input) =>
      service.resetFullAccessGrantedBy(input),
  });

  const request = async (
    headers: Record<string, string>,
    path: string,
    body: unknown,
    env?: unknown,
    method = 'POST',
  ) => {
    const res = await app.request(
      path,
      {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        ...(method === 'DELETE' ? {} : { body: JSON.stringify(body) }),
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
    security,
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

/**
 * #1796 G3 (owner decision): revoking a device's full access resets the full
 * access it had already granted, through the real operator routes. The next
 * turn applies the reset; a running turn is left to finish; the operator's
 * and other devices' decisions, and Agent or Station defaults, are listed,
 * never changed.
 */
describe('#1796 G3: revoking a device resets the full access it granted', () => {
  const standardScope = [...PAIRING_SCOPE_PRESETS.standard];
  const NONE_UNATTRIBUTED = { sessions: [], total: 0 };
  /**
   * The report without each entry's title and session (pinned on their own
   * in the test that names them), so the rest compares exactly.
   */
  const bare = (report: any) => {
    if (!report) return report;
    const strip = (entries: any[]) =>
      entries.map(({ title: _title, sessionId: _session, ...rest }) => rest);
    return {
      ...report,
      reset: strip(report.reset),
      stillFullAccess: strip(report.stillFullAccess),
      reconfined: strip(report.reconfined),
      stillUnconfined: strip(report.stillUnconfined),
      unattributedHostStarts: {
        ...report.unattributedHostStarts,
        sessions: strip(report.unattributedHostStarts.sessions),
      },
    };
  };
  const startGrantor = (f: Fixture, threadId: string) =>
    (
      f.store.latestEventByMethod(threadId, 'session.started')?.payload as
        | { metadata?: Record<string, unknown> }
        | undefined
    )?.metadata?.stationConfinementGrantor;
  /** A host session as an older Station stamped it: no grantor recorded. */
  const startUnattributedHost = async (f: Fixture, threadId: string) => {
    await f.service.dispatch(
      {
        type: 'startSession',
        input: {
          threadId,
          provider: 'claude',
          modelOptions: { approvalMode: 'never' },
        },
      },
      { fullAccessGrant: fullAccessGrantForTesting() },
    );
    await vi.waitFor(() =>
      expect(
        f.store.latestEventByMethod(threadId, 'session.started')?.payload,
      ).toMatchObject({ metadata: { stationConfinement: 'host' } }),
    );
    // Every grant names its grantor now, so an older Station's start is
    // written as it stored one: a `host` stamp with no grantor beside it.
    f.store.appendEvent({
      eventId: `${threadId}:legacy-start`,
      provider: 'claude',
      threadId,
      createdAt: new Date().toISOString(),
      method: 'session.started',
      sessionId: threadId,
      metadata: { stationConfinement: 'host' },
    } as never);
    expect(startGrantor(f, threadId)).toBeUndefined();
  };

  const removeFullAccess = (f: Fixture, deviceId: string) =>
    f.request(
      f.bearer(f.operator.credential),
      `/api/pairing/devices/${encodeURIComponent(deviceId)}/scope`,
      { scope: standardScope },
    );
  const revokeDevice = (f: Fixture, deviceId: string) =>
    f.request(
      f.bearer(f.operator.credential),
      `/api/pairing/devices/${encodeURIComponent(deviceId)}`,
      undefined,
      undefined,
      'DELETE',
    );
  const decisions = (f: Fixture, threadId: string) =>
    f.store
      .listEvents(threadId)
      .map((row) => row.payload as Record<string, any>)
      .filter((event) => event.method === 'session.approval-mode-set');
  /** A chat started by `credential`, with a full-access pick recorded or carried on the default channel. */
  const startAtFullAccess = async (
    f: Fixture,
    credential: string,
    how: 'recorded' | 'default-channel',
  ) => {
    const response = await f.request(
      f.bearer(credential),
      '/api/orchestration/chat',
      {
        message: 'go',
        target: {
          environment: { kind: 'current' },
          agent: 'claude-agent',
          ...(how === 'default-channel'
            ? { model: { options: { approvalMode: 'never' } } }
            : {}),
        },
        ...(how === 'recorded'
          ? { setApprovalMode: 'never', setApprovalModeBasedOn: null }
          : {}),
      },
    );
    expect(response.status, response.text).toBe(200);
    const start = f.claude.starts.at(-1)!;
    expect(start).toMatchObject({
      confinement: 'host',
      modelOptions: { approvalMode: 'never' },
    });
    return {
      conversationId: response.body.data.conversationId as string,
      threadId: start.threadId,
    };
  };
  const nextTurn = async (f: Fixture, threadId: string) => {
    await f.service.dispatch({
      type: 'sendTurn',
      input: { threadId, input: 'next' },
    });
    return f.claude.turns.at(-1);
  };

  test('a device’s recorded never resets to Ask when its full access is removed, attributed to the operator, and the next turn asks', async () => {
    const f = await fixture({});
    f.claude.completeTurns = true;
    const laptop = f.pair('Laptop', true);
    const { conversationId, threadId } = await startAtFullAccess(
      f,
      laptop.credential,
      'recorded',
    );

    const removed = await removeFullAccess(f, laptop.device.id);

    expect(removed.status, removed.text).toBe(200);
    expect(bare(removed.body.fullAccessRevocation)).toEqual({
      cause: 'scope-removed',
      reset: [{ conversationId, was: 'never' }],
      stillFullAccess: [],
      reconfined: [],
      stillUnconfined: [{ conversationId, until: 'next-turn' }],
      unattributedHostStarts: NONE_UNATTRIBUTED,
    });
    // History kept: the device's never, then the operator's Ask.
    const recorded = decisions(f, threadId);
    expect(recorded.map((event) => event.approvalMode)).toEqual([
      'never',
      'ask',
    ]);
    expect(recorded[0]?.clientOrigin?.actor).toEqual({
      kind: 'device',
      deviceId: laptop.device.id,
    });
    expect(recorded[1]).toMatchObject({
      clientOrigin: { actor: { kind: 'operator' } },
      revocation: {
        reason: 'device-full-access-revoked',
        deviceId: laptop.device.id,
        cause: 'scope-removed',
      },
    });
    // The grant is gone: the next turn is confined, and asks.
    expect(await nextTurn(f, threadId)).toMatchObject({
      confinement: 'workspace',
      modelOptions: { approvalMode: 'ask' },
    });
  });

  test('revoking the whole device resets a session it started unconfined on the default channel (`--approval-mode=never`)', async () => {
    const f = await fixture({});
    f.claude.completeTurns = true;
    const laptop = f.pair('Laptop', true);
    const { conversationId, threadId } = await startAtFullAccess(
      f,
      laptop.credential,
      'default-channel',
    );
    expect(decisions(f, threadId)).toEqual([]);

    const revoked = await revokeDevice(f, laptop.device.id);

    expect(revoked.status, revoked.text).toBe(200);
    expect(bare(revoked.body.fullAccessRevocation)).toEqual({
      cause: 'device-revoked',
      reset: [{ conversationId, was: 'host-start' }],
      stillFullAccess: [],
      reconfined: [],
      stillUnconfined: [{ conversationId, until: 'next-turn' }],
      unattributedHostStarts: NONE_UNATTRIBUTED,
    });
    expect(await nextTurn(f, threadId)).toMatchObject({
      confinement: 'workspace',
      modelOptions: { approvalMode: 'ask' },
    });
  });

  test('a turn already running is left to finish', async () => {
    const f = await fixture({});
    const laptop = f.pair('Laptop', true);
    const interrupt = vi.spyOn(f.claude, 'interruptTurn');
    const stop = vi.spyOn(f.claude, 'stopSession');
    const { threadId } = await startAtFullAccess(
      f,
      laptop.credential,
      'recorded',
    );
    const turnsBefore = f.claude.turns.length;

    const removed = await removeFullAccess(f, laptop.device.id);

    expect(removed.status, removed.text).toBe(200);
    expect(bare(removed.body.fullAccessRevocation).reset).toHaveLength(1);
    expect(interrupt).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(f.claude.turns).toHaveLength(turnsBefore);
    expect(
      f.store
        .listEvents(threadId)
        .map((row) => row.payload.method)
        .filter((method) => method === 'turn.aborted'),
    ).toEqual([]);
  });

  test('the operator’s standing never survives a device’s revocation, and is listed', async () => {
    const f = await fixture({});
    f.claude.completeTurns = true;
    const laptop = f.pair('Laptop', true);
    const { conversationId, threadId } = await startAtFullAccess(
      f,
      laptop.credential,
      'recorded',
    );
    const decided = await f.request(
      f.bearer(f.operator.credential),
      '/api/orchestration/commands',
      {
        type: 'setApprovalMode',
        threadId,
        approvalMode: 'never',
        basedOnSequence: Math.max(
          ...f.store
            .listEvents(threadId)
            .filter((row) => row.payload.method === 'session.approval-mode-set')
            .map((row) => row.globalSequence),
        ),
      },
    );
    expect(decided.status, decided.text).toBe(200);

    const removed = await removeFullAccess(f, laptop.device.id);

    expect(bare(removed.body.fullAccessRevocation)).toEqual({
      cause: 'scope-removed',
      reset: [],
      stillFullAccess: [{ conversationId, reason: 'operator-decision' }],
      reconfined: [],
      stillUnconfined: [],
      unattributedHostStarts: NONE_UNATTRIBUTED,
    });
    expect(decisions(f, threadId).at(-1)?.approvalMode).toBe('never');
    expect(await nextTurn(f, threadId)).toMatchObject({
      confinement: 'host',
      modelOptions: { approvalMode: 'never' },
    });
  });

  /**
   * #2898 (owner decision 2026-09-27): a running engine whose full access
   * came only from its Agent's default has no decision to re-apply, and an
   * ordinary turn carries no posture (#2144 slice 6). The confinement change
   * is the exception: the next turn re-applies the mode the engine runs,
   * under `workspace`. Claude takes it as a permission mode (`auto`, since
   * it cannot run `never` confined); Codex keeps `never`, which its adapter
   * sends as the `workspace-write` sandbox (codex-adapter.test.ts, "never is
   * never full access for a workspace session").
   */
  test.each([
    ['claude-agent', 'auto'],
    ['codex-agent', 'never'],
  ] as const)(
    'a running %s session the device started, at never only by its Agent default, is not reset: listed unconfined until its next turn, which runs confined',
    async (agent, confinedMode) => {
      const f = await fixture({ agents: { [agent]: 'never' } });
      const engine = engineFor(f, agent);
      engine.completeTurns = true;
      const laptop = f.pair('Laptop', true);
      const { conversationId } = await f.chat(
        f.bearer(laptop.credential),
        agent,
      );
      const threadId = engine.starts.at(-1)!.threadId;
      expect(lastStart(f, agent)).toMatchObject({
        confinement: 'host',
        approvalMode: 'never',
      });
      // An ordinary turn before the revocation carries no posture (#2144
      // slice 6), so the exception below is the confinement change alone.
      await f.service.dispatch({
        type: 'sendTurn',
        input: { threadId, input: 'before' },
      });
      expect(engine.turns.at(-1)?.confinement).toBe('host');
      expect(engine.turns.at(-1)?.modelOptions?.approvalMode).toBeUndefined();

      const removed = await removeFullAccess(f, laptop.device.id);

      expect(bare(removed.body.fullAccessRevocation)).toEqual({
        cause: 'scope-removed',
        reset: [],
        stillFullAccess: [],
        reconfined: [],
        stillUnconfined: [{ conversationId, until: 'next-turn' }],
        unattributedHostStarts: NONE_UNATTRIBUTED,
      });
      // The entry names the running session, the one "Stop now" stops.
      expect(
        removed.body.fullAccessRevocation.stillUnconfined[0].sessionId,
      ).toBe(threadId);
      expect(decisions(f, threadId)).toEqual([]);
      const startsBefore = engine.starts.length;
      await f.service.dispatch({
        type: 'sendTurn',
        input: { threadId, input: 'after' },
      });
      // Re-confined on the running engine, at its next turn: no restart.
      expect(engine.starts.length).toBe(startsBefore);
      expect(engine.turns.at(-1)).toMatchObject({
        confinement: 'workspace',
        modelOptions: { approvalMode: confinedMode },
      });
      // Still re-applied on the turn after, until the engine restarts
      // confined: a failed turn cannot leave it at its start posture.
      await f.service.dispatch({
        type: 'sendTurn',
        input: { threadId, input: 'again' },
      });
      expect(engine.turns.at(-1)).toMatchObject({
        confinement: 'workspace',
        modelOptions: { approvalMode: confinedMode },
      });
    },
  );

  /**
   * #2898 review: a turn that started unconfined finishes, but cannot be
   * given new instructions by steering once the grant is revoked. A turn
   * started after the revocation runs confined and can be steered.
   */
  test('a turn running unconfined is not extended by steering after a revoke; a confined turn is', async () => {
    const f = await fixture({ agents: { 'claude-agent': 'never' } });
    f.claude.openTurns = true;
    const laptop = f.pair('Laptop', true);
    const { conversationId } = await f.chat(
      f.bearer(laptop.credential),
      'claude-agent',
    );
    const threadId = f.claude.starts.at(-1)!.threadId;
    const firstTurn = `claude-turn-${f.claude.turns.length}`;
    // `dispatch` answers with the command's own result.
    const steer = async (input: string) => ({
      result: await f.service.dispatch({ type: 'steerTurn', threadId, input }),
    });
    await vi.waitFor(async () =>
      expect((await steer('before')).result).toMatchObject({
        outcome: 'steered',
      }),
    );
    expect(f.claude.steers).toHaveLength(1);

    const removed = await removeFullAccess(f, laptop.device.id);
    expect(bare(removed.body.fullAccessRevocation).stillUnconfined).toEqual([
      { conversationId, until: 'next-turn' },
    ]);

    expect((await steer('after')).result).toEqual({
      outcome: 'confinement-changed',
      threadId,
    });
    expect(f.claude.steers).toHaveLength(1);

    // The unconfined turn ends; the next one runs confined and can be steered.
    f.claude.completeTurn(threadId, firstTurn);
    await vi.waitFor(async () =>
      expect((await steer('between')).result).toMatchObject({
        outcome: 'no-active-turn',
      }),
    );
    await f.service.dispatch({
      type: 'sendTurn',
      input: { threadId, input: 'next' },
    });
    expect(f.claude.turns.at(-1)).toMatchObject({
      confinement: 'workspace',
      modelOptions: { approvalMode: 'auto' },
    });
    await vi.waitFor(async () =>
      expect((await steer('confined')).result).toMatchObject({
        outcome: 'steered',
      }),
    );
    expect(f.claude.steers.map((entry) => entry.input)).toEqual([
      'before',
      'confined',
    ]);
  });

  /**
   * #2898 delta review: only a narrowing refuses a steer. A turn that ran
   * confined is steerable when the conversation is widened (a recorded
   * `never`), and a revoke that is given back leaves nothing to refuse.
   */
  test('a confined turn widened by a recorded never is still steerable', async () => {
    const f = await fixture({});
    f.claude.openTurns = true;
    const phone = f.pair('Phone');
    await f.chat(f.bearer(phone.credential), 'claude-agent');
    const threadId = f.claude.starts.at(-1)!.threadId;
    expect(f.claude.turns.at(-1)?.confinement).toBe('workspace');
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
    expect(f.service.sessionRunsHost(threadId)).toBe(true);
    await vi.waitFor(async () =>
      expect(
        await f.service.dispatch({
          type: 'steerTurn',
          threadId,
          input: 'more',
        }),
      ).toMatchObject({ outcome: 'steered' }),
    );
    expect(f.claude.steers.map((entry) => entry.input)).toEqual(['more']);
  });

  test('a revoke steers no more; giving the grant back makes the same turn steerable again', async () => {
    const f = await fixture({ agents: { 'claude-agent': 'never' } });
    f.claude.openTurns = true;
    const laptop = f.pair('Laptop', true);
    await f.chat(f.bearer(laptop.credential), 'claude-agent');
    const threadId = f.claude.starts.at(-1)!.threadId;
    const steer = (input: string) =>
      f.service.dispatch({ type: 'steerTurn', threadId, input });
    await vi.waitFor(async () =>
      expect(await steer('before')).toMatchObject({ outcome: 'steered' }),
    );
    await removeFullAccess(f, laptop.device.id);
    expect(await steer('revoked')).toEqual({
      outcome: 'confinement-changed',
      threadId,
    });
    const regranted = await f.request(
      f.bearer(f.operator.credential),
      `/api/pairing/devices/${encodeURIComponent(laptop.device.id)}/scope`,
      { scope: [...standardScope, PAIRING_SCOPE_APPROVAL_FULL_ACCESS] },
    );
    expect(regranted.status, regranted.text).toBe(200);
    expect(await steer('regranted')).toMatchObject({ outcome: 'steered' });
    expect(f.claude.steers.map((entry) => entry.input)).toEqual([
      'before',
      'regranted',
    ]);
  });

  /**
   * #2898 delta review LOW: an engine's last accepted turn is forgotten
   * with the engine, on its exit and when it is parked, so a respawned
   * engine is judged by its own start.
   */
  test('the last accepted turn confinement is forgotten on exit and on park', async () => {
    const f = await fixture({});
    f.claude.completeTurns = true;
    f.claude.resumable = true;
    f.claude.exitOnStop = true;
    const accepted = () =>
      (
        f.service as unknown as {
          acceptedTurnConfinement: Map<string, unknown>;
        }
      ).acceptedTurnConfinement;
    await f.chat(f.bearer(f.operator.credential), 'claude-agent');
    const parked = f.claude.starts.at(-1)!.threadId;
    await f.chat(f.bearer(f.operator.credential), 'claude-agent');
    const exited = f.claude.starts.at(-1)!.threadId;
    expect(accepted().has(parked)).toBe(true);
    expect(accepted().has(exited)).toBe(true);

    // Exit: the engine reports `session.exited` on its own.
    f.claude.events.push({
      eventId: `${exited}:exited`,
      provider: 'claude',
      threadId: exited,
      createdAt: new Date().toISOString(),
      method: 'session.exited',
    } as CanonicalRuntimeEvent);
    await vi.waitFor(() => expect(accepted().has(exited)).toBe(false));

    // Park: the sweep stops the idle engine; its exit is absorbed.
    expect(await f.service.sweepIdleSessions(Date.now() + 86_400_000)).toEqual([
      parked,
    ]);
    expect(accepted().has(parked)).toBe(false);
  });

  test('a running session listed unconfined can be stopped at once, and its next start is confined', async () => {
    const f = await fixture({ agents: { 'claude-agent': 'never' } });
    f.claude.completeTurns = true;
    const laptop = f.pair('Laptop', true);
    const { conversationId } = await f.chat(
      f.bearer(laptop.credential),
      'claude-agent',
    );

    const removed = await removeFullAccess(f, laptop.device.id);

    const [entry] = removed.body.fullAccessRevocation.stillUnconfined;
    expect(entry).toMatchObject({ conversationId, until: 'next-turn' });
    // What the revocation notice's "Stop now" sends.
    const stop = vi.spyOn(f.claude, 'stopSession');
    const stopped = await f.request(
      f.bearer(f.operator.credential),
      '/api/orchestration/commands',
      { type: 'stopSession', threadId: entry.sessionId },
    );
    expect(stopped.status, stopped.text).toBe(200);
    expect(stop).toHaveBeenCalledWith(entry.sessionId);
    // With no engine running, it is re-confined from its next start.
    await vi.waitFor(async () => {
      const rerun = await f.request(
        f.bearer(f.operator.credential),
        `/api/pairing/devices/${encodeURIComponent(laptop.device.id)}/scope`,
        { scope: standardScope, resetFullAccess: true },
      );
      expect(bare(rerun.body.fullAccessRevocation)).toMatchObject({
        reconfined: [{ conversationId }],
        stillUnconfined: [],
      });
    });
    const starts = f.claude.starts.length;
    await vi.waitFor(async () => {
      const continued = await f.request(
        f.bearer(f.operator.credential),
        `/api/orchestration/chat/${encodeURIComponent(conversationId)}/continue`,
        { message: 'again' },
      );
      expect(continued.status, continued.text).toBe(200);
    });
    expect(f.claude.starts.length).toBe(starts + 1);
    expect(lastStart(f, 'claude-agent')).toMatchObject({
      confinement: 'workspace',
      approvalMode: 'auto',
      stamp: 'workspace',
    });
  });

  test('never only from an Agent default on someone else’s unconfined session is listed, not changed', async () => {
    const f = await fixture({ agents: { 'claude-agent': 'never' } });
    f.claude.completeTurns = true;
    const laptop = f.pair('Laptop', true);
    const { conversationId } = await f.chat(
      f.bearer(f.operator.credential),
      'claude-agent',
    );
    const threadId = f.claude.starts.at(-1)!.threadId;
    const latest = () =>
      Math.max(
        0,
        ...f.store
          .listEvents(threadId)
          .filter((row) => row.payload.method === 'session.approval-mode-set')
          .map((row) => row.globalSequence),
      );
    // The device takes part, then the operator picks Default, which
    // resolves to the Agent's never on the operator's unconfined session.
    for (const [credential, approvalMode] of [
      [laptop.credential, 'ask'],
      [f.operator.credential, 'connection-default'],
    ] as const) {
      const decided = await f.request(
        f.bearer(credential),
        '/api/orchestration/commands',
        {
          type: 'setApprovalMode',
          threadId,
          approvalMode,
          basedOnSequence: latest() || null,
        },
      );
      expect(decided.status, decided.text).toBe(200);
    }

    const removed = await removeFullAccess(f, laptop.device.id);

    expect(bare(removed.body.fullAccessRevocation)).toEqual({
      cause: 'scope-removed',
      reset: [],
      stillFullAccess: [{ conversationId, reason: 'agent-default' }],
      reconfined: [],
      stillUnconfined: [],
      unattributedHostStarts: NONE_UNATTRIBUTED,
    });
    expect(await nextTurn(f, threadId)).toMatchObject({
      confinement: 'host',
      modelOptions: { approvalMode: 'never' },
    });
  });

  test('a never decision recorded before decisions carried their actor is listed as unattributed, not reset', async () => {
    const f = await fixture({});
    f.claude.completeTurns = true;
    const laptop = f.pair('Laptop', true);
    const { conversationId } = await f.chat(
      f.bearer(f.operator.credential),
      'claude-agent',
    );
    const threadId = f.claude.starts.at(-1)!.threadId;
    // As an older Station recorded it: no clientOrigin.
    f.service.recordApprovalModeDecision({
      threadId,
      provider: 'claude',
      approvalMode: 'never',
      basedOnSequence: null,
    });

    const removed = await removeFullAccess(f, laptop.device.id);

    expect(bare(removed.body.fullAccessRevocation)).toEqual({
      cause: 'scope-removed',
      reset: [],
      stillFullAccess: [{ conversationId, reason: 'unattributed-decision' }],
      reconfined: [],
      stillUnconfined: [],
      unattributedHostStarts: NONE_UNATTRIBUTED,
    });
    expect(decisions(f, threadId).map((event) => event.approvalMode)).toEqual([
      'never',
    ]);
  });

  test('a scope change that keeps full access resets nothing', async () => {
    const f = await fixture({});
    const laptop = f.pair('Laptop', true);
    const { threadId } = await startAtFullAccess(
      f,
      laptop.credential,
      'recorded',
    );
    const kept = await f.request(
      f.bearer(f.operator.credential),
      `/api/pairing/devices/${encodeURIComponent(laptop.device.id)}/scope`,
      { scope: [...standardScope, PAIRING_SCOPE_APPROVAL_FULL_ACCESS] },
    );
    expect(kept.status, kept.text).toBe(200);
    expect(bare(kept.body.fullAccessRevocation)).toBeUndefined();
    expect(decisions(f, threadId).map((event) => event.approvalMode)).toEqual([
      'never',
    ]);
  });

  test('a live host session with no recorded grantor is listed as unattributed, never reset', async () => {
    const f = await fixture({});
    const laptop = f.pair('Laptop', true);
    await startUnattributedHost(f, 'older-host-session');

    const removed = await removeFullAccess(f, laptop.device.id);

    expect(removed.status, removed.text).toBe(200);
    expect(bare(removed.body.fullAccessRevocation).reset).toEqual([]);
    expect(
      bare(removed.body.fullAccessRevocation).unattributedHostStarts,
    ).toEqual({
      sessions: [
        { conversationId: 'older-host-session', startedAt: expect.any(String) },
      ],
      total: 1,
    });
    expect(decisions(f, 'older-host-session')).toEqual([]);
  });

  test('the unattributed listing is capped at 50, and says how many there are', async () => {
    const f = await fixture({});
    const laptop = f.pair('Laptop', true);
    for (let index = 0; index < 51; index += 1)
      await startUnattributedHost(f, `older-host-${index}`);

    const removed = await removeFullAccess(f, laptop.device.id);

    const listing = bare(
      removed.body.fullAccessRevocation,
    ).unattributedHostStarts;
    expect(listing.sessions).toHaveLength(50);
    expect(listing.total).toBe(51);
  });

  test('a start stamps its host grantor, and a start receipt records who asked', async () => {
    const f = await fixture({});
    const laptop = f.pair('Laptop', true);
    const { threadId } = await startAtFullAccess(
      f,
      laptop.credential,
      'default-channel',
    );
    expect(startGrantor(f, threadId)).toEqual({
      kind: 'device',
      deviceId: laptop.device.id,
    });
    expect(
      f.store
        .listCommandReceipts(threadId)
        .find((receipt) => receipt.commandType === 'startSession')?.clientOrigin
        ?.actor,
    ).toEqual({ kind: 'device', deviceId: laptop.device.id });
  });

  test('a device’s Default pick that reached unconfined never is re-confined instead, and keeps resolving through its default', async () => {
    const f = await fixture({ station: 'never' });
    f.claude.completeTurns = true;
    const laptop = f.pair('Laptop', true);
    const response = await f.request(
      f.bearer(laptop.credential),
      '/api/orchestration/chat',
      {
        message: 'go',
        target: { environment: { kind: 'current' }, agent: 'claude-agent' },
        setApprovalMode: 'connection-default',
        setApprovalModeBasedOn: null,
      },
    );
    expect(response.status, response.text).toBe(200);
    const threadId = f.claude.starts.at(-1)!.threadId;
    expect(lastStart(f, 'claude-agent')).toMatchObject({
      confinement: 'host',
      approvalMode: 'never',
    });

    const removed = await removeFullAccess(f, laptop.device.id);

    expect(bare(removed.body.fullAccessRevocation)).toMatchObject({
      reset: [],
      reconfined: [],
      stillUnconfined: [
        {
          conversationId: response.body.data.conversationId,
          until: 'next-turn',
        },
      ],
    });
    // The Default now resolves confined: the Station's never, as Claude's
    // auto inside the workspace, re-applied on this turn.
    expect(await nextTurn(f, threadId)).toMatchObject({
      confinement: 'workspace',
      modelOptions: { approvalMode: 'auto' },
    });
  });

  test('a respawn keeps the grantor beside the host stamp, so a later revoke still finds the session', async () => {
    const f = await fixture({});
    f.claude.completeTurns = true;
    const laptop = f.pair('Laptop', true);
    const { conversationId, threadId } = await startAtFullAccess(
      f,
      laptop.credential,
      'default-channel',
    );
    const stopped = await f.request(
      f.bearer(f.operator.credential),
      '/api/orchestration/commands',
      { type: 'stopSession', threadId },
    );
    expect(stopped.status, stopped.text).toBe(200);
    const starts = f.claude.starts.length;
    await vi.waitFor(async () => {
      const continued = await f.request(
        f.bearer(f.operator.credential),
        `/api/orchestration/chat/${encodeURIComponent(conversationId)}/continue`,
        { message: 'again' },
      );
      expect(continued.status, continued.text).toBe(200);
    });
    expect(f.claude.starts.length).toBe(starts + 1);
    const respawned = f.claude.starts.at(-1)!;
    expect(respawned.metadata?.stationConfinementGrantor).toEqual({
      kind: 'device',
      deviceId: laptop.device.id,
    });

    const revoked = await revokeDevice(f, laptop.device.id);

    expect(bare(revoked.body.fullAccessRevocation).reset).toEqual([
      { conversationId, was: 'host-start' },
    ]);
  });

  test('the device’s Auto on a session its grant unconfined resets to Ask; its Ask is left', async () => {
    const f = await fixture({});
    f.claude.completeTurns = true;
    const laptop = f.pair('Laptop', true);
    const start = async (approvalMode: 'auto' | 'ask') => {
      const response = await f.request(
        f.bearer(laptop.credential),
        '/api/orchestration/chat',
        {
          message: 'go',
          target: { environment: { kind: 'current' }, agent: 'claude-agent' },
          setApprovalMode: approvalMode,
          setApprovalModeBasedOn: null,
        },
      );
      expect(response.status, response.text).toBe(200);
      const threadId = f.claude.starts.at(-1)!.threadId;
      expect(lastStart(f, 'claude-agent').stamp).toBe('host');
      return {
        conversationId: response.body.data.conversationId as string,
        threadId,
      };
    };
    const auto = await start('auto');
    const ask = await start('ask');

    const removed = await removeFullAccess(f, laptop.device.id);

    expect(bare(removed.body.fullAccessRevocation).reset).toEqual([
      { conversationId: auto.conversationId, was: 'auto-on-host' },
    ]);
    // Both engines are running: each is listed until its next turn.
    const unconfined = bare(
      removed.body.fullAccessRevocation,
    ).stillUnconfined.map(
      (entry: { conversationId: string; until: string }) =>
        `${entry.conversationId} ${entry.until}`,
    );
    expect(bare(removed.body.fullAccessRevocation).reconfined).toEqual([]);
    expect(unconfined.sort()).toEqual(
      [
        `${auto.conversationId} next-turn`,
        `${ask.conversationId} next-turn`,
      ].sort(),
    );
    expect(
      decisions(f, ask.threadId).map((event) => event.approvalMode),
    ).toEqual(['ask']);
    expect(await nextTurn(f, auto.threadId)).toMatchObject({
      confinement: 'workspace',
      modelOptions: { approvalMode: 'ask' },
    });
  });

  test('without a live grant check the sessions stay unconfined, and are listed so', async () => {
    const f = await fixture({}, false);
    f.claude.completeTurns = true;
    const laptop = f.pair('Laptop', true);
    const { conversationId, threadId } = await startAtFullAccess(
      f,
      laptop.credential,
      'recorded',
    );

    const removed = await removeFullAccess(f, laptop.device.id);

    expect(bare(removed.body.fullAccessRevocation)).toMatchObject({
      reset: [{ conversationId, was: 'never' }],
      reconfined: [],
      stillUnconfined: [{ conversationId, until: 'grant-not-checked' }],
    });
    expect(await nextTurn(f, threadId)).toMatchObject({
      confinement: 'host',
      modelOptions: { approvalMode: 'ask' },
    });
  });

  test('a device that regains full access does not get its old sessions back at full access', async () => {
    const f = await fixture({});
    f.claude.completeTurns = true;
    const laptop = f.pair('Laptop', true);
    const { threadId } = await startAtFullAccess(
      f,
      laptop.credential,
      'recorded',
    );
    await removeFullAccess(f, laptop.device.id);
    const regranted = await f.request(
      f.bearer(f.operator.credential),
      `/api/pairing/devices/${encodeURIComponent(laptop.device.id)}/scope`,
      { scope: [...standardScope, PAIRING_SCOPE_APPROVAL_FULL_ACCESS] },
    );
    expect(regranted.status, regranted.text).toBe(200);
    // The stamp applies again, but the reset Ask stands: no full access
    // without a new pick.
    expect(await nextTurn(f, threadId)).toMatchObject({
      modelOptions: { approvalMode: 'ask' },
    });
  });

  test('a start whose full-access grant names no grantor is refused, and nothing starts', async () => {
    const f = await fixture({});
    const starts = f.claude.starts.length;
    await expect(
      f.service.dispatch(
        {
          type: 'startSession',
          input: {
            threadId: 'actorless-grant',
            provider: 'claude',
            modelOptions: { approvalMode: 'never' },
          },
        },
        { fullAccessGrant: fullAccessGrantForTesting(null) },
      ),
    ).rejects.toThrow(/must name who granted it/);
    expect(f.claude.starts).toHaveLength(starts);
    expect(
      f.store.latestEventByMethod('actorless-grant', 'session.started'),
    ).toBeUndefined();
  });

  test('H3: a reset that failed can be re-run, and running it again changes nothing more', async () => {
    const f = await fixture({});
    f.claude.completeTurns = true;
    const laptop = f.pair('Laptop', true);
    const { conversationId, threadId } = await startAtFullAccess(
      f,
      laptop.credential,
      'recorded',
    );
    vi.spyOn(f.service, 'resetFullAccessGrantedBy').mockRejectedValueOnce(
      new Error('store unavailable'),
    );

    const failed = await removeFullAccess(f, laptop.device.id);

    expect(failed.status).toBe(200);
    expect(failed.body.fullAccessRevocationError).toBe('reset_failed');
    expect(decisions(f, threadId).map((event) => event.approvalMode)).toEqual([
      'never',
    ]);
    // A scope write that keeps it absent, without asking, resets nothing.
    const plain = await removeFullAccess(f, laptop.device.id);
    expect(bare(plain.body.fullAccessRevocation)).toBeUndefined();
    const retry = () =>
      f.request(
        f.bearer(f.operator.credential),
        `/api/pairing/devices/${encodeURIComponent(laptop.device.id)}/scope`,
        { scope: standardScope, resetFullAccess: true },
      );

    const retried = await retry();

    expect(bare(retried.body.fullAccessRevocation)).toMatchObject({
      reset: [{ conversationId, was: 'never' }],
      stillUnconfined: [{ conversationId, until: 'next-turn' }],
    });
    // A turn since then ran confined, on the same running engine: a re-run
    // lists it as re-confined, with nothing left to stop.
    expect(await nextTurn(f, threadId)).toMatchObject({
      confinement: 'workspace',
    });
    const again = await retry();
    expect(bare(again.body.fullAccessRevocation)).toMatchObject({
      reset: [],
      reconfined: [{ conversationId }],
      stillUnconfined: [],
    });
    expect(decisions(f, threadId).map((event) => event.approvalMode)).toEqual([
      'never',
      'ask',
    ]);
  });

  test('each listed conversation carries its title and a session to open it by', async () => {
    const f = await fixture({});
    f.claude.completeTurns = true;
    const laptop = f.pair('Laptop', true);
    const { conversationId, threadId } = await startAtFullAccess(
      f,
      laptop.credential,
      'recorded',
    );

    const removed = await removeFullAccess(f, laptop.device.id);

    const entry = { conversationId, sessionId: threadId, title: 'go' };
    expect(removed.body.fullAccessRevocation.reset).toEqual([
      { ...entry, was: 'never' },
    ]);
    // Its engine is running: listed, by that running session, until its
    // next turn.
    expect(removed.body.fullAccessRevocation.stillUnconfined).toEqual([
      { ...entry, until: 'next-turn' },
    ]);
  });
});
