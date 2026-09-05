import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import {
  closeSync,
  fchmodSync,
  constants as fsConstants,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  type DevicePairingRequest,
  parseTaskTurnReference,
} from '@kontourai/station-contracts';
import { ACPStatus } from '@kontourai/station-contracts/acp';
import {
  agentId,
  parseEngineId,
} from '@kontourai/station-contracts/agent-identity';
import { PUBLIC_ANSWER_SHARE_VIEW_PATH } from '@kontourai/station-contracts/answer-share';
import type { AppConfig } from '@kontourai/station-contracts/config';
import {
  DEVICE_PAIRING_BROWSER_COOKIE_DELIVERY,
  type PairingScope,
  PUBLIC_DEVICE_PAIRING_ACCESS_REQUEST_PATH,
  PUBLIC_DEVICE_PAIRING_API_DOCS_LAUNCH_PATH,
  PUBLIC_DEVICE_PAIRING_EXCHANGE_PATH,
  PUBLIC_DEVICE_PAIRING_LOCAL_GRANT_PATH,
  PUBLIC_DEVICE_PAIRING_LOCAL_GRANT_STARTUP_PROOF_PATH,
  PUBLIC_DEVICE_PAIRING_REQUEST_PATH,
  PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_MINT_PATH,
  PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_PATH,
  PUBLIC_STATION_HANDSHAKE_PATH,
  PUBLIC_STATION_PROOF_PATH,
  pairingScopeIncludes,
  STATION_PROOF_PROTOCOL_VERSION,
} from '@kontourai/station-contracts/environment-security';
import type { IEmbeddingProvider } from '@kontourai/station-contracts/knowledge-index';
import type { LaunchableModelInventory } from '@kontourai/station-contracts/model-inventory';
import type { AdoptedSessionResult } from '@kontourai/station-contracts/orchestration';
import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import { parseStationTaskBasisCollection } from '@kontourai/station-contracts/task-basis';
import {
  INTERNAL_SESSION_READ_SCOPE,
  isSessionReadAuthority,
  sessionReadAuthorityFromRequest,
} from '@kontourai/station-contracts/tenancy';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import {
  isStationNativeShellOrigin,
  STATION_NATIVE_SHELL_ORIGINS,
} from '@kontourai/station-shared/native-shell-origin';
import type { Agent } from '@voltagent/core';
import type { HonoServerConfig } from '@voltagent/server-hono';
import { setCookie } from 'hono/cookie';
import type { FileMemoryAdapter } from '../../adapters/file/memory-adapter.js';
import {
  loadOrCreateAgentRegistry,
  replacePluginEngineConnections,
} from '../../domain/agent-registry.js';
import type { ConfigLoader } from '../../domain/config-loader.js';
import type { FileStorageAdapter } from '../../domain/file-storage-adapter.js';
import { KnowledgeIndexAdapterRegistry } from '../../knowledge-index/index-adapter-registry.js';
import { isLocalKnowledgeSourceRequestCurrent } from '../../knowledge-store/knowledge-source-observation-policy.js';
import type { KnowledgeStoreProvider } from '../../knowledge-store/knowledge-store-provider.js';
import type { MonitoringEmitter } from '../../monitoring/emitter.js';
import { monitoringSessionIdentity } from '../../monitoring/monitoring-session-identity.js';
import { createOtlpReceiverRoutes } from '../../monitoring/otlp-receiver.js';
import type { BedrockModelCatalog } from '../../providers/llm/bedrock-models.js';
import {
  listProviders,
  registerPullRequestProvider,
} from '../../providers/registries/registry.js';
import { createAgentToolRoutes } from '../../routes/agents/agent-tools.js';
import {
  createAgentRoutes,
  deriveAgentCatalog,
} from '../../routes/agents/agents.js';
import {
  agentCatalogReadSeam,
  createEnrichedAgentRoutes,
  isHonestlyAvailableConnectedAgent,
  runtimeConnectionSummary,
} from '../../routes/agents/enriched-agents.js';
import { createInvokeRoutes } from '../../routes/agents/invoke.js';
import { resolveRuntimeAgent } from '../../routes/agents/runtime-agent-resolver.js';
import { createSkillRoutes } from '../../routes/agents/skills.js';
import { createTemplateRoutes } from '../../routes/agents/templates.js';
import { createToolRoutes } from '../../routes/agents/tools.js';
import { createUnattendedGrantRoutes } from '../../routes/agents/unattended-grants-routes.js';
import { createBoardRoutes } from '../../routes/board.js';
import { createChatRoutes } from '../../routes/chat/chat.js';
import {
  createConversationRoutes,
  createGlobalConversationRoutes,
} from '../../routes/chat/conversations.js';
import { createACPRoutes } from '../../routes/connections/acp.js';
import { createAppHomeRoutes } from '../../routes/connections/app-home.js';
import { createBedrockRoutes } from '../../routes/connections/bedrock.js';
import { createConnectionRoutes } from '../../routes/connections/connections.js';
import { createModelsRoutes } from '../../routes/connections/models.js';
import { createProviderRoutes } from '../../routes/connections/providers.js';
import { createConsentNativeRoutes } from '../../routes/consent/consent-native-routes.js';
import { createPeerCredentialRoutes } from '../../routes/environments/peer-credential-routes.js';
import {
  createDiffCommentRoutes,
  createDiffCommentsAggregateRoutes,
} from '../../routes/evidence/diff-comments.js';
import { createFlowRunRoutes } from '../../routes/evidence/flow-runs.js';
import { createProposedChangeRoutes } from '../../routes/evidence/proposed-changes.js';
import {
  createReviewEvidenceAggregateRoutes,
  createReviewEvidenceRoutes,
} from '../../routes/evidence/reviews.js';
import { createTrustBundleRoutes } from '../../routes/evidence/trust-bundles.js';
import { createVeritasReadinessRoutes } from '../../routes/evidence/veritas-readiness.js';
import { createWorkflowSidecarRoutes } from '../../routes/evidence/workflow-sidecars.js';
import { createFleetInferenceRoutes } from '../../routes/inference/fleet-inference.js';
import {
  createCrossProjectKnowledgeRoutes,
  createKnowledgeRoutes,
} from '../../routes/knowledge/knowledge.js';
import { createKnowledgeIndexRoutes } from '../../routes/knowledge/knowledge-index-routes.js';
import { createKnowledgeRecordRoutes } from '../../routes/knowledge/knowledge-record-routes.js';
import { createKnowledgeSourceRoutes } from '../../routes/knowledge/knowledge-source-routes.js';
import { createKnowledgeStoreRoutes } from '../../routes/knowledge/knowledge-store-routes.js';
import { createNeo4jGraphRoutes } from '../../routes/knowledge/neo4j-graph-routes.js';
import {
  createStationControlMcpRoutes,
  STATION_CONTROL_MCP_PATH,
} from '../../routes/mcp/station-control-mcp-route.js';
import { createActionOperationRoutes } from '../../routes/operations/action-operations.js';
import { createAnalyticsRoutes } from '../../routes/operations/analytics.js';
import { createFeedbackRoutes } from '../../routes/operations/feedback.js';
import { createInsightsRoutes } from '../../routes/operations/insights.js';
import { createMonitoringRoutes } from '../../routes/operations/monitoring.js';
import { createNotificationRoutes } from '../../routes/operations/notifications.js';
import { createPushRoutes } from '../../routes/operations/push-routes.js';
import { createSchedulerRoutes } from '../../routes/operations/scheduler.js';
import { createSshEnvironmentRoutes } from '../../routes/operations/ssh-environments.js';
import { createTelemetryRoutes } from '../../routes/operations/telemetry-events.js';
import { createUsageTelemetryDisclosureRoutes } from '../../routes/operations/usage-telemetry-disclosure.js';
import { createVoiceRoutes } from '../../routes/operations/voice.js';
import { createAttachmentStagingRoutes } from '../../routes/orchestration/attachment-staging.js';
import { createAttachmentRoutes } from '../../routes/orchestration/attachments.js';
import { createAttentionRoutes } from '../../routes/orchestration/attention.js';
import { createEventRoutes } from '../../routes/orchestration/events.js';
import { createLiveActivityRoutes } from '../../routes/orchestration/live-activity.js';
import { createOperatingStateRoutes } from '../../routes/orchestration/operating-state.js';
import { createOrchestrationRoutes } from '../../routes/orchestration/orchestration.js';
import { createProjectTaskRoomRoutes } from '../../routes/orchestration/project-task-rooms.js';
import { createRunRoutes } from '../../routes/orchestration/runs.js';
import { createTaskOutputRoutes } from '../../routes/orchestration/task-outputs.js';
import {
  createTaskRoutes,
  keptRowsForTaskSession,
} from '../../routes/orchestration/tasks.js';
import { createWorkItemRoutes } from '../../routes/orchestration/work-items.js';
import { createPluginRoutes } from '../../routes/plugins/plugins.js';
import { createRegistryRoutes } from '../../routes/plugins/registry.js';
import { createCodingRoutes } from '../../routes/projects/coding.js';
import { createFsRoutes } from '../../routes/projects/fs.js';
import { createWorkflowRoutes } from '../../routes/projects/layouts.js';
import {
  createProjectRoutes,
  type ProjectResolutionRouteDeps,
} from '../../routes/projects/projects.js';
import { createUICommandRoutes } from '../../routes/projects/ui-commands.js';
import { createPullRequestRoutes } from '../../routes/pull-requests/pull-request-routes.js';
import { createSearchRoutes } from '../../routes/search.js';
import { createSecretBindingRoutes } from '../../routes/secret-bindings.js';
import { createSetupImportRoutes } from '../../routes/setup-imports.js';
import {
  createAnswerShareRoutes,
  createAnswerShareViewBudget,
  handleAnswerShareView,
} from '../../routes/share/answer-share-routes.js';
import { createSpatialBoardRoutes } from '../../routes/spatial-board.js';
import { createStarterWorkRoutes } from '../../routes/starter-work.js';
import {
  createAuthRoutes,
  createUserRoutes,
  getCachedUser,
} from '../../routes/system/auth.js';
import { createBootRoutes } from '../../routes/system/boot.js';
import { createBrandingRoutes } from '../../routes/system/branding.js';
import type { BuildProvenanceSnapshot } from '../../routes/system/build-provenance.js';
import { createConfigRoutes } from '../../routes/system/config.js';
import { createDiagnosticsRoutes } from '../../routes/system/diagnostics.js';
import { createFeaturePreviewRoutes } from '../../routes/system/feature-previews.js';
import { createSystemRoutes } from '../../routes/system/system.js';
import { createInboundWebhookRoutes } from '../../routes/webhooks/inbound-webhooks.js';
import { BoundedAttemptBudget } from '../../security/bounded-attempt-budget.js';
import { isDefinitelyOffBox } from '../../security/off-box-peer.js';
import {
  PairingFailureLimiter,
  type PairingFailureState,
} from '../../security/pairing-failure-limiter.js';
import {
  grantedPairingScope,
  type PairingScopeContextStore,
  requiredPairingScope,
} from '../../security/pairing-route-scopes.js';
import {
  attestedBrowserVisibleHost,
  attestedProxyPeerAddress,
  classifyDirectDeviceActivityPeer,
  classifyRuntimePeer,
  getRuntimeAuthenticatedRequestPrincipal,
  isLoopbackAuthority,
  isRuntimeRequestPrincipalCurrent,
  RUNTIME_CREDENTIAL_AUTHORITY_VAR,
  type RuntimeAuthenticatedRequestPrincipal,
  type RuntimeCallerRequest,
  type RuntimeDeviceActivityClassifierContext,
  type RuntimeSecurityAuditRecord,
} from '../../security/runtime-request-security.js';
import type { ACPManager } from '../../services/acp/acp-bridge.js';
import type { AgentService } from '../../services/agents/agent-service.js';
import type { SkillService } from '../../services/agents/skill-service.js';
import { UnattendedGrantStore } from '../../services/agents/unattended-grant-store.js';
import { ApprovalRegistry } from '../../services/approvals/approval-registry.js';
import { BoardStore } from '../../services/board/board-store.js';
import { CheckpointIndexStore } from '../../services/checkpoints/checkpoint-index-store.js';
import { listThreadRecordsWithObjectStatus } from '../../services/checkpoints/checkpoint-read.js';
import { CheckpointRefStore } from '../../services/checkpoints/checkpoint-ref-store.js';
import { CheckpointRestoreService } from '../../services/checkpoints/checkpoint-restore.js';
import {
  CHECKPOINT_MUTATION_LOCK,
  CheckpointRetentionService,
} from '../../services/checkpoints/checkpoint-retention.js';
import {
  createThreadWorkingDirectoryResolver,
  TurnCheckpointCaptureCoordinator,
  wireTurnCheckpointCaptureWhenEnabled,
} from '../../services/checkpoints/turn-checkpoint-capture.js';
import type { ConnectionService } from '../../services/connections/connection-service.js';
import type { ProviderService } from '../../services/connections/provider-service.js';
import type { ConsentChannelService } from '../../services/consent/consent-channel.js';
import {
  ANSWER_ASSESSMENT_UPDATED_EVENT,
  AnswerAssessmentModule,
} from '../../services/evidence/answer-assessment-module.js';
import {
  ANSWER_NARRATIVE_UPDATED_EVENT,
  AnswerNarrativeBindingModule,
} from '../../services/evidence/answer-narrative-binding-module.js';
import { AssignmentClaimService } from '../../services/evidence/assignment-claim-service.js';
import { createExactAnswerBasisModule } from '../../services/evidence/exact-answer-basis-module.js';
import { FlowAgentsRetainedNarrativeOwner } from '../../services/evidence/flow-agents-retained-narrative-owner.js';
import { FlowReviewEvidenceAttachment } from '../../services/evidence/flow-review-evidence-attachment.js';
import { GitReviewWorkspaceSource } from '../../services/evidence/git-review-workspace-source.js';
import {
  STATION_ARTIFACT_ROOTS,
  STATION_LEGACY_ROOTS,
} from '../../services/evidence/local-artifact-paths.js';
import { OrchestrationReviewExecutor } from '../../services/evidence/orchestration-review-executor.js';
import { RepoMapReviewSelection } from '../../services/evidence/repo-map-review-selection.js';
import { ReviewEvidenceModule } from '../../services/evidence/review-evidence-module.js';
import { FileReviewReceiptStore } from '../../services/evidence/review-receipt-store.js';
import { ReviewedSourceBasisResolver } from '../../services/evidence/reviewed-source-basis-resolver.js';
import {
  CanonicalProjectTrustReportReader,
  PERSONAL_PROJECT_TRUST_CAPABILITY,
  TaskAnswerSupportModule,
  TaskAnswerSupportStore,
} from '../../services/evidence/task-answer-support-module.js';
import { TrustBundleService } from '../../services/evidence/trust-bundle-service.js';
import { VeritasReadinessService } from '../../services/evidence/veritas-readiness-service.js';
import { WorkflowSidecarService } from '../../services/evidence/workflow-sidecar-service.js';
import type { FeaturePreviewRegistry } from '../../services/feature-previews/feature-preview-registry.js';
import type { FeedbackService } from '../../services/feedback/feedback-service.js';
import { FlowMcpUiEvidenceBridge } from '../../services/flow/flow-mcp-ui-evidence-bridge.js';
import { FlowReadinessBridge } from '../../services/flow/flow-readiness-bridge.js';
import { FlowRunService } from '../../services/flow/flow-run-service.js';
import {
  FileStationSurveyReviewSessionStore,
  SurveyFlowReviewService,
} from '../../services/flow/survey-flow-review-service.js';
import {
  type IdentitySource,
  TailscaleServeIdentitySource,
  type VerifiedIdentity,
} from '../../services/identity/identity-source.js';
import { resolvePrincipal as resolveStationPrincipal } from '../../services/identity/principal-resolver.js';
import { FleetInferenceService } from '../../services/inference/fleet-inference-service.js';
import { FleetServeReceiptLog } from '../../services/inference/fleet-serve-receipt-log.js';
import { DiagnosticsService } from '../../services/infra/diagnostics-service.js';
import { OperatingStateService } from '../../services/infra/operating-state-service.js';
import { createServerLogReader } from '../../services/infra/server-log-reader.js';
import { StationKitObservabilityHost } from '../../services/kits/kit-observability-host.js';
import { StationKitObservabilityRegistry } from '../../services/kits/kit-observability-registry.js';
import type { KnowledgeService } from '../../services/knowledge/knowledge-service.js';
import type { NotificationService } from '../../services/notifications/notification-service.js';
import type { WebPushService } from '../../services/notifications/web-push-service.js';
import { actionOperationActorForRequest } from '../../services/operations/action-operation-authority.js';
import type { ActionOperationService } from '../../services/operations/action-operation-service.js';
import { AttachmentStagingService } from '../../services/orchestration/attachment-staging-service.js';
import { FileConversationAcknowledgementStore } from '../../services/orchestration/conversation-acknowledgement-store.js';
import type { EventBus } from '../../services/orchestration/event-bus.js';
import type { EventStore } from '../../services/orchestration/event-store.js';
import type { OrchestrationService } from '../../services/orchestration/orchestration-service.js';
import type { OrchestrationStreamPresence } from '../../services/orchestration/orchestration-stream-presence.js';
import { ProjectTaskRoomRevisionEvidenceBridge } from '../../services/orchestration/project-task-room-revision-evidence-bridge.js';
import { ProjectTaskRoomRuntime } from '../../services/orchestration/project-task-room-runtime.js';
import { RunService } from '../../services/orchestration/run-service.js';
import { createSessionInventoryAppReadModule } from '../../services/orchestration/session-inventory-app-read-module.js';
import { createSessionInventoryModule } from '../../services/orchestration/session-inventory-module.js';
import { projectSessionLifecycle } from '../../services/orchestration/session-lifecycle-service.js';
import { createSessionWorkItemModule } from '../../services/orchestration/session-work-item-module.js';
import { PeerCredentialStore } from '../../services/peers/peer-credential-store.js';
import { DistributionProfileService } from '../../services/plugins/distribution-profile-service.js';
import { IntegrationIconAssets } from '../../services/plugins/integration-icon-assets.js';
import type { MCPService } from '../../services/plugins/mcp-service.js';
import {
  isMcpUiRenderRevoked,
  setMcpUiRenderAllowed,
} from '../../services/plugins/mcp-ui-permissions.js';
import type { AttentionProjectionService } from '../../services/projects/attention-projection.js';
import { readCheckoutRemotes } from '../../services/projects/checkout-remote-reader.js';
import { DiffCommentService } from '../../services/projects/diff-comment-service.js';
import type { FileTreeService } from '../../services/projects/file-tree-service.js';
import type { LayoutService } from '../../services/projects/layout-service.js';
import { ProjectBindingsStore } from '../../services/projects/project-binding-store.js';
import { ProjectManifestStore } from '../../services/projects/project-manifest-store.js';
import { ProjectResourceResolver } from '../../services/projects/project-resource-resolver.js';
import type { ProjectService } from '../../services/projects/project-service.js';
import type { ProposedChangeService } from '../../services/projects/proposed-change-service.js';
import { createTaskBasisAppReadModule } from '../../services/projects/task-basis-app-read-module.js';
import { createTaskBasisRuntimeComposition } from '../../services/projects/task-basis-runtime-composition.js';
import type { TaskDispatcher } from '../../services/projects/task-dispatcher.js';
import type { TaskGraphService } from '../../services/projects/task-graph-service.js';
import { createTaskGateEvaluationReferenceReadAdapter } from '../../services/projects/task-tool-result-reference-read-adapter.js';
import { WorkItemProviderService } from '../../services/projects/work-item-provider-service.js';
import { GitHubPullRequestProvider } from '../../services/pull-requests/github-pull-request-provider.js';
import { GitLabPullRequestProvider } from '../../services/pull-requests/gitlab-pull-request-provider.js';
import { PullRequestRepositoryContextResolver } from '../../services/pull-requests/pull-request-repository-context-resolver.js';
import type { SchedulerService } from '../../services/scheduling/scheduler-service.js';
import type {
  SecretBindingAdministration,
  SecretBindingIntegrationAdministration,
} from '../../services/secrets/secret-binding-administration.js';
import { createConversationIntentSummaryEvidenceCatalog } from '../../services/session-summary/conversation-intent-summary-source.js';
import { ExistingAgentSetupImportModule } from '../../services/setup/existing-agent-setup-import.js';
import {
  AnswerShareService,
  NO_CHANNEL_LOG_OBSERVER,
} from '../../services/share/answer-share-service.js';
import { AnswerShareStore } from '../../services/share/answer-share-store.js';
import { createSpatialBoardOwnerResolver } from '../../services/spatial-board/spatial-board-owner-resolver.js';
import { SpatialBoardStore } from '../../services/spatial-board/spatial-board-store.js';
import {
  CLIENT_SESSION_ID_PATTERN,
  ClientConnectionPresence,
} from '../../services/ssh/client-connection-presence.js';
import {
  DevicePairingError,
  type DevicePairingService,
  type PairingApproval,
  type PairingRequesterPosition,
} from '../../services/ssh/device-pairing-service.js';
import type { EnvironmentSecurityService } from '../../services/ssh/environment-security-service.js';
import { searchConnectedRemoteMessages } from '../../services/ssh/remote-session-reader.js';
import type { SshEnvironmentService } from '../../services/ssh/ssh-environment-service.js';
import {
  createStarterOwnerAdapter,
  type StarterOwnerAdapter,
} from '../../services/starter-work/starter-owner-adapter.js';
import {
  StarterRegistry,
  type StarterScheduledCheckOwner,
} from '../../services/starter-work/starter-registry.js';
import { StarterWorkModule } from '../../services/starter-work/starter-work-module.js';
import { publicIngressOriginResolver } from '../../services/tailscale/public-ingress-origin.js';
import type { TerminalService } from '../../services/terminal/terminal-service.js';
import type { UsageTelemetryService } from '../../services/usage-telemetry-service.js';
import { FlowAgentsWorkItemProvider } from '../../services/work-item-providers/flow-agents-work-item-provider.js';
import { LocalWorkItemProvider } from '../../services/work-item-providers/local-work-item-provider.js';
import {
  checkpointCaptureOps,
  clientCompatHandshakes,
  connectedClientPresenceOps,
  devicePairingRequests,
  deviceSessionExchanges,
  reviewEvidenceDuration,
  reviewEvidenceOperations,
} from '../../telemetry/metrics.js';
import {
  buildStationBasisProjectionToolResult,
  buildStationBasisUnavailableToolResult,
  parseStationBasisToolInput,
  STATION_BASIS_MCP_SERVER_ID,
  STATION_BASIS_MCP_TOOL_NAME,
} from '../../tools/station-control-basis-tools.js';
import {
  continueDelegatedTask,
  continueExecutionTargetMessage,
  delegateTask,
  discoverDelegationOptions,
  executeExecutionTargetMessage,
  handoffExecutionTargetMessage,
  interruptDelegatedTask,
  listDelegatedTasks,
  observeDelegatedTask,
  observeDelegatedTaskEvents,
  refreshPeerDelegationActivity,
  respondToDelegatedTaskRequest,
} from '../../tools/station-control-delegation.js';
import { INTERNAL_CONTROL_CALLER_BINDING_HEADER } from '../../tools/station-control-shared.js';
import {
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_PROXY_CALLER_HEADER,
} from '../../utils/internal-api-token.js';
import type { Logger } from '../../utils/logger.js';
import {
  outwardTransportFailure,
  sanitizedTransportError,
} from '../../utils/outward-error.js';
import { expandTilde } from '../../utils/paths.js';
import {
  configureRuntimeHttp,
  LOOPBACK_DEVICE_SESSION_COOKIE,
  parseDeviceSessionCookie,
  SECURE_DEVICE_SESSION_COOKIE,
} from '../bootstrap/runtime-http.js';
import {
  createHostedTenantMiddleware,
  createPersonalRuntimeRequestGuard,
  currentTenantExecutionContext,
  getTenantRequestContext,
  isHostedTenantExecutionRequired,
  loadHostedTenantRegistryFromEnvironment,
  tenantExecutionContextForRequest,
} from '../bootstrap/runtime-tenant-context.js';
import {
  createStationEngineAvailabilityReader,
  resolveBedrockConnectionAuth,
} from '../plugins/runtime-provider-resolution.js';
import type {
  AgentConfigurationMutationRunner,
  RuntimeContext,
} from '../types.js';
import {
  API_DOCS_LAUNCH_HEADERS,
  renderApiDocsLaunchPage,
} from './api-docs-launch.js';
import { createOrchestrationBoardAuthorization } from './board-route-authorization.js';
import {
  configureRuntimeSupportServices,
  createRuntimeSystemRouteDeps,
} from './runtime-route-support.js';
import { createTaskBasisMcpInitialRead } from './task-basis-mcp-initial-read.js';

type HonoApp = Parameters<NonNullable<HonoServerConfig['configureApp']>>[0];

/** A session worktree is valid only within the project that owns the thread. */
export function pullRequestThreadForProject<
  T extends { threadId: string; projectSlug?: string },
>(sessions: T[], threadId: string, projectSlug: string): T | undefined {
  return sessions.find(
    (candidate) =>
      candidate.threadId === threadId && candidate.projectSlug === projectSlug,
  );
}

