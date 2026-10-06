/**
 * #3429: after Continue in Station, the dock opens the continuation and a
 * follow-up sent from it reaches the continuation's engine in its folder.
 *
 * Everything real except the engines and the Station's own HTTP discovery
 * reads: the security service owns this Station's Environment, a real
 * ConfigLoader holds the engine's Agent (materialized the way boot adoption
 * does), the real OrchestrationService adopts the attached conversation, and
 * the real orchestration and conversation routes open and continue it. The
 * engines record what Station handed them and publish `session.started` with
 * the start metadata, as the real adapters do.
 */
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { materializeEngineAgent } from '../../../domain/agent-registry.js';
import { ConfigLoader } from '../../../domain/config-loader.js';
import { ensureStationHomeSchemaSync } from '../../../domain/home-schema-gate.js';
import type {
  ProviderAdapterMetadata,
  ProviderAdapterShape,
  ProviderSession,
  ProviderSessionAdoptInput,
} from '../../../providers/adapter-shape.js';
import type { IProviderAdapterRegistry } from '../../../providers/provider-interfaces.js';
import { AsyncEventQueue } from '../../../providers/sessions/async-event-queue.js';
import { configureRuntimeHttp } from '../../../runtime/bootstrap/runtime-http.js';
import { createAgentDispatchActorResolver } from '../../../runtime/mcp/station-control-caller.js';
import { createAdoptedChildExecutionBindingResolver } from '../../../services/orchestration/adopted-child-execution-binding.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { EnvironmentSecurityService } from '../../../services/ssh/environment-security-service.js';
import { createLogger } from '../../../utils/logger.js';
import { createGlobalConversationRoutes } from '../../chat/conversations.js';
import { createOrchestrationRoutes } from '../orchestration.js';

const CURRENT_API = 'http://adopted-dock.test';
process.env.STATION_API_BASE = CURRENT_API;

const fetchMock = vi.fn<typeof fetch>();

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type Engine = 'claude' | 'codex';

/**
 * The Station's own discovery reads, answered from the real Agent store and
 * Environment record so they cannot disagree with what adoption read.
 */
function installStationDiscovery(
  loader: ConfigLoader,
  security: EnvironmentSecurityService,
): void {
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url === `${CURRENT_API}/.well-known/station/v1`)
      return json({
        environmentId: (await security.readExistingRecord()).environmentId,
      });
    const agent = url.match(/\/api\/agents\/([^/]+)$/)?.[1];
    if (agent) {
      const spec = await loader.loadAgent(decodeURIComponent(agent));
      return json({
        success: true,
        data: { ...spec, slug: agent, available: true },
      });
    }
    const connection = url.match(/\/api\/connections\/([^/]+)$/)?.[1];
    if (connection)
      return json({
        success: true,
        data: {
          id: connection,
          kind: 'agent',
          type: connection,
          enabled: true,
          status: 'ready',
          capabilities: ['agent-runtime'],
          config: { provider: connection },
        },
      });
    throw new Error(`Unexpected request in adopted-dock test: ${url}`);
  });
}

/** An engine that forks attached conversations and records every turn. */
class AdoptingEngine implements ProviderAdapterShape {
  readonly metadata: ProviderAdapterMetadata;
  readonly events = new AsyncEventQueue<CanonicalRuntimeEvent>();
  readonly adoptions: ProviderSessionAdoptInput[] = [];
  readonly starts: Array<{ threadId: string; cwd?: string }> = [];
  readonly turns: Array<{ threadId: string; input: string }> = [];
  private readonly sessions = new Map<string, ProviderSession>();

  constructor(readonly provider: Engine) {
    this.metadata = {
      displayName: provider,
      description: `${provider} adopted-dock test engine`,
      capabilities: ['agent-runtime'],
    };
  }

  private publishStart(input: {
    threadId: string;
    cwd?: string;
    metadata?: Record<string, unknown>;
  }) {
    this.events.push({
      eventId: `${input.threadId}:session.started:${this.starts.length}`,
      provider: this.provider,
      threadId: input.threadId,
      createdAt: new Date().toISOString(),
      method: 'session.started',
      sessionId: input.threadId,
      metadata: { ...input.metadata, cwd: input.cwd },
    } as CanonicalRuntimeEvent);
  }

