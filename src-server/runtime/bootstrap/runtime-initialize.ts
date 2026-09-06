import type { ACPConfig } from '@kontourai/station-contracts/acp';
import type { AgentSpec } from '@kontourai/station-contracts/agent';
import type { AppConfig } from '@kontourai/station-contracts/config';
import type { BuiltinAgentEngineBinding } from '@kontourai/station-contracts/engine-capability-matrix';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { tenantExecutionContextFromSession } from '@kontourai/station-contracts/tenancy';
import type { ToolDef } from '@kontourai/station-contracts/tool';
import { Agent, type ServerProviderFactory, VoltAgent } from '@voltagent/core';
import type {
  OrchestrationUsageRef,
  UsageAggregator,
} from '../../analytics/usage-aggregator.js';
import {
  BedrockUsagePricingSnapshotCapture,
  type UsagePricingSnapshotCapture,
} from '../../analytics/usage-pricing-snapshot-capture.js';
import {
  loadOrCreateAgentRegistry,
  reconcilePluginEngineConnections,
} from '../../domain/agent-registry.js';
import { DEFAULT_SYSTEM_PROMPT } from '../../domain/config-loader.js';
import type { FileStorageAdapter } from '../../domain/file-storage-adapter.js';
import type { MonitoringEmitter } from '../../monitoring/emitter.js';
import type { ProviderSessionStartInput } from '../../providers/adapter-shape.js';
import { AcpAdapter } from '../../providers/adapters/acp-adapter.js';
import type { BedrockAdapter } from '../../providers/adapters/bedrock-adapter.js';
import type { ClaudeAdapter } from '../../providers/adapters/claude-adapter.js';
import type { CodexAdapter } from '../../providers/adapters/codex-adapter.js';
import type { MuseAdapter } from '../../providers/adapters/muse-adapter.js';
import type { OllamaAdapter } from '../../providers/adapters/ollama-adapter.js';
import {
  createRegistryAwareHasAgent,
  StationAgentAdapter,
} from '../../providers/adapters/station-agent-adapter.js';
import { BedrockLLMProvider } from '../../providers/llm/bedrock-llm-provider.js';
import { BedrockModelCatalog } from '../../providers/llm/bedrock-models.js';
import {
  isBedrockRegionId,
  resolveBedrockRegion,
} from '../../providers/llm/bedrock-region.js';
import { BuiltinACPConnectionRegistryProvider } from '../../providers/llm/defaults.js';
import { resolveRegistrySource } from '../../providers/registries/default-registry.js';
import { JsonManifestRegistryProvider } from '../../providers/registries/json-manifest-registry.js';
import { registerManifestRegistryProvider } from '../../providers/registries/register-manifest-registry.js';
import {
  createProviderAdapterRegistry,
  listProviders,
  registerACPConnectionRegistryProvider,
  registerProviderAdapters,
  registerSkillRegistryProvider,
} from '../../providers/registries/registry.js';
import { ClaudeTranscriptSessionSource } from '../../providers/sessions/claude-transcript-session-source.js';
import { publicIdentityAgentSetView } from '../../routes/agents/runtime-agent-identity.js';
import { attachVoiceWebSocket } from '../../routes/operations/voice.js';
import { getCachedUser } from '../../routes/system/auth.js';
import {
  assertRuntimeHttpRouteCoverage,
  credentialAuthorizedForScope,
  PAIRING_WS_SCOPES,
} from '../../security/pairing-route-scopes.js';
import { RuntimeAuthFailureLimiter } from '../../security/runtime-request-security.js';
import type { ACPManager } from '../../services/acp/acp-bridge.js';
import { getAgentPolicyService } from '../../services/agents/agent-policy-service.js';
import { ApprovalGuardianService } from '../../services/approvals/approval-guardian.js';
import type { ApprovalRegistry } from '../../services/approvals/approval-registry.js';
import { ConsoleBridgeService } from '../../services/evidence/console-bridge-service.js';
import { configurePlatformMutationGate } from '../../services/evidence/platform-mutation-gate.js';
import { VeritasReadinessService } from '../../services/evidence/veritas-readiness-service.js';
import { WorkflowSidecarService } from '../../services/evidence/workflow-sidecar-service.js';
import type { FeedbackService } from '../../services/feedback/feedback-service.js';
import { FlowRunService } from '../../services/flow/flow-run-service.js';
import {
  createEnvironmentRuntimeResourcePostureProbe,
  type RuntimeResourcePostureProbe,
} from '../../services/infra/resource-posture.js';
import {
  AttachedSessionFollowService,
  resolveAttachedProjectRoots,
} from '../../services/orchestration/attached-session-follow-service.js';
import type { CredentialProfileRecoveryAdapter } from '../../services/orchestration/credential-recovery-module.js';
import { EventBus } from '../../services/orchestration/event-bus.js';
import { EventStore } from '../../services/orchestration/event-store.js';
import type { MCPToolProvenanceGeneration } from '../../services/orchestration/mcp-tool-provenance.js';
import {
  type InterruptedTurnMemoryAdapter,
  OrchestrationService,
} from '../../services/orchestration/orchestration-service.js';
import {
  builtinStationAgentSpec,
  createSessionAgentResolver,
} from '../../services/orchestration/session-agent-resolution.js';
import { ProjectResourceResolver } from '../../services/projects/project-resource-resolver.js';
import { observeCwdShadow } from '../../services/projects/project-resource-shadow.js';
import { resolveProjectWorkspacePath } from '../../services/projects/project-workspace-path.js';
import { GitHubPullRequestProvider } from '../../services/pull-requests/github-pull-request-provider.js';
import { GitLabPullRequestProvider } from '../../services/pull-requests/gitlab-pull-request-provider.js';
import { NativeDeclaredPullRequestResolver } from '../../services/pull-requests/native-declared-pull-request-resolver.js';
import type { IntegrationSecretResolver } from '../../services/secrets/secret-binding-administration.js';
import type { EnvironmentSecurityService } from '../../services/ssh/environment-security-service.js';
import { registerObservableGauges } from '../../telemetry/metrics.js';
import { applyConfiguredLogLevel, type Logger } from '../../utils/logger.js';
import type { VoiceSessionService } from '../../voice/voice-session.js';
import type { AgentHooksDeps } from '../agents/agent-hooks.js';
import type { StagedPreToolPolicyEvaluator } from '../agents/pre-tool-policy.js';
import { initializeRuntimeAgents } from '../agents/runtime-agent-registry.js';
import {
  bootstrapRuntimeDefaultAgent,
  materializeBuiltinIntegrations,
} from '../agents/runtime-default-agent.js';
import type { RuntimeEventLog } from '../conversation/runtime-event-log.js';
import { safeSanitizeUIBlockEventProvenance } from '../conversation/ui-block-provenance.js';
import { withPrivateOrchestrationAdapter } from '../frameworks/orchestration-adapter-registry.js';
import { StrandsFramework } from '../frameworks/strands-adapter.js';
import { VoltAgentFramework } from '../frameworks/voltagent-adapter.js';
import {
  type HonoServerConfig,
  honoServer,
} from '../frameworks/voltagent-hono-runtime.js';
import * as MCPManager from '../mcp/mcp-manager.js';
import {
  mintStationControlMcpHeaderAuth,
  revokeStationControlMcpToken,
} from '../mcp/station-control-mcp-token.js';
import { loadRuntimePluginAssets } from '../plugins/runtime-plugin-assets.js';
import {
  createRuntimeFrameworkModel,
  resolveDefaultManagedModelHint,
} from '../plugins/runtime-provider-resolution.js';
import { SC_READ_ONLY_TOOLS } from '../tools/runtime-control-tools.js';
import type { IAgentFramework } from '../types.js';
import {
  createEventStoreWorkItemPrincipalLiveness,
  WorkItemCapture,
} from '../work-item-capture.js';
import { acpResumeCursorSupport } from './acp-resume-cursor-support.js';
import { composeAgentExecutionConfigLoader } from './agent-execution-config-loader.js';
import {
  scheduleRuntimeDailyReload,
  scheduleRuntimeEngineSpawnTmpReaping,
  scheduleRuntimePluginUpdateCheck,
  startRuntimeACPConnections,
} from './runtime-background-tasks.js';
import {
  checkOllamaAvailability,
  prepareRuntimeStartup,
} from './runtime-startup.js';
import {
  isHostedTenantExecutionRequired,
  loadHostedTenantRegistryFromEnvironment,
} from './runtime-tenant-context.js';
import { isManagedChatOrchestrationFeatureEnabled } from './station-features.js';

