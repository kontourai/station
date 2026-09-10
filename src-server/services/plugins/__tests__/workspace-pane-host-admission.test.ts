import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { AgentSpec } from '@kontourai/station-contracts/agent';
import {
  agentId,
  engineConnectionId,
  engineId,
} from '@kontourai/station-contracts/agent-identity';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import type {
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
} from '@kontourai/station-contracts/provider';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import {
  INTERNAL_SESSION_READ_SCOPE,
  sessionReadAuthorityFromRequest,
} from '@kontourai/station-contracts/tenancy';
import { WORKSPACE_PANE_HOST_CONTRIBUTION_VERSION } from '@kontourai/station-contracts/workspace-pane-host-contribution';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';
import { saveAgentConfig } from '../../../domain/config-loader-agents.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import { PLUGIN_AGENT_OWNER_FILE } from '../../../domain/plugin-agent-ownership.js';
import type { ProviderAdapterShape } from '../../../providers/adapter-shape.js';
import { StationAgentAdapter } from '../../../providers/adapters/station-agent-adapter.js';
import { AsyncEventQueue } from '../../../providers/sessions/async-event-queue.js';
import { createChatRoutes } from '../../../routes/chat/chat.js';
import { createWorkspacePaneHostActionRoutes } from '../../../routes/orchestration/workspace-pane-host-actions.js';
import { INTERNAL_NATIVE_WORKSPACE_HEADER } from '../../../runtime/conversation/native-execution-workspace.js';
import { INTERNAL_NATIVE_FOREGROUND_HEADER } from '../../../runtime/conversation/native-foreground-invocation.js';
import type { NativeOutputGrantAuthority } from '../../../runtime/native-output-turn-grant.js';
import { createRuntimeWorkspacePaneHostActions } from '../../../runtime/routes/workspace-pane-host-actions.js';
import {
  createBuiltinVendedTool,
  createBuiltinVendedToolDef,
} from '../../../runtime/tools/vended-tool-compat.js';
import { executeExecutionTargetMessage } from '../../../tools/station-control-delegation.js';
import { getAgentPolicyService } from '../../agents/agent-policy-service.js';
import { EventBus } from '../../orchestration/event-bus.js';
import { EventStore } from '../../orchestration/event-store.js';
import type { ForegroundInvocationAdmission } from '../../orchestration/foreground-invocation-admission.js';
import { OrchestrationService } from '../../orchestration/orchestration-service.js';
import { createSessionAgentResolver } from '../../orchestration/session-agent-resolution.js';
import {
  computePluginContentDigest,
  withPluginContentLock,
} from '../plugin-content-integrity.js';
import {
  prepareLocalPluginDataScope,
  preparePluginIncarnation,
} from '../plugin-incarnation.js';
import { grantPermissions, revokeAllGrants } from '../plugin-permissions.js';
import {
  captureWorkspacePaneHostPackage,
  createWorkspacePaneHostAdmission,
} from '../workspace-pane-host-admission.js';

