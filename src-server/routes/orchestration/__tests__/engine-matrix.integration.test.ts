import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { serve } from '@hono/node-server';
import { engineConnectionId } from '@kontourai/station-contracts/agent-identity';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { originalMcpToolName } from '@kontourai/station-shared/mcp-tool-selection';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { scenarios as deliveryScenarios } from '../../../../scripts/engine-delivery-probes.js';
import { runMatrix } from '../../../../scripts/lib/engine-matrix.mjs';
import { createGateTestRegistry } from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ConfigLoader } from '../../../domain/config-loader.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import type {
  ProviderAdapterMetadata,
  ProviderAdapterShape,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
} from '../../../providers/adapter-shape.js';
import { AsyncEventQueue } from '../../../providers/sessions/async-event-queue.js';
import { currentAuthorizedTurnCorrelation } from '../../../runtime/conversation/authorized-turn-correlation.js';
import { declareCurrentNativeOutput } from '../../../runtime/native-output-declaration.js';
import {
  closeNativeOutputTurnContext,
  currentNativeOutputRelayCompanion,
  runWithCurrentNativeOutputCall,
  runWithNativeOutputTurnContext,
} from '../../../runtime/native-output-turn-grant.js';
import { setRuntimeAuthenticatedRequestPrincipal } from '../../../security/runtime-request-security.js';
import { AgentService } from '../../../services/agents/agent-service.js';
import { SkillService } from '../../../services/agents/skill-service.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { createSessionAgentResolver } from '../../../services/orchestration/session-agent-resolution.js';
import { MCPService } from '../../../services/plugins/mcp-service.js';
import {
  continueExecutionTargetMessage,
  executeExecutionTargetMessage,
} from '../../../tools/station-control-delegation.js';
import { isRecord } from '../../../utils/is-record.js';
import { createLogger } from '../../../utils/logger.js';
import { createAgentRoutes } from '../../agents/agents.js';
import { createSkillRoutes } from '../../agents/skills.js';
import { createToolRoutes } from '../../agents/tools.js';
import { createOrchestrationRoutes } from '../orchestration.js';

const makeTempDir = trackTempDirs();
const exec = promisify(execFile);
const principal = {
  id: 'human:matrix:owner',
  kind: 'human' as const,
  display: 'Matrix owner',
};
const connection = {
  id: 'matrix-engine',
  kind: 'agent' as const,
  name: 'Fake engine',
  type: 'station-agent',
  enabled: true,
  status: 'ready' as const,
  capabilities: ['agent-runtime' as const],
  prerequisites: [],
  config: { provider: 'station-agent' },
};

