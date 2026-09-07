import type { EventEmitter } from 'node:events';
import type { AgentSpec } from '@kontourai/station-contracts/agent';
import type { EngineConnectionId } from '@kontourai/station-contracts/agent-identity';
import type { AppConfig } from '@kontourai/station-contracts/config';
import type { MCPLocalConnectionCustody } from '@kontourai/station-shared/mcp';
import { FileMemoryAdapter } from '../../adapters/file/memory-adapter.js';
import { FileTerminalHistoryStore } from '../../adapters/file-terminal-history-store.js';
import { NodePtyAdapter } from '../../adapters/node-pty-adapter.js';
import {
  loadOrCreateAgentRegistry,
  registerEngineConnection,
  unregisterEngineConnection,
} from '../../domain/agent-registry.js';
import type { ConfigLoader } from '../../domain/config-loader.js';
import { FileStorageAdapter } from '../../domain/file-storage-adapter.js';
import { createLocalKnowledgeSourceObservationPolicy } from '../../knowledge-store/knowledge-source-observation-policy.js';
import { KnowledgeStoreProvider } from '../../knowledge-store/knowledge-store-provider.js';
import { MonitoringEmitter } from '../../monitoring/emitter.js';
import {
  createProviderAdapterRegistry,
  providerAdapterLaunchabilitySource,
} from '../../providers/registries/registry.js';
import {
  credentialAuthorizedForScope,
  PAIRING_WS_SCOPES,
} from '../../security/pairing-route-scopes.js';
import { ACPManager } from '../../services/acp/acp-bridge.js';
import { AgentService } from '../../services/agents/agent-service.js';
import { SkillService } from '../../services/agents/skill-service.js';
import type { ApprovalRegistry } from '../../services/approvals/approval-registry.js';
import { ConnectionService } from '../../services/connections/connection-service.js';
import { FileConnectionSmokeEvidenceStore } from '../../services/connections/connection-smoke-evidence-store.js';
import { ProviderService } from '../../services/connections/provider-service.js';
import { RuntimeAuthHealthMonitor } from '../../services/connections/runtime-auth-health-monitor.js';
import { FeedbackService } from '../../services/feedback/feedback-service.js';
import { resolveCanonicalSkillSources } from '../../services/flow/flow-agents-skills-source.js';
import { KnowledgeService } from '../../services/knowledge/knowledge-service.js';
import type { EventBus } from '../../services/orchestration/event-bus.js';
import type { EventStore } from '../../services/orchestration/event-store.js';
import { MCPService } from '../../services/plugins/mcp-service.js';
import { scanPluginCommandSkills } from '../../services/plugins/plugin-command-skill-source.js';
import { FileTreeService } from '../../services/projects/file-tree-service.js';
import { LayoutService } from '../../services/projects/layout-service.js';
import { ProjectManifestStore } from '../../services/projects/project-manifest-store.js';
import { ProjectService } from '../../services/projects/project-service.js';
import { ProposedChangeService } from '../../services/projects/proposed-change-service.js';
import {
  FileSecretBindingAdministration,
  SecretBindingIntegrationService,
} from '../../services/secrets/secret-binding-administration.js';
import type { EnvironmentSecurityService } from '../../services/ssh/environment-security-service.js';
import { SshEnvironmentService } from '../../services/ssh/ssh-environment-service.js';
import { TerminalService } from '../../services/terminal/terminal-service.js';
import {
  type TerminalWebSocketSecurityAuditRecord,
  TerminalWebSocketServer,
} from '../../services/terminal/terminal-ws-server.js';
import { NovaSonicProvider } from '../../voice/providers/nova-sonic.js';
import { VoiceSessionService } from '../../voice/voice-session.js';
import type { IAgentHooks } from '../types.js';
import { createPersonalRuntimeRequestGuard } from './runtime-tenant-context.js';

type ToolNameMapping = Map<
  string,
  {
    original: string;
    normalized: string;
    server: string | null;
    tool: string;
  }
>;

