import {
  DEFAULT_GRANT_PAIRING_SCOPE,
  pairingScopePresetString,
} from '@kontourai/station-contracts';
import { MCPLocalConnectionCustody } from '@kontourai/station-shared/mcp';
import { describe, expect, test, vi } from 'vitest';
import { registerEngineConnection } from '../../../domain/agent-registry.js';
import { KnowledgeStoreProvider } from '../../../knowledge-store/knowledge-store-provider.js';
import { providerAdapterLaunchabilitySource } from '../../../providers/registries/registry.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { ProjectManifestStore } from '../../../services/projects/project-manifest-store.js';
import { createRuntimeServiceBundle } from '../runtime-service-bootstrap.js';

describe('createRuntimeServiceBundle', () => {
  test('creates storage-backed services and defers terminal WS until secure startup', () => {
    const storageAdapter = { kind: 'storage' };
    const terminalWsServer = { start: vi.fn() };
    const usageAggregatorRef = { get: vi.fn(() => ({ id: 'usage' })) };
    const createAgentService = vi.fn(() => ({ kind: 'agent-service' }));
    const createProviderService = vi.fn(() => ({ kind: 'provider-service' }));
    const createConnectionService = vi.fn(() => ({
      kind: 'connection-service',
    }));
    const createACPManager = vi.fn(() => ({
      kind: 'acp-bridge',
      getStatus: () => ({}),
    }));

    const bundle = createRuntimeServiceBundle(
      {
        projectHomeDir: '/tmp/project',
        port: 4123,
        host: '127.0.0.1',
        logger: { info: vi.fn() },
        configLoader: {
          getProjectHomeDir: () => '/tmp/project',
          loadACPConfig: vi.fn(async () => ({ connections: [] })),
          loadAppConfig: vi.fn(async () => ({})),
          updateAppConfig: vi.fn(async () => ({})),
        } as any,
        approvalRegistry: {} as any,
        eventBus: new EventBus(),
        orchestrationEventStore: {
          createCredentialApplicationFactory: vi.fn(() => ({})),
          voiceTurnRunAuthority: vi.fn(() => ({})),
        } as any,
        environmentSecurityService: {
          verifyCredential: vi.fn(() => true),
          resolveGrantedScope: vi.fn(() => DEFAULT_GRANT_PAIRING_SCOPE),
        },
        monitoringEvents: {} as any,
        memoryAdapters: new Map(),
        activeAgents: new Map(),
        agentMetadataMap: new Map(),
        agentSpecs: new Map(),
        agentTools: new Map(),
        agentHooks: new Map(),
        mcpCustody: new MCPLocalConnectionCustody(),
        mcpConfigs: new Map(),
        mcpConnectionStatus: new Map(),
        integrationMetadata: new Map(),
        toolNameMapping: new Map(),
        usageAggregatorRef,
        getTerminalShell: () => '/bin/zsh',
        persistEvent: vi.fn(async () => {}),
        resetAllRuntimeProjections: async (reset) => reset(),
        bootstrapVoiceAgent: vi.fn(async () => {}),
        resolveVectorDbProvider: vi.fn(),
        resolveEmbeddingProvider: vi.fn(),
      },
      {
        createStorageAdapter: () => storageAdapter,
        createAgentService,
        createSkillService: () => ({ kind: 'skill-service' }),
        createMcpService: () => ({ kind: 'mcp-service' }),
        createLayoutService: () => ({ kind: 'layout-service' }),
        createProjectService: () => ({ kind: 'project-service' }),
        createProviderService,
        createKnowledgeService: () => ({ kind: 'knowledge-service' }),
        createFileTreeService: () => ({ kind: 'file-tree-service' }),
        createPtyAdapter: () => ({ kind: 'pty' }),
        createHistoryStore: () => ({ kind: 'history' }),
        createTerminalService: () => ({ kind: 'terminal-service' }),
        createTerminalWsServer: () => terminalWsServer,
        createVoiceService: () => ({ kind: 'voice-service' }),
        createMonitoringEmitter: () => ({ kind: 'monitoring' }),
        createACPManager,
        createConnectionService,
        createFeedbackService: () => ({ kind: 'feedback-service' }),
      },
    );

    expect(createAgentService).toHaveBeenCalledWith(
      expect.anything(),
      storageAdapter,
      expect.any(Map),
      expect.any(Map),
      expect.any(Map),
      expect.anything(),
      expect.any(Function),
      expect.any(Function),
    );
    expect(createProviderService).toHaveBeenCalledWith(
      storageAdapter,
      expect.any(Function),
    );
    expect(createConnectionService).toHaveBeenCalled();
    const connectionServiceArgs = createConnectionService.mock
      .calls[0] as unknown as unknown[];
    expect(connectionServiceArgs[9]).toContain(
      providerAdapterLaunchabilitySource,
    );
    expect(createACPManager).toHaveBeenCalled();
    // archive#1403: the ACPManager receives Station home as the authority beneath
    // which probes prepare private connection-scoped workspaces.
    const acpManagerArgs = createACPManager.mock
      .calls[0] as unknown as unknown[];
    expect(acpManagerArgs[2]).toBe('/tmp/project');
    expect(acpManagerArgs[2]).not.toBe(process.cwd());
    expect(terminalWsServer.start).not.toHaveBeenCalled();
    expect(bundle.storageAdapter).toBe(storageAdapter);
    expect(bundle.agentService).toEqual({ kind: 'agent-service' });
  });

  test('resolves a default agent public identity to its registered runtime connection for readiness', async () => {
    const getConnection = vi.fn(async (id: string) =>
      id === 'claude' ? { status: 'ready' } : null,
    );
    const stationHomeDir = await import('node:fs/promises').then(
      ({ mkdtemp }) => mkdtemp('/tmp/station-runtime-bootstrap-'),
    );
    const configLoader = {
      getProjectHomeDir: () => stationHomeDir,
      agentExists: vi.fn(async () => false),
      loadACPConfig: vi.fn(async () => ({ connections: [] })),
      loadAppConfig: vi.fn(async () => ({})),
      updateAppConfig: vi.fn(async () => ({})),
    };
    await registerEngineConnection(configLoader as any, 'claude');
    const context = {
      projectHomeDir: stationHomeDir,
      port: 4123,
      host: '127.0.0.1',
      logger: { info: vi.fn(), warn: vi.fn() },
      configLoader,
      approvalRegistry: {} as any,
      eventBus: new EventBus(),
      orchestrationEventStore: {
        createCredentialApplicationFactory: vi.fn(() => ({})),
        voiceTurnRunAuthority: vi.fn(() => ({})),
      } as any,
      environmentSecurityService: {
        verifyCredential: vi.fn(() => true),
        resolveGrantedScope: vi.fn(() => DEFAULT_GRANT_PAIRING_SCOPE),
      },
      monitoringEvents: {} as any,
      memoryAdapters: new Map(),
      activeAgents: new Map(),
      agentMetadataMap: new Map(),
      agentSpecs: new Map(),
      agentTools: new Map(),
      agentHooks: new Map(),
      mcpCustody: new MCPLocalConnectionCustody(),
      mcpConfigs: new Map(),
      mcpConnectionStatus: new Map(),
      integrationMetadata: new Map(),
      toolNameMapping: new Map(),
      usageAggregatorRef: { get: vi.fn(() => ({ id: 'usage' })) },
      getTerminalShell: () => '/bin/zsh',
      persistEvent: vi.fn(async () => {}),
      bootstrapVoiceAgent: vi.fn(async () => {}),
      resolveVectorDbProvider: vi.fn(),
      resolveEmbeddingProvider: vi.fn(),
    };

    const bundle = createRuntimeServiceBundle(context as any, {
      createStorageAdapter: () => ({ kind: 'storage' }),
      createSkillService: () => ({}),
      createMcpService: () => ({}),
      createLayoutService: () => ({}),
      createProjectService: () => ({}),
      createProviderService: () => ({}),
      createKnowledgeService: () => ({}),
      createFileTreeService: () => ({}),
      createPtyAdapter: () => ({}),
      createHistoryStore: () => ({}),
      createTerminalService: () => ({}),
      createTerminalWsServer: () => ({ start: vi.fn() }),
      createVoiceService: () => ({}),
      createMonitoringEmitter: () => ({}),
      createACPManager: () => ({ getStatus: () => ({}) }),
      createConnectionService: () => ({ getConnection }),
      createFeedbackService: () => ({}),
    });

    await expect(bundle.agentService.getEnrichedAgents([])).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: 'claude', available: true }),
      ]),
    );
    expect(getConnection).toHaveBeenCalledWith('claude');
  });

  // K2 (archive#200 Wave 2): `knowledgeStoreProvider` is an ADDITIVE field on the bundle —
  // no existing field's shape changed (AC4 `k2-compat-path-unchanged`'s "no changed
  // return shapes" clause) — constructed unconditionally (see the module's own
  // comment for the sync-constructor/async-flag timing rationale), with zero I/O
  // against the fake storage adapter used above (a plain `{ kind: 'storage' }`
  // object with none of the three root-persistence methods) — proving construction
  // alone never touches persistence.
  test('constructs a KnowledgeStoreProvider additively, with zero calls into the storage adapter at construction time', () => {
    const storageAdapter = { kind: 'storage' };

    const bundle = createRuntimeServiceBundle(
      {
        projectHomeDir: '/tmp/project',
        port: 4123,
        logger: { info: vi.fn() },
        configLoader: {
          getProjectHomeDir: () => '/tmp/project',
          loadACPConfig: vi.fn(async () => ({ connections: [] })),
          loadAppConfig: vi.fn(async () => ({})),
          updateAppConfig: vi.fn(async () => ({})),
        } as any,
        approvalRegistry: {} as any,
        eventBus: new EventBus(),
        orchestrationEventStore: {
          createCredentialApplicationFactory: vi.fn(() => ({})),
          voiceTurnRunAuthority: vi.fn(() => ({})),
        } as any,
        environmentSecurityService: {
          verifyCredential: vi.fn(() => true),
          resolveGrantedScope: vi.fn(() => DEFAULT_GRANT_PAIRING_SCOPE),
        },
        monitoringEvents: {} as any,
        memoryAdapters: new Map(),
        activeAgents: new Map(),
        agentMetadataMap: new Map(),
        agentSpecs: new Map(),
        agentTools: new Map(),
        agentHooks: new Map(),
        mcpCustody: new MCPLocalConnectionCustody(),
        mcpConfigs: new Map(),
        mcpConnectionStatus: new Map(),
        integrationMetadata: new Map(),
        toolNameMapping: new Map(),
        usageAggregatorRef: { get: vi.fn(() => ({ id: 'usage' })) },
        getTerminalShell: () => '/bin/zsh',
        persistEvent: vi.fn(async () => {}),
        resetAllRuntimeProjections: async (reset) => reset(),
        bootstrapVoiceAgent: vi.fn(async () => {}),
        resolveVectorDbProvider: vi.fn(),
        resolveEmbeddingProvider: vi.fn(),
      },
      {
        createStorageAdapter: () => storageAdapter,
        createTerminalWsServer: () => ({ start: vi.fn() }),
      },
    );

    expect(bundle.knowledgeStoreProvider).toBeInstanceOf(
      KnowledgeStoreProvider,
    );
    // The fake storage adapter has none of listKnowledgeStoreRoots/
    // saveKnowledgeStoreRoot/removeKnowledgeStoreRoot — if construction had called
    // any of them, this would have thrown a TypeError synchronously above.
    expect(
      bundle.knowledgeStoreProvider
        .listAdapters()
        .map((a: { id: string }) => a.id),
    ).toEqual(
      expect.arrayContaining(['kit-default-store', 'kit-obsidian-store']),
    );
  });

  // archive#1499: the manifest sidecar only shrinks the legacy
  // `workingDirectory`-only path if EVERY new project gets one, which means the
  // default ProjectService the runtime actually builds must carry a manifest
  // store. Without this assertion the wiring could be dropped and every test
  // that constructs ProjectService by hand would still pass — the archive#1302
  // "designed but dead" shape.
  test('wires a ProjectManifestStore into the default ProjectService', () => {
    const bundle = createRuntimeServiceBundle(
      {
        projectHomeDir: '/tmp/project',
        port: 4123,
        logger: { info: vi.fn() },
        configLoader: {
          getProjectHomeDir: () => '/tmp/project',
          loadACPConfig: vi.fn(async () => ({ connections: [] })),
          loadAppConfig: vi.fn(async () => ({})),
          updateAppConfig: vi.fn(async () => ({})),
        } as any,
        approvalRegistry: {} as any,
        eventBus: new EventBus(),
        orchestrationEventStore: {
          createCredentialApplicationFactory: vi.fn(() => ({})),
          voiceTurnRunAuthority: vi.fn(() => ({})),
        } as any,
        environmentSecurityService: {
          verifyCredential: vi.fn(() => true),
          resolveGrantedScope: vi.fn(() => DEFAULT_GRANT_PAIRING_SCOPE),
        },
        monitoringEvents: {} as any,
        memoryAdapters: new Map(),
        activeAgents: new Map(),
        agentMetadataMap: new Map(),
        agentSpecs: new Map(),
        agentTools: new Map(),
        agentHooks: new Map(),
        mcpCustody: new MCPLocalConnectionCustody(),
        mcpConfigs: new Map(),
        mcpConnectionStatus: new Map(),
        integrationMetadata: new Map(),
        toolNameMapping: new Map(),
        usageAggregatorRef: { get: vi.fn(() => ({ id: 'usage' })) },
        getTerminalShell: () => '/bin/zsh',
        persistEvent: vi.fn(async () => {}),
        resetAllRuntimeProjections: async (reset) => reset(),
        bootstrapVoiceAgent: vi.fn(async () => {}),
        resolveVectorDbProvider: vi.fn(),
        resolveEmbeddingProvider: vi.fn(),
      },
      {
        createStorageAdapter: () => ({ kind: 'storage' }),
        createTerminalWsServer: () => ({ start: vi.fn() }),
      },
    );

    expect(
      (bundle.projectService as unknown as { manifests?: unknown }).manifests,
    ).toBeInstanceOf(ProjectManifestStore);
  });
});