export interface ConfigureRuntimeRoutesContext {
  runtimeSearch?: import('../../services/search/runtime-search.js').RuntimeSearch;
  app: HonoApp;
  logger: Logger;
  eventBus: EventBus;
  environmentSecurityService: EnvironmentSecurityService;
  approvalRegistry: ApprovalRegistry;
  /**
   * station#3677: the distinct-origin consent surface — the transaction
   * store shared with the consent listener, plus its truthful availability
   * state. Approval routes consult it before minting a review URL.
   */
  consentChannel: ConsentChannelService;
  /**
   * The app config as it stood when routes were constructed.
   *
   * Delta2 review H2: this field is a SNAPSHOT. `station-runtime.ts` replaces
   * `this.appConfig` on every configuration reload, and nothing writes back
   * here, so a route that reads it is answering with the configuration the
   * process booted with. Read `getLiveAppConfig()` for anything a user can
   * change while Station runs (the default model connection, above all);
   * `appConfig` remains only for facts fixed at construction.
   */
  appConfig: AppConfig;
  /** The current app config — see `appConfig` for why the difference matters. */
  getLiveAppConfig: () => AppConfig;
  port: number;
  host?: string;
  buildProvenanceSnapshot?: BuildProvenanceSnapshot;
  usageAggregator?: any;
  usageTelemetry?: UsageTelemetryService;
  /** Late-bound: the service is constructed after routes are registered. */
  getUsageTelemetry?: () => UsageTelemetryService | undefined;
  skillService: SkillService;
  configLoader: ConfigLoader;
  feedbackService: FeedbackService;
  fileTreeService: FileTreeService;
  storageAdapter: FileStorageAdapter;
  providerService: ProviderService;
  proposedChangeService: ProposedChangeService;
  projectService: ProjectService;
  agentService: AgentService;
  connectionService: ConnectionService;
  sshEnvironmentService: SshEnvironmentService;
  mcpService: MCPService;
  secretBindingAdministration: SecretBindingAdministration;
  secretBindingIntegrationAdministration: SecretBindingIntegrationAdministration;
  taskGraphService: TaskGraphService;
  taskDispatcher: TaskDispatcher;
  orchestrationService: OrchestrationService;
  /** Diagnostics sampler and orchestration's independent engine-start lease. */
  resourcePosture?: import('../../services/infra/resource-posture.js').RuntimeResourcePostureProbe;
  /** Runtime-owned durable operation authority shared with fleet dispatch. */
  actionOperations: ActionOperationService;
  orchestrationEventStore?: EventStore;
  pluginOperationalEventSubscriptions: Pick<
    import('../plugins/plugin-operational-event-subscriptions.js').PluginOperationalEventSubscriptionService,
    'quiesce' | 'reconcile'
  >;
  // station#1225: shared per-user live-`/events`-subscriber presence — read
  // by `createOrchestrationRoutes` (connect/disconnect bookkeeping) and by
  // `configureRuntimeSupportServices`'s push-on-completion wiring
  // (`wireTurnCompletionNotifications`), so both sides observe the SAME
  // connection state instead of two independently-tracked counts.
  orchestrationStreamPresence: OrchestrationStreamPresence;
  layoutService: LayoutService;
  modelCatalog?: BedrockModelCatalog;
  acpBridge: ACPManager;
  knowledgeService: KnowledgeService;
  // K3 index-management routes (`knowledge-index-routes.ts`) — the K2 store
  // provider is a long-lived instance constructed once at startup (safe to pass
  // directly), while the embedder is resolved fresh per-request via a getter
  // since the active embedding connection can change after startup.
  knowledgeStoreProvider: KnowledgeStoreProvider;
  resolveEmbeddingProvider: () => IEmbeddingProvider | null;
  voiceService: any;
  terminalService: TerminalService;
  activeAgents: Map<string, Agent>;
  agentMetadataMap: Map<string, any>;
  memoryAdapters: Map<string, any>;
  agentFixedTokens: Map<
    string,
    { systemPromptTokens: number; mcpServerTokens: number }
  >;
  agentTools: Map<string, any[]>;
  agentStats: Map<
    string,
    { conversationCount: number; messageCount: number; lastUpdated: number }
  >;
  agentStatus: Map<string, string>;
  metricsLog: any[];
  monitoringEvents: any;
  monitoringEmitter: MonitoringEmitter;
  eventLogPath: string;
  queryEventsFromDisk: (
    start: number,
    end: number,
    userId: string,
  ) => Promise<any[]>;
  checkOllamaAvailability: () => Promise<boolean>;
  buildRuntimeContext: () => RuntimeContext;
  getAgentConfigurationRevision: () => number | null;
  /** Why a repeatedly-failed agent activation was abandoned, per slug. */
  getAgentActivationFailure?: (
    slug: string,
  ) => { reason: string; at: string } | undefined;
  reloadAgents: () => Promise<void>;
  applyAgentConfigurationMutation: AgentConfigurationMutationRunner;
  reloadDefaultAgent: () => Promise<void>;
  reloadSkillsAndAgents: () => Promise<void>;
  initialize: () => Promise<void>;
  getVoltAgent: () => any;
  defaultAutoApprovedTools: string[];
  createMemoryAdapter: (slug: string) => FileMemoryAdapter;
  // Origin of the dedicated MCP-UI frame server, if the runtime started one.
  getMcpUiFrameOrigin?: () => string | undefined;
  // Origin of the isolated plugin-frame document, if the shared listener runs.
  getPluginFrameOrigin?: () => string | undefined;
  featurePreviews: FeaturePreviewRegistry;
  // station#980: whether STATION_FEATURES=managed-chat-orchestration is on —
  // threaded through to `GET /config/app` (see `createConfigRoutes`).
  getManagedChatOrchestrationEnabled?: () => boolean;
  // station#1194 (epic #1191, slice B): re-applies the built-in default
  // agent's engine binding immediately after `PUT /config/app` touches
  // `builtinAgentEngineConnectionId` — Voice is deliberately NOT rebound
  // (speech-to-speech, not a chat engine). Threaded to `createConfigRoutes`.
  rebindBuiltinAgents?: () => Promise<void>;
}

interface ConfigureRuntimeRoutesResult {
  schedulerService: SchedulerService;
  notificationService: NotificationService;
  attentionProjection: AttentionProjectionService;
  webPushService: WebPushService;
  kitLifecycleReady: Promise<void>;
  projectTaskRoomRuntime?: ProjectTaskRoomRuntime;
}

/**
 * station#1502 slice 4 — the stores behind `GET /:slug/resolution` and
 * `POST /:slug/bind`, all built over ONE pinned source.
 *
 * `source` is this runtime's own `storageAdapter`, and the manifest store,
 * binding store, and remote reader are constructed once and shared with the
 * resolver rather than letting it default its own. That is the recorded
 * slice-3b review finding (FIX 6, closed the same way in
 * `station-runtime.ts:580-586`): an unpinned `ProjectResourceResolver`
 * constructs a `FileStorageAdapter` of its own and can answer from a different
 * project store than the runtime was built over, so the settings surface would
 * report resolution states for a project the runtime does not have.
 */
function buildProjectResolutionRouteDeps(
  context: ConfigureRuntimeRoutesContext,
): ProjectResolutionRouteDeps {
  const homeDir = context.configLoader.getProjectHomeDir();
  const bindings = new ProjectBindingsStore(homeDir);
  const manifests = new ProjectManifestStore(homeDir, context.storageAdapter, {
    bindings,
    readRemotes: readCheckoutRemotes,
  });
  return {
    resolver: new ProjectResourceResolver({
      homeDir,
      source: context.storageAdapter,
      manifests,
      bindings,
      readRemotes: readCheckoutRemotes,
    }),
    manifests,
    bindings,
    readRemotes: readCheckoutRemotes,
  };
}

type ContextWindowInventorySource = {
  getCachedLaunchableModelInventory(): LaunchableModelInventory | null;
  listLaunchableModelInventory(): Promise<LaunchableModelInventory>;
};

/**
 * Resolves a real model context window without making the hot stats path pay
 * for an inventory refresh. Cold start and cache invalidation do one
 * compute-on-demand lookup; the ConnectionService owns in-flight coalescing.
 */
export async function resolveContextWindowTokensForStats(
  source: ContextWindowInventorySource,
  modelId: string,
): Promise<number | undefined> {
  let inventory = source.getCachedLaunchableModelInventory();
  if (!inventory) {
    try {
      inventory = await source.listLaunchableModelInventory();
    } catch {
      return undefined;
    }
  }
  const record = inventory.models.find(
    (model) =>
      model.providerModel === modelId || model.aliases.includes(modelId),
  );
  return record?.effectiveContextTokens ?? undefined;
}

/** Internal personal-mode composition seam for exact Task answer support. */
export function createPersonalTaskAnswerSupportModule(
  context: Pick<
    ConfigureRuntimeRoutesContext,
    | 'taskGraphService'
    | 'projectService'
    | 'orchestrationService'
    | 'configLoader'
    | 'appConfig'
  >,
): TaskAnswerSupportModule {
  return new TaskAnswerSupportModule({
    anchors: {
      authorize: async (taskId, referenceId, authority) => {
        const task =
          context.taskGraphService.readTaskTurnReferenceScope(taskId);
        if (!task) return 'not-found';
        const link = context.taskGraphService
          .readTaskTurnReferenceLinks(taskId)
          ?.find((candidate) => candidate.id === referenceId);
        const reference = link && parseTaskTurnReference(link.targetId);
        if (!reference) return 'not-found';
        const readAnswerBasis =
          context.orchestrationService.sessionQueries.readAnswerBasis;
        if (!readAnswerBasis) return 'unavailable';
        const answer = await readAnswerBasis(
          {
            type: 'answer-basis',
            threadId: reference.sessionId,
            turnId: reference.turnId,
          },
          authority,
        );
        if (answer.status === 'unavailable') return 'unavailable';
        if (
          answer.status !== 'found' ||
          (answer.projectSlug !== undefined &&
            answer.projectSlug !== task.projectId)
        )
          return 'not-found';
        return {
          taskId,
          referenceId,
          projectSlug: task.projectId,
          sessionId: answer.sessionId,
          turnId: answer.turnId,
          binding: answer.binding,
        };
      },
    },
    reports: new CanonicalProjectTrustReportReader((slug) => {
      const project = context.projectService.getProject(slug);
      if (!project) return undefined;
      const workspacePath = project.workingDirectory
        ? expandTilde(project.workingDirectory)
        : undefined;
      return {
        workspacePath,
        pluginDataDir: join(
          context.configLoader.getProjectHomeDir(),
          'projects',
          slug,
          'plugin-data',
        ),
        veritasEvidenceDir:
          workspacePath &&
          context.appConfig.surfaceTrustFromVeritasEvidence !== false
            ? [
                join(workspacePath, STATION_ARTIFACT_ROOTS.veritas, 'evidence'),
                join(workspacePath, STATION_LEGACY_ROOTS.veritas, 'evidence'),
              ]
            : undefined,
      };
    }, PERSONAL_PROJECT_TRUST_CAPABILITY),
    store: new TaskAnswerSupportStore(context.configLoader.getProjectHomeDir()),
  });
}

/**
 * Rechecks a credential-bound Request after an awaited owner read or queued
 * Task mutation. Ingress already performed this decision, but paired-device
 * scope can be narrowed without rotating the credential, so validity alone
 * is not sufficient at a later publication boundary.
 */
export {
  type CurrentRuntimeRequestPrincipalSecurity,
  isRuntimeRequestPrincipalCurrent,
} from '../../security/runtime-request-security.js';