  async adoptSession(input: ProviderSessionAdoptInput) {
    this.adoptions.push(input);
    this.starts.push({ threadId: input.threadId, cwd: input.cwd });
    this.publishStart(input);
    const now = new Date().toISOString();
    const session: ProviderSession = {
      provider: this.provider,
      threadId: input.threadId,
      status: 'ready',
      cwd: input.cwd,
      resumeCursor: `child-of-${input.sourceSessionId}`,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(input.threadId, session);
    return session;
  }

  async discardSession(): Promise<void> {}

  async startSession(input: {
    threadId: string;
    cwd?: string;
    metadata?: Record<string, unknown>;
  }) {
    this.starts.push({ threadId: input.threadId, cwd: input.cwd });
    this.publishStart(input);
    const now = new Date().toISOString();
    const session: ProviderSession = {
      provider: this.provider,
      threadId: input.threadId,
      status: 'ready',
      ...(input.cwd ? { cwd: input.cwd } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(input.threadId, session);
    return session;
  }

  async sendTurn(input: { threadId: string; input: string }) {
    this.turns.push({ threadId: input.threadId, input: input.input });
    return {
      threadId: input.threadId,
      turnId: `${this.provider}-turn-${this.turns.length}`,
    };
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

const makeTempDir = trackTempDirs();
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(options: { engineAgent: boolean }) {
  vi.stubEnv('STATION_HOSTED_TENANT_REGISTRY_FILE', undefined);
  const root = realpathSync.native(makeTempDir('station-adopted-dock-'));
  const home = join(root, 'home');
  // Boot claims the home's schema before anything is written to it.
  ensureStationHomeSchemaSync(home);
  const security = new EnvironmentSecurityService({ homeDir: home });
  const operator = await security.initialize();
  const loader = new ConfigLoader({ projectHomeDir: home });
  // The engines' own Agents, as boot adoption of a detected engine writes
  // them (`native-engine-adoption.ts`).
  if (options.engineAgent) {
    await materializeEngineAgent(loader, 'claude', 'Claude Code');
    await materializeEngineAgent(loader, 'codex', 'Codex');
  }
  installStationDiscovery(loader, security);

  const project = join(root, 'station');
  const folder = join(project, 'packages', 'app');
  mkdirSync(folder, { recursive: true });

  const store = new EventStore(join(root, 'orchestration.sqlite'));
  const eventBus = new EventBus();
  const engines = {
    claude: new AdoptingEngine('claude'),
    codex: new AdoptingEngine('codex'),
  };
  const registry: IProviderAdapterRegistry = {
    register() {},
    get: (provider) => engines[provider as Engine],
    list: () => Object.values(engines),
  };
  const service = new OrchestrationService({
    adapterRegistry: registry,
    eventBus,
    eventStore: store,
    adoptionLedger: store.createAdoptionLedger(),
    listProjects: () => [{ slug: 'station', workingDirectory: project }],
    // The production composition (`runtime-initialize.ts`).
    resolveAdoptedChildExecutionBinding:
      createAdoptedChildExecutionBindingResolver({
        configLoader: loader,
        readEnvironmentId: async () =>
          (await security.readExistingRecord()).environmentId,
      }),
    logger: { debug: vi.fn(), warn: vi.fn() },
  } as never);
  cleanups.push(async () => {
    await service.shutdown();
    store.close();
  });

  const { continueExecutionTargetMessage, executeExecutionTargetMessage } =
    await import('../../../tools/station-control-delegation.js');
  const readAuthority = (userId: string) =>
    sessionReadAuthorityFromRequest(userId, undefined, undefined);

  const app = new Hono();
  configureRuntimeHttp({
    app: app as never,
    logger: createLogger({ name: 'adopted-dock-test', level: 'error' }),
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
    } as never),
  );
  app.route(
    '/api/conversations',
    createGlobalConversationRoutes(
      new Map(),
      { getConversation: () => null },
      createLogger({ name: 'adopted-dock-test', level: 'error' }),
      undefined,
      service as never,
      () => 'operator',
      undefined,
      () => readAuthority('operator'),
    ),
  );

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${operator.credential}`,
  };
  const request = async (path: string, body?: unknown) => {
    const res = await app.request(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) as any };
  };

  let sources = 0;
  /** A followed conversation of `engine` whose recorded folder is `cwd`. */
  const attached = (engine: Engine, cwd = folder): string => {
    sources += 1;
    const threadId = `external:${engine}:dock-${sources}`;
    const createdAt = '2026-10-05T00:00:00.000Z';
    store.upsertSession({
      provider: engine,
      threadId,
      status: 'ready',
      cwd,
      controlMode: 'read-only-attached',
      attachedSource: {
        kind: engine === 'claude' ? 'claude-transcript' : 'codex-rollout',
        externalSessionId: `native-${sources}`,
        affinity: { kind: 'test', ref: 'fixture' },
      },
      createdAt,
      updatedAt: createdAt,
    });
    // The follow service records the local operator as the owner of a
    // conversation read from this host's engine homes.
    store.appendEvent({
      eventId: `${threadId}:attached`,
      provider: engine,
      threadId,
      createdAt,
      method: 'session.started',
      sessionId: threadId,
      metadata: { userId: 'operator' },
    } as never);
    // Codex continues only from a completed turn of the source.
    store.appendEvent({
      eventId: `${threadId}:turn-completed`,
      provider: engine,
      threadId,
      turnId: 'source-turn',
      createdAt,
      method: 'turn.completed',
      finishReason: 'stop',
    } as never);
    return threadId;
  };

  /** Continue in Station through the real command route. */
  const adopt = async (sourceThreadId: string) => {
    const response = await request('/api/orchestration/commands', {
      type: 'adoptSession',
      sourceThreadId,
    });
    expect(response.status, response.text).toBe(200);
    const childThreadId = response.body.data.threadId as string;
    // The child's start event is projected asynchronously, as in production.
    await vi.waitFor(() =>
      expect(
        store.latestEventByMethod(childThreadId, 'session.started'),
      ).toBeTruthy(),
    );
    return childThreadId;
  };

  return {
    operator,
    security,
    loader,
    service,
    store,
    engines,
    project,
    folder,
    attached,
    adopt,
    request,
  };
}

describe('#3429: a continued attached conversation opens in the dock', () => {
  test.each(['claude', 'codex'] as const)(
    '%s: the dock opens the continuation and a /chat follow-up reaches its engine in its folder',
    async (engine) => {
      const f = await fixture({ engineAgent: true });
      const child = await f.adopt(f.attached(engine));
      const environmentId = (await f.security.readExistingRecord())
        .environmentId;

      // Adoption kept its own confinement (the operator in person may grant
      // `host`, #2493) and folder, and added the binding a dock-started chat
      // of the engine's own Agent records.
      const [adoption] = f.engines[engine].adoptions;
      expect(adoption!.cwd).toBe(f.folder);
      expect(adoption!.confinement).toBe('host');
      expect(adoption!.metadata).toMatchObject({
        stationConfinement: 'host',
        agentSlug: engine,
        targetKind: 'agent',
        targetId: engine,
        connectionId: engine,
        environmentId,
        conversationId: child,
      });

      // The dock's open read (`GET /api/conversations/:id/open`).
      const opened = await f.request(
        `/api/conversations/${encodeURIComponent(child)}/open`,
      );
      expect(opened.status, opened.text).toBe(200);
      expect(opened.body.data).toMatchObject({
        status: 'resolved',
        currentSessionId: child,
        canContinue: true,
        conversation: { id: child, agentSlug: engine, environmentId },
        execution: {
          sessionId: child,
          agentId: engine,
          provider: engine,
          engineConnectionId: engine,
        },
      });

      // The dock's follow-up: the payload `foregroundMessageDispatch.ts`
      // builds for a tab with no project.
      const followUp = await f.request('/api/orchestration/chat', {
        target: { environment: { kind: 'current' }, agent: engine },
        message: 'keep going',
        conversationId: child,
      });
      expect(followUp.status, followUp.text).toBe(200);
      expect(followUp.body.data).toMatchObject({
        conversationId: child,
        sessionId: child,
      });
      // It reached the continuation's engine session, which runs in the
      // attached conversation's folder: no other session was started.
      expect(f.engines[engine].turns).toEqual([
        { threadId: child, input: 'keep going' },
      ]);
      expect(f.engines[engine].starts).toEqual([
        { threadId: child, cwd: f.folder },
      ]);
      const other = engine === 'claude' ? 'codex' : 'claude';
      expect(f.engines[other].turns).toEqual([]);
    },
  );

  test('a follow-up as a different Agent is refused by the binding', async () => {
    const f = await fixture({ engineAgent: true });
    const child = await f.adopt(f.attached('claude'));
    const followUp = await f.request('/api/orchestration/chat', {
      target: { environment: { kind: 'current' }, agent: 'codex' },
      message: 'switch',
      conversationId: child,
    });
    expect(followUp.status).not.toBe(200);
    expect(followUp.text).toMatch(
      /different Environment, Agent, or Station user/,
    );
    expect(f.engines.claude.turns).toEqual([]);
    expect(f.engines.codex.turns).toEqual([]);
  });

  test('with no Agent for the engine, the continuation is still created, has no Agent, and the dock cannot open it', async () => {
    const f = await fixture({ engineAgent: false });
    const child = await f.adopt(f.attached('claude'));

    // Nothing was written to the Agent store.
    expect(await f.loader.listAgents()).toEqual([]);
    const [adoption] = f.engines.claude.adoptions;
    expect(adoption!.metadata).not.toHaveProperty('agentSlug');
    expect(adoption!.metadata).not.toHaveProperty('environmentId');
    expect(adoption!.metadata).toMatchObject({ stationConfinement: 'host' });

    // What the dock reads to say why (`ImportedConversationPane`).
    const summary = await f.request(
      `/api/orchestration/sessions/${encodeURIComponent(child)}`,
    );
    expect(summary.status, summary.text).toBe(200);
    expect(summary.body.data.session.threadId).toBe(child);
    expect(summary.body.data.session).not.toHaveProperty('assignedAgentSlug');
    const opened = await f.request(
      `/api/conversations/${encodeURIComponent(child)}/open`,
    );
    expect(opened.status).toBe(404);
  });
});
