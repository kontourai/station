import type { AgentSpec } from '@kontourai/station-contracts/agent';
import type { AppConfig } from '@kontourai/station-contracts/config';
import type { BuiltinAgentEngineBinding } from '@kontourai/station-contracts/engine-capability-matrix';
import type { ToolDef } from '@kontourai/station-contracts/tool';
import type { Agent } from '@voltagent/core';
import type {
  OrchestrationUsageRef,
  UsageAggregator,
} from '../../analytics/usage-aggregator.js';
import type { FileStorageAdapter } from '../../domain/file-storage-adapter.js';
import type { MonitoringEmitter } from '../../monitoring/emitter.js';
import type { ProviderSessionStartInput } from '../../providers/adapter-shape.js';
import type { BedrockAdapter } from '../../providers/adapters/bedrock-adapter.js';
import type { ClaudeAdapter } from '../../providers/adapters/claude-adapter.js';
import type { CodexAdapter } from '../../providers/adapters/codex-adapter.js';
import type { MuseAdapter } from '../../providers/adapters/muse-adapter.js';
import type { OllamaAdapter } from '../../providers/adapters/ollama-adapter.js';
import type { BedrockModelCatalog } from '../../providers/llm/bedrock-models.js';
import type { ACPManager } from '../../services/acp/acp-bridge.js';
import type { SkillService } from '../../services/agents/skill-service.js';
import type { ApprovalRegistry } from '../../services/approvals/approval-registry.js';
import type { FeedbackService } from '../../services/feedback/feedback-service.js';
import type { CredentialProfileRecoveryAdapter } from '../../services/orchestration/credential-recovery-module.js';
import type { EventBus } from '../../services/orchestration/event-bus.js';
import type { EventStore } from '../../services/orchestration/event-store.js';
import type { MCPToolProvenanceGeneration } from '../../services/orchestration/mcp-tool-provenance.js';
import type { OrchestrationService } from '../../services/orchestration/orchestration-service.js';
import type { IntegrationSecretResolver } from '../../services/secrets/secret-binding-administration.js';
import type { EnvironmentSecurityService } from '../../services/ssh/environment-security-service.js';
import type { Logger } from '../../utils/logger.js';
import type { VoiceSessionService } from '../../voice/voice-session.js';
import type { AgentHooksDeps } from '../agents/agent-hooks.js';
import type { StagedPreToolPolicyEvaluator } from '../agents/pre-tool-policy.js';
import type { RuntimeEventLog } from '../conversation/runtime-event-log.js';
import type { IAgentFramework } from '../types.js';
import type { InitializeRuntimeDeps } from './runtime-initialize.js';

type RuntimeIntegrationMetadata = Map<
  string,
  { type: string; transport?: string; toolCount?: number }
>;

type ToolNameMapping = Map<
  string,
  {
    original: string;
    normalized: string;
    server: string | null;
    tool: string;
  }
>;

export interface RuntimeInitializationContext {
  port: number;
  host?: string;
  logger: Logger;
  eventBus: EventBus;
  approvalRegistry: ApprovalRegistry;
  environmentSecurityService: Pick<
    EnvironmentSecurityService,
    'verifyCredential' | 'resolveGrantedScope'
  >;
  timers: NodeJS.Timeout[];
  configLoader: {
    loadAppConfig: () => Promise<AppConfig>;
    loadPluginOverrides: () => Promise<Record<string, unknown>>;
    loadACPConfig: () => Promise<unknown>;
    getProjectHomeDir: () => string;
    loadIntegration: (id: string) => Promise<ToolDef>;
    /** archive#895 wave A: resolve an on-disk agent's spec for session-agent capability resolution. */
    loadAgent: (slug: string) => Promise<AgentSpec>;
    /** archive#3063: boot-time built-in integration materialization. */
    saveIntegration: (id: string, def: ToolDef) => Promise<void>;
    hasIntegration: (id: string) => Promise<boolean>;
    /** Agent-record enumeration for boot-time engine adoption. */
    listAgents: () => Promise<Array<{ slug: string }>>;
    mutateAgent: (slug: string, updater: (current: any) => any) => Promise<any>;
  };
  storageAdapter: FileStorageAdapter;
  skillService: SkillService;
  feedbackService: FeedbackService;
  voiceService: VoiceSessionService;
  acpBridge: ACPManager;
  /**
   * archive#1194 (epic archive#1191, slice B): resolves the built-in default
   * agent's engine binding from the LIVE ready-connections list — optional,
   * Undefined means Station's own engine.
   */
  resolveBuiltinEngineBinding?: (
    appConfig: AppConfig,
  ) => Promise<BuiltinAgentEngineBinding | null>;
  migrateBuiltinEngineConnectionSelection?: () => Promise<AppConfig>;
  orchestrationEventStore: EventStore;
  credentialProfileRecoveryAdapter?: CredentialProfileRecoveryAdapter;
  usageAggregator?: UsageAggregator;
  /** archive#3245: lifetime analytics' read of the orchestration substrate. */
  orchestrationUsageRef?: OrchestrationUsageRef;
  monitoringEmitter?: MonitoringEmitter;
  activeAgents: Map<string, Agent>;
  agentMetadataMap: Map<string, unknown>;
  memoryAdapters: Map<string, unknown>;
  agentTools: Map<string, unknown>;
  agentSpecs: Map<string, AgentSpec>;
  mcpConfigs: Map<string, unknown>;
  mcpConnectionStatus: Map<string, { connected: boolean; error?: string }>;
  integrationMetadata: RuntimeIntegrationMetadata;
  toolNameMapping: ToolNameMapping;
  mcpToolProvenanceGeneration: MCPToolProvenanceGeneration;
  /** archive#1834: hook-construction inputs for the default agent's tool gate. */
  agentFixedTokens?: Map<
    string,
    { systemPromptTokens: number; mcpServerTokens: number }
  >;
  agentHooksMap?: Map<string, unknown>;
  resolveUnattendedGrant?: AgentHooksDeps['resolveUnattendedGrant'];
  integrationSecretResolver?: IntegrationSecretResolver;
  resolveAcpPreToolPolicy?: (
    input: ProviderSessionStartInput,
  ) => Promise<StagedPreToolPolicyEvaluator | undefined>;
  toolNameReverseMapping: Map<string, string>;
  eventLog: RuntimeEventLog;
  bedrockAdapter: BedrockAdapter;
  claudeAdapter: ClaudeAdapter;
  codexAdapter: CodexAdapter;
  museAdapter: MuseAdapter;
  ollamaAdapter: OllamaAdapter;
  createVoltAgentInstance: (slug: string) => Promise<Agent>;
  configureRoutes: (app: any) => void;
  reloadAgents: () => Promise<void>;
  captureAgentConfigurationRevisions?: () => {
    provider: number;
    appConfig: number;
  };
  onAgentConfigurationReady?: (revisions: {
    provider: number;
    appConfig: number;
  }) => void;
  guardDefaultAgentTools?: (tools: any[]) => any[];
  replaceTemplateVariables: (text: string, agentName?: string) => string;
  checkBedrockCredentials: () => Promise<boolean>;
  createDefaultSkillRegistryProvider: () => Promise<unknown>;
  runStartupMigrations: (projectHomeDir: string) => Promise<void>;
  startHealthChecks: () => Promise<void>;
  onCoreConfigReady: (core: {
    appConfig: AppConfig;
    framework: IAgentFramework;
    modelCatalog: BedrockModelCatalog;
  }) => void;
  onRouteServicesReady: (services: {
    orchestrationService: OrchestrationService;
    usageAggregator?: UsageAggregator;
  }) => void | Promise<void>;
  onVoltAgentCreated: (voltAgent: import('@voltagent/core').VoltAgent) => void;
}

