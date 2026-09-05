import {
  closePluginActivationSession,
  completePluginActivationComposition,
  type PluginActivationComposition,
  preparePluginActivationComposition,
} from '../../services/plugins/plugin-activation-composition.js';
import { createLocalPluginInstallationHost } from '../../services/plugins/plugin-installation-local.js';
import type { PluginInstallationHost } from '../../services/plugins/plugin-installation-service.js';
/**
 * VoltAgent runtime integration for Station
 * Handles dynamic agent loading, switching, and MCP tool management
 */

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { join, resolve } from 'node:path';
import type { AgentSpec } from '@kontourai/station-contracts/agent';
import {
  type EngineConnectionId,
  type EngineId,
  engineConnectionId,
  parseEngineId,
} from '@kontourai/station-contracts/agent-identity';
import type { AppConfig } from '@kontourai/station-contracts/config';
import {
  type BuiltinAgentEngineBinding,
  type ControlPlaneObservation,
  resolveBuiltinAgentEngineBinding,
  resolveEngineCapabilityMatrix,
} from '@kontourai/station-contracts/engine-capability-matrix';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
import type { ConnectionReadinessEvidence } from '@kontourai/station-contracts/tool';
import type { WorktreeSessionMetadata } from '@kontourai/station-contracts/workspace-isolation';
import {
  type MCPConnection,
  MCPLocalConnectionCustody,
} from '@kontourai/station-shared/mcp';
import {
  orchestrationStoreQuarantineNotice,
  quarantineOrchestrationStore,
} from '@kontourai/station-shared/orchestration-store-quarantine';
import { DEFAULT_SERVER_PORT } from '@kontourai/station-shared/ports';
import {
  acquireStationHomeRuntimeLease,
  type StationHomeRuntimeLease,
} from '@kontourai/station-shared/station-home-lifecycle';
import { Agent, AgentRegistry, type Tool, VoltAgent } from '@voltagent/core';
import type { HonoServerConfig } from '@voltagent/server-hono';
import packageJson from '../../../package.json' with { type: 'json' };
import { FileMemoryAdapter } from '../../adapters/file/memory-adapter.js';
import type { UsageAggregator } from '../../analytics/usage-aggregator.js';
import {
  ConfigLoader,
  DEFAULT_SYSTEM_PROMPT,
  isAgentOrIntegrationConfigPath,
} from '../../domain/config-loader.js';
import type { FileStorageAdapter } from '../../domain/file-storage-adapter.js';
import { ensureStationHomeSchemaSync } from '../../domain/home-schema-gate.js';
import { getOrchestrationDatabasePath } from '../../domain/migrations/003-orchestration-events.js';
import { ensureConversationKnowledgeRoot } from '../../knowledge-store/conversation-root-bootstrap.js';
import type { KnowledgeStoreProvider } from '../../knowledge-store/knowledge-store-provider.js';
import type { MonitoringEmitter } from '../../monitoring/emitter.js';
import type { ProviderSessionStartInput } from '../../providers/adapter-shape.js';
import { BedrockAdapter } from '../../providers/adapters/bedrock-adapter.js';
import { ClaudeAdapter } from '../../providers/adapters/claude-adapter.js';
import { CodexAdapter } from '../../providers/adapters/codex-adapter.js';
import { MuseAdapter } from '../../providers/adapters/muse-adapter.js';
import { OllamaAdapter } from '../../providers/adapters/ollama-adapter.js';
import {
  claudeAppHomeEnv,
  codexAppHomeEnv,
  ensureAppHomeProfile,
} from '../../providers/app-home/app-home-profiles.js';
import {
  ensureCredentialProfileAppHome,
  normalizeCredentialProfileRegistry,
} from '../../providers/app-home/credential-profile-registry.js';
import { BedrockModelCatalog } from '../../providers/llm/bedrock-models.js';
import { disposeRetainedPreparedPluginProviders } from '../../providers/registries/registry.js';
import type { BuildProvenanceSnapshot } from '../../routes/system/build-provenance.js';
import type { ACPManager } from '../../services/acp/acp-bridge.js';
import { getAgentPolicyService } from '../../services/agents/agent-policy-service.js';
import type { AgentService } from '../../services/agents/agent-service.js';
import type { SkillService } from '../../services/agents/skill-service.js';
import { makeUnattendedGrantResolver } from '../../services/agents/unattended-grant-resolver.js';
import { UnattendedGrantStore } from '../../services/agents/unattended-grant-store.js';
import { ApprovalGuardianService } from '../../services/approvals/approval-guardian.js';
import { ApprovalRegistry } from '../../services/approvals/approval-registry.js';
import type { ConnectionService } from '../../services/connections/connection-service.js';
import type { ProviderService } from '../../services/connections/provider-service.js';
import { ConsentChannelService } from '../../services/consent/consent-channel.js';
import { AssignmentClaimService } from '../../services/evidence/assignment-claim-service.js';
import type { ConsoleBridgeService } from '../../services/evidence/console-bridge-service.js';
import { WorkflowSidecarService } from '../../services/evidence/workflow-sidecar-service.js';
import {
  FeaturePreviewRegistry,
  type FeaturePreviewSelector,
} from '../../services/feature-previews/feature-preview-registry.js';
import type { FeedbackService } from '../../services/feedback/feedback-service.js';
import { FleetCandidateService } from '../../services/inference/fleet-candidate-service.js';
import { FleetProbeService } from '../../services/inference/fleet-probe-service.js';
import type { KnowledgeService } from '../../services/knowledge/knowledge-service.js';
import type { NotificationService } from '../../services/notifications/notification-service.js';
import type { OperationalEventPublisher } from '../../services/operational-events/operational-event-outbox.js';
import { createRuntimeLifecycleOperationalEvent } from '../../services/operational-events/runtime-lifecycle-operational-event.js';
import type { AttachedSessionFollowService } from '../../services/orchestration/attached-session-follow-service.js';
import { EventBus } from '../../services/orchestration/event-bus.js';
import { EventStore } from '../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../services/orchestration/orchestration-service.js';
import { OrchestrationStreamPresence } from '../../services/orchestration/orchestration-stream-presence.js';
import type { ProjectTaskRoomRuntime } from '../../services/orchestration/project-task-room-runtime.js';
import { projectSessionLifecycle } from '../../services/orchestration/session-lifecycle-service.js';
import { PeerCredentialStore } from '../../services/peers/peer-credential-store.js';
import { AgentPluginLoader } from '../../services/plugins/agent-plugin-loader.js';
import type { MCPService } from '../../services/plugins/mcp-service.js';
import type { FileTreeService } from '../../services/projects/file-tree-service.js';
import type { LayoutService } from '../../services/projects/layout-service.js';
import { ProjectResourceResolver } from '../../services/projects/project-resource-resolver.js';
import type { ProjectService } from '../../services/projects/project-service.js';
import {
  resolveProjectWorkspacePath,
  type WorkspacePathResolver,
} from '../../services/projects/project-workspace-path.js';
import type { ProposedChangeService } from '../../services/projects/proposed-change-service.js';
import { composeTaskDispatcher } from '../../services/projects/task-dispatch-composition.js';
import type { TaskDispatcher } from '../../services/projects/task-dispatcher.js';
import { TaskGraphService } from '../../services/projects/task-graph-service.js';
import {
  assertWorktreeMetadataSessionBinding,
  terminalWorktreeStateForExit,
  WorktreeProvisioningService,
} from '../../services/projects/worktree-provisioning-service.js';
import type { SchedulerService } from '../../services/scheduling/scheduler-service.js';
import type {
  FileSecretBindingAdministration,
  SecretBindingIntegrationAdministration,
} from '../../services/secrets/secret-binding-administration.js';
import { EnvironmentSecurityService } from '../../services/ssh/environment-security-service.js';
import type { SshEnvironmentService } from '../../services/ssh/ssh-environment-service.js';
import type { TerminalService } from '../../services/terminal/terminal-service.js';
import type { TerminalWebSocketServer } from '../../services/terminal/terminal-ws-server.js';
import { UsageTelemetryService } from '../../services/usage-telemetry-service.js';
import {
  consentListenerState,
  orchestrationStoreQuarantineDispositions,
  orchestrationStreamPresenceRosterOps,
} from '../../telemetry/metrics.js';
import { configuredTelemetryShutdownTask } from '../../telemetry.js';
import { setRuntimeControlApiBase } from '../../tools/station-control-shared.js';
import {
  applyConfiguredLogLevel,
  createLogger,
  type Logger,
  logStartupLogLevelDiagnostics,
  resolveLogLevel,
} from '../../utils/logger.js';
import { expandTilde, resolveHomeDir } from '../../utils/paths.js';
import type { VoiceSessionService } from '../../voice/voice-session.js';
import { isExternalEngineBoundAgent } from '../agents/agent-engine-classification.js';
import {
  type AgentHooksDeps,
  createAgentHooks,
} from '../agents/agent-hooks.js';
import { createStagedPreToolPolicyEvaluator } from '../agents/pre-tool-policy.js';
import {
  activatePreparedRuntimeAgentInstance,
  buildRuntimeAgentInstance,
  prepareRuntimeAgentInstance,
  type RuntimeAgentPreparationState,
} from '../agents/runtime-agent-builder.js';
import {
  reloadRuntimeAgents,
  reloadRuntimeSkillsAndAgents,
  switchRuntimeAgent,
} from '../agents/runtime-agent-lifecycle.js';
import {
  type ConsentListener,
  createConsentApp,
  startConsentListener,
} from '../consent/consent-listener.js';
import { FleetRoutingReceiptLog } from '../conversation/fleet-routing-receipt-log.js';
import {
  startTaskRoomAcceptanceControl,
  type TaskRoomAcceptanceControl,
} from '../diagnostics/task-room-acceptance-control.js';
import * as MCPManager from '../mcp/mcp-manager.js';
import {
  type MCPUIFrameServer,
  startMcpUiFrameServer,
} from '../mcp/mcp-ui-frame-server.js';
import { createNativeOutputDeclarationTool } from '../native-output-declaration.js';
import { isAutoApprovedExternalTool } from '../tools/tool-executor.js';

/**
 * The recovery Adapter accepts only Station runtime connection identities.
 * Engine/provider labels and public connection ids are intentionally not
 * interchangeable at this Seam.
 */
function credentialRecoveryRuntimeConnectionId(
  provider: string,
): 'claude' | 'codex' | undefined {
  if (provider === 'claude') return 'claude';
  if (provider === 'codex') return 'codex';
  return undefined;
}

export async function loadStablePreToolPolicySpec(options: {
  getStableRevision(): number | null;
  loadAgent(): Promise<AgentSpec>;
}): Promise<{ spec: AgentSpec; revision: number }> {
  const revision = options.getStableRevision();
  if (revision === null) {
    throw new Error(
      'Station agent configuration is not stable; pre-tool policy preparation was denied.',
    );
  }
  const spec = await options.loadAgent();
  if (options.getStableRevision() !== revision) {
    throw new Error(
      'Station agent configuration changed during pre-tool policy preparation; execution was denied.',
    );
  }
  return { spec, revision };
}

import { adoptDetectedNativeEngines } from './native-engine-adoption.js';
import { isHostedTenantExecutionRequired } from './runtime-tenant-context.js';

const CONFIGURATION_RECONCILIATION_DELAYS_MS = [250, 1_000, 5_000] as const;
/**
 * How many reconciliation passes may go by without activating a slug before
 * Station stops calling it "in progress".
 *
 * Something has to end the sentence. Non-`ManagedModelUnavailableError`
 * preparation failures reject the whole pass, and the pass retries forever, so
 * a permanently broken definition reported 503 "activating" — with a
 * `Retry-After` — for the life of the process, and the editor's only word for
 * it was "hasn't finished activating". Three passes spans the whole backoff
 * rail (250ms, 1s, 5s), so a genuinely slow activation still lands inside it.
 */
const MAX_ACTIVATION_ATTEMPTS = 3;
const CONFIGURATION_READ_LEASE_TIMEOUT_MS = 30_000;
/**
 * How long an immediate (`activationMode: 'wait'`) mutation may hold the
 * serialized configuration queues waiting for its own activation.
 *
 * Connection, provider and plugin writes activate synchronously so their
 * response describes a live runtime. That is worth waiting for, but not
 * without end: the activation runs inside both configuration queues, so a
 * hanging provider probe or an unresponsive MCP server during a tool rebuild
 * used to wedge every later configuration mutation AND shutdown behind it
 * (archive#3622). Past the deadline the mutation stops owning the queues,
 * reports `configurationActivation: 'pending'` (a 202 the routes already
 * emit), and hands the rest to the reconciliation rail.
 *
 * Ten seconds is above the observed cost of a full agent rebuild with live
 * MCP servers and well below any HTTP client timeout, so a slow-but-healthy
 * activation still answers `applied`.
 */
const AGENT_CONFIGURATION_ACTIVATION_DEADLINE_MS = 10_000;
/**
 * How long shutdown waits for the configuration queues to drain before
 * proceeding without them. An abandoned activation is by definition one
 * nobody can wait for, and `gracefulShutdown` ends in `process.exit` — so the
 * drain is a courtesy to in-flight durable writes, not a barrier.
 */
const AGENT_CONFIGURATION_SHUTDOWN_DRAIN_GRACE_MS = 5_000;

/**
 * The configuration generation a reload prepared against. Every publication
 * gate re-captures it and refuses to commit if any component moved — see
 * `assertAgentConfigurationRevisions`.
 */
interface AgentConfigurationGeneration {
  provider: number;
  appConfig: number;
  selectedPackageFingerprint?: string;
  persistence?: number;
  activationEpoch?: number;
}

import { disposeAllPluginPublicServerModules } from '../../routes/plugins/plugin-public-server.js';
import { getCachedUser } from '../../routes/system/auth.js';
import { DiscordGatewayService } from '../../services/discord/discord-gateway-service.js';
import {
  ActionOperationService,
  FileActionOperationStore,
} from '../../services/operations/action-operation-service.js';
import { FleetDispatchActionOperationObserver } from '../../services/operations/fleet-dispatch-action-operation-observer.js';
import {
  createMCPToolProvenanceGeneration,
  type MCPToolProvenanceGeneration,
} from '../../services/orchestration/mcp-tool-provenance.js';
import { continueExecutionTargetMessage } from '../../tools/station-control-delegation.js';
import { buildRuntimeContext as createRuntimeContext } from '../agents/runtime-context-builder.js';
import { bootstrapRuntimeDefaultAgent } from '../agents/runtime-default-agent.js';
import { replaceRuntimeTemplateVariables } from '../agents/runtime-template-variables.js';
import { bootstrapRuntimeVoiceAgent } from '../agents/runtime-voice-agent.js';
import { RuntimeEventLog } from '../conversation/runtime-event-log.js';
import { StrandsFramework } from '../frameworks/strands-adapter.js';
import { releaseAllNativeStationControlClients } from '../frameworks/strands-tool-loader.js';
import { VoltAgentFramework } from '../frameworks/voltagent-adapter.js';
import {
  buildStationControlMcpUrl,
  mintStationControlMcpToken,
  revokeStationControlMcpToken,
} from '../mcp/station-control-mcp-token.js';
import {
  createPluginOperationalEventSubscriptionService,
  type PluginOperationalEventSubscriptionService,
} from '../plugins/plugin-operational-event-subscriptions.js';
import { RuntimeConfigurationConflictError } from '../plugins/runtime-configuration-lease.js';
import {
  createRuntimeFrameworkModel,
  ManagedModelUnavailableError,
  resolveDefaultManagedModelHint,
  resolveRuntimeEmbeddingProvider,
  resolveRuntimeVectorDbProvider,
} from '../plugins/runtime-provider-resolution.js';
import { configureRuntimeRoutes } from '../routes/runtime-routes.js';
import { SC_READ_ONLY_TOOLS } from '../tools/runtime-control-tools.js';
import { guardRuntimeGenerationTools } from '../tools/runtime-generation-tools.js';
import type {
  DispatchEvidenceSource,
  DispatchFleetRouting,
  RuntimeContext,
} from '../types.js';
import {
  createEventStoreWorkItemPrincipalLiveness,
  WorkItemCapture,
} from '../work-item-capture.js';
import {
  assertHostedPersistenceBeforeSchemaSync,
  prepareHostedPersistenceAfterSchemaSync,
} from './hosted-persistence-boundary.js';
import {
  runRuntimeHealthChecks,
  startRuntimeHealthChecks,
} from './runtime-health.js';
import { initializeRuntime } from './runtime-initialize.js';
import { createRuntimeInitializationDeps } from './runtime-initialize-deps.js';
import { rebuildOrClearRuntimeProjections } from './runtime-projection-recovery.js';
import { createRuntimeServiceBundle } from './runtime-service-bootstrap.js';
import { shutdownRuntimeServices } from './runtime-shutdown.js';
import {
  checkOllamaAvailability,
  getActiveRuntimeProjectSlug,
} from './runtime-startup.js';
import {
  BUILTIN_STATION_DOCS_TOOL_SERVER_ID,
  stationControlRuntimeIdentity,
  stationControlSpawnEnv,
  stationDocsRuntimeIdentity,
} from './station-control-runtime-env.js';
import { isManagedChatOrchestrationFeatureEnabled } from './station-features.js';
import { startStoreIntegrityVerification } from './store-integrity-verification.js';

interface PersistedAgentActivationTransaction {
  preparationState: RuntimeAgentPreparationState;
  originalState: RuntimeAgentPreparationState;
  previousAgent: Agent | undefined;
  hadPreviousMetadata: boolean;
  previousMetadata: unknown;
}

type PersistedAgentReloadTarget =
  | { kind: 'reload-all' }
  | { kind: 'removed' }
  | { kind: 'external'; metadata: any; spec: AgentSpec }
  | { kind: 'managed'; metadata: any; spec: AgentSpec };

export interface StationRuntimeOptions {
  pluginInstallationHost?: PluginInstallationHost;
  projectHomeDir?: string;
  port?: number;
  host?: string;
  logLevel?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  /** Pre-built root logger (e.g. one `index.ts` already wired to the
   * durable server-log sink at boot). Defaults to constructing one
   * internally, same as before this option existed. */
  logger?: Logger;
  /** Immutable process identity captured by the entrypoint during bootstrap. */
  buildProvenanceSnapshot?: BuildProvenanceSnapshot;
}

/**
 * Main runtime for Station system
 * Manages VoltAgent instances with dynamic agent loading
 */