interface RuntimeServiceBootstrapContext {
  projectHomeDir: string;
  port: number;
  host?: string;
  logger: any;
  configLoader: ConfigLoader;
  approvalRegistry: ApprovalRegistry;
  eventBus: EventBus;
  orchestrationEventStore: EventStore;
  environmentSecurityService: Pick<
    EnvironmentSecurityService,
    | 'verifyCredential'
    | 'resolveGrantedScope'
    | 'authorizeCredential'
    | 'credentialLocality'
  >;
  monitoringEvents: EventEmitter;
  memoryAdapters: Map<string, FileMemoryAdapter>;
  activeAgents: Map<string, any>;
  agentMetadataMap: Map<string, any>;
  agentSpecs: Map<string, AgentSpec>;
  agentTools: Map<string, any[]>;
  agentHooks: Map<string, IAgentHooks>;
  mcpConfigs: Map<string, any>;
  mcpCustody: MCPLocalConnectionCustody;
  mcpConnectionStatus: Map<string, { connected: boolean; error?: string }>;
  integrationMetadata: Map<
    string,
    { type: string; transport?: string; toolCount?: number }
  >;
  toolNameMapping: ToolNameMapping;
  resetAllRuntimeProjections: (reset: () => void) => Promise<void>;
  usageAggregatorRef: { get: () => any };
  getTerminalShell: () => string | undefined;
  persistEvent: (event: any) => Promise<void>;
  bootstrapVoiceAgent: () => Promise<void>;
  resolveVectorDbProvider: () => any;
  resolveEmbeddingProvider: () => any;
}

interface RuntimeServiceBootstrapFactories {
  createStorageAdapter?: (projectHomeDir: string) => any;
  createAgentService?: (...args: any[]) => any;
  createSkillService?: (...args: any[]) => any;
  createMcpService?: (...args: any[]) => any;
  createLayoutService?: (...args: any[]) => any;
  createProjectService?: (...args: any[]) => any;
  createProviderService?: (...args: any[]) => any;
  createProposedChangeService?: (projectHomeDir: string) => any;
  createKnowledgeService?: (...args: any[]) => any;
  createKnowledgeStoreProvider?: (storageAdapter: any) => any;
  createFileTreeService?: () => any;
  createPtyAdapter?: () => any;
  createHistoryStore?: () => any;
  createTerminalService?: (...args: any[]) => any;
  createTerminalWsServer?: (terminalService: any, auth: any) => any;
  createVoiceService?: (options: any) => any;
  createMonitoringEmitter?: (
    events: EventEmitter,
    persist: (event: any) => Promise<void>,
  ) => any;
  createACPManager?: (...args: any[]) => any;
  createConnectionService?: (...args: any[]) => any;
  createFeedbackService?: (projectHomeDir: string) => any;
  createSshEnvironmentService?: (projectHomeDir: string) => any;
}