type RuntimeFramework = VoltAgentFramework | StrandsFramework;

export interface InitializeRuntimeDeps {
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
  skillService: {
    discoverSkills: (...args: any[]) => Promise<void>;
    /** archive#895 wave A: resolve a skill id to its installed on-disk directory. */
    getSkill: (id: string) => Promise<{ path?: string }>;
  };
  feedbackService: FeedbackService;
  voiceService: VoiceSessionService;
  acpBridge: ACPManager;
  /**
   * archive#1194 (epic archive#1191, slice B): resolves the built-in default
   * agent's engine binding from the LIVE ready-connections list — optional
   * so installations/tests that don't wire it see no behavior change
   * (`undefined` binding == Station's own engine, byte-identical).
   */
  resolveBuiltinEngineBinding?: (
    appConfig: AppConfig,
  ) => Promise<BuiltinAgentEngineBinding | null>;
  /** Reconcile the built-in role after background ACP readiness settles. */
  onACPConnectionsReady?: () => void | Promise<void>;
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
  mcpCustody: import('@kontourai/station-shared/mcp').MCPLocalConnectionCustody;
  mcpConnectionStatus: Map<string, { connected: boolean; error?: string }>;
  integrationMetadata: Map<
    string,
    { type: string; transport?: string; toolCount?: number }
  >;
  toolNameMapping: Map<string, unknown>;
  toolNameReverseMapping: Map<string, string>;
  mcpToolProvenanceGeneration: MCPToolProvenanceGeneration;
  /** archive#1834: hook-construction inputs for the default agent's tool gate. */
  agentFixedTokens?: Map<
    string,
    { systemPromptTokens: number; mcpServerTokens: number }
  >;
  agentHooksMap?: Map<string, unknown>;
  /** Shared bootstrap resolver for exact unattended-tool grants. */
  resolveUnattendedGrant?: AgentHooksDeps['resolveUnattendedGrant'];
  integrationSecretResolver?: IntegrationSecretResolver;
  resolveAcpPreToolPolicy?: (
    input: ProviderSessionStartInput,
  ) => Promise<StagedPreToolPolicyEvaluator | undefined>;
  modelCatalog?: BedrockModelCatalog;
  framework?: RuntimeFramework;
  voltAgent?: VoltAgent;
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
    selectedPackageFingerprint?: string;
  };
  onAgentConfigurationReady?: (revisions: {
    provider: number;
    appConfig: number;
    selectedPackageFingerprint?: string;
  }) => void;
  guardDefaultAgentTools?: (tools: any[]) => any[];
  replaceTemplateVariables: (text: string, agentName?: string) => string;
  checkBedrockCredentials: () => Promise<boolean>;
  createDefaultSkillRegistryProvider: () => Promise<unknown>;
  runStartupMigrations: (projectHomeDir: string) => Promise<void>;
  startHealthChecks: () => Promise<void>;
  /**
   * Invoked as soon as `appConfig`/`framework`/`modelCatalog` are resolved —
   * *before* `initializeRuntimeAgents()` or `new VoltAgent(...)` run. Lets
   * `StationRuntime` assign its own fields early so closures bound at
   * construction time (e.g. `createVoltAgentInstance`, `configureRoutes`)
   * never observe them as `undefined` mid-initialize (archive#208).
   */
  onCoreConfigReady: (core: {
    appConfig: AppConfig;
    framework: IAgentFramework;
    modelCatalog: BedrockModelCatalog;
  }) => void;
  /** Publishes services captured by route registration before VoltAgent calls configureFullApp. */
  onRouteServicesReady: (services: {
    orchestrationService: OrchestrationService;
    usageAggregator?: UsageAggregator;
  }) => void | Promise<void>;
  onVoltAgentCreated: (voltAgent: VoltAgent) => void;
}