export function configureRuntimeRoutes(
  context: ConfigureRuntimeRoutesContext,
): ConfigureRuntimeRoutesResult {
  const connectedClientPresence = new ClientConnectionPresence({
    record: (op) => connectedClientPresenceOps.add(1, { op }),
  });
  let projectTaskRoomRuntime: ProjectTaskRoomRuntime | undefined;
  let projectTaskRoomLifecycleReady: Promise<void> = Promise.resolve();
  const allowedOrigins = resolveConfiguredRuntimeOrigins(context);
  const runtimeSecurity = {
    verifyCredential: (
      credential: string,
      request?: { method: string; path: string },
    ) =>
      request
        ? context.environmentSecurityService.authorizeCredential(
            credential,
            request,
          )
        : context.environmentSecurityService.verifyCredential(credential),
    resolveGrantedScope: (credential: string) =>
      context.environmentSecurityService.resolveGrantedScope(credential),
    resolveCredentialAuthority: (credential: string) =>
      context.environmentSecurityService.verifyOperatorCredential(credential)
        ? 'operator-credential'
        : context.environmentSecurityService.devicePairing.identifyDevice(
              credential,
            )
          ? 'device-credential'
          : undefined,
    resolveCredentialDeviceId: (credential: string) =>
      context.environmentSecurityService.identifyDevice(credential)?.id,
    resolvePairingSource: (credential: string) =>
      context.environmentSecurityService.identifyDevice(credential)?.source,
    resolveCredentialLocality: (credential: string) =>
      context.environmentSecurityService.credentialLocality(credential),
    resolveCredentialMintKind: (credential: string) =>
      context.environmentSecurityService.credentialMintKind(credential),
    classifyPairedDeviceActivity: classifyRuntimePairedDeviceActivity,
    allowedOrigins,
    audit: (record: RuntimeSecurityAuditRecord) =>
      record.reason === 'route_scope_unmapped'
        ? context.logger.error('Route missing pairing-scope table entry', {
            ...record,
          })
        : context.logger.warn('Remote authentication denied', { ...record }),
  };
  // This must run before every public, bespoke, and credential-protected
  // mount below. Personal mode has no configured registry and is unchanged.
  const hostedTenantRegistry = loadHostedTenantRegistryFromEnvironment();
  // #749: chat inventory/open routes receive a principal-derived authority
  // through this request-local binding.  Keeping it separate from legacy
  // read-only route fallbacks prevents a cached OS display alias from being
  // reused as identity while this migration completes.
  const conversationRequestAuthorities = new WeakMap<
    Request,
    ReturnType<typeof sessionReadAuthorityFromRequest>
  >();
  // Keep only immutable deployment configuration in this closure.  Every
  // call constructs authority from the ingress context belonging to the
  // current Request; neither a tenant nor an authority crosses requests.
  const readAuthorityForRequest = (request: Request) =>
    sessionReadAuthorityFromRequest(
      getCachedUser().alias,
      getTenantRequestContext(request),
      hostedTenantRegistry,
    );
  // One secret-bearing store feeds bounded read-only peer usage as well as
  // SSH/delegation below. Callers receive only per-request source adapters;
  // the bearer value never enters a route response or UI projection.
  const peerCredentialStore = new PeerCredentialStore(
    context.configLoader.getProjectHomeDir(),
  );
  const actionOperations = context.actionOperations;
  // Command callbacks do not receive the Hono Request, but execute inside
  // the same verified ingress async context. Build their authority at call
  // time; missing hosted ingress remains unusable and therefore fails closed.
  //
  // station#4075 stage 2: `resolvedUserId` lets a caller that already
  // resolved this SAME request's principal (the 10 `createOrchestrationRoutes`
  // execution-target deps closures below do, via
  // `orchestration.ts`'s `resolveActorPrincipal`) hand that value straight
  // through, instead of this function re-deriving a SECOND, divergent one
  // from `getCachedUser().alias`. That divergence was a real, found bug: the
  // caller's `metadata.userId` (stamped from the resolved principal at
  // `startSession`) and this function's own `readAuthority.userId` (session
  // read/command authorization) would otherwise disagree for every non-OS-
  // alias principal — a caller locked out of the very session they just
  // created.
  //
  // station#4075 stage 2 review round 1 (F4): the 5 remaining no-arg
  // callers of this function are deliberately unconverted, in two classes
  // — read-only surfaces that never stamp `metadata.userId` (MCP-UI
  // evidence attach's `readSessionFlowRun` at :1242, the personal-mode
  // spatial-board/starter-work resolvers at :2657/:2694, and the
  // background approval-registry resolution above) keep today's OS-alias
  // behavior with no divergence risk; the one write path left
  // unconverted, `/api/webhooks`' `startTurn` (:1620, a webhook-triggered
  // turn dispatch with no HTTP caller to resolve a principal from), is
  // filed as station#4184.
  const readAuthorityForExecution = (resolvedUserId?: string) => {
    const execution = currentTenantExecutionContext();
    return sessionReadAuthorityFromRequest(
      resolvedUserId ?? getCachedUser().alias,
      execution ? { tenantId: execution.tenantId } : undefined,
      hostedTenantRegistry,
    );
  };
  // station#4518: a device session paired through the pairing flow (bearer
  // or HttpOnly cookie, verified by `runtime-http.ts`'s auth middleware
  // BEFORE this resolver ever runs) has no `VerifiedIdentity` — the only
  // registered `INGRESS_IDENTITY_SOURCE` is Tailscale Serve's WhoIs header,
  // which a phone reaching this host through its own paired-device credential
  // never carries. Pre-station#4075-stage-2, that gap was invisible: every
  // orchestration route fell through to `getCachedUser().alias` (the SERVER
  // OPERATOR's own OS account) regardless of who actually authenticated —
  // a device session could chat, but every turn was misattributed to the
  // operator. Stage 2 closed that misattribution by making an unresolvable
  // caller THROW instead of defaulting, which is correct, but nothing filled
  // the now-fail-closed gap for the device-credential case, so a real
  // approved device session lost chat entirely (station#4518).
  //
  // This translates the ALREADY-VERIFIED `RuntimeAuthenticatedRequestPrincipal`
  // (`runtimePrincipal.authority === 'device-credential'`, set by
  // `runtime-http.ts` only after `verifyCredential` accepted the bearer/
  // cookie) into a `VerifiedIdentity` — never a second, independent read of
  // the raw header/cookie. `identifyDevice` is called with
  // `runtimePrincipal.credential`, the SAME verified credential text
  // `runtime-http.ts` already passed to `resolveCredentialDeviceId` to mint
  // `deviceId` in the first place (`runtimeSecurity` above); this is the
  // identical store lookup, read a second time for its `.name`, not a new
  // derivation of "is this a paired device". The resulting
  // `human:device:<deviceId>` principal is per-device and stable — never the
  // shared `human:local:operator` literal, which stays gated on the
  // `home-possession` locality fact alone (a device credential deliberately
  // never carries that fact; see `CredentialLocality`'s docs — a phone is not
  // the operator's own machine, and this path does not grant that authority).
  const deviceSessionIdentity = (
    runtimePrincipal: RuntimeAuthenticatedRequestPrincipal | undefined,
  ): VerifiedIdentity | null => {
    if (runtimePrincipal?.authority !== 'device-credential') return null;
    const device = context.environmentSecurityService.identifyDevice(
      runtimePrincipal.credential,
    );
    if (!device) return null;
    // LOW-1 (station#4518 fix round): a blank/whitespace-only stored device
    // name is registry corruption, not a reason to throw an untranslated
    // TypeError out of a principal-resolution seam — fall back to the
    // (always-present) device id rather than let `''.trim()` mint an empty
    // `displayName` or a missing `.name` field (a test double's shape) throw
    // on `.trim()`.
    return {
      provider: 'device',
      subject: device.id,
      displayName: device.name?.trim() || device.id,
    };
  };
  // station#4075 stage 2: the fail-closed principal resolver, wired at the
  // single production `createOrchestrationRoutes` call site below (the
  // stage-2 probe's finding 2 — this deps literal never wired anything into
  // the old `getUserId` seam, so every orchestration route fell through to
  // the OS-account alias for every caller and device). `identifyIngress`
  // and `getRuntimeAuthenticatedRequestPrincipal` are the SAME two ingress
  // reads every other identity-adjacent decision in this file already uses
  // (`classifyRuntimePairedDeviceActivity`, `resolveClientOriginForRequest`)
  // — this resolver adds no third derivation of "who is calling", it
  // composes the existing two into stage 1's `resolvePrincipal` contract.
  // station#4518: a THIRD ingress fact — `deviceSessionIdentity` above — is
  // consulted only when Tailscale Serve WhoIs found nothing AND this request
  // carries no `home-possession` authority fact. `resolvePrincipal`'s own
  // precedence is "identity always wins when present" (module docs), so
  // feeding it a device identity unconditionally would have OUTRANKED
  // home-possession — wrong: home-possession means "this credential was
  // minted by proving possession of THIS machine" (local-grant/UI-bootstrap
  // only), which is a STRONGER, narrower fact than "this is some approved
  // device" and correctly collapses to the shared local-operator principal
  // (a Tauri desktop app talking to its own bundled Station, say — that is
  // the operator, not a distinct device identity). Gating the fallback here,
  // at the call site, keeps `resolvePrincipal`'s own precedence contract
  // (identity vs. `operatorAuthority` vs. `hostedTenant`) untouched — this
  // file decides what counts as "identity" for its own callers, exactly as
  // it already does by choosing what to pass as `operatorAuthority`/
  // `hostedTenant`.
  //
  // station#4518 fix round (HIGH-1): a device session and a Tailscale Serve
  // WhoIs identity are NOT mutually exclusive — station's own UI proxy
  // (`packages/cli/src/commands/lifecycle.ts`'s `proxyToBackend`) forwards
  // the caller's cookies/headers (including a device-session cookie)
  // VERBATIM while ALSO stamping `INTERNAL_INGRESS_IDENTITY_HEADER` when
  // Tailscale Serve identified the caller, then re-dials this backend from
  // its own loopback socket. A phone that is BOTH paired (has a device
  // session cookie) AND reached through a `tailscale serve`-fronted proxy
  // with WhoIs enabled therefore presents both facts on the SAME request.
  // `identifyIngress(c) ?? …` means WhoIs wins by construction — a
  // DECISION (owner, station#4518 fix round), not an accident: WhoIs is the
  // finer-grained, individually-attributable fact
  // (`human:tailscale-serve:<login>`) versus the coarser per-device fact
  // (`human:device:<deviceId>`), matching this module's documented
  // "identity is always the finer-grained fact when it exists" precedence.
  // The consequence, stated plainly rather than hidden: the SAME physical
  // phone resolves to a DIFFERENT principal — and therefore a different
  // session/attribution namespace — depending on which of Station's two
  // shipping topologies it reaches this host through (WhoIs-enabled Serve
  // vs. a bare device pairing with no Serve identity in front of it).
  // Unifying those two facts into one stable per-person identity is an
  // open, disclosed design question (decision-needed follow-up), not
  // something this fix resolves.
  const resolveOrchestrationRequestPrincipal = memoizePerRequest(
    (c: {
      env: unknown;
      req: { raw: Request; header(name: string): string | undefined };
    }) => {
      const runtimePrincipal = getRuntimeAuthenticatedRequestPrincipal(
        c.req.raw,
      );
      // station#4529 (found building #4537's paired-device journey coverage
      // on the standard E2E fixture, which authenticates as a verified
      // operator credential with no home-possession stamp — the exact
      // "realistic unresolvable shape" the room-principal tests pinned,
      // which this fix makes resolvable): a VERIFIED operator credential
      // (`authority === 'operator-credential'`, set by `runtime-http.ts`
      // only after its auth middleware accepted the bearer — never a second,
      // independent credential check here) is now ALSO sufficient for
      // `operatorAuthority`, not just mint-time home-possession. See
      // `OperatorAuthorityFact`'s doc (`principal-resolver.ts`) for the
      // rationale: the principal gate closed here was a speed bump, not a
      // boundary, for a remote holder of the operator secret — see that
      // doc for what it actually blocked and what this fix newly grants
      // directly.
      const operatorAuthority =
        runtimePrincipal?.locality === 'home-possession'
          ? { locality: runtimePrincipal.locality }
          : runtimePrincipal?.authority === 'operator-credential'
            ? ({ verifiedOperatorCredential: true } as const)
            : undefined;
      // Precedence (unchanged shape, now three tiers): WhoIs identity, when
      // present, always wins (`identifyIngress(c) ?? …`, station#4518 fix
      // round HIGH-1's reasoning below). Otherwise `operatorAuthority` — now
      // either verified fact — outranks `deviceSessionIdentity`: an
      // operator-credential caller collapses to the shared local-operator
      // principal exactly like a home-possessed one already did, and a
      // device-credential caller only reaches `deviceSessionIdentity` when
      // NEITHER stronger fact is present. `operatorAuthority ? null : …`
      // still does this — a verified operator credential and a
      // device-credential authority are mutually exclusive per credential
      // (`resolveCredentialAuthority` returns exactly one), so this is
      // choosing between disjoint cases, not silently dropping one.
      return resolveStationPrincipal(
        identifyIngress(c) ??
          (operatorAuthority ? null : deviceSessionIdentity(runtimePrincipal)),
        hostedTenantRegistry !== undefined ? 'hosted' : 'personal',
        operatorAuthority,
        // station#4075 stage 2 review round 3: the THIRD hosted outcome —
        // read via `tenantExecutionContextForRequest`, which reads the
        // WeakMap `createHostedTenantMiddleware` itself populated after
        // verifying the host binding + per-boot internal-token attestation
        // (runtime-tenant-context.ts:101-155) — NEVER re-derived from
        // `INTERNAL_TENANT_HEADER` (or any other raw header) independently
        // at this seam. A raw-header read here would let any caller who can
        // merely SPELL the tenant header mint a tenant attribution the
        // middleware never verified.
        tenantExecutionContextForRequest(c.req.raw),
        // Cosmetic display only (never `id` — see principal-resolver.ts):
        // reuses the same OS-alias source the removed fallback used to mint
        // an id from, now confined to a label.
        { resolveOperatorDisplay: () => getCachedUser().alias },
      );
    },
  );
  const conversationReadAuthorityForContext = (
    c: Parameters<typeof resolveOrchestrationRequestPrincipal>[0],
  ) => {
    const runtimePrincipal = getRuntimeAuthenticatedRequestPrincipal(c.req.raw);
    return sessionReadAuthorityFromRequest(
      resolveOrchestrationRequestPrincipal(c).id,
      getTenantRequestContext(c.req.raw),
      hostedTenantRegistry,
      runtimePrincipal?.locality === 'home-possession'
        ? { localHomePossession: true }
        : undefined,
    );
  };
  const conversationReadAuthorityForRequest = (request: Request) => {
    const authority = conversationRequestAuthorities.get(request);
    if (!authority) {
      // This is a wiring failure, never permission to fall back to a cached
      // OS alias. Public conversation reads must have crossed the middleware
      // that resolves the same principal as orchestration.
      throw new Error('Conversation request authority was not resolved');
    }
    return authority;
  };
  const bindConversationReadAuthority = async (
    c: Parameters<typeof resolveOrchestrationRequestPrincipal>[0],
    next: () => Promise<void>,
  ) => {
    conversationRequestAuthorities.set(
      c.req.raw,
      conversationReadAuthorityForContext(c),
    );
    await next();
  };
  // station#4075 stage 3 slice 1: `ProjectTaskRoomRequestAuthority.resolve`
  // (below, at the Task-room `requestAuthority` deps literal) receives only a
  // bare `Request` — never the Hono `Context` — because every one of its
  // ~15 call sites inside `ProjectTaskRoomRuntime` forwards just `c.req.raw`.
  // `resolveOrchestrationRequestPrincipal` above needs `c.env` (loopback
  // proof for the UI-proxy ingress-identity read) and `c.req.header`, which a
  // bare `Request` cannot supply. Rather than widening that interface across
  // every call site, this WeakMap mirrors the established
  // `setRuntimeAuthenticatedRequestPrincipal`/`getRuntimeAuthenticatedRequestPrincipal`
  // pattern (`security/runtime-request-security.ts`): resolve once, with the
  // real `c`, in the `/api/tasks/*` middleware below (which DOES have `c`),
  // and cache the result on the Request for the room runtime's later
  // Request-only reads. A resolution failure (thrown `PrincipalUnresolvedError`)
  // is never cached — a missing entry and a failed resolution are
  // indistinguishable to the reader below, and both fail closed to
  // `{ kind: 'revoked' }`, never a default identity.
  const roomRequestPrincipals = new WeakMap<Request, PrincipalRef>();
  // The registry is process-wide, but each decision remains bound to either a
  // tenant-validated session or the authority minted in its current ingress
  // context. Install this before any route or agent registration can create a
  // hosted approval; an unbound approval must never become observable.
  context.approvalRegistry.setHostedAuthorization({
    isHosted: () => hostedTenantRegistry !== undefined,
    resolveSessionTenant: (sessionId) => {
      const authority = readAuthorityForExecution();
      if (
        authority.mode !== 'hosted' ||
        !authority.tenantExecutionContext ||
        !context.orchestrationService.canUserReadSession(sessionId, authority)
      ) {
        return undefined;
      }
      return authority.tenantExecutionContext;
    },
    canReadSession: (sessionId, authority) =>
      context.orchestrationService.canUserReadSession(sessionId, authority),
  });
  if (hostedTenantRegistry) {
    context.app.use(
      '*',
      createHostedTenantMiddleware(hostedTenantRegistry, {
        // The MCP endpoint has a separate loopback + token-bound tenant
        // authenticator below. A stage grant was bound to a verified
        // owner+tenant at prepare time, so only its exact one-shot PUT is the
        // other credential-independent leaf. No other hosted route bypasses
        // ingress.
        bypass: (request) =>
          new URL(request.url).pathname === STATION_CONTROL_MCP_PATH ||
          isAttachmentStageGrantUploadRequest(request),
      }),
    );
  }
  // Install the full classification, credential, and mutation-budget chain
  // before every public or bespoke handler below. Its central capability
  // declaration lets public and MCP-token routes reach only their own
  // handlers; pairing-scoped routes authenticate before dispatch.
  configureRuntimeHttp({
    app: context.app,
    logger: context.logger,
    eventBus: context.eventBus,
    security: runtimeSecurity,
  });
  // Shared resolver keeps project and Registry catalog projections identical.
  const layoutCatalog = new DistributionProfileService(
    context.configLoader.getProjectHomeDir(),
    context.appConfig.distributionProfile,
  );
  const kitObservabilityRegistry = new StationKitObservabilityRegistry(
    new StationKitObservabilityHost({
      supported_contract_versions: ['1.0'],
      capabilities: [
        'standard_views',
        'mcp_apps_resource_bridge',
        'resource.open',
        'proposal.review',
      ],
    }),
    {
      statePath: join(
        context.configLoader.getProjectHomeDir(),
        'config',
        'kit-observability-lifecycle.json',
      ),
    },
  );
  // These public routes register before the security CORS middleware (so they
  // stay unauthenticated), which means that middleware only handles their
  // OPTIONS preflight — the actual GET/POST responses would ship without an
  // Access-Control-Allow-Origin header, so a cross-origin webview (the native
  // mobile shell, origin http://tauri.localhost) can complete the preflight
  // but is then blocked from reading the response. That silently breaks both
  // the pairing handshake and the ongoing reachability probe. Echo the trusted
  // origin onto every public /.well-known/station/v1 response so these
  // cross-origin discovery/pairing calls actually resolve.
  const publicOrigins = new Set(allowedOrigins);
  context.app.use('/.well-known/station/v1/*', async (c, next) => {
    await next();
    applyPublicCorsHeaders(c, publicOrigins);
  });
  context.app.use('/.well-known/station/v1', async (c, next) => {
    await next();
    applyPublicCorsHeaders(c, publicOrigins);
  });
  // These are the only unauthenticated HTTP routes. Register them before the
  // fail-closed middleware so a future business mount cannot accidentally
  // inherit public access from a broad path prefix.
  configureRuntimePublicRoutes(context.app, context.environmentSecurityService);
  // Shared between the public local-grant route below and the authenticated
  // `/api/pairing/**` host routes so a same-user self-authorization and an
  // operator-approved pairing land in the same log, at the same volume
  // (station#1715).
  const pairingApprovalAudit = (record: PairingApprovalAuditRecord) =>
    context.logger.warn(
      record.event === 'station.pairing.approved'
        ? 'Device pairing approved'
        : 'Device pairing approval refused',
      { ...record },
    );
  const pairingAuthFailureAudit = (record: PairingAuthFailureAuditRecord) =>
    context.logger.warn('Pairing authentication attempt rejected', {
      ...record,
    });
  configureDevicePairingPublicRoutes(
    context.app,
    context.environmentSecurityService.devicePairing,
    {
      allowedOrigins,
      localGrant: {
        secretPath: join(
          context.configLoader.getProjectHomeDir(),
          'runtime',
          'local-grant.secret',
        ),
      },
      uiBootstrapToken: process.env.STATION_UI_BOOTSTRAP_TOKEN,
      audit: pairingApprovalAudit,
      authFailureAudit: pairingAuthFailureAudit,
      authFailureSourceId: (source) =>
        context.environmentSecurityService.pseudonymizePairingAuditSource(
          source,
        ),
      // Capture this child process's launch identity once. The local startup
      // proof must answer for the exact sidecar that owns the grant secret,
      // never for mutable request input or a later environment replacement.
      startupIdentity: () => ({
        instanceId: process.env.STATION_INSTANCE_ID ?? '',
        bootId: process.env.STATION_BOOT_ID ?? '',
      }),
      resolvePublicIngressOrigin: publicIngressOriginResolver(context.port)
        .resolve,
    },
  );
  // station#1423. ONE service instance for both families: the operator mints
  // and revokes through the authenticated `/api/shares` mount below, and the
  // share holder reads through the public route registered here. Two
  // instances would mean two stores and a revocation that never reached the
  // reader.
  const answerShareService = new AnswerShareService({
    store: new AnswerShareStore({
      homeDir: context.configLoader.getProjectHomeDir(),
    }),
    sessions: context.orchestrationService,
    // station#1598. The claim this line makes is "this Station has no channel
    // log, so no answer it mints has a channel coordinate" — stated here,
    // where it can be read and challenged, rather than reached by a default
    // inside the service that could not tell that fact from an unwired
    // observer. The day a channel log exists, this symbol goes away and the
    // compiler names this call site.
    channelObserver: NO_CHANNEL_LOG_OBSERVER,
  });
  // station#1423 M-1: deliberately NOT `consumePairingAttempt(pairingPeer(c))`.
  // Every browser reaches this route through the UI proxy, so the socket peer
  // is `127.0.0.1` for all of them and a peer-keyed bucket is one global
  // bucket that any single client could spend to 429 the whole public share
  // surface. See `createAnswerShareViewBudget` for the two-budget shape that
  // replaces it. One instance per process, so the windows actually accumulate.
  const answerShareViewBudget = createAnswerShareViewBudget();
  context.app.post(PUBLIC_ANSWER_SHARE_VIEW_PATH, async (c) => {
    const outcome = await handleAnswerShareView({
      request: c.req.raw,
      service: answerShareService,
      budget: answerShareViewBudget,
      authority: readAuthorityForRequest(c.req.raw),
      readBoundedBody: readBoundedRequestBody,
    });
    return outcome.kind === 'rate-limited'
      ? c.json({ error: 'rate_limited' }, 429)
      : c.json(outcome.result, outcome.status);
  });
  // station#1195: the built-in station-control MCP server's HTTP/SSE
  // endpoint — a THIRD auth category, neither "public" (unauthenticated)
  // nor "normal session-authed". It has its own bespoke auth (a per-session
  // minted token in the URL query string, see station-control-mcp-token.ts)
  // and its `mcp-token` capability-table entry leaves that query token for
  // this handler rather than treating it as a pairing credential.
  const answerAssessmentModule = new AnswerAssessmentModule(
    context.configLoader.getProjectHomeDir(),
    {
      read: (sessionId, turnId, authority) =>
        context.orchestrationService.sessionQueries.readAnswerBasis?.(
          { type: 'answer-basis', threadId: sessionId, turnId },
          authority,
        ) ?? Promise.resolve({ status: 'unavailable' as const }),
    },
    ({ sessionId, turnId, revision, active }) =>
      context.eventBus.emit(ANSWER_ASSESSMENT_UPDATED_EVENT, {
        sessionId,
        turnId,
        revision,
        active,
      }),
  );
  const answerNarrativeBindingModule = new AnswerNarrativeBindingModule(
    context.configLoader.getProjectHomeDir(),
    {
      read: (sessionId, turnId, authority) =>
        context.orchestrationService.sessionQueries.readAnswerBasis?.(
          { type: 'answer-basis', threadId: sessionId, turnId },
          authority,
        ) ?? Promise.resolve({ status: 'unavailable' as const }),
    },
    new FlowAgentsRetainedNarrativeOwner(resolveWorkspacePath),
    ({ sessionId, turnId, revision, active }) =>
      context.eventBus.emit(ANSWER_NARRATIVE_UPDATED_EVENT, {
        sessionId,
        turnId,
        revision,
        active,
      }),
  );
  const reviewedSourceBasisResolver = new ReviewedSourceBasisResolver({
    projectHomeDir: context.configLoader.getProjectHomeDir(),
    logger: context.logger,
  });
  const exactAnswerBasis = createExactAnswerBasisModule({
    hosted: isHostedTenantExecutionRequired,
    canReadSession: (sessionId, authority) =>
      context.orchestrationService.canUserReadSession(sessionId, authority),
    readAnswer: async (sessionId, turnId, authority) =>
      context.orchestrationService.sessionQueries.readAnswerBasis?.(
        { type: 'answer-basis', threadId: sessionId, turnId },
        authority,
      ),
    readAssessment: ({ authorizedAnswer, authority, current }) =>
      answerAssessmentModule.readExactAnswerAssessmentWithReviewedSource({
        authorizedAnswer,
        authority,
        current,
      }),
    readNarrative: ({ authorizedAnswer, authority, current }) =>
      answerNarrativeBindingModule.readExactAnswerNarrative({
        authorizedAnswer,
        authority,
        current,
      }),
    readReviewedSource: ({ answer, assessment, authority, current }) =>
      reviewedSourceBasisResolver.read({
        answer,
        assessment,
        authority,
        current,
      }),
  });
  const sessionWorkItems = context.orchestrationEventStore
    ? createSessionWorkItemModule({
        eventStore: context.orchestrationEventStore,
        canReadSession: (sessionId, authority) =>
          context.orchestrationService.canUserReadSession(sessionId, authority),
      })
    : undefined;
  // The inventory is runtime-composed with the same exact-answer module used
  // by direct Basis reads; OrchestrationService remains free of Surface owners.
  const sessionInventory = createSessionInventoryModule({
    sessionOutputs: context.orchestrationService.sessionOutputs,
    readWholeSessionEvents: (
      threadId,
      frozenHighWater,
      continuation,
      group,
      limit,
    ) =>
      context.orchestrationEventStore?.listSessionInventoryEvents(threadId, {
        frozenHighWater,
        continuation,
        group,
        limit,
      }) ?? { events: [], highWater: 0 },
    readWholeSessionHighWater: (threadId) =>
      context.orchestrationEventStore?.readSessionInventoryHighWater(
        threadId,
      ) ?? 0,
    canReadSession: (threadId, authority) =>
      context.orchestrationService.canUserReadSession(threadId, authority),
    readExactAnswerBasis: exactAnswerBasis.read,
    readAnswerBasis: (threadId, turnId, authority) =>
      context.orchestrationService.sessionQueries.readAnswerBasis?.(
        { type: 'answer-basis', threadId, turnId },
        authority,
      ) ?? Promise.resolve({ status: 'unavailable' as const }),
    issueCursor: (cursor) =>
      context.orchestrationEventStore?.issueSessionInventoryCursor(cursor) ??
      '',
    readCursor: (cursor) =>
      context.orchestrationEventStore?.readSessionInventoryCursor(cursor),
    sessionWorkItems,
    conversationForSession: (sessionId) =>
      context.orchestrationEventStore?.conversationForSession(sessionId),
  });
  context.app.route(
    '',
    createStationControlMcpRoutes({
      port: context.port,
      hostedTenantRegistry,
    }),
  );
  context.app.route(
    '/api/feature-previews',
    createFeaturePreviewRoutes(context.featurePreviews, context.logger),
  );

  configureDevicePairingHostRoutes(
    context.app,
    context.environmentSecurityService.devicePairing,
    {
      // An approval by a caller that presented no credential is the disclosed
      // residue being exercised — warn volume, same as a denied remote
      // authentication, so it is readable in the same place.
      audit: pairingApprovalAudit,
      connectedClientPresence,
      clientPresenceAvailable: hostedTenantRegistry === undefined,
    },
  );

  // Live config, not the boot snapshot: the catalogue must be fetched from the
  // region the inference path would use right now (station#1557).
  context.app.route(
    '/api/models',
    createModelsRoutes({
      getAppConfig: () => context.configLoader.loadAppConfig(),
      // station#3399: the catalogue is a single global answer, so it consults
      // the FIRST enabled Bedrock connection's configured auth rather than the
      // default chain. That is exactly right when a Station has one Bedrock
      // connection (the common case, and the one where the old behaviour was
      // simply wrong) and arbitrary when it has several — inference resolves
      // auth per connection, and this route has no connection to resolve for.
      getBedrockAuth: async () => {
        const connections = await context.connectionService.listConnections();
        const bedrock = connections.find(
          (connection) => connection.type === 'bedrock' && connection.enabled,
        );
        return bedrock ? resolveBedrockConnectionAuth(bedrock) : {};
      },
    }),
  );
  context.app.route(
    '/api/system',
    createSystemRoutes(createRuntimeSystemRouteDeps(context), context.logger),
  );
  context.app.route(
    '/api/analytics',
    createAnalyticsRoutes(
      context.usageAggregator,
      undefined,
      readAuthorityForRequest,
      () =>
        peerCredentialStore
          .list()
          .map((peer) => peerCredentialStore.get(peer.environmentId))
          .filter((peer): peer is NonNullable<typeof peer> => peer !== null),
      context.environmentSecurityService.devicePairing.environmentId(),
    ),
  );
  context.app.route('/api/telemetry', createTelemetryRoutes(context.logger));
  // The UI mounts its disclosure on every shell, but this function runs inside
  // initializeRuntime, BEFORE StationRuntime constructs usageTelemetry — so
  // `context.usageTelemetry` is undefined here by construction (that was the
  // 404; capturing it with `!` made it a 500). Mount unconditionally with a
  // getter that resolves the service per request.
  context.app.route(
    '/api/usage-telemetry',
    createUsageTelemetryDisclosureRoutes(() => context.getUsageTelemetry?.()),
  );
  context.app.route(
    '/api/diagnostics',
    createDiagnosticsRoutes(
      new DiagnosticsService(context.configLoader.getProjectHomeDir(), {
        buildProvenanceSnapshot: context.buildProvenanceSnapshot,
      }),
      context.logger,
      // station#1896 logging slice 2: same directory slice 1's
      // `installServerLogSink` call (src-server/index.ts) writes to —
      // constructed inline the same way DiagnosticsService is above.
      createServerLogReader({
        directory: join(
          context.configLoader.getProjectHomeDir(),
          'logs',
          'server',
        ),
      }),
    ),
  );
  context.app.route(
    '/api/proposed-changes',
    createProposedChangeRoutes(context.proposedChangeService),
  );
  // station#3677 PR 3: the native consent broker's server half. Its own
  // family — consent is not a plugin concern; the two leaves' real gate is
  // the bound home-possession locality (see the scope inventory's entry).
  context.app.route(
    '/api/consent',
    createConsentNativeRoutes({ consentChannel: context.consentChannel }),
  );
  context.app.route('/api/auth', createAuthRoutes());
  context.app.route(
    '/api/secret-bindings',
    createSecretBindingRoutes(
      context.secretBindingAdministration,
      context.secretBindingIntegrationAdministration,
      context.mcpService,
    ),
  );
  context.app.route('/api/users', createUserRoutes());
  context.app.route(
    '/api/plugins',
    createPluginRoutes(
      context.configLoader.getProjectHomeDir(),
      context.logger,
      context.eventBus,
      {
        consentChannel: context.consentChannel,
        applyConfigurationMutation: context.applyAgentConfigurationMutation,
        refreshKitObservability: () =>
          kitObservabilityRegistry.discoverInstalled([
            join(context.configLoader.getProjectHomeDir(), 'kits'),
            join(context.configLoader.getProjectHomeDir(), 'plugins'),
          ]),
        settleProviderAdapterRetirements: () =>
          context.orchestrationService.settleProviderAdapterRetirements(),
        reconcileEngineConnections: async (plugin) => {
          await replacePluginEngineConnections(
            context.configLoader,
            plugin,
            listProviders('acpConnections')
              .filter((entry: any) => entry.source === plugin)
              .flatMap((entry: any) =>
                (entry.provider.getConnections?.() ?? []).map(
                  (connection: any) => connection.id,
                ),
              ),
          );
        },
        removeEngineConnections: async (plugin) => {
          const { unregisterPluginEngineConnections } = await import(
            '../../domain/agent-registry.js'
          );
          await unregisterPluginEngineConnections(context.configLoader, plugin);
        },
        quiesceEventSubscriptions: (plugin) =>
          context.pluginOperationalEventSubscriptions.quiesce(plugin),
        reconcileEventSubscriptions: () =>
          context.pluginOperationalEventSubscriptions.reconcile(),
      },
    ),
  );
  context.app.route('/api/fs', createFsRoutes());
  context.app.route(
    '/api/registry',
    createRegistryRoutes(
      context.configLoader,
      async () => {
        const acpConfig = await context.configLoader.loadACPConfig();
        await context.acpBridge.startAll(acpConfig.connections);
      },
      context.reloadSkillsAndAgents,
      context.skillService,
      {
        applyConfigurationMutation: context.applyAgentConfigurationMutation,
        approveKitOperatorAction: (candidate) =>
          context.approvalRegistry.register(
            ApprovalRegistry.generateId(
              `kit-operator-action-${candidate.descriptorDigest}-${candidate.incarnation}-${candidate.actionDigest}`,
            ),
            {
              metadata: {
                source: 'runtime',
                title: `Kit action: ${candidate.action.intent}`,
                agentName: candidate.contributionRef,
                description: `The ${candidate.contributionRef} Kit requests ${candidate.action.intent} for descriptor ${candidate.descriptorDigest}, incarnation ${candidate.incarnation}, target ${JSON.stringify(candidate.target)}.`,
              },
            },
          ),
        eventBus: context.eventBus,
        kitObservabilityRegistry,
        layoutCatalog,
        logger: context.logger,
        settleProviderAdapterRetirements: () =>
          context.orchestrationService.settleProviderAdapterRetirements(),
      },
    ),
  );

  // #749: these route families are the only public conversation discovery and
  // open surfaces. Bind the same principal-derived authority used by
  // orchestration before either route can inspect inventory or transcript.
  context.app.use('/agents/*', bindConversationReadAuthority);
  context.app.use('/api/conversations', bindConversationReadAuthority);
  context.app.use('/api/conversations/*', bindConversationReadAuthority);
  context.app.use('/api/search', bindConversationReadAuthority);
  context.app.use('/api/search/*', bindConversationReadAuthority);
  context.app.route(
    '/agents',
    createAgentRoutes(
      context.agentService,
      context.skillService,
      context.applyAgentConfigurationMutation,
      context.getVoltAgent,
      // #1536 D8 review H2: one reader for every surface that asks, reading
      // LIVE config. These three sites each built the call separately and had
      // already drifted onto the boot snapshot.
      createStationEngineAvailabilityReader(context),
      // Station#975 (unification slice 5) D-3: save-response validation
      // findings need the same runtime-connection lookup the enriched-agents
      // route below already performs — same shape, same fail-open contract
      // (createAgentRoutes's computeValidationFindings degrades to no
      // findings on a fetch failure, never a 500).
      async () =>
        (await context.connectionService.listRuntimeConnections()).map(
          (connection) =>
            runtimeConnectionSummary({ ...connection, parseEngineId }),
        ),
      // §3.3 orphan visibility (station#1004, unification slice 7): known
      // project slugs, so the save response can surface the ownership
      // finding for an A1-preserved orphan.
      () =>
        context.projectService.listProjects().map((project) => project.slug),
    ),
  );
  context.app.route(
    '/api/skills',
    createSkillRoutes(context.skillService, () =>
      context.configLoader.getProjectHomeDir(),
    ),
  );
  // Existing-agent setup import is personal-machine filesystem authority. A
  // hosted process must not even construct the module: an operator credential
  // is authority for the hosted tenant, never for this server's CODEX_HOME.
  if (hostedTenantRegistry === undefined) {
    context.app.route(
      '/api/setup-imports',
      createSetupImportRoutes(
        new ExistingAgentSetupImportModule(context.skillService, () =>
          context.configLoader.getProjectHomeDir(),
        ),
        {
          operatorIdentityForRequest: (routeContext) => {
            const authority = (
              routeContext as unknown as { get: (key: string) => unknown }
            ).get(RUNTIME_CREDENTIAL_AUTHORITY_VAR);
            return authority === 'operator-credential'
              ? getCachedUser().alias
              : undefined;
          },
          isHostedExecution: () => hostedTenantRegistry !== undefined,
        },
      ),
    );
  }
  // Shared across the integrations (MCP-UI evidence), flow, and readiness mounts
  // so they all operate on one run-file view.
  const flowRunService = new FlowRunService();
  const mcpUiEvidenceBridge = new FlowMcpUiEvidenceBridge({ flowRunService });
  const taskAnswerSupport = isHostedTenantExecutionRequired()
    ? undefined
    : createPersonalTaskAnswerSupportModule(context);
  const { taskOutputs, taskBasis, taskToolResultReferences } =
    createTaskBasisRuntimeComposition({
      homeDir: context.configLoader.getProjectHomeDir(),
      taskGraphService: context.taskGraphService,
      sessionQueries: context.orchestrationService.sessionQueries,
      hosted: isHostedTenantExecutionRequired,
      canReadSession: (sessionId, authority) =>
        context.orchestrationService.canUserReadSession(sessionId, authority),
      gateEvaluationReferences: createTaskGateEvaluationReferenceReadAdapter({
        taskGraph: context.taskGraphService,
        resolveProjectWorkspace: resolveWorkspacePath,
        isRequestPrincipalCurrent: (request) =>
          isRuntimeRequestPrincipalCurrent(
            request,
            context.environmentSecurityService,
          ),
        readFlowGateEvaluation: async ({ projectId, ref, authorize }) => {
          const cwd = resolveWorkspacePath(projectId);
          return cwd
            ? flowRunService.readGateEvaluation(cwd, ref, authorize)
            : { status: 'missing' };
        },
      }),
      readAssessment: async ({
        answer,
        authority,
        taskId,
        answerReferenceId,
      }) => {
        // A present Task curation association is authoritative only for this
        // Task. Corrupt/restricted local state is a visible owner arm, never
        // permission to fall back to a producer record for another scope.
        if (taskAnswerSupport) {
          const manual = await taskAnswerSupport.assessment(
            taskId,
            answerReferenceId,
            authority,
          );
          if (manual) return { assessment: manual };
        }
        return answerAssessmentModule.readExactAnswerAssessmentWithReviewedSource(
          {
            authorizedAnswer: answer,
            authority,
          },
        );
      },
      readReviewedSource: ({ answer, assessment, authority }) =>
        reviewedSourceBasisResolver.read({
          answer,
          assessment,
          authority,
          current: () =>
            context.orchestrationService.canUserReadSession(
              answer.sessionId,
              authority,
            ),
        }),
      // An absent private pin is a legacy/unbound Keep, never permission to
      // fall back to the mutable direct-association head.
      readNarrative: ({ answer, authority, associationRevision, request }) =>
        answerNarrativeBindingModule.readExactAnswerNarrative({
          authorizedAnswer: answer,
          authority,
          ...(associationRevision === undefined
            ? { revision: -1 }
            : { revision: associationRevision }),
          ...(request
            ? { current: () => isRequestPrincipalCurrent(request) }
            : {}),
        }),
    });
  const taskBasisAppRead = createTaskBasisAppReadModule({
    read: async ({ taskId, authority, request }) => {
      const outcome = await taskBasis.read({ taskId, authority, request });
      if (outcome.status !== 'found') return outcome;
      const data = parseStationTaskBasisCollection(outcome.data);
      return data
        ? { status: 'found' as const, data }
        : { status: 'unavailable' as const };
    },
    capturePublicationPolicy: async () => {
      const snapshot =
        await context.configLoader.captureIntegrationPolicySnapshot(
          STATION_BASIS_MCP_SERVER_ID,
        );
      if (
        !snapshot ||
        isMcpUiRenderRevoked(
          context.configLoader.getProjectHomeDir(),
          STATION_BASIS_MCP_SERVER_ID,
        )
      )
        return null;
      const disabled = new Set(snapshot.disabledTools);
      return snapshot.enabled &&
        !disabled.has('get_task_basis') &&
        !disabled.has('station-control_get_task_basis')
        ? snapshot
        : null;
    },
    isPublicationPolicyCurrent: (snapshot) =>
      !!snapshot &&
      context.configLoader.isIntegrationPolicySnapshotCurrent(
        snapshot as import('../../domain/config-loader.js').IntegrationPolicySnapshot,
      ) &&
      !isMcpUiRenderRevoked(
        context.configLoader.getProjectHomeDir(),
        STATION_BASIS_MCP_SERVER_ID,
      ),
    // Render revocation is checked before owner I/O and immediately before a
    // page can be published; failure is deliberately generic.
    isEnabled: async () => {
      const integration = await context.configLoader.loadIntegration(
        STATION_BASIS_MCP_SERVER_ID,
      );
      const disabled = new Set(integration.disabledTools ?? []);
      return (
        !isMcpUiRenderRevoked(
          context.configLoader.getProjectHomeDir(),
          STATION_BASIS_MCP_SERVER_ID,
        ) &&
        integration.enabled !== false &&
        !disabled.has('get_task_basis') &&
        !disabled.has('station-control_get_task_basis')
      );
    },
  });
  const taskBasisCallerBinding = (request: Request) => {
    const principal = getRuntimeAuthenticatedRequestPrincipal(request);
    if (!principal) return undefined;
    const internalBinding = request.headers.get(
      INTERNAL_CONTROL_CALLER_BINDING_HEADER,
    );
    if (
      principal.kind === 'internal' &&
      internalBinding &&
      /^[A-Za-z0-9_-]{20,128}$/.test(internalBinding)
    )
      return internalBinding;
    return createHash('sha256')
      .update(
        `${principal.kind ?? 'credential'}:${principal.authority ?? 'none'}:${principal.credential}`,
      )
      .digest('base64url');
  };
  // Keep this Request-only check at the runtime seam. It reuses the ingress
  // principal cached by authentication and replays ingress's current scope
  // classification for every protected publication route.
  const isRequestPrincipalCurrent = (request: Request) => {
    return isRuntimeRequestPrincipalCurrent(
      request,
      context.environmentSecurityService,
    );
  };
  context.app.route(
    '/api/search',
    createSearchRoutes(context.runtimeSearch, {
      readAuthorityForRequest: conversationReadAuthorityForRequest,
      isRequestPrincipalCurrent,
    }),
  );
  const sessionInventoryAppRead = createSessionInventoryAppReadModule({
    read: async ({ scope, authority, request: _request, current }) => {
      const outcome = await sessionInventory.read({
        scope,
        ...(scope.kind === 'kept-in-task'
          ? {
              keptRows: keptRowsForTaskSession(
                context.taskGraphService,
                scope.taskId,
                scope.sessionId,
              ),
              taskWorkItemRef: context.taskGraphService.readTask(scope.taskId)
                ?.workItemRef,
            }
          : {}),
        authority,
        current,
      });
      return outcome.status === 'found'
        ? { status: 'unavailable' as const }
        : outcome;
    },
    page: async ({
      scope,
      groupId,
      continuation,
      authority,
      request: _request,
      current,
    }) => {
      const outcome = await sessionInventory.page({
        scope,
        groupId,
        continuation,
        ...(scope.kind === 'kept-in-task'
          ? {
              keptRows: keptRowsForTaskSession(
                context.taskGraphService,
                scope.taskId,
                scope.sessionId,
              ),
              taskWorkItemRef: context.taskGraphService.readTask(scope.taskId)
                ?.workItemRef,
            }
          : {}),
        authority,
        current,
      });
      return outcome.status === 'found'
        ? { status: 'unavailable' as const }
        : outcome;
    },
    authorize: ({ scope, routeFamily, authority, request }) => {
      if (
        !request ||
        !isRequestPrincipalCurrent(request) ||
        !context.orchestrationService.canUserReadSession(
          scope.sessionId,
          authority,
        )
      )
        return false;
      if (routeFamily === 'orchestration') return scope.kind !== 'kept-in-task';
      if (scope.kind !== 'kept-in-task') return false;
      if (!context.taskGraphService.readTask(scope.taskId)) return false;
      return context.taskGraphService
        .readSessionRelations(scope.sessionId)
        .links.some(
          (link) =>
            (link.sourceType === 'task' && link.sourceId === scope.taskId) ||
            (link.targetType === 'task' && link.targetId === scope.taskId),
        );
    },
    isEnabled: async () => {
      const integration = await context.configLoader.loadIntegration(
        STATION_BASIS_MCP_SERVER_ID,
      );
      const disabled = new Set(integration.disabledTools ?? []);
      return (
        !isMcpUiRenderRevoked(
          context.configLoader.getProjectHomeDir(),
          STATION_BASIS_MCP_SERVER_ID,
        ) &&
        integration.enabled !== false &&
        !disabled.has('get_session_inventory') &&
        !disabled.has('station-control/get_session_inventory') &&
        !disabled.has('station-control_get_session_inventory')
      );
    },
  });
  const taskBasisMcpInitialRead = createTaskBasisMcpInitialRead({
    taskBasis,
    taskGraph: context.taskGraphService,
    authorityForRequest: readAuthorityForRequest,
    isRequestPrincipalCurrent,
    canReadSession: (sessionId, authority) =>
      context.orchestrationService.canUserReadSession(sessionId, authority),
  });
  context.app.route(
    '/integrations',
    // Reconnect reloads agents (which rebuilds their MCP connections), NOT a
    // full `initialize()` — re-running init re-binds the HTTP + voice-WS ports
    // (EADDRINUSE → uncaughtException → the server shuts itself down).
    createToolRoutes(context.mcpService, context.reloadAgents, {
      integrationIconAssets: new IntegrationIconAssets(
        context.configLoader.getProjectHomeDir(),
      ),
      // MCP-UI tool calls with `approvalPolicy: 'require'` block on a real inbox
      // approval before executing (the existing managed-approval registry +
      // inbox surface); the spec-compliant tool result is returned only after.
      approvalRegistry: context.approvalRegistry,
      // An approved call attaches a Flow-evidence receipt when its session is
      // bound to a run (threadId present + flow binding); otherwise audit-only.
      attachMcpUiEvidence: async ({ threadId, ...call }) => {
        const bound = await context.orchestrationService.readSessionFlowRun(
          threadId,
          readAuthorityForExecution(),
        );
        if (!bound) return;
        await mcpUiEvidenceBridge.attach(bound, call);
      },
      // Per-server MCP-UI render permission (S2, allow + revoke). Default allow
      // preserves the open + hardened-sandbox posture; an operator can revoke
      // a specific server's render from the integration settings.
      isRenderRevoked: (serverId) =>
        isMcpUiRenderRevoked(
          context.configLoader.getProjectHomeDir(),
          serverId,
        ),
      setRenderAllowed: (serverId, allow) =>
        setMcpUiRenderAllowed(
          context.configLoader.getProjectHomeDir(),
          serverId,
          allow,
        ),
      readInitialMcpAppResult: async (input) => {
        const taskResult = await taskBasisMcpInitialRead(input);
        if (taskResult !== undefined) return taskResult;
        if (
          input.serverId !== STATION_BASIS_MCP_SERVER_ID ||
          input.toolName !== STATION_BASIS_MCP_TOOL_NAME
        )
          return undefined;
        const basisInput = parseStationBasisToolInput(input.arguments);
        if (basisInput?.scope !== 'answer')
          return buildStationBasisUnavailableToolResult();
        const authority = readAuthorityForRequest(input.request);
        const outcome = await exactAnswerBasis.read({
          sessionId: basisInput.sessionId,
          turnId: basisInput.turnId,
          authority,
          current: () =>
            isRequestPrincipalCurrent(input.request) &&
            context.orchestrationService.canUserReadSession(
              basisInput.sessionId,
              authority,
            ),
        });
        if (outcome.status !== 'found')
          return buildStationBasisUnavailableToolResult(
            outcome?.status === 'unavailable',
          );
        return buildStationBasisProjectionToolResult(outcome.projection);
      },
    }),
  );
  context.app.route(
    '/api/ui',
    createUICommandRoutes(context.eventBus, {
      isHostedDeployment: () => hostedTenantRegistry !== undefined,
    }),
  );
  context.app.route(
    '/api/tasks',
    createTaskOutputRoutes(taskOutputs, {
      taskGraph: context.taskGraphService,
      sessionOutputs: context.orchestrationService.sessionOutputs,
      readAuthorityForRequest,
      canReadSession: (sessionId, authority) =>
        context.orchestrationService.canUserReadSession(sessionId, authority),
      isRequestPrincipalCurrent,
      resolveProjectWorkspace: resolveWorkspacePath,
    }),
  );
  context.app.route(
    '/api/tasks',
    createTaskRoutes(context.taskGraphService, {
      taskDispatcher: context.taskDispatcher,
      readAuthorityForRequest,
      canReadSession: (sessionId, authority) =>
        context.orchestrationService.canUserReadSession(sessionId, authority),
      sessionInventory,
      readAssistantTurn: ({ sessionId, turnId, authority }) =>
        context.orchestrationService.sessionQueries.readAssistantTurn(
          { type: 'assistant-turn', threadId: sessionId, turnId },
          authority,
        ),
      readUserInput: ({ sessionId, eventId, authority }) =>
        context.orchestrationService.sessionQueries.readUserInput(
          { type: 'user-input', threadId: sessionId, eventId },
          authority,
        ),
      readToolResult: async ({ sessionId, eventId, authority }) =>
        (await context.orchestrationService.sessionQueries.readToolResult?.(
          { type: 'tool-result', threadId: sessionId, eventId },
          authority,
        )) ?? { status: 'unavailable' },
      readFlowGateEvaluation: async ({ projectId, ref, authorize }) => {
        const cwd = resolveWorkspacePath(projectId);
        if (!cwd) return { status: 'missing' };
        return flowRunService.readGateEvaluation(cwd, ref, authorize);
      },
      resolveProjectWorkspace: resolveWorkspacePath,
      readTaskToolResultReferences: (input) =>
        taskToolResultReferences.read(input),
      readTaskBasis: (request) => taskBasis.read(request),
      taskBasisAppRead,
      sessionInventoryAppRead,
      callerBindingForRequest: taskBasisCallerBinding,
      isRequestPrincipalCurrent,
      answerNarrativeBindingModule,
      // A deliberate personal-only composition seam. Hosted mode must not
      // touch the global graph, Project service, home, or local filesystem.
      answerSupportModuleForRequest: () =>
        createPersonalTaskAnswerSupportModule(context),
    }),
  );
  // The runtime composition seam owns the only durable Starter Work adapter.
  // The store is a narrow correlation ledger, never a second task authority.
  // Starter Work's TaskGraph adapter is personal-home authority. Hosted
  // requests have no equivalent per-tenant task owner, so do not expose a
  // global home-backed ledger across tenant boundaries.
  const checkStarterAgentReadiness = async (requestedAgentId?: string) => {
    const agents = await context.agentService.listAgents();
    const agentId =
      requestedAgentId ??
      agents.map((agent) => agent.slug).find((slug) => slug === 'station') ??
      agents[0]?.slug;
    if (!agentId)
      return {
        state: 'unavailable' as const,
        reason:
          'No ready Agent is available. Choose an Agent before starting Starter Work.',
      };
    try {
      const spec = await context.agentService.getAgent(agentId);
      const managed = createStationEngineAvailabilityReader(context)(spec);
      if (managed) return { state: 'unavailable' as const, reason: managed };
      if (!spec.execution?.agentConnectionId)
        return { state: 'ready' as const, agentId };
      const connections = new Map(
        (await context.connectionService.listRuntimeConnections()).map(
          (connection) => [
            connection.id,
            runtimeConnectionSummary({ ...connection, parseEngineId }),
          ],
        ),
      );
      return isHonestlyAvailableConnectedAgent(spec, connections)
        ? { state: 'ready' as const, agentId }
        : {
            state: 'deferred' as const,
            reason: 'The selected Agent engine is still becoming ready.',
          };
    } catch {
      return {
        state: 'unavailable' as const,
        reason: 'The selected Agent is unavailable.',
      };
    }
  };
  const createPersonalStarterRegistry = !isHostedTenantExecutionRequired()
    ? (
        owners: StarterOwnerAdapter,
        scheduledChecks: StarterScheduledCheckOwner,
      ) =>
        new StarterRegistry(
          new StarterWorkModule(
            join(context.configLoader.getProjectHomeDir(), 'starter-work.json'),
          ),
          context.taskGraphService,
          context.taskDispatcher,
          {
            check: (input) =>
              checkStarterAgentReadiness(
                input.dispatch?.agentId ?? input.task.agentId,
              ),
            checkScheduled: () => checkStarterAgentReadiness('station'),
          },
          {
            read: async (sessionId) => {
              const detail = await context.orchestrationService.readSession(
                sessionId,
                INTERNAL_SESSION_READ_SCOPE,
              );
              return detail
                ? {
                    threadId: detail.session.threadId,
                    controlMode: detail.session.controlMode,
                  }
                : null;
            },
            continue: async ({ sourceSessionId, operationId }) => {
              try {
                const outcome =
                  await context.orchestrationService.dispatchWithReceipt({
                    type: 'adoptSession',
                    sourceThreadId: sourceSessionId,
                    idempotencyKey: operationId,
                  });
                const session = outcome.result as
                  | AdoptedSessionResult
                  | undefined;
                if (!session?.threadId)
                  return {
                    state: 'unavailable' as const,
                    reason:
                      'Station accepted continuation without an exact child Session.',
                    retrySafe: true,
                    receiptId: outcome.receipt.commandId,
                  };
                return {
                  state: 'continued' as const,
                  session,
                  receiptId: outcome.receipt.commandId,
                };
              } catch (error) {
                const observed = error as {
                  message?: string;
                  receipt?: { commandId?: string };
                  receiptStatus?: 'persisted' | 'unavailable';
                };
                return {
                  state:
                    observed.receiptStatus === 'persisted'
                      ? ('failed' as const)
                      : ('indeterminate' as const),
                  reason:
                    observed.message ??
                    'The Session continuation outcome is unavailable.',
                  retrySafe: true,
                  ...(observed.receipt?.commandId
                    ? { receiptId: observed.receipt.commandId }
                    : {}),
                };
              }
            },
          },
          context.getLiveAppConfig,
          owners,
          scheduledChecks,
        )
    : undefined;
  // Personal-only composition. Hosted deployments have no durable task owner
  // binding yet, so they deliberately expose no room route at all.
  if (!isHostedTenantExecutionRequired() && context.orchestrationEventStore) {
    let revisionEvidence: ProjectTaskRoomRevisionEvidenceBridge | undefined;
    try {
      revisionEvidence = new ProjectTaskRoomRevisionEvidenceBridge({
        eventStore: context.orchestrationEventStore,
        security: context.environmentSecurityService,
      });
    } catch {
      // Room editing remains available; discovery names revision-link absence.
    }
    const roomRuntime = new ProjectTaskRoomRuntime({
      taskGraph: context.taskGraphService,
      projectForId: (id) => {
        const project = context.projectService
          .listProjects()
          .find((candidate) => candidate.id === id || candidate.slug === id);
        // TaskGraph's established UI ingress records the Project slug while
        // newer callers may retain its opaque id. Room scope follows the
        // Task's exact stored identity; the lookup only proves that identity
        // still resolves to this Project.
        return project ? { id, slug: project.slug } : undefined;
      },
      history: (authority) =>
        context.orchestrationEventStore!.createProjectTaskRoomHistory({
          capabilities: authority.capabilities,
          agents: authority.agents,
          ...(authority.links ? { links: authority.links } : {}),
        }),
      working:
        context.orchestrationEventStore.createProjectTaskRoomWorkingState(
          process.env.STATION_PERFORMANCE_REFERENCE === '1'
            ? {
                maxRetainedOperations:
                  process.env
                    .STATION_PERFORMANCE_RECONNECT_DIAGNOSTIC_SEED_COUNT ===
                  '10'
                    ? 10
                    : 10_000,
                maxWorkingSnapshotBytes: 16 * 1024 * 1024,
                responseTimeoutMs: 120_000,
              }
            : undefined,
        ),
      ...(revisionEvidence ? { revisionEvidence } : {}),
      requestAuthority: {
        // station#4075 stage 3 slice 1: `operatorId` is now the stage-2
        // resolved `PrincipalRef.id` — cached on this exact `request` by the
        // `/api/tasks/*` middleware below, via the SAME production resolver
        // (`resolveOrchestrationRequestPrincipal`) the 12 orchestration
        // routes already use — never `getCachedUser().alias`. That alias was
        // the same OS-account-fallback class stages 1-2 removed from
        // dispatch: every distinct human/device reaching a Task room was
        // attributed to the SAME server-process OS account. Fail-closed: no
        // cached principal (resolution never ran, or threw
        // `PrincipalUnresolvedError`) revokes the grant rather than falling
        // back to any default identity.
        resolve: async (request) => {
          const authenticated =
            getRuntimeAuthenticatedRequestPrincipal(request);
          if (!authenticated) return { kind: 'revoked' as const };
          const principal = roomRequestPrincipals.get(request);
          if (!principal) return { kind: 'revoked' as const };
          const device = context.environmentSecurityService.identifyDevice(
            authenticated.credential,
          );
          if (device)
            return {
              kind: 'granted' as const,
              operatorId: principal.id,
              deviceId: device.id,
              policyRevision: device.scope,
            };
          return context.environmentSecurityService.verifyOperatorCredential(
            authenticated.credential,
          )
            ? {
                kind: 'granted' as const,
                operatorId: principal.id,
                deviceId: `operator:${principal.id}`,
                policyRevision: 'operator',
              }
            : { kind: 'revoked' as const };
        },
      },
      readAgentLifecycle: async ({ sessionId }) => {
        const detail = await context.orchestrationService.readSession(
          sessionId,
          INTERNAL_SESSION_READ_SCOPE,
        );
        if (!detail) return undefined;
        const lifecycle = projectSessionLifecycle({
          session: detail.session,
          events: detail.events,
        });
        const outcome =
          lifecycle.lifecycleState === 'completed'
            ? 'completed'
            : lifecycle.lifecycleState === 'failed'
              ? 'failed'
              : lifecycle.lifecycleState === 'canceled'
                ? 'cancelled'
                : undefined;
        return {
          provider: detail.session.provider,
          ...(outcome ? { outcome } : {}),
        };
      },
    });
    projectTaskRoomRuntime = roomRuntime;
    // A provider start is never retried from this rail. Only the idempotent
    // room-publication receipt is replayed after a prior process died between
    // Task association and history append.
    const roomTaskIds = context.taskGraphService
      .listTasks()
      .map((task) => task.id);
    projectTaskRoomLifecycleReady = Promise.all([
      roomRuntime.reconcileAgentLifecycles(roomTaskIds),
      roomRuntime.reconcileRevisionPublications(roomTaskIds),
    ]).then(() => undefined);
    // station#4075 stage 3 slice 1: resolve the calling principal once, here,
    // where the real Hono `c` (env + headers) is available, and cache it on
    // `c.req.raw` for `requestAuthority.resolve` above — see the
    // `roomRequestPrincipals` docs above `resolveOrchestrationRequestPrincipal`
    // for why the room runtime cannot do this resolution itself. A resolution
    // failure is deliberately left uncached (fail closed), matching
    // `resolveActorPrincipal`'s documented contract in
    // `routes/orchestration/orchestration.ts` that an unresolvable caller
    // throws rather than falling back to a default identity.
    //
    // Fix round (station#4075 stage 3 slice 1 review): every public
    // `ProjectTaskRoomRuntime` method that reaches `requestAuthority.resolve`
    // (via the private `#principal`) is invoked from exactly one of two
    // mounts — `discover`/`document`/`subscribe`/`subscriptionAlive`/
    // `subscriptionCadence`/`message`/`live`/`editPlan`/`submitBatch`/
    // `history` all come from `createProjectTaskRoomRoutes` under
    // `/api/tasks/*` (`routes/orchestration/project-task-rooms.ts`), and
    // `liveActivity` comes from `createLiveActivityRoutes` under
    // `/api/live-activity` (`routes/orchestration/live-activity.ts:23-25`,
    // mounted below at the unconditional `context.app.route('/api/live-
    // activity', ...)` call). `recovery` is never called from a live HTTP
    // route (system-only). The prime-principal middleware below MUST cover
    // both mounts — priming `/api/tasks/*` alone left every
    // `/api/live-activity` request with no cached principal, so `#principal`
    // always resolved `undefined`, `#authorizedDocument` always returned
    // undefined, and `liveActivity()` silently returned an empty
    // participants projection for every caller instead of revoking or
    // granting honestly.
    const primeRoomRequestPrincipal = async (
      c: Parameters<typeof resolveOrchestrationRequestPrincipal>[0],
      next: () => Promise<void>,
    ) => {
      try {
        roomRequestPrincipals.set(
          c.req.raw,
          resolveOrchestrationRequestPrincipal(c),
        );
      } catch {
        // Unresolved: no cache entry, so `requestAuthority.resolve` above
        // revokes rather than reading a stale or default principal.
      }
      await next();
    };
    context.app.use('/api/tasks/*', primeRoomRequestPrincipal);
    context.app.use('/api/live-activity', primeRoomRequestPrincipal);
    context.app.route('/api/tasks', createProjectTaskRoomRoutes(roomRuntime));
  }
  context.app.route(
    '/api/live-activity',
    createLiveActivityRoutes({
      roomRuntime: projectTaskRoomRuntime,
      connectedClientPresence,
      activePairedDeviceIds: () =>
        context.environmentSecurityService.devicePairing
          .listDevices()
          .filter((device) => device.revokedAt === null)
          .map((device) => device.id),
      hosted: isHostedTenantExecutionRequired,
    }),
  );
  // station#2802 slices 1/2 + fix round: workspace checkpoints — durable git
  // snapshots captured at turn boundaries (baseline on turn.started, settle
  // on turn.completed/turn.aborted) into hidden pseudo-refs, indexed in the
  // Station home. Capture is behind the default-OFF `workspaceCheckpoints`
  // app setting (fix-round H3): checkpoint objects are pinned against
  // `git gc` by their reflogs, so capture spends disk in every bound
  // project and must be an owner decision (`station checkpoints status` /
  // `prune` inspect and reclaim it). When off, NOTHING subscribes — no git
  // calls, no index writes. The listener is fire-and-forget by contract: a
  // checkpoint failure is recorded, never surfaced to the turn (see
  // turn-checkpoint-capture.ts). The read-only list route stays available
  // at any flag state; it serves the index truthfully (empty when capture
  // never ran).
  const checkpointHome = context.configLoader.getProjectHomeDir();
  const checkpointIndexStore = new CheckpointIndexStore(checkpointHome);
  const checkpointRefStore = new CheckpointRefStore();
  const checkpointRetentionService = new CheckpointRetentionService(
    checkpointIndexStore,
    checkpointRefStore,
    checkpointHome,
  );
  const checkpointRestoreService = new CheckpointRestoreService(
    checkpointIndexStore,
    checkpointRefStore,
    checkpointHome,
  );
  wireTurnCheckpointCaptureWhenEnabled(context.appConfig, {
    eventBus: context.eventBus,
    coordinator: new TurnCheckpointCaptureCoordinator({
      refStore: checkpointRefStore,
      indexStore: checkpointIndexStore,
      resolveWorkingDirectory: createThreadWorkingDirectoryResolver(
        context.orchestrationService,
        () => context.storageAdapter.listProjects(),
      ),
      logger: context.logger,
      retention: checkpointRetentionService,
      runMutationExclusive: async (operation) => {
        const release = await acquireFileMutationLockAsync(
          join(checkpointHome, CHECKPOINT_MUTATION_LOCK),
          { timeoutMs: 15 * 60_000 },
        );
        try {
          return await operation();
        } finally {
          await release();
        }
      },
      onOutcome: ({ phase, outcome }) =>
        checkpointCaptureOps.add(1, { phase, outcome }),
    }),
    logger: context.logger,
  });
  // Deliberately mounted at its own literal family: pairing-route-scopes.ts
  // records `/api/webhooks` and its HMAC-token leaf separately, so tunnel
  // exposure cannot turn an unmapped path into an authentication bypass.
  context.app.route(
    '/api/webhooks',
    createInboundWebhookRoutes({
      homeDir: context.configLoader.getProjectHomeDir(),
      logger: context.logger,
      startTurn: (input) =>
        executeExecutionTargetMessage(
          { ...input, readAuthority: readAuthorityForExecution() },
          context.orchestrationService,
        ),
    }),
  );
  // Current-host composer staging is intentionally process-local: unfinished
  // uploads expire on restart rather than becoming a durable hidden queue.
  const attachmentStaging = new AttachmentStagingService();
  context.app.route(
    '/api/orchestration/attachment-staging',
    createAttachmentStagingRoutes({
      service: attachmentStaging,
      currentOwner: (c) => {
        const principal = resolveOrchestrationRequestPrincipal(c);
        return {
          principalId: principal.id,
          ...(tenantExecutionContextForRequest(c.req.raw)
            ? {
                tenantId: tenantExecutionContextForRequest(c.req.raw)!.tenantId,
              }
            : {}),
        };
      },
    }),
  );
  context.app.route(
    '/api/orchestration',
    createOrchestrationRoutes(context.orchestrationService, {
      eventBus: context.eventBus,
      logger: context.logger,
      actionOperations,
      terminalService: context.terminalService,
      resolvePrincipal: resolveOrchestrationRequestPrincipal,
      isRequestPrincipalCurrent,
      answerAssessmentModule,
      answerNarrativeBindingModule,
      reviewedSourceBasisResolver,
      exactAnswerBasis,
      sessionInventory,
      sessionInventoryAppRead,
      callerBindingForRequest: taskBasisCallerBinding,
      listThreadCheckpoints: (threadId) =>
        listThreadRecordsWithObjectStatus(
          checkpointIndexStore,
          checkpointRefStore,
          threadId,
        ),
      restoreThreadCheckpoint: (input) =>
        checkpointRestoreService.restore(input),
      listCheckpointRestoreEvents: (threadId) =>
        checkpointRestoreService.listEvents(threadId),
      delegateTask: (input) =>
        delegateTask(
          { ...input, readAuthority: readAuthorityForExecution(input.userId) },
          context.orchestrationService,
        ),
      executeForegroundMessage: (input) =>
        executeExecutionTargetMessage(
          { ...input, readAuthority: readAuthorityForExecution(input.userId) },
          context.orchestrationService,
        ),
      hydrateStagedAttachments: (principal, references, binding) =>
        attachmentStaging.bindAndHydrate(
          {
            principalId: principal.id,
            ...(currentTenantExecutionContext()
              ? { tenantId: currentTenantExecutionContext()!.tenantId }
              : {}),
          },
          references,
          binding,
        ),
      acceptStagedAttachments: (principal, references, binding) =>
        attachmentStaging.acceptBinding(
          {
            principalId: principal.id,
            ...(currentTenantExecutionContext()
              ? { tenantId: currentTenantExecutionContext()!.tenantId }
              : {}),
          },
          references,
          binding,
        ),
      handoffConversation: (input) =>
        handoffExecutionTargetMessage(
          { ...input, readAuthority: readAuthorityForExecution(input.userId) },
          context.orchestrationService,
        ),
      reserveConversationContextBoundary: (input) =>
        context.orchestrationService.reserveConversationContextBoundary(
          input.conversationId,
          readAuthorityForExecution(input.actorId),
          {
            policy: input.policy,
            idempotencyKey: input.idempotencyKey,
            expectedCurrentSessionId: input.expectedCurrentSessionId,
            actorId: input.actorId,
            clientOrigin: JSON.stringify(input.clientOrigin),
          },
        ),
      readConversationContextBoundary: (
        conversationId,
        idempotencyKey,
        authority,
      ) =>
        context.orchestrationService.readConversationContextBoundaryStatus(
          conversationId,
          idempotencyKey,
          authority,
        ),
      cancelConversationContextBoundary: (
        conversationId,
        idempotencyKey,
        authority,
      ) =>
        context.orchestrationService.cancelConversationContextBoundary(
          conversationId,
          idempotencyKey,
          authority,
        ),
      projectDefaultEnvironment: (projectSlug) => {
        const configured =
          context.projectService.getProject(projectSlug).defaultEnvironment;
        if (configured?.kind !== 'saved') return { kind: 'current' };
        const exists = context.sshEnvironmentService
          .list()
          .some(
            (environment) =>
              environment.profile.environmentId === configured.id,
          );
        return exists ? configured : { kind: 'current' };
      },
      continueForegroundMessage: (input) =>
        continueExecutionTargetMessage(
          { ...input, readAuthority: readAuthorityForExecution(input.userId) },
          context.orchestrationService,
        ),
      discoverDelegationOptions,
      continueDelegatedTask: (input) =>
        continueDelegatedTask(
          { ...input, readAuthority: readAuthorityForExecution(input.userId) },
          context.orchestrationService,
        ),
      respondToDelegatedTaskRequest: (input) =>
        respondToDelegatedTaskRequest(
          { ...input, readAuthority: readAuthorityForExecution(input.userId) },
          context.orchestrationService,
        ),
      interruptDelegatedTask: (input) =>
        interruptDelegatedTask(
          { ...input, readAuthority: readAuthorityForExecution(input.userId) },
          context.orchestrationService,
        ),
      listDelegatedTasks: (input) =>
        listDelegatedTasks(
          { ...input, readAuthority: readAuthorityForExecution(input.userId) },
          context.orchestrationService,
        ),
      observeDelegatedTask: (input) =>
        observeDelegatedTask(
          { ...input, readAuthority: readAuthorityForExecution(input.userId) },
          context.orchestrationService,
        ),
      refreshDelegatedTaskActivity: (input) =>
        refreshPeerDelegationActivity(
          { ...input, readAuthority: readAuthorityForExecution(input.userId) },
          context.orchestrationService,
        ),
      observeDelegatedTaskEvents: (input) =>
        observeDelegatedTaskEvents(
          { ...input, readAuthority: readAuthorityForExecution(input.userId) },
          context.orchestrationService,
        ),
      presence: context.orchestrationStreamPresence,
      hostedTenantRegistry,
    }),
  );

  const runtimeContext = context.buildRuntimeContext();

  context.app.route(
    '/api/agents',
    createEnrichedAgentRoutes({
      agentMetadataMap: context.agentMetadataMap,
      activeAgents: context.activeAgents,
      // The service, not the loader: `getAgent`/`listAgents` are where the
      // reserved Station identity's engine binding is projected (station#3662
      // delta H3). One named seam, so the binding is testable rather than a
      // pair of lambdas a guard can only grep for (delta-2 MEDIUM).
      ...agentCatalogReadSeam(context.agentService),
      getActivationFailure: (slug) => context.getAgentActivationFailure?.(slug),
      getDefaultAgentIds: async () =>
        new Set(
          (
            await loadOrCreateAgentRegistry(context.configLoader)
          ).defaultAgents.map((agent) => String(agent.id)),
        ),
      defaultModel: context.appConfig.defaultModel,
      defaultTools: {
        // station#1547: `station-docs` joins the built-in agent's tool-server
        // list as projected by `GET /api/agents`.
        //
        // Scoped honestly: this is a PROJECTION, not the delivery path. It
        // describes the built-in agent's tools; three other mechanisms
        // actually deliver them, and this line proves none of them.
        //
        //  - Station's own engine gets both via the `defaultSpec` written in
        //    `runtime-default-agent.ts`.
        //  - An external engine running the `station` identity gets both via
        //    `builtinStationAgentSpec` (`session-agent-resolution.ts`), the
        //    synthetic spec that stands in for the on-disk one a
        //    registry-default agent does not have —
        //    `configLoader.loadAgent('station')` throws and `loadAgentSpec`
        //    maps that to null, so without the synthetic spec the resolver
        //    would return early. `station-control` still needs the engine's
        //    matrix to name a `builtinStationControlDelivery` mechanism;
        //    `station-docs` needs nothing, because it declares no `env`.
        //  - An ACP engine gets `station-docs` from the runtime grant in
        //    `acp-adapter.ts` (station#1547 AC5), unconditionally. Since
        //    station#1684 such an engine CAN carry `station-control` — but
        //    only when its connected CLI advertises `mcpCapabilities.http`
        //    at `initialize`, which is a per-connection fact no projection
        //    can state, so the grant stays unconditional and this list
        //    stays a projection.
        //
        // What remains uncovered is a NON-`station` agent on a capable
        // engine: a user's own `claude`/`codex` agent is delivered whatever
        // it authored and nothing more. That is by design, not a gap this
        // list papers over — it authors its own tools.
        mcpServers: ['station-control', 'station-docs'],
        autoApprove: context.defaultAutoApprovedTools,
      },
      getRuntimeConnections: async () =>
        (await context.connectionService.listRuntimeConnections()).map(
          (connection) =>
            runtimeConnectionSummary({ ...connection, parseEngineId }),
        ),
      getAgentConfigurationRevision: context.getAgentConfigurationRevision,
      logger: context.logger,
      // Home's recommendation and the Agents list read this reason.
      resolveAvailability: createStationEngineAvailabilityReader(context),
      // §3.3 orphan visibility (station#1004, unification slice 7): known
      // project slugs, used to mark a persisted agent's `project` as an
      // orphan finding when it names a project that no longer exists.
      listProjectSlugs: () =>
        context.projectService.listProjects().map((project) => project.slug),
    }),
  );

  context.app.route('/acp', createACPRoutes(runtimeContext));
  context.app.route('/agents', createAgentToolRoutes(runtimeContext));
  context.app.route(
    '/',
    createInvokeRoutes(runtimeContext, { readAuthorityForRequest }),
  );
  context.app.route(
    '/api/agents',
    createChatRoutes({
      ...runtimeContext,
      // station#977: threaded in here (rather than widening the shared
      // `RuntimeContext` every route module receives) so `/chat` can apply
      // the same external-engine honesty check `GET /api/agents` uses
      // instead of falsely reporting a persisted, ready external-engine
      // agent "not currently launchable".
      connectionService: context.connectionService,
      // #1536 D8 delta review DM1: the live inputs the shared availability
      // reader needs. Without them `/chat` answered its 409 from the boot
      // snapshot, so fixing the default model connection at runtime cleared
      // the picker and the inbox while chat went on refusing until restart.
      getLiveAppConfig: () => context.getLiveAppConfig(),
      checkGatedModelConnectionIds: () =>
        context.connectionService.checkGatedModelConnectionIds(),
      listAgents: () => context.agentService.listAgents(),
      getDefaultAgentIds: async () =>
        new Set(
          (
            await loadOrCreateAgentRegistry(context.configLoader)
          ).defaultAgents.map((agent) => String(agent.id)),
        ),
    }),
  );
  context.app.route('/agents', createWorkflowRoutes(context.layoutService));
  context.app.route(
    '/api/projects',
    createProjectRoutes(
      context.projectService,
      context.storageAdapter,
      context.configLoader.getProjectHomeDir(),
      {
        layoutCatalog,
        kitObservabilityRegistry,
        terminalService: context.terminalService,
        // station#3778: the SAME service instance the Board's availability
        // route answers from, so the Pane catalogue, the nav entry and the
        // route guard cannot drift into three answers.
        hasBuilderRun: (slug) => {
          const workspace = resolveWorkspacePath(slug);
          return workspace
            ? operatingStateService.hasBuilderRun(workspace)
            : false;
        },
        listAgents: async () =>
          (await context.agentService.listAgents()).map(
            ({ slug, project }) => ({ slug: agentId(slug), project }),
          ),
        // station#1502 slice 4. `source` is PINNED to this runtime's own
        // storage adapter, exactly as `station-runtime.ts` pins it (slice-3b
        // review FIX 6): a resolver that defaults its own `FileStorageAdapter`
        // answers from a different project store than the runtime was built
        // over, so the settings surface and the runtime would disagree about
        // the same project. The stores below share that pinned source for the
        // same reason.
        resolution: buildProjectResolutionRouteDeps(context),
      },
    ),
  );
  context.app.route(
    '/api/providers',
    createProviderRoutes(context.providerService, {
      applyConfigurationMutation: context.applyAgentConfigurationMutation,
      // So the legacy provider endpoints answer from the same classified check
      // the connections surface reads, rather than a narrower boolean.
      connectionService: context.connectionService,
    }),
  );
  context.app.route(
    '/api/connections',
    createConnectionRoutes(context.connectionService, {
      applyConfigurationMutation: context.applyAgentConfigurationMutation,
    }),
  );
  context.app.route(
    '/api/connections',
    createAppHomeRoutes({
      // #896 wave 2: the DELETE clear route's 409-while-enabled guard reads
      // the connection's SAVED config directly — never the in-memory
      // adapter state — same source of truth `runtimeDefaultConfig`/
      // `sanitizeRuntimeConfig` already treat as authoritative.
      isUseAppHomeEnabled: async (id) =>
        (await context.connectionService.getConnection(id))?.config
          ?.useAppHome === true,
      // Credential-profile management delegates all registry/application
      // state transitions to the single ConnectionService authority.
      connectionService: context.connectionService,
    }),
  );
  // station#1398 slice 2: the fleet inference family, mounted on its own
  // top-level prefix rather than under `/api/connections` so its
  // `inference:invoke` tier cannot be inherited by (or from) a neighbour —
  // see `pairing-route-scopes.ts`'s entry and
  // `docs/design/inference-fleet.md` §3.3. Completions only: this route
  // never constructs a session and is not `delegate_task`.
  // The base below is a STRING LITERAL, not the
  // `FLEET_INFERENCE_ROUTE_PREFIX` constant, on purpose: the scope-coverage
  // scanners in `pairing-route-scopes.test.ts` and
  // `pairing-route-leaf-scan.ts` only discover mounts whose base is written
  // inline, and the latter's own docblock warns that a computed or variable
  // base would be invisible to them. A DRY constant here would buy nothing
  // and would silently remove this family from the guard that proves every
  // registered route resolves to a required scope.
  context.app.route(
    '/api/inference',
    createFleetInferenceRoutes(
      new FleetInferenceService({
        getFleetContributionManifest: () =>
          context.connectionService.getFleetContributionManifest(),
        getConnection: (id) => context.connectionService.getConnection(id),
      }),
      // station#1398 slice 3, §3.4 "Both sides record": B's own account of
      // what it served. Local-only, hash-chained, digests not content.
      new FleetServeReceiptLog(context.configLoader.getProjectHomeDir()),
    ),
  );
  // One store instance feeds both the SSH session reader's outbound bearer
  // and the operator provisioning routes below. The tunnel is transport only;
  // remote protected reads carry this credential explicitly.
  // station#2037: persistent exact-tool grants share the runtime's STATION_HOME
  // with the resolver already wired by slice 3. The narrower route-family
  // scope below makes this an operator-management surface, never an agent tool.
  const unattendedGrantStore = new UnattendedGrantStore(
    context.configLoader.getProjectHomeDir(),
  );
  registerPullRequestProvider(new GitHubPullRequestProvider());
  registerPullRequestProvider(new GitLabPullRequestProvider());
  const pullRequestContextResolver = new PullRequestRepositoryContextResolver();
  context.app.route(
    '/api/pull-requests',
    createPullRequestRoutes(
      () => listProviders('pullRequest').map((entry) => entry.provider),
      async (routeContext) => {
        const projectSlug = routeContext.req.query('project');
        if (!projectSlug)
          return { available: false, reason: 'A recorded project is required' };
        let project: { workingDirectory?: string };
        try {
          project = context.projectService.getProject(projectSlug);
        } catch {
          return { available: false, reason: 'Project is unavailable' };
        }
        const threadId = routeContext.req.query('thread');
        const session = threadId
          ? pullRequestThreadForProject(
              await context.orchestrationService.listSessions(
                INTERNAL_SESSION_READ_SCOPE,
              ),
              threadId,
              projectSlug,
            )
          : undefined;
        return pullRequestContextResolver.resolve({
          // EXPAND — 111 lines above this file's own comment warning about
          // exactly this. Raw, it reaches `git remote -v` with a `~/…` cwd
          // (ENOENT) or realpathSync (throws), so the Pull Requests panel
          // reported itself permanently unavailable (station#3155).
          projectWorkingDirectory: project.workingDirectory
            ? resolve(expandTilde(project.workingDirectory))
            : project.workingDirectory,
          workspaceIsolation: session?.workspaceIsolation,
          requestedWorkingDirectory: routeContext.req.query('workingDirectory'),
        });
      },
      {
        operatorIdentityForRequest: (routeContext) => {
          const authority = (
            routeContext as unknown as { get: (key: string) => unknown }
          ).get(RUNTIME_CREDENTIAL_AUTHORITY_VAR);
          return authority === 'operator-credential'
            ? getCachedUser().alias
            : undefined;
        },
      },
    ),
  );
  context.app.route(
    '/api/agents/unattended-grants',
    createUnattendedGrantRoutes(unattendedGrantStore, {
      operatorIdentityForRequest: (routeContext) => {
        const authority = (
          routeContext as unknown as { get: (key: string) => unknown }
        ).get(RUNTIME_CREDENTIAL_AUTHORITY_VAR);
        return authority === 'operator-credential'
          ? getCachedUser().alias
          : undefined;
      },
      logger: context.logger,
    }),
  );
  context.app.route(
    '/api/environments/ssh',
    createSshEnvironmentRoutes(
      context.sshEnvironmentService,
      undefined,
      peerCredentialStore,
    ),
  );
  // station#1123 slice 2: outbound peer-credential admin routes. Gated to
  // access:manage in pairing-route-scopes.ts (see that module and
  // peer-credential-routes.ts's own docblock for why) — a plain-JSON store
  // constructed inline the same way DiagnosticsService is above, no new
  // field on ConfigureRuntimeRoutesContext required. The SSH-profile lookup
  // (review fix, PR #1178) reuses the already-wired sshEnvironmentService
  // rather than a second file read.
  context.app.route(
    '/api/environments/peers',
    createPeerCredentialRoutes(peerCredentialStore, (environmentId) =>
      context.sshEnvironmentService
        .list()
        .some(
          (environment) => environment.profile.environmentId === environmentId,
        ),
    ),
  );
  // station#1423: the operator's own answer-share management family. The base
  // is a STRING LITERAL rather than `ANSWER_SHARE_ROUTE_PREFIX`, for the same
  // reason the fleet mount above spells its base inline: the scope-coverage
  // scanners in `pairing-route-scopes.test.ts` and `pairing-route-leaf-scan.ts`
  // only discover mounts whose base is written literally, and a DRY constant
  // here would silently remove this family from the guard that proves every
  // registered route resolves to a required scope.
  //
  // Its own top-level prefix, not a leaf under `/api/orchestration`: this
  // table classifies at route-FAMILY granularity, so hanging shares off an
  // existing family would either let a future sibling inherit the share tier
  // or let a future share endpoint inherit `orchestration:read`. Gated at
  // `access:manage` — see `pairing-route-scopes.ts` for the reasoning.
  context.app.route(
    '/api/shares',
    createAnswerShareRoutes(answerShareService, { readAuthorityForRequest }),
  );
  context.app.get('/api/projects/:slug/conversations', async (routeContext) => {
    // File-memory conversations have no tenant binding.  They are therefore
    // not a hosted projection, even if an old shared home still contains
    // records; return the same empty inventory shape rather than exposing a
    // cross-tenant count or title.
    if (readAuthorityForRequest(routeContext.req.raw).mode === 'hosted') {
      return routeContext.json({ success: true, data: [] });
    }
    const limit = Number(routeContext.req.query('limit') || 50);
    const adapter = context.memoryAdapters.values().next().value;
    if (!adapter) {
      return routeContext.json({ success: true, data: [] });
    }
    const conversations = await adapter.queryConversations({});
    conversations.sort((a: any, b: any) =>
      (b.updatedAt || '').localeCompare(a.updatedAt || ''),
    );
    return routeContext.json({
      success: true,
      data: conversations.slice(0, limit),
    });
  });
  context.app.route(
    '/api/projects/:slug/knowledge',
    createKnowledgeRoutes(context.knowledgeService),
  );
  // `flowRunService` is created above (shared with the integrations mount).
  // The Flow readiness bridge (S1c) reuses the same Veritas CLI runs via this
  // readiness service.
  const veritasReadinessService = new VeritasReadinessService();
  // A project's workingDirectory is stored as the user typed it, often with a
  // leading `~` (e.g. `~/dev/github/...`). The flow/readiness/trust services
  // do `existsSync(join(cwd, '.flow'|'.veritas'|...))` directly, so an
  // unexpanded `~` makes every check miss and the integrations report
  // "not configured" even when the dirs exist. Expand the tilde here, the same
  // way the coding file routes already do at their boundary.
  function resolveWorkspacePath(slug: string): string | undefined {
    try {
      const wd = context.projectService.getProject(slug)?.workingDirectory;
      return wd ? expandTilde(wd) : undefined;
    } catch {
      return undefined;
    }
  }
  /**
   * station#3778 — ONE instance, so every surface that asks "does this project
   * have a Builder run?" (the Board's availability route, its nav entry via
   * that route, and the workspace-Pane catalogue) asks the same object.
   */
  const operatingStateService = new OperatingStateService({
    workflowSidecarService: new WorkflowSidecarService({
      logger: context.logger,
    }),
  });
  const reviewObserver = {
    record(input: { operation: string; outcome: string; durationMs?: number }) {
      try {
        reviewEvidenceOperations.add(1, {
          operation: input.operation,
          outcome: input.outcome,
        });
        if (input.durationMs !== undefined) {
          reviewEvidenceDuration.record(input.durationMs, {
            operation: input.operation,
            outcome: input.outcome,
          });
        }
      } catch {}
    },
    diagnostic(input: {
      operation: string;
      error: unknown;
      requestId?: string;
      projectSlug?: string;
    }) {
      try {
        context.logger.warn('Independent review evidence operation failed', {
          operation: input.operation,
          requestId: input.requestId,
          projectSlug: input.projectSlug,
          error: input.error,
        });
      } catch {}
    },
  };
  const reviewStore = new FileReviewReceiptStore(
    { workspace: resolveWorkspacePath },
    {
      coordinationDirectory: join(
        context.configLoader.getProjectHomeDir(),
        '.review-evidence-coordination',
      ),
      diagnostic: (operation, error) =>
        reviewObserver.diagnostic({ operation, error }),
    },
  );
  const reviewEvidence = new ReviewEvidenceModule({
    source: new GitReviewWorkspaceSource(
      { workspace: resolveWorkspacePath },
      join(
        context.configLoader.getProjectHomeDir(),
        '.review-evidence-workspaces',
      ),
    ),
    executor: new OrchestrationReviewExecutor({
      orchestration: context.orchestrationService,
      supportsReadOnlyReview: (provider) =>
        context.orchestrationService.supportsReadOnlyReview(provider),
    }),
    receipts: reviewStore,
    submissions: reviewStore,
    principals: {
      resolveAgent: async (agentSlug) => {
        try {
          const agent = await context.configLoader.loadAgent(agentSlug);
          return {
            actorId: `agent:${agentSlug}`,
            displayName: agent.name,
          };
        } catch {
          return null;
        }
      },
    },
    observer: reviewObserver,
    attachment: new FlowReviewEvidenceAttachment(
      flowRunService,
      resolveWorkspacePath,
    ),
    selectionResolver: new RepoMapReviewSelection({
      target: (projectSlug) => {
        const project = context.projectService.getProject(projectSlug);
        const workspace = project?.workingDirectory
          ? expandTilde(project.workingDirectory)
          : undefined;
        if (!project || !workspace) return undefined;
        return {
          projectSlug: project.slug,
          workspace,
          globalAgentSlugs: [...(project.agents ?? [])].map(String).sort(),
        };
      },
      listAgents: () => context.configLoader.listAgents(),
      supportsReadOnlyReview: (provider) =>
        context.orchestrationService.supportsReadOnlyReview(provider),
      isCodexReviewerAvailable: (agent) =>
        agent.execution?.agentConnectionId === 'codex',
    }),
  });
  context.app.route(
    '/api/projects/:slug/reviews',
    createReviewEvidenceRoutes(reviewEvidence, {
      getUserId: () => getCachedUser().alias,
      getTenantExecutionContext: currentTenantExecutionContext,
      reportError: (operation, error) =>
        reviewObserver.diagnostic({ operation, error }),
    }),
  );
  context.app.route(
    '/api/review-evidence',
    createReviewEvidenceAggregateRoutes(
      reviewEvidence,
      () =>
        context.projectService.listProjects().map((project) => project.slug),
      (operation, error) => reviewObserver.diagnostic({ operation, error }),
    ),
  );
  const surveyReview = new SurveyFlowReviewService(
    new FileStationSurveyReviewSessionStore({
      listSlugs: () =>
        context.projectService.listProjects().map((project) => project.slug),
      workspace: resolveWorkspacePath,
    }),
    {
      diagnostic: (projectSlug, error) =>
        context.logger.warn('Survey flow review project unavailable', {
          projectSlug,
          error: sanitizedTransportError(error),
        }),
    },
  );
  context.app.get('/api/survey-flow-reviews', async (routeContext) => {
    try {
      const data = await surveyReview.listAll(
        context.projectService.listProjects().map((project) => project.slug),
      );
      return routeContext.json({ success: true, data });
    } catch (error) {
      const failure = outwardTransportFailure('runtimeHttp');
      context.logger.error('Survey flow review lookup failed', {
        correlationId: failure.correlationId,
        error: sanitizedTransportError(error),
      });
      return routeContext.json(
        {
          success: false,
          error: {
            code: 'survey_flow_review_unavailable',
            correlationId: failure.correlationId,
          },
        },
        500,
      );
    }
  });
  context.app.route(
    '/api/projects/:slug/flow',
    createFlowRunRoutes(flowRunService, {
      getWorkspacePath: resolveWorkspacePath,
      isRequestPrincipalCurrent,
      readinessBridge: new FlowReadinessBridge({
        flowRunService,
        readinessService: veritasReadinessService,
      }),
      surveyReview,
    }),
  );
  context.app.route(
    '/api/projects/:slug/workflow',
    createWorkflowSidecarRoutes(
      new WorkflowSidecarService({ logger: context.logger }),
      {
        getWorkspacePath: resolveWorkspacePath,
        getSessionReadAuthority: readAuthorityForRequest,
      },
    ),
  );
  context.app.route(
    '/api/projects/:slug/work-items',
    createWorkItemRoutes(
      new WorkItemProviderService(
        [
          new LocalWorkItemProvider(context.taskGraphService),
          new FlowAgentsWorkItemProvider({ logger: context.logger }),
        ],
        context.logger,
      ),
      {
        getWorkspacePath: resolveWorkspacePath,
        getSessionReadAuthority: readAuthorityForRequest,
        // Stateless service (package-root resolution only) — a separate
        // instance from the one `StationRuntime` wires into
        // `taskGraphService` (roadmap #584) is cheap and avoids widening
        // this function's context type just to share one.
        assignmentClaimService: new AssignmentClaimService({
          logger: context.logger,
        }),
      },
    ),
  );
  context.app.route(
    '/api/projects/:slug/operating-state',
    createOperatingStateRoutes(operatingStateService, {
      getWorkspacePath: resolveWorkspacePath,
      getSessionReadAuthority: readAuthorityForRequest,
      intentBindingDeps: {
        taskGraphService: context.taskGraphService,
        taskDispatcher: context.taskDispatcher,
        orchestrationService: context.orchestrationService,
        getSessionReadAuthority: readAuthorityForExecution,
        isHostedExecution: () => hostedTenantRegistry !== undefined,
      },
    }),
  );
  context.app.route(
    '/api/projects/:slug/readiness',
    createVeritasReadinessRoutes(veritasReadinessService, {
      getWorkspacePath: resolveWorkspacePath,
    }),
  );
  context.app.route(
    '/api/projects/:slug/trust-bundles',
    createTrustBundleRoutes(new TrustBundleService(), {
      available: () => !isHostedTenantExecutionRequired(),
      resolveLocations: (slug) => {
        try {
          const project = context.projectService.getProject(slug);
          if (!project) return undefined;
          const workspacePath = project.workingDirectory
            ? expandTilde(project.workingDirectory)
            : undefined;
          // Surface the trust bundle embedded in the latest Veritas evidence
          // record, unless explicitly disabled. Default on (=== false opt-out)
          // so Trust lights up wherever Veritas has run.
          const veritasEvidenceDir =
            workspacePath &&
            context.appConfig.surfaceTrustFromVeritasEvidence !== false
              ? [
                  join(
                    workspacePath,
                    STATION_ARTIFACT_ROOTS.veritas,
                    'evidence',
                  ),
                  join(workspacePath, STATION_LEGACY_ROOTS.veritas, 'evidence'),
                ]
              : undefined;
          return {
            workspacePath,
            veritasEvidenceDir,
            pluginDataDir: join(
              context.configLoader.getProjectHomeDir(),
              'projects',
              slug,
              'plugin-data',
            ),
          };
        } catch {
          return undefined;
        }
      },
    }),
  );
  context.app.route(
    '/api/projects/:slug/diff-comments',
    createDiffCommentRoutes(new DiffCommentService(), {
      resolveStorePath: (slug) => {
        try {
          const project = context.projectService.getProject(slug);
          if (!project?.workingDirectory) return undefined;
          return join(
            expandTilde(project.workingDirectory),
            '.station',
            'diff-comments.json',
          );
        } catch {
          return undefined;
        }
      },
    }),
  );
  context.app.route(
    '/api/diff-comments',
    createDiffCommentsAggregateRoutes(new DiffCommentService(), {
      listStorePaths: () =>
        context.projectService
          .listProjects()
          .map((project) => project.workingDirectory)
          .filter((wd): wd is string => !!wd)
          .map((wd) => join(expandTilde(wd), '.station', 'diff-comments.json')),
    }),
  );
  context.app.route(
    '/api/knowledge',
    createCrossProjectKnowledgeRoutes(
      context.knowledgeService,
      context.storageAdapter,
      context.providerService,
    ),
  );
  // K3 index-management routes (rebuild/migrate) — explicit, user/CLI-triggered
  // only, mounted alongside the cross-project knowledge routes above at the same
  // `/api/knowledge` base (distinct sub-paths, no collision:
  // `/index/rebuild`, `/migrate` vs. `/status`, `/search`).
  const knowledgeIndexRegistry = new KnowledgeIndexAdapterRegistry();
  const knowledgeIndexProvider = knowledgeIndexRegistry.get('sqlite-vec');
  if (!knowledgeIndexProvider) {
    throw new Error(
      "KnowledgeIndexAdapterRegistry did not pre-register the built-in 'sqlite-vec' provider",
    );
  }
  context.app.route(
    '/api/knowledge',
    createKnowledgeIndexRoutes({
      store: context.knowledgeStoreProvider,
      indexProvider: knowledgeIndexProvider,
      dataDir: context.configLoader.getProjectHomeDir(),
      getEmbedder: () => context.resolveEmbeddingProvider(),
    }),
  );
  // K4 onboarding routes (roots/adapters) — same `/api/knowledge` base, distinct
  // sub-paths (`/roots`, `/roots/validate`, `/adapters`) with no collision against
  // the cross-project routes' `/status`/`/search` or K3's `/index/rebuild`/`/migrate`.
  context.app.route(
    '/api/knowledge',
    createKnowledgeStoreRoutes({
      store: context.knowledgeStoreProvider,
      dataDir: context.configLoader.getProjectHomeDir(),
    }),
  );
  // K5 record-CRUD routes (`s203-knowledge-meeting-notes` Wave 1 Task 2) — same
  // `/api/knowledge` base, distinct sub-paths (`/roots/:rootId/records`,
  // `/roots/:rootId/records/:id`, `/roots/:rootId/records/:id/links`,
  // `/roots/:rootId/graph`) with no collision against any route mounted above:
  // those are all either `/roots`/`/roots/validate`/`/roots/:id` (single segment
  // after `/roots`) or a distinct top-level verb (`/status`, `/search`,
  // `/index/*`, `/migrate`, `/adapters`).
  context.app.route(
    '/api/knowledge',
    createKnowledgeRecordRoutes({
      store: context.knowledgeStoreProvider,
    }),
  );
  const personalSourceRequest = createPersonalRuntimeRequestGuard();
  context.app.route(
    '/api/knowledge',
    createKnowledgeSourceRoutes(context.knowledgeStoreProvider, (request) =>
      isLocalKnowledgeSourceRequestCurrent(
        request,
        context.environmentSecurityService,
        personalSourceRequest,
      ),
    ),
  );
  // K5 Neo4j graph-view routes (`s203-knowledge-meeting-notes` Wave 1 Task 1) — same
  // `/api/knowledge` base, sub-paths of the file-based graph route
  // (`/roots/:rootId/graph/neo4j*`), so no collision with the route mounted just
  // above or any other route mounted at this base (see `neo4j-graph-routes.ts`'s
  // module doc for why this is a sibling file rather than an extension of
  // `knowledge-record-routes.ts`).
  context.app.route(
    '/api/knowledge',
    createNeo4jGraphRoutes({
      store: context.knowledgeStoreProvider,
    }),
  );
  context.app.route('/api/coding', createCodingRoutes(context.fileTreeService));
  context.app.route(
    '/api/templates',
    createTemplateRoutes(context.storageAdapter),
  );
  context.app.route(
    '/config',
    createConfigRoutes(
      context.configLoader,
      context.logger,
      context.eventBus,
      context.applyAgentConfigurationMutation,
      context.getMcpUiFrameOrigin,
      context.getManagedChatOrchestrationEnabled,
      context.rebindBuiltinAgents,
      context.getPluginFrameOrigin,
    ),
  );
  context.app.route(
    '/bedrock',
    createBedrockRoutes(
      () => context.modelCatalog!,
      context.appConfig,
      context.logger,
    ),
  );
  context.app.route('/api/branding', createBrandingRoutes());
  // A best-effort accelerator only: each provider is the same route factory
  // used by the independent query, so response derivation remains singular.
  context.app.route(
    '/api/boot',
    createBootRoutes({
      auth: async () => (await createAuthRoutes().request('/status')).json(),
      config: async () =>
        (
          await createConfigRoutes(
            context.configLoader,
            context.logger,
            context.eventBus,
            context.applyAgentConfigurationMutation,
            context.getMcpUiFrameOrigin,
            context.getManagedChatOrchestrationEnabled,
            context.rebindBuiltinAgents,
            context.getPluginFrameOrigin,
          ).request('/app')
        ).json(),
      capabilities: async () =>
        (
          await createSystemRoutes(
            createRuntimeSystemRouteDeps(context),
            context.logger,
          ).request('/capabilities')
        ).json(),
      branding: async () => (await createBrandingRoutes().request('/')).json(),
      agents: async () => {
        const enrichedAgents = await context.agentService.getEnrichedAgents(
          await context.getVoltAgent()!.getAgents(),
        );
        return {
          success: true,
          data: await deriveAgentCatalog(
            context.agentService,
            enrichedAgents,
            // This site also omitted `gatedConnectionIds` entirely, so
            // `/api/boot`'s catalog reported an agent bound to a faulted
            // connection as runnable.
            createStationEngineAvailabilityReader(context),
          ),
        };
      },
      projects: async () => ({
        success: true,
        data: await context.projectService.listProjects(),
      }),
      models: async () =>
        (
          await createModelsRoutes({
            getAppConfig: () => context.configLoader.loadAppConfig(),
          }).request('/')
        ).json(),
    }),
  );
  context.app.route(
    '/monitoring',
    createMonitoringRoutes({
      activeAgents: context.activeAgents as any,
      agentStats: context.agentStats,
      agentStatus: context.agentStatus as any,
      memoryAdapters: context.memoryAdapters,
      metricsLog: context.metricsLog,
      monitoringEvents: context.monitoringEvents,
      queryEventsFromDisk: context.queryEventsFromDisk,
      projectHomeDir: context.configLoader.getProjectHomeDir(),
      readAuthorityForRequest,
      canReadMonitoringEvent: (event, authority) => {
        const sessionId = monitoringSessionIdentity(event);
        return sessionId
          ? context.orchestrationService.canUserReadSession(
              sessionId,
              authority,
            )
          : true;
      },
      resolveAgentModel: async (slug, agent) => {
        if (slug !== 'default') {
          return typeof agent.model === 'string'
            ? agent.model
            : agent.model?.modelId;
        }

        const configuredProviders = context.providerService
          .listProviderConnections()
          .filter(
            (connection) =>
              connection.enabled && connection.capabilities.includes('llm'),
          );

        if (
          !context.appConfig.defaultLLMProvider &&
          configuredProviders.length === 0
        ) {
          return 'Not configured';
        }

        try {
          const { model } = await context.providerService.resolveProvider({});
          return model || 'Not configured';
        } catch {
          return 'Not configured';
        }
      },
    }),
  );
  context.app.route(
    '',
    createOtlpReceiverRoutes(
      (event) => context.monitoringEmitter.emitRaw(event),
      () => getCachedUser().alias,
    ),
  );
  context.app.route(
    '/agents',
    createConversationRoutes(
      context.memoryAdapters,
      context.logger,
      context.agentFixedTokens,
      context.agentTools,
      context.configLoader,
      context.appConfig,
      context.modelCatalog,
      context.createMemoryAdapter,
      context.orchestrationService,
      undefined,
      async (modelId) => {
        // station#2372: preserve the synchronous cached fast path, but do not
        // let cold start or cache invalidation make a known model incidental
        // "unknown". The inventory service coalesces concurrent refreshes.
        return resolveContextWindowTokensForStats(
          context.connectionService,
          modelId,
        );
      },
      conversationReadAuthorityForRequest,
      context.orchestrationService,
      (slug) =>
        resolveRuntimeAgent(slug, {
          listAgents: () => context.agentService.listAgents(),
          getDefaultAgentIds: async () =>
            new Set(
              (
                await loadOrCreateAgentRegistry(context.configLoader)
              ).defaultAgents.map((agent) => String(agent.id)),
            ),
        }),
      undefined,
      context.projectService,
      runtimeContext,
      undefined,
      actionOperations,
      createConversationIntentSummaryEvidenceCatalog({
        taskGraph: context.taskGraphService,
        sessionQueries: context.orchestrationService.sessionQueries,
      }),
      conversationReadAuthorityForContext,
    ),
  );
  // The bytes behind a transcript's attachment chips. Separate from
  // `/api/orchestration` so its one leaf reads as a bounded blob fetch rather
  // than inheriting a session-control family's surface (station#3385).
  context.app.route(
    '/api/attachments',
    createAttachmentRoutes({
      readAttachment: (ref) =>
        runtimeContext.orchestrationEventStore.readAttachmentBlob(ref),
      threadsForAttachment: (ref, request) => {
        const authority = readAuthorityForRequest(request);
        return runtimeContext.orchestrationEventStore.listAttachmentCandidateThreads(
          ref,
          isSessionReadAuthority(authority) ? authority.userId : undefined,
        );
      },
      canReadSession: (threadId, request) =>
        context.orchestrationService.canUserReadSession(
          threadId,
          readAuthorityForRequest(request),
        ),
    }),
  );
  context.app.route(
    '/api/conversations',
    createGlobalConversationRoutes(
      context.memoryAdapters,
      context.storageAdapter,
      context.logger,
      context.createMemoryAdapter,
      context.orchestrationService,
      undefined,
      new FileConversationAcknowledgementStore(
        context.configLoader.getProjectHomeDir(),
      ),
      conversationReadAuthorityForRequest,
      context.orchestrationService,
      (query, signal) =>
        searchConnectedRemoteMessages(
          context.sshEnvironmentService,
          query,
          signal,
          undefined,
          peerCredentialStore,
        ),
    ),
  );

  const {
    schedulerService,
    notificationService,
    approvalInboxProvider,
    attentionProjection,
    webPushService,
    webPushEnabled,
  } = configureRuntimeSupportServices(context, flowRunService);
  const nativeInvocationRunReader =
    runtimeContext.orchestrationEventStore.nativeInvocationRunReader();
  const voiceTurnRunReader =
    runtimeContext.orchestrationEventStore.voiceTurnRunReader();
  const runService = new RunService(
    context.orchestrationService,
    schedulerService,
    nativeInvocationRunReader,
    voiceTurnRunReader,
  );
  // This is deliberately composed only after every owner named by a
  // WorkReference is available. It receives the stored board refs and never
  // becomes a general cross-product search surface.
  if (!isHostedTenantExecutionRequired()) {
    const spatialBoardResolver = createSpatialBoardOwnerResolver({
      projects: context.projectService,
      tasks: context.taskGraphService,
      sessions: context.orchestrationService,
      sessionAuthority: readAuthorityForExecution(),
      approvals: context.approvalRegistry,
      reviews: reviewEvidence,
      flow: flowRunService,
      runs: runService,
      agents: context.agentService,
    });
    context.app.route(
      '/api/spatial-board',
      createSpatialBoardRoutes(
        new SpatialBoardStore(
          join(context.configLoader.getProjectHomeDir(), 'spatial-board.json'),
        ),
        spatialBoardResolver,
      ),
    );
  }
  // station#4079 slice 1: the board face's persisted store — pinned-widget
  // rows + tab rows keyed on the durable session/Task identity, one JSON
  // file per board under <projectHomeDir>/boards (see BoardStore's doc
  // comment for why this is per-reference rather than one shared store).
  //
  // Fix round B2: authorization composed exactly like `createAttachmentRoutes`
  // above — `canReadSession` reuses `context.orchestrationService`'s ONE
  // session-scoped gate (`canUserReadSession`) with THIS request's own
  // authority, never a second derivation. `taskExists` mirrors the sibling
  // `SpatialBoardResolver`'s task resolver (existence + projectId match,
  // `spatial-board-owner-resolver.ts`) — Tasks have no per-user ownership
  // check anywhere in this codebase today.
  context.app.route(
    '/api/board',
    createBoardRoutes(
      new BoardStore(join(context.configLoader.getProjectHomeDir(), 'boards')),
      // Delta review micro-round item 2: this composition is now extracted
      // into `createOrchestrationBoardAuthorization` (own file, own
      // wiring-smoke test) rather than an inline object literal here — see
      // that file's doc comment for why.
      createOrchestrationBoardAuthorization({
        orchestrationService: context.orchestrationService,
        taskGraphService: context.taskGraphService,
        readAuthorityForRequest,
      }),
    ),
  );
  if (createPersonalStarterRegistry) {
    const starterOwners = createStarterOwnerAdapter({
      approvals: {
        list: () =>
          notificationService.list({
            category: ['approval-request'],
          }),
        observe: (notification) => approvalInboxProvider.observe(notification),
      },
      runs: runService,
      reviews: {
        read: (receiptId, projectSlug) =>
          reviewEvidence.read(receiptId, projectSlug),
        listAll: () =>
          reviewEvidence.listAll(
            context.projectService
              .listProjects()
              .map((project) => project.slug),
          ),
      },
      authority: readAuthorityForExecution(),
    });
    context.app.route(
      '/api/starter-work',
      createStarterWorkRoutes(
        createPersonalStarterRegistry(starterOwners, {
          prepare: (operationId) =>
            schedulerService.prepareStarterManualIntent(operationId),
        }),
      ),
    );
  }
  context.app.route(
    '/events',
    createEventRoutes({
      eventBus: context.eventBus,
      getACPStatus: () => {
        const status = context.acpBridge.getStatus();
        return {
          connected: status.connections.some(
            (connection: any) => connection.status === ACPStatus.AVAILABLE,
          ),
          connections: status.connections,
        };
      },
      logger: context.logger,
      readAuthorityForRequest,
      canReadNotificationEvent: (_event, data, authority) => {
        const record = data as Record<string, unknown> | undefined;
        const sessionId = notificationSessionIdentity(record);
        return (
          sessionId !== undefined &&
          context.orchestrationService.canUserReadSession(sessionId, authority)
        );
      },
      // Registry resolution removes the pending entry before it emits its
      // terminal event. The registry therefore authorizes every lifecycle
      // frame from its immutable, session-bound metadata rather than a
      // settled-entry cache or any serialized tenant context.
      canReadApprovalEvent: (_event, data, authority) =>
        context.approvalRegistry.canReadEvent(data, authority),
      canReadAnswerAssessmentEvent: (data, authority) => {
        const sessionId = (data as { sessionId?: unknown } | undefined)
          ?.sessionId;
        return (
          typeof sessionId === 'string' &&
          context.orchestrationService.canUserReadSession(sessionId, authority)
        );
      },
      canReadAnswerNarrativeEvent: (data, authority) => {
        const sessionId = (data as { sessionId?: unknown } | undefined)
          ?.sessionId;
        return (
          typeof sessionId === 'string' &&
          context.orchestrationService.canUserReadSession(sessionId, authority)
        );
      },
      connectPairedDevice: (request) => {
        const sessionId = request.headers.get('x-station-client-session');
        if (!sessionId || !CLIENT_SESSION_ID_PATTERN.test(sessionId))
          return undefined;
        const principal = getRuntimeAuthenticatedRequestPrincipal(request);
        if (principal?.authority !== 'device-credential') return undefined;
        const device = context.environmentSecurityService.identifyDevice(
          principal.credential,
        );
        return device
          ? connectedClientPresence.connect(device.id, sessionId)
          : undefined;
      },
      isPairedDeviceConnectionCurrent: (request) => {
        const principal = getRuntimeAuthenticatedRequestPrincipal(request);
        return (
          principal?.authority !== 'device-credential' ||
          context.environmentSecurityService.identifyDevice(
            principal.credential,
          ) !== null
        );
      },
    }),
  );
  context.app.route(
    '/api/system',
    createPushRoutes({
      enabled: webPushEnabled,
      getVapidPublicKey: () => webPushService.getPublicKey(),
      identifyDevice: (credential) =>
        context.environmentSecurityService.identifyDevice(credential),
      setPushSubscription: (deviceId, subscription) =>
        context.environmentSecurityService.devicePairing.setPushSubscription(
          deviceId,
          subscription,
        ),
      clearPushSubscription: (deviceId) =>
        context.environmentSecurityService.devicePairing.clearPushSubscription(
          deviceId,
        ),
    }),
  );
  context.app.route(
    '/scheduler',
    createSchedulerRoutes(schedulerService, context.logger, {
      readAuthorityForRequest,
    }),
  );
  context.app.route(
    '/api/runs',
    createRunRoutes(runService, context.logger, readAuthorityForRequest),
  );
  context.app.route(
    '/notifications',
    createNotificationRoutes(notificationService, {
      readAuthorityForRequest,
      canReadSession: (sessionId, authority) =>
        context.orchestrationService.canUserReadSession(sessionId, authority),
    }),
  );
  context.app.route(
    '/api/attention',
    createAttentionRoutes(attentionProjection, {
      readAuthorityForRequest,
      // #765 D5: derive the device-pairing items' `viewerCanDecide` from the
      // SAME two gates the middleware applies to an approve/deny request, in
      // the same order: the pairing family's authority boundary
      // (`authorizeCredential`, via the exported predicate) and then the
      // scope table's tier for the confirm/deny leaves (read from the table
      // itself, not restated — live verification caught a device that passes
      // the boundary with `access:approve` while the table still 403s it
      // because the scope-edit promotion path cannot retain `access:manage`).
      // The attested internal principal (station-control/MCP) bypasses both
      // gates in `configureRuntimeHttp`, so it decides too; an absent
      // principal or an unmapped table entry fails closed.
      viewerMayDecidePairingRequests: (request) => {
        const principal = getRuntimeAuthenticatedRequestPrincipal(request);
        if (!principal) return false;
        if (principal.kind === 'internal') return true;
        if (
          !context.environmentSecurityService.credentialMayDecidePairingRequests(
            principal.credential,
          )
        ) {
          return false;
        }
        // Confirm and deny share the `/api/pairing` single-tier rule
        // (method-agnostic), so one representative leaf answers for both.
        const requiredScope = requiredPairingScope(
          'POST',
          '/api/pairing/requests/:requestId/confirm',
        );
        if (requiredScope === undefined) return false;
        const grantedScope =
          context.environmentSecurityService.resolveGrantedScope(
            principal.credential,
          );
        return (
          grantedScope !== undefined &&
          pairingScopeIncludes(grantedScope, requiredScope)
        );
      },
    }),
  );
  context.app.route(
    '/api/action-operations',
    createActionOperationRoutes({
      operations: actionOperations,
      actorForRequest: (request) => {
        const authority = readAuthorityForRequest(request);
        return actionOperationActorForRequest(request, authority, (sessionId) =>
          context.orchestrationService.canUserReadSession(sessionId, authority),
        );
      },
    }),
  );
  context.app.route(
    '/api/feedback',
    createFeedbackRoutes(context.feedbackService),
  );
  context.app.route(
    '/api/insights',
    // station#3130: insights reads the same directory as /monitoring/events
    // and must apply the same two authorization layers.
    createInsightsRoutes(context.eventLogPath, {
      readAuthorityForRequest,
      // The SAME central session predicate /monitoring/events composes, not a
      // second derivation of it.
      canReadMonitoringEvent: (event, authority) => {
        const sessionId = monitoringSessionIdentity(event);
        return sessionId
          ? context.orchestrationService.canUserReadSession(
              sessionId,
              authority,
            )
          : true;
      },
    }),
  );
  context.app.route('/api/voice', createVoiceRoutes(context.voiceService));

  // Route registration remains synchronous for Hono's configure callback;
  // runtime initialization still waits for the serialized Kit snapshot before
  // reporting readiness.
  const kitLifecycleReady = Promise.all([
    kitObservabilityRegistry.discoverInstalled([
      join(context.configLoader.getProjectHomeDir(), 'kits'),
      join(context.configLoader.getProjectHomeDir(), 'plugins'),
    ]),
    // A ready runtime must not race a first browser discovery against the
    // exact-once room/history/outbox startup replay.
    projectTaskRoomLifecycleReady,
  ]).then(() => undefined);

  return {
    schedulerService,
    notificationService,
    attentionProjection,
    webPushService,
    kitLifecycleReady,
    projectTaskRoomRuntime,
  };
}