export function createRuntimeInitializationDeps(
  context: RuntimeInitializationContext,
): InitializeRuntimeDeps {
  return {
    port: context.port,
    host: context.host,
    logger: context.logger,
    eventBus: context.eventBus,
    approvalRegistry: context.approvalRegistry,
    environmentSecurityService: context.environmentSecurityService,
    timers: context.timers,
    configLoader: context.configLoader,
    storageAdapter: context.storageAdapter,
    skillService: context.skillService,
    feedbackService: context.feedbackService,
    voiceService: context.voiceService,
    acpBridge: context.acpBridge,
    resolveBuiltinEngineBinding: context.resolveBuiltinEngineBinding,
    migrateBuiltinEngineConnectionSelection:
      context.migrateBuiltinEngineConnectionSelection,
    orchestrationEventStore: context.orchestrationEventStore,
    credentialProfileRecoveryAdapter: context.credentialProfileRecoveryAdapter,
    usageAggregator: context.usageAggregator,
    orchestrationUsageRef: context.orchestrationUsageRef,
    monitoringEmitter: context.monitoringEmitter,
    activeAgents: context.activeAgents,
    agentMetadataMap: context.agentMetadataMap,
    memoryAdapters: context.memoryAdapters,
    agentTools: context.agentTools,
    agentSpecs: context.agentSpecs,
    mcpConfigs: context.mcpConfigs,
    mcpConnectionStatus: context.mcpConnectionStatus,
    integrationMetadata: context.integrationMetadata,
    toolNameMapping: context.toolNameMapping,
    mcpToolProvenanceGeneration: context.mcpToolProvenanceGeneration,
    toolNameReverseMapping: context.toolNameReverseMapping,
    agentFixedTokens: context.agentFixedTokens,
    agentHooksMap: context.agentHooksMap,
    resolveUnattendedGrant: context.resolveUnattendedGrant,
    integrationSecretResolver: context.integrationSecretResolver,
    resolveAcpPreToolPolicy: context.resolveAcpPreToolPolicy,
    eventLog: context.eventLog,
    bedrockAdapter: context.bedrockAdapter,
    claudeAdapter: context.claudeAdapter,
    codexAdapter: context.codexAdapter,
    museAdapter: context.museAdapter,
    ollamaAdapter: context.ollamaAdapter,
    createVoltAgentInstance: context.createVoltAgentInstance,
    configureRoutes: context.configureRoutes,
    reloadAgents: context.reloadAgents,
    captureAgentConfigurationRevisions:
      context.captureAgentConfigurationRevisions,
    onAgentConfigurationReady: context.onAgentConfigurationReady,
    guardDefaultAgentTools: context.guardDefaultAgentTools,
    replaceTemplateVariables: context.replaceTemplateVariables,
    checkBedrockCredentials: context.checkBedrockCredentials,
    createDefaultSkillRegistryProvider:
      context.createDefaultSkillRegistryProvider,
    runStartupMigrations: context.runStartupMigrations,
    startHealthChecks: context.startHealthChecks,
    onCoreConfigReady: context.onCoreConfigReady,
    onRouteServicesReady: context.onRouteServicesReady,
    onVoltAgentCreated: context.onVoltAgentCreated,
  };
}