export class StationRuntime {
  private readonly pluginInstallationHost: PluginInstallationHost;
  private configLoader: ConfigLoader;
  private appConfig!: AppConfig;
  private logger: Logger;
  private readonly buildProvenanceSnapshot?: BuildProvenanceSnapshot;
  /** One persistent grant store shared by default and persisted managed agents. */
  private readonly unattendedGrantStore: UnattendedGrantStore;
  private readonly discordGatewayService: DiscordGatewayService;
  private readonly resolveUnattendedGrant: NonNullable<
    AgentHooksDeps['resolveUnattendedGrant']
  >;
  private voltAgent?: VoltAgent;
  private mcpConfigs: Map<string, MCPConnection> = new Map();
  private readonly mcpCustody = new MCPLocalConnectionCustody();
  private mcpConnectionStatus: Map<
    string,
    { connected: boolean; error?: string }
  > = new Map();
  private retiredMcpConfigs = new Set<{ disconnect(): Promise<void> }>();
  private integrationMetadata: Map<
    string,
    { type: string; transport?: string; toolCount?: number }
  > = new Map();
  private activeAgents: Map<string, any> = new Map();
  private agentMetadataMap: Map<string, any> = new Map();
  private agentSpecs: Map<string, AgentSpec> = new Map(); // Cache agent specs
  private memoryAdapters: Map<string, FileMemoryAdapter> = new Map();
  private agentTools: Map<string, Tool<any>[]> = new Map(); // Cache loaded tools per agent
  private globalToolRegistry: Map<string, Tool<any>> = new Map(); // All unique tools by name
  private agentFixedTokens: Map<
    string,
    { systemPromptTokens: number; mcpServerTokens: number }
  > = new Map(); // Cache fixed token counts per agent
  private agentHooksMap: Map<string, ReturnType<typeof createAgentHooks>> =
    new Map();
  private toolNameMapping: Map<
    string,
    {
      original: string;
      normalized: string;
      server: string | null;
      tool: string;
    }
  > = new Map(); // Tool name mapping with parsed data
  private toolNameReverseMapping: Map<string, string> = new Map(); // Original -> Normalized for O(1) lookup
  private mcpToolProvenanceGeneration: MCPToolProvenanceGeneration =
    createMCPToolProvenanceGeneration();
  private monitoringEvents = new EventEmitter();
  private monitoringEmitter!: MonitoringEmitter;
  private agentStats = new Map<
    string,
    { conversationCount: number; messageCount: number; lastUpdated: number }
  >();
  private agentStatus = new Map<string, 'idle' | 'running'>();
  private agentConfigurationRevision = 0;
  private agentConfigurationMutationQueue: Promise<void> = Promise.resolve();
  private agentConfigurationPersistenceQueue: Promise<void> = Promise.resolve();
  private agentConfigurationPersistenceRevision = 0;
  /** Installed-plugin Skill source generation requested versus loaded. */
  private pluginSkillSourceRevision = 0;
  private loadedPluginSkillSourceRevision = 0;
  /**
   * Bumped every time an activation is abandoned at its deadline
   * (archive#3622). It is part of the generation snapshot every reload
   * captures, so an abandoned pass that eventually wakes up fails its own
   * `assertAgentConfigurationRevisions` gate and rolls back instead of
   * publishing a snapshot built before a later writer ran. That is what makes
   * releasing the queue lease safe: the abandoned pass can still be running,
   * but it can no longer become a second writer over the live agent maps.
   */
  private agentConfigurationActivationEpoch = 0;
  /** Overridable so suites can prove the bound without waiting for it. */
  private agentConfigurationActivationDeadlineMs =
    AGENT_CONFIGURATION_ACTIVATION_DEADLINE_MS;
  private agentConfigurationShutdownDrainGraceMs =
    AGENT_CONFIGURATION_SHUTDOWN_DRAIN_GRACE_MS;
  private agentConfigurationMutationsClosed = false;
  private loadedProviderLaunchabilityRevision: number | null = null;
  private loadedAppConfigLaunchabilityRevision: number | null = null;
  private loadedSelectedPackageFingerprint: string | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private initializeInFlight: Promise<void> | null = null;
  private configurationReconciliationScheduled = false;
  /**
   * Narrow agent activations currently running, keyed by slug. Present for
   * exactly as long as the work is — see `trackAgentActivation`.
   *
   * Initialized lazily at both use sites as well as here. Several runtime
   * suites build a partial instance with `Object.create(StationRuntime.
   * prototype)` and assign only the fields they need, so a class field that
   * only a real constructor populates turns "I added an index" into a
   * TypeError inside every such harness — which is exactly how this arrived
   * (the registry-publication rollback test stopped registering anything at
   * all). An in-memory index has no reason to demand construction.
   */
  private agentActivationsInFlight = new Map<string, Promise<void>>();
  /**
   * Slugs whose durable write has landed but whose activation is still owed
   * to a reconciliation pass, with the number of passes that have gone by
   * WITHOUT covering them. Distinct from `agentActivationsInFlight`, which
   * means "a narrow activation is executing right now": on the deferred path
   * there is no narrow activation at all, and the gap between the create
   * returning and reconciliation starting is exactly the window a caller
   * would otherwise be told the Agent "is not active".
   *
   * Lazily created for the same reason as the map above — several runtime
   * suites build partial instances with `Object.create(prototype)`.
   */
  private agentsAwaitingReconciliation = new Map<
    string,
    { attempts: number }
  >();
  /**
   * Slugs whose activation was tried and kept failing. Recorded so a read
   * route can stop saying "still activating" — which was true for a while and
   * then became a lie — and say what actually went wrong instead.
   */
  private agentActivationFailures = new Map<
    string,
    { reason: string; at: string }
  >();
  private configurationReconciliationAttempt = 0;
  private reconciliationChurnWindowStartMs = 0;
  private reconciliationChurnCount = 0;
  private readonly nativeEngineAdoptionAbort = new AbortController();
  private configurationSourceUnsubscribers: Array<() => void> = [];
  private schedulerService?: SchedulerService;
  private kitLifecycleReady: Promise<void> = Promise.resolve();
  private notificationService?: NotificationService;
  private projectTaskRoomRuntime?: ProjectTaskRoomRuntime;
  private taskRoomAcceptanceControl?: TaskRoomAcceptanceControl;
  private metricsLog: Array<{
    timestamp: number;
    agentSlug: string;
    event: string;
    conversationId?: string;
    messageCount?: number;
    cost?: number;
  }> = [];
  private eventLogPath: string;
  private eventLog: RuntimeEventLog;
  private modelCatalog?: BedrockModelCatalog;
  private usageAggregator?: UsageAggregator;
  private port: number;
  private host?: string;
  private approvalRegistry: ApprovalRegistry;
  private bedrockAdapter = new BedrockAdapter();
  private claudeAdapter = new ClaudeAdapter({
    resolvePreToolPolicy: (input) =>
      this.resolveExternalPreToolPolicy(input, 'authentic'),
    // Skills materialization opt-in (docs/design/connections-onboarding.md
    // §5) — closures only; `this.configLoader`/`this.skillService` are
    // assigned later in the constructor body, but neither closure is
    // invoked until a session actually starts, well after construction
    // completes.
    getProvideSkills: async () => {
      const appConfig = await this.configLoader.loadAppConfig();
      const provideSkills =
        appConfig.agentConnections?.claude?.config?.provideSkills;
      return Array.isArray(provideSkills)
        ? provideSkills.filter((id): id is string => typeof id === 'string')
        : undefined;
    },
    resolveSkillDir: async (id) => {
      try {
        const skill = await this.skillService.getSkill(id);
        return skill.path || null;
      } catch {
        return null;
      }
    },
    // App-home profile opt-in (archive#896, agent-engine-unification.md §6.1's
    // overlay model, channel 2). `undefined` ⇒ the SDK spawn keeps today's
    // byte-identical behavior (full process env, no CLAUDE_CONFIG_DIR
    // override) — this closure is only invoked at `startSession` time, well
    // after construction, same lazy-capture posture as `getProvideSkills`.
    // Legacy no-ref lookup failures degrade to the global config. An explicit
    // or configured credential profile fails closed so a successful turn can
    // never be attributed to credentials that were not actually applied.
    getAppHomeEnv: async (credentialProfileRef) => {
      let selectedProfileRef = credentialProfileRef;
      try {
        const appConfig = await this.configLoader.loadAppConfig();
        const configuredRef = normalizeCredentialProfileRegistry(
          appConfig.agentConnections?.claude?.credentialRecovery,
        ).activeProfileRef;
        const profileRef =
          credentialProfileRef ??
          (typeof configuredRef === 'string' ? configuredRef : undefined);
        selectedProfileRef = profileRef;
        if (profileRef) {
          const { dir } = await ensureCredentialProfileAppHome(
            'claude',
            profileRef,
          );
          return claudeAppHomeEnv(dir);
        }
        const useAppHome =
          appConfig.agentConnections?.claude?.config?.useAppHome === true;
        if (!useAppHome) return undefined;
        const { dir } = await ensureAppHomeProfile('claude');
        return claudeAppHomeEnv(dir);
      } catch (error) {
        if (selectedProfileRef) {
          throw new Error(
            'Credential profile environment could not be prepared.',
          );
        }
        (this.logger?.warn as ((...a: unknown[]) => void) | undefined)?.(
          `App home profile: failed to resolve the claude app-home env; continuing with the global Claude Code config: ${error instanceof Error ? error.message : String(error)}`,
        );
        return undefined;
      }
    },
    // Station#1157 review fix (MEDIUM): the built-in station-control MCP
    // server needs THIS instance's actual bound port, not
    // `process.env.PORT`/`STATION_PORT` (stale/unset under `PORT=0`/
    // auto-allocate — see `stationControlSpawnEnv`'s doc comment). `this.port`
    // is assigned later in the constructor body (field initializers run
    // first, same lazy-capture posture as `getProvideSkills` above), but
    // this closure is only invoked at `startSession` time, well after
    // construction completes.
    getStationControlEnv: () => stationControlSpawnEnv(this.port),
    // `this.logger` is not assigned until later in the constructor body
    // (field initializers run first) — wrap it in a lazily-evaluated shim
    // rather than capturing `this.logger` (which would freeze in as
    // `undefined`).
    logger: {
      warn: (msg: string, ...args: unknown[]) =>
        (this.logger?.warn as ((...a: unknown[]) => void) | undefined)?.(
          msg,
          ...args,
        ),
    },
  });
  private codexAdapter = new CodexAdapter({
    // App-home profile opt-in (archive#896 wave 2, agent-engine-unification.md
    // §6.1's overlay model, channel 2) — mirrors claudeAdapter's
    // getAppHomeEnv closure above; codex has no `getProvideSkills` analog
    // (skills stay claude/workspace-channel only this wave). As above,
    // selected-profile failures block the spawn instead of falling back.
    getAppHomeEnv: async (credentialProfileRef) => {
      let selectedProfileRef = credentialProfileRef;
      try {
        const appConfig = await this.configLoader.loadAppConfig();
        const configuredRef = normalizeCredentialProfileRegistry(
          appConfig.agentConnections?.codex?.credentialRecovery,
        ).activeProfileRef;
        const profileRef =
          credentialProfileRef ??
          (typeof configuredRef === 'string' ? configuredRef : undefined);
        selectedProfileRef = profileRef;
        if (profileRef) {
          const { dir } = await ensureCredentialProfileAppHome(
            'codex',
            profileRef,
          );
          return codexAppHomeEnv(dir);
        }
        const useAppHome =
          appConfig.agentConnections?.codex?.config?.useAppHome === true;
        if (!useAppHome) return undefined;
        const { dir } = await ensureAppHomeProfile('codex');
        return codexAppHomeEnv(dir);
      } catch (error) {
        if (selectedProfileRef) {
          throw new Error(
            'Credential profile environment could not be prepared.',
          );
        }
        (this.logger?.warn as ((...a: unknown[]) => void) | undefined)?.(
          `App home profile: failed to resolve the codex app-home env; continuing with the global Codex config: ${error instanceof Error ? error.message : String(error)}`,
        );
        return undefined;
      }
    },
    // archive#1195: the wire-safe substitution for the built-in
    // station-control server (see codex-mcp-passthrough.ts's header
    // comment) — mints a per-session, short-lived, station-control-scoped
    // bearer token and returns the URL it authenticates against THIS
    // instance's own station-control HTTP/SSE MCP endpoint
    // (station-control-mcp-route.ts). `this.port` is assigned early in the
    // constructor body (same lazy-capture posture as
    // `getStationControlEnv` above), but this closure is only invoked at
    // `startSession` time, well after construction completes.
    mintStationControlMcpAuth: (threadId: string, tenantExecutionContext) => {
      const { token } = mintStationControlMcpToken(
        threadId,
        'url-token',
        undefined,
        tenantExecutionContext,
      );
      return buildStationControlMcpUrl(this.port, token);
    },
    revokeStationControlMcpAuth: (threadId: string) =>
      revokeStationControlMcpToken(threadId),
    // `this.logger` is not assigned until later in the constructor body
    // (field initializers run first) — wrap it in a lazily-evaluated shim
    // rather than capturing `this.logger` (which would freeze in as
    // `undefined`).
    logger: {
      warn: (msg: string, ...args: unknown[]) =>
        (this.logger?.warn as ((...a: unknown[]) => void) | undefined)?.(
          msg,
          ...args,
        ),
    },
  });
  // Muse Code spawns one `muse exec` per TURN rather than holding a
  // per-session process, so there is no app-home/credential-profile closure to
  // wire here (nothing is spawned at session start). The logger closure reads
  // `this.logger` lazily for the same reason the Codex one above does.
  private museAdapter = new MuseAdapter({
    logger: {
      warn: (msg: string, context?: unknown) =>
        (this.logger?.warn as ((...a: unknown[]) => void) | undefined)?.(
          msg,
          context,
        ),
      info: (msg: string, context?: unknown) =>
        (this.logger?.info as ((...a: unknown[]) => void) | undefined)?.(
          msg,
          context,
        ),
    },
  });
  private ollamaAdapter = new OllamaAdapter();
  private orchestrationService!: OrchestrationService;
  private resourcePosture?: import('../../services/infra/resource-posture.js').RuntimeResourcePostureProbe;
  private attachedSessionFollowService?: AttachedSessionFollowService;
  private consoleBridgeService?: ConsoleBridgeService;
  private orchestrationEventStore: EventStore;
  /**
   * The store `startStoreIntegrityVerification` verifies on a schedule. Held
   * because the constructor's own derivation is a local, and re-deriving it at
   * the timer is how two seams end up naming different files.
   */
  private orchestrationDatabasePath: string;
  /**
   * Stops the scheduled store verification, including a probe already
   * running. Clearing the interval alone would leave that child reparented to
   * init when `gracefulShutdown` exits the process (archive#3218 review).
   */
  private stopStoreIntegrityVerification?: () => void;
  private readonly operationalEventPublisher: OperationalEventPublisher;
  private readonly pluginOperationalEventSubscriptions: PluginOperationalEventSubscriptionService;
  private readonly stationHomeRuntimeLease: StationHomeRuntimeLease;

  // Services
  private agentService!: AgentService;
  private skillService!: SkillService;
  private mcpService!: MCPService;
  private secretBindingAdministration!: FileSecretBindingAdministration;
  private secretBindingIntegrationAdministration!: SecretBindingIntegrationAdministration;
  private layoutService!: LayoutService;
  private storageAdapter!: FileStorageAdapter;
  private projectService!: ProjectService;
  private providerService!: ProviderService;
  private proposedChangeService!: ProposedChangeService;
  private connectionService!: ConnectionService;
  private knowledgeService!: KnowledgeService;
  private knowledgeStoreProvider!: KnowledgeStoreProvider;
  private fileTreeService!: FileTreeService;
  private readonly taskGraphService: TaskGraphService;
  private readonly taskDispatchAssignmentClaims: Pick<
    AssignmentClaimService,
    'claim' | 'release' | 'status'
  >;
  private readonly resolveTaskDispatchWorkspace: WorkspacePathResolver;
  private taskDispatcher!: TaskDispatcher;
  private terminalService!: TerminalService;
  private terminalWsServer!: TerminalWebSocketServer;
  private terminalWsStarted = false;
  private voiceService!: VoiceSessionService;
  private voiceWsAttached = false;
  private acpBridge: ACPManager;
  private feedbackService: FeedbackService;
  private environmentSecurityService: EnvironmentSecurityService;
  /**
   * This Station's own environment id, captured once identity is initialized
   * (archive#1398). `null` before then, and a `null` here means fleet
   * routing stays unwired rather than stamping receipts with a placeholder
   * identity — a receipt that cannot say whose decision it records is not a
   * receipt.
   */
  private stationEnvironmentId: string | null = null;
  /** archive#1398 — see {@link StationRuntime.fleetProbes}. */
  private fleetProbeService: FleetProbeService | undefined;
  private readonly featurePreviews: FeaturePreviewRegistry;
  /** Bound during composition, then selected at the fleet-routing branch. */
  private fleetConsumerProbesPreview!: FeaturePreviewSelector;
  private sshEnvironmentService: SshEnvironmentService;
  private timers: NodeJS.Timeout[] = [];
  public readonly eventBus = new EventBus();
  // archive#1225: shared per-user live-`/events`-subscriber presence, read
  // by both `createOrchestrationRoutes` and the push-on-completion wiring —
  // see `ConfigureRuntimeRoutesContext.orchestrationStreamPresence`'s doc
  // comment for why this must be the ONE instance both sides observe.
  public readonly orchestrationStreamPresence = new OrchestrationStreamPresence(
    {
      onRosterOp: (op) => orchestrationStreamPresenceRosterOps.add(1, { op }),
    },
  );
  private framework!: VoltAgentFramework | StrandsFramework;
  // Different-origin MCP Apps sandbox proxy. It uses an ephemeral loopback port
  // by default; MCP_UI_FRAME_PORT can pin that port for deployments.
  private mcpUiFrameServer: MCPUIFrameServer | null = null;
  // archive#3677: the distinct-origin consent surface. The channel service
  // (transaction store + truthful availability state) exists from
  // construction so routes can consult it even when the listener never
  // binds; the listener itself starts during initialize.
  public readonly consentChannel = new ConsentChannelService();
  private consentListener: ConsentListener | null = null;
  private usageTelemetry?: UsageTelemetryService;
  /** One durable operation authority shared by route and fleet composition. */
  private actionOperations!: ActionOperationService;

  private async resolveExternalPreToolPolicy(
    input: ProviderSessionStartInput,
    toolNameProvenance: 'authentic' | 'self-reported',
  ) {
    if (!input.agent) return undefined;
    const { spec, revision } = await loadStablePreToolPolicySpec({
      getStableRevision: () => this.getStableAgentConfigurationRevision(),
      loadAgent: () => this.configLoader.loadAgent(input.agent!.slug),
    });
    return createStagedPreToolPolicyEvaluator({
      spec,
      agentPolicyService: getAgentPolicyService(this.logger),
      approvalGuardian: new ApprovalGuardianService({
        appConfig: this.appConfig,
        framework: this.framework,
        listProviderConnections: () =>
          this.providerService.listProviderConnections(),
        logger: this.logger,
        modelCatalog: this.modelCatalog,
        projectHomeDir: this.configLoader.getProjectHomeDir(),
      }),
      isCurrentRuntimeGeneration: () =>
        this.getStableAgentConfigurationRevision() === revision,
      resolveUnattendedGrant: this.resolveUnattendedGrant,
      toolNameMapping: this.toolNameMapping,
      isGranted: (tool) =>
        isAutoApprovedExternalTool(
          tool.toolName,
          input.agent?.autoApprove,
          input.agent?.toolServers,
          toolNameProvenance,
        ),
      logger: this.logger,
    });
  }