/**
 * Classifies activity from directly-observed or internal-token-attested peer
 * data. Untrusted forwarded input never reaches this resolver.
 */
export function classifyRuntimePairedDeviceActivity({
  environment,
  header,
  directSocketAddress,
  attestedProxyPeerAddress,
}: RuntimeDeviceActivityClassifierContext) {
  // A tailnet class comes only from the existing, token-bound ingress identity
  // source. Direct CGNAT addresses are intentionally not enough to claim
  // tailnet provenance.
  if (
    identifyIngress({
      env: environment,
      req: { header },
    })?.provider === 'tailscale-serve'
  ) {
    return 'tailnet' as const;
  }
  return classifyDirectDeviceActivityPeer(
    attestedProxyPeerAddress ?? directSocketAddress,
  );
}

/**
 * Notification rows carry session identity in metadata, while an update or
 * dismissal event carries only the opaque notification id. Keep the runtime
 * SSE predicate on the same canonical identity vocabulary as monitoring and
 * the notification REST route, without treating an id or a count as tenant
 * authority.
 */
function notificationSessionIdentity(
  notification: unknown,
): string | undefined {
  if (!notification || typeof notification !== 'object') return undefined;
  return monitoringSessionIdentity(
    (notification as { metadata?: unknown }).metadata,
  );
}