class MatrixAdapter implements ProviderAdapterShape {
  provider = 'station-agent';
  eventProvider: string | undefined;
  readonly metadata: ProviderAdapterMetadata = {
    displayName: 'Matrix fake',
    description: 'Offline matrix integration',
    capabilities: ['agent-runtime'],
    modelLaunch: {
      defaultAtStart: 'engine-selected',
      omissionAtResume: 'engine-selected',
      omissionPerTurn: 'engine-selected',
      overrideAtStart: true,
      overrideAtResume: true,
      overridePerTurn: true,
    },
    continuity: { resume: 'same-session', fork: 'none', rewind: 'none' },
  };
  readonly events = new AsyncEventQueue<CanonicalRuntimeEvent>();
  readonly sessions = new Map<string, ProviderSession>();
  readonly turns: ProviderSendTurnInput[] = [];
  readonly starts: ProviderSessionStartInput[] = [];
  readonly stops: string[] = [];
  readonly rendered = new Map<string, string[]>();
  deliveryTurn:
    | ((
        input: ProviderSendTurnInput,
        turnId: string,
      ) => Promise<string | undefined>)
    | undefined;
  private readonly secrets = new Map<string, string>();
  startupError: string | undefined;
  forgetOnStop = false;
  stopError = false;
  failSend = false;
  wrongContent = false;
  reportedModel: string | undefined;
  catalog = ['matrix-1', 'matrix-2'].map((id) => ({
    id,
    name: id,
    originalId: id,
    resolvedModel: undefined as string | undefined,
  }));
  missingModel = false;
  wrongFollowup = false;
  noOpStop = false;
  constructor(private readonly root: string) {}
  async listModelCatalog() {
    return {
      models: this.catalog,
    };
  }
  async startSession(
    input: ProviderSessionStartInput,
  ): Promise<ProviderSession> {
    this.starts.push(input);
    const session: ProviderSession = {
      provider: this.provider,
      threadId: input.threadId,
      cwd: input.cwd,
      model: input.modelId,
      status: 'ready',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.sessions.set(input.threadId, session);
    try {
      this.secrets.set(
        input.threadId,
        await readFile(
          join(this.root, `${encodeURIComponent(input.threadId)}.secret`),
          'utf8',
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.events.push({
      eventId: randomUUID(),
      provider: this.provider,
      threadId: input.threadId,
      sessionId: input.threadId,
      method: 'session.started',
      createdAt: session.createdAt,
      metadata: input.metadata,
    });
    this.events.push({
      eventId: randomUUID(),
      provider: this.provider,
      threadId: input.threadId,
      sessionId: input.threadId,
      method: 'session.configured',
      createdAt: session.createdAt,
      cwd: input.cwd,
      model: input.modelId,
      metadata: input.metadata,
    });
    if (this.startupError)
      this.events.push({
        eventId: randomUUID(),
        provider: this.provider,
        threadId: input.threadId,
        method: 'runtime.error',
        severity: 'error',
        createdAt: new Date().toISOString(),
        message: this.startupError,
      });
    return session;
  }
  async sendTurn(input: ProviderSendTurnInput) {
    this.turns.push(input);
    if (this.failSend) throw new Error('Engine send failed');
    const turnId = currentAuthorizedTurnCorrelation()?.turnId ?? randomUUID();
    const base = {
      provider: this.eventProvider ?? this.provider,
      threadId: input.threadId,
      turnId,
      createdAt: new Date().toISOString(),
    };
    this.events.push({
      ...base,
      eventId: randomUUID(),
      method: 'turn.started',
      prompt: input.displayInput ?? input.input,
    });
    const token = /Remember this secret for this conversation: ([\w-]+)\./.exec(
      input.input,
    )?.[1];
    if (token) {
      this.secrets.set(input.threadId, token);
      await writeFile(
        join(this.root, `${encodeURIComponent(input.threadId)}.secret`),
        token,
      );
    }
    const artifact =
      /Create (station-matrix-[\w-]+\.txt) containing exactly (STATION_MATRIX_ARTIFACT:[\w-]+)/.exec(
        input.input,
      );
    if (artifact) {
      const session = this.sessions.get(input.threadId);
      if (!session?.cwd) throw new Error('No admitted workspace');
      await writeFile(
        join(session.cwd, artifact[1]),
        this.wrongContent ? 'Wrong artifact contents' : artifact[2],
      );
      const context =
        currentNativeOutputRelayCompanion()?.issueForRuntimeConfiguration(
          this,
          () => true,
        );
      if (!context) throw new Error('No native output declaration grant');
      await runWithNativeOutputTurnContext(context, () =>
        runWithCurrentNativeOutputCall(randomUUID(), () =>
          declareCurrentNativeOutput({
            file: { path: artifact[1], mediaType: 'text/plain' },
          }),
        ),
      );
      closeNativeOutputTurnContext(context);
      this.rendered.set(turnId, [artifact[1]]);
    }
    const deliveryReply = await this.deliveryTurn?.(input, turnId);
    const reply =
      deliveryReply ??
      (/Reply with exactly STATION_SMOKE_OK/.test(input.input)
        ? 'STATION_SMOKE_OK'
        : this.wrongFollowup
          ? 'wrong recall'
          : (this.secrets.get(input.threadId) ?? 'forgot'));
    this.events.push({
      ...base,
      eventId: randomUUID(),
      method: 'turn.completed',
      outputText: reply,
      metadata: {
        effectiveModel: input.modelId,
        ...(this.missingModel
          ? {}
          : {
              reportedModel:
                this.reportedModel ??
                this.catalog.find((entry) => entry.id === input.modelId)
                  ?.resolvedModel ??
                input.modelId,
            }),
      },
    });
    return { threadId: input.threadId, turnId };
  }
  async stopSession(threadId: string) {
    this.stops.push(threadId);
    if (this.stopError)
      this.emitError(threadId, 'Recycle transport disconnected');
    if (this.forgetOnStop)
      await rm(join(this.root, `${encodeURIComponent(threadId)}.secret`), {
        force: true,
      });
    if (!this.noOpStop) {
      this.sessions.delete(threadId);
      this.secrets.delete(threadId);
    }
  }
  emitError(threadId: string, message: string) {
    const eventId = randomUUID();
    this.events.push({
      eventId,
      provider: this.provider,
      threadId,
      method: 'runtime.error',
      severity: 'error',
      createdAt: new Date().toISOString(),
      message,
    });
    return eventId;
  }
  async listSessions() {
    return [...this.sessions.values()];
  }
  async hasSession(threadId: string) {
    return this.sessions.has(threadId);
  }
  async interruptTurn() {
    return { outcome: 'no-active-turn' as const };
  }
  async respondToRequest() {}
  async stopAll() {
    this.sessions.clear();
  }
  streamEvents(options?: { signal?: AbortSignal }) {
    return this.events.iterable(options);
  }
}

describe('engine matrix through real foreground routes and orchestration', () => {
  let service: OrchestrationService;
  let adapter: MatrixAdapter;
  let store: EventStore;
  let server: ReturnType<typeof serve>;
  let origin: string;
  let workspace: string;
  let connections: (typeof connection)[];
  let loader: ConfigLoader;
  let skills: SkillService;
  let integrations: MCPService;
  let agents: AgentService;
  const requests: Array<{
    path: string;
    method: string;
    body?: unknown;
    status?: number;
  }> = [];
  beforeEach(async () => {
    const root = await realpath(makeTempDir('engine-matrix-real-'));
    workspace = join(root, 'workspace');
    await mkdir(workspace);
    vi.stubEnv('STATION_HOME', join(root, 'home'));
    vi.stubEnv('STATION_INSTANCE_NAME', 'matrix-integration');
    vi.stubEnv('STATION_DELIVERY_PROBE_MCP_ENDPOINT', '');
    loader = new ConfigLoader({ projectHomeDir: join(root, 'home') });
    const logger = createLogger({ name: 'matrix-delivery-integration' });
    skills = new SkillService(loader, logger);
    integrations = new MCPService(
      loader,
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      logger,
      undefined,
      49372,
    );
    agents = new AgentService(
      loader,
      new FileStorageAdapter(join(root, 'home')),
      new Map(),
      new Map(),
      new Map(),
      logger,
    );
    requests.length = 0;
    connections = [connection];
    adapter = new MatrixAdapter(root);
    store = new EventStore(join(root, 'events.sqlite'));
    const bus = new EventBus();
    service = new OrchestrationService({
      adapterRegistry: createGateTestRegistry(adapter),
      eventBus: bus,
      eventStore: store,
      logger: { debug: vi.fn(), warn: vi.fn() },
      resolveSessionAgent: createSessionAgentResolver({
        logger,
        loadAgentSpec: async (slug) =>
          slug === 'matrix'
            ? {
                name: 'Matrix',
                prompt: 'Follow the supplied diagnostic prompt.',
                execution: {
                  agentConnectionId: engineConnectionId('matrix-engine'),
                },
              }
            : await loader.loadAgent(slug),
        resolveToolServer: async (id) => loader.loadIntegration(id),
        resolveSkillDir: async (id) => (await skills.getSkill(id)).path,
      }),
    });
    const app = new Hono();
    app.use('*', async (c, next) => {
      setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
        credential: 'operator-credential',
        authority: 'operator-credential',
        source: 'bearer',
      });
      const row = {
        path: c.req.path,
        method: c.req.method,
        ...(c.req.method === 'POST'
          ? { body: await c.req.raw.clone().json() }
          : {}),
        status: 0,
      };
      requests.push(row);
      await next();
      row.status = c.res.status;
    });
    app.get('/.well-known/station/v1', (c) =>
      c.json({ environmentId: 'matrix-host' }),
    );
    const agent = {
      slug: 'matrix',
      name: 'Matrix',
      available: true,
      executionDefault: true,
      execution: { agentConnectionId: 'matrix-engine' },
    };
    app.get('/api/agents', (c) => c.json({ success: true, data: [agent] }));
    app.get('/api/agents/:slug', async (c) =>
      c.json({
        success: true,
        data:
          c.req.param('slug') === 'matrix'
            ? agent
            : {
                slug: c.req.param('slug'),
                ...(await loader.loadAgent(c.req.param('slug'))),
                available: true,
              },
      }),
    );
    app.route(
      '/api/skills',
      createSkillRoutes(skills, () => join(root, 'home')),
    );
    app.route(
      '/integrations',
      createToolRoutes(integrations, async () => undefined),
    );
    app.route(
      '/agents',
      createAgentRoutes(
        agents,
        skills,
        async (operation) => operation(() => undefined),
        () => ({ getAgents: () => [] }),
      ),
    );

    app.get('/api/connections/agents', (c) =>
      c.json({
        success: true,
        data: connections.map((entry) => ({
          ...entry,
          type: adapter.provider,
          config: { provider: adapter.provider },
        })),
      }),
    );
    app.get('/api/connections/matrix-engine', (c) =>
      c.json({
        success: true,
        data: {
          ...connection,
          type: adapter.provider,
          config: { provider: adapter.provider },
        },
      }),
    );
    app.route(
      '/api/orchestration',
      createOrchestrationRoutes(service, {
        eventBus: bus,
        logger: { debug: vi.fn() },
        getUserId: () => 'matrix-owner',
        resolvePrincipal: () => principal,
        isRequestPrincipalCurrent: () => true,
        executeForegroundMessage: (input) =>
          executeExecutionTargetMessage(input, service),
        continueForegroundMessage: (input) =>
          continueExecutionTargetMessage(input, service),
      }),
    );
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
    if (!server.listening)
      await new Promise<void>((resolve) => server.once('listening', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    vi.stubEnv('STATION_API_BASE', origin);
    vi.stubEnv('STATION_INTERNAL_API_TOKEN', 'matrix-test-control-token');
  });
  afterEach(async () => {
    await service?.shutdown();
    store?.close();
    await integrations?.resetRuntimeState();
    if (server)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    vi.unstubAllEnvs();
  });
  const api = async (
    path: string,
    body?: unknown,
    method = body ? 'POST' : 'GET',
  ) => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    if (!isRecord(result) || !response.ok || !result.success)
      throw new Error(`HTTP ${response.status}: ${JSON.stringify(result)}`);
    return result;
  };
  const run = (extra: Record<string, unknown> = {}) =>
    runMatrix({
      api,
      connectionId: 'matrix-engine',
      cwd: workspace,
      timeoutMs: 5000,
      observeOutputs: async ({
        sessionId,
        turnId,
      }: {
        sessionId: string;
        turnId: string;
      }) => ({
        sessionId,
        turnId,
        names: adapter.rendered.get(turnId) ?? [],
      }),
      ...extra,
    });

  test('runs the full delivery probe through real skill, MCP, policy and foreground routes, then DELETEs all resources', async () => {
    const deliveryErrors: unknown[] = [];
    const deliver: NonNullable<MatrixAdapter['deliveryTurn']> = async (
      input,
      turnId,
    ) => {
      if (
        !input.input.startsWith('Use the delivery-') &&
        !input.input.startsWith('Call ping')
      )
        return undefined;
      const start = adapter.starts.findLast(
        (entry) => entry.threadId === input.threadId,
      );
      // Station's native engine loads its authored Agent at invocation, rather
      // than receiving the external-adapter ResolvedAgentDefinition channel.
      const slug = start?.metadata?.agentSlug;
      if (typeof slug !== 'string')
        throw new Error('No admitted Agent identity');
      expect(slug).toMatch(/^delivery-/);
      const spec = await loader.loadAgent(slug);
      const serverId = spec.tools?.mcpServers?.find((id) =>
        id.startsWith('probe'),
      );
      if (!serverId) throw new Error('No configured MCP server');
      const server = await loader.loadIntegration(serverId);
      expect(server.disabledTools).toEqual(['blocked']);
      expect(
        server.probe?.toolNames?.map((name) =>
          originalMcpToolName(server.id, name),
        ),
      ).toEqual(expect.arrayContaining(['ping', 'blocked']));
      if (input.input.startsWith('Use the delivery-')) {
        const skillId = spec.skills?.[0];
        if (!skillId) throw new Error('Skill did not reach the authored Agent');
        const skill = await skills.getSkill(skillId);
        const result = await exec(
          process.execPath,
          [join(skill.path, 'scripts/probe.mjs')],
          { cwd: workspace, windowsHide: true, timeout: 5000 },
        );
        const artifact = (await readdir(workspace)).find((name) =>
          /^delivery-.*\.txt$/.test(name),
        );
        if (!artifact) throw new Error('Skill script did not write its output');
        const context =
          currentNativeOutputRelayCompanion()?.issueForRuntimeConfiguration(
            adapter,
            () => true,
          );
        if (!context) throw new Error('No delivery output grant');
        try {
          await runWithNativeOutputTurnContext(context, () =>
            runWithCurrentNativeOutputCall(randomUUID(), () =>
              declareCurrentNativeOutput({
                file: { path: artifact, mediaType: 'text/plain' },
              }),
            ),
          );
        } finally {
          closeNativeOutputTurnContext(context);
        }
        adapter.rendered.set(turnId, [artifact]);
        expect(
          await readFile(join(skill.path, 'SKILL.md'), 'utf8'),
        ).not.toContain(result.stdout.trim());
        expect(input.input).not.toContain(result.stdout.trim());
        return result.stdout.trim();
      }
      if (!server?.command)
        throw new Error('MCP did not reach session resolution');
      const client = new Client({ name: 'matrix-delivery', version: '1' });
      try {
        await client.connect(
          new StdioClientTransport({
            command: server.command,
            args: server.args,
            stderr: 'pipe',
          }),
        );
        expect(
          (await client.listTools()).tools.map((tool) => tool.name),
        ).toContain('blocked');
        const toolCallId = randomUUID();
        const event = {
          provider: adapter.provider,
          threadId: input.threadId,
          turnId,
          createdAt: new Date().toISOString(),
          toolCallId,
          toolName: `mcp__${server.id}__ping`,
        };
        adapter.events.push({
          ...event,
          eventId: randomUUID(),
          method: 'tool.started',
          arguments: {},
        });
        const response = await client.callTool({ name: 'ping', arguments: {} });
        expect(response).toMatchObject({
          content: [{ text: 'DELIVERY_PING_OK' }],
        });
        adapter.events.push({
          ...event,
          eventId: randomUUID(),
          method: 'tool.completed',
          status: 'success',
          result: response,
        });
        return 'DELIVERY_PING_OK';
      } finally {
        await client.close();
      }
    };
    adapter.deliveryTurn = async (input, turnId) => {
      try {
        return await deliver(input, turnId);
      } catch (error) {
        deliveryErrors.push(error);
        throw error;
      }
    };
    const result = await run({ additionalScenarios: deliveryScenarios });
    expect(deliveryErrors).toEqual([]);
    const row = result.rows.find((entry) => entry.scenario === 'delivery');
    expect(row, JSON.stringify(result.rows)).toMatchObject({
      status: 'unverified',
      delivery: {
        skills: { probe: 'unverified' },
        script: { probe: 'pass' },
        toolServers: { probe: 'pass' },
        disabledTool: { probe: 'pass' },
        nativeToolPolicy: { probe: 'unverified' },
      },
    });
    expect(row?.turns).toHaveLength(2);
    expect(row?.turns[0].storedOutputs).toEqual([
      expect.stringMatching(/^delivery-[a-f0-9]+\.txt$/),
    ]);
    expect(result.rows.some((entry) => entry.status === 'fail')).toBe(false);
    expect(result.plan.plannedTurnCount).toBe(14);
    expect(result.sentTurns).toBe(14);
    expect(
      requests
        .filter(
          (request) =>
            request.path.startsWith('/integrations') ||
            request.path.startsWith('/api/skills') ||
            request.path.startsWith('/agents'),
        )
        .every((request) => request.status! < 300),
    ).toBe(true);
    const deletes = requests.filter((request) => request.method === 'DELETE');
    expect(deletes.map((request) => request.path)).toEqual([
      expect.stringMatching(/^\/agents\/delivery-/),
      expect.stringMatching(/^\/api\/skills\/delivery-/),
      expect.stringMatching(/^\/integrations\/probe/),
    ]);
    expect(deletes.every((request) => request.status === 200)).toBe(true);
    expect(await loader.listIntegrations()).toEqual([]);
    expect(await loader.agentExists(deletes[0].path.split('/').at(-1)!)).toBe(
      false,
    );
    expect(
      skills.listSkills().some((entry) => entry.name.startsWith('delivery-')),
    ).toBe(false);
    expect(
      adapter.starts.filter((start) =>
        String(start.metadata?.agentSlug).startsWith('delivery-'),
      ),
    ).toHaveLength(1);
  });

  test('runs all five scenarios, model switch and recycle with stored outputs and real provenance', async () => {
    const result = await run();

    expect(
      result.rows.map((row: any) => ({
        scenario: row.scenario,
        status: row.status,
        failure: row.failure,
      })),
    ).toEqual(
      expect.arrayContaining(
        ['first', 'follow-up', 'model-switch', 'artifact', 'recycle'].map(
          (scenario) => ({ scenario, status: 'pass', failure: null }),
        ),
      ),
    );
    expect(result.rows).toHaveLength(10);
    expect(result.rows.every((row: any) => row.status === 'pass')).toBe(true);
    expect(adapter.turns).toHaveLength(12);
    expect(
      result.rows
        .filter((row: any) => row.scenario === 'model-switch')
        .map((row: any) => row.turns.map((turn: any) => turn.requestedModel)),
    ).toEqual([
      ['matrix-2', 'matrix-1'],
      ['matrix-1', 'matrix-2'],
    ]);
    expect(
      result.rows
        .filter((row: any) => row.scenario === 'recycle')
        .map((row: any) => row.recycleEvidence),
    ).toEqual(
      Array(2).fill({
        loadedBefore: true,
        loadedAfterStop: false,
        loadedAfterRecall: true,
      }),
    );
    expect(
      result.rows
        .filter((row: any) => row.scenario === 'artifact')
        .every(
          (row: any) =>
            row.turns[0].checks.artifactContent === 'pass' &&
            row.turns[0].storedOutputs.length === 1,
        ),
    ).toBe(true);
    expect(adapter.starts.length).toBeGreaterThan(2);
    expect(
      requests
        .filter((row) => row.method === 'POST')
        .every((row) => row.status === 200),
    ).toBe(true);
    expect(
      requests.some(
        (row) =>
          row.path.endsWith('/commands') &&
          ['startSession', 'sendTurn'].includes(
            (row.body as { type: string }).type,
          ),
      ),
    ).toBe(false);
  });

  test('refuses the CLI billable gate against the real app before any request', async () => {
    await expect(
      exec(
        process.execPath,
        [
          fileURLToPath(
            new URL(
              '../../../../scripts/station-agent-smoke.mjs',
              import.meta.url,
            ),
          ),
          '--matrix',
          `--origin=${origin}`,
          '--connection=matrix-engine',
          `--cwd=${workspace}`,
        ],
        {
          windowsHide: true,
          timeout: 15000,
          maxBuffer: 1024 * 1024,
          env: { ...process.env, STATION_CREDENTIAL: 'matrix-test-credential' },
        },
      ),
    ).rejects.toMatchObject({ code: 2 });
    expect(requests).toEqual([]);
    expect(adapter.turns).toEqual([]);
  });

  test('refuses an over-budget plan before a real engine start', async () => {
    await expect(run({ maxTurns: 11 })).rejects.toThrow('Planned 12 turns');
    expect(adapter.starts).toEqual([]);
    expect(adapter.turns).toEqual([]);
  });

  test('surfaces errors emitted during new-session startup', async () => {
    adapter.startupError = 'New session startup failed';
    const result = await run();
    expect(
      result.rows.some(
        (row: any) =>
          row.status === 'fail' &&
          row.failure.includes('New session startup failed'),
      ),
    ).toBe(true);
  });

  test.each([
    ['wrongFollowup', 'follow-up', 'response', 2],
    ['forgetOnStop', 'recycle', 'response', 4],
    ['wrongContent', 'artifact', 'artifactContent', 3],
    ['failSend', 'first', '409', 1],
  ] as const)(
    'detects %s through real orchestration without retrying a send',
    async (fault, scenario, reason, sends) => {
      adapter[fault] = true;
      const result = await run({ modelIds: ['matrix-1'] });
      expect(
        result.rows.find((row: any) => row.scenario === scenario),
      ).toMatchObject({
        status: 'fail',
        failure: expect.stringContaining(reason),
      });
      expect(adapter.turns).toHaveLength(sends);
    },
  );

  test.each(['missingModel', 'noObserver', 'mismatchedObserver'] as const)(
    'leaves %s unverified through real message projection',
    async (fault) => {
      adapter.missingModel = fault === 'missingModel';
      const result = await run({
        modelIds: ['matrix-1'],
        ...(fault === 'noObserver'
          ? { observeOutputs: undefined }
          : fault === 'mismatchedObserver'
            ? {
                observeOutputs: async () => ({
                  sessionId: 'wrong',
                  turnId: 'wrong',
                  names: [],
                }),
              }
            : {}),
      });
      expect(result.rows[0].status).toBe('unverified');
      expect(result.rows.some((row: any) => row.status === 'fail')).toBe(false);
    },
  );

  test('rejects a substituted reported model projected by the server', async () => {
    adapter.reportedModel = 'different-model';
    const result = await run({ modelIds: ['matrix-1'] });
    expect(result.rows[0]).toMatchObject({
      status: 'fail',
      failure: expect.stringContaining('servedModel'),
    });
    expect(adapter.turns).toHaveLength(1);
  });

  test('compares a Claude-shaped catalog resolution while preserving the launch alias', async () => {
    adapter.catalog = [
      {
        id: 'sonnet',
        name: 'Sonnet',
        originalId: 'sonnet',
        resolvedModel: 'claude-sonnet-4-5',
      },
    ];
    const result = await run();
    expect(result.rows[0].turns[0]).toMatchObject({
      requestedModel: 'sonnet',
      comparisonModel: 'claude-sonnet-4-5',
      reportedModel: 'claude-sonnet-4-5',
      status: 'pass',
    });
    expect(adapter.turns.every((turn) => turn.modelId === 'sonnet')).toBe(true);
  });

  test('leaves an unresolved Claude launch alias unverified', async () => {
    adapter.provider = 'claude';
    adapter.catalog = [
      {
        id: 'sonnet',
        name: 'Sonnet',
        originalId: 'sonnet',
        resolvedModel: undefined,
      },
    ];
    adapter.reportedModel = 'claude-sonnet-4-5';
    const result = await run();
    expect(result.rows[0]).toMatchObject({
      status: 'unverified',
      failure: expect.stringContaining('alias without resolution'),
    });
  });

  test('fails a real turn when the rendered observer includes an extra output', async () => {
    const result = await run({
      modelIds: ['matrix-1'],
      observeOutputs: async ({
        sessionId,
        turnId,
      }: {
        sessionId: string;
        turnId: string;
      }) => ({ sessionId, turnId, names: ['extra.txt'] }),
    });
    expect(result.rows[0]).toMatchObject({
      status: 'fail',
      failure: expect.stringContaining('outputs'),
    });
    expect(adapter.turns).toHaveLength(1);
  });

  test('fails when runtime events report a different serving engine', async () => {
    adapter.eventProvider = 'claude';
    const result = await run({ modelIds: ['matrix-1'] });
    expect(result.rows[0]).toMatchObject({
      status: 'fail',
      failure: expect.stringContaining('servedConnection'),
    });
    expect(adapter.turns).toHaveLength(1);
  });

  test('refuses a second enabled connection before any engine start', async () => {
    connections.push({ ...connection, id: 'other-engine' });
    await expect(run()).rejects.toThrow(
      'only the selected engine connection enabled',
    );
    expect(adapter.starts).toEqual([]);
    expect(adapter.turns).toEqual([]);
  });

  test('records a no-op stop as unverified rather than claiming a recycle', async () => {
    adapter.noOpStop = true;
    const result = await run({ modelIds: ['matrix-1'] });
    expect(
      result.rows.find((row: any) => row.scenario === 'recycle'),
    ).toMatchObject({
      status: 'unverified',
      failure: expect.stringContaining('unload transition'),
      recycleEvidence: { loadedBefore: true, loadedAfterStop: true },
    });
    expect(adapter.turns).toHaveLength(3);
  });

  test.each(['between-turns', 'recycle'] as const)(
    'fails on a session error during %s before another send',
    async (when) => {
      adapter.stopError = when === 'recycle';
      const result = await run({
        modelIds: ['matrix-1'],
        observeOutputs: async ({
          sessionId,
          turnId,
        }: {
          sessionId: string;
          turnId: string;
        }) => {
          if (when === 'between-turns' && adapter.turns.length === 1) {
            const id = adapter.emitError(
              sessionId,
              'Between-turn transport disconnected',
            );
            await vi.waitFor(async () => {
              const events = (
                await api(`/api/orchestration/sessions/${sessionId}/events`)
              ).data;
              expect(
                Array.isArray(events) &&
                  events.some((event) => event.eventId === id),
              ).toBe(true);
            });
          }
          return {
            sessionId,
            turnId,
            names: adapter.rendered.get(turnId) ?? [],
          };
        },
      });
      expect(
        result.rows.find(
          (row: any) =>
            row.scenario === (when === 'recycle' ? 'recycle' : 'follow-up'),
        ),
      ).toMatchObject({
        status: 'fail',
        failure:
          when === 'recycle'
            ? 'Recycle transport disconnected'
            : 'Between-turn transport disconnected',
      });
      expect(adapter.turns).toHaveLength(when === 'recycle' ? 3 : 1);
    },
  );

  test('refuses duplicate scenario ids and unadvertised models before starting', async () => {
    await expect(
      run({ additionalScenarios: [{ id: 'first', run() {} }] }),
    ).rejects.toThrow('Duplicate scenario id');
    await expect(run({ modelIds: ['not-advertised'] })).rejects.toThrow(
      '--model is not advertised',
    );
    expect(adapter.starts).toEqual([]);
  });

  test('keeps the legacy scenario seam and forwards an explicit DELETE to a real route', async () => {
    const result = await run({
      modelIds: ['matrix-1'],
      additionalScenarios: [
        {
          id: 'cleanup',
          async run(ctx: any) {
            await ctx.recall(ctx.model);
            await expect(
              ctx.api(
                `/api/orchestration/conversations/${ctx.conversationId}/context-boundary/no-such-key`,
                undefined,
                'DELETE',
              ),
            ).rejects.toThrow('HTTP 409');
          },
        },
      ],
    });
    expect(
      result.rows.find((row: any) => row.scenario === 'cleanup')?.status,
    ).toBe('pass');
    expect(
      requests
        .filter((request) =>
          request.path.endsWith('/context-boundary/no-such-key'),
        )
        .map((request) => request.method),
    ).toEqual(['DELETE']);
    expect(adapter.turns).toHaveLength(5);
  });

  const cli = async (args: string[], credential = 'matrix-test-credential') => {
    const output = makeTempDir('matrix-reports-');
    const outcome = await exec(
      process.execPath,
      [
        fileURLToPath(
          new URL(
            '../../../../scripts/station-agent-smoke.mjs',
            import.meta.url,
          ),
        ),
        '--matrix',
        '--confirm-billable-engine-matrix',
        `--origin=${origin}`,
        '--connection=matrix-engine',
        `--cwd=${workspace}`,
        `--output-dir=${output}`,
        ...args,
      ],
      {
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, STATION_CREDENTIAL: credential },
      },
    ).then(
      (value) => ({ ...value, code: 0 }),
      (error) => ({
        code: error.code,
        stdout: String(error.stdout),
        stderr: String(error.stderr),
      }),
    );
    return {
      ...outcome,
      files: await Promise.all(
        (await readdir(output)).map((file) =>
          readFile(join(output, file), 'utf8'),
        ),
      ),
    };
  };

  test('prints the plan, restricts the allowlist, writes both reports and redacts an engine-echoed credential', async () => {
    adapter.startupError =
      'Provider echoed matrix-test-credential; context unavailable';
    const outcome = await cli([
      '--model=matrix-1',
      '--model=matrix-1',
      '--max-turns=4',
    ]);
    expect(outcome.code).toBe(1);
    expect(JSON.parse(outcome.stderr)).toMatchObject({
      type: 'engine-matrix-plan',
      modelIds: ['matrix-1'],
      plannedTurnCount: 4,
    });
    expect(JSON.parse(outcome.stdout).rows[0].failure).toBe(
      'Provider echoed [redacted]; context unavailable',
    );
    expect(adapter.turns).toHaveLength(1);
    expect(adapter.turns[0].modelId).toBe('matrix-1');
    expect(outcome.files).toHaveLength(2);
    for (const output of [outcome.stdout, outcome.stderr, ...outcome.files])
      expect(output).not.toContain('matrix-test-credential');
  });

  test('refuses short credentials before any real request', async () => {
    const outcome = await cli([], 'x');
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain(
      'Credential must contain at least 16 characters',
    );
    expect(requests).toEqual([]);
  });

  test.each(['continue', 'steer'] as const)(
    'counts explicit POST methods and query strings for %s against the hard turn budget',
    async (kind) => {
      const result = await run({
        modelIds: ['matrix-1'],
        maxTurns: 5,
        additionalScenarios: [
          {
            id: 'budget-probe',
            maxTurns: 1,
            async run(ctx: any) {
              await ctx.recall(ctx.model);
              await ctx.api(
                kind === 'continue'
                  ? `/api/orchestration/chat/${ctx.conversationId}/continue?probe=1`
                  : '/api/orchestration/commands?probe=1',
                kind === 'continue'
                  ? { message: 'Extra', clientTurnId: randomUUID() }
                  : {
                      type: 'steerTurn',
                      threadId: ctx.sessionId,
                      input: 'Extra',
                    },
                'POST',
              );
            },
          },
        ],
      });
      expect(
        result.rows.find((row: any) => row.scenario === 'budget-probe')
          ?.failure,
      ).toContain('Hard turn ceiling');
      expect(adapter.turns).toHaveLength(5);
      expect(
        requests.some(
          (row) =>
            (row.body as { message?: string; input?: string } | undefined)
              ?.message === 'Extra' ||
            (row.body as { input?: string } | undefined)?.input === 'Extra',
        ),
      ).toBe(false);
    },
  );
});