  constructor(options: StationRuntimeOptions = {}) {
    const projectHomeDir = options.projectHomeDir || resolveHomeDir();
    // archive#3217, and it has to be HERE rather than in `index.ts`: the
    // pre-boot hooks `index.ts` runs are not on every entry point's path, so
    // a quarantine wired there would never run for the CLI. Above the runtime
    // lease because the quarantine takes the MAINTENANCE lease, which proves no
    // runtime holds this home — and this process's own runtime lease would be
    // the counterexample.
    //
    // The hosted pre-gate runs first, and only claims what it actually does:
    // outside hosted-tenant mode it returns immediately, and even inside it
    // this call checks the home ROOT's ownership and symlink safety, not the
    // per-path assertions that run after the schema sync below. The quarantine
    // does its own symlink check on the one directory it creates.
    assertHostedPersistenceBeforeSchemaSync(projectHomeDir);
    const orchestrationStoreQuarantine =
      quarantineOrchestrationStore(projectHomeDir);
    // Every outcome but the ordinary one is counted. `home-active` and
    // `store-unreadable` are the states where the boot is about to die on
    // `EventStoreIntegrityError`, and an operator who cannot tell whether the
    // quarantine ran, declined, or could not look is reading the same message
    // this branch exists to replace.
    if (orchestrationStoreQuarantine.kind !== 'no-marker') {
      orchestrationStoreQuarantineDispositions.add(1, {
        outcome: orchestrationStoreQuarantine.kind,
      });
    }
    const stationHomeRuntimeLease =
      acquireStationHomeRuntimeLease(projectHomeDir);
    this.stationHomeRuntimeLease = stationHomeRuntimeLease;
    let openedEventStore: EventStore | undefined;
    let openedConfigLoader: ConfigLoader | undefined;
    try {
      // No EventStore/SQLite, watcher, or ConfigLoader application-data read is
      // allowed before the home marker has failed closed or been bootstrapped.
      assertHostedPersistenceBeforeSchemaSync(projectHomeDir);
      ensureStationHomeSchemaSync(projectHomeDir);
      const orchestrationDatabasePath =
        getOrchestrationDatabasePath(projectHomeDir);
      prepareHostedPersistenceAfterSchemaSync(
        projectHomeDir,
        `${projectHomeDir}/data`,
        orchestrationDatabasePath,
      );
      this.port = options.port ?? DEFAULT_SERVER_PORT;
      this.buildProvenanceSnapshot = options.buildProvenanceSnapshot;
      setRuntimeControlApiBase(this.port);
      this.host = options.host;
      this.eventLogPath = `${projectHomeDir}/monitoring`;
      this.environmentSecurityService = new EnvironmentSecurityService({
        homeDir: projectHomeDir,
      });

      const agentPluginLoader = new AgentPluginLoader({
        projectHomeDir,
        journal: () =>
          this.orchestrationEventStore.createPackageMcpAdmissionJournal(),
        report: (report) =>
          this.logger?.warn('Agent Plugin component was not loaded', report),
      });
      this.configLoader = openedConfigLoader = new ConfigLoader({
        projectHomeDir,
        watchFiles: true,
        enforceHomeSchema: true,
        integrationSources: [agentPluginLoader],
      });
      // archive#3063: the built-in tool servers' spawn identity (dist path,
      // STATION_API_BASE/STATION_PORT) is THIS instance's property, resolved
      // fresh on every `loadIntegration` — never read from, and never
      // persisted to, the shared `integrations/` files. Two co-homed
      // instances (desktop app + launchd service) therefore agree on the
      // persisted bytes, which is what lets the byte-identical save skip
      // converge instead of the cross-process reload ping-pong this issue
      // fixed. Lazy closures: `this.port` is already final here (set above,
      // pre-resolved by index.ts even under PORT=0 auto-allocate).
      this.configLoader.registerBuiltinIntegrationRuntimeIdentity(
        'station-control',
        () => stationControlRuntimeIdentity(this.port),
      );
      this.configLoader.registerBuiltinIntegrationRuntimeIdentity(
        BUILTIN_STATION_DOCS_TOOL_SERVER_ID,
        () => stationDocsRuntimeIdentity(),
      );
      this.orchestrationDatabasePath = orchestrationDatabasePath;
      this.orchestrationEventStore = openedEventStore = new EventStore(
        orchestrationDatabasePath,
      );
      this.pluginInstallationHost =
        options.pluginInstallationHost ??
        createLocalPluginInstallationHost(
          join(projectHomeDir, 'plugins'),
          this.orchestrationEventStore.createPackageMcpAdmissionJournal(),
        );
      this.operationalEventPublisher =
        this.orchestrationEventStore.createOperationalEventPublisher({
          appended: ({ journalSequence, event }) => {
            this.eventBus.emit(SERVER_EVENTS.OPERATIONAL_EVENT, {
              journalSequence,
              event,
            });
          },
        });

      const resolvedLogLevel = resolveLogLevel(options.logLevel);
      this.logger =
        options.logger ??
        createLogger({
          name: 'station',
          level: resolvedLogLevel,
        });
      this.actionOperations = new ActionOperationService(
        new FileActionOperationStore(projectHomeDir),
      );
      // Reported at the first moment there is a logger to report it with. The
      // quarantine itself has to run before this — before the EventStore that
      // would otherwise refuse to open — so the outcome waits here rather than
      // the decision moving later.
      const quarantineNotice = orchestrationStoreQuarantineNotice(
        orchestrationStoreQuarantine,
      );
      if (quarantineNotice) {
        this.logger.warn(quarantineNotice, {
          outcome: orchestrationStoreQuarantine.kind,
          ...(orchestrationStoreQuarantine.kind === 'quarantined'
            ? {
                quarantineDir: orchestrationStoreQuarantine.quarantineDir,
                // Names AND sizes AND provenance: a bare list of names would
                // have the log repeating the same claim the record was fixed
                // to stop making.
                files: orchestrationStoreQuarantine.files,
              }
            : {}),
          ...('marker' in orchestrationStoreQuarantine
            ? { observedAt: orchestrationStoreQuarantine.marker.observedAt }
            : {}),
        });
      }
      this.featurePreviews = new FeaturePreviewRegistry(
        projectHomeDir,
        this.logger,
      );
      this.bindFleetConsumerProbesPreview();
      this.pluginOperationalEventSubscriptions =
        createPluginOperationalEventSubscriptionService({
          eventBus: this.eventBus,
          eventStore: this.orchestrationEventStore,
          logger: this.logger,
          projectHomeDir,
        });
      this.unattendedGrantStore = new UnattendedGrantStore(projectHomeDir);
      this.discordGatewayService = new DiscordGatewayService({
        homeDir: projectHomeDir,
        logger: this.logger,
        eventBus: this.eventBus,
        // Discord supplies only the bound Station conversation. The shared
        // continuation resolves that conversation's persisted target and then
        // enters the same executeForegroundMessage seam as POST /chat.
        executeForegroundMessage: (input) => {
          if (!this.orchestrationService) {
            throw new Error('Station orchestration is unavailable');
          }
          return continueExecutionTargetMessage(
            input,
            this.orchestrationService,
          );
        },
        readTranscript: ({ sessionId, turnId }) =>
          this.orchestrationService
            ?.readSessionMessages(sessionId, INTERNAL_SESSION_READ_SCOPE)
            .filter(
              (message) =>
                message.role === 'assistant' &&
                message.metadata?.turnId === turnId,
            )
            .flatMap((message) => message.parts)
            .filter((part) => part.type === 'text')
            .map((part) => part.text ?? '')
            .join('') ?? '',
      });
      this.resolveUnattendedGrant = makeUnattendedGrantResolver(
        this.unattendedGrantStore,
        { logger: this.logger },
      );
      logStartupLogLevelDiagnostics(this.logger, options.logLevel);
      this.eventLog = new RuntimeEventLog(this.eventLogPath, this.logger);
      this.taskDispatchAssignmentClaims = new AssignmentClaimService({
        logger: this.logger,
      });
      this.resolveTaskDispatchWorkspace = (projectId: string) => {
        const resolver = new ProjectResourceResolver({
          homeDir: projectHomeDir,
          source: {
            getProject: (slug) => this.projectService.getProject(slug),
            listLayouts: (slug) => this.storageAdapter.listLayouts(slug),
          },
        });
        return resolveProjectWorkspacePath(projectId, { resolver });
      };
      this.approvalRegistry = new ApprovalRegistry(this.logger, {
        eventBus: this.eventBus,
      });
      const services = createRuntimeServiceBundle({
        projectHomeDir,
        port: this.port,
        host: this.host,
        logger: this.logger,
        configLoader: this.configLoader,
        agentPluginLoader,
        approvalRegistry: this.approvalRegistry,
        eventBus: this.eventBus,
        orchestrationEventStore: this.orchestrationEventStore,
        environmentSecurityService: this.environmentSecurityService,
        monitoringEvents: this.monitoringEvents,
        memoryAdapters: this.memoryAdapters,
        activeAgents: this.activeAgents,
        agentMetadataMap: this.agentMetadataMap,
        agentSpecs: this.agentSpecs,
        agentTools: this.agentTools,
        agentHooks: this.agentHooksMap,
        mcpConfigs: this.mcpConfigs,
        mcpCustody: this.mcpCustody,
        mcpConnectionStatus: this.mcpConnectionStatus,
        integrationMetadata: this.integrationMetadata,
        toolNameMapping: this.toolNameMapping,
        resetAllRuntimeProjections: async (resetIntegrationState) => {
          await this.recoverRuntimeProjections(resetIntegrationState);
        },
        usageAggregatorRef: { get: () => this.usageAggregator },
        getTerminalShell: () => this.appConfig?.terminalShell,
        persistEvent: (event: any) => this.eventLog.persist(event),
        bootstrapVoiceAgent: async () => this.bootstrapVoiceAgent(),
        resolveVectorDbProvider: () =>
          resolveRuntimeVectorDbProvider(this.providerService),
        resolveEmbeddingProvider: () =>
          resolveRuntimeEmbeddingProvider(this.providerService),
      });
      this.storageAdapter = services.storageAdapter;
      this.agentService = services.agentService;
      this.skillService = services.skillService;
      this.mcpService = services.mcpService;
      this.secretBindingAdministration = services.secretBindingAdministration;
      this.secretBindingIntegrationAdministration =
        services.secretBindingIntegrationAdministration;
      this.layoutService = services.layoutService;
      this.projectService = services.projectService;
      this.providerService = services.providerService;
      this.proposedChangeService = services.proposedChangeService;
      this.knowledgeService = services.knowledgeService;
      this.knowledgeStoreProvider = services.knowledgeStoreProvider;
      this.fileTreeService = services.fileTreeService;
      this.terminalService = services.terminalService;
      this.terminalWsServer = services.terminalWsServer;
      this.voiceService = services.voiceService;
      this.monitoringEmitter = services.monitoringEmitter;
      this.acpBridge = services.acpBridge;
      this.connectionService = services.connectionService;
      this.feedbackService = services.feedbackService;
      this.sshEnvironmentService = services.sshEnvironmentService;

      // Compose the graph only once all of its graph/read dependencies are
      // concrete. This is deliberately later than the assignment Adapter above:
      // `ProjectService` is created by the runtime bundle, and a graph whose
      // workspace resolver is installed later would make startup ordering part
      // of its Interface. The sidecar reader is stateless, but belongs at this
      // same composition seam for the identical reason.
      this.taskGraphService = new TaskGraphService(projectHomeDir, {
        projectService: this.projectService,
        workflowSidecarReader: new WorkflowSidecarService({
          logger: this.logger,
        }),
        assignmentClaimService: this.taskDispatchAssignmentClaims,
        resolveProjectWorkspace: this.resolveTaskDispatchWorkspace,
      });
      // Release a task's assignment claim when its orchestration session ends
      // (natural completion or `stopSession`/cancel — both surface as the
      // same canonical `session.exited` event). Never throws into the
      // EventBus: `releaseClaimForSession` already catches internally, and
      // the `.catch` here is defense-in-depth for the subscription callback
      // itself.
      const worktreeProvisioningService = new WorktreeProvisioningService();
      this.eventBus.subscribe((serverEvent) => {
        if (serverEvent.event !== SERVER_EVENTS.ORCHESTRATION_EVENT) return;
        const event = serverEvent.data?.event as
          | {
              method?: string;
              sessionId?: string;
              provider?: string;
              reason?: string;
              exitCode?: number;
            }
          | undefined;
        if (event?.method !== 'session.exited' || !event.sessionId) return;
        const sessionId = event.sessionId;
        void this.taskGraphService
          .releaseClaimForSession(sessionId, event.reason ?? 'session.exited')
          .catch((error) => {
            this.logger.warn(
              'Failed to release assignment claim on session exit',
              {
                sessionId: event.sessionId,
                error: error instanceof Error ? error.message : String(error),
              },
            );
          });
        void this.orchestrationService
          .readSession(sessionId, INTERNAL_SESSION_READ_SCOPE)
          .then(async (detail) => {
            if (!detail) return;
            const task = this.taskGraphService
              .listTasks()
              .find((candidate) => candidate.sessionId === sessionId);
            if (task && event.provider) {
              // Fold the persisted canonical stream through the one lifecycle
              // classifier used by every other Station projection. Exit
              // `reason` is adapter text, not a room-outcome authority.
              const lifecycle = projectSessionLifecycle({
                session: detail.session,
                events: detail.events,
              });
              const outcome =
                lifecycle.lifecycleState === 'completed'
                  ? 'completed'
                  : lifecycle.lifecycleState === 'failed'
                    ? 'failed'
                    : 'cancelled';
              await this.projectTaskRoomRuntime?.publishAgentFinished({
                taskId: task.id,
                sessionId,
                provider: event.provider,
                outcome,
              });
            }
            const metadata = worktreeMetadataFromEvents(
              detail.events,
              sessionId,
            );
            if (!metadata) return;
            const terminalState = terminalWorktreeStateForExit({
              lifecycleState: detail.session.lifecycleState,
              exitCode: event.exitCode,
              events: detail.events,
            });
            await worktreeProvisioningService.finalize({
              metadata,
              terminalState,
              sessionId,
            });
          })
          .catch((error) => {
            this.logger.warn('Failed to finalize worktree on session exit', {
              sessionId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      });
      // Startup reconciliation sweep (review finding #5): a prior Station
      // process (or dispatch attempt) may have crashed between an
      // AssignmentProvider claim succeeding and its release, wedging the
      // subject with no live owner — the in-process release triggers above
      // (session.exited, task-terminal) only fire for a THIS-process crash's
      // survivors, not a claim left over from before this restart. Fire-and-
      // forget: never block server startup on it, but it needs
      // `projectService`/`taskGraphService` wiring to already be complete,
      // which it is at this point in the constructor. See
      // `TaskGraphService.reconcileStaleAssignmentClaims`'s own doc comment
      // for the accepted residual gap this sweep does not close.
      void this.taskGraphService
        .reconcileStaleAssignmentClaims()
        .then((result) => {
          if (result.releasedSubjects.length > 0) {
            this.logger.info(
              'Startup reconciliation released stale assignment claims',
              { subjects: result.releasedSubjects },
            );
          }
        })
        .catch((error) => {
          this.logger.warn('Startup assignment-claim reconciliation failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        });

      // Log versions for debugging
      this.logger.info('Station Runtime initializing', {
        voltagentCore: '1.1.37',
        aiSdkBedrock: '3.0.56',
        nodeVersion: process.version,
      });
    } catch (error) {
      const failures: unknown[] = [error];
      let persistenceClosed = true;
      try {
        openedEventStore?.close();
      } catch (closeError) {
        persistenceClosed = false;
        failures.push(closeError);
      }
      if (openedConfigLoader) void openedConfigLoader.dispose().catch(() => {});
      if (persistenceClosed) {
        try {
          stationHomeRuntimeLease.release();
        } catch (releaseError) {
          failures.push(releaseError);
        }
      }
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          'Runtime construction failed and home ownership cleanup was incomplete',
        );
      }
      throw error;
    }
  }

  /**
   * Reload agents from disk
   */
  async reloadAgents(): Promise<void> {
    await this.mutateAgentConfiguration(() =>
      this.reloadConfigurationFromDisk(),
    );
  }

  private async recoverRuntimeProjections(
    resetIntegrationState: () => void,
  ): Promise<void> {
    await this.mutateAgentConfiguration(() =>
      rebuildOrClearRuntimeProjections(
        () => {
          resetIntegrationState();
          return this.reloadConfigurationFromDisk();
        },
        () => {
          resetIntegrationState();
          this.globalToolRegistry.clear();
          this.toolNameReverseMapping.clear();
          this.activeAgents.clear();
        },
      ),
    );
  }

  /** Plain-data engine connections used to resolve the built-in binding. */
  private async listEngineConnections(): Promise<
    Array<{
      id: EngineConnectionId;
      type: string;
      name: string;
      enabled: boolean;
      status: string;
      engineId?: EngineId;
      capabilities: string[];
      controlPlaneObservation?: ControlPlaneObservation;
    }>
  > {
    return (await this.connectionService.listRuntimeConnections()).map(
      (connection) => ({
        id: engineConnectionId(connection.id),
        type: connection.type,
        name: connection.name,
        enabled: connection.enabled,
        status: connection.status,
        engineId: parseEngineId(connection.config.engineId),
        capabilities: connection.capabilities,
        // archive#1549: per connection, from the projection the picker
        // reads — so the bootstrap binding and the picker derive the same
        // capability from the same evidence.
        controlPlaneObservation: connection.controlPlaneObservation,
      }),
    );
  }

  /**
   * archive#1194 (epic archive#1191, slice B): resolves the built-in agents'
   * (default + station-voice) engine binding — Station's own engine
   * (`null`) unless the onboarding picker's persisted choice
   * (`appConfig.builtinAgentEngineConnectionId`) or its unchosen sensible
   * default names a ready external engine.
   */
  private async resolveBuiltinEngineBinding(
    appConfig: AppConfig,
  ): Promise<BuiltinAgentEngineBinding | null> {
    const connections = await this.listEngineConnections();
    const readyExternalEngines = connections
      .filter(
        (seed) =>
          seed.enabled &&
          seed.status === 'ready' &&
          seed.capabilities.includes('agent-runtime'),
      )
      .map((seed) => ({
        connectionId: seed.id,
        matrix: resolveEngineCapabilityMatrix(seed.id, {
          type: seed.type,
          engineId: seed.engineId,
        }),
        controlPlaneObservation: seed.controlPlaneObservation,
      }))
      .filter((engine) => engine.matrix.engineId !== 'station');

    const stationChatReady =
      resolveDefaultManagedModelHint(
        appConfig,
        this.providerService.listProviderConnections(),
      ) !== null;

    const explicitConnectionId = appConfig.builtinAgentEngineConnectionId;
    return resolveBuiltinAgentEngineBinding({
      explicitConnectionId,
      stationChatReady,
      readyExternalEngines,
    });
  }

  /**
   * archive#1194 (epic archive#1191, slice B): re-applies the built-in DEFAULT
   * agent's engine binding after `builtinAgentEngineConnectionId` changes
   * (the onboarding picker's mutation) — reuses the existing bootstrap
   * function exactly as any other reload does, so a repeat call is
   * idempotent and never clobbers a persisted explicit choice back to
   * Station (see `resolveBuiltinAgentEngineBinding`'s doc comment).
   *
   * Deliberately does NOT touch `station-voice` (review round 2, archive#1194):
   * Voice is a speech-to-speech agent (`voice-session.ts`'s `IS2SProvider`)
   * that never reads an engine binding — rebinding it would silently degrade
   * it to a toolless assistant while claiming to run it on another engine, a
   * category error (Voice is speech, not text chat).
   */
  async rebindBuiltinAgents(): Promise<void> {
    await this.reloadDefaultAgent();
  }

  async applyAgentConfigurationMutation<T>(
    operation: import('../types.js').AgentConfigurationMutationOperation<T>,
    options?: import('../types.js').AgentConfigurationMutationOptions<T>,
  ): Promise<T> {
    if (options?.activationMode === 'defer' && options.pluginActivation)
      throw new Error(
        'Plugin activation requires the owned runtime composition boundary',
      );
    if (options?.activationMode === 'defer') {
      return this.serializeAgentConfigurationPersistence(async () => {
        let mutationBegan = false;
        const activation: import('../types.js').AgentConfigurationActivation = {
          status: 'applied',
        };
        const beginMutation = () => {
          if (mutationBegan) return;
          mutationBegan = true;
          if (options?.rediscoverSkills) {
            this.pluginSkillSourceRevision =
              (this.pluginSkillSourceRevision ?? 0) + 1;
          }
          this.agentConfigurationPersistenceRevision =
            (this.agentConfigurationPersistenceRevision ?? 0) + 1;
          this.loadedProviderLaunchabilityRevision = null;
          this.loadedAppConfigLaunchabilityRevision = null;
        };
        try {
          const result = await operation(beginMutation, activation);
          if (mutationBegan) {
            activation.status = 'pending';
            activation.reason =
              'Configuration was saved, but runtime activation is pending reconciliation.';
            // The durable write has landed and the runtime has NOT caught up
            // yet. Record that for this slug so a read route can say
            // "activating" instead of "exists but is not active" — the whole
            // reason create no longer has to hold its response open.
            this.markAgentAwaitingReconciliation(
              options?.resolveAgentSlug?.(result),
            );
            this.configurationReconciliationAttempt = 0;
            this.scheduleAgentConfigurationReconciliation();
          }
          return result;
        } catch (error) {
          // A failed operation may still have changed durable state after
          // beginMutation(). Reconcile it without holding the error response.
          if (mutationBegan) {
            this.configurationReconciliationAttempt = 0;
            this.scheduleAgentConfigurationReconciliation();
          }
          throw error;
        }
      });
    }
    // Restored to the pre-branch shape. An earlier round moved agent CREATE
    // to `'wait'` (to make `GET /agents/:slug/tools` answer 200 immediately)
    // and then bounded the response with a timer. Both are gone: the bound
    // was a liveness hazard — a never-settling activation awaited inside both
    // serialized queues wedges every later configuration mutation AND
    // shutdown — and creates no longer need it, because "activating" is now a
    // state the tools route can report (see `trackAgentActivation`).
    //
    // The wait that remains here belongs to connection/provider/plugin
    // mutations, and it is now BOUNDED (archive#3622). The durable write still
    // runs inside both queues — it is fast — and the activation still runs
    // under the access lease so there is exactly one writer over the live
    // agent maps. What changed is that the lease is no longer open-ended:
    // past `agentConfigurationActivationDeadlineMs` the mutation stops
    // awaiting its own activation, bumps the activation epoch so the
    // abandoned pass fails its own publication gate instead of committing a
    // snapshot a later writer has already invalidated, and answers with
    // `configurationActivation: 'pending'` (the 202 the routes already emit).
    // The activation keeps running; the reconciliation rail owns finishing it.
    return this.serializeAgentConfigurationPersistence(() =>
      this.serializeAgentConfigurationAccess(async () => {
        let mutationBegan = false;
        const beginMutation = () => {
          if (mutationBegan) return;
          mutationBegan = true;
          if (options?.rediscoverSkills) {
            this.pluginSkillSourceRevision =
              (this.pluginSkillSourceRevision ?? 0) + 1;
          }
          this.agentConfigurationRevision += 1;
        };
        let result: T | undefined;
        let operationError: unknown;
        const activation: import('../types.js').AgentConfigurationActivation = {
          status: 'applied',
        };
        try {
          result = await operation(beginMutation, activation);
        } catch (error) {
          operationError = error;
        }

        let reloadError: unknown;
        let activationAbandoned = false;
        if (mutationBegan) {
          try {
            const agentSlug =
              operationError === undefined && result !== undefined
                ? options?.resolveAgentSlug?.(result)
                : undefined;
            const activating = this.trackAgentActivation(
              agentSlug,
              (async () => {
                const composition =
                  options?.pluginActivation && operationError === undefined
                    ? await preparePluginActivationComposition(
                        options.pluginActivation,
                      )
                    : undefined;
                if (agentSlug && !composition)
                  await this.reloadPersistedAgentFromDisk(agentSlug);
                else await this.reloadConfigurationFromDisk(composition);
                if (composition)
                  await completePluginActivationComposition(composition);
              })(),
            );
            const outcome =
              await this.awaitActivationWithinDeadline(activating);
            if (outcome.status === 'abandoned') {
              activationAbandoned = true;
              if (options?.pluginActivation)
                closePluginActivationSession(options.pluginActivation);
              this.abandonStalledActivation(agentSlug, activating);
            } else if (outcome.error !== undefined) {
              throw outcome.error;
            }
          } catch (error) {
            reloadError = error;
            // Never re-open a stable read generation against a persisted
            // definition that failed to activate. Reconciliation must publish
            // a complete runtime snapshot before new work can be admitted.
            this.loadedProviderLaunchabilityRevision = null;
            this.loadedAppConfigLaunchabilityRevision = null;
          } finally {
            if (options?.pluginActivation)
              closePluginActivationSession(options.pluginActivation);
            this.agentConfigurationRevision += 1;
          }
        }

        if (operationError && reloadError) {
          throw new AggregateError(
            [operationError, reloadError],
            'Configuration mutation and runtime reload both failed.',
          );
        }
        if (operationError) throw operationError;
        if (reloadError) {
          activation.status = 'pending';
          activation.reason =
            'Configuration was saved, but runtime activation is pending reconciliation.';
          this.logger?.error?.(
            'Configuration activation failed after persistence',
            {
              error: reloadError,
            },
          );
          this.configurationReconciliationAttempt = 0;
          this.scheduleAgentConfigurationReconciliation();
        }
        if (activationAbandoned) {
          activation.status = 'pending';
          activation.reason =
            'Configuration was saved, but runtime activation did not finish ' +
            'within its deadline and is continuing in the background.';
        }
        return result as T;
      }),
    );
  }

  /**
   * Waits for an activation, but only for as long as holding the
   * configuration queues open is defensible (archive#3622).
   *
   * Never rejects: the activation's own failure is reported as an outcome so
   * the loser of the race cannot become an unhandled rejection when the
   * deadline wins.
   */
  private async awaitActivationWithinDeadline(
    activating: Promise<void>,
  ): Promise<
    | { status: 'settled'; error: unknown }
    | { status: 'abandoned'; error?: never }
  > {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = activating.then(
      () => ({ status: 'settled' as const, error: undefined as unknown }),
      (error: unknown) => ({ status: 'settled' as const, error }),
    );
    const deadline = new Promise<{ status: 'abandoned' }>((resolve) => {
      timer = setTimeout(() => {
        resolve({ status: 'abandoned' as const });
      }, this.activationDeadlineMs());
      this.timers?.push(timer);
    });
    try {
      return await Promise.race([settled, deadline]);
    } finally {
      if (timer) this.releaseRuntimeTimer(timer);
    }
  }

  /**
   * Gives up ownership of an activation that outran its deadline.
   *
   * Three things have to be true for that to be safe, and each is done here:
   * the abandoned pass must not be able to publish (the epoch bump invalidates
   * the generation it prepared against, so its own
   * `assertAgentConfigurationRevisions` gate rejects and rolls back); its
   * eventual settlement must not surface as an unhandled rejection; and
   * something must still finish the job — the reconciliation rail, which is
   * also what makes the outcome observable to a caller that got the 202.
   */
  private abandonStalledActivation(
    slug: string | undefined,
    activating: Promise<void>,
  ): void {
    this.agentConfigurationActivationEpoch =
      (this.agentConfigurationActivationEpoch ?? 0) + 1;
    this.logger?.warn?.(
      'Runtime activation exceeded its deadline; the configuration queues ' +
        'were released and reconciliation now owns it',
      {
        agent: slug,
        deadlineMs: this.activationDeadlineMs(),
      },
    );
    void activating.then(
      () => {
        this.logger?.info?.(
          'Abandoned runtime activation finished after its deadline',
          { agent: slug },
        );
      },
      (error: unknown) => {
        this.logger?.error?.('Abandoned runtime activation failed', {
          agent: slug,
          error,
        });
      },
    );
    this.markAgentAwaitingReconciliation(slug);
    this.configurationReconciliationAttempt = 0;
    this.scheduleAgentConfigurationReconciliation();
  }

  /**
   * Lets in-flight configuration work finish before teardown, without making
   * shutdown hostage to it (archive#3622).
   *
   * `agentConfigurationMutationsClosed` is already set by the time this runs,
   * so nothing new can enter either queue; what is left is whatever was
   * already executing. A durable write is short and worth waiting for. An
   * activation that outran its own deadline is by definition one nobody can
   * wait for, so past the grace period shutdown proceeds and says so.
   */
  private async drainConfigurationQueues(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drained = (async () => {
      await this.agentConfigurationPersistenceQueue;
      await this.agentConfigurationMutationQueue;
      return 'drained' as const;
    })().catch(() => 'drained' as const);
    const grace = new Promise<'timed-out'>((resolve) => {
      timer = setTimeout(() => resolve('timed-out'), this.drainGraceMs());
      this.timers?.push(timer);
    });
    let outcome: 'drained' | 'timed-out';
    try {
      outcome = await Promise.race([drained, grace]);
    } finally {
      if (timer) this.releaseRuntimeTimer(timer);
    }
    if (outcome === 'timed-out') {
      this.logger?.warn?.(
        'Configuration queues did not drain before shutdown; proceeding ' +
          'without them',
        { graceMs: this.drainGraceMs() },
      );
    }
  }

  /**
   * Read through accessors, never off the field: several runtime suites build
   * a partial instance with `Object.create(StationRuntime.prototype)` and
   * assign only the fields they need, so a class field only a real constructor
   * populates reads `undefined` there — and `setTimeout(fn, undefined)` fires
   * on the next tick, which would silently turn every wait-mode mutation in
   * those suites into an instant abandonment. Same reason the activation
   * index above is lazily initialized at its use sites.
   */
  private activationDeadlineMs(): number {
    return (
      this.agentConfigurationActivationDeadlineMs ??
      AGENT_CONFIGURATION_ACTIVATION_DEADLINE_MS
    );
  }

  private drainGraceMs(): number {
    return (
      this.agentConfigurationShutdownDrainGraceMs ??
      AGENT_CONFIGURATION_SHUTDOWN_DRAIN_GRACE_MS
    );
  }

  private releaseRuntimeTimer(timer: ReturnType<typeof setTimeout>): void {
    clearTimeout(timer);
    if (Array.isArray(this.timers)) {
      const index = this.timers.indexOf(timer);
      if (index >= 0) this.timers.splice(index, 1);
    }
  }

  /**
   * Records an activation as in flight for its slug, for exactly as long as it
   * is running.
   *
   * This is what "activation pending" is derived from. It replaced
   * `configurationReconciliationScheduled`, which was a GLOBAL timer flag: it
   * named no slug (so an unrelated inactive agent was told 503 "activating"),
   * and it flips false the moment reconciliation begins (so the one agent
   * actually mid-activation could be told 409 "not active" while its
   * activation was still running). A per-slug entry that exists precisely
   * while the work exists cannot say either of those things.
   */
  private markAgentAwaitingReconciliation(slug: string | undefined): void {
    if (!slug) return;
    this.agentsAwaitingReconciliation ??= new Map();
    this.agentsAwaitingReconciliation.set(slug, {
      attempts: 0,
    });
    // A fresh write is a fresh attempt: whatever failed last time was about
    // the previous bytes, and reporting it against these would be a stale
    // accusation.
    this.agentActivationFailures?.delete(slug);
  }

  /**
   * Settle the pending set against what a finished reconciliation pass
   * actually produced.
   *
   * Retiring the whole set on any successful pass was wrong, and subtly so.
   * `agentConfigurationPersistenceRevision` increments when the durable write
   * BEGINS, so a pass already in flight can capture the new revision, read the
   * agents directory before the file lands, and still succeed — after the
   * create marked its slug. A wholesale clear then retired a slug that pass
   * never saw, and the successor pass could take the loaded-state fast path
   * and no-op, leaving the Agent at 409 forever.
   *
   * So a slug is retired only on EVIDENCE that this pass covered it: the
   * runtime's metadata map is cleared and repopulated from disk by every full
   * reload, so the slug being in it afterwards is exactly "the pass read this
   * agent". Anything else stays pending and the next pass tries again —
   * bounded by `MAX_ACTIVATION_ATTEMPTS`, because an activation that will
   * never succeed has to stop calling itself "in progress".
   */
  private settleAwaitingReconciliation(passError?: unknown): void {
    const pending = this.agentsAwaitingReconciliation;
    if (!pending || pending.size === 0) return;
    const covered = this.agentMetadataMap ?? new Map();
    for (const [slug, state] of [...pending]) {
      if (passError === undefined && covered.has(slug)) {
        pending.delete(slug);
        continue;
      }
      state.attempts += 1;
      if (state.attempts < MAX_ACTIVATION_ATTEMPTS) continue;
      pending.delete(slug);
      const reason =
        passError instanceof Error
          ? passError.message
          : passError !== undefined
            ? String(passError)
            : 'Station reloaded its agents but this one did not become active.';
      this.agentActivationFailures ??= new Map();
      this.agentActivationFailures.set(slug, {
        reason,
        at: new Date().toISOString(),
      });
      this.logger?.error?.('Agent activation gave up after repeated attempts', {
        agent: slug,
        attempts: state.attempts,
        reason,
      });
    }
  }

  private trackAgentActivation(
    slug: string | undefined,
    activating: Promise<void>,
  ): Promise<void> {
    if (!slug) return activating;
    this.agentActivationsInFlight ??= new Map();
    const inFlight = this.agentActivationsInFlight;
    const tracked = activating.finally(() => {
      // Identity-checked: only clear the entry this call put there.
      if (inFlight.get(slug) === tracked) inFlight.delete(slug);
    });
    inFlight.set(slug, tracked);
    return tracked;
  }

  private scheduleAgentConfigurationReconciliation(): void {
    if (
      this.configurationReconciliationScheduled ||
      this.agentConfigurationMutationsClosed
    ) {
      return;
    }
    // Retry indefinitely, but cap the interval after the initial fast passes.
    // Exhausting this rail would leave both loaded revisions null forever and
    // reject all runtime work until an unrelated config event or restart.
    const delay =
      CONFIGURATION_RECONCILIATION_DELAYS_MS[
        Math.min(
          this.configurationReconciliationAttempt,
          CONFIGURATION_RECONCILIATION_DELAYS_MS.length - 1,
        )
      ];
    this.configurationReconciliationScheduled = true;
    const timer = setTimeout(() => {
      if (Array.isArray(this.timers)) {
        const index = this.timers.indexOf(timer);
        if (index >= 0) this.timers.splice(index, 1);
      }
      this.configurationReconciliationScheduled = false;
      void this.reconcileAgentConfigurationSources()
        .then((reloaded) => {
          this.configurationReconciliationAttempt = 0;
          // Per slug, and only for slugs this pass demonstrably covered —
          // see `settleAwaitingReconciliation` for the race a wholesale clear
          // lost to.
          this.settleAwaitingReconciliation();
          if (this.agentsAwaitingReconciliation?.size) {
            // Still owed. Without this the create's own successor pass is the
            // only retry, and it can no-op on the loaded-state fast path.
            this.scheduleAgentConfigurationReconciliation();
          }
          if (reloaded) this.observeReconciliationChurn();
        })
        .catch((error) => {
          this.configurationReconciliationAttempt += 1;
          this.logger?.error?.('Configuration reconciliation failed', {
            error,
            attempt: this.configurationReconciliationAttempt,
          });
          this.settleAwaitingReconciliation(error);
          this.scheduleAgentConfigurationReconciliation();
        });
    }, delay);
    this.timers?.push(timer);
  }

  /**
   * Churn detector for the reconciliation rail (archive#1574): a healthy runtime
   * reconciles once per external change, so a burst of completions means the
   * reconcile pass itself (or something it triggers) keeps bumping a
   * launchability revision — the feedback loop observed live on 2026-08-02
   * (one pass per ~1.4s, indefinitely, every catalog read unstable). The
   * loop cannot be broken generically here without masking real changes, so
   * the contract is: name the oscillating counters loudly, once per window.
   */
  private observeReconciliationChurn(): void {
    const now = Date.now();
    if (now - this.reconciliationChurnWindowStartMs > 30_000) {
      this.reconciliationChurnWindowStartMs = now;
      this.reconciliationChurnCount = 0;
    }
    this.reconciliationChurnCount += 1;
    if (this.reconciliationChurnCount === 10) {
      this.logger?.error?.(
        'Agent configuration reconciliation ran 10 full reloads in 30s. ' +
          'Either a burst of legitimate configuration changes, or something ' +
          'is bumping a launchability revision after each reconcile pass — ' +
          'if no operator activity explains it, these counters name the ' +
          'oscillating source.',
        {
          providerLaunchabilityRevision:
            this.providerService.getLaunchabilityRevision(),
          appConfigLaunchabilityRevision:
            this.configLoader.getLaunchabilityRevision(),
          loadedProviderLaunchabilityRevision:
            this.loadedProviderLaunchabilityRevision,
          loadedAppConfigLaunchabilityRevision:
            this.loadedAppConfigLaunchabilityRevision,
        },
      );
    }
  }

  /** Resolves true when a reload actually ran (false for the no-op fast path). */
  private async reconcileAgentConfigurationSources(): Promise<boolean> {
    return await this.serializeAgentConfigurationAccess(async () => {
      // The loaded-state check answers "are the provider/app-config sources
      // current", which says nothing about an agent file written since. A
      // pending slug is precisely the case where they are current and the
      // runtime still has not read this agent, so the fast path must not
      // claim there is nothing to do.
      if (
        this.runtimeConfigurationSourcesAreLoaded() &&
        (this.loadedPluginSkillSourceRevision ?? 0) ===
          (this.pluginSkillSourceRevision ?? 0) &&
        !this.agentsAwaitingReconciliation?.size
      ) {
        return false;
      }
      this.agentConfigurationRevision += 1;
      try {
        await this.reloadConfigurationFromDisk();
      } finally {
        this.agentConfigurationRevision += 1;
      }
      return true;
    });
  }

  private runtimeConfigurationSourcesAreLoaded(): boolean {
    return (
      this.loadedProviderLaunchabilityRevision !== null &&
      this.loadedAppConfigLaunchabilityRevision !== null &&
      typeof this.loadedSelectedPackageFingerprint === 'string' &&
      this.providerService.getLaunchabilityRevision() ===
        this.loadedProviderLaunchabilityRevision &&
      this.configLoader.getLaunchabilityRevision() ===
        this.loadedAppConfigLaunchabilityRevision &&
      this.captureSelectedPackageFingerprint() ===
        this.loadedSelectedPackageFingerprint
    );
  }

  /**
   * archive#983 (scoped advance, station#settings-revamp slice 6, docs/
   * design/settings-architecture.md §6): the config watcher already filters,
   * dedupes, and reconciles `agents/*\/agent.json`/`integrations/*\/
   * integration.json` file events into `ConfigLoader.on('add'|'change'|
   * 'remove', ...)`, but until this wiring, nothing in production ever
   * subscribed — the whole watcher half was computed and discarded.
   *
   * This reuses `reloadAgents()` — the SAME unconditional "resync the
   * runtime's agent set from disk" entrypoint `scheduleRuntimeDailyReload`
   * already fires on a timer and `POST /api/agents/reload` fires on demand —
   * rather than `scheduleAgentConfigurationReconciliation()` below: that
   * reconciliation path is gated on the provider/app-config LAUNCHABILITY
   * REVISION counters actually having drifted, which an agent/integration
   * file edit never touches, so gating this on it would silently no-op.
   *
   * Review round 1 HIGH 2 + MEDIUM 1, both folded into
   * `runWatchedConfigFileReload` below:
   *
   *   - `CONFIG_CHANGED` is emitted only AFTER `reloadAgents()` resolves —
   *     emitting it up front (as this first shipped) let a client that
   *     refetches on the event win a race against the reload and read the
   *     stale pre-change agent list, and it fired even when the reload
   *     rejected, falsely claiming a change took effect. A rejection is now
   *     logged via the runtime logger (previously silently swallowed) and
   *     emits nothing.
   *   - The handler coalesces a burst of events into one reload rather than
   *     one-per-event (a single external edit routinely produces several:
   *     add+change, or several files touched in one save). Mirrors
   *     `configurationReconciliationScheduled`'s simple boolean reentry
   *     guard rather than a timer-based debounce: a reload already in
   *     flight absorbs every event that arrives before it settles, and at
   *     most one further reload is queued to run immediately after, so a
   *     change that lands mid-reload is still picked up rather than
   *     silently dropped.
   *
   * Not in scope (stays archive#983): reading WHICH agent/integration changed and
   * doing a narrower, content-aware reload — this only stops discarding the
   * notification that *something* under `agents/`/`integrations/` changed.
   */
  private observeRuntimeConfigurationSources(): void {
    if (this.configurationSourceUnsubscribers.length > 0) return;
    const onChange = () => this.scheduleAgentConfigurationReconciliation();
    const projectHomeDir = this.configLoader.getProjectHomeDir();
    let watchedConfigFileReloadInFlight = false;
    let watchedConfigFileReloadQueued = false;
    const runWatchedConfigFileReload = (): void => {
      watchedConfigFileReloadInFlight = true;
      this.reloadAgents()
        .then(() => {
          // Watcher-driven reloads bypass the reconciliation rail, so they
          // must feed the churn detector themselves — the archive#1588 write loop
          // ran 200+ reloads through this exact path without a single churn
          // log because only the rail was counted.
          this.observeReconciliationChurn();
          this.eventBus.emit(SERVER_EVENTS.CONFIG_CHANGED, {
            source: 'config-watcher',
          });
        })
        .catch((error) => {
          this.logger?.error?.(
            'Failed to reload agents after an external agent/integration ' +
              'config file change',
            { error },
          );
        })
        .finally(() => {
          watchedConfigFileReloadInFlight = false;
          if (watchedConfigFileReloadQueued) {
            watchedConfigFileReloadQueued = false;
            runWatchedConfigFileReload();
          }
        });
    };
    const onWatchedConfigFileEvent = (path: unknown): void => {
      if (typeof path !== 'string') return;
      if (!isAgentOrIntegrationConfigPath(projectHomeDir, path)) return;
      if (watchedConfigFileReloadInFlight) {
        watchedConfigFileReloadQueued = true;
        return;
      }
      runWatchedConfigFileReload();
    };
    this.configLoader.on('add', onWatchedConfigFileEvent);
    this.configLoader.on('change', onWatchedConfigFileEvent);
    this.configLoader.on('remove', onWatchedConfigFileEvent);
    this.configurationSourceUnsubscribers = [
      this.providerService.onLaunchabilityChange(onChange),
      this.configLoader.onLaunchabilityChange(onChange),
      () => {
        this.configLoader.off('add', onWatchedConfigFileEvent);
        this.configLoader.off('change', onWatchedConfigFileEvent);
        this.configLoader.off('remove', onWatchedConfigFileEvent);
      },
    ];
    if (!this.runtimeConfigurationSourcesAreLoaded()) onChange();
  }

  private stopObservingRuntimeConfigurationSources(): void {
    const unsubscribers = this.configurationSourceUnsubscribers ?? [];
    this.configurationSourceUnsubscribers = [];
    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
  }

  async commitAgentConfigurationRead<T>(
    expectedRevision: number,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.serializeAgentConfigurationPersistence(() =>
      this.serializeAgentConfigurationAccess(async () => {
        if (this.getStableAgentConfigurationRevision() !== expectedRevision) {
          throw new RuntimeConfigurationConflictError();
        }
        const result = await this.runBoundedConfigurationRead(operation);
        if (this.getStableAgentConfigurationRevision() !== expectedRevision) {
          throw new RuntimeConfigurationConflictError();
        }
        return result;
      }),
    );
  }

  private async runBoundedConfigurationRead<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    let timeout: NodeJS.Timeout | null = null;
    const leaseTimeout = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        reject(new RuntimeConfigurationConflictError());
      }, CONFIGURATION_READ_LEASE_TIMEOUT_MS);
    });
    try {
      return await Promise.race([operation(), leaseTimeout]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async reloadAgentsFromDisk(
    composition?: PluginActivationComposition,
  ): Promise<void> {
    const configurationBefore = this.captureAgentConfigurationRevisions();
    this.loadedProviderLaunchabilityRevision = null;
    this.loadedAppConfigLaunchabilityRevision = null;
    const preparationState: RuntimeAgentPreparationState = {
      agentFixedTokens: new Map(),
      agentHooksMap: new Map(),
      agentSpecs: new Map(),
      agentTools: new Map(),
      globalToolRegistry: new Map(),
      integrationMetadata: new Map(),
      mcpConfigs: new Map(),
      mcpConnectionStatus: new Map(),
      memoryAdapters: new Map(),
      mcpToolProvenanceGeneration: createMCPToolProvenanceGeneration(),
      // A fresh generation must never inherit a prior runtime name's
      // authority. A replacement may reuse its presentation name; collisions
      // apply only among tools admitted to this staged snapshot.
      toolNameMapping: new Map(),
      toolNameReverseMapping: new Map(),
    };
    for (const [source, target] of [
      [this.agentFixedTokens, preparationState.agentFixedTokens],
      [this.agentHooksMap, preparationState.agentHooksMap],
      [this.agentSpecs, preparationState.agentSpecs],
      [this.agentTools, preparationState.agentTools],
      [this.memoryAdapters, preparationState.memoryAdapters],
    ] as Array<[Map<string, any>, Map<string, any>]>) {
      const defaultValue = source.get('default');
      if (defaultValue !== undefined) target.set('default', defaultValue);
    }
    let stagedAppConfig: AppConfig | null = null;
    const appConfig = await reloadRuntimeAgents({
      configLoader: composition
        ? this.configLoader.forPluginActivationComposition(composition)
        : this.configLoader,
      activeAgents: this.activeAgents,
      agentMetadataMap: this.agentMetadataMap,
      agentSpecs: this.agentSpecs,
      agentTools: this.agentTools,
      memoryAdapters: this.memoryAdapters,
      mcpConfigs: this.mcpConfigs,
      preparedMcpConfigs: preparationState.mcpConfigs,
      mcpConnectionStatus: this.mcpConnectionStatus,
      integrationMetadata: this.integrationMetadata,
      voltAgent: this.voltAgent
        ? {
            registerAgent: (agent) => this.voltAgent?.registerAgent(agent),
            removeAgent: (id) => AgentRegistry.getInstance().removeAgent(id),
          }
        : undefined,
      logger: this.logger,
      eventBus: this.eventBus,
      prepareVoltAgentInstance: (slug, nextAppConfig) =>
        prepareRuntimeAgentInstance(
          this.runtimeAgentBuilderContext(slug, nextAppConfig, composition),
          preparationState,
        ),
      activateVoltAgentInstance: (prepared) =>
        activatePreparedRuntimeAgentInstance(prepared, {
          ...this.runtimeAgentBuilderContext(
            prepared.slug,
            stagedAppConfig ?? this.appConfig,
            composition,
          ),
          ...preparationState,
        }),
      commitPreparedResources: () => {
        this.mcpToolProvenanceGeneration.revoke();
        this.mcpToolProvenanceGeneration =
          preparationState.mcpToolProvenanceGeneration;
        for (const [key, value] of preparationState.mcpConfigs) {
          this.mcpConfigs.set(key, value);
        }
        for (const [key, value] of preparationState.mcpConnectionStatus) {
          this.mcpConnectionStatus.set(key, value);
        }
        for (const [key, value] of preparationState.integrationMetadata) {
          this.integrationMetadata.set(key, value);
        }
        for (const [source, target] of [
          [preparationState.agentFixedTokens, this.agentFixedTokens],
          [preparationState.agentHooksMap, this.agentHooksMap],
          [preparationState.agentSpecs, this.agentSpecs],
          [preparationState.agentTools, this.agentTools],
          [preparationState.memoryAdapters, this.memoryAdapters],
          [preparationState.globalToolRegistry, this.globalToolRegistry],
        ] as Array<[Map<string, any>, Map<string, any>]>) {
          target.clear();
          for (const [key, value] of source) target.set(key, value);
        }
        this.toolNameMapping.clear();
        for (const [key, value] of preparationState.toolNameMapping) {
          this.toolNameMapping.set(key, value);
        }
        this.toolNameReverseMapping.clear();
        for (const [key, value] of preparationState.toolNameReverseMapping) {
          this.toolNameReverseMapping.set(key, value);
        }
      },
      cleanupPreparedResources: async () => {
        const failures: unknown[] = [];
        for (const config of preparationState.mcpConfigs.values()) {
          try {
            await config.disconnect();
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length > 0) {
          throw new AggregateError(
            failures,
            'Prepared agent resource cleanup failed.',
          );
        }
      },
      assertConfigurationCurrent: () =>
        this.assertAgentConfigurationRevisions(configurationBefore),
      retainRetiredResource: (_key, config) => {
        this.retiredMcpConfigs.add(config);
      },
      releaseRetiredResource: (config) => {
        this.retiredMcpConfigs.delete(config);
      },
      loadAppConfig: async () => {
        stagedAppConfig = await this.configLoader.loadAppConfig();
        return stagedAppConfig;
      },
    });
    await this.reloadDefaultAgentFromConfig(appConfig, composition);
    this.rebuildGlobalToolRegistry();
    this.assertAgentConfigurationRevisions(configurationBefore);
    this.appConfig = appConfig;
    this.usageTelemetry?.reconfigure(appConfig);
    applyConfiguredLogLevel(appConfig.logLevel, this.logger);
    this.recordLoadedConfigurationRevisions(configurationBefore);
  }

  /**
   * Full configuration activation plus any retained installed-plugin Skill
   * discovery obligation. The revision comparison makes a failed activation
   * retry discovery and prevents an older abandoned pass from clearing a newer
   * plugin mutation's obligation.
   */
  private async reloadConfigurationFromDisk(
    composition?: PluginActivationComposition,
  ): Promise<void> {
    const requestedSkillRevision = this.pluginSkillSourceRevision ?? 0;
    if (
      (this.loadedPluginSkillSourceRevision ?? 0) !== requestedSkillRevision
    ) {
      await this.skillService.discoverSkills(
        this.configLoader.getProjectHomeDir(),
        getActiveRuntimeProjectSlug(this.storageAdapter),
        composition,
      );
    }
    await this.reloadAgentsFromDisk(composition);
    this.loadedPluginSkillSourceRevision = requestedSkillRevision;
  }

  /**
   * Applies one persisted agent definition without rebuilding every managed
   * agent or rebinding the default model. Agent CRUD writes do not alter the
   * provider/app-config generations, so the broad reload is both unnecessary
   * and the source of save-path queueing under a loaded runtime.
   */
  private async reloadPersistedAgentFromDisk(slug: string): Promise<void> {
    const configurationBefore = this.captureAgentConfigurationRevisions();
    const target = await this.resolvePersistedAgentReloadTarget(slug);
    if (target.kind === 'reload-all') {
      await this.reloadConfigurationFromDisk();
      return;
    }
    const transaction = this.beginPersistedAgentActivationTransaction(slug);
    if (target.kind === 'removed') {
      this.applyRemovedPersistedAgent(slug, transaction, configurationBefore);
    } else if (target.kind === 'external') {
      this.applyExternalPersistedAgent(
        slug,
        target,
        transaction,
        configurationBefore,
      );
    } else {
      await this.activateManagedPersistedAgent(
        slug,
        target,
        transaction,
        configurationBefore,
      );
    }
  }

  private async resolvePersistedAgentReloadTarget(
    slug: string,
  ): Promise<PersistedAgentReloadTarget> {
    // A delete has no persisted spec to inspect, so check the live prior
    // definition first. Its MCP resources still need broad lifecycle cleanup.
    if (this.agentSpecs.get(slug)?.tools?.mcpServers?.length) {
      return { kind: 'reload-all' };
    }
    const metadata = (await this.configLoader.listAgents()).find(
      (candidate) => candidate.slug === slug,
    );
    if (!metadata) return { kind: 'removed' };
    const spec = await this.configLoader.loadAgent(slug);
    // MCP resources are shared across agents, so their staged lifecycle
    // remains owned by the broad reload transaction.
    if (spec?.tools?.mcpServers?.length) {
      return { kind: 'reload-all' };
    }
    return isExternalEngineBoundAgent(metadata)
      ? { kind: 'external', metadata, spec }
      : { kind: 'managed', metadata, spec };
  }

  private applyRemovedPersistedAgent(
    slug: string,
    transaction: PersistedAgentActivationTransaction,
    configurationBefore: AgentConfigurationGeneration,
  ): void {
    this.removePersistedAgentRuntimeState(slug, transaction);
    this.completePersistedAgentTransition(configurationBefore);
  }

  private applyExternalPersistedAgent(
    slug: string,
    target: Extract<PersistedAgentReloadTarget, { kind: 'external' }>,
    transaction: PersistedAgentActivationTransaction,
    configurationBefore: AgentConfigurationGeneration,
  ): void {
    this.removePersistedAgentRuntimeState(slug, transaction);
    this.agentMetadataMap.set(slug, target.metadata);
    // Deliberate divergence, tolerated: neither cold boot
    // (`runtime-agent-registry.ts`) nor the broad reload
    // (`reloadRuntimeAgents`) ever publishes a spec for an
    // external-engine-bound record — both skip it, and the broad reload's
    // clear-and-copy drops this entry again on the next full reload. So
    // ABSENCE is the steady state every `agentSpecs` consumer already
    // tolerates, and this extra entry is additive rather than load-bearing.
    // The only narrow-path reader is `resolvePersistedAgentReloadTarget`'s
    // MCP guard, and both of its outcomes are correct here: broad cleanup
    // while the entry exists, narrow while it does not, because an external
    // agent's tools belong to its engine and Station never connected MCP
    // resources on its behalf. Converging the two would mean teaching the
    // broad reload to publish specs it never prepared — a change to
    // full-reload semantics, out of scope for narrow activation.
    this.agentSpecs.set(slug, target.spec);
    this.completePersistedAgentTransition(configurationBefore);
  }

  private async activateManagedPersistedAgent(
    slug: string,
    target: Extract<PersistedAgentReloadTarget, { kind: 'managed' }>,
    transaction: PersistedAgentActivationTransaction,
    configurationBefore: AgentConfigurationGeneration,
  ): Promise<void> {
    let nextAgent: Agent;
    try {
      nextAgent = await this.createStagedPersistedAgent(
        slug,
        transaction.preparationState,
      );
    } catch (error) {
      if (!(error instanceof ManagedModelUnavailableError)) throw error;
      this.applyUnavailablePersistedAgent(
        slug,
        target,
        transaction,
        configurationBefore,
        error,
      );
      return;
    }
    this.publishStagedPersistedAgent(
      slug,
      target.metadata,
      nextAgent,
      transaction,
      configurationBefore,
    );
    this.emitAgentsChanged();
  }

  private applyUnavailablePersistedAgent(
    slug: string,
    target: Extract<PersistedAgentReloadTarget, { kind: 'managed' }>,
    transaction: PersistedAgentActivationTransaction,
    configurationBefore: AgentConfigurationGeneration,
    error: ManagedModelUnavailableError,
  ): void {
    this.removePersistedAgentRuntimeState(slug, transaction);
    this.agentMetadataMap.set(slug, target.metadata);
    this.agentSpecs.set(slug, target.spec);
    this.logger.info('Agent is unavailable until a model is configured', {
      agent: slug,
      reason: error.message,
    });
    this.completePersistedAgentTransition(configurationBefore);
  }

  private removePersistedAgentRuntimeState(
    slug: string,
    transaction: PersistedAgentActivationTransaction,
  ): void {
    if (transaction.previousAgent) {
      this.activeAgents.delete(slug);
      AgentRegistry.getInstance().removeAgent(
        transaction.previousAgent.id ?? slug,
      );
    }
    this.agentMetadataMap.delete(slug);
    this.agentSpecs.delete(slug);
    this.agentTools.delete(slug);
    this.agentFixedTokens.delete(slug);
    this.agentHooksMap.delete(slug);
    this.memoryAdapters.delete(slug);
  }

  /**
   * Closing step for the three non-managed narrow outcomes (removed,
   * external, model-unavailable). Unlike `publishStagedPersistedAgent`,
   * these get no rollback: they have already mutated the live maps by the
   * time `assertAgentConfigurationRevisions` can reject, and that asymmetry
   * is deliberate. A rejection here means the provider, app-config, or
   * persistence generation moved mid-transition, so the whole live snapshot
   * is stale — not just this slug — and restoring the prior single-agent
   * entries would republish equally stale state. The throw propagates to
   * `applyAgentConfigurationMutation`'s immediate-activation branch (the
   * only caller of `reloadPersistedAgentFromDisk`; `activationMode: 'defer'`
   * never reaches here), which nulls both loaded launchability revisions.
   * That closes the stable read generation
   * (`getStableAgentConfigurationRevision` returns null, so no new work is
   * admitted) and keeps `runtimeConfigurationSourcesAreLoaded` false, so the
   * scheduled reconciliation — which retries indefinitely at a capped
   * interval — runs a full `reloadAgentsFromDisk` and republishes a
   * complete snapshot. Bounded blast radius, self-healing.
   */
  private completePersistedAgentTransition(
    configurationBefore: AgentConfigurationGeneration,
  ): void {
    this.rebuildGlobalToolRegistry();
    this.emitAgentsChanged();
    this.assertAgentConfigurationRevisions(configurationBefore);
  }

  private beginPersistedAgentActivationTransaction(
    slug: string,
  ): PersistedAgentActivationTransaction {
    return {
      preparationState: this.snapshotRuntimeAgentPreparationState(),
      originalState: this.snapshotRuntimeAgentPreparationState(),
      previousAgent: this.activeAgents.get(slug),
      hadPreviousMetadata: this.agentMetadataMap.has(slug),
      previousMetadata: this.agentMetadataMap.get(slug),
    };
  }

  private snapshotRuntimeAgentPreparationState(): RuntimeAgentPreparationState {
    return {
      agentFixedTokens: new Map(this.agentFixedTokens),
      agentHooksMap: new Map(this.agentHooksMap),
      agentSpecs: new Map(this.agentSpecs),
      agentTools: new Map(this.agentTools),
      globalToolRegistry: new Map(this.globalToolRegistry),
      integrationMetadata: new Map(this.integrationMetadata),
      mcpConfigs: new Map(this.mcpConfigs),
      mcpConnectionStatus: new Map(this.mcpConnectionStatus),
      memoryAdapters: new Map(this.memoryAdapters),
      mcpToolProvenanceGeneration: this.mcpToolProvenanceGeneration,
      toolNameMapping: new Map(this.toolNameMapping),
      toolNameReverseMapping: new Map(this.toolNameReverseMapping),
    };
  }

  private async createStagedPersistedAgent(
    slug: string,
    preparationState: RuntimeAgentPreparationState,
  ): Promise<Agent> {
    const prepared = await this.preparePersistedAgentInstance(
      slug,
      preparationState,
    );
    return activatePreparedRuntimeAgentInstance(prepared, {
      ...this.runtimeAgentBuilderContext(slug, this.appConfig),
      ...preparationState,
    });
  }

  private publishStagedPersistedAgent(
    slug: string,
    metadata: unknown,
    nextAgent: Agent,
    transaction: PersistedAgentActivationTransaction,
    configurationBefore: AgentConfigurationGeneration,
  ): void {
    let publicationAttempted = false;
    try {
      this.assertAgentConfigurationRevisions(configurationBefore);
      publicationAttempted = true;
      this.voltAgent?.registerAgent(nextAgent);
      if (
        transaction.previousAgent &&
        (transaction.previousAgent.id ?? slug) !== (nextAgent.id ?? slug)
      ) {
        AgentRegistry.getInstance().removeAgent(
          transaction.previousAgent.id ?? slug,
        );
      }
      this.copyRuntimeAgentPreparationState(transaction.preparationState);
      this.agentMetadataMap.set(slug, metadata);
      this.activeAgents.set(slug, nextAgent);
      this.rebuildGlobalToolRegistry();
      this.assertAgentConfigurationRevisions(configurationBefore);
    } catch (error) {
      this.restorePersistedAgentActivationTransaction(
        slug,
        nextAgent,
        transaction,
        publicationAttempted,
        error,
      );
    }
  }

  private copyRuntimeAgentPreparationState(
    source: RuntimeAgentPreparationState,
    includeGlobalToolRegistry = false,
  ): void {
    // MCP/integration maps remain staged-only here: narrow activation falls
    // back to the full lifecycle whenever either agent owns MCP resources.
    const maps: Array<[Map<string, any>, Map<string, any>]> = [
      [source.agentFixedTokens, this.agentFixedTokens],
      [source.agentHooksMap, this.agentHooksMap],
      [source.agentSpecs, this.agentSpecs],
      [source.agentTools, this.agentTools],
      [source.memoryAdapters, this.memoryAdapters],
    ];
    if (includeGlobalToolRegistry) {
      maps.push([source.globalToolRegistry, this.globalToolRegistry]);
    }
    for (const [from, target] of maps) {
      target.clear();
      for (const [key, value] of from) target.set(key, value);
    }
  }

  private restorePersistedAgentActivationTransaction(
    slug: string,
    nextAgent: Agent,
    transaction: PersistedAgentActivationTransaction,
    publicationAttempted: boolean,
    error: unknown,
  ): never {
    const rollbackErrors: unknown[] = [];
    this.copyRuntimeAgentPreparationState(transaction.originalState, true);
    if (transaction.previousAgent) {
      this.activeAgents.set(slug, transaction.previousAgent);
    } else {
      this.activeAgents.delete(slug);
    }
    if (transaction.hadPreviousMetadata) {
      this.agentMetadataMap.set(slug, transaction.previousMetadata);
    } else {
      this.agentMetadataMap.delete(slug);
    }
    if (publicationAttempted) {
      try {
        if (
          (nextAgent.id ?? slug) !== (transaction.previousAgent?.id ?? slug)
        ) {
          AgentRegistry.getInstance().removeAgent(nextAgent.id ?? slug);
        }
        if (transaction.previousAgent) {
          this.voltAgent?.registerAgent(transaction.previousAgent);
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        'Persisted agent activation failed and rollback was incomplete.',
      );
    }
    throw error;
  }

  private async preparePersistedAgentInstance(
    slug: string,
    preparationState: RuntimeAgentPreparationState,
  ) {
    return prepareRuntimeAgentInstance(
      this.runtimeAgentBuilderContext(slug, this.appConfig),
      preparationState,
    );
  }

  private emitAgentsChanged(): void {
    try {
      this.eventBus.emit(SERVER_EVENTS.AGENTS_CHANGED, {
        count: this.agentMetadataMap.size,
      });
    } catch (error) {
      this.logger.error('Agent reload event listener failed', { error });
    }
  }

  /** Canonical selected-generation identity, including activation-pending generations.
   * Claims, PIDs and history are not configuration authority. Optional selection
   * metadata participates as opaque identity, never filesystem/path admission. */
  private captureSelectedPackageFingerprint(): string | null {
    try {
      const selected = this.orchestrationEventStore
        ?.createPackageMcpAdmissionJournal()
        .selectedInstallations();
      if (
        selected?.state !== 'observed' ||
        !Array.isArray(selected.installations)
      )
        return null;
      const ids = new Set<string>();
      const identities: string[] = [];
      for (const item of selected.installations) {
        if (
          !item ||
          [
            item.journalId,
            item.pluginId,
            item.incarnation,
            item.contentDigest,
          ].some((value) => typeof value !== 'string' || value.length === 0) ||
          ids.has(item.pluginId) ||
          [item.materialization, item.dataScope, item.origin].some(
            (value) => value !== undefined && typeof value !== 'string',
          )
        )
          return null;
        ids.add(item.pluginId);
        identities.push(
          JSON.stringify([
            item.journalId,
            item.pluginId,
            item.incarnation,
            item.contentDigest,
            item.materialization ?? null,
            item.dataScope ?? null,
            item.origin ?? null,
          ]),
        );
      }
      return createHash('sha256')
        .update(JSON.stringify(identities.sort()))
        .digest('hex');
    } catch {
      return null;
    }
  }

  private assertAgentConfigurationRevisions(expected: {
    provider: number;
    appConfig: number;
    selectedPackageFingerprint?: string;
    persistence?: number;
    activationEpoch?: number;
  }): void {
    const current = this.captureAgentConfigurationRevisions();
    if (
      expected.provider !== current.provider ||
      expected.appConfig !== current.appConfig ||
      expected.selectedPackageFingerprint !==
        current.selectedPackageFingerprint ||
      (expected.persistence !== undefined &&
        expected.persistence !== current.persistence) ||
      (expected.activationEpoch !== undefined &&
        expected.activationEpoch !== current.activationEpoch)
    ) {
      throw new Error(
        'Runtime configuration changed while agents were being reloaded.',
      );
    }
  }

  private captureAgentConfigurationRevisions(): {
    provider: number;
    appConfig: number;
    selectedPackageFingerprint: string;
    persistence: number;
    activationEpoch: number;
  } {
    const selectedPackageFingerprint = this.captureSelectedPackageFingerprint();
    if (selectedPackageFingerprint === null) {
      throw new Error('Selected package generations could not be verified.');
    }
    return {
      selectedPackageFingerprint,
      provider: this.providerService.getLaunchabilityRevision(),
      appConfig: this.configLoader.getLaunchabilityRevision(),
      persistence: this.agentConfigurationPersistenceRevision ?? 0,
      activationEpoch: this.agentConfigurationActivationEpoch ?? 0,
    };
  }

  private recordLoadedConfigurationRevisions(revisions: {
    provider: number;
    appConfig: number;
    selectedPackageFingerprint?: string;
    persistence?: number;
  }): void {
    this.loadedProviderLaunchabilityRevision = revisions.provider;
    this.loadedAppConfigLaunchabilityRevision = revisions.appConfig;
    // Record the selection used by construction, never a new read that could
    // relabel already-built agents after another runtime selected a generation.
    this.loadedSelectedPackageFingerprint =
      typeof revisions.selectedPackageFingerprint === 'string' &&
      revisions.selectedPackageFingerprint.length > 0
        ? revisions.selectedPackageFingerprint
        : null;
  }

  private getStableAgentConfigurationRevision(): number | null {
    if (
      this.agentConfigurationMutationsClosed ||
      this.agentConfigurationRevision % 2 !== 0 ||
      !this.runtimeConfigurationSourcesAreLoaded()
    )
      return null;
    return this.agentConfigurationRevision;
  }

  /**
   * Rebuild the default Station agent after model connections change so its
   * provider binding reflects the latest persisted connection immediately.
   */
  async reloadDefaultAgent(): Promise<void> {
    await this.mutateAgentConfiguration(async () => {
      const appConfig = await this.configLoader.loadAppConfig();
      const configurationBefore = this.captureAgentConfigurationRevisions();
      this.loadedProviderLaunchabilityRevision = null;
      this.loadedAppConfigLaunchabilityRevision = null;
      await this.reloadDefaultAgentFromConfig(appConfig);
      this.rebuildGlobalToolRegistry();
      this.assertAgentConfigurationRevisions(configurationBefore);
      this.appConfig = appConfig;
      this.usageTelemetry?.reconfigure(appConfig);
      this.recordLoadedConfigurationRevisions(configurationBefore);
    });
  }

  private async reloadDefaultAgentFromConfig(
    appConfig: AppConfig,
    composition?: PluginActivationComposition,
  ): Promise<void> {
    const builtinEngineBinding =
      await this.resolveBuiltinEngineBinding(appConfig);
    await bootstrapRuntimeDefaultAgent({
      appConfig,
      builtinEngineBinding,
      configLoader: composition
        ? this.configLoader.forPluginActivationComposition(composition)
        : this.configLoader,
      framework: this.framework,
      logger: this.logger,
      usageAggregator: this.usageAggregator,
      defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT,
      autoApproveTools: SC_READ_ONLY_TOOLS,
      replaceTemplateVariables: (text) =>
        replaceRuntimeTemplateVariables(text, appConfig),
      resolveDefaultModelHint: () =>
        resolveDefaultManagedModelHint(
          appConfig,
          this.providerService.listProviderConnections(),
        ),
      createModel: (spec) =>
        createRuntimeFrameworkModel(spec, {
          framework: this.framework,
          appConfig,
          projectHomeDir: this.configLoader.getProjectHomeDir(),
          modelCatalog: this.modelCatalog,
          listProviderConnections: () =>
            this.providerService.listProviderConnections(),
        }),
      loadAgentTools: async (slug, spec, provenanceGeneration) => [
        ...(await MCPManager.loadAgentTools(
          slug,
          spec,
          this.configLoader,
          this.mcpConfigs,
          this.mcpConnectionStatus,
          this.integrationMetadata,
          this.toolNameMapping,
          this.toolNameReverseMapping,
          this.logger,
          this.port,
          provenanceGeneration!,
          this.secretBindingAdministration,
          this.mcpCustody,
        )),
        // The built-in default bypasses persisted-agent framework loading.
        // Add only the private native tool here, never through MCP/public
        // configuration, and only once for this one default-agent path.
        createNativeOutputDeclarationTool(),
      ],
      guardTools: (tools) => this.guardDefaultAgentTools(tools),
      activeAgents: this.activeAgents,
      agentTools: this.agentTools,
      memoryAdapters: this.memoryAdapters,
      agentMetadataMap: this.agentMetadataMap,
      toolNameMapping: this.toolNameMapping,
      mcpToolProvenanceGeneration: this.mcpToolProvenanceGeneration,
      agentFixedTokens: this.agentFixedTokens,
      agentHooksMap: this.agentHooksMap,
      workItemCapture: new WorkItemCapture(
        this.orchestrationEventStore,
        createEventStoreWorkItemPrincipalLiveness(this.orchestrationEventStore),
      ),
      // archive#1834 review round 2: the same guardian composition
      // runtime-agent-builder gives every persisted agent.
      approvalGuardian: new ApprovalGuardianService({
        appConfig,
        framework: this.framework,
        listProviderConnections: () =>
          this.providerService.listProviderConnections(),
        logger: this.logger,
        modelCatalog: this.modelCatalog,
        projectHomeDir: this.configLoader.getProjectHomeDir(),
      }),
      resolveUnattendedGrant: this.resolveUnattendedGrant,
    });
  }

  private guardDefaultAgentTools(tools: any[]): any[] {
    const guarded = this.guardAgentGenerationTools('default', tools);
    return guarded;
  }

  private guardAgentGenerationTools(slug: string, tools: any[]): any[] {
    let guarded: any[] = [];
    guarded = guardRuntimeGenerationTools(
      tools,
      () =>
        this.getStableAgentConfigurationRevision() !== null &&
        this.agentTools.get(slug) === guarded,
      (operation) => this.runToolWithCurrentConfiguration(operation),
    );
    return guarded;
  }

  private async runToolWithCurrentConfiguration<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const revision = this.getStableAgentConfigurationRevision();
    if (revision === null) throw new RuntimeConfigurationConflictError();
    return this.commitAgentConfigurationRead(revision, operation);
  }

  private rebuildGlobalToolRegistry(): void {
    this.globalToolRegistry.clear();
    const ordered = [
      this.agentTools.get('default') ?? [],
      ...[...this.agentTools.entries()]
        .filter(([slug]) => slug !== 'default')
        .map(([, tools]) => tools),
    ];
    for (const tools of ordered) {
      for (const tool of tools) {
        if (!this.globalToolRegistry.has(tool.name)) {
          this.globalToolRegistry.set(tool.name, tool);
        }
      }
    }
  }

  private async bootstrapVoiceAgent(): Promise<void> {
    // archive#1194 review round 2: station-voice is deliberately NEVER
    // rebound to an external engine (see `rebindBuiltinAgents`'s doc
    // comment) — this stays byte-identical to pre-#1194 behavior.
    await bootstrapRuntimeVoiceAgent({
      agentSpecs: this.agentSpecs.values(),
      configLoader: this.configLoader,
      createVoltAgentInstance: async (slug) =>
        this.createVoltAgentInstance(slug),
      agentTools: this.agentTools,
      logger: this.logger,
    });
  }

  /**
   * Re-discover skills and rebuild all agents so skill assignments take effect.
   */
  async reloadSkillsAndAgents(): Promise<void> {
    await this.mutateAgentConfiguration(async () => {
      await reloadRuntimeSkillsAndAgents({
        skillService: this.skillService,
        configLoader: this.configLoader,
        storageAdapter: this.storageAdapter,
        activeAgents: this.activeAgents,
        logger: this.logger,
        createVoltAgentInstance: async (slug) =>
          this.createVoltAgentInstance(slug),
      });
      this.loadedPluginSkillSourceRevision =
        this.pluginSkillSourceRevision ?? 0;
    });
  }

  /**
   * Initialize the runtime.
   *
   * The in-flight promise is tracked so `shutdown()` can settle it first —
   * without that, a shutdown during boot (an app quit mid-launch, or a test
   * teardown after a cancelled case) leaves the orphaned initialization
   * racing the teardown: it reads a home directory the teardown already
   * deleted and its rejection surfaces in whatever context runs next
   * (archive#1019's `custom-writer not found` cross-test contamination).
   */
  async initialize(): Promise<void> {
    const inFlight = this.runInitialize();
    this.initializeInFlight = inFlight;
    try {
      return await inFlight;
    } finally {
      if (this.initializeInFlight === inFlight) {
        this.initializeInFlight = null;
      }
    }
  }

  private async runInitialize(): Promise<void> {
    // Identity/credential state is a startup invariant. Corrupt or unsafe
    // state prevents any listener from being configured.
    const identity = await this.environmentSecurityService.initialize();
    this.stationEnvironmentId = identity.environmentId;
    const packageProjections = await this.pluginInstallationHost.reconcile();
    if (packageProjections.status === 'pending')
      this.logger.warn('Plugin catalog projection remains pending', {
        plugins: packageProjections.pending,
      });
    await this.sshEnvironmentService.initialize();
    // Terminal sessions are process-global and have no durable tenant
    // binding. A hosted tenant-isolated runtime must not bind the separate
    // terminal port until that transport has tenant authorization.
    if (!this.terminalWsStarted && !isHostedTenantExecutionRequired()) {
      this.terminalWsServer.start(this.port + 1, this.host);
      this.terminalWsStarted = true;
    }
    let initialized: Awaited<ReturnType<typeof initializeRuntime>>;
    try {
      // Private SQLite takes ownership of old config-backed credential
      // evidence before any route can accept a full config update.
      await this.connectionService.migrateLegacyCredentialApplicationsAtStartup();
      // Compatibility writes are a configuration phase, not part of the
      // revision-fenced agent-construction phase inside initializeRuntime.
      initialized = await initializeRuntime(
        createRuntimeInitializationDeps({
          port: this.port,
          host: this.host,
          logger: this.logger,
          eventBus: this.eventBus,
          approvalRegistry: this.approvalRegistry,
          environmentSecurityService: this.environmentSecurityService,
          timers: this.timers,
          configLoader: this.configLoader,
          storageAdapter: this.storageAdapter,
          skillService: this.skillService,
          feedbackService: this.feedbackService,
          voiceService: this.voiceService,
          acpBridge: this.acpBridge,
          resolveBuiltinEngineBinding: (appConfig) =>
            this.resolveBuiltinEngineBinding(appConfig),
          // ACP connections finish their first capability handshake in the
          // background. Re-resolve the reserved Station role once that live
          // evidence exists so a persisted OpenCode/Kiro choice does not stay
          // failed-safe on Station's native engine until another config write.
          onACPConnectionsReady: () => this.reloadDefaultAgent(),
          orchestrationEventStore: this.orchestrationEventStore,
          credentialProfileRecoveryAdapter:
            this.connectionService.createCredentialProfileRecoveryAdapter(
              credentialRecoveryRuntimeConnectionId,
            ),
          usageAggregator: this.usageAggregator,
          // archive#3245: lifetime analytics reads the orchestration
          // substrate through the SAME `readSessionUsage` fold the stats
          // route uses. Resolved per rescan off `this.orchestrationService`,
          // which a reload replaces underneath a reused aggregator. The
          // aggregate scope is the deliberate one: `stats.json` is a
          // home-global lifetime store with no per-user partition, and
          // `listSessionUsage` refuses the read outright in hosted mode,
          // where "home-global" would mean "across tenants".
          orchestrationUsageRef: {
            get: () =>
              this.orchestrationService
                ? {
                    listSessionUsage: () =>
                      this.orchestrationService.listSessionUsage(
                        INTERNAL_SESSION_READ_SCOPE,
                      ),
                  }
                : undefined,
          },
          monitoringEmitter: this.monitoringEmitter,
          activeAgents: this.activeAgents,
          agentMetadataMap: this.agentMetadataMap,
          memoryAdapters: this.memoryAdapters,
          agentTools: this.agentTools,
          agentSpecs: this.agentSpecs,
          mcpConfigs: this.mcpConfigs,
          mcpCustody: this.mcpCustody,
          mcpConnectionStatus: this.mcpConnectionStatus,
          integrationMetadata: this.integrationMetadata,
          toolNameMapping: this.toolNameMapping,
          toolNameReverseMapping: this.toolNameReverseMapping,
          mcpToolProvenanceGeneration: this.mcpToolProvenanceGeneration,
          agentFixedTokens: this.agentFixedTokens,
          agentHooksMap: this.agentHooksMap,
          resolveUnattendedGrant: this.resolveUnattendedGrant,
          integrationSecretResolver: this.secretBindingAdministration,
          resolveAcpPreToolPolicy: (input) =>
            this.resolveExternalPreToolPolicy(input, 'self-reported'),
          eventLog: this.eventLog,
          bedrockAdapter: this.bedrockAdapter,
          claudeAdapter: this.claudeAdapter,
          codexAdapter: this.codexAdapter,
          museAdapter: this.museAdapter,
          ollamaAdapter: this.ollamaAdapter,
          createVoltAgentInstance: async (slug) =>
            this.createVoltAgentInstance(slug),
          configureRoutes: (app: any) => this.configureRoutes(app),
          reloadAgents: async () => this.reloadAgents(),
          captureAgentConfigurationRevisions: () =>
            this.captureAgentConfigurationRevisions(),
          onAgentConfigurationReady: (revisions) =>
            this.recordLoadedConfigurationRevisions(revisions),
          guardDefaultAgentTools: (tools) => this.guardDefaultAgentTools(tools),
          replaceTemplateVariables: (text, agentName) =>
            this.replaceTemplateVariables(text, agentName),
          checkBedrockCredentials: async () => {
            const { checkBedrockCredentials } = await import(
              '../../providers/llm/bedrock.js'
            );
            return checkBedrockCredentials();
          },
          createDefaultSkillRegistryProvider: async () => {
            const { FilesystemSkillRegistryProvider } = await import(
              '../../providers/registries/filesystem-skill-registry.js'
            );
            const { GitHubSkillRegistryProvider } = await import(
              '../../providers/registries/github-skill-registry.js'
            );
            const { MultiSourceSkillRegistryProvider } = await import(
              '../../providers/registries/multi-source-skill-registry.js'
            );
            return new MultiSourceSkillRegistryProvider([
              new FilesystemSkillRegistryProvider(),
              new GitHubSkillRegistryProvider(),
            ]);
          },
          runStartupMigrations: async (projectHomeDir) => {
            const { runStartupMigrations } = await import(
              '../../domain/migration.js'
            );
            await runStartupMigrations(projectHomeDir);
          },
          startHealthChecks: () => this.startHealthChecks(),
          // archive#208: assign appConfig/framework/modelCatalog as soon as they're
          // resolved inside initializeRuntime() — before initializeRuntimeAgents()
          // or new VoltAgent(...)/configureRoutes() run and read `this.X` through
          // closures bound above at construction time. The tail assignments below
          // (lines following `initializeRuntime()`'s return) become a harmless,
          // redundant re-assignment of the same already-set values.
          onCoreConfigReady: (core) => {
            this.appConfig = core.appConfig;
            this.framework = core.framework as
              | VoltAgentFramework
              | StrandsFramework;
            this.modelCatalog = core.modelCatalog;
          },
          onRouteServicesReady: async (services) => {
            this.orchestrationService = services.orchestrationService;
            // Route construction happens inside initializeRuntime before this
            // method returns. Publish the Dispatcher at that composition seam,
            // after its concrete orchestration Adapter exists and before any
            // route or capability can read runtime context.
            this.taskDispatcher = composeTaskDispatcher(
              this.taskGraphService,
              {
                orchestrationService: this.orchestrationService,
                assignmentClaimService: this.taskDispatchAssignmentClaims,
                resolveProjectWorkspace: this.resolveTaskDispatchWorkspace,
              },
              {
                prepareAgentStarted: (result) =>
                  this.projectTaskRoomRuntime?.prepareAgentStarted(result),
                // Route composition assigns this property before any user can
                // dispatch. Read it lazily so construction order cannot invent
                // a room or turn a provider start into a retryable failure.
                publishAgentStarted: (result) =>
                  this.projectTaskRoomRuntime?.publishAgentStarted(result),
              },
            );
            this.connectionService.setSmokeRunner((input) =>
              this.orchestrationService.runConnectionSmoke(input),
            );
            this.usageAggregator = services.usageAggregator;
            // archive#1879: register the `conversation-store` K2 adapter and
            // (flag-gated) ensure `root:conversations` — this is the earliest
            // point `knowledgeStoreProvider`, `orchestrationService`,
            // `memoryAdapters`, and `configLoader` all exist together
            // (module doc's onCoreConfigReady/onRouteServicesReady ordering
            // note; `this.appConfig` is set synchronously by
            // `onCoreConfigReady` above, which always runs first).
            await ensureConversationKnowledgeRoot({
              provider: this.knowledgeStoreProvider,
              persistence: this.storageAdapter,
              sessionReader: {
                listSessionReadModel: (authority) =>
                  this.orchestrationService.listSessionReadModel(authority),
                sessionQueries: this.orchestrationService.sessionQueries,
              },
              fileStores: this.memoryAdapters,
              getUserId: () => getCachedUser().alias,
              projectHomeDir: this.configLoader.getProjectHomeDir(),
              knowledgeStoresEnabled: this.appConfig?.knowledgeStores,
            });
          },
          onVoltAgentCreated: (voltAgent) => {
            this.voltAgent = voltAgent;
          },
        }),
      );
      await this.kitLifecycleReady;
    } catch (error) {
      return await this.cleanupFailedInitialization(error);
    }

    this.appConfig = initialized.appConfig;
    this.framework = initialized.framework;
    this.orchestrationService = initialized.orchestrationService;
    this.resourcePosture = initialized.resourcePosture;
    this.attachedSessionFollowService =
      initialized.attachedSessionFollowService;
    this.consoleBridgeService = initialized.consoleBridgeService;
    this.modelCatalog = initialized.modelCatalog;
    this.usageAggregator = initialized.usageAggregator;
    this.voltAgent = initialized.voltAgent;
    this.voiceWsAttached = initialized.voiceWsAttached;
    this.rebuildGlobalToolRegistry();

    const pluginEventSubscriptions =
      await this.pluginOperationalEventSubscriptions.start();
    if (pluginEventSubscriptions.kind === 'unavailable') {
      this.logger.error(
        'Plugin operational event subscriptions are unavailable; Station continues without plugin event delivery',
      );
    }

    await this.startMcpUiFrameServerIfConfigured();
    await this.startConsentListenerOrReport();
    await this.startTaskRoomAcceptanceControlIfConfigured();
    this.discordGatewayService.start();
    this.usageTelemetry = new UsageTelemetryService({
      homeDir: this.configLoader.getProjectHomeDir(),
      appConfig: this.appConfig,
      version: packageJson.version,
      logger: this.logger,
    });
    // A saved, current receipt remains consent after a restart. This read is
    // fail-closed: loadDisclosureReceipt logs malformed receipts and leaves
    // telemetry inactive, while a missing receipt stays silent and inactive.
    await this.usageTelemetry.loadDisclosureReceipt();
    this.orchestrationService.setUsageTelemetry(this.usageTelemetry);
    // Never delay a usable runtime for optional telemetry.
    void this.usageTelemetry.stationStarted();
    this.observeRuntimeConfigurationSources();
    this.recordRuntimeLifecycle('ready');

    // archive#1575: detected native engines (claude/codex CLIs) become registry
    // engine connections + default Agents without a Providers-UI trip.
    // Fire-and-forget with its own retry window: detection races startup
    // under load, and a lost race must not strand the registry empty. The
    // catalog reads the registry live, so adopted agents appear on the next
    // /api/agents request without a reload.
    void adoptDetectedNativeEngines({
      configLoader: this.configLoader,
      logger: this.logger,
      timers: this.timers,
      signal: this.nativeEngineAdoptionAbort.signal,
    });
  }

  private async cleanupFailedInitialization(error: unknown): Promise<never> {
    const failures = [error];
    const attempt = async (
      cleanup: (() => void | Promise<void>) | undefined,
    ): Promise<boolean> => {
      if (!cleanup) return true;
      try {
        await cleanup();
        return true;
      } catch (cleanupError) {
        failures.push(cleanupError);
        return false;
      }
    };

    await attempt(() => this.sshEnvironmentService.shutdown());
    await attempt(() => this.discordGatewayService.stop());
    await attempt(() => this.taskRoomAcceptanceControl?.close());
    this.taskRoomAcceptanceControl = undefined;
    const scheduler = this.schedulerService;
    if (await attempt(scheduler ? () => scheduler.stop() : undefined)) {
      if (this.schedulerService === scheduler)
        this.schedulerService = undefined;
    }
    const notifications = this.notificationService;
    if (
      await attempt(notifications ? () => notifications.shutdown() : undefined)
    ) {
      if (this.notificationService === notifications)
        this.notificationService = undefined;
    }
    const voltAgent = this.voltAgent;
    await attempt(voltAgent ? () => voltAgent.shutdown() : undefined);
    await attempt(async () => {
      const outcome = await this.pluginOperationalEventSubscriptions.close();
      if (outcome.kind !== 'closed') {
        throw new Error(
          `Plugin operational event subscriptions did not close: ${outcome.kind}`,
        );
      }
    });
    if (await attempt(() => this.terminalWsServer.stop())) {
      this.terminalWsStarted = false;
    }

    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        'Runtime initialization failed and service cleanup also failed',
      );
    }
    throw error;
  }

  /**
   * Dedicated MCP Apps sandbox-proxy origin. It starts on an ephemeral port by
   * default; MCP_UI_FRAME_PORT may pin one for deployments. A bind failure is
   * non-fatal and degrades to the opaque-origin native/static fallback.
   */
  private async startMcpUiFrameServerIfConfigured(): Promise<void> {
    const raw = process.env.MCP_UI_FRAME_PORT;
    const port = raw ? Number.parseInt(raw, 10) : 0;
    if (
      !Number.isInteger(port) ||
      port < 0 ||
      port > 65535 ||
      (raw !== undefined && port === 0)
    ) {
      this.logger.warn('Ignoring invalid MCP_UI_FRAME_PORT', { value: raw });
      return;
    }
    if (port === this.port) {
      this.logger.warn(
        'MCP_UI_FRAME_PORT must differ from the Station port; skipping frame origin',
        { port },
      );
      return;
    }
    this.mcpUiFrameServer = await startMcpUiFrameServer({
      port,
      stationPort: this.port,
      stationHost: this.host,
      logger: this.logger,
    });
  }

  private async startTaskRoomAcceptanceControlIfConfigured(): Promise<void> {
    const socketPath = process.env.STATION_E2E_TASK_ROOM_CONTROL_SOCKET;
    if (!socketPath) return;
    if (!this.taskDispatcher || !this.projectTaskRoomRuntime)
      throw new Error('Task-room acceptance control dependencies unavailable');
    this.taskRoomAcceptanceControl = await startTaskRoomAcceptanceControl({
      socketPath,
      e2eSystemStatusReady: process.env.STATION_E2E_SYSTEM_STATUS_READY,
      publishAgentEdit: async (input) => {
        const dispatched = await this.taskDispatcher!.dispatch(input.taskId, {
          agentId: input.agentId,
          provider: 'task-dispatch',
          sourceSurface: 'e2e-task-room-control',
        });
        if (dispatched.kind !== 'dispatched')
          throw new Error(`Task dispatch was ${dispatched.kind}`);
        const association = dispatched.result;
        const edit =
          await this.projectTaskRoomRuntime!.publishAgentDocumentEdit({
            taskId: input.taskId,
            agentId: input.agentId,
            sessionId: association.session.threadId,
            provider: association.session.provider,
            desiredText: input.desiredText,
          });
        if (
          edit.kind !== 'committed' &&
          edit.kind !== 'duplicate' &&
          edit.kind !== 'unchanged'
        )
          throw new Error(
            `Agent document edit was ${edit.kind}${'reason' in edit && edit.reason ? `: ${edit.reason}` : ''}`,
          );
        return {
          kind: 'published',
          taskId: input.taskId,
          agentId: input.agentId,
          sessionId: edit.sessionId,
          runId: edit.runId,
          revision: edit.revision,
          text: edit.text,
        };
      },
      preparePerformanceCorpus: async (input) => {
        const graph = await this.taskGraphService.readTaskGraph(input.taskId);
        const binding = graph?.task.workspaceBinding;
        const workingDirectory = binding?.workingDirectory
          ? resolve(expandTilde(binding.workingDirectory))
          : undefined;
        if (
          binding?.availability !== 'available' ||
          typeof workingDirectory !== 'string' ||
          workingDirectory.length === 0
        )
          throw new Error('Task workspace is unavailable');
        const content = Array.from({ length: 100_000 }, (_, index) =>
          String(index % 10),
        ).join('\n');
        const path = 'plain-text-100k-lines-v1.txt';
        let rebuilt = input.phase === 'cold';
        try {
          const current = this.fileTreeService.readFileWithin(
            workingDirectory,
            path,
          );
          if (input.phase === 'cold' || current !== content)
            this.fileTreeService.writeTextFileWithin(
              workingDirectory,
              path,
              content,
            );
        } catch {
          rebuilt = true;
          this.fileTreeService.writeTextFileWithin(
            workingDirectory,
            path,
            content,
          );
        }
        return {
          kind: 'prepared',
          path,
          corpusId: 'plain-text-100k-lines-v1',
          sha256: createHash('sha256').update(content).digest('hex'),
          lineCount: 100_000,
          rebuilt,
        };
      },
      seedPerformanceOperations: (input) =>
        this.projectTaskRoomRuntime!.seedPerformanceOperations(input),
    });
  }

  /**
   * archive#3677: bind the distinct-origin consent listener on the instance's
   * fifth first-class port (`STATION_CONSENT_PORT`, default `port + 3` — the
   * same derivation the terminal (+1) and voice (+2) listeners use).
   *
   * Failure policy (owner decision 3): approvals fail CLOSED, Station stays
   * usable. Every path that cannot bind records a truthful unavailable
   * reason on the channel service — which the approval routes surface as a
   * refusal — and never degrades open. This deliberately does NOT copy the
   * MCP frame proxy's silent `resolve(null)` optional-degrade shape.
   */
  private async startConsentListenerOrReport(): Promise<void> {
    if (isHostedTenantExecutionRequired()) {
      // Same posture as the terminal listener above: hosted ingress is
      // authority-significant, and the consent port has no tenant mapping
      // yet — refuse rather than serve consent for the wrong tenant.
      this.consentChannel.markUnavailable(
        'Hosted tenant-isolated runtimes do not bind the consent listener yet; approvals are unavailable.',
      );
      consentListenerState.add(1, { state: 'unavailable' });
      this.logger.warn(
        'Consent listener not started on a hosted tenant runtime; approvals are unavailable',
      );
      return;
    }
    const raw = process.env.STATION_CONSENT_PORT;
    const port = raw !== undefined ? Number.parseInt(raw, 10) : this.port + 3;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      this.consentChannel.markUnavailable(
        `Invalid consent port ${raw ?? port}; approvals are unavailable.`,
      );
      consentListenerState.add(1, { state: 'unavailable' });
      this.logger.error('Invalid consent port; approvals are unavailable', {
        value: raw ?? String(port),
      });
      return;
    }
    const started = await startConsentListener({
      app: createConsentApp({
        channel: this.consentChannel,
        credentials: this.environmentSecurityService,
        logger: this.logger,
      }),
      port,
      host: this.host,
      logger: this.logger,
    });
    if (started.status === 'listening') {
      this.consentListener = started.listener;
      this.consentChannel.markListening(started.listener.port);
      consentListenerState.add(1, { state: 'listening' });
      this.logger.info('Consent listener listening', {
        port: started.listener.port,
      });
      return;
    }
    this.consentChannel.markUnavailable(started.reason);
    consentListenerState.add(1, { state: 'unavailable' });
    this.logger.error(
      'Consent listener unavailable; approvals are unavailable until it binds',
      { reason: started.reason },
    );
  }

  /**
   * Configure all HTTP routes on the Hono app instance.
   * Extracted from the configureApp callback for readability.
   */
  private configureRoutes(
    app: Parameters<NonNullable<HonoServerConfig['configureApp']>>[0],
  ): void {
    const {
      schedulerService,
      notificationService,
      kitLifecycleReady,
      projectTaskRoomRuntime,
    } = configureRuntimeRoutes({
      app,
      logger: this.logger,
      eventBus: this.eventBus,
      environmentSecurityService: this.environmentSecurityService,
      approvalRegistry: this.approvalRegistry,
      consentChannel: this.consentChannel,
      appConfig: this.appConfig,
      // Delta2 review H2: `appConfig` above is captured once, here, while
      // `this.appConfig` is REPLACED by every configuration reload
      // (`reloadDefaultAgent`, `reloadRuntimeAgents`). A route that must
      // agree with the agent the runtime just rebuilt has to read the field,
      // not the value it held at construction.
      getLiveAppConfig: () => this.appConfig,
      port: this.port,
      host: this.host,
      buildProvenanceSnapshot: this.buildProvenanceSnapshot,
      usageAggregator: this.usageAggregator,
      usageTelemetry: this.usageTelemetry,
      getUsageTelemetry: () => this.usageTelemetry,
      skillService: this.skillService,
      configLoader: this.configLoader,
      feedbackService: this.feedbackService,
      fileTreeService: this.fileTreeService,
      storageAdapter: this.storageAdapter,
      providerService: this.providerService,
      proposedChangeService: this.proposedChangeService,
      projectService: this.projectService,
      agentService: this.agentService,
      connectionService: this.connectionService,
      sshEnvironmentService: this.sshEnvironmentService,
      mcpService: this.mcpService,
      secretBindingAdministration: this.secretBindingAdministration,
      secretBindingIntegrationAdministration:
        this.secretBindingIntegrationAdministration,
      taskGraphService: this.taskGraphService,
      taskDispatcher: this.taskDispatcher,
      terminalService: this.terminalService,
      actionOperations: this.actionOperations,
      orchestrationService: this.orchestrationService,
      resourcePosture: this.resourcePosture,
      orchestrationEventStore: this.orchestrationEventStore,
      pluginInstallationHost: this.pluginInstallationHost,
      pluginOperationalEventSubscriptions:
        this.pluginOperationalEventSubscriptions,
      orchestrationStreamPresence: this.orchestrationStreamPresence,
      layoutService: this.layoutService,
      modelCatalog: this.modelCatalog,
      acpBridge: this.acpBridge,
      knowledgeService: this.knowledgeService,
      knowledgeStoreProvider: this.knowledgeStoreProvider,
      resolveEmbeddingProvider: () =>
        resolveRuntimeEmbeddingProvider(this.providerService),
      voiceService: this.voiceService,
      activeAgents: this.activeAgents,
      agentMetadataMap: this.agentMetadataMap,
      memoryAdapters: this.memoryAdapters,
      agentFixedTokens: this.agentFixedTokens,
      agentTools: this.agentTools,
      agentStats: this.agentStats,
      agentStatus: this.agentStatus,
      metricsLog: this.metricsLog,
      monitoringEvents: this.monitoringEvents,
      monitoringEmitter: this.monitoringEmitter,
      eventLogPath: this.eventLogPath,
      queryEventsFromDisk: (start: number, end: number, userId: string) =>
        this.eventLog.queryEvents(start, end, userId),
      checkOllamaAvailability,
      buildRuntimeContext: () => this.buildRuntimeContext(),
      getAgentConfigurationRevision: () =>
        this.getStableAgentConfigurationRevision(),
      getAgentActivationFailure: (slug: string) =>
        this.agentActivationFailures?.get(slug),
      reloadAgents: async () => this.reloadAgents(),
      applyAgentConfigurationMutation: (operation, options) =>
        this.applyAgentConfigurationMutation(operation, options),
      reloadDefaultAgent: async () => this.reloadDefaultAgent(),
      reloadSkillsAndAgents: async () => this.reloadSkillsAndAgents(),
      initialize: async () => this.initialize(),
      getVoltAgent: () => this.voltAgent,
      defaultAutoApprovedTools: SC_READ_ONLY_TOOLS,
      createMemoryAdapter: (_slug: string) =>
        new FileMemoryAdapter({
          projectHomeDir: this.configLoader.getProjectHomeDir(),
          usageAggregator: this.usageAggregator,
        }),
      getMcpUiFrameOrigin: () => this.mcpUiFrameServer?.origin,
      getPluginFrameOrigin: () => this.mcpUiFrameServer?.origin,
      featurePreviews: this.featurePreviews,
      // archive#980 fix (HIGH): read the live env var, never
      // `this.appConfig` — see `station-features.ts`'s docblock for why.
      getManagedChatOrchestrationEnabled: () =>
        isManagedChatOrchestrationFeatureEnabled(),
      rebindBuiltinAgents: () => this.rebindBuiltinAgents(),
    });
    this.schedulerService = schedulerService;
    this.notificationService = notificationService;
    this.kitLifecycleReady = kitLifecycleReady;
    this.projectTaskRoomRuntime = projectTaskRoomRuntime;
  }

  /**
   * Build RuntimeContext for extracted route modules
   */
  private buildRuntimeContext(): RuntimeContext {
    const runtime = this;
    return createRuntimeContext({
      activeAgents: this.activeAgents,
      agentSpecs: this.agentSpecs,
      agentTools: this.agentTools,
      memoryAdapters: this.memoryAdapters,
      mcpConnectionStatus: this.mcpConnectionStatus,
      integrationMetadata: this.integrationMetadata,
      toolNameMapping: this.toolNameMapping,
      toolNameReverseMapping: this.toolNameReverseMapping,
      globalToolRegistry: this.globalToolRegistry,
      agentFixedTokens: this.agentFixedTokens,
      agentStatus: this.agentStatus,
      agentHooksMap: this.agentHooksMap,
      approvalRegistry: this.approvalRegistry,
      configLoader: this.configLoader,
      get appConfig() {
        return runtime.appConfig;
      },
      modelCatalog: this.modelCatalog,
      framework: this.framework,
      acpBridge: this.acpBridge,
      acpProviderSecretResolver: this.secretBindingAdministration,
      providerService: this.providerService,
      knowledgeService: this.knowledgeService,
      feedbackService: this.feedbackService,
      usageAggregator: this.usageAggregator,
      storageAdapter: this.storageAdapter,
      eventBus: this.eventBus,
      orchestrationEventStore: this.orchestrationEventStore,
      logger: this.logger,
      dispatchEvidenceSource: this.dispatchEvidenceSource(),
      fleetRouting: this.fleetRouting(),
      monitoringEvents: this.monitoringEvents,
      monitoringEmitter: this.monitoringEmitter,
      agentStats: this.agentStats,
      metricsLog: this.metricsLog,
      persistEvent: (event: any) => this.eventLog.persist(event),
      createBedrockModel: (spec: AgentSpec) =>
        createRuntimeFrameworkModel(spec, {
          framework: this.framework,
          appConfig: this.appConfig,
          projectHomeDir: this.configLoader.getProjectHomeDir(),
          modelCatalog: this.modelCatalog,
          listProviderConnections: () =>
            this.providerService.listProviderConnections(),
        }),
      replaceTemplateVariables: (text: string) =>
        this.replaceTemplateVariables(text),
      getNormalizedToolName: (name: string) =>
        MCPManager.getNormalizedToolName(name, this.toolNameReverseMapping),
      getOriginalToolName: (name: string) =>
        MCPManager.getOriginalToolName(name, this.toolNameMapping),
      getAgentConfigurationRevision: () =>
        this.getStableAgentConfigurationRevision(),
      isAgentConfigurationActivationPending: (slug: string) =>
        this.agentActivationsInFlight?.has(slug) === true ||
        this.agentsAwaitingReconciliation?.has(slug) === true,
      getAgentActivationFailure: (slug: string) =>
        this.agentActivationFailures?.get(slug),
      commitAgentConfigurationRead: (expectedRevision, operation) =>
        this.commitAgentConfigurationRead(expectedRevision, operation),
      reloadAgents: () => this.reloadAgents(),
      applyAgentConfigurationMutation: (operation, options) =>
        this.applyAgentConfigurationMutation(operation, options),
      initialize: () => this.initialize(),
    });
  }

  /**
   * Start periodic health checks for all agents
   */
  private async startHealthChecks(): Promise<void> {
    await startRuntimeHealthChecks({
      timers: this.timers,
      logger: this.logger,
      runHealthChecks: async () =>
        runRuntimeHealthChecks({
          activeAgents: this.activeAgents,
          agentSpecs: this.agentSpecs,
          memoryAdapters: this.memoryAdapters,
          mcpConnectionStatus: this.mcpConnectionStatus,
          integrationMetadata: this.integrationMetadata,
          monitoringEmitter: this.monitoringEmitter,
        }),
    });
    // archive#3218. The reactive watch (archive#3215) sees corruption a query
    // touches; this sees the pages nothing reads. It runs in a child process
    // because `PRAGMA quick_check` is synchronous and would otherwise stall
    // this loop for its whole duration. The SCHEDULE rides `this.timers`, so
    // the existing `shutdownRuntimeServices` clears it; the disposer is what
    // stops a probe that is already running, and `shutdown()` calls it.
    this.stopStoreIntegrityVerification = startStoreIntegrityVerification({
      timers: this.timers,
      databasePath: this.orchestrationDatabasePath,
      logger: this.logger,
    });
  }

  /**
   * Create a VoltAgent Agent instance from agent spec
   */
  private async createVoltAgentInstance(agentSlug: string): Promise<Agent> {
    return buildRuntimeAgentInstance(
      this.runtimeAgentBuilderContext(agentSlug, this.appConfig),
    );
  }

  private runtimeAgentBuilderContext(
    agentSlug: string,
    appConfig: AppConfig,
    composition?: PluginActivationComposition,
  ) {
    return {
      agentSlug,
      appConfig,
      configLoader: composition
        ? this.configLoader.forPluginActivationComposition(composition)
        : this.configLoader,
      framework: this.framework,
      skillService: this.skillService,
      logger: this.logger,
      serverPort: this.port,
      integrationSecretResolver: this.secretBindingAdministration,
      mcpCustody: this.mcpCustody,
      modelCatalog: this.modelCatalog,
      usageAggregator: this.usageAggregator,
      listProviderConnections: () =>
        this.providerService.listProviderConnections(),
      dispatchEvidenceSource: this.dispatchEvidenceSource(),
      fleetRouting: this.fleetRouting(),
      approvalRegistry: this.approvalRegistry,
      mcpConfigs: this.mcpConfigs,
      retiredMcpConfigs: this.retiredMcpConfigs,
      mcpConnectionStatus: this.mcpConnectionStatus,
      integrationMetadata: this.integrationMetadata,
      toolNameMapping: this.toolNameMapping,
      toolNameReverseMapping: this.toolNameReverseMapping,
      mcpToolProvenanceGeneration: this.mcpToolProvenanceGeneration,
      memoryAdapters: this.memoryAdapters,
      agentFixedTokens: this.agentFixedTokens,
      agentTools: this.agentTools,
      globalToolRegistry: this.globalToolRegistry,
      agentHooksMap: this.agentHooksMap,
      agentSpecs: this.agentSpecs,
      isAgentHooksCurrent: (
        slug: string,
        hooks: ReturnType<typeof createAgentHooks>,
      ) =>
        this.getStableAgentConfigurationRevision() !== null &&
        this.agentHooksMap.get(slug) === hooks,
      resolveUnattendedGrant: this.resolveUnattendedGrant,
      workItemCapture: new WorkItemCapture(
        this.orchestrationEventStore,
        createEventStoreWorkItemPrincipalLiveness(this.orchestrationEventStore),
      ),
      guardTools: (tools: any[]) =>
        this.guardAgentGenerationTools(agentSlug, tools),
      replaceTemplateVariables: (text: string, agentName?: string) =>
        this.replaceTemplateVariables(text, agentName),
    };
  }

  /**
   * Live evidence for Dispatch candidate grading (archive#1426): backs
   * `AgentCreationConfig.dispatchEvidenceSource`/`RuntimeContext.dispatchEvidenceSource`
   * with `this.connectionService` so `createConfiguredDispatchModel` grades
   * every candidate off the connection's actual current
   * `ConnectionEvidenceLevel`, instead of a hardcoded constant.
   *
   * Fix round (SF-5): resolves ALL requested connection ids from ONE
   * `listConnections()` discovery pass (which includes health probes),
   * never one pass per connection id — a naive per-id `getConnection()` call
   * would re-run that full discovery once per Dispatch candidate.
   */
  private dispatchEvidenceSource(): DispatchEvidenceSource {
    return {
      getConnectionReadinessEvidence: async (connectionIds) => {
        const wanted = new Set(connectionIds);
        const evidence = new Map<string, ConnectionReadinessEvidence>();
        if (wanted.size === 0) return evidence;
        const connections = await this.connectionService.listConnections();
        for (const connection of connections) {
          if (wanted.has(connection.id) && connection.readinessEvidence) {
            evidence.set(connection.id, connection.readinessEvidence);
          }
        }
        return evidence;
      },
      // archive#1430: backs `structured-tools` derivation with the
      // deterministic model-inventory accessor rather than the
      // route-populated cache — see `ConnectionService.getModelToolSurface`.
      getModelToolSurface: (bindings) =>
        this.connectionService.getModelToolSurface(bindings),
    };
  }

  /**
   * Fleet routing wiring (archive#1398): peer candidates plus the
   * local, hash-chained routing-receipt log.
   *
   * Constructed lazily per call rather than cached because a peer credential
   * can be provisioned or revoked at any moment, and a cached candidate
   * source would keep routing to a peer whose credential the operator has
   * already removed. The per-call cost is one small JSON read; the
   * peer-manifest fetches behind it are already TTL-batched by
   * `createTtlCachedCandidateResolver`.
   *
   * `environmentId` comes from this Station's own handshake record — the
   * same identity every peer authenticates against — so a receipt can never
   * disagree with the identity the machine presents.
   */
  private fleetRouting(): DispatchFleetRouting | undefined {
    const environmentId = this.stationEnvironmentId;
    if (!environmentId) return undefined;
    const projectHomeDir = this.configLoader.getProjectHomeDir();
    const receiptLog = new FleetRoutingReceiptLog(projectHomeDir);
    return {
      environmentId,
      resolveCandidates: async () =>
        new FleetCandidateService({
          ...(this.fleetProbes() ? { probes: this.fleetProbes()! } : {}),
          peers: {
            listFleetPeers: () => {
              const store = new PeerCredentialStore(projectHomeDir);
              return store
                .list()
                .map((peer) => store.get(peer.environmentId))
                .filter((peer): peer is NonNullable<typeof peer> => !!peer)
                .map((peer) => ({
                  environmentId: peer.environmentId,
                  apiBase: peer.apiBase,
                  scope: peer.scope,
                  label: peer.label,
                  credential: peer.credential,
                }));
            },
          },
        }).resolve(),
      appendReceipt: (envelope) => receiptLog.append(envelope),
      observer: new FleetDispatchActionOperationObserver(this.actionOperations),
    };
  }

  /**
   * The one long-lived probe cache (archive#1398).
   *
   * `fleetRouting()` rebuilds `FleetCandidateService` on every resolution on
   * purpose (a revoked peer credential must take effect immediately), so the
   * probe service CANNOT live there: a per-call cache would be empty on every
   * look, schedule a probe every window, and never read one back — an
   * unbounded stream of completions against peers that never upgraded a
   * single candidate. It is held here, for the life of the runtime, so
   * `observe()` can actually answer.
   *
   * `undefined` — no probing at all — unless the operator enables the
   * runtime-consumed Feature Preview. Its consumer is bound during runtime
   * composition so the UI can expose it before fleet routing first runs.
   */
  private fleetProbes(): FleetProbeService | undefined {
    return this.fleetConsumerProbesPreview.select({
      enabled: () => {
        this.fleetProbeService ??= new FleetProbeService({
          logger: this.logger,
        });
        return this.fleetProbeService;
      },
      disabled: () => undefined,
    });
  }

  /**
   * The composition-time binding for the fleet routing consumer. Keeping the
   * definition beside the selector it supplies means this preview exists only
   * while this runtime consumer is built into Station.
   */
  private bindFleetConsumerProbesPreview(): void {
    this.fleetConsumerProbesPreview = this.featurePreviews.bind({
      id: 'fleet-consumer-probes',
      label: 'Fleet consumer probes',
      description:
        'Probe a peer-contributed model before routing work to it. This can spend a completion on another Station.',
    });
  }

  private replaceTemplateVariables(text: string, _agentName?: string): string {
    return replaceRuntimeTemplateVariables(text, this.appConfig);
  }

  /**
   * Switch to a different agent (for CLI usage)
   */
  async switchAgent(targetSlug: string): Promise<Agent> {
    return this.mutateAgentConfiguration(() =>
      switchRuntimeAgent({
        targetSlug,
        activeAgents: this.activeAgents,
        voltAgent: this.voltAgent,
        logger: this.logger,
        createVoltAgentInstance: async (slug) =>
          this.createVoltAgentInstance(slug),
      }),
    );
  }

  private mutateAgentConfiguration<T>(operation: () => Promise<T>): Promise<T> {
    if (this.agentConfigurationMutationsClosed) {
      return Promise.reject(
        new Error('Runtime configuration mutations are closed.'),
      );
    }
    const run = async () => {
      this.agentConfigurationRevision += 1;
      try {
        return await operation();
      } finally {
        this.agentConfigurationRevision += 1;
      }
    };
    return this.serializeAgentConfigurationAccess(run);
  }

  private serializeAgentConfigurationAccess<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.agentConfigurationMutationsClosed) {
      return Promise.reject(
        new Error('Runtime configuration operations are closed.'),
      );
    }
    const result = this.agentConfigurationMutationQueue.then(
      operation,
      operation,
    );
    this.agentConfigurationMutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Durable agent writes serialize with each other but do not wait behind a
   * slow background runtime rebuild. Runtime reloads fence publication with
   * agentConfigurationPersistenceRevision, so a write that overlaps a reload
   * invalidates that staged generation and queues another reconciliation.
   */
  private serializeAgentConfigurationPersistence<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.agentConfigurationMutationsClosed) {
      return Promise.reject(
        new Error('Runtime configuration operations are closed.'),
      );
    }
    const queue = this.agentConfigurationPersistenceQueue ?? Promise.resolve();
    const result = queue.then(operation, operation);
    this.agentConfigurationPersistenceQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Get an agent by slug
   */
  getAgent(slug: string): Agent | undefined {
    return this.activeAgents.get(slug);
  }

  /**
   * List all loaded agents
   */
  listAgents(): string[] {
    return Array.from(this.activeAgents.keys());
  }

  /**
   * Shutdown the runtime
   */
  async shutdown(): Promise<void> {
    // Settle any pending native-engine adoption window before timers are
    // cleared, so its promise cannot strand on a cleared timeout (archive#1575).
    // Optional-chained: prototype-built test doubles (Object.create) have no
    // constructor-initialized fields, and shutdown must never throw for them.
    this.nativeEngineAdoptionAbort?.abort();
    // Early, before the shutdown-promise guard: a store probe in flight is a child process, and
    // `gracefulShutdown` ends in `process.exit`. Same optional-chaining
    // reason as the line above — prototype-built doubles have no fields.
    this.stopStoreIntegrityVerification?.();
    if (this.shutdownPromise) return this.shutdownPromise;
    // Settle any in-flight initialize() before tearing down — its rejection
    // is expected here (we are shutting down under it) and must not escape
    // as an unhandled rejection attributed to someone else.
    if (this.initializeInFlight) {
      await this.initializeInFlight.catch(() => {});
    }
    this.stopObservingRuntimeConfigurationSources();
    this.agentConfigurationMutationsClosed = true;
    this.shutdownPromise = this.shutdownAfterConfigurationDrain().catch(
      (error) => {
        this.shutdownPromise = null;
        throw error;
      },
    );
    return this.shutdownPromise;
  }

  private async shutdownAfterConfigurationDrain(): Promise<void> {
    this.recordRuntimeLifecycle('stopping');
    await this.drainConfigurationQueues();
    const mcpUiFrameServer = this.mcpUiFrameServer;
    const consentListener = this.consentListener;
    const failures: unknown[] = [];
    try {
      await this.discordGatewayService?.stop();
    } catch (error) {
      failures.push(error);
    }
    try {
      const optionalNetworkShutdownTasks = [
        this.usageTelemetry
          ? {
              name: 'usage telemetry',
              shutdown: (signal: AbortSignal) =>
                this.usageTelemetry?.shutdown(signal),
            }
          : undefined,
        configuredTelemetryShutdownTask(),
      ].filter((task) => task !== undefined);
      await shutdownRuntimeServices({
        logger: this.logger,
        timers: this.timers,
        schedulerService: this.schedulerService,
        orchestrationService: this.orchestrationService,
        attachedSessionFollowService: this.attachedSessionFollowService,
        consoleBridgeService: this.consoleBridgeService,
        voltAgent: this.voltAgent,
        mcpConfigs: this.mcpConfigs,
        retiredMcpConfigs: this.retiredMcpConfigs,
        mcpCustody: this.mcpCustody,
        activeAgents: this.activeAgents,
        acpBridge: this.acpBridge,
        connectionService: this.connectionService,
        modelCatalog: this.modelCatalog,
        feedbackService: this.feedbackService,
        notificationService: this.notificationService,
        voiceService: this.voiceService,
        mcpUiFrameServer: mcpUiFrameServer
          ? {
              close: async () => {
                await mcpUiFrameServer.close();
                this.mcpUiFrameServer = null;
              },
            }
          : undefined,
        consentListener: consentListener
          ? {
              close: async () => {
                await consentListener.close();
                this.consentListener = null;
                this.consentChannel.markUnavailable(
                  'Station is shutting down.',
                );
              },
            }
          : undefined,
        terminalWsServer: this.terminalWsServer,
        terminalService: this.terminalService,
        monitoringEmitter: this.monitoringEmitter,
        sshEnvironmentService: this.sshEnvironmentService,
        configLoader: this.configLoader,
        optionalNetworkShutdownTasks,
      });
    } catch (error) {
      failures.push(error);
    }
    try {
      await Promise.all([
        MCPManager.releaseAllNativeStationControlConnections(this.mcpCustody),
        releaseAllNativeStationControlClients(this.mcpCustody),
      ]);
    } catch (error) {
      failures.push(error);
    }
    try {
      const subscriptions =
        await this.pluginOperationalEventSubscriptions.close();
      if (subscriptions.kind !== 'closed') {
        failures.push(
          new Error(
            `Plugin operational event subscriptions did not close: ${subscriptions.kind}`,
          ),
        );
      }
    } catch (error) {
      failures.push(error);
    }
    try {
      await disposeRetainedPreparedPluginProviders();
    } catch (error) {
      failures.push(error);
    }
    try {
      await disposeAllPluginPublicServerModules();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.taskRoomAcceptanceControl?.close();
      this.taskRoomAcceptanceControl = undefined;
    } catch (error) {
      failures.push(error);
    }
    try {
      const roomClose = await this.projectTaskRoomRuntime?.close();
      if (roomClose && roomClose.kind !== 'closed')
        failures.push(
          new Error(
            `Project/Task room runtime did not close: ${roomClose.kind}`,
          ),
        );
      this.projectTaskRoomRuntime = undefined;
    } catch (error) {
      failures.push(error);
    }
    try {
      // Never wired into shutdownRuntimeServices - leaves the orchestration
      // SQLite connection (and its file handle on projectHomeDir) open past
      // shutdown indefinitely. POSIX tolerates deleting a directory with an
      // open file inside it, which hid this; Windows does not.
      this.orchestrationEventStore.close();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 0) {
      try {
        this.stationHomeRuntimeLease?.release();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        'Runtime shutdown cleanup was incomplete.',
      );
    }
  }

  private recordRuntimeLifecycle(phase: 'ready' | 'stopping'): void {
    if (!this.stationEnvironmentId) return;
    const outcome = this.operationalEventPublisher.append(
      createRuntimeLifecycleOperationalEvent({
        phase,
        environmentId: this.stationEnvironmentId,
        version: packageJson.version,
      }),
    );
    if (outcome.kind === 'appended' || outcome.kind === 'duplicate') return;
    try {
      this.logger.warn(
        'Operational runtime lifecycle event was not persisted',
        {
          phase,
          outcome: outcome.kind,
        },
      );
    } catch {
      // Diagnostics are observer-only and cannot change runtime lifecycle.
    }
  }
}