export function configureRuntimePublicRoutes(
  app: HonoApp,
  environmentSecurityService: Pick<
    EnvironmentSecurityService,
    'getPublicHandshake' | 'createPublicProof'
  >,
): void {
  app.get(PUBLIC_STATION_HANDSHAKE_PATH, async (c) => {
    const handshake = await environmentSecurityService.getPublicHandshake();
    // Recorded from the served document rather than from the constants, so the
    // metric can never claim a contract the response did not actually carry.
    if (handshake.compatibility) {
      clientCompatHandshakes.add(1, {
        protocol_version: handshake.compatibility.protocolVersion,
        min_client_protocol: handshake.compatibility.minClientProtocol,
      });
    }
    return c.json(handshake);
  });
  const proofAttempts = new Map<string, { count: number; resetAt: number }>();
  app.post(PUBLIC_STATION_PROOF_PATH, async (c) => {
    if (new URL(c.req.url).search) {
      return c.json({ error: 'invalid_proof_request' }, 400);
    }
    const peer =
      (c.env as { incoming?: { socket?: { remoteAddress?: string } } })
        ?.incoming?.socket?.remoteAddress ?? 'absent';
    const now = Date.now();
    const attempt = proofAttempts.get(peer);
    if (attempt && attempt.resetAt > now && attempt.count >= 30) {
      return c.json({ error: 'rate_limited' }, 429);
    }
    if (!attempt || attempt.resetAt <= now) {
      if (proofAttempts.size >= 1_024)
        proofAttempts.delete(proofAttempts.keys().next().value!);
      proofAttempts.set(peer, { count: 1, resetAt: now + 60_000 });
    } else attempt.count += 1;
    const bodyResult = await readBoundedRequestBody(c.req.raw, 256);
    if (bodyResult.status === 'too-large') {
      return c.json({ error: 'proof_request_too_large' }, 413);
    }
    if (bodyResult.status !== 'ok') {
      return c.json({ error: 'invalid_proof_request' }, 400);
    }
    const raw = bodyResult.body;
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ error: 'invalid_proof_request' }, 400);
    }
    const value = body as Record<string, unknown>;
    if (
      !value ||
      typeof value !== 'object' ||
      Object.keys(value).sort().join(',') !== 'nonce,protocolVersion' ||
      value.protocolVersion !== STATION_PROOF_PROTOCOL_VERSION ||
      typeof value.nonce !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(value.nonce)
    ) {
      return c.json({ error: 'invalid_proof_request' }, 400);
    }
    return c.json(
      await environmentSecurityService.createPublicProof(value.nonce),
    );
  });
  app.get('/api/system/liveness', (c) => c.json({ live: true }));
}