describe('terminal WebSocket scope gating (station#1098)', () => {
  function baseContext(environmentSecurityService: {
    verifyCredential: (credential: string) => boolean | Promise<boolean>;
    resolveGrantedScope: (
      credential: string,
    ) => string | undefined | Promise<string | undefined>;
  }) {
    return {
      projectHomeDir: '/tmp/project',
      port: 4123,
      host: '127.0.0.1',
      logger: { info: vi.fn(), warn: vi.fn() },
      configLoader: {
        getProjectHomeDir: () => '/tmp/project',
        loadACPConfig: vi.fn(async () => ({ connections: [] })),
        loadAppConfig: vi.fn(async () => ({})),
        updateAppConfig: vi.fn(async () => ({})),
      } as any,
      approvalRegistry: {} as any,
      eventBus: new EventBus(),
      orchestrationEventStore: {
        createCredentialApplicationFactory: vi.fn(() => ({})),
        voiceTurnRunAuthority: vi.fn(() => ({})),
      } as any,
      environmentSecurityService,
      monitoringEvents: {} as any,
      memoryAdapters: new Map(),
      activeAgents: new Map(),
      agentMetadataMap: new Map(),
      agentSpecs: new Map(),
      agentTools: new Map(),
      agentHooks: new Map(),
      mcpCustody: new MCPLocalConnectionCustody(),
      mcpConfigs: new Map(),
      mcpConnectionStatus: new Map(),
      integrationMetadata: new Map(),
      toolNameMapping: new Map(),
      usageAggregatorRef: { get: vi.fn(() => ({ id: 'usage' })) },
      getTerminalShell: () => '/bin/zsh',
      persistEvent: vi.fn(async () => {}),
      bootstrapVoiceAgent: vi.fn(async () => {}),
      resolveVectorDbProvider: vi.fn(),
      resolveEmbeddingProvider: vi.fn(),
    };
  }

  /** Captures the exact `auth` option `TerminalWebSocketServer` was constructed with. */
  function captureTerminalAuth() {
    let captured: {
      verifyCredential: (credential: string) => boolean | Promise<boolean>;
    } | null = null;
    const factories = {
      createTerminalWsServer: (_terminalService: unknown, auth: any) => {
        captured = auth;
        return { start: vi.fn() };
      },
    };
    return { factories, getAuth: () => captured! };
  }

  test('a device credential scoped to terminal:operate authenticates the terminal WS', async () => {
    const scope = pairingScopePresetString('standard'); // includes terminal:operate
    const { factories, getAuth } = captureTerminalAuth();
    createRuntimeServiceBundle(
      baseContext({
        verifyCredential: async (credential) => credential === 'device-1',
        resolveGrantedScope: async (credential) =>
          credential === 'device-1' ? scope : undefined,
      }) as any,
      factories,
    );

    await expect(getAuth().verifyCredential('device-1')).resolves.toBe(true);
  });

  test('a read-only device credential authenticates the boundary but is denied terminal:operate', async () => {
    const scope = pairingScopePresetString('read-only');
    const { factories, getAuth } = captureTerminalAuth();
    createRuntimeServiceBundle(
      baseContext({
        verifyCredential: async (credential) => credential === 'device-1',
        resolveGrantedScope: async (credential) =>
          credential === 'device-1' ? scope : undefined,
      }) as any,
      factories,
    );

    await expect(getAuth().verifyCredential('device-1')).resolves.toBe(false);
  });

  test('the operator (full-scope) credential authenticates the terminal WS', async () => {
    const { factories, getAuth } = captureTerminalAuth();
    createRuntimeServiceBundle(
      baseContext({
        verifyCredential: async (credential) => credential === 'operator',
        resolveGrantedScope: async (credential) =>
          credential === 'operator' ? DEFAULT_GRANT_PAIRING_SCOPE : undefined,
      }) as any,
      factories,
    );

    await expect(getAuth().verifyCredential('operator')).resolves.toBe(true);
  });

  test('an invalid credential is rejected before any scope lookup', async () => {
    const resolveGrantedScope = vi.fn(async () => DEFAULT_GRANT_PAIRING_SCOPE);
    const { factories, getAuth } = captureTerminalAuth();
    createRuntimeServiceBundle(
      baseContext({
        verifyCredential: async () => false,
        resolveGrantedScope,
      }) as any,
      factories,
    );

    await expect(getAuth().verifyCredential('anything')).resolves.toBe(false);
    expect(resolveGrantedScope).not.toHaveBeenCalled();
  });
});