const pluginId = 'admission-proof';
const slug = agentId('admission-assistant');
const projectSlug = 'project-a';
const spec: AgentSpec = {
  name: 'Captured Assistant',
  prompt: 'The exact authored Agent instructions.',
  execution: { agentConnectionId: engineConnectionId('claude') },
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForEntry(signal: Promise<void>, pending: Promise<unknown>) {
  await Promise.race([
    signal,
    pending.then(() => {
      throw new Error(
        'Invocation settled before reaching the controlled boundary',
      );
    }),
  ]);
}

describe('Workspace Pane host invocation admission', () => {
  let home: string;
  let pluginDir: string;
  let storage: FileStorageAdapter;
  let store: EventStore;
  let service: OrchestrationService;
  let authority: ReturnType<typeof createWorkspacePaneHostAdmission>;
  let adapter: ProviderAdapterShape;
  let nativeAdapter: ProviderAdapterShape | undefined;
  let start: ReturnType<
    typeof vi.fn<(input: ProviderSessionStartInput) => Promise<ProviderSession>>
  >;
  let send: ReturnType<
    typeof vi.fn<
      (
        input: ProviderSendTurnInput,
      ) => Promise<{ threadId: string; turnId: string }>
    >
  >;
  let beforeReady: (() => Promise<void>) | undefined;
  let beforeTurn: (() => Promise<void>) | undefined;
  let counter = 0;
  let ordinaryLookupAllowed = false;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'station-pane-admission-'));
    pluginDir = join(home, 'plugins', pluginId);
    const agentDir = join(home, 'agents', slug);
    mkdirSync(join(pluginDir, 'agents', slug), { recursive: true });
    mkdirSync(join(pluginDir, 'prompts'), { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'agent.json'), JSON.stringify(spec));
    writeFileSync(
      join(pluginDir, 'agents', slug, 'agent.json'),
      JSON.stringify(spec),
    );
    writeFileSync(
      join(agentDir, PLUGIN_AGENT_OWNER_FILE),
      JSON.stringify({ plugin: pluginId }),
    );
    writeFileSync(
      join(pluginDir, 'prompts', 'registered.md'),
      '---\nid: registered\nlabel: Registered label is not the body\n---\nExact registered body.',
    );
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({
        name: pluginId,
        version: '1.0.0',
        agents: [{ slug, source: `./agents/${slug}/agent.json` }],
        prompts: { source: './prompts' },
        workspacePaneHost: {
          version: WORKSPACE_PANE_HOST_CONTRIBUTION_VERSION,
          agentSelection: {
            availableAgents: [{ kind: 'own-plugin-agent', agentId: slug }],
            defaultAgent: { kind: 'own-plugin-agent', agentId: slug },
          },
          actions: [
            {
              id: 'literal',
              label: 'Different literal label',
              presentation: 'action',
              intent: { kind: 'prompt', prompt: `${pluginId}:registered` },
            },
            {
              id: 'registered',
              label: 'Different registered label',
              presentation: 'action',
              intent: { kind: 'plugin-prompt', promptId: 'registered' },
            },
          ],
        },
      }),
    );
    storage = new FileStorageAdapter(home);
    await storage.createProject({
      id: 'project-id-a',
      slug: projectSlug,
      name: 'Project A',
      agents: [slug],
      workingDirectory: home,
      createdAt: '2026-09-04T00:00:00Z',
      updatedAt: '2026-09-04T00:00:00Z',
    });
    store = new EventStore(join(home, 'orchestration.sqlite'));
    authority = createWorkspacePaneHostAdmission({
      projectHomeDir: home,
      projects: storage,
      journal: store.createPackageMcpAdmissionJournal(),
    });
    const sessions = new Map<string, ProviderSession>();
    const events = new AsyncEventQueue<CanonicalRuntimeEvent>();
    start = vi.fn(async (input) => {
      const now = new Date().toISOString();
      events.push({
        eventId: `${input.threadId}:started`,
        provider: 'claude',
        threadId: input.threadId,
        method: 'session.started',
        sessionId: input.threadId,
        createdAt: now,
        metadata: input.metadata,
      });
      const session: ProviderSession = {
        provider: 'claude',
        threadId: input.threadId,
        cwd: input.cwd,
        status: 'ready',
        createdAt: now,
        updatedAt: now,
      };
      sessions.set(session.threadId, session);
      return session;
    });
    send = vi.fn(async (input) => {
      const turnId = `turn-${++counter}`;
      events.push({
        eventId: `${turnId}:start`,
        provider: 'claude',
        threadId: input.threadId,
        turnId,
        method: 'turn.started',
        createdAt: new Date().toISOString(),
        prompt: input.displayInput ?? input.input,
      });
      return { threadId: input.threadId, turnId };
    });
    adapter = {
      provider: 'claude',
      metadata: {
        engineId: engineId('claude'),
        displayName: 'Controlled provider',
        description: 'No live account',
        builtin: true,
        capabilities: ['agent-runtime'],
        modelLaunch: {
          defaultAtStart: 'engine-selected',
          omissionAtResume: 'engine-selected',
          omissionPerTurn: 'engine-selected',
          overrideAtStart: false,
          overrideAtResume: false,
          overridePerTurn: false,
        },
      },
      startSession: start,
      sendTurn: send,
      stopSession: async (id) => {
        sessions.delete(id);
      },
      stopAll: async () => {
        sessions.clear();
      },
      hasSession: async (id) => sessions.has(id),
      listSessions: async () => [...sessions.values()],
      streamEvents: (options) => events.iterable(options),
      getPrerequisites: async () => {
        await beforeReady?.();
        return [];
      },
      interruptTurn: async () => ({ outcome: 'no-active-turn' }),
      steerTurn: async () => {},
      respondToRequest: async () => {},
    };
    nativeAdapter = undefined;
    service = new OrchestrationService({
      adapterRegistry: {
        register: () => {},
        get: (id) =>
          id === 'claude'
            ? adapter
            : id === 'station-agent'
              ? nativeAdapter
              : undefined,
        list: () => [adapter, ...(nativeAdapter ? [nativeAdapter] : [])],
      },
      eventBus: new EventBus(),
      eventStore: store,
      adoptionLedger: store.createAdoptionLedger(),
      resolveSessionAgent: createSessionAgentResolver({
        loadAgentSpec: async () => {
          throw new Error('Must consume captured Agent, not reread');
        },
        resolveToolServer: async () => null,
        resolveSkillDir: async () => null,
      }),
      loadAgentExecutionConfig: async () => {
        if (ordinaryLookupAllowed)
          return JSON.parse(
            readFileSync(join(home, 'agents', slug, 'agent.json'), 'utf8'),
          ).execution;
        throw new Error('Must consume captured execution, not reread');
      },
      loadAgentPresentation: async () => {
        if (ordinaryLookupAllowed)
          return JSON.parse(
            readFileSync(join(home, 'agents', slug, 'agent.json'), 'utf8'),
          );
        throw new Error('Must consume captured presentation, not reread');
      },
      listProjects: () => [storage.projectRevision(projectSlug).value],
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    ordinaryLookupAllowed = false;
    beforeReady = undefined;
    beforeTurn = undefined;
  });

  afterEach(async () => {
    await service?.shutdown();
    store?.close();
    rmSync(home, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  test('real host HTTP action uses production foreground composition and exact provider receipt once', async () => {
    vi.stubEnv('STATION_API_BASE', 'http://pane-host.test');
    vi.stubEnv('STATION_INTERNAL_API_TOKEN', 'pane-host-fixture-token');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input);
        const data = url.endsWith('/.well-known/station/v1')
          ? { environmentId: 'environment-current' }
          : url.endsWith('/api/connections/claude')
            ? {
                success: true,
                data: {
                  id: 'claude',
                  kind: 'agent',
                  type: 'claude',
                  enabled: true,
                  status: 'ready',
                  capabilities: ['agent-runtime'],
                  config: { provider: 'claude' },
                },
              }
            : undefined;
        if (!data) throw new Error(`Unexpected fixture request ${url}`);
        return new Response(JSON.stringify(data), {
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
    await grantPermissions(home, pluginId, ['agents.invoke']);
    const principal = humanPrincipal('test', 'pane-owner', 'Pane owner');
    const actor = {
      principal,
      isCurrent: () => true,
      readAuthority: sessionReadAuthorityFromRequest(
        principal.id,
        undefined,
        undefined,
      ),
    };
    const actions = createRuntimeWorkspacePaneHostActions({
      projectHomeDir: home,
      projects: storage,
      orchestration: service,
      journal: store.createPackageMcpAdmissionJournal(),
      getConnection: async (id) => ({
        id,
        name: 'Controlled connection',
        kind: 'agent',
        type: 'claude',
        enabled: true,
        status: 'ready',
        capabilities: ['agent-runtime'],
        config: { provider: 'claude' },
        prerequisites: [],
      }),
    });
    const app = createWorkspacePaneHostActionRoutes({
      service: actions,
      actorFor: () => actor,
    });
    const catalog = await readJson(
      await app.request(`/${projectSlug}/catalog`),
    );
    const projection = catalog.data.contributions[0].projection;
    const preparation = await readJson(
      await app.request(`/${projectSlug}/prepare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...projection.owner,
          actionKey: projection.actions.find(
            (action: { id: string }) => action.id === 'registered',
          ).key,
        }),
      }),
    );
    expect(preparation.data.state).toBe('prepared');
    const execute = () =>
      app.request(`/${projectSlug}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticket: preparation.data.ticket }),
      });
    const [first, second] = await Promise.all([execute(), execute()]);
    const result = (await readJson(first)).data;
    expect(result).toMatchObject({ state: 'accepted' });
    expect((await readJson(second)).data).toEqual({ state: 'indeterminate' });
    expect(start).toHaveBeenCalledOnce();
    expect(start.mock.calls[0]![0]).toMatchObject({
      agent: { slug, systemPrompt: spec.prompt },
      metadata: { agentSlug: slug, projectSlug, userId: principal.id },
    });
    expect(send).toHaveBeenCalledOnce();
    expect(
      send.mock.calls[0]![0].displayInput ?? send.mock.calls[0]![0].input,
    ).toBe('Exact registered body.');
    await expect
      .poll(async () =>
        (
          await service.readSession(
            result.sessionId,
            INTERNAL_SESSION_READ_SCOPE,
          )
        )?.events.some(
          (event) =>
            event.method === 'turn.started' && event.turnId === result.turnId,
        ),
      )
      .toBe(true);
  });

  async function nativeHostProof(
    options: {
      beforeModel?: () => Promise<void>;
      inModel?: () => Promise<void>;
      retainArtifact?: boolean;
      portable?: boolean;
      dropCompanionMarker?: boolean;
      dropWorkspaceMarker?: boolean;
      waitForModel?: Promise<void>;
    } = {},
  ) {
    const nativeSpec: AgentSpec = {
      name: 'Native captured assistant',
      prompt: 'Keep these native instructions.',
      model: 'controlled-native-model',
    };
    writeFileSync(
      join(home, 'agents', slug, 'agent.json'),
      JSON.stringify(nativeSpec),
    );
    writeFileSync(
      join(pluginDir, 'agents', slug, 'agent.json'),
      JSON.stringify(nativeSpec),
    );
    if (options.portable) {
      const legacy = JSON.parse(
        readFileSync(join(pluginDir, 'plugin.json'), 'utf8'),
      );
      writeFileSync(
        join(pluginDir, 'plugin.json'),
        JSON.stringify({
          $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
          name: legacy.name,
          version: legacy.version,
          extensions: {
            'io.kontourai.station': {
              schemaVersion: '1.0',
              agents: legacy.agents,
              prompts: legacy.prompts,
              workspacePaneHost: legacy.workspacePaneHost,
            },
          },
        }),
      );
    }
    let retained:
      | ReturnType<
          ReturnType<
            EventStore['createPackageMcpAdmissionJournal']
          >['currentInstallation']
        >
      | undefined;
    if (options.retainArtifact) {
      const source = join(home, 'staged-source');
      renameSync(pluginDir, source);
      const plugins = join(home, 'plugins');
      const dataScope = prepareLocalPluginDataScope(
        plugins,
        pluginId,
        null,
        'preserve',
      );
      const root = preparePluginIncarnation(
        plugins,
        pluginId,
        source,
        dataScope,
      ).captured;
      const journal = store.createPackageMcpAdmissionJournal();
      expect(
        journal.recordInstallation({
          pluginId,
          previous: null,
          materialization: root.generation!,
          dataScope,
          contentDigest: computePluginContentDigest(
            dirname(root.packageRoot),
            basename(root.packageRoot),
          )!,
        }).state,
      ).toBe('recorded');
      retained = journal.currentInstallation(pluginId);
      // Deliberately do not publish the compatibility alias: it is not authority.
    }
    await grantPermissions(
      home,
      pluginId,
      ['agents.invoke'],
      captureWorkspacePaneHostPackage(
        home,
        pluginId,
        store.createPackageMcpAdmissionJournal(),
      ),
    );
    vi.stubEnv('STATION_API_BASE', 'http://pane-native.test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: Parameters<typeof fetch>[0]) => {
        const path = new URL(String(url)).pathname;
        if (path === `/api/agents/${slug}`)
          return Response.json({
            success: true,
            data: { ...nativeSpec, slug },
          });
        if (path.startsWith('/api/projects/'))
          return Response.json({
            success: true,
            data: storage.projectRevision(path.slice('/api/projects/'.length))
              .value,
          });
        if (!String(url).endsWith('/.well-known/station/v1'))
          throw new Error(`Unexpected native proof network request: ${path}`);
        return new Response(
          JSON.stringify({ environmentId: 'environment-current' }),
        );
      }),
    );
    const streamText = vi.fn(
      async (_input: unknown, _context: Record<string, unknown>) => {
        await options.inModel?.();
        await options.waitForModel;
        return {
          fullStream: (async function* () {
            yield { type: 'text-delta', text: 'Controlled native answer.' };
            yield { type: 'finish', finishReason: 'stop' };
          })(),
          text: Promise.resolve('Controlled native answer.'),
          usage: Promise.resolve(undefined),
          finishReason: Promise.resolve('stop'),
        };
      },
    );
    const activeAgent = {
      getMemory: () => null,
      streamText,
      model: { modelId: 'controlled-native-model' },
    };
    let beforeModelCalled = false;
    const memory = {
      getConversation: async () => {
        if (!beforeModelCalled) {
          beforeModelCalled = true;
          await options.beforeModel?.();
        }
        return { id: 'native-proof', title: 'Native proof' };
      },
      createConversation: async () => {},
      addMessage: async () => {},
      updateConversation: async () => {},
      getMessages: async () => [],
      getConversations: async () => [],
    };
    const ctx = {
      activeAgents: new Map([[slug, activeAgent]]),
      agentSpecs: new Map([[slug, nativeSpec]]),
      storageAdapter: storage,
      appConfig: {},
      configLoader: {
        getProjectHomeDir: () => home,
        getLaunchabilityRevision: () => 0,
      },
      providerService: {
        getLaunchabilityRevision: () => 0,
        listProviderConnections: () => [],
      },
      knowledgeService: {
        getInjectContext: async () => null,
        getRAGContextDetailed: async () => null,
      },
      feedbackService: {
        getRatings: () => [],
        getBehaviorGuidelinesDetailed: () => null,
      },
      getAgentConfigurationRevision: () => 0,
      commitAgentConfigurationRead: async (
        _revision: number,
        operation: () => Promise<unknown>,
      ) => operation(),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      toolNameMapping: new Map(),
      approvalRegistry: {},
      agentHooksMap: new Map(),
      memoryAdapters: new Map([[slug, memory]]),
      agentStatus: new Map(),
      agentStats: new Map(),
      agentTools: new Map(),
      metricsLog: [],
      orchestrationEventStore: store,
    };
    const chat = createChatRoutes(ctx as never);
    nativeAdapter = new StationAgentAdapter({
      apiBase: 'http://pane-native.test',
      hasAgent: () => true,
      approvalRegistry: { has: () => false, resolve: () => false } as never,
      eventBus: new EventBus(),
      fetch: async (url, init) => {
        const headers = new Headers(init?.headers);
        if (options.dropCompanionMarker)
          headers.delete(INTERNAL_NATIVE_FOREGROUND_HEADER);
        if (options.dropWorkspaceMarker)
          headers.delete(INTERNAL_NATIVE_WORKSPACE_HEADER);
        return chat.request(
          new URL(String(url)).pathname.replace('/api/agents', ''),
          { ...init, headers },
        );
      },
    });
    const principal = humanPrincipal('test', 'native-owner', 'Native owner');
    const actor = {
      principal,
      isCurrent: () => true,
      readAuthority: sessionReadAuthorityFromRequest(
        principal.id,
        undefined,
        undefined,
      ),
    };
    const actions = createRuntimeWorkspacePaneHostActions({
      projectHomeDir: home,
      projects: storage,
      orchestration: service,
      journal: store.createPackageMcpAdmissionJournal(),
      getConnection: async () => null,
      nativeAgentAvailable: () => true,
    });
    const app = createWorkspacePaneHostActionRoutes({
      service: actions,
      actorFor: () => actor,
    });
    const catalog = await readJson(
      await app.request(`/${projectSlug}/catalog`),
    );
    const projection = catalog.data.contributions[0].projection;
    const prepared = await readJson(
      await app.request(`/${projectSlug}/prepare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...projection.owner,
          actionKey: projection.actions.find(
            (action: { id: string }) => action.id === 'registered',
          ).key,
        }),
      }),
    );
    expect(prepared.data.state).toBe('prepared');
    return {
      actor,
      retained,
      streamText,
      ctx,
      provenance: { ...projection.owner, actionId: 'registered' },
      execute: async () =>
        (
          await readJson(
            await app.request(`/${projectSlug}/execute`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ticket: prepared.data.ticket }),
            }),
          )
        ).data,
    };
  }

  test('native action resolves journal-selected artifact without an alias and stamps its admission generation', async () => {
    const proof = await nativeHostProof({ retainArtifact: true });
    expect(proof.retained?.state).toBe('observed');
    if (proof.retained?.state !== 'observed')
      throw new Error('fixture installation absent');
    expect(proof.provenance.installationGeneration).toBe(
      proof.retained.installation.incarnation,
    );
    expect(proof.provenance.installationGeneration).not.toBe(
      proof.retained.installation.contentDigest,
    );
    const result = await proof.execute();
    expect(result.state).toBe('accepted');
    expect(proof.streamText).toHaveBeenCalledOnce();
  });

  test('portable Station namespace host declaration reaches the canonical native HTTP execution bridge', async () => {
    const proof = await nativeHostProof({
      retainArtifact: true,
      portable: true,
    });
    const result = await proof.execute();
    expect(result.state).toBe('accepted');
    expect(proof.streamText).toHaveBeenCalledOnce();
    expect(proof.streamText.mock.calls[0]?.[0]).toContain(
      'Exact registered body.',
    );
  });

  test('journal retirement fences a prepared native action even while artifact bytes remain', async () => {
    const proof = await nativeHostProof({ retainArtifact: true });
    if (proof.retained?.state !== 'observed')
      throw new Error('fixture installation absent');
    const permissionArtifact = captureWorkspacePaneHostPackage(
      home,
      pluginId,
      store.createPackageMcpAdmissionJournal(),
    );
    await expect(
      grantPermissions(
        home,
        'other-plugin',
        ['agents.invoke'],
        permissionArtifact,
      ),
    ).rejects.toThrow();
    expect(
      store
        .createPackageMcpAdmissionJournal()
        .requestRetirement(proof.retained.installation).state,
    ).toBe('fenced');
    expect((await proof.execute()).state).toBe('unavailable');
    expect(proof.streamText).not.toHaveBeenCalled();
    await expect(
      grantPermissions(home, pluginId, ['agents.invoke'], permissionArtifact),
    ).rejects.toThrow();
  });

  test('captured native action reaches existing native model once and releases grants before settlement', async () => {
    const settled = deferred();
    const proof = await nativeHostProof({ waitForModel: settled.promise });
    try {
      const result = await proof.execute();
      expect(result).toMatchObject({ state: 'accepted' });
      expect(proof.streamText).toHaveBeenCalledOnce();
      expect(proof.streamText).toHaveBeenCalledWith(
        expect.stringContaining('Exact registered body.'),
        expect.objectContaining({
          userId: humanPrincipal('test', 'native-owner', 'Native owner').id,
        }),
      );
      await revokeAllGrants(home, pluginId);
      settled.resolve();
      await expect
        .poll(async () =>
          (
            await service.readSession(
              result.sessionId,
              INTERNAL_SESSION_READ_SCOPE,
            )
          )?.events.some(
            (event) =>
              event.method === 'turn.completed' &&
              event.turnId === result.turnId,
          ),
        )
        .toBe(true);
      expect((await proof.execute()).state).toBe('indeterminate');
      expect(proof.streamText).toHaveBeenCalledOnce();
      rmSync(pluginDir, { recursive: true, force: true });
      const archived = await service.readSession(
        result.sessionId,
        INTERNAL_SESSION_READ_SCOPE,
      );
      expect(archived?.session.lifecycleState).toBe('completed');
      expect(
        archived?.events.find((event) => event.method === 'session.started')
          ?.metadata?.workspacePaneHostAction,
      ).toEqual(proof.provenance);
      expect(store.listCommandReceipts(result.sessionId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            commandType: 'startSession',
            status: 'accepted',
          }),
          expect.objectContaining({
            commandType: 'sendTurn',
            status: 'accepted',
          }),
        ]),
      );
    } finally {
      settled.resolve();
    }
  });

  test.each([
    'agent-edit',
    'permission-revocation',
    'runtime-replacement',
    'stripped-companion',
  ] as const)(
    'native final provider admission refuses %s without ambient fallback',
    async (change) => {
      let proof: Awaited<ReturnType<typeof nativeHostProof>>;
      proof = await nativeHostProof({
        dropCompanionMarker: change === 'stripped-companion',
        beforeModel: async () => {
          if (change === 'agent-edit')
            await saveAgentConfig(home, slug, {
              name: 'Changed',
              prompt: 'Replacement native instructions.',
            });
          if (change === 'permission-revocation')
            await revokeAllGrants(home, pluginId);
          if (change === 'runtime-replacement')
            proof.ctx.activeAgents.set(slug, {
              ...proof.ctx.activeAgents.get(slug)!,
              streamText: vi.fn(),
            });
        },
      });
      expect((await proof.execute()).state).not.toBe('accepted');
      expect(proof.streamText).not.toHaveBeenCalled();
    },
  );

  async function dispatch(admission: ForegroundInvocationAdmission) {
    const threadId = `pane-thread-${++counter}`;
    const started = await service.startSessionInternal(
      {
        type: 'start-session',
        input: {
          provider: 'claude',
          threadId,
          cwd: home,
          metadata: {
            agentSlug: admission.agentId,
            projectSlug: admission.project.slug,
            userId: 'owner',
          },
        },
      },
      { userId: 'owner' },
      { foregroundInvocationAdmission: admission },
    );
    if (started.status !== 'accepted') throw new Error(started.message);
    await beforeTurn?.();
    const turn = await service.dispatchWithReceipt(
      {
        type: 'sendTurn',
        input: {
          threadId,
          input: admission.message,
          clientTurnId: `client-${threadId}`,
        },
      },
      { userId: 'owner' },
      { foregroundInvocationAdmission: admission },
    );
    return { threadId, started, turn };
  }

  async function prepare(actionId = 'literal') {
    return authority.prepare({ pluginId, projectSlug, actionId });
  }

  test.each([
    ['literal', `${pluginId}:registered`],
    ['registered', 'Exact registered body.'],
  ])(
    'dispatches %s exact body through real Session and turn owners',
    async (actionId, body) => {
      const result = await (await prepare(actionId)).run(dispatch);
      expect(start).toHaveBeenCalledOnce();
      expect(start.mock.calls[0]![0]).toMatchObject({
        metadata: { agentSlug: slug, projectSlug },
        agent: { slug, systemPrompt: spec.prompt },
      });
      expect(send).toHaveBeenCalledOnce();
      expect(
        send.mock.calls[0]![0].displayInput ?? send.mock.calls[0]![0].input,
      ).toBe(body);
      expect(
        store.readCommandReceipt(result.started.receipt.commandId)?.status,
      ).toBe('accepted');
      expect(
        store.readCommandReceipt(result.turn.receipt.commandId)?.status,
      ).toBe('accepted');
      await expect
        .poll(async () =>
          (
            await service.readSession(
              result.threadId,
              INTERNAL_SESSION_READ_SCOPE,
            )
          )?.events.some(
            (event) => event.method === 'turn.started' && event.prompt === body,
          ),
        )
        .toBe(true);
    },
  );

  test('refuses changed Project policy after pending start resolution, before provider invocation', async () => {
    const entered = deferred();
    const release = deferred();
    beforeReady = async () => {
      entered.resolve();
      await release.promise;
    };
    const pending = (await prepare()).run(dispatch);
    await waitForEntry(entered.promise, pending);
    const revision = storage.projectRevision(projectSlug);
    await revision.replace({ ...revision.value, agents: [] });
    release.resolve();
    await expect(pending).rejects.toThrow();
    expect(start).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  test('refuses an Agent edit between preparation and actual start', async () => {
    const prepared = await prepare();
    await saveAgentConfig(home, slug, {
      ...spec,
      prompt: 'Changed instructions',
    });
    await expect(prepared.run(dispatch)).rejects.toThrow();
    expect(start).not.toHaveBeenCalled();
  });

  test('refuses policy loss after accepted Session start but before the first turn', async () => {
    beforeTurn = async () => {
      const revision = storage.projectRevision(projectSlug);
      await revision.replace({ ...revision.value, agents: [] });
    };
    await expect((await prepare()).run(dispatch)).rejects.toThrow();
    expect(start).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });

  test('refuses a reentrant installed-body mutation between start and turn despite the outer content lease', async () => {
    beforeTurn = async () =>
      withPluginContentLock(join(home, 'plugins'), pluginId, async () => {
        writeFileSync(
          join(pluginDir, 'prompts', 'registered.md'),
          'New registered body',
        );
      });
    await expect((await prepare('registered')).run(dispatch)).rejects.toThrow();
    expect(start).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });

  test('does not let consumers mutate captured Agent or Project inputs', async () => {
    await (await prepare()).run(async (admission) => {
      admission.agentSpec.prompt = 'Caller replacement';
      admission.project.agents = [];
      return dispatch(admission);
    });
    expect(start.mock.calls[0]![0].agent?.systemPrompt).toBe(spec.prompt);
  });

  test('Project revision admission does not trust the mutable value handed to its caller', async () => {
    const revision = storage.projectRevision(projectSlug);
    revision.value.agents = [];
    await revision.withCurrentRead!(async (current) => {
      expect(current.agents).toEqual([slug]);
    });
  });

  test('refuses changed installed body and a foreign Agent owner', async () => {
    const prepared = await prepare('registered');
    await withPluginContentLock(join(home, 'plugins'), pluginId, async () => {
      writeFileSync(
        join(pluginDir, 'prompts', 'registered.md'),
        'Replacement body',
      );
    });
    await expect(prepared.run(dispatch)).rejects.toThrow();
    expect(start).not.toHaveBeenCalled();
    writeFileSync(
      join(home, 'agents', slug, PLUGIN_AGENT_OWNER_FILE),
      JSON.stringify({ plugin: 'another-plugin' }),
    );
    await expect(prepare()).rejects.toThrow();
  });

  test('retains an already-invoked turn when policy changes during provider settlement and never replays', async () => {
    const entered = deferred();
    const release = deferred();
    send.mockImplementation(async (input) => {
      entered.resolve();
      await release.promise;
      return {
        threadId: input.threadId,
        turnId: 'accepted-after-policy-change',
      };
    });
    const prepared = await prepare();
    const pending = prepared.run(dispatch);
    await waitForEntry(entered.promise, pending);
    const revision = storage.projectRevision(projectSlug);
    // Must not wait for provider settlement: the short Project/Agent guards
    // release once invocation begins, not when the remote Promise resolves.
    await revision.replace({ ...revision.value, agents: [] });
    release.resolve();
    const result = await pending;
    expect(result.turn.result).toMatchObject({
      turnId: 'accepted-after-policy-change',
    });
    await expect(prepared.run(dispatch)).rejects.toThrow();
    expect(send).toHaveBeenCalledOnce();
  });

  test('retains unknown provider effect instead of relabeling policy change as cancellation', async () => {
    const entered = deferred();
    const release = deferred();
    send.mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      throw new Error('Provider response lost after invocation');
    });
    const prepared = await prepare();
    const pending = prepared.run(dispatch);
    await waitForEntry(entered.promise, pending);
    const revision = storage.projectRevision(projectSlug);
    await revision.replace({ ...revision.value, agents: [] });
    release.resolve();
    await expect(pending).rejects.toThrow();
    const threadId = send.mock.calls[0]![0].threadId;
    expect(
      store.sessionTurnBoundaryAuthority().hasPossibleEffect(threadId),
    ).toEqual({ kind: 'available', active: true });
    await expect(prepared.run(dispatch)).rejects.toThrow();
    expect(send).toHaveBeenCalledOnce();
  });

  test('rejects policy mutation during the final coordinated pre-invocation read', async () => {
    const entered = deferred();
    const release = deferred();
    const read = service.readSession.bind(service);
    let turnReads = 0;
    vi.spyOn(service, 'readSession').mockImplementation(async (...args) => {
      const result = await read(...args);
      if (++turnReads === 2) {
        entered.resolve();
        await release.promise;
      }
      return result;
    });
    const pending = (await prepare()).run(dispatch);
    await waitForEntry(entered.promise, pending);
    const revision = storage.projectRevision(projectSlug);
    await revision.replace({ ...revision.value, agents: [] });
    release.resolve();
    await expect(pending).rejects.toThrow();
    expect(start).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });

  test('never mutates persisted declarations or substitutes first required/ambient Agents', async () => {
    const path = join(pluginDir, 'plugin.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    delete manifest.workspacePaneHost.agentSelection.defaultAgent;
    writeFileSync(path, JSON.stringify(manifest));
    await expect(prepare()).rejects.toThrow();
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(manifest);
    expect(start).not.toHaveBeenCalled();
  });

  test('maps malformed installed source to the bounded unavailable contract', async () => {
    writeFileSync(join(pluginDir, 'plugin.json'), '{not json');
    await expect(prepare()).rejects.toMatchObject({
      code: 'foreground_invocation_unavailable',
      message:
        'The captured Workspace Pane action is unavailable or changed before invocation.',
    });
  });

  test('a changed Project refuses captured provisioning before the Git effect', async () => {
    const revision = storage.projectRevision(projectSlug);
    await revision.replace({
      ...revision.value,
      defaultWorkspaceIsolation: 'worktree',
    });
    const prepared = await prepare();
    const changed = storage.projectRevision(projectSlug);
    await changed.replace({ ...changed.value, name: 'Changed after capture' });
    const provision = vi.fn(async () => ({
      path: join(home, 'never-created'),
    }));
    await expect(
      prepared.run((admission) =>
        admission.invoke(
          'provision',
          {
            threadId: 'worktree-thread',
            agentId: slug,
            projectSlug,
          },
          provision,
        ),
      ),
    ).rejects.toThrow();
    expect(provision).not.toHaveBeenCalled();
  });

  test('provisioned workspace admission refuses another Session or CWD and cannot start twice', async () => {
    const revision = storage.projectRevision(projectSlug);
    await revision.replace({
      ...revision.value,
      defaultWorkspaceIsolation: 'worktree',
    });
    const prepared = await prepare();
    const effect = vi.fn(async () => undefined);
    await prepared.run(async (admission) => {
      const actual = {
        threadId: 'captured-thread',
        agentId: slug,
        projectSlug,
      };
      const cwd = join(home, 'owned-worktree');
      await admission.invoke('provision', actual, async () => ({ path: cwd }));
      await expect(
        admission.invoke(
          'start',
          { ...actual, threadId: 'other', cwd },
          effect,
        ),
      ).rejects.toThrow();
      await expect(
        admission.invoke('start', { ...actual, cwd: home }, effect),
      ).rejects.toThrow();
      expect(effect).not.toHaveBeenCalled();
      await admission.invoke('start', { ...actual, cwd }, effect);
      await expect(
        admission.invoke('start', { ...actual, cwd }, effect),
      ).rejects.toThrow();
      expect(effect).toHaveBeenCalledOnce();
    });
  });

  test('pending provisioning cannot admit an early start in the shared Project directory', async () => {
    const revision = storage.projectRevision(projectSlug);
    await revision.replace({
      ...revision.value,
      defaultWorkspaceIsolation: 'worktree',
    });
    const prepared = await prepare();
    const pending = deferred();
    const entered = deferred();
    const startEffect = vi.fn(async () => undefined);
    await prepared.run(async (admission) => {
      const actual = { threadId: 'pending-thread', agentId: slug, projectSlug };
      const provisioning = admission.invoke('provision', actual, async () => {
        entered.resolve();
        await pending.promise;
        return { path: join(home, 'created-worktree') };
      });
      await entered.promise;
      try {
        await expect(
          admission.invoke('start', { ...actual, cwd: home }, startEffect),
        ).rejects.toThrow();
        expect(startEffect).not.toHaveBeenCalled();
      } finally {
        pending.resolve();
        await provisioning;
      }
    });
  });

  test('native worktree action and ordinary child continuation keep real Bash in the owned workspace without output grants', async () => {
    const repo = join(home, 'repository');
    mkdirSync(repo);
    execFileSync('git', ['init', '--quiet', repo], { windowsHide: true });
    execFileSync(
      'git',
      [
        '-C',
        repo,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        'commit',
        '--allow-empty',
        '-m',
        'fixture',
      ],
      { windowsHide: true },
    );
    const revision = storage.projectRevision(projectSlug);
    await revision.replace({
      ...revision.value,
      workingDirectory: repo,
      defaultWorkspaceIsolation: 'worktree',
    });
    const bash = createBuiltinVendedTool(
      slug,
      createBuiltinVendedToolDef('bash')!,
    )!;
    const observed: unknown[] = [];
    const proofOptions = {
      dropWorkspaceMarker: false,
      inModel: async () => {
        observed.push(
          await bash.execute({ mode: 'execute', command: 'pwd -P' }),
        );
      },
    };
    const proof = await nativeHostProof(proofOptions);
    const result = await proof.execute();
    expect(result.state).toBe('accepted');
    await expect.poll(() => observed.length).toBe(1);
    const session = await service.readSession(
      result.sessionId,
      INTERNAL_SESSION_READ_SCOPE,
    );
    expect(session?.session.cwd).not.toBe(repo);
    expect(observed[0]).toMatchObject({
      output: realpathSync(session!.session.cwd!),
    });
    expect(session?.session.cwd).toContain('repository-worktrees');
    await expect
      .poll(
        async () =>
          (
            await service.readSession(
              result.sessionId,
              INTERNAL_SESSION_READ_SCOPE,
            )
          )?.session.lifecycleState,
      )
      .toBe('completed');
    const forged = await service.sessionCommands.execute(
      {
        type: 'start-session',
        input: {
          provider: 'station-agent',
          threadId: 'forged-public-worktree',
          cwd: session!.session.cwd,
          metadata: {
            agentId: slug,
            agentSlug: slug,
            projectSlug,
            userId: proof.actor.principal.id,
            workspaceIsolation: { mode: 'worktree' },
            worktree: {
              mode: 'worktree',
              path: session!.session.cwd,
              repoPath: repo,
            },
            executionWorkspace: {
              threadId: 'forged-public-worktree',
              projectSlug,
              cwd: session!.session.cwd,
            },
          },
        },
      },
      { userId: proof.actor.principal.id },
    );
    expect(forged.status).not.toBe('accepted');
    expect('message' in forged ? forged.message : '').toContain(
      'outside project',
    );
    expect(proof.streamText).toHaveBeenCalledOnce();
    ordinaryLookupAllowed = true;
    await storage.createProject({
      ...storage.projectRevision(projectSlug).value,
      id: 'project-b-id',
      slug: 'project-b',
      name: 'Same repository, different Project',
    });
    await expect(
      executeExecutionTargetMessage(
        {
          conversationId: result.conversationId,
          target: {
            environment: { kind: 'current' },
            agent: slug,
            workspace: { kind: 'project', projectSlug: 'project-b' },
          },
          message: 'Must not cross Project identity.',
          userId: proof.actor.principal.id,
          principal: proof.actor.principal,
          readAuthority: proof.actor.readAuthority,
        },
        service,
      ),
    ).rejects.toMatchObject({
      code: 'continuation_workspace_different_project',
    });
    expect(proof.streamText).toHaveBeenCalledOnce();
    expect(service.currentConversationSessionId(result.conversationId)).toBe(
      result.sessionId,
    );
    const registeredBefore = execFileSync(
      'git',
      ['-C', repo, 'worktree', 'list', '--porcelain'],
      { windowsHide: true, encoding: 'utf8' },
    );
    // Output declaration can be disabled/exhausted without changing location.
    const outputAuthority = Reflect.get(
      service,
      'nativeOutputGrants',
    ) as NativeOutputGrantAuthority;
    const steering = vi.spyOn(getAgentPolicyService(), 'steeringContext');
    const optionalGrant = vi
      .spyOn(outputAuthority, 'issue')
      .mockReturnValue(null);
    try {
      const continued = await executeExecutionTargetMessage(
        {
          conversationId: result.conversationId,
          target: {
            environment: { kind: 'current' },
            agent: slug,
            workspace: { kind: 'project', projectSlug },
          },
          message: 'Continue in the same workspace.',
          userId: proof.actor.principal.id,
          principal: proof.actor.principal,
          readAuthority: proof.actor.readAuthority,
        },
        service,
      );
      await expect.poll(() => observed.length).toBe(2);
      expect(continued.sessionId).not.toBe(result.sessionId);
      expect(
        (
          await service.readSession(
            continued.sessionId,
            INTERNAL_SESSION_READ_SCOPE,
          )
        )?.session.cwd,
      ).toBe(session!.session.cwd);
      expect(observed[1]).toMatchObject({
        output: realpathSync(session!.session.cwd!),
      });
      expect(
        execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], {
          windowsHide: true,
          encoding: 'utf8',
        }),
      ).toBe(registeredBefore);
      expect(optionalGrant).toHaveBeenCalled();
      expect(steering.mock.calls.at(-1)?.[0].cwd).toBe(session!.session.cwd);
      await expect
        .poll(
          async () =>
            (
              await service.readSession(
                continued.sessionId,
                INTERNAL_SESSION_READ_SCOPE,
              )
            )?.session.lifecycleState,
        )
        .toBe('completed');
      const third = await executeExecutionTargetMessage(
        {
          conversationId: result.conversationId,
          target: {
            environment: { kind: 'current' },
            agent: slug,
            workspace: { kind: 'project', projectSlug },
          },
          message: 'Third turn in the original owned worktree.',
          userId: proof.actor.principal.id,
          principal: proof.actor.principal,
          readAuthority: proof.actor.readAuthority,
        },
        service,
      );
      await expect.poll(() => observed.length).toBe(3);
      expect(third.sessionId).not.toBe(continued.sessionId);
      expect(third.sessionId).not.toBe(result.sessionId);
      expect(observed[2]).toMatchObject({
        output: realpathSync(session!.session.cwd!),
      });
      expect(
        (
          await service.readSession(
            third.sessionId,
            INTERNAL_SESSION_READ_SCOPE,
          )
        )?.session.cwd,
      ).toBe(session!.session.cwd);
      expect(
        execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], {
          windowsHide: true,
          encoding: 'utf8',
        }),
      ).toBe(registeredBefore);
      await expect
        .poll(
          async () =>
            (
              await service.readSession(
                third.sessionId,
                INTERNAL_SESSION_READ_SCOPE,
              )
            )?.session.lifecycleState,
        )
        .toBe('completed');
      proofOptions.dropWorkspaceMarker = true;
      await expect(
        executeExecutionTargetMessage(
          {
            conversationId: result.conversationId,
            target: {
              environment: { kind: 'current' },
              agent: slug,
              workspace: { kind: 'project', projectSlug },
            },
            message: 'Must not run without the workspace relay.',
            userId: proof.actor.principal.id,
            principal: proof.actor.principal,
            readAuthority: proof.actor.readAuthority,
          },
          service,
        ),
      ).rejects.toThrow();
      expect(proof.streamText).toHaveBeenCalledTimes(3);
    } finally {
      optionalGrant.mockRestore();
      steering.mockRestore();
    }
  });

  test('refuses native Agent execution that cannot consume the captured spec', async () => {
    const nativeStart = vi.fn(adapter.startSession);
    nativeAdapter = {
      ...adapter,
      provider: 'station-agent',
      metadata: { ...adapter.metadata, engineId: engineId('station') },
      startSession: nativeStart,
    };
    const prepared = await prepare();
    await expect(
      prepared.run(async (admission) => {
        const outcome = await service.startSessionInternal(
          {
            type: 'start-session',
            input: {
              provider: 'station-agent',
              threadId: 'native-refusal',
              metadata: {
                agentSlug: admission.agentId,
                projectSlug: admission.project.slug,
                userId: 'owner',
              },
            },
          },
          { userId: 'owner' },
          { foregroundInvocationAdmission: admission },
        );
        if (outcome.status !== 'accepted') throw new Error(outcome.message);
        return outcome;
      }),
    ).rejects.toThrow();
    expect(nativeStart).not.toHaveBeenCalled();
  });
});