function pairingSocketAddress(c: { env: unknown }): string | undefined {
  return (c.env as { incoming?: { socket?: { remoteAddress?: string } } })
    ?.incoming?.socket?.remoteAddress;
}

function pairingPeer(c: { env: unknown }): string {
  return pairingSocketAddress(c) ?? 'absent';
}

/** A Hono context as the shared security helpers' request shape. */
function runtimeCallerRequest(c: {
  env: unknown;
  req: { header: (name: string) => string | undefined };
}): RuntimeCallerRequest {
  return { environment: c.env, header: (name) => c.req.header(name) };
}

/**
 * The public UI proxy is allowed to replace its loopback hop with the source
 * it directly observed only when its request carries the per-boot internal
 * token. An untrusted forwarded header never changes the limiter key.
 */
function pairingRateLimitSource(c: {
  env: unknown;
  req: { header: (name: string) => string | undefined };
}): string {
  const attestedAddress = attestedProxyPeerAddress(runtimeCallerRequest(c));
  return attestedAddress ?? pairingPeer(c);
}

/**
 * Where a pairing requester was, as far as this host can prove
 * (station#1490) — the value `DevicePairingService.confirmRequest` weighs an
 * unauthenticated approver against.
 *
 * Two addresses can answer this, and the order matters. Station's own loopback
 * UI proxy terminates the client's connection and opens its own, so everything
 * behind it reaches this handler from 127.0.0.1: judging the direct socket
 * alone would refuse every phone that loads the UI from the UI port, which is
 * how a phone normally reaches a Station. The proxy therefore reports the
 * address it saw, and that report is worth more than the socket — but ONLY
 * when it is attested: a trusted internal token (a per-boot secret a floor
 * adversary does not have) presented from a loopback direct peer, which is the
 * same anchor `readVerifiedIngressIdentity` already uses. The proxy strips any
 * client-supplied copy of these headers before setting its own.
 *
 * Note what is deliberately NOT consulted: `classifyAttestedProxyCaller`'s
 * verdict. That function answers the auth boundary's question, where an
 * untrusted token yields `remote` because `remote` is its safe answer. Here
 * `remote` is the permissive answer, so reusing it would let anyone on the
 * floor send a junk token and be promoted to off-box. Whatever address is
 * chosen, the same predicate judges it.
 */
function pairingRequesterPosition(c: {
  env: unknown;
  req: { header: (name: string) => string | undefined };
}): PairingRequesterPosition {
  // A server-verified ingress identity is a position in its own right, not a
  // weaker substitute for one. `tailscale serve` terminates the tailnet
  // connection on this host and re-dials the UI port from loopback — which
  // `trustedTailscaleIdentity` REQUIRES — so the attested peer address for a
  // Serve request is 127.0.0.1 and always will be. Judging those requests by
  // address alone refused precisely the requests carrying the strongest
  // provenance Station has (station#1490 delta review H2). The identity is
  // unforgeable from the floor for the same reason the attested address is:
  // `readVerifiedIngressIdentity` demands the per-boot internal token from a
  // loopback direct peer, and the proxy strips every client-supplied
  // `tailscale-*` header before minting its own.
  if (identifyIngress(c)) return 'off-box';
  const directAddress = pairingSocketAddress(c);
  const attestedAddress = attestedProxyPeerAddress(runtimeCallerRequest(c));
  return isDefinitelyOffBox(attestedAddress ?? directAddress)
    ? 'off-box'
    : 'unproven';
}

function consumePairingAttempt(
  budget: BoundedAttemptBudget,
  peer: string,
  bucket:
    | 'access-request'
    | 'local-grant'
    | 'ui-bootstrap-mint'
    | 'request'
    | 'exchange',
  limit: number,
  windowMs: number,
  now = Date.now(),
): boolean {
  return budget.reserve(bucket, peer, limit, windowMs, now).kind === 'admitted';
}

/**
 * Additive-tolerant body parsing for the public pairing endpoints
 * (station#1673): a request succeeds when every `requiredKeys` entry is
 * present (the caller still type-checks each field), and fails closed on a
 * missing required key. Unknown/optional keys are never rejected — an older
 * client omitting a since-added optional field (or a newer client sending
 * one an older server predates) must not 400 on that basis alone. Callers
 * remain responsible for validating the type of every field they read.
 */