export function createRuntimeServiceBundle(
  context: RuntimeServiceBootstrapContext,
  factories: RuntimeServiceBootstrapFactories = {},
) {
  const storageAdapter =
    factories.createStorageAdapter?.(context.projectHomeDir) ??
    new FileStorageAdapter(context.configLoader.getProjectHomeDir());
  let connectionService: ConnectionService | undefined;
  // The default ConnectionService owns this monitor and disposes it with the
  // runtime. A custom factory owns any monitor it chooses to construct.
  const runtimeAuthHealthMonitor = factories.createConnectionService
    ? undefined
    : new RuntimeAuthHealthMonitor(context.eventBus);
  const getEngineReadiness = async (engineConnectionId: string) => {
    if (engineConnectionId === 'default') {
      return {
        available: context.activeAgents.has('default'),
        ...(context.activeAgents.has('default')
          ? {}
          : {
              reason:
                'Station default Agent is not registered with the managed runtime.',
            }),
      };
    }
    const connection =
      await connectionService?.getConnection(engineConnectionId);
    return {
      available: connection?.status === 'ready',
      ...(connection?.status === 'ready'
        ? {}
        : {
            reason: connection?.config?.readinessReason as string | undefined,
          }),
    };
  };

  const agentService =
    factories.createAgentService?.(
      context.configLoader,
      storageAdapter,
      context.activeAgents,
      context.agentMetadataMap,
      context.agentSpecs,
      context.logger,
      () => loadOrCreateAgentRegistry(context.configLoader),
      getEngineReadiness,
    ) ??
    new AgentService(
      context.configLoader,
      storageAdapter,
      context.activeAgents,
      context.agentMetadataMap,
      context.agentSpecs,
      context.logger,
      () => loadOrCreateAgentRegistry(context.configLoader),
      getEngineReadiness,
    );

  const skillService =
    factories.createSkillService?.(context.configLoader, context.logger) ??
    new SkillService(context.configLoader, context.logger, {
      // Canonical Flow Agents skills (deliver, plan-work, verify-work, …)
      // from the installed package become browsable/assignable Station
      // skills — a read-only source adapter, no copied content (S3 item 3).
      canonicalSources: resolveCanonicalSkillSources(),
      pluginCommandSource: (projectHomeDir, takenNames) =>
        scanPluginCommandSkills(projectHomeDir, context.logger, takenNames).map(
          (skill) => ({ ...skill, resources: [] }),
        ),
    });

  const secretBindingAdministration = new FileSecretBindingAdministration(
    context.projectHomeDir,
    { logger: context.logger },
  );
  const secretBindingIntegrationAdministration =
    new SecretBindingIntegrationService(
      secretBindingAdministration,
      context.configLoader,
      context.logger,
      async (id, operation) => {
        const result = await context.mcpCustody.mutate(id, operation);
        context.mcpConfigs.delete(id);
        return result;
      },
    );

  const mcpService =
    factories.createMcpService?.(
      context.configLoader,
      context.mcpConfigs,
      context.mcpConnectionStatus,
      context.integrationMetadata,
      context.agentTools,
      context.toolNameMapping,
      context.logger,
    ) ??
    new MCPService(
      context.configLoader,
      context.mcpConfigs,
      context.mcpConnectionStatus,
      context.integrationMetadata,
      context.agentTools,
      context.toolNameMapping,
      context.logger,
      context.resetAllRuntimeProjections,
      context.port,
      secretBindingAdministration,
      secretBindingAdministration,
      context.mcpCustody,
    );

  const layoutService =
    factories.createLayoutService?.(context.configLoader, context.logger) ??
    new LayoutService(context.configLoader, context.logger);

  const projectService =
    factories.createProjectService?.(storageAdapter) ??
    new ProjectService(
      storageAdapter,
      // archive#1499: every NEW project gets a manifest sidecar, so the legacy
      // `workingDirectory`-only path shrinks monotonically instead of becoming
      // a permanent second mode (portable-project-identity.md §5).
      new ProjectManifestStore(context.projectHomeDir, storageAdapter),
    );

  const providerService =
    factories.createProviderService?.(storageAdapter, () =>
      context.configLoader.loadAppConfig(),
    ) ??
    new ProviderService(storageAdapter, () =>
      context.configLoader.loadAppConfig(),
    );

  const proposedChangeService =
    factories.createProposedChangeService?.(context.projectHomeDir) ??
    new ProposedChangeService(context.projectHomeDir);

  const knowledgeService =
    factories.createKnowledgeService?.(
      () => context.resolveVectorDbProvider(),
      () => context.resolveEmbeddingProvider(),
      context.projectHomeDir,
      storageAdapter,
    ) ??
    new KnowledgeService(
      () => context.resolveVectorDbProvider(),
      () => context.resolveEmbeddingProvider(),
      context.projectHomeDir,
      storageAdapter,
    );

  // K2 store-layer seam (`AppConfig.knowledgeStores`, default off). Constructed
  // unconditionally here — NOT gated on the flag at this call site — because
  // `createRuntimeServiceBundle` is synchronous (called from `StationRuntime`'s
  // constructor, which cannot await) while `configLoader.loadAppConfig()` is async
  // and, at this exact point in cold start, has not resolved yet (`this.appConfig`
  // is assigned later, once `initialize()`'s async flow completes — see archive#208's
  // fix). This mirrors the file's own established precedent for the identical
  // tension: `providerService`/`connectionService` above also take a *lazy*
  // `() => context.configLoader.loadAppConfig()` getter rather than an
  // eagerly-resolved config, deferring any flag-dependent decision to whichever
  // call site actually needs it. Constructing `KnowledgeStoreProvider` itself does
  // zero I/O (no root exists until `createRoot` is called) and registers only the
  // two Station-owned Kit-format adapters — so its mere existence changes nothing
  // observable, exactly like `knowledgeService` above. AC4 ("byte-identical when
  // the flag is off") holds today because nothing in this bundle calls into
  // `knowledgeStoreProvider` yet; the flag's enforcement point begins with
  // whichever K3+ work adds a route/service that both checks the flag (async) and
  // calls this provider or `projectNamespacesToRoots`.
  const knowledgeStoreProvider =
    factories.createKnowledgeStoreProvider?.(storageAdapter) ??
    new KnowledgeStoreProvider(
      storageAdapter,
      createLocalKnowledgeSourceObservationPolicy({
        stationHome: context.configLoader.getProjectHomeDir(),
        persistence: storageAdapter,
        security: context.environmentSecurityService,
        isPersonalRequest: createPersonalRuntimeRequestGuard(),
      }),
    );

  const fileTreeService =
    factories.createFileTreeService?.() ?? new FileTreeService();
  const ptyAdapter = factories.createPtyAdapter?.() ?? new NodePtyAdapter();
  const historyStore =
    factories.createHistoryStore?.() ?? new FileTerminalHistoryStore();
  const terminalService =
    factories.createTerminalService?.(
      ptyAdapter,
      historyStore,
      context.getTerminalShell,
    ) ??
    new TerminalService(ptyAdapter, historyStore, context.getTerminalShell);

  const terminalAuth = {
    // Scoped pairing (archive#1098): a valid credential must ALSO carry
    // terminal:operate — a read-only paired device authenticates fine but
    // never reaches an open terminal session. Shared with voice's identical
    // gate (`runtime-initialize.ts`) via `credentialAuthorizedForScope`.
    verifyCredential: (credential: string) =>
      credentialAuthorizedForScope(
        context.environmentSecurityService,
        PAIRING_WS_SCOPES.terminal,
        credential,
      ),
    audit: (record: TerminalWebSocketSecurityAuditRecord) =>
      context.logger.warn('Terminal authentication denied', record),
  };
  const terminalWsServer =
    factories.createTerminalWsServer?.(terminalService, terminalAuth) ??
    new TerminalWebSocketServer(terminalService, terminalAuth);

  const voiceService =
    factories.createVoiceService?.({
      providerFactory: () => new NovaSonicProvider({ region: 'us-east-1' }),
      agentTools: context.agentTools,
      agentSpecs: context.agentSpecs,
      agentHooks: context.agentHooks,
      voiceAgentSlug: 'station-voice',
      onFirstSession: () => context.bootstrapVoiceAgent(),
      voiceTurnRuns: context.orchestrationEventStore.voiceTurnRunAuthority(),
    }) ??
    new VoiceSessionService({
      providerFactory: () => new NovaSonicProvider({ region: 'us-east-1' }),
      agentTools: context.agentTools,
      agentSpecs: context.agentSpecs,
      agentHooks: context.agentHooks,
      voiceAgentSlug: 'station-voice',
      onFirstSession: () => context.bootstrapVoiceAgent(),
      voiceTurnRuns: context.orchestrationEventStore.voiceTurnRunAuthority(),
    });

  const monitoringEmitter =
    factories.createMonitoringEmitter?.(
      context.monitoringEvents,
      context.persistEvent,
    ) ?? new MonitoringEmitter(context.monitoringEvents, context.persistEvent);

  // archive#1403: ACP probes prepare their own connection-scoped private workspace
  // beneath Station home. Pass the authority root, not a launch cwd; the
  // probe keeps an explicitly configured connection cwd ahead of this seam.
  const acpManagedWorkspaceHome = context.configLoader.getProjectHomeDir();

  const acpBridge =
    factories.createACPManager?.(
      context.approvalRegistry,
      context.logger,
      acpManagedWorkspaceHome,
      context.memoryAdapters,
      (_slug: string) =>
        new FileMemoryAdapter({
          projectHomeDir: context.configLoader.getProjectHomeDir(),
          usageAggregator: context.usageAggregatorRef.get(),
        }),
      context.usageAggregatorRef,
      context.eventBus,
      context.monitoringEvents,
      context.persistEvent,
      monitoringEmitter,
    ) ??
    new ACPManager(
      context.approvalRegistry,
      context.logger,
      acpManagedWorkspaceHome,
      context.memoryAdapters,
      (_slug: string) =>
        new FileMemoryAdapter({
          projectHomeDir: context.configLoader.getProjectHomeDir(),
          usageAggregator: context.usageAggregatorRef.get(),
        }),
      context.usageAggregatorRef,
      context.eventBus,
      context.monitoringEvents,
      context.persistEvent,
      monitoringEmitter,
    );

  connectionService = factories.createConnectionService
    ? factories.createConnectionService(
        providerService,
        () => createProviderAdapterRegistry().list(),
        async () => {
          const config = await context.configLoader.loadACPConfig();
          return config.connections;
        },
        () => acpBridge.getStatus(),
        () => context.configLoader.loadAppConfig(),
        (updates: any) => context.configLoader.updateAppConfig(updates),
        context.orchestrationEventStore.createCredentialApplicationFactory(),
        undefined,
        undefined,
        [
          providerService,
          context.configLoader,
          providerAdapterLaunchabilitySource,
        ].filter(
          (source): source is ProviderService | ConfigLoader =>
            typeof source?.getLaunchabilityRevision === 'function' &&
            typeof source?.onLaunchabilityChange === 'function',
        ),
        (mutate: (current: Readonly<AppConfig>) => Partial<AppConfig>) =>
          context.configLoader.mutateAppConfig(mutate),
        {
          load: () => loadOrCreateAgentRegistry(context.configLoader),
          register: (id: EngineConnectionId) =>
            registerEngineConnection(context.configLoader, id),
          unregister: (id: EngineConnectionId) =>
            unregisterEngineConnection(context.configLoader, id),
        },
      )
    : new ConnectionService(
        providerService,
        () => createProviderAdapterRegistry().list(),
        async () => {
          const config = await context.configLoader.loadACPConfig();
          return config.connections;
        },
        () => acpBridge.getStatus(),
        () => context.configLoader.loadAppConfig(),
        (updates) => context.configLoader.updateAppConfig(updates),
        context.orchestrationEventStore.createCredentialApplicationFactory(),
        runtimeAuthHealthMonitor,
        new FileConnectionSmokeEvidenceStore(context.projectHomeDir),
        [
          providerService,
          context.configLoader,
          providerAdapterLaunchabilitySource,
        ].filter(
          (source): source is ProviderService | ConfigLoader =>
            typeof source?.getLaunchabilityRevision === 'function' &&
            typeof source?.onLaunchabilityChange === 'function',
        ),
        (mutate) => context.configLoader.mutateAppConfig(mutate),
        {
          load: () => loadOrCreateAgentRegistry(context.configLoader),
          register: (id: EngineConnectionId) =>
            registerEngineConnection(context.configLoader, id),
          unregister: (id: EngineConnectionId) =>
            unregisterEngineConnection(context.configLoader, id),
        },
      );

  if (!connectionService) {
    throw new Error('Connection service factory did not return a service.');
  }

  const feedbackService =
    factories.createFeedbackService?.(context.projectHomeDir) ??
    new FeedbackService(context.projectHomeDir);

  const sshEnvironmentService =
    factories.createSshEnvironmentService?.(context.projectHomeDir) ??
    new SshEnvironmentService(context.projectHomeDir);

  return {
    storageAdapter,
    agentService,
    skillService,
    mcpService,
    layoutService,
    projectService,
    providerService,
    proposedChangeService,
    knowledgeService,
    knowledgeStoreProvider,
    fileTreeService,
    terminalService,
    terminalWsServer,
    voiceService,
    monitoringEmitter,
    acpBridge,
    connectionService,
    feedbackService,
    sshEnvironmentService,
    secretBindingAdministration,
    secretBindingIntegrationAdministration,
  };
}