interface InitializeRuntimeResult {
  appConfig: AppConfig;
  framework: RuntimeFramework;
  orchestrationService: OrchestrationService;
  resourcePosture: RuntimeResourcePostureProbe;
  attachedSessionFollowService: AttachedSessionFollowService;
  consoleBridgeService: ConsoleBridgeService;
  modelCatalog: BedrockModelCatalog;
  usageAggregator?: UsageAggregator;
  voltAgent: VoltAgent;
  voiceWsAttached: boolean;
}

/**
 * Starts boot-time background work whose lifetime must not depend on ACP
 * readiness. Keep this as the runtime-initialize seam: ACP config or registry
 * failures are detached and logged by `startRuntimeACPConnections`, while the
 * engine-spawn reaper is armed synchronously for every boot.
 */
export function initializeRuntimeBackgroundTasks(
  deps: Pick<
    InitializeRuntimeDeps,
    'timers' | 'logger' | 'configLoader' | 'acpBridge' | 'onACPConnectionsReady'
  >,
): void {
  const { timers, logger, configLoader, acpBridge, onACPConnectionsReady } =
    deps;

  scheduleRuntimeEngineSpawnTmpReaping({ timers, logger });
  startRuntimeACPConnections({
    loadACPConfig: async () => (await configLoader.loadACPConfig()) as any,
    loadRegisteredRuntimeConnectionIds: async () => {
      const registry = await loadOrCreateAgentRegistry(configLoader as any);
      return new Set(registry.engineConnections.map(({ id }) => String(id)));
    },
    acpBridge,
    logger,
    onReady: onACPConnectionsReady,
  });
}