async function readPairingJson(
  request: Request,
  requiredKeys: string[],
): Promise<Record<string, unknown> | undefined> {
  const result = await readBoundedRequestBody(request, 2_048);
  if (result.status !== 'ok') return undefined;
  try {
    const value = JSON.parse(result.body);
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !requiredKeys.every((key) => Object.hasOwn(value, key))
    ) {
      return undefined;
    }
    return value as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

async function readPairingExchangeJson(
  request: Request,
): Promise<Record<string, unknown> | undefined> {
  return readPairingJson(request, ['offerId', 'proof', 'requestId']);
}

/**
 * `POST /api/pairing/offers` body: `endpoint` required, `scope` optional (R3
 * UI presets), `kind` optional (station#1123 slice 1: `'device'` |
 * `'delegation'`, defaults to `'device'` in the service).
 */
const PAIRING_OFFER_BODY_KEYSETS = new Set([
  'endpoint',
  'endpoint,kind',
  'endpoint,kind,scope',
  'endpoint,scope',
]);

async function readPairingOfferJson(
  request: Request,
): Promise<Record<string, unknown> | undefined> {
  const result = await readBoundedRequestBody(request, 2_048);
  if (result.status !== 'ok') return undefined;
  try {
    const value = JSON.parse(result.body);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }
    const keys = Object.keys(value).sort().join(',');
    if (!PAIRING_OFFER_BODY_KEYSETS.has(keys)) return undefined;
    return value as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function pairingErrorStatus(error: unknown): 400 | 403 | 404 | 409 | 410 | 429 {
  if (!(error instanceof DevicePairingError)) return 400;
  if (error.code === 'offer_capacity_reached') return 429;
  // 403, not 401: the caller may well have presented nothing, but the fix is
  // not "authenticate this same request" — an approval this request is not
  // permitted to make has to happen somewhere else (the host CLI, or a session
  // holding the operator credential), so a `WWW-Authenticate`-shaped 401 would
  // point the operator at the wrong remedy.
  if (
    error.code === 'request_denied' ||
    error.code === 'approval_requires_operator'
  ) {
    return 403;
  }
  if (error.code === 'request_not_found' || error.code === 'device_not_found') {
    return 404;
  }
  if (error.code === 'offer_expired') return 410;
  if (
    error.code === 'offer_unavailable' ||
    error.code === 'request_not_confirmed' ||
    error.code === 'device_active' ||
    // station#3816: a conflict, not a bad request — the caller's edit was
    // well-formed and lost a race, and the remedy is to re-read and redo it.
    error.code === 'scope_changed'
  ) {
    return 409;
  }
  return 400;
}

function pairingErrorCode(error: unknown): string {
  return error instanceof DevicePairingError ? error.code : 'invalid_request';
}

function applyPublicCorsHeaders(
  c: {
    req: { header: (name: string) => string | undefined };
    header: (name: string, value: string) => void;
  },
  allowedOrigins: ReadonlySet<string>,
): void {
  const origin = c.req.header('origin');
  if (origin && allowedOrigins.has(origin)) {
    c.header('Access-Control-Allow-Origin', origin);
    c.header('Vary', 'Origin');
    c.header('Access-Control-Allow-Credentials', 'true');
  }
}

/**
 * station#4518 fix round (MED-2): memoizes a per-request derivation, keyed
 * on Request object IDENTITY — the same pattern `roomRequestPrincipals`
 * above already uses to resolve the room's caller once per request rather
 * than once per `#principal()` read. A fresh `Request` per real incoming
 * HTTP call means this NEVER caches across requests (a WeakMap entry is
 * only reachable through the exact object a caller already holds); it only
 * dedupes repeated calls WITHIN the handling of one request.
 * `resolveOrchestrationRequestPrincipal` wraps this because
 * `orchestration.ts`'s `readAuthorityFor(c)` — the single fail-closed
 * resolution point 41 call sites reach through — is called MORE THAN ONCE
 * inside at least two handlers in a single request (`GET
 * .../narrative/target`, `GET .../assessment/target`), each call redoing
 * the timing-safe operator-credential comparison and the paired-device
 * registry scan (a possible fsync) that a resolution performs.
 *
 * A THROWN resolution (`PrincipalUnresolvedError`) is deliberately never
 * cached, matching `roomRequestPrincipals`' own documented policy: a
 * missing cache entry and "not yet resolved" are indistinguishable to a
 * later call, and both correctly re-run the resolver — which fails closed
 * again, at the same (bounded) cost, rather than remembering a stale
 * refusal.
 */
export function memoizePerRequest<
  TContext extends { req: { raw: Request } },
  TResult,
>(resolve: (context: TContext) => TResult): (context: TContext) => TResult {
  const cache = new WeakMap<Request, TResult>();
  return (context: TContext): TResult => {
    // LOW-A (station#4518 fix round, delta review): `cache.has()`, not an
    // `undefined` sentinel — this is an EXPORTED generic, so a future
    // resolver that legitimately RETURNS `undefined` must still be cached,
    // not silently re-run on every call.
    if (cache.has(context.req.raw)) return cache.get(context.req.raw)!;
    const result = resolve(context);
    cache.set(context.req.raw, result);
    return result;
  };
}

// Ingress identity providers, tried in order; the first that recognizes the
// request wins. Today only the tailnet-WhoIs (Tailscale Serve) source is
// registered. A future `KontourAccountIdentitySource` (validating a Kontour
// session token -> provider: 'kontour-account') is registered additively by
// appending it here — the pairing/authz boundary below consumes the
// provider-agnostic `VerifiedIdentity`, so no authz change is required.
// Exported for the local-mode-invariant regression guard
// (`src-server/services/identity/__tests__/local-mode-invariant.test.ts`),
// which asserts against the REAL source list rather than a fixture: a request
// carrying no ingress-identity credential must yield no identity, so the
// presence of this list never makes identity mandatory. See
// `docs/design/identity.md`.
export const INGRESS_IDENTITY_SOURCES: readonly IdentitySource[] = [
  new TailscaleServeIdentitySource(),
];

export function identifyIngress(c: {
  env: unknown;
  req: { header: (name: string) => string | undefined };
}): VerifiedIdentity | null {
  for (const source of INGRESS_IDENTITY_SOURCES) {
    const identity = source.identify({
      environment: c.env,
      header: (name) => c.req.header(name),
    });
    if (identity) return identity;
  }
  return null;
}

/**
 * Whether the request came from a process on THIS machine that reached this
 * server DIRECTLY on loopback — never through Station's own UI proxy, a
 * Tailscale Serve tunnel, or any other forwarded hop (station#1490/#1991).
 *
 * Three signals, all required: a loopback direct socket peer, no
 * server-verified ingress identity, and none of the proxy's own attestation
 * headers present. The socket peer alone is NOT enough — Station's UI proxy
 * terminates the client connection and re-dials the backend from 127.0.0.1,
 * so every request behind it (every `:3000` client, and any phone loading the
 * UI port) also arrives from loopback. What the proxy cannot fake is the
 * ABSENCE of its own headers: it sets `INTERNAL_API_TOKEN_HEADER` and
 * `INTERNAL_PROXY_CALLER_HEADER` on the backend connection it opens (after
 * stripping any client-supplied copies), so their absence is the positive
 * proof that no proxy is in the loop.
 *
 * The local-grant handler turns on this: a mere network position that
 * transited the proxy must never stand in for genuine direct-loopback
 * possession.
 */
function isDirectLoopbackCaller(c: {
  env: unknown;
  req: { header: (name: string) => string | undefined };
}): boolean {
  return (
    classifyRuntimePeer(pairingSocketAddress(c)).peerClass === 'loopback' &&
    identifyIngress(c) === null &&
    !c.req.header(INTERNAL_PROXY_CALLER_HEADER) &&
    !c.req.header(INTERNAL_API_TOKEN_HEADER)
  );
}

/**
 * Whether the client on the other end of this request is a browser ON THIS
 * MACHINE, as far as the host can PROVE (station#3876).
 *
 * `station start` prints `http://127.0.0.1:<uiPort>/#station-ui-bootstrap=…`,
 * so the ordinary way an operator reaches their own Station is through the UI
 * proxy. {@link isDirectLoopbackCaller} answers a narrower question — "did
 * this reach the server socket with no hop at all?" — and its answer for the
 * printed URL is `false`, which is why the operator's own browser used to mint
 * a credential with no `home-possession` stamp and every surface reading that
 * one locality fact then told them to "Run this on <hostName>" while they sat
 * at that host. This predicate does not add a second locality derivation: it
 * corrects the input to the existing one, so D6's log redaction and #3843's
 * presentation both move with it and neither needs a per-surface branch.
 *
 * THREE facts, all required, none of them settable by the browser:
 *
 *  1. No server-verified ingress identity. `tailscale serve` terminates the
 *     tailnet connection on this host and re-dials the UI port FROM loopback,
 *     so a phone's request would otherwise satisfy (2) exactly. The identity
 *     is the positive marker that it came off-box.
 *  2. The CLIENT address is loopback. Through the proxy that is the address
 *     the proxy attested seeing (the proxy strips any client-supplied copy
 *     before setting its own, and the reader accepts it only alongside the
 *     per-boot internal token from a loopback direct peer — a phone on the
 *     LAN or the tailnet therefore reports its own address and stays paired).
 *     With NO proxy in the loop it is the direct socket. Attestation headers
 *     that are PRESENT but not trusted fail closed: a junk token must never
 *     buy the direct reading of the hop standing in front of it.
 *  3. The browser addressed this machine's LOOPBACK, per the same attested
 *     `Host` (station#3752). This is what a `tailscale serve` hop cannot
 *     produce even when Station was not configured with its trusted origin
 *     and (1) is therefore silent: Serve preserves the browser's `Host`,
 *     which is the tailnet name — the fact `trustedTailscaleIdentity` in
 *     `packages/cli/src/commands/lifecycle.ts` already depends on.
 *
 * WHAT IT DOES NOT PROVE, deliberately stated rather than implied. Loopback is
 * a transport position: an SSH local forward, or any process already running
 * as this user, satisfies all three. That is unchanged from the direct-socket
 * path this widens and is why the credential it mints keeps mint kind
 * `ui-bootstrap`, which the native consent broker refuses (station#3677 PR 3)
 * — this buys presentation and log-read locality, never approval authority.
 */
function isSameMachineBrowserCaller(c: {
  env: unknown;
  req: { header: (name: string) => string | undefined };
}): boolean {
  if (identifyIngress(c) !== null) return false;
  if (classifyRuntimePeer(pairingSocketAddress(c)).peerClass !== 'loopback') {
    return false;
  }
  const request = runtimeCallerRequest(c);
  const attestedClient = attestedProxyPeerAddress(request);
  if (attestedClient === undefined) {
    // No attested Station-proxy hop, so the loopback socket above IS the
    // client and there is nothing for facts 2 and 3 to reconstruct. Only a
    // request carrying NONE of the proxy's headers reads its own socket that
    // way: attestation that is present but untrusted fails closed.
    return (
      c.req.header(INTERNAL_PROXY_CALLER_HEADER) === undefined &&
      c.req.header(INTERNAL_API_TOKEN_HEADER) === undefined
    );
  }
  return (
    classifyRuntimePeer(attestedClient).peerClass === 'loopback' &&
    isLoopbackAuthority(attestedBrowserVisibleHost(request))
  );
}

const LOCAL_GRANT_DIRECTORY_MODE = 0o700;
const LOCAL_GRANT_FILE_MODE = 0o600;

/**
 * Mints a fresh per-boot local-grant secret (station#1715) and durably writes
 * it to `secretPath` (parent directory 0700, file 0600), atomically replacing
 * any previous boot's value. The file exists only so the desktop shell —
 * running as the same OS user — can read it directly off disk
 * (`src-desktop/src/lib.rs`'s `station_local_grant_secret`); the route
 * created below never re-reads it, it compares every presented candidate
 * against the value returned here, held in a closure for the life of the
 * process.
 */
function writeLocalGrantSecretFile(secretPath: string): string {
  const secret = randomBytes(32).toString('base64url');
  mkdirSync(dirname(secretPath), {
    recursive: true,
    mode: LOCAL_GRANT_DIRECTORY_MODE,
  });
  const temporaryPath = `${secretPath}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporaryPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      LOCAL_GRANT_FILE_MODE,
    );
    if (process.platform !== 'win32') {
      fchmodSync(descriptor, LOCAL_GRANT_FILE_MODE);
    }
    writeFileSync(descriptor, secret, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, secretPath);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporaryPath, { force: true });
  }
  return secret;
}

/** Timing-safe compare over digests, so a length mismatch never short-circuits. */
function timingSafeSecretEqual(candidate: string, expected: string): boolean {
  const candidateDigest = createHash('sha256').update(candidate).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(candidateDigest, expectedDigest);
}

/**
 * What a launcher capability is FOR. Each purpose owns its own slot, so a mint
 * for one cannot invalidate an unspent capability for another (#1259).
 *
 * Closed on purpose: an open vocabulary would let a caller allocate unbounded
 * slots, and would make "which capabilities are live" unanswerable.
 */
const UI_BOOTSTRAP_PURPOSES = ['launcher', 'api-docs'] as const;
type UiBootstrapPurpose = (typeof UI_BOOTSTRAP_PURPOSES)[number];

function uiBootstrapPurposeFrom(
  value: unknown,
): UiBootstrapPurpose | undefined {
  // Absent means the original purpose, so every existing caller -- the CLI's
  // printed start link and the SPA -- keeps working unchanged.
  if (value === undefined) return 'launcher';
  return typeof value === 'string' &&
    (UI_BOOTSTRAP_PURPOSES as readonly string[]).includes(value)
    ? (value as UiBootstrapPurpose)
    : undefined;
}

export function configureDevicePairingPublicRoutes(
  app: HonoApp,
  pairing: DevicePairingService,
  options: {
    allowedOrigins?: readonly string[];
    /**
     * Same-user local self-authorization (station#1715). Present in every
     * production boot; omitted only by tests/harnesses that do not exercise
     * this route, where the local-grant route then unconditionally refuses
     * (no secret to compare against — never a silent "no auth required").
     */
    localGrant?: { secretPath: string };
    /** Exact process identity exposed only after owner-secret + loopback proof. */
    startupIdentity?: () => { instanceId: string; bootId: string } | undefined;
    /** Per-boot, launcher-issued capability for one browser UI session. */
    uiBootstrapToken?: string;
    audit?: (record: PairingApprovalAuditRecord) => void;
    authFailureAudit?: (record: PairingAuthFailureAuditRecord) => void;
    /** Required with authFailureAudit so durable evidence never stores a raw peer. */
    authFailureSourceId?: (source: string) => string;
    failureLimiter?: PairingFailureLimiter;
    now?: () => number;
    /**
     * This Station's public tailnet origin, asked of the Tailscale daemon
     * (station#3379/#3645). Consulted when the UI proxy attested the hop OR
     * when the request's Host merely looks like a tailnet authority — the
     * latter proves nothing, which is why consultation is not selection:
     * a direct request uses only the daemon-published origin whose authority
     * exactly equals its Host. A proxy-attested request has had that authority
     * rewritten to loopback, so it uses the resolver's canonical first origin.
     * Only the pairing endpoint is derived from it, and in the access-request
     * flow that value never reaches the device at all. Absent (or
     * unresolvable) leaves the previous request-derived behaviour untouched.
     */
    resolvePublicIngressOrigin?: () => Promise<readonly string[] | undefined>;
  } = {},
): void {
  if (options.authFailureAudit && !options.authFailureSourceId) {
    throw new Error(
      'Pairing authentication audit requires a keyed source pseudonymizer',
    );
  }
  const localGrantSecret = options.localGrant
    ? writeLocalGrantSecretFile(options.localGrant.secretPath)
    : undefined;
  // One slot PER PURPOSE (#1259). "Refreshing replaces the previous unspent
  // capability" is the intended rule and stays intact -- but it only makes
  // sense between mints for the SAME purpose. With a single shared slot,
  // #1118's tray minting for the API docs silently invalidated a pending
  // `station start` link, and the user saw a login URL that had stopped
  // working for no reason on screen.
  //
  // The vocabulary is closed so a caller cannot mint unbounded slots by
  // inventing purposes.
  const uiBootstrapTokens = new Map<UiBootstrapPurpose, string>();
  if (options.uiBootstrapToken)
    uiBootstrapTokens.set('launcher', options.uiBootstrapToken);
  const startupIdentity = options.startupIdentity?.();
  // This id is server-owned and stable for this launcher's lifetime. A
  // browser cannot choose a replacement domain merely by replaying a link,
  // while a preserved HttpOnly session remains the cross-restart identity.
  const uiBootstrapClientInstanceId = randomUUID();
  const failureLimiter =
    options.failureLimiter ?? new PairingFailureLimiter({ now: options.now });
  const attemptBudget = new BoundedAttemptBudget();
  const auditFailedAuthentication = (
    event: PairingAuthFailureAuditRecord['event'],
    surface: PairingAuthFailureAuditRecord['surface'],
    reason: PairingAuthFailureAuditRecord['reason'],
    source: string,
    state?: PairingFailureState,
  ) =>
    options.authFailureAudit?.({
      event,
      surface,
      reason,
      timestamp: options.now?.() ?? Date.now(),
      sourceCorrelation: options.authFailureSourceId!(source),
      failureCount: state?.failures ?? 0,
      lockExpiresAt: state?.lockedUntil ?? null,
      lockDurationMs: state
        ? Math.max(0, state.lockedUntil - (options.now?.() ?? Date.now()))
        : 0,
    });
  app.post(PUBLIC_DEVICE_PAIRING_LOCAL_GRANT_STARTUP_PROOF_PATH, async (c) => {
    if (new URL(c.req.url).search) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    // This is deliberately the same capability boundary as the local-grant
    // exchange. It is not a bearer fallback: a direct loopback caller must
    // prove possession of THIS boot's owner-only secret, and the endpoint
    // returns no credential or environment metadata.
    if (!localGrantSecret || !startupIdentity || !isDirectLoopbackCaller(c)) {
      return c.json({ error: 'local_grant_forbidden' }, 403);
    }
    const body = await readPairingJson(c.req.raw, [
      'secret',
      'instanceId',
      'bootId',
      'environmentId',
    ]);
    if (
      !body ||
      typeof body.secret !== 'string' ||
      body.secret.length === 0 ||
      typeof body.instanceId !== 'string' ||
      body.instanceId.length === 0 ||
      body.instanceId.length > 512 ||
      typeof body.bootId !== 'string' ||
      body.bootId.length === 0 ||
      body.bootId.length > 512 ||
      typeof body.environmentId !== 'string' ||
      body.environmentId.length === 0 ||
      body.environmentId.length > 512
    ) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    // Keep wrong secret, wrong identity, and wrong position indistinguishable:
    // callers learn only that the exact local proof did not hold.
    if (
      !timingSafeSecretEqual(body.secret, localGrantSecret) ||
      body.instanceId !== startupIdentity.instanceId ||
      body.bootId !== startupIdentity.bootId ||
      body.environmentId !== pairing.environmentId()
    ) {
      return c.json({ error: 'local_grant_forbidden' }, 403);
    }
    return c.json({ ready: true });
  });
  app.post(PUBLIC_DEVICE_PAIRING_LOCAL_GRANT_PATH, async (c) => {
    if (new URL(c.req.url).search) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    // Threat model (station#1715): possession of the owner-only Station home
    // is local authority already — this route only mechanizes that into a
    // normal paired-device credential rather than adding a new privilege.
    // What it defends is the boundary around that fact: the secret file
    // itself (0600, owner-only, per-boot) and the requirement that the
    // caller reach this exact process directly on loopback — never through
    // Station's own UI proxy, a Tailscale Serve tunnel, or any other
    // forwarded hop, each of which would let a network position stand in for
    // filesystem possession. It deliberately adds nothing against a same-user
    // malicious process: that adversary already has arbitrary access to
    // everything this grants.
    if (!localGrantSecret) {
      devicePairingRequests.add(1, {
        source: 'same-origin',
        outcome: 'denied',
      });
      return c.json({ error: 'local_grant_forbidden' }, 403);
    }
    if (!isDirectLoopbackCaller(c)) {
      devicePairingRequests.add(1, {
        source: 'same-origin',
        outcome: 'denied',
      });
      return c.json({ error: 'local_grant_forbidden' }, 403);
    }
    if (
      !consumePairingAttempt(
        attemptBudget,
        pairingPeer(c),
        'local-grant',
        5,
        60_000,
      )
    ) {
      return c.json({ error: 'rate_limited' }, 429);
    }
    const body = await readPairingJson(c.req.raw, ['secret', 'deviceName']);
    if (
      !body ||
      typeof body.secret !== 'string' ||
      body.secret.length === 0 ||
      typeof body.deviceName !== 'string' ||
      body.deviceName.length === 0 ||
      (body.clientInstanceId !== undefined &&
        typeof body.clientInstanceId !== 'string')
    ) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    // Same refusal code as the loopback-position check above — a caller must
    // not be able to distinguish "wrong network position" from "wrong
    // secret" from the response.
    if (!timingSafeSecretEqual(body.secret, localGrantSecret)) {
      devicePairingRequests.add(1, {
        source: 'same-origin',
        outcome: 'denied',
      });
      return c.json({ error: 'local_grant_forbidden' }, 403);
    }
    try {
      const offer = pairing.createOffer({
        endpoint: new URL(c.req.url).origin,
      });
      const request = pairing.requestPairing({
        offerId: offer.offerId,
        proof: offer.challenge,
        deviceName: body.deviceName,
        clientInstanceId: body.clientInstanceId as string | undefined,
        source: 'same-origin',
        // Not 'off-box': this request never left the machine. `local-grant`
        // approval below does not consult this value at all (see
        // `PairingApproval`'s doc) — it is recorded honestly rather than
        // spoofed to fit the unauthenticated-approval path.
        requesterPosition: 'unproven',
      });
      const approval: PairingApproval = { kind: 'local-grant' };
      pairing.confirmRequest(request.requestId, approval);
      options.audit?.({
        event: 'station.pairing.approved',
        approver: 'local-grant',
        source: request.source,
        timestamp: Date.now(),
      });
      const { replacement, ...result } = pairing.exchange({
        offerId: offer.offerId,
        proof: offer.challenge,
        requestId: request.requestId,
        clientInstanceId: body.clientInstanceId as string | undefined,
        locality: 'home-possession',
        // The one mint path that proves the caller read the owner-only
        // per-boot secret FILE — the discriminator the native consent
        // broker requires (station#3677 PR 3).
        mintKind: 'local-grant',
      });
      deviceSessionExchanges.add(1, { outcome: 'issued', replacement });
      return c.json(result, 200);
    } catch (error) {
      devicePairingRequests.add(1, {
        source: 'same-origin',
        outcome: 'denied',
      });
      return c.json(
        { error: pairingErrorCode(error) },
        pairingErrorStatus(error),
      );
    }
  });
  // Station's own launcher for the framework-served API docs (#934). Serves
  // static HTML and no credential; the single-use capability arrives in the
  // fragment, which never reaches this server. Direct loopback only: the sole
  // caller is the local tray opening the local browser, so there is no reason
  // to expose it to a peer that can reach the listener.
  app.get(PUBLIC_DEVICE_PAIRING_API_DOCS_LAUNCH_PATH, (c) => {
    if (new URL(c.req.url).search) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    if (!isDirectLoopbackCaller(c)) {
      return c.json({ error: 'local_grant_forbidden' }, 403);
    }
    return c.body(renderApiDocsLaunchPage(), 200, API_DOCS_LAUNCH_HEADERS);
  });
  app.post(PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_MINT_PATH, async (c) => {
    if (new URL(c.req.url).search) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    if (!localGrantSecret || !isDirectLoopbackCaller(c)) {
      devicePairingRequests.add(1, {
        source: 'same-origin',
        outcome: 'denied',
      });
      return c.json({ error: 'local_grant_forbidden' }, 403);
    }
    if (
      !consumePairingAttempt(
        attemptBudget,
        pairingPeer(c),
        'ui-bootstrap-mint',
        5,
        60_000,
      )
    ) {
      return c.json({ error: 'rate_limited' }, 429);
    }
    const body = await readPairingJson(c.req.raw, ['secret']);
    if (!body || typeof body.secret !== 'string' || body.secret.length === 0) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    // Match local-grant's indistinguishable refusal for the same two proofs.
    if (!timingSafeSecretEqual(body.secret, localGrantSecret)) {
      devicePairingRequests.add(1, {
        source: 'same-origin',
        outcome: 'denied',
      });
      return c.json({ error: 'local_grant_forbidden' }, 403);
    }
    // There is one server-held capability. Refreshing it deliberately makes a
    // previously copied but unspent launcher fragment unusable.
    const purpose = uiBootstrapPurposeFrom(body.purpose);
    if (!purpose) return c.json({ error: 'invalid_request' }, 400);
    const minted = randomBytes(32).toString('base64url');
    uiBootstrapTokens.set(purpose, minted);
    return c.json(
      {
        token: minted,
        path: PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_PATH,
      },
      200,
    );
  });
  app.post(PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_PATH, async (c) => {
    if (new URL(c.req.url).search) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    const body = await readPairingJson(c.req.raw, ['token']);
    if (
      !body ||
      typeof body.token !== 'string' ||
      body.token.length === 0 ||
      !isTrustedBrowserPairingOrigin(c.req.raw, options.allowedOrigins ?? [])
    ) {
      return c.json({ error: 'ui_bootstrap_forbidden' }, 403);
    }

    // Every populated slot is compared, with no early exit on a match, so which
    // purpose a presented capability belongs to is not observable from timing.
    // (Empty slots are skipped, so slot OCCUPANCY is — that was already true of
    // the single slot, and occupancy carries nothing about the token bytes.)
    let matchedPurpose: UiBootstrapPurpose | undefined;
    for (const candidate of UI_BOOTSTRAP_PURPOSES) {
      const stored = uiBootstrapTokens.get(candidate);
      if (stored && timingSafeSecretEqual(body.token, stored))
        matchedPurpose = candidate;
    }

    // A preserved HttpOnly session is already the strongest evidence this
    // browser can present, so return it rather than minting a second
    // identityless credential — repeated start links stay idempotent. But a
    // capability that was PRESENTED is spent regardless (#1283): it has been
    // in a browser, and the holder loses nothing they still needed. Leaving it
    // live was the common outcome of the tray's docs launch (#1259), since the
    // default browser usually already holds a session.
    const existingCredential = parseDeviceSessionCookie(c.req.header('cookie'));
    const existingDevice = existingCredential
      ? pairing.identifyDevice(existingCredential)
      : null;
    if (existingDevice) {
      if (matchedPurpose) uiBootstrapTokens.delete(matchedPurpose);
      return c.json({
        environmentId: pairing.environmentId(),
        device: existingDevice,
        delivery: DEVICE_PAIRING_BROWSER_COOKIE_DELIVERY,
      });
    }
    if (!matchedPurpose) {
      return c.json({ error: 'ui_bootstrap_forbidden' }, 403);
    }

    let bootstrapOfferId: string | undefined;
    try {
      const offer = pairing.createOffer({
        endpoint: new URL(c.req.url).origin,
      });
      bootstrapOfferId = offer.offerId;
      const request = pairing.requestPairing({
        offerId: offer.offerId,
        proof: offer.challenge,
        deviceName: 'Station local UI',
        clientInstanceId: uiBootstrapClientInstanceId,
        source: 'same-origin',
        requesterPosition: 'unproven',
      });
      pairing.confirmRequest(request.requestId, { kind: 'ui-bootstrap' });
      const { replacement, ...result } = pairing.exchange({
        offerId: offer.offerId,
        proof: offer.challenge,
        requestId: request.requestId,
        clientInstanceId: uiBootstrapClientInstanceId,
        // Bind locality at mint. The launcher token was printed on this
        // machine's terminal and `isSameMachineBrowserCaller` proves the
        // browser presenting it is on this machine too — whether it reached
        // the server socket directly or through Station's own UI proxy, which
        // is what the printed `http://127.0.0.1:<uiPort>/#…` URL does
        // (station#3876). A phone through that same proxy, a Serve hop, and
        // an unattested header all still mint a session that is not the local
        // operator.
        ...(isSameMachineBrowserCaller(c)
          ? {
              locality: 'home-possession',
              // Same possession proof, DIFFERENT custody: this credential is
              // handed to browser JS on the host, so it must never satisfy
              // the native broker's local-grant requirement (station#3677
              // PR 3 — same-origin plugin code runs where this token lives).
              mintKind: 'ui-bootstrap',
            }
          : {}),
      });
      // Keep a valid capability retryable when the exchange refuses (for
      // example, while the bounded identityless quota is full). This runs
      // only after durable issuance/replacement succeeds.
      // Only the capability that was actually spent. Clearing the map would
      // reintroduce #1259 at the redemption boundary instead of the mint one.
      uiBootstrapTokens.delete(matchedPurpose);
      options.audit?.({
        event: 'station.pairing.approved',
        approver: 'ui-bootstrap',
        source: request.source,
        timestamp: Date.now(),
      });
      deviceSessionExchanges.add(1, { outcome: 'issued', replacement });
      const origin = new URL(c.req.header('origin')!);
      setCookie(
        c,
        origin.protocol === 'https:'
          ? SECURE_DEVICE_SESSION_COOKIE
          : LOOPBACK_DEVICE_SESSION_COOKIE,
        result.credential,
        {
          httpOnly: true,
          maxAge: 365 * 24 * 60 * 60,
          path: '/',
          sameSite: 'Strict',
          secure: origin.protocol === 'https:',
        },
      );
      return c.json({
        environmentId: result.environmentId,
        device: result.device,
        delivery: DEVICE_PAIRING_BROWSER_COOKIE_DELIVERY,
      });
    } catch (error) {
      // A refused exchange leaves a confirmed bootstrap request behind. It is
      // never useful without the launcher-owned offer, so cancel it before
      // returning: repeated quota retries must not consume offer capacity.
      if (bootstrapOfferId) pairing.discardOffer(bootstrapOfferId);
      return c.json(
        { error: pairingErrorCode(error) },
        pairingErrorStatus(error),
      );
    }
  });
  app.post(PUBLIC_DEVICE_PAIRING_ACCESS_REQUEST_PATH, async (c) => {
    if (new URL(c.req.url).search) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    const ingressIdentity = identifyIngress(c);
    const requestSource = ingressIdentity ? 'tailnet' : 'same-origin';
    if (
      !isTrustedBrowserPairingOrigin(c.req.raw, options.allowedOrigins ?? [])
    ) {
      devicePairingRequests.add(1, {
        source: requestSource,
        outcome: 'denied',
      });
      return c.json({ error: 'origin_forbidden' }, 403);
    }
    if (
      !consumePairingAttempt(
        attemptBudget,
        pairingPeer(c),
        'access-request',
        5,
        60_000,
      )
    ) {
      devicePairingRequests.add(1, {
        source: requestSource,
        outcome: 'rate-limited',
      });
      return c.json({ error: 'rate_limited' }, 429);
    }
    const body = await readPairingJson(c.req.raw, ['deviceName']);
    if (
      !body ||
      typeof body.deviceName !== 'string' ||
      (body.clientInstanceId !== undefined &&
        typeof body.clientInstanceId !== 'string')
    ) {
      devicePairingRequests.add(1, {
        source: requestSource,
        outcome: 'denied',
      });
      return c.json({ error: 'invalid_request' }, 400);
    }
    try {
      // The pairing endpoint is the Station address the requester actually
      // reached us at — not the client's Origin, which for a native webview is
      // its own internal origin (e.g. http://tauri.localhost) rather than a
      // Station host. Same value as Origin in the same-origin browser case.
      // Behind `tailscale serve` the request URL cannot supply this. TLS
      // terminates in the daemon, so the API sees plain HTTP with either the
      // tailnet Host — which `createOffer` rejects, since a public host on
      // http is neither https nor private — or, through Station's own UI
      // proxy, `127.0.0.1`, which no device can reach. Both are wrong, and
      // the first is why a tailnet access request failed outright.
      //
      // Ask the daemon instead, and only for a request that already proved
      // it came through that ingress (`ingressIdentity` is the proxy's
      // attestation, verified against the per-boot internal token). Forwarded
      // headers are deliberately not consulted: anything able to reach this
      // API directly can set them, and this value decides where a credential
      // is later presented.
      const requestUrl = new URL(c.req.url);
      // Two ways a request can prove it arrived over this Station's own
      // tailnet ingress, because there are two shipping topologies:
      //
      //   serve -> Station's UI proxy   the proxy attests (`ingressIdentity`)
      //                                 but rewrites Host to 127.0.0.1
      //   serve -> this server directly no attestation exists, but Host is
      //                                 the tailnet authority serve published
      //
      // The second is why a channel app (stable/beta/nightly), which embeds
      // its server with no UI proxy in front, could not pair over the tailnet
      // at all (station#3645).
      //
      // Matching on Host is safe here specifically because the value being
      // chosen is always THIS node's own daemon-published origin. A forged
      // Host cannot redirect a credential somewhere else; it can only select
      // between addresses we already own, and only when the daemon confirms
      // it serves one of our ports. It is not a general-purpose reason to
      // trust Host.
      const mayBeOwnIngress =
        ingressIdentity !== null || requestUrl.hostname.endsWith('.ts.net');
      const resolvedIngressOrigins = mayBeOwnIngress
        ? await options.resolvePublicIngressOrigin?.()
        : undefined;
      // A direct Serve hop retains the public Host. Select only the exact
      // daemon-validated listener that accepted it; a configured second
      // listener must not be shadowed by the canonical default. The UI proxy
      // necessarily rewrites Host to loopback, so its ingress identity is the
      // proof of topology and the resolver's deterministic first origin is
      // the only safe selection rule. Forwarded headers remain untrusted.
      const directIngressOrigin = resolvedIngressOrigins?.find(
        (origin) => requestUrl.host === new URL(origin).host,
      );
      const requestOrigin = ingressIdentity
        ? (resolvedIngressOrigins?.[0] ?? requestUrl.origin)
        : (directIngressOrigin ?? requestUrl.origin);
      const accessInput = {
        endpoint: requestOrigin,
        deviceName: body.deviceName,
        clientInstanceId: body.clientInstanceId as string | undefined,
        requesterPosition: pairingRequesterPosition(c),
      };
      const result = ingressIdentity
        ? pairing.requestAccess({
            ...accessInput,
            source: 'tailnet',
            // Adapt the provider-agnostic VerifiedIdentity back to the pairing
            // boundary's TailscaleServeRequester shape (subject -> login). The
            // pairing service's requester contract is unchanged.
            requester: {
              provider: 'tailscale-serve',
              login: ingressIdentity.subject,
              ...(ingressIdentity.displayName !== undefined
                ? { displayName: ingressIdentity.displayName }
                : {}),
            },
          })
        : pairing.requestAccess(accessInput);
      devicePairingRequests.add(1, {
        source: requestSource,
        outcome: 'requested',
      });
      return c.json(result, 202);
    } catch (error) {
      devicePairingRequests.add(1, {
        source: requestSource,
        outcome:
          error instanceof DevicePairingError &&
          error.code === 'offer_capacity_reached'
            ? 'rate-limited'
            : 'denied',
      });
      return c.json(
        { error: pairingErrorCode(error) },
        pairingErrorStatus(error),
      );
    }
  });

  app.post(PUBLIC_DEVICE_PAIRING_REQUEST_PATH, async (c) => {
    if (new URL(c.req.url).search) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    const source = pairingRateLimitSource(c);
    if (
      !consumePairingAttempt(
        attemptBudget,
        source,
        'request',
        10,
        60_000,
        options.now?.(),
      )
    ) {
      auditFailedAuthentication(
        'station.pairing.authentication_rate_limited',
        'pairing-request',
        'rate_limited',
        source,
      );
      return c.json({ error: 'rate_limited' }, 429);
    }
    const admission = failureLimiter.admit('pairing-request', source);
    if (admission.kind === 'rate-limited') {
      auditFailedAuthentication(
        'station.pairing.authentication_rate_limited',
        'pairing-request',
        'rate_limited',
        source,
        admission.state,
      );
      c.header('Retry-After', String(admission.retryAfterSeconds));
      return c.json({ error: 'rate_limited' }, 429);
    }
    const body = await readPairingJson(c.req.raw, [
      'deviceName',
      'offerId',
      'proof',
    ]);
    if (
      !body ||
      typeof body.deviceName !== 'string' ||
      typeof body.offerId !== 'string' ||
      typeof body.proof !== 'string' ||
      (body.clientInstanceId !== undefined &&
        typeof body.clientInstanceId !== 'string')
    ) {
      const state = failureLimiter.finalize(admission.admission, 'failure');
      auditFailedAuthentication(
        'station.pairing.authentication_failed',
        'pairing-request',
        'invalid_request',
        source,
        state,
      );
      return c.json({ error: 'invalid_request' }, 400);
    }
    try {
      const request = pairing.requestPairing({
        deviceName: body.deviceName,
        offerId: body.offerId,
        proof: body.proof,
        clientInstanceId: body.clientInstanceId as string | undefined,
        source: 'pairing-code',
        requesterPosition: pairingRequesterPosition(c),
      });
      devicePairingRequests.add(1, {
        source: request.source,
        outcome: 'requested',
      });
      failureLimiter.finalize(admission.admission, 'success');
      return c.json(request, 202);
    } catch (error) {
      if (isPairingAuthenticationFailure(error)) {
        const reason = pairingErrorCode(error) as
          | 'invalid_offer'
          | 'invalid_request';
        const state = failureLimiter.finalize(admission.admission, 'failure');
        auditFailedAuthentication(
          'station.pairing.authentication_failed',
          'pairing-request',
          reason,
          source,
          state,
        );
      } else {
        failureLimiter.finalize(admission.admission, 'pending');
      }
      return c.json(
        { error: pairingErrorCode(error) },
        pairingErrorStatus(error),
      );
    }
  });

  app.post(PUBLIC_DEVICE_PAIRING_EXCHANGE_PATH, async (c) => {
    if (new URL(c.req.url).search) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    const source = pairingRateLimitSource(c);
    if (
      !consumePairingAttempt(
        attemptBudget,
        source,
        'exchange',
        90,
        5 * 60_000,
        options.now?.(),
      )
    ) {
      auditFailedAuthentication(
        'station.pairing.authentication_rate_limited',
        'credential-exchange',
        'rate_limited',
        source,
      );
      return c.json({ error: 'rate_limited' }, 429);
    }
    const admission = failureLimiter.admit('credential-exchange', source);
    if (admission.kind === 'rate-limited') {
      auditFailedAuthentication(
        'station.pairing.authentication_rate_limited',
        'credential-exchange',
        'rate_limited',
        source,
        admission.state,
      );
      c.header('Retry-After', String(admission.retryAfterSeconds));
      return c.json({ error: 'rate_limited' }, 429);
    }
    const body = await readPairingExchangeJson(c.req.raw);
    const browserCookieDelivery =
      body?.delivery === DEVICE_PAIRING_BROWSER_COOKIE_DELIVERY;
    if (
      !body ||
      typeof body.offerId !== 'string' ||
      typeof body.proof !== 'string' ||
      typeof body.requestId !== 'string' ||
      (body.clientInstanceId !== undefined &&
        typeof body.clientInstanceId !== 'string') ||
      (body.delivery !== undefined && !browserCookieDelivery)
    ) {
      const state = failureLimiter.finalize(admission.admission, 'failure');
      auditFailedAuthentication(
        'station.pairing.authentication_failed',
        'credential-exchange',
        'invalid_request',
        source,
        state,
      );
      return c.json({ error: 'invalid_request' }, 400);
    }
    if (
      browserCookieDelivery &&
      !isTrustedBrowserPairingOrigin(c.req.raw, options.allowedOrigins ?? [])
    ) {
      deviceSessionExchanges.add(1, {
        outcome: 'denied',
        reason: 'origin_forbidden',
      });
      failureLimiter.finalize(admission.admission, 'pending');
      return c.json({ error: 'origin_forbidden' }, 403);
    }
    try {
      const { replacement, ...result } = pairing.exchange({
        offerId: body.offerId,
        proof: body.proof,
        requestId: body.requestId,
        clientInstanceId: body.clientInstanceId as string | undefined,
      });
      deviceSessionExchanges.add(1, {
        outcome: 'issued',
        replacement,
      });
      failureLimiter.finalize(admission.admission, 'success');
      if (!browserCookieDelivery) return c.json(result);

      const origin = new URL(c.req.header('origin')!);
      setCookie(
        c,
        origin.protocol === 'https:'
          ? SECURE_DEVICE_SESSION_COOKIE
          : LOOPBACK_DEVICE_SESSION_COOKIE,
        result.credential,
        {
          httpOnly: true,
          maxAge: 365 * 24 * 60 * 60,
          path: '/',
          sameSite: 'Strict',
          secure: origin.protocol === 'https:',
        },
      );
      return c.json({
        environmentId: result.environmentId,
        device: result.device,
        delivery: DEVICE_PAIRING_BROWSER_COOKIE_DELIVERY,
      });
    } catch (error) {
      if (isPairingAuthenticationFailure(error)) {
        const reason = pairingErrorCode(error) as
          | 'invalid_offer'
          | 'invalid_request';
        const state = failureLimiter.finalize(admission.admission, 'failure');
        auditFailedAuthentication(
          'station.pairing.authentication_failed',
          'credential-exchange',
          reason,
          source,
          state,
        );
      } else {
        failureLimiter.finalize(admission.admission, 'pending');
      }
      if (browserCookieDelivery) {
        deviceSessionExchanges.add(1, {
          outcome: 'denied',
          reason: pairingErrorCode(error),
        });
      }
      return c.json(
        { error: pairingErrorCode(error) },
        pairingErrorStatus(error),
      );
    }
  });
}