function worktreeMetadataFromEvents(
  events: unknown[],
  sessionId: string,
): WorktreeSessionMetadata | undefined {
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const sessionStart = event as {
      method?: unknown;
      sessionId?: unknown;
      metadata?: unknown;
    };
    if (
      sessionStart.method !== 'session.started' ||
      sessionStart.sessionId !== sessionId
    ) {
      continue;
    }
    const metadata = sessionStart.metadata;
    if (!metadata || typeof metadata !== 'object') continue;
    const worktree = (metadata as Record<string, unknown>).worktree;
    if (!worktree || typeof worktree !== 'object') continue;
    const candidate = worktree as Partial<WorktreeSessionMetadata>;
    if (
      candidate.mode === 'worktree' &&
      typeof candidate.repoPath === 'string' &&
      typeof candidate.path === 'string' &&
      typeof candidate.branch === 'string' &&
      typeof candidate.baseRef === 'string' &&
      (candidate.cleanupPolicy === 'cleanup' ||
        candidate.cleanupPolicy === 'preserve') &&
      typeof candidate.preserveOnFailure === 'boolean' &&
      typeof candidate.createdAt === 'string'
    ) {
      assertWorktreeMetadataSessionBinding(
        candidate as WorktreeSessionMetadata,
        sessionId,
      );
      return candidate as WorktreeSessionMetadata;
    }
  }
  return undefined;
}