export async function initializeRuntime(
  deps: InitializeRuntimeDeps,
): Promise<InitializeRuntimeResult> {
  const {
    port,
    host,
    logger,
    eventBus,
    approvalRegistry,
    timers,
    configLoader,
    storageAdapter,
    skillService,
    feedbackService,
    voiceService,
    acpBridge,
    orchestrationEventStore,
    usageAggregator,
    orchestrationUsageRef,
    monitoringEmitter,
    activeAgents,
    agentMetadataMap,
    memoryAdapters,
    agentTools,
    mcpConfigs,
    mcpConnectionStatus,
    integrationMetadata,
    toolNameMapping,
    toolNameReverseMapping,
    eventLog,
    bedrockAdapter,
    claudeAdapter,
    codexAdapter,
    museAdapter,
    ollamaAdapter,
    createVoltAgentInstance,
    configureRoutes,
    reloadAgents,
    replaceTemplateVariables,
    checkBedrockCredentials,
    createDefaultSkillRegistryProvider,
    runStartupMigrations,
    startHealthChecks,
    onCoreConfigReady,
    onRouteServicesReady,
    onVoltAgentCreated,
  } = deps;

  logger.debug('Initializing Station Runtime...');

  const appConfig = await configLoader.loadAppConfig();
  // The orchestration service starts before the model catalog is composed.
  // Keep this tiny forwarding seam stable, then install the real catalog
  // authority below before adapter streams can emit usage events.
  let usagePricingSnapshotCapture: UsagePricingSnapshotCapture | undefined;
  const features = (process.env.STATION_FEATURES || '')
    .split(',')
    .filter(Boolean);
  if (features.includes('strands-runtime')) {
    appConfig.runtime = 'strands';
  }
  // archive#980: default OFF. In-memory only (never persisted to
  // config/app.json) — mirrors the `strands-runtime` flag just above.
  // **Boot-time snapshot only — NOT the source of truth after this point.**
  // `this.appConfig` (station-runtime.ts) is wholesale reassigned from a
  // fresh disk load on every `reloadAgentsFromDisk()`/`reloadDefaultAgent()`
  // (which never carries this non-persisted field), so any live reader must
  // go through `isManagedChatOrchestrationFeatureEnabled()`
  // (`station-features.ts`), never `appConfig.managedChatOrchestration`
  // directly — see `createConfigRoutes`'s `getManagedChatOrchestrationEnabled`
  // param, which does exactly that.
  appConfig.managedChatOrchestration = isManagedChatOrchestrationFeatureEnabled(
    process.env,
  );

  const runtime = appConfig.runtime || 'voltagent';
  const framework: RuntimeFramework =
    runtime === 'strands' ? new StrandsFramework() : new VoltAgentFramework();

  logger.info('App config loaded', {
    region: appConfig.region,
    model: appConfig.defaultModel,
    runtime,
  });

  applyConfiguredLogLevel(appConfig.logLevel, logger);

  const acpAdapter = new AcpAdapter({
    getConnections: async () =>
      ((await configLoader.loadACPConfig()) as ACPConfig).connections,
    logger,
    resolveToolServer: (id) =>
      configLoader.loadIntegration(id).catch(() => null),
    resolvePreToolPolicy: deps.resolveAcpPreToolPolicy,
    // archive#1684: the wire-safe substitution for the built-in
    // station-control server on the ACP channel (see
    // acp-mcp-passthrough.ts's header comment). Same per-session,
    // 12-hour-TTL, station-control-scoped token the Codex closure in
    // station-runtime.ts mints — differing only in the channel it is
    // carried on: the URL is built WITHOUT a token
    // (`buildStationControlMcpHeaderUrl`) because the credential rides an
    // `Authorization: Bearer` header instead. `port` is this instance's
    // actually-bound port, the same value the station-control MCP route is
    // served on. The adapter calls this only after its own live
    // `mcpCapabilities.http` gate says yes.
    //
    // The mint itself is `mintStationControlMcpHeaderAuth` rather than an
    // inline body (review fix): an inline closure here was the one
    // production site for the per-session/revocable/bounded-TTL properties
    // and no test could reach it.
    mintStationControlMcpAuth: (threadId, tenantExecutionContext) =>
      mintStationControlMcpHeaderAuth(port, threadId, tenantExecutionContext),
    revokeStationControlMcpAuth: (threadId: string) =>
      revokeStationControlMcpToken(threadId),
  });
  let stationAgentsReady = false;
  const stationAgentAdapter = new StationAgentAdapter({
    apiBase: `http://127.0.0.1:${port}`,
    // archive#1049: the active set alone under-recognizes agents the real
    // chat route can still report on (a persisted agent whose model failed
    // to resolve at registration is "known" to /chat, which returns a
    // specific 409 — not "unknown"). This is a strict widening (accept-more,
    // never accept-less), so it is safe for BOTH paths that reach this gate:
    // the managed-chat-orchestration flip AND the always-on `delegateTask`
    // Station-agent branch (which uses provider 'station-agent' regardless of
    // the flag) — not flip-only, contrary to what the flag's name suggests.
    // archive#1992: the active set keys the built-in default agent under the
    // internal runtime key 'default' (runtime-default-agent.ts), while every
    // caller reaching this gate uses the public slug 'station' — and the
    // registry-declared default agent has no persisted file for the loader
    // fallback to find. View the set through public identity so 'station'
    // resolves; the reserved internal key stays unrecognized.
    hasAgent: createRegistryAwareHasAgent(
      publicIdentityAgentSetView(activeAgents),
      (agentId) => configLoader.loadAgent(agentId),
    ),
    isAgentRegistryReady: () => stationAgentsReady,
    approvalRegistry,
    eventBus,
  });
  registerProviderAdapters(
    [claudeAdapter, codexAdapter, museAdapter, acpAdapter, stationAgentAdapter],
    { builtin: true, source: 'station-core' },
  );
  registerACPConnectionRegistryProvider(
    new BuiltinACPConnectionRegistryProvider(),
    'core',
    true,
  );

  const flowRunService = new FlowRunService();
  const hostedTenantRegistry = loadHostedTenantRegistryFromEnvironment();
  const publicAdapterRegistry = createProviderAdapterRegistry();
  // archive#895 wave A: resolve per-agent capability delivery (ACP tool servers,
  // Claude skills) into a session's ResolvedAgentDefinition before dispatch.
  // Fail-open closures, mirroring the ClaudeAdapter skills wiring above:
  // an unknown agent/tool-server/skill degrades to "not resolved", never a
  // session-start failure.
  const loadSessionAgentSpec = (slug: string) =>
    configLoader.loadAgent(slug).catch(() => null);
  const resolveSessionAgent = createSessionAgentResolver({
    loadAgentSpec: loadSessionAgentSpec,
    resolveToolServer: (id) =>
      configLoader.loadIntegration(id).catch(() => null),
    resolveSkillDir: async (id) => {
      try {
        const skill = await skillService.getSkill(id);
        return skill.path || null;
      } catch {
        return null;
      }
    },
    logger,
  });
  // archive#1745: the `providerRegistrationSettled` barrier that used to be
  // built here is gone. Plugin-contributed adapters still do not exist in
  // `publicAdapterRegistry` until `loadRuntimePluginAssets` (below) has run,
  // several awaits AFTER `orchestrationService.initialize()` — but nothing
  // now takes an irreversible action on that registry read. The orphan
  // question is projected at read time and carried on the wire as
  // `OrchestrationSessionSummary.answerability` (ADR 0012), so a late-
  // registering plugin's sessions simply read as answerable again on the
  // next read, with no ordering for anyone to get wrong and no repair to
  // run. The barrier's incidental blast radius went with it:
  // `recoveryCoordinator.reconcile()` is no longer delayed behind plugin
  // asset loading it never depended on.
  const adoptionLedger = orchestrationEventStore.createAdoptionLedger();
  // The same probe owns foreground engine admission, scheduler admission, and
  // the system-status projection. The observation is diagnostics-only;
  // orchestration retains this controller solely for its engine-start lease.
  const resourcePosture = createEnvironmentRuntimeResourcePostureProbe();
  // Private owner point-read seam for native declared PR outputs. It is
  // intentionally distinct from the public Pull Requests route, whose
  // context resolver requires a pushed branch/base for interactive actions.
  const nativeDeclaredPullRequestResolver =
    new NativeDeclaredPullRequestResolver({
      providers: () => [
        new GitHubPullRequestProvider(),
        new GitLabPullRequestProvider(),
      ],
    });
  const orchestrationService = new OrchestrationService({
    // Bedrock and Ollama are Station-engine model-provider implementations,
    // not public engine connections. Keep them available for dispatch without
    // publishing them through the registry that feeds New Chat inventory.
    adapterRegistry: withPrivateOrchestrationAdapter(publicAdapterRegistry, [
      bedrockAdapter,
      ollamaAdapter,
    ]),
    eventBus,
    eventStore: orchestrationEventStore,
    pricingSnapshotCapture: {
      capture: async (input) => usagePricingSnapshotCapture?.capture(input),
    },
    turnDeduplicator: orchestrationEventStore.createTurnDeduplicator(),
    // #764: a user-requested continuation of a stopped ACP conversation must
    // know BEFORE the child start whether the connection's observed
    // initialize handshake advertised `loadSession`; without it the resume
    // cursor path is a start the ACP adapter must fail-closed (A3), leaving
    // a durable reservation the supervision read then has to look through.
    // `undefined` (no handshake evidence, or a non-ACP provider) keeps the
    // cursor path — the adapter's own ruling stays authoritative there.
    // #764: derivation extracted (and unit-tested) in
    // acp-resume-cursor-support.ts — keyed on the observed handshake, not on
    // the presence of capabilities.
    resumeCursorSupport: acpResumeCursorSupport(acpBridge),
    adoptionLedger,
    credentialProfileRecoveryAdapter: deps.credentialProfileRecoveryAdapter,
    requireTenantExecutionContext: isHostedTenantExecutionRequired,
    validateRecoveredTenantExecutionContext: (context) => {
      if (!hostedTenantRegistry) return context;
      if (
        !context ||
        !hostedTenantRegistry.tenants.some(
          (tenant) => tenant.id === context.tenantId,
        )
      ) {
        return undefined;
      }
      return tenantExecutionContextFromSession(context);
    },
    // Station currently exposes one local account. Keep legacy, pre-owner
    // sessions readable only through this explicit compatibility mode; a
    // multi-user runtime must migrate them and switch this to `deny`.
    ownerlessSessionAccess: 'single-user-compat',
    // #749: rows written before principal ownership retain this Station
    // process's former OS alias. SessionAuthorization admits it only for the
    // request-derived home-possession local-operator principal.
    legacyPersonalOwner: getCachedUser().alias,
    flowRunService,
    resourcePosture,
    listProjects: () => storageAdapter.listProjects(),
    nativeDeclaredPullRequestResolver,
    // archive#1501: shadow `resolveProjectResource` against the
    // session-cwd seam over REAL traffic before slice 3c flips it. Dispatched
    // and discarded on purpose — `observeCwdShadow` never resolves, rejects,
    // or delays a session start (project-resource-shadow.ts decision 1).
    observeCwdShadow: (sample) => {
      observeCwdShadow(sample, {
        logger,
        // The seam reads THIS home's project store; so must the shadow.
        homeDir: configLoader.getProjectHomeDir(),
      }).catch(() => {
        // `observeCwdShadow` already swallows the resolution's own failures;
        // this catches the observer machinery itself (a metric or logger
        // throw) so a shadow can never surface as an unhandled rejection.
      });
    },
    veritasReadinessService: new VeritasReadinessService(),
    agentPolicyService: getAgentPolicyService(logger),
    workflowSidecarService: new WorkflowSidecarService({ logger }),
    resolveSessionAgent,
    loadAgentPresentation: async (slug) => {
      const spec =
        (await loadSessionAgentSpec(slug)) ?? builtinStationAgentSpec(slug);
      return spec
        ? { name: spec.name, ...(spec.icon ? { icon: spec.icon } : {}) }
        : undefined;
    },
    // archive#2959: per-agent turn-stall window override. Unlike
    // `resolveSessionAgent` above, applies to every provider — not gated by
    // `sessionDeliveryChannels`/`ENGINE_CAPABILITY_MATRICES`.
    loadAgentExecutionConfig: composeAgentExecutionConfigLoader(configLoader),
    monitoringEmitter,
    // archive#4080: the interrupted-turn consumer's ONLY use of this
    // map is the narrow `InterruptedTurnMemoryAdapter` seam — see
    // `OrchestrationServiceOptions.memoryAdapters`'s doc for why
    // orchestration accepts it structurally rather than typed as
    // `FileMemoryAdapter`. `FileMemoryAdapter` implements every member of
    // that seam (`addMessage`/`getMessages`/`getConversation`), so this cast
    // is a narrowing, not a fabrication.
    memoryAdapters: memoryAdapters as unknown as Map<
      string,
      InterruptedTurnMemoryAdapter
    >,
    logger,
  });
  orchestrationService.initialize();

  // archive#1501, seam S5 (`docs/design/portable-project-identity.md`
  // §2.2.1): where the attached-session reverse map's candidate roots come
  // from. The archive#1462 tie-break itself is untouched, and
  // `resolveAttachedProjectRoots` (which owns the never-drop-a-candidate rule
  // and carries its rationale) is the only thing this wiring decides.
  const attachedProjectResourceResolver = new ProjectResourceResolver({
    homeDir: configLoader.getProjectHomeDir(),
  });
  const attachedSessionFollowService = new AttachedSessionFollowService({
    sources: [new ClaudeTranscriptSessionSource()],
    eventStore: orchestrationEventStore,
    adoptionLedger,
    eventBus,
    logger,
    listProjects: () => storageAdapter.listProjects(),
    resolveProjectRoots: () =>
      resolveAttachedProjectRoots(storageAdapter.listProjects(), (slug) =>
        resolveProjectWorkspacePath(slug, {
          resolver: attachedProjectResourceResolver,
        }),
      ),
  });

  // Platform-mutation gate (S3 item 4): mutating station-control tool calls
  // in a policy-opted workspace are audited (canonical `platform.mutation`
  // events + Flow evidence when a gated run is active) and profile-gated.
  // Non-opted workspaces see zero behavior change.
  configurePlatformMutationGate({
    policyService: getAgentPolicyService(logger),
    flowRunService,
    emitEvent: (event) => {
      // archive#1399 fix round 2, B3 (writer-inventory ratchet): a
      // `platform.mutation` event's own construction never sets
      // `method: 'tool.completed'`, so this is a no-op today — routed
      // through the safe sanitizer anyway so every `appendEvent`/
      // `appendEventIfAbsent` call site in the tree is uniformly covered,
      // with no per-file exemption for the writer-inventory test to keep
      // correct as this closure evolves.
      const sanitized = safeSanitizeUIBlockEventProvenance(
        event,
        (message, meta) => logger.warn(message, meta),
      );
      orchestrationEventStore.appendEvent(sanitized);
      eventBus.emit(SERVER_EVENTS.ORCHESTRATION_EVENT, { event: sanitized });
    },
    logger,
  });

  // Console bridge (S4 item 1): when configured via STATION_CONSOLE_HUB_URL
  // and/or STATION_CONSOLE_FILE_SINK, Station's canonical session/run events
  // are derived into deterministic `kontour.console.event` records and
  // delivered to the Kontour Console hub and/or workspace `.kontour/events/`
  // files. Off by default (start() is a no-op without config); fail-soft —
  // Console being down never affects sessions. Retained (not fire-and-forget)
  // and returned below so `shutdownRuntimeServices` can `stop()` it (review
  // fix, HIGH, archive#1093 Part B fix round) — its coalescing worker now
  // owns a real timer that must be disposed on shutdown, not just abandoned.
  const consoleBridgeService = new ConsoleBridgeService({
    eventBus,
    eventStore: orchestrationEventStore,
    logger,
  });
  consoleBridgeService.start();

  // Falls back to the bundled starter manifest when nothing is configured, so a
  // fresh install can browse and install working examples without first being
  // told to point at a registry.
  const registrySource = resolveRegistrySource(appConfig.registryUrl);
  if (registrySource) {
    const registryProvider = new JsonManifestRegistryProvider(
      registrySource.source,
      configLoader.getProjectHomeDir(),
      undefined,
      logger,
    );
    registerManifestRegistryProvider(registryProvider, registrySource.origin);
    logger.info('JSON manifest registry configured', {
      url: registrySource.source,
      origin: registrySource.origin,
    });
  }

  // archive#1557: the catalogue and the LLM provider must use the region the
  // chat turn will use, resolved once (`providers/llm/bedrock-region.ts`).
  const bedrockRegionResolution = resolveBedrockRegion({
    configRegion: appConfig.region,
    env: process.env,
  });
  // A malformed AWS_REGION is discarded by the resolver, but a malformed
  // STORED region is not — silently dropping a setting the user saved is its
  // own dishonesty, so it reaches `BedrockModelCatalog`, whose constructor
  // throws. That throw names neither the field nor where the value came from,
  // which turns a one-character typo in a hand-edited config into an
  // unexplained failure to start (round-3 review, L8). Fail with the fact.
  if (!isBedrockRegionId(bedrockRegionResolution.region)) {
    throw new Error(
      `Station cannot start: the AWS region "${bedrockRegionResolution.region}" is not a valid region id. ` +
        `It came from ${
          bedrockRegionResolution.source === 'config'
            ? 'the "region" setting in your Station config'
            : `the ${bedrockRegionResolution.envVar} environment variable`
        }. Expected a form like "us-east-1".`,
    );
  }
  const bedrockRegion = bedrockRegionResolution.region;
  const modelCatalog = new BedrockModelCatalog(bedrockRegion);
  usagePricingSnapshotCapture = new BedrockUsagePricingSnapshotCapture(
    modelCatalog,
    bedrockRegion,
  );
  bedrockAdapter.configureLaunchability({
    modelCatalog,
    llm: new BedrockLLMProvider({ region: bedrockRegion }),
  });
  logger.debug('Bedrock model catalog initialized');

  await loadRuntimePluginAssets({
    packageMcpJournal:
      orchestrationEventStore.createPackageMcpAdmissionJournal(),
    logger,
    projectHomeDir: configLoader.getProjectHomeDir(),
    loadPluginOverrides: () => configLoader.loadPluginOverrides(),
  });

  // Plugin/native Adapter identity exists only after the asset composition

  // archive#208: hand appConfig/framework/modelCatalog to StationRuntime immediately —
  // initializeRuntimeAgents() (below) and new VoltAgent(...)/configureRoutes()
  // both need them mid-flight, through closures bound at StationRuntime
  // construction time, well before initializeRuntime() itself returns.
  onCoreConfigReady({ appConfig, framework, modelCatalog });

  const nextUsageAggregator = await prepareRuntimeStartup({
    projectHomeDir: configLoader.getProjectHomeDir(),
    appConfig,
    storageAdapter,
    configLoader,
    skillService,
    logger,
    timers,
    createUsageAggregator: usageAggregator ? () => usageAggregator : undefined,
    orchestrationUsageRef,
    runStartupMigrations,
    checkBedrockCredentials:
      process.env.STATION_E2E_FIRST_RUN === '1'
        ? async () => false
        : checkBedrockCredentials,
    checkOllamaAvailability:
      process.env.STATION_E2E_FIRST_RUN === '1'
        ? async () => false
        : checkOllamaAvailability,
    registerSkillRegistryProvider,
    createDefaultSkillRegistryProvider,
  });

  scheduleRuntimeDailyReload({
    timers,
    reloadAgents,
  });

  // `new VoltAgent(...)` synchronously invokes configureFullApp. Publish every
  // service that configureRoutes captures before constructing it.
  await onRouteServicesReady({
    orchestrationService,
    usageAggregator: nextUsageAggregator,
  });

  // archive#3063: the ONE unconditional materialization of the built-in
  // integration files (`station-control`, `station-docs`) per process
  // lifetime — at boot, before the first agent construction resolves either
  // id. The persisted shape is instance-independent (no dist path, no port —
  // see `createRuntimeSelfIntegration`), so on a converged home the
  // byte-identical save skip makes this a zero-write no-op, and a home
  // carrying the pre-#3063 identity-baked files is rewritten once to the
  // stable form. Reload paths (`bootstrapRuntimeDefaultAgent`) deliberately
  // never rewrite an existing file — a reload that mutates its own watched
  // inputs is the archive#1588/#3063 reload-loop anti-pattern.
  await materializeBuiltinIntegrations(deps.configLoader);

  const configurationBefore = deps.captureAgentConfigurationRevisions?.();
  const agents = await initializeRuntimeAgents({
    configLoader: deps.configLoader as any,
    logger,
    bootstrapDefaultAgent: async () =>
      (await bootstrapRuntimeDefaultAgent({
        appConfig,
        builtinEngineBinding:
          await deps.resolveBuiltinEngineBinding?.(appConfig),
        configLoader: deps.configLoader as any,
        framework,
        logger,
        usageAggregator: nextUsageAggregator,
        defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT,
        autoApproveTools: SC_READ_ONLY_TOOLS,
        replaceTemplateVariables,
        resolveDefaultModelHint: () =>
          resolveDefaultManagedModelHint(
            appConfig,
            storageAdapter.listProviderConnections(),
          ),
        createModel: async (spec) =>
          createRuntimeFrameworkModel(spec, {
            framework,
            appConfig,
            projectHomeDir: configLoader.getProjectHomeDir(),
            modelCatalog,
            listProviderConnections: () =>
              storageAdapter.listProviderConnections(),
          }),
        loadAgentTools: async (slug, spec, provenanceGeneration) =>
          MCPManager.loadAgentTools(
            slug,
            spec,
            deps.configLoader as any,
            mcpConfigs as any,
            mcpConnectionStatus,
            integrationMetadata,
            toolNameMapping as any,
            toolNameReverseMapping,
            logger,
            port,
            provenanceGeneration!,
            deps.integrationSecretResolver,
            deps.mcpCustody,
          ),
        guardTools: deps.guardDefaultAgentTools,
        activeAgents: activeAgents as any,
        agentTools: agentTools as any,
        memoryAdapters: memoryAdapters as any,
        agentMetadataMap: agentMetadataMap as any,
        toolNameMapping: toolNameMapping as any,
        mcpToolProvenanceGeneration: deps.mcpToolProvenanceGeneration,
        agentFixedTokens: deps.agentFixedTokens,
        agentHooksMap: deps.agentHooksMap as any,
        workItemCapture: new WorkItemCapture(
          orchestrationEventStore,
          createEventStoreWorkItemPrincipalLiveness(orchestrationEventStore),
        ),
        resolveUnattendedGrant: deps.resolveUnattendedGrant,
        // archive#1834 review round 2: the same guardian composition
        // runtime-agent-builder gives every persisted agent.
        approvalGuardian: new ApprovalGuardianService({
          appConfig,
          framework,
          listProviderConnections: () =>
            storageAdapter.listProviderConnections(),
          logger,
          modelCatalog,
          projectHomeDir: configLoader.getProjectHomeDir(),
        }),
      })) as Record<string, Agent>,
    createVoltAgentInstance,
    activeAgents: activeAgents as any,
    agentMetadataMap: agentMetadataMap as any,
  });
  const configurationAfter = deps.captureAgentConfigurationRevisions?.();
  if (
    configurationBefore &&
    configurationAfter &&
    (configurationBefore.provider !== configurationAfter.provider ||
      configurationBefore.appConfig !== configurationAfter.appConfig ||
      configurationBefore.selectedPackageFingerprint !==
        configurationAfter.selectedPackageFingerprint)
  ) {
    throw new Error(
      'Runtime configuration changed while startup agents were being constructed.',
    );
  }
  if (configurationBefore) {
    deps.onAgentConfigurationReady?.(configurationBefore);
  }
  stationAgentsReady = true;

  const serverConfig = {
    port,
    // Station owns terminal and voice WebSockets on dedicated authenticated
    // listeners. Do not expose the framework's separately-upgraded socket,
    // which cannot inherit Hono's direct-peer boundary.
    enableWebSocket: false,
    ...(host ? { hostname: host } : {}),
    // VoltAgent normally registers its root invoke/chat/stream routes before
    // configureApp. Full-app composition lets Station install its two exact
    // public routes and centralized fail-closed boundary first, then mount
    // every framework-owned surface behind it.
    configureFullApp: ({
      app,
      routes,
      middlewares,
    }: Parameters<NonNullable<HonoServerConfig['configureFullApp']>>[0]) => {
      configureRoutes(app);
      middlewares.landingPage();
      routes.agents();
      routes.workflows();
      routes.tools();
      routes.logs();
      routes.updates();
      routes.observability();
      routes.memory();
      routes.triggers();
      routes.mcp();
      routes.a2a();
      routes.ui();
      routes.doc();
      // archive#2000: inspect Hono's live registration list only after both
      // Station and VoltAgent framework surfaces have mounted. A missing
      // capability entry is a startup error, never an implicit public route.
      assertRuntimeHttpRouteCoverage(app.routes);
    },
  };

  let resolveServerStartup!: () => void;
  let rejectServerStartup!: (reason?: unknown) => void;
  const serverStartup = new Promise<void>((resolve, reject) => {
    resolveServerStartup = resolve;
    rejectServerStartup = reject;
  });
  // VoltAgent observes start failures in its own fire-and-forget chain; attach
  // Station's handler immediately as well, before awaiting VoltAgent.ready.
  void serverStartup.catch(() => {});
  let serverStartInvoked = false;
  const createServer = honoServer(serverConfig);
  const trackedServerFactory: ServerProviderFactory = (serverDeps) => {
    const provider = createServer(serverDeps);
    return {
      isRunning: () => provider.isRunning(),
      stop: () => provider.stop(),
      start: async () => {
        serverStartInvoked = true;
        try {
          const result = await provider.start();
          resolveServerStartup();
          return result;
        } catch (error) {
          rejectServerStartup(error);
          throw error;
        }
      },
    };
  };

  const voltAgent = new VoltAgent({
    agents,
    logger: logger as any,
    server: trackedServerFactory,
  });
  onVoltAgentCreated(voltAgent);
  await voltAgent.ready;
  if (serverStartInvoked) await serverStartup;
  if (voltAgent.initError) throw voltAgent.initError;

  registerObservableGauges({
    activeAgents: () => activeAgents.size,
    mcpConnections: () => mcpConnectionStatus.size,
  });

  await eventLog.loadRecentEvents();
  await startHealthChecks();

  feedbackService.setAnalyzeCallback(async (prompt: string) => {
    const agent =
      activeAgents.get('default') || activeAgents.values().next().value;
    if (!agent) throw new Error('No agents available for feedback analysis');
    const result = await agent.generateText(prompt);
    return result.text;
  });
  feedbackService.start();

  // Plugin-contributed ACP entries are durable identities before any probe;
  // readiness can change later but never manufactures/removes a default.
  await reconcilePluginEngineConnections(
    configLoader as any,
    listProviders('acpConnections').flatMap((entry: any) =>
      (entry.provider.getConnections?.() ?? []).map((connection: any) => ({
        id: connection.id,
        plugin: entry.source,
      })),
    ),
  );
  initializeRuntimeBackgroundTasks({
    timers,
    logger,
    configLoader,
    acpBridge,
    onACPConnectionsReady: deps.onACPConnectionsReady,
  });

  scheduleRuntimePluginUpdateCheck({
    timers,
    port,
    eventBus,
    logger,
  });

  // Bind the dedicated listener only after every awaited initialization step
  // succeeds, so a rejected startup cannot strand the global voice-port guard.
  attachVoiceWebSocket(port + 2, voiceService, host, {
    // Scoped pairing (archive#1098): a valid credential must ALSO carry
    // orchestration:operate. Shared with terminal's identical gate
    // (`runtime-service-bootstrap.ts`) via `credentialAuthorizedForScope`.
    verifyCredential: (credential) =>
      credentialAuthorizedForScope(
        deps.environmentSecurityService,
        PAIRING_WS_SCOPES.voice,
        credential,
      ),
    limiter: new RuntimeAuthFailureLimiter(),
    audit: (record) => logger.warn('Voice authentication denied', record),
  });
  // Defer Claude-transcript follow so the first event-loop turns can answer
  // identity/readiness probes. Immediate start() + bulk INSERT OR IGNORE of
  // large attached histories was wedging launchd health checks (port bound,
  // HTTP hung). Follow still runs; first poll is delayed slightly.
  setTimeout(() => {
    attachedSessionFollowService.start();
  }, 2_500).unref?.();
  logger.info('Voice WebSocket listening', { port: port + 2 });
  logger.debug('Station Runtime initialized', { port });

  return {
    appConfig,
    framework,
    orchestrationService,
    resourcePosture,
    attachedSessionFollowService,
    consoleBridgeService,
    modelCatalog,
    usageAggregator: nextUsageAggregator,
    voltAgent,
    voiceWsAttached: true,
  };
}