/**
 * Origins that only a native Station shell can present. A web page cannot set
 * `Origin` to any of these — the browser controls that header — so seeing one
 * is itself evidence the caller is the packaged app rather than a site.
 */
function isTrustedBrowserPairingOrigin(
  request: Request,
  allowedOrigins: readonly string[],
): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  // A native shell reaching a REMOTE Station is inherently cross-site and its
  // origin is the packaged app's own (tauri.localhost), so it satisfies neither
  // the allow-list nor the same-origin check below. It was therefore always
  // refused — making "Request access" impossible from the desktop and mobile
  // apps, the one flow that exists precisely for pairing to a remote host.
  //
  // The guard's security property is that a browser controls `Origin`, so a
  // hostile site cannot pose as an allow-listed one. That still holds: no web
  // page can present a tauri origin. Only the packaged app can, and the
  // operator still approves every request out of band.
  if (isStationNativeShellOrigin(origin)) return true;
  // Trust the origin when it's explicitly allow-listed, OR when it equals the
  // address the requester actually reached us at (the request's own host
  // authority). The latter lets a direct-IP client — a CLI, or a browser/native
  // app served from a raw LAN/tailnet host the server binds via 0.0.0.0 and so
  // can't self-enumerate into the allowlist — pair without weakening browser
  // security: a browser cannot forge the Origin header, and a cross-site
  // request carries a foreign Origin plus sec-fetch-site: cross-site (rejected
  // below). The operator still approves every request out of band.
  let requestOrigin: string | null = null;
  try {
    requestOrigin = new URL(request.url).origin;
  } catch {
    requestOrigin = null;
  }
  if (!allowedOrigins.includes(origin) && origin !== requestOrigin) {
    return false;
  }
  const fetchSite = request.headers.get('sec-fetch-site');
  // A native shell reaching a REMOTE Station is inherently cross-site: its page
  // origin is the packaged app's own (tauri.localhost), never the Station's. It
  // therefore always sent sec-fetch-site: cross-site and was always refused,
  // which made "Request access" impossible from the desktop and mobile apps —
  // the one flow that exists precisely for pairing to a remote host.
  //
  // The guard's security property is that a browser cannot forge `Origin`, so a
  // hostile site cannot pose as an allow-listed one. That still holds here: no
  // web page can present a tauri.localhost origin. Relaxing sec-fetch-site for
  // exactly those origins restores the native flow without letting any site in,
  // and the operator still approves every request out of band.
  return fetchSite === null || fetchSite === 'same-origin';
}

/**
 * Approval-time audit record (station#1490). Deliberately carries only the
 * request's own coarse provenance and who approved it — no device name, no id,
 * no address — the same privacy rule `station.device_pairing.requests` states.
 */
export interface PairingApprovalAuditRecord {
  /**
   * Grant and refusal are separate event names, not one name plus an
   * `outcome` field: this is a security log, and a reader grepping the event
   * name for approvals must not also be handed every refusal (station#1490
   * delta review L2).
   */
  readonly event: 'station.pairing.approved' | 'station.pairing.refused';
  readonly approver: PairingApproval['kind'];
  readonly source: DevicePairingRequest['source'];
  readonly timestamp: number;
}

/**
 * Durable, secret-safe public pairing failure evidence. The raw source is
 * intentionally absent: it is used only as an in-memory limiter key, never
 * promoted into logs or metrics.
 */
export interface PairingAuthFailureAuditRecord {
  readonly event:
    | 'station.pairing.authentication_failed'
    | 'station.pairing.authentication_rate_limited';
  readonly surface: 'pairing-request' | 'credential-exchange';
  readonly reason: 'invalid_offer' | 'invalid_request' | 'rate_limited';
  readonly timestamp: number;
  /** HMAC pseudonym, stable for this Station and never the raw peer address. */
  readonly sourceCorrelation: string;
  readonly failureCount: number;
  /** Null when an admission/budget refusal did not create a timed lock. */
  readonly lockExpiresAt: number | null;
  readonly lockDurationMs: number;
}

function isPairingAuthenticationFailure(error: unknown): boolean {
  return (
    error instanceof DevicePairingError &&
    (error.code === 'invalid_offer' || error.code === 'invalid_request')
  );
}

export function configureDevicePairingHostRoutes(
  app: HonoApp,
  pairing: DevicePairingService,
  options: {
    audit?: (record: PairingApprovalAuditRecord) => void;
    connectedClientPresence?: ClientConnectionPresence;
    /** Hosted tenants cannot safely share this process-local aggregate. */
    clientPresenceAvailable?: boolean;
  } = {},
): void {
  const audit = options.audit;
  app.post('/api/pairing/offers', async (c) => {
    const body = await readPairingOfferJson(c.req.raw);
    if (!body || typeof body.endpoint !== 'string') {
      return c.json({ error: 'invalid_request' }, 400);
    }
    if (body.scope !== undefined && typeof body.scope !== 'string') {
      return c.json({ error: 'invalid_request' }, 400);
    }
    if (
      body.kind !== undefined &&
      body.kind !== 'device' &&
      body.kind !== 'delegation'
    ) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    try {
      return c.json(
        pairing.createOffer({
          endpoint: body.endpoint,
          scope: body.scope as string | undefined,
          kind: body.kind as 'device' | 'delegation' | undefined,
        }),
        201,
      );
    } catch (error) {
      return c.json(
        { error: pairingErrorCode(error) },
        pairingErrorStatus(error),
      );
    }
  });
  app.delete('/api/pairing/offers/:offerId', (c) => {
    try {
      pairing.cancelOffer(c.req.param('offerId'));
      return c.body(null, 204);
    } catch (error) {
      return c.json(
        { error: pairingErrorCode(error) },
        pairingErrorStatus(error),
      );
    }
  });
  app.get('/api/pairing/requests', (c) =>
    c.json({ requests: pairing.listRequests() }),
  );
  app.post('/api/pairing/requests/:requestId/confirm', (c) => {
    const requestId = c.req.param('requestId');
    // station#1490: the ONLY caller-identity signal this handler has. The
    // granted-scope var is published by `runtime-http.ts` exclusively on the
    // branch where a presented credential was verified AND satisfied the
    // route's tier. Absence therefore means the request passed only through
    // Station's exact internal-token attestation; it is never a bare
    // loopback/SSH request, which runtime authentication rejects first.
    // `DevicePairingService.confirmRequest` retains the downstream
    // classification for this internal path.
    const approval: PairingApproval =
      grantedPairingScope(c as unknown as PairingScopeContextStore) ===
      undefined
        ? { kind: 'unauthenticated' }
        : { kind: 'presented-credential' };
    try {
      const request = pairing.confirmRequest(requestId, approval);
      devicePairingRequests.add(1, {
        source: request.source,
        outcome: 'approved',
        approver: approval.kind,
      });
      // station#1490: a known-open class stays open here (see the threat
      // model's residue), so detection is the compensating control. An
      // approval granted to a caller that presented nothing is the event worth
      // reading — it is both the ordinary first-run journey and the shape of
      // the remaining conversion, and nothing else in the log distinguishes
      // them. Emitted at the same volume as an authentication denial, and
      // carrying no device or network identity, matching the counter's rule.
      if (approval.kind === 'unauthenticated') {
        audit?.({
          event: 'station.pairing.approved',
          approver: 'unauthenticated',
          source: request.source,
          timestamp: Date.now(),
        });
      }
      return c.json(request);
    } catch (error) {
      if (
        error instanceof DevicePairingError &&
        error.code === 'approval_requires_operator'
      ) {
        // Read the source back for the metric rather than defaulting it: a
        // refused approval that cannot be attributed to a real pending request
        // should not manufacture a label for one.
        const source = pairing
          .listRequests()
          .find((candidate) => candidate.requestId === requestId)?.source;
        if (source) {
          devicePairingRequests.add(1, {
            source,
            outcome: 'approval-refused',
            approver: approval.kind,
          });
          audit?.({
            event: 'station.pairing.refused',
            approver: approval.kind,
            source,
            timestamp: Date.now(),
          });
        }
      }
      return c.json(
        { error: pairingErrorCode(error) },
        pairingErrorStatus(error),
      );
    }
  });
  app.delete('/api/pairing/requests/:requestId', (c) => {
    try {
      const request = pairing.denyRequest(c.req.param('requestId'));
      devicePairingRequests.add(1, {
        source: request.source,
        outcome: 'denied',
      });
      return c.json(request);
    } catch (error) {
      return c.json(
        { error: pairingErrorCode(error) },
        pairingErrorStatus(error),
      );
    }
  });
  app.get('/api/pairing/devices', (c) => {
    const devices = pairing.listDevices();
    const connected = options.connectedClientPresence?.snapshot(
      devices
        .filter((device) => device.revokedAt === null)
        .map((device) => device.id),
    );
    return c.json({
      devices: devices.map((device) => ({
        ...device,
        connectedClients: connected?.get(device.id) ?? null,
      })),
    });
  });
  app.get('/api/client-presence/summary', (c) => {
    if (options.clientPresenceAvailable === false)
      return c.json({ error: 'unavailable' }, 404);
    const devices = pairing
      .listDevices()
      .filter((device) => device.revokedAt === null);
    const connected = options.connectedClientPresence?.snapshot(
      devices.map((device) => device.id),
    );
    const connectedClients = [...(connected?.values() ?? [])].reduce(
      (total, value) => total + value.sessionCount,
      0,
    );
    return c.json({
      connectedClients,
      connectedDevices: connected?.size ?? 0,
      observedAt: Date.now(),
    });
  });
  app.delete('/api/pairing/devices/:deviceId', (c) => {
    try {
      const authority = (c as unknown as { get: (key: string) => unknown }).get(
        RUNTIME_CREDENTIAL_AUTHORITY_VAR,
      );
      if (authority !== 'operator-credential') {
        return c.json({ error: 'authentication_required' }, 401);
      }
      const deviceId = c.req.param('deviceId');
      const device = pairing.revokeDevice(deviceId, authority);
      options.connectedClientPresence?.disconnectDevice(deviceId);
      return c.json(device);
    } catch (error) {
      return c.json(
        { error: pairingErrorCode(error) },
        pairingErrorStatus(error),
      );
    }
  });
  /**
   * Change a paired device's access (station#3816).
   *
   * Operator-only, exactly like revoking — the same authority check, because
   * this is the same class of decision: what a device may do on this
   * Station. Until now the only available answer was "nothing", so narrowing
   * a device meant unpairing and re-pairing it, losing its identity and
   * history; and `operator-promotion`, the grant path the contracts declare
   * for `access:approve` and `consent:decide`, had no mechanism at all.
   */
  app.post('/api/pairing/devices/:deviceId/scope', async (c) => {
    try {
      const authority = (c as unknown as { get: (key: string) => unknown }).get(
        RUNTIME_CREDENTIAL_AUTHORITY_VAR,
      );
      if (authority !== 'operator-credential') {
        return c.json({ error: 'authentication_required' }, 401);
      }
      const body = (await c.req.json().catch(() => null)) as {
        scope?: unknown;
        expectedScope?: unknown;
      } | null;
      const scope = Array.isArray(body?.scope) ? body.scope : null;
      if (scope === null || scope.some((token) => typeof token !== 'string')) {
        return c.json({ error: 'invalid_scope' }, 400);
      }
      // Optional: when the client sends what it believed the scope was, the
      // write becomes conditional and a racing operator's change is not
      // silently reverted.
      const expectedScope =
        typeof body?.expectedScope === 'string'
          ? body.expectedScope
          : undefined;
      const deviceId = c.req.param('deviceId');
      const device = pairing.setDeviceScope(
        deviceId,
        scope as PairingScope[],
        // The operator credential IS the approval here; the service still
        // checks the approval shape so no caller can reach it another way.
        { kind: 'presented-credential' },
        expectedScope,
      );
      // station#3816 (review HIGH): HTTP re-reads scope per request, but
      // terminal and voice authenticate ONCE at the handshake and never
      // again — so a device demoted to Read-only kept writing on a terminal
      // socket it had already opened, and could open new PTYs on it, until
      // it disconnected or Station restarted. That is precisely the
      // "demoted device keeps operating" failure this surface exists to
      // prevent. Dropping its leases forces every live connection to
      // re-authenticate, where the new scope applies. Revoke already does
      // exactly this; a scope change is the same kind of decision.
      options.connectedClientPresence?.disconnectDevice(deviceId);
      return c.json(device);
    } catch (error) {
      const code = pairingErrorCode(error);
      return c.json(
        {
          error: code,
          // #831 (resolved as operator-channel-only): the refusal is
          // deliberate, so say what the caller should do instead of leaving a
          // bare code. `access:manage` — the tier that decides pairing
          // requests and provisions outbound peer credentials — is never
          // grantable through this route; those decisions stay on the
          // operator channel (the host CLI, or a session already holding the
          // operator credential).
          ...(code === 'scope_not_grantable'
            ? {
                detail:
                  'This access tier cannot be granted here. Pairing decisions and peer-credential provisioning are operator-channel-only: use the host CLI or a session holding the operator credential.',
              }
            : {}),
        },
        pairingErrorStatus(error),
      );
    }
  });
  app.delete('/api/pairing/devices/:deviceId/record', (c) => {
    try {
      const authority = (c as unknown as { get: (key: string) => unknown }).get(
        RUNTIME_CREDENTIAL_AUTHORITY_VAR,
      );
      if (authority !== 'operator-credential') {
        return c.json({ error: 'authentication_required' }, 401);
      }
      return c.json(
        pairing.removeRevokedDevice(c.req.param('deviceId'), authority),
      );
    } catch (error) {
      return c.json(
        { error: pairingErrorCode(error) },
        pairingErrorStatus(error),
      );
    }
  });
}

export type BoundedBodyResult =
  | { status: 'ok'; body: string }
  | { status: 'too-large' }
  | { status: 'invalid' };

/** Exact hosted-ingress exception for the bearer-stage-grant-only upload leaf. */
export function isAttachmentStageGrantUploadRequest(request: Request): boolean {
  const { pathname } = new URL(request.url);
  return (
    request.method === 'PUT' &&
    /^\/api\/orchestration\/attachment-staging\/stage_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(
      pathname,
    )
  );
}

/** Reads an unauthenticated request body without ever buffering past maxBytes. */
export async function readBoundedRequestBody(
  request: Request,
  maxBytes: number,
): Promise<BoundedBodyResult> {
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    if (!/^\d+$/.test(declared) || Number(declared) > maxBytes) {
      return { status: 'too-large' };
    }
  }
  const stream = request.body;
  if (!stream) return { status: 'invalid' };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBytes) {
        await reader
          .cancel('proof request body exceeded byte limit')
          .catch(() => {});
        return { status: 'too-large' };
      }
      chunks.push(result.value);
    }
  } catch {
    await reader.cancel().catch(() => {});
    return { status: 'invalid' };
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return {
      status: 'ok',
      body: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    };
  } catch {
    return { status: 'invalid' };
  }
}

function resolveConfiguredRuntimeOrigins(
  context: Pick<ConfigureRuntimeRoutesContext, 'host' | 'port'>,
): string[] {
  const origins = new Set(
    (process.env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
  origins.add(`http://localhost:${context.port}`);
  origins.add(`http://127.0.0.1:${context.port}`);
  origins.add(`http://[::1]:${context.port}`);
  for (const origin of STATION_NATIVE_SHELL_ORIGINS) origins.add(origin);
  if (context.host && context.host !== '0.0.0.0' && context.host !== '::') {
    origins.add(`http://${context.host}:${context.port}`);
    origins.add(`https://${context.host}:${context.port}`);
  }
  return [...origins];
}
