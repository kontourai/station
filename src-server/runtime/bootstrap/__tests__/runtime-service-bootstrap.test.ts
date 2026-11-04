import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_GRANT_PAIRING_SCOPE } from '@kontourai/station-contracts';
import { MCPLocalConnectionCustody } from '@kontourai/station-shared/mcp';
import { afterAll, describe, expect, test, vi } from 'vitest';
import { registerEngineConnection } from '../../../domain/agent-registry.js';
import { KnowledgeStoreProvider } from '../../../knowledge-store/knowledge-store-provider.js';
import { providerAdapterLaunchabilitySource } from '../../../providers/registries/registry.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { ProjectManifestStore } from '../../../services/projects/project-manifest-store.js';
import { createRuntimeServiceBundle } from '../runtime-service-bootstrap.js';

// `mkdtemp('/tmp/station-runtime-bootstrap-')` hardcoded `/tmp` as the mkdtemp
// BASE and never removed what it made, so every run left one more directory in
// a world-writable directory shared with the whole host -- 123 had accumulated
// when this was found (#1790; the live count drifts as sibling lanes on `main`
// add more and the host's /tmp cleaner reaps older ones). `tmpdir()` is the
// platform's own answer -- `/tmp` does not exist on Windows at all -- and the
// roots are removed below.
const createdTempRoots: string[] = [];

afterAll(() => {
  for (const root of createdTempRoots) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('createRuntimeServiceBundle', () => {
  test('creates storage-backed services', () => {
    const storageAdapter = { kind: 'storage' };
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
          authorizeCredential: vi.fn(() => false),
          credentialLocality: vi.fn(() => undefined),
          verifyCredential: vi.fn(() => true),
          identifyDevice: vi.fn(() => null),
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
    expect(acpManagerArgs[1]).toBe('/tmp/project');
    expect(acpManagerArgs[1]).not.toBe(process.cwd());
    expect(bundle.storageAdapter).toBe(storageAdapter);
    expect(bundle.agentService).toEqual({ kind: 'agent-service' });
  });

  test('resolves a default agent public identity to its registered runtime connection for readiness', async () => {
    const getConnection = vi.fn(async (id: string) =>
      id === 'claude' ? { status: 'ready' } : null,
    );
    const stationHomeDir = await import('node:fs/promises').then(
      ({ mkdtemp }) => mkdtemp(join(tmpdir(), 'station-runtime-bootstrap-')),
    );
    createdTempRoots.push(stationHomeDir);
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
          authorizeCredential: vi.fn(() => false),
          credentialLocality: vi.fn(() => undefined),
          verifyCredential: vi.fn(() => true),
          identifyDevice: vi.fn(() => null),
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
        persistEvent: vi.fn(async () => {}),
        resetAllRuntimeProjections: async (reset) => reset(),
        bootstrapVoiceAgent: vi.fn(async () => {}),
        resolveVectorDbProvider: vi.fn(),
        resolveEmbeddingProvider: vi.fn(),
      },
      {
        createStorageAdapter: () => storageAdapter,
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
          authorizeCredential: vi.fn(() => false),
          credentialLocality: vi.fn(() => undefined),
          verifyCredential: vi.fn(() => true),
          identifyDevice: vi.fn(() => null),
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
        persistEvent: vi.fn(async () => {}),
        resetAllRuntimeProjections: async (reset) => reset(),
        bootstrapVoiceAgent: vi.fn(async () => {}),
        resolveVectorDbProvider: vi.fn(),
        resolveEmbeddingProvider: vi.fn(),
      },
      {
        createStorageAdapter: () => ({ kind: 'storage' }),
      },
    );

    expect(
      (bundle.projectService as unknown as { manifests?: unknown }).manifests,
    ).toBeInstanceOf(ProjectManifestStore);
  });
});
