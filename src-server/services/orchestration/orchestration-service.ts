import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { FlowEvidenceEntry } from '@kontourai/flow';
import {
  type AgentExecutionConfig,
  type AgentSpec,
  isSupportedAgentIconToken,
} from '@kontourai/station-contracts/agent';
import { validateChatAttachments } from '@kontourai/station-contracts/chat-attachment';
import type { ClientOrigin } from '@kontourai/station-contracts/client-origin';
import type {
  ConversationContextBoundaryProjection,
  ConversationContextBoundaryRequest,
} from '@kontourai/station-contracts/conversation-context-boundary';
import {
  ENGINE_CAPABILITY_MATRICES,
  sessionDeliveryChannels,
} from '@kontourai/station-contracts/engine-capability-matrix';
import { engineDisplayLabel } from '@kontourai/station-contracts/engine-display';
import type {
  AgentRunSummary,
  ConversationHandoffStatusProjection,
  ConversationListItem,
  InterruptTurnResult,
  OrchestrationCommand,
  OrchestrationCommandDispatchResult,
  OrchestrationCommandReceipt,
  OrchestrationConversationEventWindow,
  OrchestrationSendTurnInput,
  OrchestrationSessionDetail,
  OrchestrationSessionEventPage,
  OrchestrationSessionEventWindow,
  OrchestrationSessionSummary,
  SessionBoardItem,
  SteerTurnResult,
} from '@kontourai/station-contracts/orchestration';
import {
  FOREGROUND_MESSAGE_INDETERMINATE_CODE,
  PENDING_TURN_INTERRUPT_TTL_MS,
} from '@kontourai/station-contracts/orchestration';
import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import type {
  EngineId,
  ProviderSendTurnInput,
  ProviderSession,
} from '@kontourai/station-contracts/provider';
import {
  FIRST_TURN_INSTRUCTIONS_COMPOSED_METADATA_KEY,
  MODEL_LAUNCH_PLAN_METADATA_KEY,
  MODEL_LAUNCH_REQUESTED_OVERRIDE_METADATA_KEY,
  SESSION_AGENT_DISPLAY_NAME_MAX_LENGTH,
  SESSION_AGENT_DISPLAY_NAME_METADATA_KEY,
  SESSION_AGENT_ICON_METADATA_KEY,
  SESSION_CAPABILITY_DELIVERY_METADATA_KEY,
  SESSION_REATTACH_CONFLICT_CODE,
  SESSION_VISIBILITY_METADATA_KEY,
  type SessionCapabilityDeliveryMetadata,
  type SessionReattachConflictReason,
  stripReservedOrchestrationMetadata,
  unsupportedModelOptionError,
  unsupportedModelOptionKeys,
  WORKSPACE_PANE_HOST_ACTION_METADATA_KEY,
} from '@kontourai/station-contracts/provider';
import type {
  CanonicalRuntimeEvent,
  FlowRunFreshness,
} from '@kontourai/station-contracts/runtime-events';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import type { DeclaredOutputDescriptor } from '@kontourai/station-contracts/session-output-declaration';
import {
  INTERNAL_SESSION_READ_SCOPE,
  type InternalSessionReadScope,
  isSessionReadAuthority,
  type SessionReadAuthority,
  type TenantExecutionContext,
} from '@kontourai/station-contracts/tenancy';
import type { SessionBuilderRunView } from '@kontourai/station-contracts/workflow';
import type { ConversationMessage } from '@kontourai/station-shared/conversation-message';
import { assembleTurnProvenanceEnvelopes } from '@kontourai/station-shared/turn-provenance-fold';
import type { SessionUsageAggregate } from '@kontourai/station-shared/usage-fold';
import type { SessionLifecycleState } from '../../../packages/contracts/src/session-lifecycle.js';
import {
  foldedSessionLifecycleState,
  SESSION_ENDED_REJECTION_CODE,
  SESSION_LIFECYCLE_TRANSITIONS,
} from '../../../packages/contracts/src/session-lifecycle.js';
import type { OrchestrationSessionUsage } from '../../analytics/usage-aggregator-state.js';
import type { UsagePricingSnapshotCapture } from '../../analytics/usage-pricing-snapshot-capture.js';
import type { MonitoringEmitter } from '../../monitoring/emitter.js';
import { engineIdForAdapter } from '../../providers/adapter-identity.js';
import type {
  ProviderAdapterShape,
  ProviderSessionStartInput,
  ProviderTurnStartResult,
} from '../../providers/adapter-shape.js';
import { ProviderTurnEndedError } from '../../providers/adapter-shape.js';
import type { Prerequisite } from '../../providers/provider-contracts.js';
import type { IProviderAdapterRegistry } from '../../providers/provider-interfaces.js';
import { publicAgentIdFromRuntimeKey } from '../../routes/agents/runtime-agent-identity.js';
import { withTenantExecutionContext } from '../../runtime/bootstrap/runtime-tenant-context.js';
import {
  createAuthorizedTurnCorrelation,
  runWithAuthorizedTurnCorrelation,
} from '../../runtime/conversation/authorized-turn-correlation.js';
import {
  createNativeForegroundRelay,
  runWithNativeForegroundRelay,
} from '../../runtime/conversation/native-foreground-invocation.js';
import { safeSanitizeUIBlockEventProvenance } from '../../runtime/conversation/ui-block-provenance.js';
import {
  requiredMissingPrerequisites,
  resolveRuntimeAdapterReadiness,
} from '../../runtime/frameworks/runtime-adapter-readiness.js';
import { createNativeOutputDeclarationOperation } from '../../runtime/native-output-declaration.js';
import type { NativeOutputCallFacts } from '../../runtime/native-output-turn-grant.js';
import {
  createNativeOutputGrantAuthority,
  createNativeOutputRelayCompanion,
  runWithNativeOutputRelayCompanion,
} from '../../runtime/native-output-turn-grant.js';
import {
  adapterSessionStartDuration,
  adapterTurnDuration,
  attachedSessionMutationRejected,
  chatAttachmentBytesDispatched,
  chatAttachmentsDispatched,
  chatStartGate,
  orchestrationCommandsDispatched,
  orchestrationSteerDispatches,
  orchestrationStoreContentionObserved,
  orchestrationTurnDedup,
  sessionActivityEvents,
  sessionBackgroundTasks,
  sessionCwdResolution,
  sessionOwnerCacheOps,
  sessionStateDuration,
  sessionTransitions,
  tenantExecutionContextAttributes,
  tenantExecutionContextOutcomes,
  uiSessionBoardActions,
  uiSessionBoardLoadDuration,
} from '../../telemetry/metrics.js';
import { composeAmbientTurnText } from '../../utils/ambient-context.js';
import { raceWithSignal, throwIfAborted } from '../../utils/bounded-async.js';
import { sessionCorrelationBindings } from '../../utils/logger-correlation.js';
import { expandTilde, safeHomeDirectory } from '../../utils/paths.js';
import { type AgentPolicyService } from '../agents/agent-policy-service.js';
import type {
  ConnectionSmokeRunInput,
  ConnectionSmokeRunResult,
} from '../connections/connection-service.js';
import {
  type SessionWorkflowBinding,
  type WorkflowSidecarAttachMode,
} from '../evidence/orchestration-workflow-sidecar.js';
import type { VeritasReadinessService } from '../evidence/veritas-readiness-service.js';
import type { WorkflowSidecarService } from '../evidence/workflow-sidecar-service.js';
import type {
  AttachFlowEvidenceOptions,
  FlowRunService,
  FlowRunStatus,
} from '../flow/flow-run-service.js';
import { type SessionFlowBinding } from '../flow/orchestration-flow-gate.js';
import { receiptBus } from '../infra/receipt-bus.js';
import {
  admitEngineStartForIntent,
  ConcurrentEngineStartCapacityError,
  type RuntimeResourcePostureProbe,
} from '../infra/resource-posture.js';
import {
  type CwdShadowSample,
  dispatchCwdShadow,
} from '../projects/project-resource-shadow.js';
import type { UsageTelemetryProperties } from '../usage-telemetry-inventory.js';
import { AdapterRetirement } from './adapter-retirement.js';
import type { AdoptionLedger, AdoptionReservation } from './adoption-ledger.js';
import { AttachedSessionAdoption } from './attached-session-adoption.js';
import { type AttachedProjectRoot } from './attached-session-follow-service.js';
import {
  ClientOriginTurnPropagation,
  withClientOrigin,
} from './client-origin-propagation.js';
import { ConnectionSmoke } from './connection-smoke.js';
import {
  type ConversationHistoryPage,
  ConversationHistoryReadService,
} from './conversation-history-read-service.js';
import {
  ConversationLineage,
  canResolveConversationContinuation,
} from './conversation-lineage.js';
import {
  type ConversationOpenResolver,
  createConversationOpenResolver,
} from './conversation-open-resolver.js';
import { CooperativeStop } from './cooperative-stop.js';
import { CredentialProfileRecovery } from './credential-profile-recovery.js';
import {
  type CredentialProfileRecoveryAdapter,
  type CredentialRecoveryModule,
  createCredentialRecoveryModule,
} from './credential-recovery-module.js';
import { DeltaCoalescer, isCoalescableDelta } from './delta-coalescer.js';
import type { EventBus } from './event-bus.js';
import type {
  ConversationForkProvenance,
  EventStore,
  PersistedRuntimeEvent,
} from './event-store.js';
import {
  type ExecutionWorkspaceBinding,
  readExecutionWorkspaceBinding,
} from './execution-workspace-binding.js';
import { FlowPolicySidecar } from './flow-policy-sidecar.js';
import {
  type ForegroundInvocationAdmission,
  ForegroundInvocationUnavailableError,
} from './foreground-invocation-admission.js';
import { InternalStopSuppression } from './internal-stop-suppression.js';
import {
  type InterruptedTurnMemoryAdapter,
  InterruptedTurnRecovery,
} from './interrupted-turn-recovery.js';
import {
  knownModelsCatalog,
  listLaunchableAdapterModels,
  ModelLaunchPlanning,
  ModelLaunchPlanUnavailableError,
  normalizeOmittedModelId,
} from './model-launch-planning.js';
import {
  type RequestReplayOutcome,
  type SessionAnswerabilityObservation,
} from './open-requests.js';
import { OrchestrationMonitoringBridge } from './orchestration-monitoring-bridge.js';
import {
  buildAgentRunSummary,
  buildOrchestrationSessionSummary,
  projectOrchestrationEventToReadModel,
  type RecoveredSessionStartOptions,
  recoverOrchestrationSessions,
  resolveOrchestrationAdapterForThread,
  startRecoveredOrchestrationSession,
  trackOrchestrationSession,
} from './orchestration-session-state.js';
import { type OrchestrationStreamPresenceSubject } from './orchestration-stream-presence.js';
import { type RecoveryDispatchAdapter } from './recovery-dispatch-adapter.js';
import { servingInstanceIdentity } from './serving-instance.js';
import { sessionAgentStartUnavailableReason } from './session-agent-resolution.js';
import { SessionAuthorization } from './session-authorization.js';
import {
  createSessionCommandModule,
  type SessionCommand,
  type SessionCommandContext,
  type SessionCommandImplementation,
  type SessionCommandInternalOptions,
  type SessionCommandModule,
  type SessionCommandOutcome,
} from './session-command-module.js';
import { SessionEventReads } from './session-event-reads.js';
import {
  SessionExecutionCoordinator,
  SessionTurnStartIndeterminateError,
} from './session-execution-coordinator.js';
import {
  createSessionLifecycleModule,
  type SessionLifecycleModule,
} from './session-lifecycle-module.js';
import {
  ACTIVE_TURN_FOLD_METHODS,
  activeTurnIdForEvents,
  createManualSessionTransitionEvent,
  isDeferredRetriableTurnError,
  normalizeCanonicalRuntimeEventLifecycle,
  projectSessionLifecycle,
  turnIdentityAnchorForEvents,
} from './session-lifecycle-service.js';
import {
  createSessionOutputsModule,
  type SessionOutputsModule,
} from './session-outputs-module.js';
import {
  createSessionQueryModule,
  MAX_ASSISTANT_TURN_EVENTS,
  type SessionQueryModule,
} from './session-query-module.js';
import { SessionRecoveryCoordinator } from './session-recovery-coordinator.js';
import { SessionTranscriptReads } from './session-transcript-reads.js';
import { createInMemorySessionTurnBoundaryAuthority } from './session-turn-boundary.js';
import type { TurnDeduplicator } from './turn-deduplicator.js';
import { TurnProgressTracker } from './turn-progress-tracker.js';
import { TurnProvenanceSidecar } from './turn-provenance-sidecar.js';

type UsageTelemetryObserver = {
  trackSessionRecovery(
    properties: UsageTelemetryProperties<'session_recovery'>,
  ): void;
  trackEngineTurn(properties: UsageTelemetryProperties<'engine_turn'>): void;
};

function telemetryEngine(
  provider: string,
): UsageTelemetryProperties<'engine_turn'>['engine'] {
  return (
    ['station', 'acp', 'bedrock', 'claude', 'codex', 'muse', 'ollama'].includes(
      provider,
    )
      ? provider
      : 'other'
  ) as UsageTelemetryProperties<'engine_turn'>['engine'];
}

/**
 * archive#978 review r1 (HIGH fix): the shape of `dispatch`/
 * `dispatchWithReceipt`'s internal-only third parameter. See the
 * `dispatchWithReceipt` docblock for why this can never reach the service
 * from an HTTP route.
 */
interface OrchestrationDispatchInternalOptions {
  foregroundInvocationAdmission?: ForegroundInvocationAdmission;
  executionWorkspace?: ExecutionWorkspaceBinding;
  /** Skip the modelOptions per-provider support check for this one command. */
  skipModelOptionSupportCheck?: boolean;
  /**
   * Permit the server-owned credential profile selector for a bounded
   * connection smoke. Ordinary session callers must use the committed active
   * profile resolved by StationRuntime instead of choosing credentials.
   */
  credentialProfileApplication?: boolean;
  /**
   * How this command's `metadata.taskSlug` attach may treat the sidecar
   * (archive#189 S4). `read-only-join` marks a session Station is starting
   * against a Builder run someone ELSE is driving, so the attach reads and
   * binds but never writes `state.json`.
   *
   * Deliberately carried here, in the internal-options bag, and not in
   * `metadata`: the route's `metadata` is a client-suppliable
   * `z.record(z.unknown())`, and which writer owns a run's state file is a
   * server decision, not a client hint.
   */
  workflowSidecarAttachMode?: WorkflowSidecarAttachMode;
  /** Server-owned execution policy; never accepted from an HTTP command. */
  reviewIsolation?: ProviderSessionStartInput['reviewIsolation'];
  /**
   * archive#2821 hardening L3: see the matching field on
   * `SessionCommandInternalOptions`. Threaded here only so
   * `startSessionInternal` can forward it structurally.
   */
  ephemeralSessionVisibility?: boolean;
  conversationIdentity?: {
    conversationId: string;
    environmentId: string;
  };
  resourceAdmissionIntent?: import('../infra/resource-posture.js').RuntimeEngineStartIntent;
}

function chatStartGateReason(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown';
  if (error.message.includes('prerequisites missing')) {
    return 'missing_prerequisites';
  }
  if (error.message.includes('runtime is not ready')) {
    return 'runtime_not_ready';
  }
  return 'start_failed';
}

/**
 * Station-vs-external collapse of an adapter's engine identity
 * (docs/design/agent-engine-unification.md §4.1; archive#1003 Phase B) for
 * telemetry/projection sites that
 * only need the binary distinction (plus 'unknown' for an unresolvable
 * adapter), not the full engine id. `acp` is not derived through here —
 * callers that want it check `adapter.provider === 'acp'` first, since it's
 * a distinct value, not a station/external collapse.
 */
function engineExecutionForAdapter(
  adapter: ProviderAdapterShape | undefined,
): 'station' | 'external' | 'unknown' {
  if (!adapter) return 'unknown';
  return engineIdForAdapter(adapter) === 'station' ? 'station' : 'external';
}

function chatStartGateAgentType(adapter: ProviderAdapterShape): string {
  return adapter.provider === 'acp'
    ? 'acp'
    : engineExecutionForAdapter(adapter);
}

export interface OrchestrationProviderSummary {
  provider: EngineId;
  prerequisites: Prerequisite[];
  activeSessions: number;
}

export class OrchestrationCommandDispatchError extends Error {
  readonly code?: string;
  readonly outcome?: 'indeterminate';
  readonly retryable?: boolean;

  constructor(
    message: string,
    readonly receipt: OrchestrationCommandReceipt,
    readonly indeterminateSession?: ProviderSession,
    /** Whether the returned receipt is a durable fact or only the attempted one. */
    readonly receiptStatus: 'persisted' | 'unavailable' = 'persisted',
    indeterminateTurnStart = false,
    code?: string,
  ) {
    super(message);
    this.name = 'OrchestrationCommandDispatchError';
    if (indeterminateTurnStart) {
      this.code = FOREGROUND_MESSAGE_INDETERMINATE_CODE;
      this.outcome = 'indeterminate';
    } else if (code) {
      this.code = code;
      // A refusal-to-act (not a failed action) is retryable. Any code whose
      // error message tells the user to retry belongs in this set —
      // archive#3493 delta review caught 'session_start_in_flight' saying
      // "retry" while this line still classified it non-retryable.
      this.retryable =
        code === 'session_start_in_flight' ||
        code === 'resource_engine_start_capacity';
    }
  }
}

/** A repeated start may attach only when it cannot change session behavior. */
export class SessionReattachConflictError extends Error {
  readonly code = SESSION_REATTACH_CONFLICT_CODE;

  constructor(readonly reason: SessionReattachConflictReason) {
    super(`${SESSION_REATTACH_CONFLICT_CODE}: ${reason}`);
  }
}

/**
 * archive#3493 fix round HIGH: a Stop that lands while this process is
 * still starting the session's engine waits for that start, but only up to
 * the adapter-stop deadline — a wedged `adapter.startSession` must not turn
 * a Stop press into a forever-hang. On expiry the command refuses with this
 * typed error rather than falling through to the dormant write, which would
 * report success around a live start (the original archive#3493 lie).
 */
export class SessionStopWhileStartingError extends Error {
  readonly code = 'session_start_in_flight';

  constructor(threadId: string, timeoutMs: number) {
    super(
      `Session is still starting; stop did not settle within ${timeoutMs}ms — retry: ${threadId}`,
    );
    this.name = 'SessionStopWhileStartingError';
  }
}

export { AdoptionContinuationInProgressError } from './attached-session-adoption.js';
export { ModelLaunchPlanUnavailableError } from './model-launch-planning.js';

/**
 * A `sendTurn` refused because the session's folded lifecycle state is
 * terminal (`completed`). This used to be a bare
 * `Error('Session state completed is terminal')` — an internal lifecycle
 * sentence that rode the chat route's catch-all straight into user-facing
 * notices, concatenated with the dropped message text. The message here is
 * written for the person who sent the turn, and the stable `code` lets
 * clients say what actually happened (a Station-side refusal on an ended
 * session, not an agent failure) without parsing prose.
 */
export class SessionEndedError extends Error {
  readonly code = SESSION_ENDED_REJECTION_CODE;

  constructor() {
    super(
      'This session has already ended, so it cannot take another message. Start a new chat to continue.',
    );
    this.name = 'SessionEndedError';
  }
}

export const ATTACHED_SESSION_READ_ONLY_ERROR =
  'Attached sessions are read-only.';
export const PEER_DELEGATION_ACTIVITY_READ_ONLY_ERROR =
  'Peer delegation Activity records are read-only.';

/** A request authority or deliberately named process-wide aggregate scope. */
export type SessionReadScope = SessionReadAuthority | InternalSessionReadScope;

/**
 * The FileMemory seam and its occupancy helper moved to
 * `interrupted-turn-recovery.ts` with the consumer that is their only
 * caller (epic archive#4024). Re-exported because
 * `OrchestrationServiceOptions.memoryAdapters` still declares the type and
 * `runtime/bootstrap/runtime-initialize.ts` imports it from here.
 */
export type { InterruptedTurnMemoryAdapter };

interface OrchestrationServiceOptions {
  adapterRegistry: IProviderAdapterRegistry;
  monitoringEmitter?: MonitoringEmitter;
  eventBus: EventBus;
  eventStore?: EventStore;
  /**
   * Optional write-time catalog authority. The service calls it only while a
   * token event is entering the canonical log; read paths use the persisted
   * snapshot and never perform a current-price lookup.
   */
  pricingSnapshotCapture?: UsagePricingSnapshotCapture;
  /** Adoption's deliberately composed behavioral Interface. */
  adoptionLedger?: AdoptionLedger;
  turnDeduplicator?: TurnDeduplicator;
  /**
   * #764: observed per-connection resume support consulted at continuation
   * resolution, BEFORE a reserved child starts. Return `false` only for an
   * OBSERVED capability absence (an ACP initialize handshake without
   * `loadSession`); `undefined` keeps the resumeCursor path and leaves the
   * adapter's own fail-closed ruling authoritative.
   */
  resumeCursorSupport?: (requested: {
    provider: EngineId;
    connectionId?: string;
  }) => boolean | undefined;
  /** Real connection Adapter composed by StationRuntime; never a recovery protocol. */
  credentialProfileRecoveryAdapter?: CredentialProfileRecoveryAdapter;
  /** Hosted deployments fail closed for direct/internal starts without a server binding. */
  requireTenantExecutionContext?: () => boolean;
  validateRecoveredTenantExecutionContext?: (
    context: TenantExecutionContext | undefined,
  ) => TenantExecutionContext | undefined;
  /**
   * Explicit bridge for installations that still have pre-ownership sessions.
   * Multi-user hosts must leave this at the secure default (`deny`) and
   * migrate or quarantine ownerless rows before exposing them.
   */
  ownerlessSessionAccess?: 'deny' | 'single-user-compat';
  /** Exact legacy OS-alias owner for the local-home principal migration only. */
  legacyPersonalOwner?: string;
  /** When provided, sessions started in Flow workspaces are gate-bound. */
  flowRunService?: FlowRunService;
  listProjects?: () => AttachedProjectRoot[];
  /** Private exact PR point read; it never shares the public route's branch resolver. */
  nativeDeclaredPullRequestResolver?: {
    read(input: {
      provider: string;
      host: string;
      owner: string;
      repository: string;
      ref: string;
      nativeId: string;
      facts: NativeOutputCallFacts;
    }): Promise<Extract<
      DeclaredOutputDescriptor,
      { kind: 'pull-request' }
    > | null>;
    readCurrent(input: {
      provider: string;
      host: string;
      owner: string;
      repository: string;
      ref: string;
      nativeId: string;
      workingDirectory: string;
    }): Promise<Extract<
      DeclaredOutputDescriptor,
      { kind: 'pull-request' }
    > | null>;
  };
  /**
   * archive#1501: non-authoritative observer of `resolveStartSessionCwd`'s
   * project resolution. Optional and unwired in tests; when omitted, the seam
   * runs byte-for-byte as before. Implementations MUST NOT throw and MUST NOT
   * block — see `project-resource-shadow.ts` decision 1.
   */
  observeCwdShadow?: (sample: CwdShadowSample) => void;
  /**
   * When provided (alongside flowRunService), the completion gate auto-runs
   * Veritas readiness and attaches it once before bouncing a session for
   * missing readiness-type evidence (S1c).
   */
  veritasReadinessService?: VeritasReadinessService;
  /**
   * When provided, sessions started in `.flow-agents` workspaces are bound
   * to Flow Agents policy enforcement (S3): stop-goal-fit at the completion
   * choke point, post-hoc config-protection/quality-gate warnings on the
   * adapter event stream for runtimes Station cannot pre-empt. Fail-open:
   * non-opted workspaces see zero behavior change.
   */
  agentPolicyService?: AgentPolicyService;
  /**
   * When provided, sessions started with an explicit `metadata.taskSlug`
   * bind to the durable `.flow-agents/<task-slug>/state.json` sidecar (S3
   * item 2): session start records/resumes the task state, completion gate
   * verdicts write their guidance into it, and completion marks it
   * delivered. The sidecar is workspace-resident, so the workflow survives
   * session handoff, compaction, and RUNTIME SWITCHES. Fail-open: sessions
   * without a task slug see zero behavior change.
   */
  workflowSidecarService?: WorkflowSidecarService;
  /**
   * archive#895 wave A: resolve `startSession` input into a `ResolvedAgentDefinition`
   * (`input.agent`) before dispatch, for sessions started as a real on-disk
   * agent. Optional — omitted in installations/tests that don't wire it, in
   * which case `startSession` input reaches the adapter exactly as before.
   */
  resolveSessionAgent?: (
    input: ProviderSessionStartInput,
    captured?: { agentId: string; spec: AgentSpec },
  ) => Promise<ProviderSessionStartInput>;
  /** Optional immutable presentation source for a newly created Agent session. */
  loadAgentPresentation?: (
    agentSlug: string,
  ) => Promise<{ name: string; icon?: string } | undefined>;
  /**
   * archive#2959: load an on-disk agent's `AgentExecutionConfig` so
   * `resolveSessionAgentForStart` can resolve its declared
   * `turnStallWindowMs` override (`resolveTurnStallWindowMs`,
   * `@kontourai/station-contracts/turn-stall-window`). Independent of
   * `resolveSessionAgent` above: that resolver's capability-delivery
   * resolution is gated by `sessionDeliveryChannels`/`ENGINE_CAPABILITY_MATRICES`
   * and no-ops for providers absent from that matrix (e.g. bedrock, ollama),
   * but the turn-stall window applies uniformly to every provider. Optional
   * — omitted installations/tests get `DEFAULT_TURN_STALL_WINDOW_MS` for
   * every session; a rejection is treated the same as "no override".
   */
  loadAgentExecutionConfig?: (
    agentSlug: string,
  ) => Promise<AgentExecutionConfig | undefined>;
  /**
   * archive#4080: per-agent FileMemory stores, keyed by agent slug —
   * the SAME map `runtime-initialize.ts` composes for the `/chat` route.
   *
   * The interrupted-turn consumer (`InterruptedTurnRecovery.consume`)
   * chooses its banner's presentation path the SAME way the read path does
   * (`routes/chat/conversations.ts`'s `readConversationMessages`): a
   * session's transcript lives wherever that read finds it non-empty — this
   * store when it has anything for the thread, the persisted-runtime-events
   * projection otherwise (`readSessionMessages`'s doc has the full split).
   * Review round 1 (H2): the FIRST version of this gated on
   * `provider === 'station-agent'` instead, which is wrong in both
   * directions — a station-agent conversation created under a real user id
   * (not the conventional `agent:${slug}` one) would have gone unseen by a
   * FileMemory read keyed on the wrong id, and any other engine was
   * silently assumed empty with no check at all. Checking real occupancy
   * removes both assumptions and needs no provider branch.
   *
   * Deliberately a narrow structural seam, not `FileMemoryAdapter` itself —
   * orchestration takes no dependency on the file-memory adapter layer.
   * Optional so installations/tests that don't wire it see zero behavior
   * change (the consumer always falls back to the event-projected path).
   */
  memoryAdapters?: Map<string, InterruptedTurnMemoryAdapter>;
  /** Observed host-pressure gate composed by the production runtime. */
  resourcePosture?: RuntimeResourcePostureProbe;
  /** Cleanup deadline for replaceable provider adapters. */
  adapterStopTimeoutMs?: number;
  /**
   * User-stop grace for an engine's protocol-level cancel acknowledgement.
   * Five seconds gives connected engines time to flush a terminal event while
   * keeping an unresponsive local process from lingering indefinitely.
   */
  cooperativeStopBudgetMs?: number;
  /** Bounded owner-cache capacity; configurable for small deterministic tests. */
  sessionOwnerCacheMaxEntries?: number;
  logger: {
    debug(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    /**
     * Optional (archive#1897 logging slice 3): binds a session-scoped
     * child logger — see `sessionLogger()` below — so a session's own
     * lifecycle warns/debug lines and a later
     * `read_logs?q=<conversationId>` query correlate on the SAME field
     * name a monitoring event uses (`logger-correlation.ts`). Deliberately
     * optional so every existing narrow `{ debug, warn }` test double
     * (dozens of call sites across this service's test suite) keeps
     * typechecking unchanged; call sites fall back to the un-bound logger
     * when a double omits it.
     */
    child?(bindings: Record<string, unknown>): {
      debug(message: string, meta?: Record<string, unknown>): void;
      warn(message: string, meta?: Record<string, unknown>): void;
    };
  };
}

export interface PeerDelegationActivityDispatch {
  taskId: string;
  conversationId: string;
  prompt: string;
  userId: string;
  environment: { id: string; name: string; kind: 'peer' };
  target: { kind: 'agent'; id: string };
  projectSlug?: string;
  parentTaskId?: string;
}

function peerDelegationActivityThreadId(
  environmentId: string,
  taskId: string,
): string {
  const digest = crypto
    .createHash('sha256')
    .update(`${environmentId}\0${taskId}`)
    .digest('hex')
    .slice(0, 32);
  return `peer-delegation:${digest}`;
}

function peerDelegationLifecyclePath(
  from: SessionLifecycleState,
  to: SessionLifecycleState,
): SessionLifecycleState[] | undefined {
  const queue: SessionLifecycleState[][] = [[from]];
  const visited = new Set<SessionLifecycleState>([from]);
  while (queue.length > 0) {
    const path = queue.shift()!;
    const current = path.at(-1)!;
    for (const next of SESSION_LIFECYCLE_TRANSITIONS[current]) {
      if (visited.has(next)) continue;
      const nextPath = [...path, next];
      if (next === to) return nextPath;
      visited.add(next);
      queue.push(nextPath);
    }
  }
  return undefined;
}

/**
 * Server-only admission seam for narrowly scoped execution envelopes.  It is
 * intentionally opt-in: ordinary Tasks and interactive Sessions have no
 * registered observer and retain their existing command path.
 */
export type OrchestrationTurnAdmission = (input: {
  threadId: string;
}) => { allowed: true } | { allowed: false; reason: string };

/**
 * archive#685 choke point: compose ambient, model-facing context into the turn's
 * model input while keeping the typed text available as `displayInput` for
 * transcript-facing events (`turn.started` prompt). Adapters never see the
 * `ambientContext` field itself.
 */
function composeAmbientSendTurnInput(
  commandInput: OrchestrationSendTurnInput,
): ProviderSendTurnInput {
  const { ambientContext, ...turnInput } = commandInput;
  const composed = composeAmbientTurnText(ambientContext, turnInput.input);
  if (composed === turnInput.input) {
    return turnInput;
  }
  return {
    ...turnInput,
    input: composed,
    displayInput: turnInput.input,
    // Relay-only (see ProviderSendTurnInput.ambientContext): direct-model
    // adapters ignore it; the station-agent relay forwards it so /chat
    // composes once and persists typed text.
    ambientContext,
  };
}

/**
 * archive#895 wave C (instructionsInFirstTurn): read the pending first-turn
 * authored prompt off a session's own event log — the same receipt
 * `session-agent-resolution.ts` stamps into `session.started` metadata
 * before any turn dispatches (`report.systemPrompt.channel === 'first-turn'`
 * with a `firstTurnInstructions` string). Every delivering adapter spreads
 * `input.metadata` into its `session.started`/`session.configured` publish
 * (see e.g. `muse-adapter.ts`), so the receipt lands durably before this
 * function ever runs — mirrors `station-control-delegation.ts`'s
 * `capabilityDeliveryReport` fold for this narrower need (only the
 * systemPrompt entry, only the first-turn shape).
 *
 * Returns `undefined` once a `turn.started` already exists for this
 * session: that is the session's genuine first turn having already
 * happened, and the ONLY signal this function needs to never re-prepend —
 * every later `sendTurn` dispatch on the same session sees its own prior
 * `turn.started` in the event log it reads. Checked over the whole log
 * rather than short-circuiting mid-scan, so this holds regardless of a
 * session.configured event's position relative to turn.started.
 */
function pendingFirstTurnInstructions(
  events: readonly { method?: unknown; metadata?: unknown }[],
): string | undefined {
  if (events.some((event) => event.method === 'turn.started')) {
    return undefined;
  }
  let firstTurnInstructions: string | undefined;
  for (const event of events) {
    if (
      event.method !== 'session.started' &&
      event.method !== 'session.configured'
    ) {
      continue;
    }
    const metadata =
      event.metadata && typeof event.metadata === 'object'
        ? (event.metadata as Record<string, unknown>)
        : undefined;
    const report = metadata?.[SESSION_CAPABILITY_DELIVERY_METADATA_KEY] as
      | SessionCapabilityDeliveryMetadata
      | undefined;
    const systemPrompt = report?.systemPrompt;
    if (
      systemPrompt?.channel === 'first-turn' &&
      typeof systemPrompt.firstTurnInstructions === 'string'
    ) {
      firstTurnInstructions = systemPrompt.firstTurnInstructions;
    }
  }
  return firstTurnInstructions;
}

/**
 * Strip client-supplied server-owned receipt metadata before
 * resolution/dispatch. The route schema's `metadata` field is an untyped
 * `z.record(z.unknown())` (unlike the rest of `startSession`'s input, which
 * strips unknown keys), so a client could otherwise forge this reserved,
 * server-owned receipt key. Returns `input` unchanged when nothing to strip
 * (the common case) rather than always allocating a new metadata object.
 */
function stripReservedCapabilityMetadata<
  T extends {
    metadata?: Record<string, unknown>;
    modelOptions?: Record<string, unknown>;
  },
>(input: T): T {
  const metadata = stripReservedOrchestrationMetadata(input.metadata);
  const modelOptions = stripReservedOrchestrationMetadata(input.modelOptions);
  if (metadata === input.metadata && modelOptions === input.modelOptions) {
    return input;
  }
  return { ...input, metadata, modelOptions } as T;
}

/** True when `candidate` is `root` itself or a directory inside it. */
function isWithinDirectory(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const rel = relative(root, candidate);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * archive#686/#791/#1011: decide the working directory an engine session launches
 * in. This is the ONE place a session's `cwd` is settled, and every provider
 * reaches its adapter through it, so a fix here covers Claude, Codex,
 * ACP-connected CLIs, and Station's own agent relay alike.
 *
 * archive#1011 was a family of fail-open branches: whenever this returned the input
 * unchanged, the adapter spawned the engine with no `cwd` at all and the
 * process simply inherited the SERVER's working directory — `$HOME` in the
 * desktop app. A chat the UI shows as bound to a project then read and wrote
 * the wrong files. So the rule is now: a project-bound chat either launches
 * in a real, resolved directory or fails loudly enough to name the project
 * and the path.
 *
 * Resolution order and the reasoning behind each edge case:
 *
 * - Every `cwd` — the project's `workingDirectory` (stored with a literal
 *   `~`, see terminal-service) and any caller-supplied one — is
 *   tilde-expanded and resolved to an absolute path. Callers that pass a
 *   project path through verbatim (`station chat --project=<slug>`,
 *   `station-control-delegation.ts`) were handing adapters a literal
 *   `~/dev/...` that no `chdir` can satisfy; the engine then failed to launch
 *   behind an adapter-specific error that named neither the project nor the
 *   path.
 * - A `projectSlug` this Station does not have is a broken binding, not a
 *   global chat: fail loudly instead of silently launching in the server's
 *   directory.
 * - A project WITHOUT a `workingDirectory` is deliberately NOT an error.
 *   Such a project is an organizational/knowledge scope, not a directory
 *   binding — Station seeds exactly one (`default`) — so a chat in it is a
 *   global chat and must keep behaving like one. Since archive#1042 that means an
 *   explicit `$HOME`, not an inherited server directory; archive#1023 extends the
 *   same terminus to the ACP adapter, which was the last engine family whose
 *   chain still ended at `process.cwd()`.
 * - A caller-supplied `cwd` still wins over the project directory (a session
 *   may legitimately be bound to a worktree or subdirectory), but only while
 *   it stays inside the project it claims to be bound to.
 * - A resolved directory that does not exist fails closed (archive#791).
 *
 * archive#1501: `observeShadow` is a NON-AUTHORITATIVE observer of
 * this function's project resolution. Every branch below behaves exactly as
 * it did before — the shadow is dispatched and discarded, never awaited and
 * never consulted. See `project-resource-shadow.ts` for why the migration is
 * shadowed before it is flipped.
 */
function resolveStartSessionCwd(
  input: ProviderSessionStartInput,
  listProjects?: () => AttachedProjectRoot[],
  observeShadow?: (sample: CwdShadowSample) => void,
  admittedWorkspace?: ForegroundInvocationAdmission['provisionedWorkspace'],
): ProviderSessionStartInput {
  const rawProjectSlug = input.metadata?.projectSlug;
  const projectSlug =
    typeof rawProjectSlug === 'string' && rawProjectSlug
      ? rawProjectSlug
      : undefined;
  const suppliedCwd = input.cwd ? resolve(expandTilde(input.cwd)) : undefined;

  // `listProjects` is optional on the service options, so an installation
  // that never wired it cannot resolve project bindings at all. Keep the
  // input untouched there rather than failing every project-bound chat on a
  // server-wiring defect the user cannot act on.
  let projectCwd: string | undefined;
  if (projectSlug && listProjects) {
    const project = listProjects().find((entry) => entry.slug === projectSlug);
    if (!project) {
      sessionCwdResolution.add(1, {
        provider: input.provider,
        source: 'project',
        outcome: 'rejected',
        reason: 'project_not_found',
      });
      // Shadowed BEFORE the throw: this branch is a real resolution outcome
      // and skipping it would leave the loudest fail-closed path unobserved.
      dispatchCwdShadow(observeShadow, {
        projectSlug,
        provider: input.provider,
        projectNotFound: true,
      });
      throw new Error(
        `Chat is bound to project '${projectSlug}', which this Station does not have. Reopen the chat under an existing project, or recreate the project.`,
      );
    }
    projectCwd = project.workingDirectory
      ? resolve(expandTilde(project.workingDirectory))
      : undefined;
    dispatchCwdShadow(observeShadow, {
      projectSlug,
      provider: input.provider,
      projectCwd,
    });
  }

  const cwd = suppliedCwd ?? projectCwd;
  if (!cwd) {
    // archive#1023: never inherit the server process's cwd — on a desktop install
    // that happened to be $HOME, but from a dev checkout or a service it is
    // the install root, and the UI promises "~ (defaults to home)" for a
    // directory-less project. Make the promise true everywhere. The seeded
    // `default` project (no workingDirectory) and unbound chats both land
    // here; the resolver's product-side follow-ups in archive#1023 still apply.
    //
    // ACP is still excluded here, for the same reason as before: its adapter
    // carries a connection-level fallback (`config.cwd`) that only the
    // adapter can see, and defaulting unconditionally here would permanently
    // shadow it. Since archive#1403, the adapter ends that chain in a private,
    // Station-managed workspace and fails closed if it cannot prepare one;
    // it records that final outcome on this instrument.
    const home = input.provider === 'acp' ? undefined : safeHomeDirectory();
    if (home) {
      sessionCwdResolution.add(1, {
        provider: input.provider,
        source: 'none',
        outcome: 'defaulted_home',
        reason: projectSlug ? 'project_without_directory' : 'unbound_chat',
      });
      // archive#1174: this cwd is a default, not a real project/user
      // binding — see cwdDefaulted's doc comment on ProviderSessionStartInput.
      return { ...input, cwd: home, cwdDefaulted: true };
    }
    sessionCwdResolution.add(1, {
      provider: input.provider,
      source: 'none',
      outcome: input.provider === 'acp' ? 'deferred' : 'inherited',
      reason:
        input.provider === 'acp'
          ? 'acp_connection_default'
          : 'home_unavailable',
    });
    // archive#1174: still no real project/user cwd, even though this
    // degenerate-host/ACP branch leaves `cwd` itself untouched.
    return { ...input, cwdDefaulted: true };
  }

  if (
    projectCwd &&
    suppliedCwd &&
    !isWithinDirectory(projectCwd, suppliedCwd) &&
    !(
      admittedWorkspace?.threadId === input.threadId &&
      admittedWorkspace.projectSlug === projectSlug &&
      admittedWorkspace.cwd === suppliedCwd
    )
  ) {
    sessionCwdResolution.add(1, {
      provider: input.provider,
      source: 'explicit',
      outcome: 'rejected',
      reason: 'outside_project',
    });
    throw new Error(
      `Requested working directory ${suppliedCwd} is outside project '${projectSlug}' (${projectCwd}).`,
    );
  }

  // Fail closed on a stale or deleted directory rather than handing it to the
  // adapter (archive#791). Dropping the cwd instead would be worse than an error: the
  // adapter would spawn in whatever the server's cwd happens to be — usually
  // the install root — so an agent asked to work on a project would quietly
  // read and write somewhere else entirely. Failing here names the project and
  // the path; failing at spawn produces an adapter-specific message that does
  // not.
  if (!existsSync(cwd)) {
    sessionCwdResolution.add(1, {
      provider: input.provider,
      source: suppliedCwd ? 'explicit' : 'project',
      outcome: 'rejected',
      reason: 'missing_directory',
    });
    throw new Error(
      projectSlug && cwd === projectCwd
        ? `Project '${projectSlug}' working directory no longer exists: ${cwd}`
        : `Requested working directory does not exist: ${cwd}`,
    );
  }

  sessionCwdResolution.add(1, {
    provider: input.provider,
    source: suppliedCwd ? 'explicit' : 'project',
    outcome: 'resolved',
    reason: projectSlug ? 'project_bound' : 'unbound_chat',
  });
  return { ...input, cwd };
}

export class OrchestrationService {
  readonly sessionCommands: SessionCommandModule;
  private readonly sessionCommandImplementation: SessionCommandImplementation;
  readonly sessionQueries: SessionQueryModule;
  /** Authoritative inventory-to-session open state; routes do not restitch it. */
  readonly conversationOpenResolver: ConversationOpenResolver;
  /** Explicit declared-output inventory; separate from transcript/Basis reads. */
  readonly sessionOutputs: SessionOutputsModule;
  readonly sessionLifecycles: SessionLifecycleModule;
  private usageTelemetry?: UsageTelemetryObserver;
  private readonly sessionExecutionCoordinator: SessionExecutionCoordinator;
  /** Private native-output authority; no public Session/Thread API exposes it. */
  private readonly nativeOutputGrants = createNativeOutputGrantAuthority();
  /** Pending opaque handles; durable admission occurs only at terminal append. */
  private readonly nativeOutputDeclarations: ReturnType<
    typeof createNativeOutputDeclarationOperation
  >;
  /** Exact active generation until the ordered durable terminal event commits. */
  private readonly nativeOutputTurnGenerations = new Map<string, string>();
  private readonly consumedAdapterEventStreams =
    new WeakSet<ProviderAdapterShape>();
  private readonly activeEventAdapters = new Map<
    EngineId,
    ProviderAdapterShape
  >();
  private readonly adapterEventControllers = new Map<
    ProviderAdapterShape,
    AbortController
  >();
  /**
   * Adapter retirement + the bounded-await helpers (epic archive#4024).
   * Owns its two maps; every write is internal. The dead
   * `adapterRetirements` Set that used to sit here was deleted in the same
   * slice — three references file-wide (declare, one add, one delete) and
   * never read, iterated, sized or awaited. It was NOT the collection
   * shutdown drains: that is `adapterRetirementByAdapter`, the raw
   * operation, which shutdown re-wraps in its own deadline.
   */
  /** Turn-provenance envelopes (epic archive#4024, C2 sub-cut). */
  private readonly turnProvenance: TurnProvenanceSidecar;
  private readonly adapterRetirement: AdapterRetirement;
  /** Boot-time interrupted-turn recovery (epic archive#4024). */
  private readonly interruptedTurns: InterruptedTurnRecovery;
  private adapterRegistryUnsubscribe?: () => void;
  private readonly sessionAdapters = new Map<string, ProviderAdapterShape>();
  /**
   * Turn progress + turn-stall observation (epic archive#4024, archive#4116):
   * owns the stall watchdog, per-thread windows, and the process-local
   * progress markers. Constructed in the ctor — its deps object captures two
   * `options.*` values EAGERLY (the ctor parameter is not in scope in a
   * field initializer at all), while the closures over `this` are lazy and
   * would survive either placement (the deltaCoalescer note below records
   * the lazy-`this.options` hazard for field initializers that DO close over
   * it).
   */
  private readonly turnProgress: TurnProgressTracker;
  /** Transcript read/search/usage projections (epic archive#4024, archive#4144). */
  private readonly transcriptReads: SessionTranscriptReads;
  /** Event paging & stream replay (epic archive#4024, archive#4155). */
  private readonly sessionEventReads: SessionEventReads;
  /** Tenancy & owner authorization (epic archive#4024, archive#4166). */
  private readonly sessionAuthz: SessionAuthorization;
  /** Model launch plan & selector validation (epic archive#4024, archive#4179). */
  private readonly modelLaunch: ModelLaunchPlanning;
  /** Credential-profile recovery, execution half (epic archive#4024, archive#4174). */
  private readonly credentialProfileRecovery: CredentialProfileRecovery;
  /** Connection smoke (epic archive#4024, archive#4195). */
  private readonly connectionSmoke: ConnectionSmoke;
  /** Cooperative stop & deferred interrupt (epic archive#4024, archive#4204). */
  private readonly cooperativeStop: CooperativeStop;
  private readonly threadProviders = new Map<string, EngineId>();
  private readonly clientOriginTurns = new ClientOriginTurnPropagation();
  /**
   * archive#4075 stage 2 review round 1 (F2, MEDIUM/HIGH): `sendTurn`'s
   * begin/settle around `clientOriginTurns` runs INSIDE
   * `sessionExecutionCoordinator.runTurnStart`, which already serializes
   * distinct turn STARTS per thread — but `runTurnStart`'s claim/
   * `notInvoked` lifecycle is specifically about starting a turn (mutually
   * exclusive with a lifecycle transition), and a steer targets a turn
   * that is already running, so reusing it for steer would misrepresent a
   * steer as a turn start to the boundary authority. This is the narrower,
   * purpose-built equivalent for steer: a steer's `turn.started
   * (inputKind:'steer')` reuses the SAME turnId as the turn it steers, so
   * two concurrent steers on one thread collide on the exact same
   * `ClientOriginTurnPropagation` key — whichever one's adapter event
   * lands "early" gets buffered under that key and is later republished
   * under WHICHEVER caller's `settle()` finds it first, regardless of
   * which one actually produced it. That is true whether or not either
   * caller carries a `clientOrigin`/`principal` to reserve — `begin()`'s
   * own `false` return does not distinguish "nothing to reserve" (benign,
   * safely ignorable, the common case for callers with no attribution)
   * from "another reservation is in flight" (must refuse), so gating the
   * refusal on `begin()`'s return alone is not enough. This set holds the
   * one true serialization fact instead: is a steer command currently
   * in flight for this thread, at all.
   */
  private readonly inFlightSteers = new Set<string>();
  private readonly sessionReadModel = new Map<string, ProviderSession>();
  /**
   * Webhook turns retain their event/command receipts but never enter the
   * ordinary session inventory. The durable event metadata rehydrates this
   * fact after restart; this Set closes the short live gap before a read.
   */
  private readonly ephemeralSessionThreads = new Set<string>();
  /**
   * The connection selection is command context, not a public session field.
   * Keep it only while this process owns the session so a credential-profile
   * restart can recreate the adapter's private quota routing identity.
   */
  private readonly sessionConnectionIds = new Map<string, string>();
  private readonly quarantinedThreads = new Set<string>();
  /**
   * Internal-stop push suppression (epic archive#4024, archive#4144): the C5
   * cluster's Set and its archive#3525 rationale moved verbatim to
   * internal-stop-suppression.ts. Constructed in the ctor; the public
   * `consumeInternalStopSuppression` forwarder keeps the external surface.
   */
  private readonly internalStops: InternalStopSuppression;
  private readonly startingSessionThreads = new Set<string>();
  /**
   * archive#3476: in-flight lazy materialisations, keyed by thread. Two
   * concurrent first turns on the same restored session would otherwise each
   * call `adapter.startSession`, spawning two engines for one conversation —
   * a small copy of the leak this change removes. Every materialising caller
   * (sendTurn, the startSession reattach path) goes through
   * `materializeRecoveredSession`, so sharing the promise here covers all of
   * them rather than one.
   */
  private readonly materializingSessions = new Map<
    string,
    Promise<ProviderAdapterShape | undefined>
  >();
  /** Flow run / policy hooks / workflow sidecar (epic archive#4024, archive#4218). */
  private readonly flowPolicy: FlowPolicySidecar;
  private readonly recoveryCoordinator?: SessionRecoveryCoordinator;
  private readonly credentialRecovery?: CredentialRecoveryModule;
  private readonly conversationHistoryReader?: ConversationHistoryReadService;
  private readonly turnDeduplicator?: TurnDeduplicator;
  private readonly conversationLineage: ConversationLineage;
  private readonly adoptionLedger?: AdoptionLedger;
  private readonly adoption: AttachedSessionAdoption;
  private readonly monitoringBridge: OrchestrationMonitoringBridge;
  /**
   * Batches content deltas ahead of the publish body. Emits through
   * `publishCanonicalEvent` rather than `projectAndPublishEvent`, which would
   * re-enter the coalescer it was flushed from.
   */
  private readonly deltaCoalescer = new DeltaCoalescer(
    (event) => this.publishCanonicalEvent(event),
    {
      // Read lazily: this field initializer runs before `options` is
      // guaranteed to be assigned, and nothing warns until a delivery fails.
      logger: {
        warn: (message, meta) => this.options.logger.warn(message, meta),
      },
    },
  );
  /** Threads whose missing configuration has already been logged for monitoring. */
  private readonly monitoringUnconfiguredThreads = new Set<string>();
  private readonly turnAdmissions = new Set<OrchestrationTurnAdmission>();
  private started = false;
  /**
   * archive#1745: whether this process's startup attachment pass has FINISHED
   * — not whether it succeeded.
   *
   * Deliberately not "whether `recoverSessions()` completed": it is set in a
   * `finally`, so it is also true after the chain rejected, where recovery
   * demonstrably did not finish and `sessionAdapters` holds only the threads
   * it reached before throwing. The alternative reading — hold the window open
   * on failure — is a permanent fail-open plus a `reconcile()` that never
   * runs; see the `.finally` in `initialize()` for why settling on whatever
   * was reached is the smaller residual. There is deliberately no third
   * `settled-with-error` state: nothing downstream reads this but the
   * answerability observation, which has no use for the distinction.
   *
   * Read ONLY through `observeAnswerability`, which reports `'unknown'`
   * attachment until it is true, so the projection fails open in the window.
   */
  private sessionAttachmentSettled = false;

  constructor(private readonly options: OrchestrationServiceOptions) {
    this.nativeOutputDeclarations = createNativeOutputDeclarationOperation({
      authority: this.nativeOutputGrants,
      workspaceForCall: (facts) => facts.workspaceRoot,
      ...(options.nativeDeclaredPullRequestResolver
        ? {
            readPullRequest: (input) =>
              options.nativeDeclaredPullRequestResolver!.read(input),
          }
        : {}),
    });
    // Constructed FIRST: SessionAuthorization holds only raw option values
    // and no back-references, so building it before every other collaborator
    // means no later closure can capture an undefined authz seam.
    this.sessionAuthz = new SessionAuthorization({
      ...(options.eventStore ? { eventStore: options.eventStore } : {}),
      ...(options.requireTenantExecutionContext !== undefined
        ? {
            requireTenantExecutionContext:
              options.requireTenantExecutionContext,
          }
        : {}),
      ...(options.validateRecoveredTenantExecutionContext !== undefined
        ? {
            validateRecoveredTenantExecutionContext:
              options.validateRecoveredTenantExecutionContext,
          }
        : {}),
      ...(options.ownerlessSessionAccess !== undefined
        ? { ownerlessSessionAccess: options.ownerlessSessionAccess }
        : {}),
      ...(options.legacyPersonalOwner !== undefined
        ? { legacyPersonalOwner: options.legacyPersonalOwner }
        : {}),
      ...(options.sessionOwnerCacheMaxEntries !== undefined
        ? { sessionOwnerCacheMaxEntries: options.sessionOwnerCacheMaxEntries }
        : {}),
    });
    this.modelLaunch = new ModelLaunchPlanning({
      loadedSessionModel: (threadId) =>
        this.sessionReadModel.get(threadId)?.model,
    });
    this.turnProgress = new TurnProgressTracker({
      providerForThread: (threadId) =>
        this.sessionAdapters.get(threadId)?.provider,
      // Captured by value where the arrows above stay lazy: `options` is a
      // never-reassigned parameter property, so both styles read the same
      // function for the service's whole life.
      loadAgentExecutionConfig: options.loadAgentExecutionConfig,
      publishProjectionChange: (threadId) =>
        this.options.eventBus.emit(
          SERVER_EVENTS.ORCHESTRATION_SESSION_PROJECTION_UPDATED,
          { threadId },
        ),
      logger: options.logger,
    });
    this.transcriptReads = new SessionTranscriptReads({
      canReadSession: (threadId, authority) =>
        this.sessionAuthz.canReadSession(threadId, authority),
      isEphemeralSession: (threadId) => this.isEphemeralSession(threadId),
      sessionAttributionFor: (threadId) => this.sessionAttributionFor(threadId),
      listEventPayloads: (threadId) =>
        (this.options.eventStore?.listEvents(threadId) ?? []).map(
          (event) => event.payload,
        ),
      listUsageEventRecords: (threadId) =>
        this.options.eventStore?.listEvents(threadId) ?? [],
      listUsageReceiptEvents: (input) =>
        this.options.eventStore?.listUsageReceiptEvents(input) ?? [],
      listUsageCoverageEvents: (input) =>
        this.options.eventStore?.listUsageCoverageEvents(input) ?? [],
      searchConversationMessages: (input) =>
        this.options.eventStore?.searchConversationMessages(input) ?? [],
      readSessionThreadIds: (authority) => {
        if (authority === INTERNAL_SESSION_READ_SCOPE) {
          return (this.options.eventStore?.readSessions() ?? []).map(
            (persisted) => persisted.threadId,
          );
        }
        if (!isSessionReadAuthority(authority)) return [];
        return (
          this.options.eventStore?.readUsageSessionThreadIds({
            ownerUserId: authority.userId,
            ...(authority.mode === 'hosted' && authority.tenantExecutionContext
              ? { tenantId: authority.tenantExecutionContext.tenantId }
              : {}),
          }) ?? []
        );
      },
      requireTenantExecutionContext: () =>
        this.options.requireTenantExecutionContext?.() === true,
      // The sink the fold's drop contract depends on. Without it a refused
      // figure is silently swallowed — the exact outcome
      // `packages/shared/src/usage-fold.ts` forbids, and the reason the
      // birth-site guards would stop being able to surface a producer defect.
      reportDroppedUsageFigure: (dropped) =>
        (
          this.options.logger?.warn as ((...a: unknown[]) => void) | undefined
        )?.(
          `Usage fold refused a persisted ${dropped.field} (${String(dropped.value)}) while replaying thread ${dropped.threadId ?? 'unknown'}${dropped.provider ? ` from ${dropped.provider}` : ''}: the figure is unusable, so it is read as absent rather than as a measurement.`,
        ),
    });
    this.sessionEventReads = new SessionEventReads({
      ...(options.eventStore ? { eventStore: options.eventStore } : {}),
      logger: options.logger,
      listSessions: (authority) => this.listSessions(authority),
      hydratePersistedTenantContexts: (sessions) =>
        this.sessionAuthz.hydratePersistedTenantContexts(sessions),
      loadedSessionForThread: (threadId) => this.sessionReadModel.get(threadId),
      canReadSession: (threadId, authority) =>
        this.sessionAuthz.canReadSession(threadId, authority),
      canUserReadSession: (threadId, authority) =>
        this.canUserReadSession(threadId, authority),
      readTurnProgress: (threadId) => this.turnProgress.read(threadId),
      observeAnswerability: (threadId, provider, observedAt) =>
        this.observeAnswerability(threadId, provider, observedAt),
      readSession: (threadId, authority) =>
        this.readSession(threadId, authority),
    });
    this.internalStops = new InternalStopSuppression({
      listActiveTurnFoldEventPayloads: (threadId) =>
        (
          this.options.eventStore?.listEventsByMethods(
            threadId,
            ACTIVE_TURN_FOLD_METHODS,
          ) ?? []
        ).map((stored) => stored.payload),
      emitRedispatchFailed: (payload) =>
        this.options.eventBus.emit(
          SERVER_EVENTS.INTERNAL_STOP_REDISPATCH_FAILED,
          payload,
        ),
    });
    this.sessionExecutionCoordinator = new SessionExecutionCoordinator(
      options.eventStore?.sessionTurnBoundaryAuthority() ??
        createInMemorySessionTurnBoundaryAuthority(),
    );
    this.turnDeduplicator =
      options.turnDeduplicator ?? options.eventStore?.createTurnDeduplicator();
    this.adoptionLedger =
      options.adoptionLedger ?? options.eventStore?.createAdoptionLedger();
    // Value-typed deps (eventStore, adoptionLedger, adapterRegistry,
    // flowRunService, listProjects, requireTenantExecutionContext, logger)
    // are captured ONCE here; the service reads the same `options` fields
    // live. Safe only while nothing mutates `options` post-construction —
    // nothing does today; if that ever changes, convert these to closures.
    this.adoption = new AttachedSessionAdoption({
      ...(options.eventStore ? { eventStore: options.eventStore } : {}),
      ...(this.adoptionLedger ? { adoptionLedger: this.adoptionLedger } : {}),
      adapterRegistry: options.adapterRegistry,
      ...(options.flowRunService
        ? { flowRunService: options.flowRunService }
        : {}),
      ...(options.listProjects ? { listProjects: options.listProjects } : {}),
      ...(options.requireTenantExecutionContext !== undefined
        ? {
            requireTenantExecutionContext:
              options.requireTenantExecutionContext,
          }
        : {}),
      logger: options.logger,
      canReadSessionForCommand: (threadId, userId, tenantExecutionContext) =>
        this.sessionAuthz.canReadSessionForCommand(
          threadId,
          userId,
          tenantExecutionContext,
        ),
      tenantContextFor: (threadId) =>
        this.sessionAuthz.tenantContextFor(threadId),
      liveSessions: () => this.sessionReadModel.values(),
      trackSession: (session, adapter) => this.trackSession(session, adapter),
      evictCollidingAttachedAliases: () => this.evictCollidingAttachedAliases(),
      persistReceipt: (receipt) => this.persistReceipt(receipt),
      requireAdapter: (provider) => this.requireAdapter(provider),
      assertAdapterCurrent: (adapter) => this.assertAdapterCurrent(adapter),
      assertAdapterReady: (adapter) => this.assertAdapterReady(adapter),
      withAcceptedModelLaunchPlan: (
        adapter,
        input,
        lifecycle,
        retainedModelId,
      ) =>
        this.modelLaunch.withAcceptedModelLaunchPlan(
          adapter,
          input,
          lifecycle,
          retainedModelId,
        ),
      recordAcceptedModelLaunchPlan: (
        adapter,
        plan,
        lifecycle,
        requestedOverride,
      ) =>
        this.modelLaunch.recordAcceptedModelLaunchPlan(
          adapter,
          plan,
          lifecycle,
          requestedOverride,
        ),
      modelLaunchPlanFromInput: (input) =>
        this.modelLaunch.modelLaunchPlanFromInput(input),
      modelLaunchRequestedOverrideFromInput: (input) =>
        this.modelLaunch.modelLaunchRequestedOverrideFromInput(input),
      forgetAbandonedAdoptionMemory: (reservation) =>
        this.clearAbandonedAdoptionMemory(reservation),
      logCleanupFailure: (resource, reservation, error) =>
        this.logAdoptionCleanupFailure(resource, reservation, error),
    });
    this.sessionCommandImplementation =
      this.createSessionCommandImplementation();
    this.sessionCommands = this.sessionCommandImplementation;
    this.sessionLifecycles = createSessionLifecycleModule({
      coordinator: this.sessionExecutionCoordinator,
      initialize: () => this.initialize(),
      isReadOnlyAttached: (threadId) =>
        this.isReadOnlyAttachedSession(threadId),
      attachedReadOnlyMessage: ATTACHED_SESSION_READ_ONLY_ERROR,
      readSession: (threadId, authority) =>
        this.readSession(threadId, authority),
      prepareCompletion: (input) => this.flowPolicy.prepareCompletion(input),
      publish: (event) => {
        this.projectAndPublishEvent(event);
      },
      latestStateEventAt: (threadId, state) =>
        this.options.eventStore?.latestEventForSessionState(threadId, state)
          ?.createdAt,
      observeTransition: (input) => {
        sessionTransitions.add(1, {
          from_state: input.from,
          to_state: input.to,
          runtime_kind: input.provider,
          source: input.source,
          reason: input.reason,
          outcome: input.outcome,
        });
      },
      observeBoardAction: (input) => {
        uiSessionBoardActions.add(1, input);
      },
      observeStateDuration: (input) => {
        this.recordStateDuration({
          previousState: input.previousState,
          nextEventAt: input.nextEventAt,
          ...(input.previousEventAt
            ? { previousEventAt: input.previousEventAt }
            : {}),
          runtimeKind: input.provider,
        });
      },
    });
    this.sessionQueries = createSessionQueryModule({
      findSession: async (threadId) => {
        // A targeted query is deliberately durable/in-memory only: starting
        // adapter recovery or enumerating every provider here would make a
        // single chat refresh depend on unrelated remote adapters.
        const persisted =
          this.options.eventStore?.readSessionByThread(threadId);
        if (persisted)
          this.sessionAuthz.hydratePersistedTenantContexts([persisted]);
        const loaded = this.sessionReadModel.get(threadId);
        if (!persisted && !loaded) return null;
        return { persisted, loaded };
      },
      projectConversation: ({ persisted, loaded }, events) => {
        const session = buildOrchestrationSessionSummary({
          persisted,
          loaded,
          events: [...events],
          turnProgress: this.turnProgress.read(
            persisted?.threadId ?? loaded?.threadId ?? '',
          ),
          answerability: this.observeAnswerability(
            persisted?.threadId ?? loaded?.threadId ?? '',
            (loaded ?? persisted)?.provider,
            new Date().toISOString(),
          ),
        });
        if (!session.assignedAgentSlug) return null;
        const threadId = persisted?.threadId ?? loaded?.threadId ?? '';
        const conversationId =
          this.options.eventStore?.conversationForSession(threadId)
            ?.conversationId ?? session.conversationId;
        const acceptedModel = conversationId
          ? this.options.eventStore?.readLatestAcceptedConversationModel({
              conversationId,
              environmentId: session.environmentId,
            })
          : undefined;
        return {
          assignedAgentSlug: session.assignedAgentSlug,
          ...(conversationId ? { conversationId } : {}),
          ...(session.environmentId
            ? { environmentId: session.environmentId }
            : {}),
          ...(acceptedModel ? { acceptedModel } : {}),
          ...(session.projectSlug ? { projectSlug: session.projectSlug } : {}),
          ...(session.reportedModel
            ? { reportedModel: session.reportedModel }
            : {}),
          ...(session.effectiveModel
            ? { effectiveModel: session.effectiveModel }
            : {}),
          ...(session.model ? { model: session.model } : {}),
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          ...(session.lastEventAt ? { lastEventAt: session.lastEventAt } : {}),
        };
      },
      canReadSession: (threadId, authority) =>
        this.sessionAuthz.canReadSession(threadId, authority),
      listEvents: (threadId) =>
        (this.options.eventStore?.listEvents(threadId) ?? []).map(
          (event) => event.payload,
        ),
      // Task user-input pinning is event-id exact. Do not substitute a
      // transcript projection or a turn replay: one turn can hold steers.
      userInputEventById: (eventId) => {
        const event = this.options.eventStore?.userInputEventById(eventId);
        return event
          ? {
              ...event,
              attachments: event.attachments.map((attachment) => ({
                name: attachment.name,
                mediaType: attachment.mimeType,
                size: attachment.size,
              })),
            }
          : undefined;
      },
      toolCompletedEventById: (threadId, eventId) =>
        this.options.eventStore?.toolCompletedEventById(threadId, eventId),
      // Basis receives only the exact indexed turn window. SessionQuery never
      // falls back to an unbounded Session replay when this adapter is absent.
      listBasisEventsForTurn: (threadId, turnId) =>
        this.options.eventStore?.listBasisEventsForTurn(threadId, turnId) ?? {
          status: 'over-budget' as const,
        },
      listEventsForTurn: (threadId, turnId) =>
        (
          this.options.eventStore?.listEventsForTurn(
            threadId,
            turnId,
            MAX_ASSISTANT_TURN_EVENTS + 1,
          ) ?? []
        ).map((event) => event.payload),
      projectSlugForSession: (_session, threadId) =>
        this.options.eventStore?.readConversationProjectSlug(threadId),
      reportUnavailable: (query, error) => {
        this.options.logger.warn('Session conversation query is unavailable', {
          intent: query.type,
          threadId: query.threadId,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });
    this.sessionOutputs = createSessionOutputsModule({
      eventStore: this.options.eventStore,
      canReadSession: (threadId, authority) =>
        this.sessionAuthz.canReadSession(threadId, authority),
      // The Session's current owner binding is intentionally resolved only on
      // explicit inspection. It never enters the persisted candidate or list.
      workspaceForSession: (threadId) =>
        this.sessionReadModel.get(threadId)?.cwd ??
        this.options.eventStore?.readSessionByThread(threadId)?.cwd,
      ...(this.options.nativeDeclaredPullRequestResolver
        ? {
            pullRequestResolver: this.options.nativeDeclaredPullRequestResolver,
          }
        : {}),
    });
    this.monitoringBridge = new OrchestrationMonitoringBridge(
      options.monitoringEmitter,
      (threadId) => this.monitoringContextFor(threadId),
    );
    if (options.eventStore) {
      this.conversationHistoryReader = new ConversationHistoryReadService({
        eventStore: options.eventStore,
        canReadSession: (threadId, authority) =>
          this.sessionAuthz.canReadSession(threadId, authority),
        hydratePersistedSession: (threadId) => {
          const persisted = options.eventStore?.readSessionByThread(threadId);
          if (persisted)
            this.sessionAuthz.hydratePersistedTenantContexts([persisted]);
          return persisted;
        },
        loadedSessionForThread: (threadId) =>
          this.sessionReadModel.get(threadId),
        observeAnswerability: (threadId, provider, observedAt) =>
          this.observeAnswerability(threadId, provider, observedAt),
        ownerlessPersonalAccess:
          options.ownerlessSessionAccess === 'single-user-compat',
      });
    }
    // ConversationLineage captures `turnDeduplicator` and
    // `conversationHistoryReader` BY VALUE (slice-3 precedent) — both are
    // assigned above; constructing it earlier would silently capture
    // undefined for both. Nothing mutates `options` post-construction.
    this.conversationLineage = new ConversationLineage({
      ...(options.eventStore ? { eventStore: options.eventStore } : {}),
      logger: options.logger,
      ...(options.resumeCursorSupport
        ? { resumeCursorSupport: options.resumeCursorSupport }
        : {}),
      ...(this.turnDeduplicator
        ? { turnDeduplicator: this.turnDeduplicator }
        : {}),
      ...(this.conversationHistoryReader
        ? { conversationHistoryReader: this.conversationHistoryReader }
        : {}),
      readSession: (threadId, authority) =>
        this.readSession(threadId, authority),
      readSessionMessages: (threadId, authority) =>
        this.readSessionMessages(threadId, authority),
      listSessionReadModel: (authority) => this.listSessionReadModel(authority),
      canReadSession: (threadId, authority) =>
        this.sessionAuthz.canReadSession(threadId, authority),
    });
    this.conversationOpenResolver = createConversationOpenResolver({
      currentSessionId: (conversationId) =>
        this.conversationLineage.currentConversationSessionId(conversationId),
      readCurrent: async ({ conversationId, authority }) => {
        const detail =
          await this.conversationLineage.readCurrentConversationSession(
            conversationId,
            authority,
          );
        if (!detail) return null;
        return {
          messages: this.readSessionMessages(
            detail.session.threadId,
            authority,
          ),
          answerability: detail.session.answerability,
          // Continuation is a server decision over the CURRENT replaceable
          // Session. A historical/nonmutable inventory row, a read-only
          // attachment, an active turn, a pending review, or a stopped child
          // does not become writable merely because the selected Agent has a
          // provider today.
          canContinue: canResolveConversationContinuation(detail),
        };
      },
      reportUnavailable: (error) =>
        options.logger.warn('Conversation open resolution is unavailable', {
          error: error instanceof Error ? error.message : String(error),
        }),
    });
    this.flowPolicy = new FlowPolicySidecar({
      flowRunService: () => options.flowRunService,
      veritasReadinessService: () => options.veritasReadinessService,
      agentPolicyService: () => options.agentPolicyService,
      workflowSidecarService: () => options.workflowSidecarService,
      publishEvent: (event) => {
        this.projectAndPublishEvent(event);
      },
      // The SERVICE forwarder: keeps the T9 latch in the composed path.
      readSession: (threadId, authority) =>
        this.readSession(threadId, authority),
      runtimeKindFor: (provider) => this.runtimeKindFor(provider),
      engineExecutionForAdapter: (adapter) =>
        engineExecutionForAdapter(adapter),
      latestEventPayloadByMethod: (threadId, method) =>
        this.options.eventStore?.latestEventByMethod(threadId, method)?.payload,
      logger: options.logger,
    });
    this.credentialProfileRecovery = new CredentialProfileRecovery({
      dispatchSendTurn: (replay) =>
        this.dispatch({ type: 'sendTurn', input: replay }),
      providerAcceptsResponse: (provider) =>
        this.options.adapterRegistry.get(provider)?.metadata.recovery
          ?.dispatchSettlement === 'provider-response',
      interruptRecoveredTurn: (input) => this.interruptRecoveredTurn(input),
      restartProviderSession: (input) =>
        this.restartCredentialProfileProviderSession(input),
      reportRedispatchFailed: (threadId, turnId, provider) =>
        this.internalStops.reportRedispatchFailed(threadId, turnId, provider),
      onTurnDispatched: (input) =>
        this.monitoringBridge.onTurnDispatched(input),
      forgetCoalescedThread: (threadId) =>
        this.deltaCoalescer.forgetThread(threadId),
      markThreadQuarantined: (threadId) => {
        this.quarantinedThreads.add(threadId);
      },
      sessionAdapterFor: (threadId) => this.sessionAdapters.get(threadId),
      loadedProviderFor: (threadId) =>
        this.sessionReadModel.get(threadId)?.provider,
      providerForThread: (threadId) => this.threadProviders.get(threadId),
      // The divergent teardown flags are declared HERE, not in the module:
      // the slice-2 source invariant scans only this file and pins all six
      // flagged forgetThreadState call sites (quarantine's row is first in
      // the seam docblock table, and this ctor site keeps that order).
      forgetThreadState: (threadId) =>
        this.forgetThreadState(threadId, {
          policyThreads: true,
          flowBoundThreads: true,
        }),
      markSessionClosed: (threadId, provider) => {
        this.options.eventStore?.markSessionClosed(threadId, provider);
      },
      logger: options.logger,
    });
    this.interruptedTurns = new InterruptedTurnRecovery({
      // Lazy: the store is optional and may be swapped after construction.
      eventStore: () => this.options.eventStore,
      // The Map is absorbed HERE so the module never holds a handle (T13).
      memoryAdapterFor: (agentSlug) =>
        this.options.memoryAdapters?.get(agentSlug),
      // Boolean, NOT void: the module's M4 refusal branch reads it.
      publishEvent: (event) => this.projectAndPublishEvent(event),
      logger: this.options.logger,
    });
    this.turnProvenance = new TurnProvenanceSidecar({
      eventStore: () => this.options.eventStore,
      logger: this.options.logger,
    });
    this.adapterRetirement = new AdapterRetirement({
      // Lazy: the LIVE option, read at each deadline.
      configuredStopTimeoutMs: () => this.options.adapterStopTimeoutMs,
      // A named dep, never a move: this method is one of the six
      // `forgetThreadState` sites the T10(3) source invariant counts in
      // THIS file, so it must stay here.
      finalizeStoppedAdapterSessions: (adapter, sessions, reason) =>
        this.finalizeStoppedAdapterSessions(adapter, sessions, reason),
      logger: this.options.logger,
    });
    this.connectionSmoke = new ConnectionSmoke({
      // The PUBLIC dispatch — it carries its own initialize() latch and is
      // the only entry point accepting the third `internal` argument the
      // smoke's systemPrompt/profile selection needs (see
      // `dispatchWithReceipt`'s docblock).
      dispatch: (command, context, internal) =>
        this.dispatch(command, context, internal),
      listEventPayloads: (threadId) =>
        (this.options.eventStore?.listEvents(threadId) ?? []).map(
          (item) => item.payload,
        ),
      // The SERVICE forwarder, never `transcriptReads` directly: it carries
      // the T9 latch, so the composition is byte-identical to in-service.
      readSessionMessages: (threadId, authority) =>
        this.readSessionMessages(threadId, authority),
      // The bounded-await helpers moved to AdapterRetirement (slice 12);
      // ConnectionSmoke is one of the two callers that are not retirements.
      // Still lazy arrows: the module reads the LIVE
      // `options.adapterStopTimeoutMs` at call time.
      adapterStopTimeoutMs: () => this.adapterRetirement.adapterStopTimeoutMs(),
      runCleanupWithinDeadline: (cleanup, label, deadlineAt) =>
        this.adapterRetirement.runCleanupWithinDeadline(
          cleanup,
          label,
          deadlineAt,
        ),
      runOperationWithinDeadline: (operation, label, deadlineAt) =>
        this.adapterRetirement.runOperationWithinDeadline(
          operation,
          label,
          deadlineAt,
        ),
      adapterFor: (provider) => this.options.adapterRegistry.get(provider),
      // C7's ONE raw read, as a named boolean — never a Map handle (T13).
      hasThreadProvider: (threadId) => this.threadProviders.has(threadId),
      // Deliberately never rescinded on this path; see the module docblock.
      armInternalStop: (threadId) => {
        this.internalStops.arm(threadId);
      },
      deleteThread: (threadId) => {
        this.options.eventStore?.deleteThread(threadId);
      },
      invalidateSessionOwner: (threadId) => {
        this.sessionAuthz.invalidateSessionOwner(threadId);
      },
    });
    this.cooperativeStop = new CooperativeStop({
      // Called, not captured: reads the LIVE options value per stop.
      configuredBudgetMs: () => this.options.cooperativeStopBudgetMs,
      listSessionProjectionEvents: (threadId) =>
        (
          this.options.eventStore?.listSessionProjectionEvents(threadId) ?? []
        ).map((stored) => stored.payload),
      sessionAdapterFor: (threadId) => this.sessionAdapters.get(threadId),
      publishEvent: (event) => {
        this.projectAndPublishEvent(event);
      },
      assertAdapterCurrentAfterCommand: (adapter) =>
        this.assertAdapterCurrentAfterCommand(adapter),
      loadedOrPersistedSession: (threadId) =>
        this.sessionReadModel.get(threadId) ??
        this.options.eventStore?.readSessionByThread(threadId),
      persistedSession: (threadId) =>
        this.options.eventStore?.readSessionByThread(threadId),
      upsertLoadedSession: (threadId, session) => {
        this.sessionReadModel.set(threadId, session);
      },
      upsertSession: (session) => {
        this.options.eventStore?.upsertSession(session);
      },
      // The divergent teardown flags are declared HERE, not in the module
      // (slice-2 source invariant, T10(3)): the scan reads only this file,
      // and an inline literal is the only form it can see. This is the
      // SECOND ctor-declared seam site; CredentialProfileRecovery's sorts
      // first and this one second, mirrored by the docblock table's first
      // two rows.
      forgetThreadState: (threadId) =>
        this.forgetThreadState(threadId, {
          policyThreads: true,
          turnProgress: true,
        }),
      logger: options.logger,
    });
    if (options.eventStore) {
      const recoveryDispatchAdapter = this.createRecoveryDispatchAdapter();
      const recoveryLedger = options.eventStore.createRecoveryLedger({
        credentialStartup: {
          inspect: (input) =>
            options.credentialProfileRecoveryAdapter?.inspectStartup?.(input) ??
            Promise.resolve({ kind: 'indeterminate' as const }),
          settle: (input) =>
            options.credentialProfileRecoveryAdapter?.settleStartup?.(input) ??
            Promise.resolve({ kind: 'indeterminate' as const }),
          acknowledge: async (input) =>
            (await options.credentialProfileRecoveryAdapter?.acknowledgeStartup?.(
              input,
            )) ?? { kind: 'unavailable' as const },
        },
      });
      if (options.credentialProfileRecoveryAdapter) {
        this.credentialRecovery = createCredentialRecoveryModule({
          ledger: recoveryLedger,
          adapter: options.credentialProfileRecoveryAdapter,
          dispatchAdapter: recoveryDispatchAdapter,
          restoreSession: async (input) =>
            this.credentialProfileRecovery.restoreSession(input),
          quarantineSession: async (threadId) =>
            this.quarantineCredentialProfileRecoverySession(threadId),
          setRestarting: (threadId, restarting) =>
            this.credentialProfileRecovery.setRestarting(threadId, restarting),
          now: () => new Date(),
        });
      }
      this.recoveryCoordinator = new SessionRecoveryCoordinator({
        eventStore: options.eventStore,
        recoveryLedger,
        recoveryDispatchAdapter,
        adapterForProvider: (provider) =>
          this.options.adapterRegistry.get(provider),
        credentialRecovery: this.credentialRecovery,
        isCredentialRestarting: (threadId) =>
          this.credentialProfileRecovery.isRestarting(threadId),
        onOutcome: ({ failureKind, decision, outcome }) => {
          this.usageTelemetry?.trackSessionRecovery({
            failure_kind: failureKind,
            decision,
            outcome,
          });
        },
      });
    }
  }

  setUsageTelemetry(usageTelemetry: UsageTelemetryObserver | undefined): void {
    this.usageTelemetry = usageTelemetry;
  }

  initialize(): void {
    if (this.started) return;
    this.started = true;
    this.adoption.registerOwner();

    this.consumeCurrentAdapterEvents();
    this.adapterRegistryUnsubscribe = this.options.adapterRegistry.onChange?.(
      () => this.consumeCurrentAdapterEvents(),
    );

    void this.adoption
      .startReconciliation()
      .then(() => this.recoverSessions())
      .catch((error) => {
        // Both upstream steps do unguarded durable reads
        // (`adoptionLedger.reservations()`, `readSessions()`), so this chain can
        // reject. On `main` that only produced an unhandled rejection; since
        // archive#1779 it would ALSO leave `sessionAttachmentSettled` false
        // for the process lifetime — a permanent fail-open — and skip
        // `recoveryCoordinator.reconcile()` entirely. Caught and logged so
        // the `finally` below always runs.
        this.options.logger.warn(
          'Session recovery did not complete; attachment settles on whatever this process reached',
          { error: error instanceof Error ? error.message : String(error) },
        );
      })
      .finally(() => {
        // archive#1745: `sessionAdapters` now reflects every thread this
        // process actually re-attached (or failed to), which is the ONE
        // input `projectRequestAnswerability` cannot honestly guess at
        // before this point. Until it is set, that projection answers
        // `answerable` for everything — see `sessionAttachmentSettled`.
        //
        // SETTLED EVEN ON FAILURE, deliberately. The alternative — hold the
        // window open when recovery throws — sounds conservative and is
        // strictly worse: the fail-open then never closes, so a genuinely
        // stranded approval is shown forever, and `reconcile()` never runs.
        //
        // The residual is real and is bounded rather than argued away: a
        // thread recovery had not yet reached reads `detached`, and an earlier
        // version of this comment claimed that was harmless because "a
        // `past_resume` session cannot be answered by anyone". That is FALSE
        // and this file's own predicate says so — `projectRequestAnswerability`
        // checks attachment FIRST and unconditionally, precisely because a
        // thread this process is holding can answer its own requests whatever
        // its log folds to (pinned by the liveness-guard test). So the honest
        // statement is: the residual is confined to sessions recovery had not
        // reached before it threw, and it is strictly smaller than a permanent
        // fail-open, which is the only other option.
        //
        // archive#1284's startup orphan-reconciliation pass used to run
        // here, behind a `providerRegistrationSettled` barrier, and it is
        // gone: the barrier existed only because the pass WROTE an
        // irreversible cancellation, and there is nothing irreversible left
        // to order. `recoveryCoordinator.reconcile()` — which never had any
        // dependency on plugin registration — is no longer delayed behind
        // plugin asset loading as a side effect of guarding a fact it does
        // not read.
        this.sessionAttachmentSettled = true;
        receiptBus.publish({ kind: 'session.attachment.settled' });
        try {
          this.recoveryCoordinator?.reconcile();
        } catch (error) {
          // Startup recovery is intentionally fire-and-forget. A store may
          // have been retired while its final settlement microtask was still
          // queued; never turn that teardown race into an unhandled process
          // rejection after attachment state has already settled.
          this.options.logger.warn(
            'Recovery-intent reconciliation did not complete after session attachment settled',
            { error: error instanceof Error ? error.message : String(error) },
          );
        }
        // archive#4080: after recovered sessions are tracked, so a
        // thread's provider/owner can resolve the same way any other
        // post-recovery read of it does. Fire-and-forget, like the
        // recovery-intent reconciliation just above — a failure here must
        // never surface as an unhandled rejection after attachment state
        // has already settled; unwritten banners simply retry next boot.
        void this.interruptedTurns.consume().catch((error) => {
          this.options.logger.warn(
            'Interrupted-turn boundary consumption did not complete',
            { error: error instanceof Error ? error.message : String(error) },
          );
        });
      });
  }

  /**
   * The process-local half of the answerability decoration (archive#1778):
   * what THIS process, right now, knows about a session's thread and its
   * provider's adapter. `buildOrchestrationSessionSummary` supplies the
   * third input (the folded lifecycle state) and calls the one predicate.
   *
   * Nothing is written and nothing is cancelled. Every read recomputes it, so
   * the case that forced the old `providerRegistrationSettled` barrier — a
   * plugin whose adapter registers after boot ordering says it should have —
   * self-heals on the next read instead of needing a happens-before nobody
   * can enforce.
   *
   * `observedAt` is passed in rather than read here so that every summary in
   * ONE list read carries ONE observation timestamp: the list is one
   * observation of this process's state, not N of them, and a client
   * comparing rows should not see them drift apart by microseconds.
   */
  private observeAnswerability(
    threadId: string,
    /**
     * Absent only where the session record itself is absent, which
     * `buildOrchestrationSessionSummary` rejects outright — so this is not a
     * fallback that decides anything, and "no provider named" honestly maps
     * to "no adapter registered for it".
     */
    provider: string | undefined,
    observedAt: string,
  ): SessionAnswerabilityObservation {
    return {
      threadAttachment: !this.sessionAttachmentSettled
        ? 'unknown'
        : this.sessionAdapters.has(threadId)
          ? 'attached'
          : 'detached',
      providerRegistered:
        provider !== undefined &&
        this.options.adapterRegistry.get(provider) !== undefined,
      observedBy: servingInstanceIdentity(),
      observedAt,
    };
  }

  private createRecoveryDispatchAdapter(): RecoveryDispatchAdapter {
    return this.credentialProfileRecovery.createDispatchAdapter();
  }

  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: retained for test reach-ins (T6, slice 7 — 4 cast sites reach this name; the runtime path lives in CredentialProfileRecovery).
  private restartCredentialProfileRecoverySession(
    input: Parameters<CredentialProfileRecovery['restartRecoverySession']>[0],
  ): Promise<{ turnId: string }> {
    return this.credentialProfileRecovery.restartRecoverySession(input);
  }

  // Kept deliberately asymmetric with `restoreSession` (rewired direct):
  // the ctor's quarantineSession closure routes through THIS forwarder, and
  // that in-file caller is what keeps biome's unsafe pass from deleting a
  // method 5 tests cast to. Do not "finish the job" by making it symmetric.
  private quarantineCredentialProfileRecoverySession(
    threadId: string,
  ): Promise<void> {
    return this.credentialProfileRecovery.quarantineSession(threadId);
  }

  /**
   * Recovery-compensation interrupt (C6a's execution half — slice 7 kept
   * adapter resolution and both adapter-currency asserts beside the
   * registry and the thread index, as one collapsed dep).
   */
  private async interruptRecoveredTurn({
    threadId,
    turnId,
  }: {
    threadId: string;
    turnId?: string;
  }): Promise<void> {
    const adapter = await resolveOrchestrationAdapterForThread({
      threadId,
      threadProviders: this.threadProviders,
      requireAdapter: (provider) => this.requireAdapter(provider),
      adapters: this.options.adapterRegistry.list(),
    });
    this.assertAdapterCurrent(adapter);
    await adapter.interruptTurn(threadId, turnId);
    this.assertAdapterCurrentAfterCommand(adapter);
  }

  /**
   * Server-owned lifecycle interruption for bounded unattended work. The
   * caller cannot name a provider or a turn: the persisted thread identity
   * resolves both, preserving the same adapter-currency checks as recovery.
   */
  async interruptTurn(threadId: string): Promise<void> {
    await this.interruptRecoveredTurn({ threadId });
  }

  /**
   * archive#3525 fix round FIX 1: `armedInternalStopTurnId` in the return
   * value is `undefined` when no turn was open to suppress, and otherwise
   * names the turn id `internalStops.arm` armed BEFORE the
   * `stopSession` below — every caller of this method is responsible for
   * rescinding it (`internalStops.rescind`) once it knows whether a
   * real re-dispatch actually followed. This method rescinds it itself for
   * failures within its OWN body (probe-proven: `adapter.startSession`
   * rejecting left the suppression armed with nothing ever going on to
   * consume it, silently swallowing the "needs attention" push for a
   * credential restart that never actually replayed anything).
   */
  private async restartCredentialProfileProviderSession(input: {
    threadId: string;
    signal: AbortSignal;
    modelId?: string;
    credentialProfileRef?: string;
  }): Promise<{
    adapter: ProviderAdapterShape;
    armedInternalStopTurnId?: string;
  }> {
    const existing = this.sessionReadModel.get(input.threadId);
    if (!existing) {
      throw new Error('Credential profile recovery session is unavailable.');
    }
    // archive#3476: resolve by the session's own persisted provider rather
    // than by probing every adapter for a live thread. This path REPLACES the
    // provider process wholesale, so it must work for a session restored at
    // boot with no engine behind it — boot reconciliation reaches here via
    // `CredentialProfileRecovery.restoreSession`, and a throw there quarantines
    // the session (which closes it, destroying `resumeCursor`). Starting an
    // engine only to stop it again would be the alternative, and would be
    // absurd.
    const adapter = this.requireAdapter(existing.provider);
    this.threadProviders.set(input.threadId, adapter.provider);
    let armedInternalStopTurnId: string | undefined;
    if (await adapter.hasSession(input.threadId)) {
      // archive#3525: this stop tears down mid-turn, and the caller may
      // re-dispatch the SAME turn afterward — an internal retry, not a
      // user-visible failure, PROVIDED the rest of this restart (and the
      // caller's own follow-up) actually succeeds. The `catch` below (and
      // each caller's own handling of the returned id) is what keeps this
      // conditional rather than a standing promise nothing redeems.
      armedInternalStopTurnId = this.internalStops.arm(input.threadId);
      try {
        await adapter.stopSession(input.threadId);
      } catch (error) {
        // archive#3525 fix round MEDIUM 1: `stopSession` rejecting gets its
        // OWN try/catch, separate from the restart's remaining steps below —
        // a single shared catch could not distinguish "torn down, then the
        // retry failed" (a genuine redispatch failure) from "the teardown
        // itself failed" (possibly no failure to report at all).
        //
        // Rescind WITHOUT emitting `INTERNAL_STOP_REDISPATCH_FAILED` here.
        // This is safe because BOTH recovery-capable adapters that can reach
        // this catch retain the session on a failed stop: codex's real
        // `stopSession` rethrows when `terminateRecord` fails, restores
        // `record.stopped = false`, and never reaches
        // `publishOrphanedTurnFailure` — the turn is still running, and will
        // publish its own genuine terminal through the normal pipeline when
        // it actually ends. Muse's real `stopSession` throws when
        // termination is unconfirmed and explicitly "retain[s] both the
        // session and the original child handle" rather than settling the
        // turn — same shape. Emitting anyway would be a FALSE "needs
        // attention" for a turn that never stopped, and if it then completes
        // normally, the notification dedupe-update path silently rewrites
        // that row without ever sending a correcting push — the exact shape
        // `resolveTurnCompletionOutcome`'s own comment names as the reason
        // to defer rather than guess ("a subsequent success can never
        // recall" an already-delivered alarm).
        //
        // NOT true of every adapter in general: claude's `stopSession`
        // deletes the session and publishes `session.exited` FIRST, then
        // best-effort cleans up skills overlays (swallowing that cleanup's
        // own failures) — teardown completes before any later throw could
        // occur, so "nothing was stopped" would be the wrong claim for it.
        // Left as-is rather than special-cased: a turn stopped through that
        // path never had a turn-scoped terminal to alarm about in the first
        // place (only `session.exited` with no `turnId`), which is the
        // pre-existing scope boundary `resolveTurnCompletionOutcome`'s own
        // doc already declares this listener does not cover — so rescinding
        // without emitting is still correct, just for a different reason
        // (there was never anything to correct) than the codex/muse case
        // (there is, but it must wait for a real terminal).
        this.internalStops.rescind(armedInternalStopTurnId);
        throw error;
      }
    }
    try {
      throwIfAborted(input.signal);
      const tenantExecutionContext =
        this.sessionAuthz.tenantContextFor(input.threadId) ??
        existing.tenantExecutionContext;
      // A credential-profile retry is a fresh provider process, not a
      // continuation of its old SDK instance. Reconstruct the same server-owned
      // session-start identity that normal recovery uses, then route it through
      // the canonical resolver before the adapter starts. In particular, the
      // persisted delegation is an input to Claude's staged PreToolUse policy;
      // omitting it here would let a credential retry bypass that policy.
      const persistedMetadata = this.readLatestSessionStartMetadata(
        input.threadId,
      );
      let startInput: ProviderSessionStartInput = {
        threadId: input.threadId,
        provider: adapter.provider,
        cwd: existing.cwd,
        modelId: input.modelId ?? existing.model,
        resumeCursor: existing.resumeCursor,
        persistSession: existing.persistSession,
        ...(persistedMetadata
          ? { metadata: persistedMetadata }
          : this.sessionConnectionIds.has(input.threadId)
            ? {
                metadata: {
                  connectionId: this.sessionConnectionIds.get(input.threadId),
                },
              }
            : {}),
        ...(tenantExecutionContext ? { tenantExecutionContext } : {}),
        ...(input.credentialProfileRef
          ? { credentialProfileRef: input.credentialProfileRef }
          : {}),
        signal: input.signal,
      };
      // Do not degrade to an unresolved adapter start here. Unlike cold session
      // recovery, this path immediately replays a turn; a resolver failure must
      // keep the replay fail-closed so no engine runs it without its authored
      // policy context (for Claude, that context is PreToolUse).
      startInput = await this.resolveSessionAgentForStart(startInput);
      throwIfAborted(startInput.signal);
      const admissionLease = await admitEngineStartForIntent(
        this.options.resourcePosture,
        this.options.logger,
        'recovery',
        { binding: input.threadId },
      );
      let session: ProviderSession;
      try {
        session = await withTenantExecutionContext(tenantExecutionContext, () =>
          adapter.startSession(startInput),
        );
      } finally {
        admissionLease?.release();
      }
      this.trackSession(session, adapter);
      this.options.eventStore?.upsertSession(session);
      return { adapter, armedInternalStopTurnId };
    } catch (error) {
      this.internalStops.reportRedispatchFailed(
        input.threadId,
        armedInternalStopTurnId,
        adapter.provider,
      );
      throw error;
    }
  }

  /**
   * Resolve the canonical session agent and enforce the authored-spec start
   * gate in one place for both ordinary starts and credential restarts.
   * archive#3027 made the gate symmetric across every delivery-capable
   * engine — claude, codex, muse, and every ACP-dispatched engine alike —
   * with no resume grandfathering: a cold resume of an existing thread is
   * gated exactly like a fresh start (boot recovery and live-session
   * reattach never enter this path and stay best-effort). Starts without a
   * server-owned agent slug remain genuinely agent-less.
   */
  private async resolveSessionAgentForStart(
    input: ProviderSessionStartInput,
    admission?: ForegroundInvocationAdmission,
  ): Promise<ProviderSessionStartInput> {
    const agentSlug = input.metadata?.agentSlug;
    if (
      admission &&
      (agentSlug !== admission.agentId ||
        (input.provider === 'station-agent') !==
          !admission.agentSpec.execution?.agentConnectionId ||
        (input.provider === 'station-agent'
          ? Boolean(admission.agentSpec.execution?.agentConnectionId)
          : !sessionDeliveryChannels(input.provider) ||
            !this.options.resolveSessionAgent))
    )
      throw new ForegroundInvocationUnavailableError();
    const captured = admission
      ? { agentId: admission.agentId, spec: admission.agentSpec }
      : undefined;
    const withCredentialProfile = await this.applyAgentCredentialProfileRef(
      captured ? { ...input, agent: undefined } : input,
      captured?.spec,
    );
    const resolved = this.options.resolveSessionAgent
      ? await this.options.resolveSessionAgent(withCredentialProfile, captured)
      : withCredentialProfile;
    const unavailableReason = sessionAgentStartUnavailableReason({
      provider: input.provider,
      agentSlug,
      // Providers with no session-delivery concept — Station's own engine
      // and the managed model runtimes, for which `sessionDeliveryChannels`
      // returns undefined (derived from the capability matrix, never a
      // provider name list) — load authored specs themselves, and the
      // session resolver deliberately no-ops for them. An unattached
      // definition there is not a missing spec, so they are not gated here.
      hasResolvedAgent:
        Boolean(resolved.agent) ||
        sessionDeliveryChannels(input.provider) === undefined,
    });
    if (unavailableReason) throw new Error(unavailableReason);
    await this.turnProgress.setWindow(
      input.threadId,
      agentSlug,
      captured ? { execution: captured.spec.execution } : undefined,
    );
    if (captured) {
      return {
        ...resolved,
        metadata: {
          ...resolved.metadata,
          ...(admission?.source
            ? {
                [WORKSPACE_PANE_HOST_ACTION_METADATA_KEY]: {
                  ...admission.source,
                },
              }
            : {}),
          [SESSION_AGENT_DISPLAY_NAME_METADATA_KEY]: captured.spec.name.slice(
            0,
            SESSION_AGENT_DISPLAY_NAME_MAX_LENGTH,
          ),
          ...(captured.spec.icon &&
          isSupportedAgentIconToken(captured.spec.icon)
            ? { [SESSION_AGENT_ICON_METADATA_KEY]: captured.spec.icon }
            : {}),
        },
      };
    }
    return await this.withSessionAgentPresentation(resolved);
  }

  private async withSessionAgentPresentation(
    input: ProviderSessionStartInput,
  ): Promise<ProviderSessionStartInput> {
    const metadata = input.metadata ?? {};
    const hasSnapshot =
      Object.hasOwn(metadata, SESSION_AGENT_DISPLAY_NAME_METADATA_KEY) ||
      Object.hasOwn(metadata, SESSION_AGENT_ICON_METADATA_KEY);
    // Recovery must preserve the old immutable snapshot. A legacy resumed
    // session with no snapshot stays unresolved rather than borrowing the
    // Agent's current mutable presentation.
    if (hasSnapshot || input.resumeCursor !== undefined) return input;
    const agentSlug = metadata.agentSlug;
    if (
      typeof agentSlug !== 'string' ||
      !agentSlug ||
      !this.options.loadAgentPresentation
    ) {
      return input;
    }
    try {
      const presentation = await this.options.loadAgentPresentation(agentSlug);
      if (!presentation) return input;
      const name = presentation.name.trim();
      const icon = presentation.icon?.trim();
      return {
        ...input,
        metadata: {
          ...metadata,
          ...(name
            ? {
                [SESSION_AGENT_DISPLAY_NAME_METADATA_KEY]: name.slice(
                  0,
                  SESSION_AGENT_DISPLAY_NAME_MAX_LENGTH,
                ),
              }
            : {}),
          ...(icon && isSupportedAgentIconToken(icon)
            ? {
                [SESSION_AGENT_ICON_METADATA_KEY]: icon,
              }
            : {}),
        },
      };
    } catch (error) {
      this.options.logger.warn(
        'Session Agent presentation snapshot could not be loaded; continuing without mutable identity fallback',
        {
          threadId: input.threadId,
          agentSlug,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return input;
    }
  }

  /**
   * archive#3530: apply the session agent's own `execution.credentialProfileRef`
   * so an agent can name WHICH account of its engine it runs on.
   *
   * Both ordinary starts and credential restarts route through
   * `resolveSessionAgentForStart`, so placing it here covers both without a
   * second call site.
   *
   * An explicit per-call ref always wins and is never overwritten — credential
   * recovery supplies one deliberately (`restartCredentialProfileProviderSession`),
   * and a retry that silently ignored the candidate it was told to try would
   * defeat the whole recovery mechanism. This only ever FILLS an absent value.
   *
   * Everything else degrades to today's behavior byte-identically: no agent
   * slug, no resolver seam, an agent with no pin, or a load failure all leave
   * the input untouched, and `getAppHomeEnv` then resolves the connection's
   * own active profile exactly as before. A load failure is deliberately NOT
   * fatal here — it means "this agent expressed no preference", not "this
   * agent demanded an account we could not honor". The fail-closed half lives
   * where a profile is actually applied: `getAppHomeEnv` throws when a
   * SELECTED profile cannot be prepared, so a pin that resolves but cannot be
   * materialized still fails the start rather than running on another account.
   */
  private async applyAgentCredentialProfileRef(
    input: ProviderSessionStartInput,
    captured?: AgentSpec,
  ): Promise<ProviderSessionStartInput> {
    if (captured) {
      const ref = captured.execution?.credentialProfileRef;
      if (
        input.credentialProfileRef !== undefined &&
        input.credentialProfileRef !== ref
      ) {
        throw new ForegroundInvocationUnavailableError();
      }
      return ref ? { ...input, credentialProfileRef: ref } : input;
    }
    if (input.credentialProfileRef) return input;
    const agentSlug = input.metadata?.agentSlug;
    if (typeof agentSlug !== 'string' || !agentSlug) return input;
    if (!this.options.loadAgentExecutionConfig) return input;
    try {
      const execution = await this.options.loadAgentExecutionConfig(agentSlug);
      const ref = execution?.credentialProfileRef;
      if (typeof ref !== 'string' || !ref.trim()) return input;
      return { ...input, credentialProfileRef: ref };
    } catch (error) {
      // Independent review (Codex), HIGH: continuing here silently ran a
      // PINNED agent on whatever account the connection happens to select.
      // The load failing does not mean the agent expressed no preference — it
      // means we do not know whether it did, and those are different facts.
      // The contract on `AgentExecutionConfig.credentialProfileRef` promises
      // fail-closed account attribution, and a turn billed to and attributed
      // to the wrong account is exactly what it promises cannot happen.
      //
      // This deliberately fails a start that would previously have succeeded.
      // That is the correct direction for a credential decision: an erroring
      // agent store is rare and loud, while a turn on the wrong account is
      // silent and unrecoverable.
      (this.options.logger?.warn as ((...a: unknown[]) => void) | undefined)?.(
        `Credential profile: could not read the agent's execution config, so the account it runs on is unknown: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new Error(
        "The agent's execution configuration could not be read, so Station cannot tell which account this session should use.",
      );
    }
  }

  private consumeCurrentAdapterEvents(): void {
    const currentAdapters = new Map(
      this.options.adapterRegistry
        .list()
        .map((adapter) => [adapter.provider, adapter]),
    );
    for (const [provider, adapter] of this.activeEventAdapters) {
      if (currentAdapters.get(provider) !== adapter) {
        const retiredSessions = this.captureAdapterSessions(adapter);
        this.activeEventAdapters.delete(provider);
        this.stopAdapterEventConsumer(adapter);
        this.adapterRetirement.retire(adapter, retiredSessions);
      }
    }
    for (const adapter of currentAdapters.values()) {
      this.activeEventAdapters.set(adapter.provider, adapter);
      if (
        this.adapterEventControllers.has(adapter) ||
        this.consumedAdapterEventStreams.has(adapter)
      ) {
        continue;
      }
      const controller = new AbortController();
      this.consumedAdapterEventStreams.add(adapter);
      this.adapterEventControllers.set(adapter, controller);
      void this.consumeAdapterEvents(adapter, controller);
    }
  }

  /**
   * Public surface with external callers (runtime routes, and five plugin
   * files that thread it as a bare `() => Promise<void>` — a rename here is
   * invisible to a grep of this file). Retained as a forwarder; the engine
   * moved to AdapterRetirement in slice 12.
   */
  async settleProviderAdapterRetirements(): Promise<void> {
    return this.adapterRetirement.settleRetirements();
  }

  async shutdown(): Promise<void> {
    // Revoke private native-output scopes before any provider cleanup. A
    // stop/retirement rejection must not leave a callback capable of
    // admitting output while this service is already shutting down.
    this.nativeOutputGrants.dispose();
    this.nativeOutputTurnGenerations.clear();
    // A delta still buffered is text the model produced and nobody saw.
    // Flush before anything else here can tear the publish path down —
    // guarded, because this runs first and a failed final publish must not
    // cost the watchdog timers and the recovery coordinator their disposal.
    try {
      this.deltaCoalescer.flushAll();
    } catch (error) {
      this.options.logger.warn('Final content delta flush failed at shutdown', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // archive#2959: never leave a watchdog timer outliving this service.
    this.turnProgress.dispose();
    await this.recoveryCoordinator?.dispose();
    this.adapterRegistryUnsubscribe?.();
    this.adapterRegistryUnsubscribe = undefined;
    const currentAdapters = this.options.adapterRegistry.list();
    const currentSessions = new Map(
      currentAdapters.map((adapter) => [
        adapter,
        this.captureAdapterSessions(adapter),
      ]),
    );
    for (const adapter of this.adapterEventControllers.keys()) {
      this.stopAdapterEventConsumer(adapter);
    }
    // Both reads happen at THIS synchronous tick with no await between
    // them: inserting one changes which adapters the second arm
    // double-stops. Pinned by a source invariant.
    const retiringAdapters = this.adapterRetirement.retiringAdapters();
    const cleanupResults = await Promise.allSettled([
      ...this.adapterRetirement.shutdownRetirementTasks(),
      ...currentAdapters
        .filter((adapter) => !retiringAdapters.has(adapter))
        .map((adapter) =>
          this.adapterRetirement.runCleanupWithinDeadline(async () => {
            await adapter.stopAll();
            this.finalizeStoppedAdapterSessions(
              adapter,
              currentSessions.get(adapter) ?? new Map(),
              'orchestration_shutdown',
            );
          }, `${adapter.provider} adapter shutdown`),
        ),
    ]);
    this.activeEventAdapters.clear();
    this.adoption.unregisterOwner();
    const failures = cleanupResults.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Provider adapter shutdown failed.');
    }
  }

  /**
   * archive#980 Wave 0 (AC3 defensive guard): `station-agent` is the private
   * orchestration adapter that relays managed-agent chat through
   * `/api/agents/:slug/chat` (`withPrivateOrchestrationAdapter`,
   * `orchestration-adapter-registry.ts`) — it is dispatchable (`get`) but
   * must never surface as a selectable engine/connection. That wrapper's
   * `list()` unconditionally appends the private adapter, so this is the one
   * place to filter it back out before any inventory-shaped read (this
   * method backs `GET /api/orchestration/providers`, the closest thing to a
   * generic "provider inventory" surface). Today's New Chat/engine pickers
   * are built from agents + engine connections, not this endpoint (audited
   * archive#980), so this is currently a no-op in practice — kept anyway as
   * the guard against a future caller reading this list for inventory.
   */
  async listProviders(
    authority: SessionReadScope,
  ): Promise<OrchestrationProviderSummary[]> {
    this.initialize();
    const providers = await Promise.all(
      this.options.adapterRegistry
        .list()
        .filter((adapter) => adapter.provider !== 'station-agent')
        .map(async (adapter) => {
          const [sessions, prerequisites] = await Promise.all([
            adapter.listSessions(),
            this.readPrerequisites(adapter),
          ]);
          for (const session of sessions) this.trackSession(session, adapter);
          return {
            provider: adapter.provider,
            prerequisites,
            activeSessions: sessions.filter((session) =>
              this.sessionAuthz.canReadSession(session.threadId, authority),
            ).length,
          };
        }),
    );

    return providers.sort((a, b) => a.provider.localeCompare(b.provider));
  }

  async getProviderCommands(provider: EngineId): Promise<
    Array<{
      name: string;
      description: string;
      argumentHint?: string;
      passthrough: boolean;
    }>
  > {
    const adapter = this.options.adapterRegistry.get(provider);
    if (!adapter) return [];
    return (await adapter.getCommands?.()) ?? [];
  }

  /**
   * Narrow capability query for the independent-review composition root.
   * The caller cannot select or mint a sandbox policy through this Interface;
   * it can only refuse an Adapter that lacks the reviewed native guarantee.
   */
  supportsReadOnlyReview(provider: EngineId): boolean {
    return (
      this.options.adapterRegistry.get(provider)?.metadata.reviewIsolation ===
      'read-only'
    );
  }

  async getProviderModels(
    provider: EngineId,
    options?: { signal?: AbortSignal },
  ): Promise<
    Array<{
      id: string;
      name: string;
      originalId: string;
    }>
  > {
    const adapter = this.options.adapterRegistry.get(provider);
    if (!adapter) return [];
    const models = await listLaunchableAdapterModels(adapter, options);
    // archive#977: an empty live/cached catalog (unreachable engine, no
    // cache yet) shouldn't leave the model picker empty for an external
    // engine that ships a known-models fallback — keeps the picker
    // consistent with the launchability gate's own fallback below.
    return models.length ? models : knownModelsCatalog(adapter);
  }

  async listSessions(authority: SessionReadScope): Promise<ProviderSession[]> {
    this.initialize();
    const sessionsByAdapter = await Promise.all(
      this.options.adapterRegistry.list().map(async (adapter) => ({
        adapter,
        sessions: await adapter.listSessions(),
      })),
    );
    const sessions: ProviderSession[] = [];
    for (const entry of sessionsByAdapter) {
      for (const session of entry.sessions) {
        this.trackSession(session, entry.adapter);
        if (
          !this.isEphemeralSession(session.threadId) &&
          this.sessionAuthz.canReadSession(session.threadId, authority)
        ) {
          // Tenant authority is server execution state, never a provider
          // session API field. Keep it available to the private read model
          // through `trackSession`, but do not return it to callers.
          const {
            tenantExecutionContext: _tenantExecutionContext,
            ...publicSession
          } = session;
          sessions.push(publicSession);
        }
      }
    }

    return sessions.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * Persist the delegating Station's own dispatch receipt for work owned by a
   * paired peer. This is a compact Activity record, not a copy of the peer's
   * runtime event stream: dispatch proves only `queued`; a later point read
   * must supply lifecycle evidence before this record can advance.
   */
  recordPeerDelegationActivityDispatch(
    input: PeerDelegationActivityDispatch,
  ): string {
    this.initialize();
    const threadId = peerDelegationActivityThreadId(
      input.environment.id,
      input.taskId,
    );
    if (
      this.sessionReadModel.has(threadId) ||
      this.options.eventStore?.readSessionByThread(threadId)
    ) {
      return threadId;
    }
    const createdAt = new Date().toISOString();
    const title = Array.from(input.prompt.replace(/\s+/g, ' ').trim())
      .slice(0, 120)
      .join('');
    this.projectAndPublishEvent({
      eventId: `peer-delegation-dispatched:${threadId}`,
      provider: 'station-agent',
      threadId,
      createdAt,
      method: 'session.started',
      sessionId: threadId,
      initialState: 'created',
      sessionState: 'queued',
      transitionReason: 'session_started',
      transitionSource: 'runtime',
      metadata: {
        taskId: input.taskId,
        conversationId: input.conversationId,
        environmentId: input.environment.id,
        environmentName: input.environment.name,
        environmentKind: input.environment.kind,
        targetKind: input.target.kind,
        targetId: input.target.id,
        assignedAgentSlug: input.target.id,
        delegationTitle: title,
        userId: input.userId,
        ...(input.projectSlug ? { projectSlug: input.projectSlug } : {}),
        ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
      },
    });
    return threadId;
  }

  /** Advance a peer Activity record only from an observed peer lifecycle. */
  recordPeerDelegationActivityOutcome(input: {
    taskId: string;
    environmentId: string;
    status: SessionLifecycleState;
  }): boolean {
    this.initialize();
    const threadId = peerDelegationActivityThreadId(
      input.environmentId,
      input.taskId,
    );
    const persisted = this.options.eventStore?.readSessionByThread(threadId);
    const loaded = this.sessionReadModel.get(threadId);
    const session = loaded ?? persisted;
    if (!session) return false;
    const events =
      this.options.eventStore
        ?.listSessionProjectionEvents(threadId)
        .map((event) => event.payload) ?? [];
    const current = projectSessionLifecycle({ session, events }).lifecycleState;
    if (current === input.status) return false;
    const path = peerDelegationLifecyclePath(current, input.status);
    if (!path) {
      this.options.logger.warn(
        'Could not reconcile peer delegation Activity lifecycle',
        { threadId, from: current, to: input.status },
      );
      return false;
    }
    for (let index = 1; index < path.length; index += 1) {
      const event = createManualSessionTransitionEvent({
        provider: session.provider,
        threadId,
        from: path[index - 1],
        to: path[index],
        reason: 'manual_update',
        source: 'system_recovery',
        message: 'Observed from the paired Station delegation status endpoint',
      });
      this.projectAndPublishEvent(event);
    }
    return true;
  }

  async listSessionReadModel(
    authority: SessionReadScope,
  ): Promise<OrchestrationSessionSummary[]> {
    this.initialize();
    await this.listSessions(INTERNAL_SESSION_READ_SCOPE);
    this.evictCollidingAttachedAliases();

    const persistedSessions = this.options.eventStore?.readSessions() ?? [];
    this.sessionAuthz.hydratePersistedTenantContexts(persistedSessions);
    const persistedByThread = new Map(
      persistedSessions.map((session) => [session.threadId, session]),
    );
    const threadIds = new Set<string>([
      ...persistedByThread.keys(),
      ...this.sessionReadModel.keys(),
    ]);

    // ONE timestamp for the whole read: this list is a single observation of
    // this process's state, not one observation per row.
    const observedAt = new Date().toISOString();
    const readableThreadIds = [...threadIds].filter(
      (threadId) =>
        !this.isEphemeralSession(threadId) &&
        this.sessionAuthz.canReadSession(threadId, authority),
    );
    // archive#4466: batched over every readable thread in a fixed number of
    // SQL round trips instead of one `listSessionProjectionEvents` +
    // `countEventsByThread` pair per thread — this route is polled on the
    // Activity view's mount and stalled proportionally to the thread count
    // before this change.
    const eventStore = this.options.eventStore;
    const eventsByThread =
      eventStore?.listSessionProjectionEventsForThreads(readableThreadIds) ??
      new Map<string, PersistedRuntimeEvent[]>();
    const eventCountByThread =
      eventStore?.countEventsByThreads(readableThreadIds) ??
      new Map<string, number>();
    return readableThreadIds
      .map((threadId) => {
        // archive#1867: summary facts are queried by their load-bearing
        // methods, never by a recent tail. A Flow/policy binding can be older
        // than an arbitrarily long streaming turn and must remain visible.
        const events = eventsByThread.get(threadId) ?? [];
        // Invariant: `countEventsByThreads` is queried for this same
        // `readableThreadIds` set, so a missing entry here means the store
        // itself reports zero raw events for the thread (archive#4466
        // review remediation) — never "count unknown, guess from the bounded
        // projection", which would silently under-report a thread whose
        // history exceeds its handful of folded facts.
        const eventCount = eventCountByThread.get(threadId) ?? 0;
        const persisted = persistedByThread.get(threadId);
        const loaded = this.sessionReadModel.get(threadId);
        return buildOrchestrationSessionSummary({
          persisted,
          loaded,
          events: events.map((event) => event.payload),
          eventCount,
          turnProgress: this.turnProgress.read(threadId),
          answerability: this.observeAnswerability(
            threadId,
            (loaded ?? persisted)?.provider,
            observedAt,
          ),
        });
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async listLoadedSessionReadModel(
    authority: SessionReadScope,
  ): Promise<OrchestrationSessionSummary[]> {
    const sessions = await this.listSessionReadModel(authority);
    return sessions.filter((session) => session.isLoaded);
  }

  async listAgentRuns(authority: SessionReadScope): Promise<AgentRunSummary[]> {
    this.initialize();
    await this.listSessions(INTERNAL_SESSION_READ_SCOPE);
    this.evictCollidingAttachedAliases();

    const persistedSessions = this.options.eventStore?.readSessions() ?? [];
    this.sessionAuthz.hydratePersistedTenantContexts(persistedSessions);
    const persistedByThread = new Map(
      persistedSessions.map((session) => [session.threadId, session]),
    );
    const threadIds = new Set<string>([
      ...persistedByThread.keys(),
      ...this.sessionReadModel.keys(),
    ]);

    // ONE timestamp for the whole read, for the reason `listSessionReadModel`
    // documents.
    const observedAt = new Date().toISOString();
    const readableThreadIds = [...threadIds].filter((threadId) =>
      this.sessionAuthz.canReadSession(threadId, authority),
    );
    // archive#4466: batched the same way `listSessionReadModel` is — one
    // `listSessionProjectionEventsForThreads`/`countEventsByThreads` pair for
    // the whole readable set instead of a per-thread pair inside this `.map`.
    const eventStore = this.options.eventStore;
    const eventsByThread =
      eventStore?.listSessionProjectionEventsForThreads(readableThreadIds) ??
      new Map<string, PersistedRuntimeEvent[]>();
    const eventCountByThread =
      eventStore?.countEventsByThreads(readableThreadIds) ??
      new Map<string, number>();
    return readableThreadIds
      .map((threadId) => {
        // archive#1867: same complete state-bearing projection as the
        // session list; never let a transcript tail erase governance facts.
        const events = eventsByThread.get(threadId) ?? [];
        // Invariant: `countEventsByThreads` is queried for this same
        // `readableThreadIds` set, so a missing entry here means the store
        // itself reports zero raw events for the thread (archive#4466
        // review remediation) — never "count unknown, guess from the bounded
        // projection", which would silently under-report a thread whose
        // history exceeds its handful of folded facts.
        const eventCount = eventCountByThread.get(threadId) ?? 0;
        // archive#1778 delta review: loaded-first, matching every other
        // emission site AND `buildAgentRunSummary`'s own
        // `base = loaded ?? persisted`. It was persisted-first here, so a run's
        // `providerId` was derived loaded-first while the `providerRegistered`
        // input behind its `answerability` was derived persisted-first — two
        // emission routes deriving one session from different views.
        //
        // NO TEST PINS THIS, and the reason is recorded rather than papered
        // over: the two views cannot differ for a thread (both derive their
        // provider from the same persisted row, and the only writer that
        // populates one without the other copies it), so no honest fixture
        // discriminates the two orderings. An attempt to force the skew by
        // having an adapter report a different provider was measured and had
        // NO power — a reported session is a tracked session, so
        // `projectRequestAnswerability` short-circuits on attachment before
        // the provider lookup is consulted (probed: 25 short-circuits, zero
        // reaching the arm). This is therefore a consistency fix with an
        // unreachable failure mode, kept because the inconsistency is real in
        // the code even where it is inert in behaviour.
        const provider =
          this.sessionReadModel.get(threadId)?.provider ??
          persistedByThread.get(threadId)?.provider;
        return buildAgentRunSummary({
          persisted: persistedByThread.get(threadId),
          loaded: this.sessionReadModel.get(threadId),
          events: events.map((event) => event.payload),
          eventCount,
          engineExecution: provider
            ? engineExecutionForAdapter(
                this.options.adapterRegistry.get(provider),
              )
            : 'unknown',
          answerability: this.observeAnswerability(
            threadId,
            provider,
            observedAt,
          ),
        });
      })
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  async readAgentRun(
    runId: string,
    authority: SessionReadScope,
  ): Promise<AgentRunSummary | null> {
    const runs = await this.listAgentRuns(authority);
    return runs.find((run) => run.runId === runId) ?? null;
  }

  async listProjectSessionBoard(
    projectSlug: string,
    authority: SessionReadScope,
  ): Promise<SessionBoardItem[]> {
    this.initialize();
    const startedAt = performance.now();
    const sessions = await this.listSessionReadModel(authority);
    const runsBySessionId = new Map(
      (await this.listAgentRuns(authority)).map((run) => [run.sessionId, run]),
    );

    const items = sessions
      .filter((session) => session.projectSlug === projectSlug)
      .map((session): SessionBoardItem => {
        const run = runsBySessionId.get(session.threadId);
        // archive#1778: NOT a second fold. The board used to re-derive
        // `lifecycleState ?? 'running'` and `pendingReview` from the same raw
        // fields the base summary had already folded — one of at least three
        // parallel projections layered over `listSessionReadModel`, and the
        // divergent-copy disease `open-requests.ts` names. The re-derivations
        // are gone; the board carries what the base summary computed. The one
        // remaining resolution — an absent optional `lifecycleState` — is the
        // shared `foldedSessionLifecycleState`, so there is a single `??`
        // decision in the codebase rather than one per consumer.
        const lifecycleState = foldedSessionLifecycleState(
          session.lifecycleState,
        );
        return {
          sessionId: session.threadId,
          provider: session.provider,
          controlMode: session.controlMode,
          runtimeKind: session.provider,
          agentType: run?.engineExecution ?? 'unknown',
          answerability: session.answerability,
          lifecycleState,
          ...(session.previousLifecycleState
            ? { previousLifecycleState: session.previousLifecycleState }
            : {}),
          ...(session.transitionReason
            ? { transitionReason: session.transitionReason }
            : {}),
          ...(session.transitionSource
            ? { transitionSource: session.transitionSource }
            : {}),
          pendingReview: session.pendingReview === true,
          ...(session.blockedReason
            ? { blockedReason: session.blockedReason }
            : {}),
          projectSlug,
          ...(session.projectLayoutSlug
            ? { projectLayoutSlug: session.projectLayoutSlug }
            : {}),
          ...(session.assignedAgentSlug
            ? { assignedAgentSlug: session.assignedAgentSlug }
            : {}),
          ...(session.model ? { model: session.model } : {}),
          status: session.status,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          ...(session.lastEventAt ? { lastEventAt: session.lastEventAt } : {}),
          ...(session.lastEventMethod
            ? { lastEventMethod: session.lastEventMethod }
            : {}),
          isLoaded: session.isLoaded,
          isPersisted: session.isPersisted,
          eventCount: session.eventCount,
          retryEligible:
            run?.retryEligible === true ||
            lifecycleState === 'failed' ||
            lifecycleState === 'blocked',
          openHref: `/projects/${projectSlug}?chat=${encodeURIComponent(
            session.threadId,
          )}`,
        };
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    uiSessionBoardLoadDuration.record(performance.now() - startedAt, {
      project_scope: projectSlug,
      result_count_bucket: bucketCount(items.length),
    });
    return items;
  }

  async readSession(
    threadId: string,
    authority: SessionReadScope,
  ): Promise<OrchestrationSessionDetail | null> {
    this.initialize();
    await this.listSessions(INTERNAL_SESSION_READ_SCOPE);

    const persistedSessions = this.options.eventStore?.readSessions() ?? [];
    this.sessionAuthz.hydratePersistedTenantContexts(persistedSessions);
    const persisted = persistedSessions.find(
      (session) => session.threadId === threadId,
    );
    const loaded = this.sessionReadModel.get(threadId);
    if (!persisted && !loaded) {
      return null;
    }
    if (!this.sessionAuthz.canReadSession(threadId, authority)) {
      return null;
    }

    // Conversation history remains the full-record contract of this detail
    // reader. It is deliberately outside archive#1867's summary/query slice; the
    // cursor migration for that payload belongs to archive#2004.
    const events = (this.options.eventStore?.listEvents(threadId) ?? []).map(
      (event) => event.payload,
    );

    const recovery = this.recoveryCoordinator?.latestProjection(threadId);
    return {
      session: buildOrchestrationSessionSummary({
        persisted,
        loaded,
        events,
        turnProgress: this.turnProgress.read(threadId),
        answerability: this.observeAnswerability(
          threadId,
          (loaded ?? persisted)?.provider,
          new Date().toISOString(),
        ),
      }),
      events,
      ...(recovery ? { recovery } : {}),
    };
  }

  // Conversation lineage/handoff/history forwarders (epic archive#4024,
  // archive#4155): bodies live in ConversationLineage (conversation-lineage.ts).
  // Flat same-named forwarders keep the test Proxy's authority injection
  // (T3) and each body's initialize() latch (T9) exactly as the bodies had.
  async resolveConversationContinuation(
    conversationId: string,
    authority: SessionReadScope,
    requested: { provider: EngineId; connectionId?: string },
  ): Promise<{
    sessionId: string;
    startRequired: boolean;
    resumeCursor?: unknown;
    transcriptSeed?: string;
    contextBoundary?: ConversationContextBoundaryProjection;
  }> {
    this.initialize();
    return this.conversationLineage.resolveConversationContinuation(
      conversationId,
      authority,
      requested,
    );
  }

  currentConversationSessionId(conversationId: string): string {
    return this.conversationLineage.currentConversationSessionId(
      conversationId,
    );
  }

  async readCurrentConversationSession(
    conversationId: string,
    authority: SessionReadScope,
  ): Promise<OrchestrationSessionDetail | null> {
    return this.conversationLineage.readCurrentConversationSession(
      conversationId,
      authority,
    );
  }

  reservedConversationHandoff(
    sessionId: string,
  ): ReturnType<ConversationLineage['reservedConversationHandoff']> {
    return this.conversationLineage.reservedConversationHandoff(sessionId);
  }

  async prepareConversationHandoff(
    conversationId: string,
    authority: SessionReadScope,
    target: {
      agentId: string;
      environmentId: string;
      connectionId?: string;
      modelId?: string;
      idempotencyKey: string;
      messageDigest: string;
    },
  ): ReturnType<ConversationLineage['prepareConversationHandoff']> {
    this.initialize();
    return this.conversationLineage.prepareConversationHandoff(
      conversationId,
      authority,
      target,
    );
  }

  async readConversationHandoffStatus(
    conversationId: string,
    idempotencyKey: string,
    authority: SessionReadScope,
  ): Promise<ConversationHandoffStatusProjection | null> {
    this.initialize();
    return this.conversationLineage.readConversationHandoffStatus(
      conversationId,
      idempotencyKey,
      authority,
    );
  }

  async reserveConversationContextBoundary(
    conversationId: string,
    authority: SessionReadScope,
    input: ConversationContextBoundaryRequest & {
      actorId: string;
      clientOrigin?: string;
    },
  ): Promise<ConversationContextBoundaryProjection> {
    this.initialize();
    return this.conversationLineage.reserveConversationContextBoundary(
      conversationId,
      authority,
      input,
    );
  }

  async readConversationContextBoundaryStatus(
    conversationId: string,
    idempotencyKey: string,
    authority: SessionReadScope,
  ): Promise<ConversationContextBoundaryProjection | null> {
    this.initialize();
    return this.conversationLineage.readConversationContextBoundaryStatus(
      conversationId,
      idempotencyKey,
      authority,
    );
  }

  async cancelConversationContextBoundary(
    conversationId: string,
    idempotencyKey: string,
    authority: SessionReadScope,
  ): Promise<ConversationContextBoundaryProjection | null> {
    this.initialize();
    return this.conversationLineage.cancelConversationContextBoundary(
      conversationId,
      idempotencyKey,
      authority,
    );
  }

  claimConversationContextBoundaryColdStart(
    boundaryId: string,
    startCommandId: string,
  ) {
    this.initialize();
    return this.conversationLineage.claimConversationContextBoundaryColdStart(
      boundaryId,
      startCommandId,
    );
  }

  consumeConversationContextBoundary(
    boundaryId: string,
    startCommandId: string,
  ) {
    this.initialize();
    const marker = this.conversationLineage.consumeConversationContextBoundary(
      boundaryId,
      startCommandId,
    );
    // A very fast engine can publish its terminal event before `sendTurn()`
    // returns the accepted identity that consumes this boundary. Re-fold only
    // the successor's durable events in that race; never rewrite their hashes
    // or Task references, only their separately stored provenance sidecars.
    if (marker?.status === 'consumed' && this.options.eventStore) {
      const events = this.options.eventStore
        .listEvents(marker.successorSessionId)
        .map((event) => event.payload);
      for (const envelope of assembleTurnProvenanceEnvelopes(events)) {
        const terminal = events.find(
          (event) =>
            event.turnId === envelope.turnId &&
            event.method === 'turn.completed',
        );
        this.options.eventStore.upsertTurnProvenance({
          ...envelope,
          contextBoundary: {
            state: 'observed',
            value: {
              boundaryId: marker.boundaryId,
              policy: marker.policy,
              priorTranscriptInjected:
                marker.policy === 'continue-from-history',
            },
            observedFrom: terminal
              ? [{ eventId: terminal.eventId, method: terminal.method }]
              : [],
          },
        });
      }
    }
    return marker;
  }

  releaseConversationContextBoundaryFailedClaim(
    boundaryId: string,
    indeterminate = false,
  ) {
    this.initialize();
    return this.conversationLineage.releaseConversationContextBoundaryFailedClaim(
      boundaryId,
      indeterminate,
    );
  }

  /**
   * The session's current project binding (delegation-scoped first, same
   * precedence `sessionOpenHref`/`resolveNotificationOpenHref` use), read
   * synchronously from the persisted event store + in-memory read model —
   * no adapter I/O (deliberately NOT `listSessionReadModel()`, which polls
   * every registered adapter's `listSessions()`). archive#1284: lets
   * `approval-inbox.ts` attach `projectSlug` to a `request.opened`
   * notification's metadata at delivery time without stalling on adapter
   * calls unrelated to the thread that just opened a request.
   */
  resolveSessionProjectSlug(threadId: string): string | undefined {
    const persisted = this.options.eventStore
      ?.readSessions()
      .find((session) => session.threadId === threadId);
    const loaded = this.sessionReadModel.get(threadId);
    if (!persisted && !loaded) return undefined;
    const events = (
      this.options.eventStore?.listSessionProjectionEvents(threadId) ?? []
    ).map((event) => event.payload);
    // Named by the compiler, not by a sweep: this builds a summary purely to
    // read its project binding and hands nothing to a client, so the
    // observation it must supply is real but never emitted. That is the
    // required member working as designed — every construction site is
    // enumerated, and an internal one costs two map lookups.
    const summary = buildOrchestrationSessionSummary({
      persisted,
      loaded,
      events,
      answerability: this.observeAnswerability(
        threadId,
        (loaded ?? persisted)?.provider,
        new Date().toISOString(),
      ),
    });
    return summary.delegation?.projectSlug ?? summary.projectSlug;
  }

  // Event paging & stream replay forwarders (epic archive#4024, archive#4155):
  // bodies live in SessionEventReads (session-event-reads.ts). Flat
  // same-named forwarders keep the test Proxy's authority injection (T3)
  // and the per-method initialize() latch (T9) exactly as the bodies had.
  readRequestOutcome(
    threadId: string,
    requestId: string,
  ): RequestReplayOutcome {
    return this.sessionEventReads.readRequestOutcome(threadId, requestId);
  }

  async readSessionEventPage(
    threadId: string,
    options: {
      afterSequence: number;
      limit: number;
      authority: SessionReadScope;
    },
  ): Promise<OrchestrationSessionEventPage | null> {
    this.initialize();
    return this.sessionEventReads.readSessionEventPage(threadId, options);
  }

  async readSessionEventWindow(
    threadId: string,
    options: {
      cursor?: string;
      turnLimit: number;
      authority: SessionReadScope;
      signal?: AbortSignal;
    },
  ): Promise<OrchestrationSessionEventWindow | null> {
    this.initialize();
    return this.sessionEventReads.readSessionEventWindow(threadId, options);
  }

  async readConversationEventWindow(
    conversationId: string,
    options: {
      cursor?: string;
      turnLimit: number;
      authority: SessionReadScope;
      signal?: AbortSignal;
    },
  ): Promise<OrchestrationConversationEventWindow | null> {
    this.initialize();
    return this.sessionEventReads.readConversationEventWindow(
      conversationId,
      options,
    );
  }

  readEventStreamHead(): number {
    this.initialize();
    return this.sessionEventReads.readEventStreamHead();
  }

  readEventGlobalSequence(eventId: string): number | undefined {
    return this.sessionEventReads.readEventGlobalSequence(eventId);
  }

  readEventStreamReplay(
    afterGlobalSequence: number,
    options: { threadId?: string; limit: number },
    authority: SessionReadScope,
  ): PersistedRuntimeEvent[] {
    this.initialize();
    return this.sessionEventReads.readEventStreamReplay(
      afterGlobalSequence,
      options,
      authority,
    );
  }

  readEventStreamReplayPlan(
    afterGlobalSequence: number,
    options: { threadId?: string; limit: number; maxSerializedBytes: number },
    authority: SessionReadScope,
  ): { count: number; fitsBudget: boolean } {
    this.initialize();
    return this.sessionEventReads.readEventStreamReplayPlan(
      afterGlobalSequence,
      options,
      authority,
    );
  }

  /**
   * Project a native-SDK session's persisted events into the canonical
   * conversation-message shape via the shared projection. This is the
   * read/refresh seam so external-agent (Claude/Codex) chats can render through
   * the same message shape as ACP/internal — no second copy in the memory store.
   */
  readSessionMessages(
    threadId: string,
    authority: SessionReadScope,
  ): ConversationMessage[] {
    this.initialize();
    return this.transcriptReads.readSessionMessages(threadId, authority);
  }

  /**
   * Bounded, indexed transcript search for the command palette.  The event
   * store intersects owner/tenant FTS scope terms while selecting rows; this
   * method then reuses the ordinary session predicate as a defence-in-depth
   * check before exposing any excerpt.
   */
  searchSessionMessages(
    query: string,
    authority: SessionReadScope,
    limit = 20,
  ): ReturnType<SessionTranscriptReads['searchSessionMessages']> {
    this.initialize();
    return this.transcriptReads.searchSessionMessages(query, authority, limit);
  }

  /**
   * Fold a native-SDK session's persisted events into engine-agnostic usage
   * totals via the shared reducer (archive#1299). Mirrors
   * `readSessionMessages` exactly — same authorization gate, same event
   * source — so the stats route's memory-store fallback can reuse this one
   * seam instead of re-reading the event store itself.
   */
  readSessionUsage(
    threadId: string,
    authority: SessionReadScope,
  ): SessionUsageAggregate {
    this.initialize();
    return this.transcriptReads.readSessionUsage(threadId, authority);
  }

  /**
   * Every persisted session's usage, for lifetime analytics (archive#3245).
   *
   * It is a loop over {@link readSessionUsage} and nothing else: no second
   * reducer, no second scope handling, no direct event access — so the
   * Profile's totals and the conversation stats modal cannot disagree about
   * what an engine reported, and a new engine lights up in both the moment it
   * emits the canonical events.
   *
   * A session that was never configured is skipped: it has no agent or
   * conversation to attribute usage to, and that is the same rule monitoring
   * applies to the same sessions.
   */
  listSessionUsage(authority: SessionReadScope): OrchestrationSessionUsage[] {
    this.initialize();
    return this.transcriptReads.listSessionUsage(authority);
  }

  listUsageReceipts(
    authority: SessionReadAuthority,
    stationId: string,
    request: { from: string; to: string; cursor?: string; pageSize?: number },
  ): {
    receipts: import('@kontourai/station-contracts/usage-rollup').UsageReceipt[];
    nextCursor?: string;
  } {
    this.initialize();
    return this.transcriptReads.listUsageReceipts(
      authority,
      stationId,
      request,
    );
  }

  canUserReadSession(threadId: string, authority: SessionReadScope): boolean {
    this.initialize();
    return this.sessionAuthz.canReadSession(threadId, authority);
  }

  /**
   * Presence-subject resolution (body lives in SessionAuthorization —
   * epic archive#4024, archive#4166); the initialize() latch stays here (T9).
   */
  resolveSessionPresenceSubject(
    threadId: string,
  ): OrchestrationStreamPresenceSubject | undefined {
    this.initialize();
    return this.sessionAuthz.resolveSessionPresenceSubject(threadId);
  }

  /**
   * archive#3525: called by `wireTurnCompletionNotifications` before it
   * would otherwise schedule a push for `turnId`'s terminal event. Returns
   * true (and consumes the entry) exactly when `InternalStopSuppression.arm`
   * armed this turn id for an internal-machinery stop — see
   * the Set's doc in internal-stop-suppression.ts for why this is the correctness-bearing
   * check rather than the bounded timer that also clears it.
   */
  consumeInternalStopSuppression(turnId: string): boolean {
    return this.internalStops.consume(turnId);
  }

  async readSessionConversation(
    threadId: string,
    authority: SessionReadScope,
  ): ReturnType<ConversationLineage['readSessionConversation']> {
    return this.conversationLineage.readSessionConversation(
      threadId,
      authority,
    );
  }

  /**
   * Exact conversation-open point read.  Unlike history inventory this never
   * pages or derives a candidate from recency: the supplied durable
   * conversation identity is followed only to its lineage current child and
   * projected under the request's one authority.
   */
  async resolveConversationOpen(
    conversationId: string,
    authority: SessionReadAuthority,
  ) {
    this.initialize();
    const currentSessionId = this.currentConversationSessionId(conversationId);
    const query = await this.sessionQueries.read(
      { type: 'conversation', threadId: currentSessionId },
      authority,
    );
    if (query.status === 'unavailable') return null;
    if (query.status !== 'found') return null;
    // A direct legacy root may not have a lineage row. A lineage child must
    // still prove it belongs to the requested durable conversation; otherwise
    // an id collision cannot open a foreign Session.
    if (
      query.conversation.id !== conversationId &&
      this.options.eventStore?.conversationForSession(currentSessionId)
        ?.conversationId !== conversationId
    ) {
      return null;
    }
    const detail = await this.readCurrentConversationSession(
      conversationId,
      authority,
    );
    const conversation: ConversationListItem = {
      id: conversationId,
      source: 'runtime',
      agentSlug: publicAgentIdFromRuntimeKey(query.conversation.agentSlug),
      ...(query.conversation.projectSlug
        ? { projectSlug: query.conversation.projectSlug }
        : {}),
      title: query.conversation.title,
      createdAt: query.conversation.createdAt,
      updatedAt: query.conversation.updatedAt,
      messageCount: query.conversation.messageCount,
      mutable: false,
      answerability: detail?.session.answerability ?? { answerable: true },
      ...(query.conversation.model ? { model: query.conversation.model } : {}),
      ...(query.conversation.acceptedModel
        ? { acceptedModel: query.conversation.acceptedModel }
        : {}),
      ...(query.conversation.environmentId
        ? { environmentId: query.conversation.environmentId }
        : {}),
    };
    return this.conversationOpenResolver.resolve({ conversation, authority });
  }

  appendConversationFork(event: CanonicalRuntimeEvent): void {
    this.conversationLineage.appendConversationFork(event);
  }

  appendConversationForkIfAbsent(event: CanonicalRuntimeEvent): boolean {
    return this.conversationLineage.appendConversationForkIfAbsent(event);
  }

  /** Pure fold; this intentionally does not initialize or rehydrate anything. */
  readConversationForkProvenance(conversationId: string): {
    forkedFrom?: ConversationForkProvenance;
    forkedTo: ConversationForkProvenance[];
  } {
    return this.conversationLineage.readConversationForkProvenance(
      conversationId,
    );
  }

  async listSessionConversations(
    agentSlug: string,
    authority: SessionReadScope,
  ): ReturnType<ConversationLineage['listSessionConversations']> {
    return this.conversationLineage.listSessionConversations(
      agentSlug,
      authority,
    );
  }

  async listAllSessionConversations(
    authority: SessionReadScope,
  ): Promise<ConversationListItem[]> {
    this.initialize();
    return this.conversationLineage.listAllSessionConversations(authority);
  }

  async listConversationHistoryPage(
    authority: SessionReadAuthority,
    options: { limit: number; cursor?: string; agentSlug?: string },
  ): Promise<ConversationHistoryPage> {
    this.initialize();
    return this.conversationLineage.listConversationHistoryPage(
      authority,
      options,
    );
  }

  /** Private adapters compose service state into the deep start command. */
  private createSessionCommandImplementation(): SessionCommandImplementation {
    return createSessionCommandModule({
      receiptLedger: {
        initialize: () => this.initialize(),
        recordDispatch: (input) =>
          orchestrationCommandsDispatched.add(1, {
            type: 'startSession',
            provider: input.provider,
          }),
        persist: (receipt) => this.persistReceipt(receipt),
        read: (commandId) =>
          this.options.eventStore?.readCommandReceipt(commandId) ?? null,
        reportUnavailable: ({ phase, error, receipt }) =>
          this.options.logger.warn('Session command receipt is unavailable', {
            phase,
            commandId: receipt.commandId,
            threadId: receipt.threadId,
            error: error instanceof Error ? error.message : String(error),
          }),
      },
      sessionState: {
        boundTenant: (threadId) => this.sessionAuthz.tenantContextFor(threadId),
        recordTenantMismatch: () =>
          tenantExecutionContextOutcomes.add(
            1,
            tenantExecutionContextAttributes({
              operation: 'dispatch',
              source: 'session',
              outcome: 'rejected',
              reason: 'mismatch',
            }),
          ),
        isQuarantined: (threadId) => this.quarantinedThreads.has(threadId),
        isReadOnlyAttached: (threadId) =>
          this.isReadOnlyAttachedSession(threadId),
        recordAttachedMutationRejection: () =>
          attachedSessionMutationRejected.add(1, {
            command_type: 'startSession',
            source: 'attached',
          }),
        canRead: (threadId, userId, tenant) =>
          this.sessionAuthz.canReadSessionForCommand(threadId, userId, tenant),
        existing: (threadId) => ({
          adapter: this.sessionAdapters.get(threadId),
          session: this.sessionReadModel.get(threadId),
        }),
        claimStart: (threadId) => {
          if (this.startingSessionThreads.has(threadId)) return false;
          this.startingSessionThreads.add(threadId);
          return true;
        },
        releaseStart: (threadId) =>
          this.startingSessionThreads.delete(threadId),
        attachStarted: (session, adapter, tenant, startInput) => {
          if (
            startInput.metadata?.[SESSION_VISIBILITY_METADATA_KEY] ===
            'ephemeral'
          ) {
            this.ephemeralSessionThreads.add(session.threadId);
            session.ephemeral = true;
          } else {
            this.ephemeralSessionThreads.delete(session.threadId);
            delete session.ephemeral;
          }
          this.trackSession(session, adapter);
          // Quota routing identity (archive#2354): the selected external
          // connection is command context captured at start, ported here
          // from the pre-refactor startSession case during the shepherd
          // merge — the factory closure is shared across concurrent starts,
          // so the input rides the per-call hook, never a closure variable.
          const startConnectionId =
            typeof startInput.metadata?.connectionId === 'string'
              ? startInput.metadata.connectionId
              : undefined;
          if (startConnectionId) {
            this.sessionConnectionIds.set(session.threadId, startConnectionId);
          }
          if (tenant) {
            this.sessionAuthz.bindTenantContext(session.threadId, tenant);
            session.tenantExecutionContext = tenant;
          }
          this.options.eventStore?.upsertSession(session);
        },
      },
      launchPolicy: {
        assertStartAllowed: (input, context, internal) => {
          if (
            this.options.requireTenantExecutionContext?.() &&
            !context.tenantExecutionContext
          )
            throw new Error(
              'Tenant execution context is required for hosted session start.',
            );
          if (
            'credentialProfileRef' in input &&
            input.credentialProfileRef !== undefined &&
            !internal?.credentialProfileApplication
          )
            throw new Error(
              'Credential profile selection is reserved for Station-managed recovery.',
            );
        },
        validateReattachAgainstPersisted: (input, session) => {
          // archive#3493 residual 6: the reattach conflicts that need no
          // adapter, checked against the PERSISTED row so a dormant session
          // refuses BEFORE `materializeRestoredSession` spawns its engine.
          // `validateReattach` below still runs after materialisation — the
          // launch-plan acceptance is adapter-dependent — as belt-and-braces.
          // Known divergence between the two seams (fix-round review): this
          // one compares against the persisted `session.model`, while the
          // post-spawn check compares against the POST-materialise model
          // (`startRecoveredOrchestrationSession` sets `nextSession.model =
          // recovered.model ?? session.model`), so an adapter that
          // normalises a model id during start can pass here and still
          // conflict there. Worst case is spawn-then-refuse — the exact
          // pre-fix behaviour, never a wrong acceptance — which is why the
          // divergence is named rather than closed.
          const reattach = normalizeOmittedModelId(input);
          const model = reattach.modelId?.trim();
          if (model && model !== session.model?.trim())
            throw new SessionReattachConflictError('model-change');
          if (Object.keys(input.modelOptions ?? {}).length > 0)
            throw new SessionReattachConflictError(
              'model-options-not-idempotent',
            );
        },
        validateReattach: (input, existing) => {
          const reattach = normalizeOmittedModelId(input);
          const model = reattach.modelId?.trim();
          if (model) {
            this.modelLaunch.assertAcceptedModelLaunchPlan(
              existing.adapter,
              model,
              reattach.resumeCursor === undefined ? 'start' : 'resume',
              existing.session.model,
            );
            if (model !== existing.session.model?.trim())
              throw new SessionReattachConflictError('model-change');
          }
          if (Object.keys(input.modelOptions ?? {}).length > 0)
            throw new SessionReattachConflictError(
              'model-options-not-idempotent',
            );
        },
        requireAdapter: (provider) => this.requireAdapter(provider),
        materializeRestoredSession: (threadId) =>
          this.materializeRecoveredSession(threadId),
        prepareStart: async (input, context, internal, adapter) => {
          if (!internal?.skipModelOptionSupportCheck) {
            const unsupported = unsupportedModelOptionKeys(
              adapter.provider,
              input.modelOptions,
            );
            if (unsupported.length > 0)
              throw new Error(
                unsupportedModelOptionError(
                  adapter.provider,
                  unsupported[0],
                  input.threadId,
                ),
              );
          }
          const connectionId =
            typeof input.metadata?.connectionId === 'string'
              ? input.metadata.connectionId
              : undefined;
          const {
            reviewIsolation: _untrustedReviewIsolation,
            ...publicStartInput
          } = input as ProviderSessionStartInput;
          let startInput = resolveStartSessionCwd(
            normalizeOmittedModelId(
              stripReservedCapabilityMetadata(publicStartInput),
            ),
            this.options.listProjects,
            this.options.observeCwdShadow,
            internal?.foregroundInvocationAdmission?.provisionedWorkspace ??
              readExecutionWorkspaceBinding(internal?.executionWorkspace),
          );
          if (internal?.reviewIsolation) {
            startInput = {
              ...startInput,
              reviewIsolation: internal.reviewIsolation,
            };
          }
          // archive#2821 hardening L3: `stripReservedCapabilityMetadata`
          // above removed `sessionVisibility` from EVERY caller's metadata,
          // trusted or not, because it cannot tell them apart. Only an
          // internal caller that set `ephemeralSessionVisibility` gets it
          // back — the one legitimate writer (the foreground webhook seam,
          // via `startSessionInternal`) re-derives it here rather than
          // relying on it surviving the strip.
          if (internal?.ephemeralSessionVisibility) {
            startInput = {
              ...startInput,
              metadata: {
                ...startInput.metadata,
                [SESSION_VISIBILITY_METADATA_KEY]: 'ephemeral',
              },
            };
          }
          if (internal?.conversationIdentity) {
            startInput = {
              ...startInput,
              metadata: {
                ...startInput.metadata,
                conversationId: internal.conversationIdentity.conversationId,
                environmentId: internal.conversationIdentity.environmentId,
              },
            };
          }
          if (context.tenantExecutionContext) {
            tenantExecutionContextOutcomes.add(
              1,
              tenantExecutionContextAttributes({
                operation: 'start',
                source: 'request',
                outcome: 'accepted',
                reason: 'none',
              }),
            );
            startInput = {
              ...startInput,
              tenantExecutionContext: context.tenantExecutionContext,
            };
          }
          startInput = this.modelLaunch.withAcceptedModelLaunchPlan(
            adapter,
            startInput,
            startInput.resumeCursor === undefined ? 'start' : 'resume',
          );
          await this.assertAdapterReady(adapter, connectionId);
          startInput = await this.modelLaunch.validateConnectedCliModelSelector(
            adapter,
            startInput,
          );
          startInput = await this.resolveSessionAgentForStart(
            startInput,
            internal?.foregroundInvocationAdmission,
          );
          throwIfAborted(startInput.signal);
          this.assertAdapterCurrent(adapter);
          chatStartGate.add(1, {
            agent_type: chatStartGateAgentType(adapter),
            runtime_type: adapter.provider,
            outcome: 'allowed',
            reason: 'adapter_configured',
          });
          return startInput;
        },
        start: async (adapter, input, context, internal) => {
          const startedAt = performance.now();
          const admissionLease = await admitEngineStartForIntent(
            this.options.resourcePosture,
            this.options.logger,
            internal?.resourceAdmissionIntent ?? 'interactive_user',
            {
              binding: input.threadId,
            },
          );
          let session: ProviderSession;
          try {
            const invoke = () =>
              withTenantExecutionContext(context.tenantExecutionContext, () =>
                adapter.startSession(input),
              );
            session = await (internal?.foregroundInvocationAdmission
              ? internal.foregroundInvocationAdmission.invoke(
                  'start',
                  {
                    threadId: input.threadId,
                    cwd: input.cwd,
                    agentId: input.metadata?.agentSlug,
                    projectSlug: input.metadata?.projectSlug,
                  },
                  invoke,
                )
              : invoke());
          } finally {
            admissionLease?.release();
          }
          adapterSessionStartDuration.record(performance.now() - startedAt, {
            provider: adapter.provider,
          });
          return session;
        },
        recordStarted: (adapter, input) =>
          this.modelLaunch.recordAcceptedModelLaunchPlan(
            adapter,
            this.modelLaunch.modelLaunchPlanFromInput(input),
            input.resumeCursor === undefined ? 'start' : 'resume',
            this.modelLaunch.modelLaunchRequestedOverrideFromInput(input),
          ),
        ensureStartedSessionCurrent: async (adapter, session, signal) => {
          if (signal?.aborted) {
            await this.adapterRetirement.cleanupObsoleteStartedSession(
              adapter,
              session.threadId,
            );
            throwIfAborted(signal);
          }
          if (!this.isAdapterCurrent(adapter)) {
            await this.adapterRetirement.cleanupObsoleteStartedSession(
              adapter,
              session.threadId,
            );
            throw new Error(
              `${adapter.provider} adapter was replaced while the session was starting.`,
            );
          }
        },
        logStarted: (adapter, input) => {
          this.sessionLogger(input).debug('Session started', {
            provider: adapter.provider,
          });
        },
        recordGateBlocked: (adapter, error) =>
          chatStartGate.add(1, {
            agent_type: chatStartGateAgentType(adapter),
            runtime_type: adapter.provider,
            outcome: 'blocked',
            reason: chatStartGateReason(error),
          }),
      },
      bindings: {
        bind: async (input, internal) => {
          const logger = this.sessionLogger(input);
          await this.flowPolicy.bindExplicitFlowRunToSession(input, logger);
          this.flowPolicy.bindWorkflowSidecarToSession(
            input,
            internal?.workflowSidecarAttachMode,
            logger,
          );
          this.flowPolicy.bindPolicyHooksToSession(input, logger);
        },
      },
      publicSession: publicProviderSession,
      isRejectedError: (error) =>
        error instanceof ModelLaunchPlanUnavailableError ||
        error instanceof SessionReattachConflictError ||
        error instanceof ConcurrentEngineStartCapacityError,
      attachedSessionReadOnlyMessage: ATTACHED_SESSION_READ_ONLY_ERROR,
    });
  }

  /**
   * archive#2821 hardening L3: server-only session start that may set
   * privileged internal-only fields (currently only
   * `ephemeralSessionVisibility`) no HTTP command body can supply. Mirrors
   * `dispatchWithReceipt`'s `internal`-escape-hatch precedent (archive#978
   * review r1) but preserves `SessionCommandOutcome`'s exact shape —
   * `dispatchWithReceipt`'s own `startSession` branch collapses a
   * `rejected`/`failed`/`indeterminate` outcome into one
   * `OrchestrationCommandDispatchError` and does not carry the
   * `indeterminate` case's session/receipt through unless the outcome object
   * happens to expose a `code`, so routing through it here would silently
   * drop `executeExecutionTargetMessage`'s existing
   * `ForegroundMessageIndeterminateError` handling. Never call this from a
   * route handling a client-supplied command body.
   */
  async startSessionInternal(
    command: SessionCommand,
    context: SessionCommandContext,
    internal: SessionCommandInternalOptions,
  ): Promise<SessionCommandOutcome> {
    return this.sessionCommandImplementation.executeInternal(
      command,
      context,
      internal,
    );
  }

  async dispatch(
    command: OrchestrationCommand,
    context?: {
      userId?: string;
      tenantExecutionContext?: TenantExecutionContext;
      clientOrigin?: ClientOrigin;
      /**
       * archive#4075 stage 2: the caller's resolved PrincipalRef, stamped
       * at emit time onto the `turn.started` this dispatch causes (via the
       * same `ClientOriginTurnPropagation` mechanism `clientOrigin` already
       * rides). Additive — every existing caller that only threads `userId`
       * keeps working; the emitted event simply carries no `principal`.
       */
      principal?: PrincipalRef;
    },
    internal?: OrchestrationDispatchInternalOptions,
  ): Promise<
    | ProviderSession
    | ProviderTurnStartResult
    | SteerTurnResult
    | InterruptTurnResult
    | undefined
  > {
    const response = await this.dispatchWithReceipt(command, context, internal);
    return response.result as
      | ProviderSession
      | ProviderTurnStartResult
      | SteerTurnResult
      | InterruptTurnResult
      | undefined;
  }

  /** Register a server-owned per-turn admission observer. */
  registerTurnAdmission(admission: OrchestrationTurnAdmission): () => void {
    this.turnAdmissions.add(admission);
    return () => this.turnAdmissions.delete(admission);
  }

  private assertTurnAdmitted(threadId: string): void {
    for (const admission of this.turnAdmissions) {
      const result = admission({ threadId });
      if (!result.allowed) throw new Error(result.reason);
    }
  }

  /**
   * archive#978 review r1 (HIGH fix): `internal` is a service-internal-only
   * escape hatch, never reachable from an HTTP body — every route calls
   * `dispatchWithReceipt(command, context)` with exactly two arguments (the
   * command is zod-validated JSON; `context` is server-built from
   * `getUserId()`), so a third positional parameter has no channel a
   * client-supplied payload could ever populate. Its purpose is letting
   *
   * `ConnectionSmoke.runConnectionSmoke` (`connection-smoke.ts`) use its internal `systemPrompt` and the
   * explicitly selected candidate profile, without reopening either choice
   * for an externally reachable caller (see `unsupportedModelOptionKeys`'s
   * docblock in contracts `provider.ts`).
   */
  async dispatchWithReceipt(
    command: OrchestrationCommand,
    context?: {
      userId?: string;
      tenantExecutionContext?: TenantExecutionContext;
      clientOrigin?: ClientOrigin;
      /**
       * archive#4075 stage 2: the caller's resolved PrincipalRef, stamped
       * at emit time onto the `turn.started` this dispatch causes (via the
       * same `ClientOriginTurnPropagation` mechanism `clientOrigin` already
       * rides). Additive — every existing caller that only threads `userId`
       * keeps working; the emitted event simply carries no `principal`.
       */
      principal?: PrincipalRef;
    },
    internal?: OrchestrationDispatchInternalOptions,
  ): Promise<
    OrchestrationCommandDispatchResult<
      | ProviderSession
      | ProviderTurnStartResult
      | SteerTurnResult
      | InterruptTurnResult
      | undefined
    >
  > {
    if (command.type === 'startSession') {
      const outcome = internal
        ? await this.sessionCommandImplementation.executeInternal(
            { type: 'start-session', input: command.input },
            context ?? {},
            internal,
          )
        : await this.sessionCommands.execute(
            { type: 'start-session', input: command.input },
            context ?? {},
          );
      if (outcome.status === 'accepted') {
        return { receipt: outcome.receipt, result: outcome.session };
      }
      const code = 'code' in outcome ? outcome.code : undefined;
      throw new OrchestrationCommandDispatchError(
        outcome.message,
        outcome.receipt,
        outcome.status === 'indeterminate' ? outcome.session : undefined,
        outcome.receiptStatus,
        false,
        code,
      );
    }
    this.initialize();
    const receipt: OrchestrationCommandReceipt =
      withClientOrigin<OrchestrationCommandReceipt>(
        {
          commandId: crypto.randomUUID(),
          threadId: this.commandThreadId(command),
          commandType: command.type,
          status: 'accepted',
          createdAt: new Date().toISOString(),
        },
        context?.clientOrigin,
      );
    orchestrationCommandsDispatched.add(1, {
      type: command.type,
      provider: this.commandProvider(command) ?? 'unknown',
    });

    const commandThreadId = this.commandThreadId(command);
    const boundTenant = this.sessionAuthz.tenantContextFor(commandThreadId);
    if (
      boundTenant &&
      context?.tenantExecutionContext &&
      boundTenant.tenantId !== context.tenantExecutionContext.tenantId
    ) {
      tenantExecutionContextOutcomes.add(
        1,
        tenantExecutionContextAttributes({
          operation: 'dispatch',
          source: 'session',
          outcome: 'rejected',
          reason: 'mismatch',
        }),
      );
      const rejectedReceipt = { ...receipt, status: 'rejected' as const };
      this.persistReceipt(rejectedReceipt);
      throw new OrchestrationCommandDispatchError(
        `Tenant execution context does not match session: ${commandThreadId}`,
        rejectedReceipt,
      );
    }
    if (boundTenant) {
      tenantExecutionContextOutcomes.add(
        1,
        tenantExecutionContextAttributes({
          operation: 'continue',
          source: 'session',
          outcome: 'accepted',
          reason: 'none',
        }),
      );
    }
    if (
      context?.userId !== undefined &&
      !this.sessionAuthz.canReadSessionForCommand(
        commandThreadId,
        context.userId,
        context.tenantExecutionContext,
      )
    ) {
      const rejectedReceipt = { ...receipt, status: 'rejected' as const };
      this.persistReceipt(rejectedReceipt);
      throw new OrchestrationCommandDispatchError(
        `Session not found: ${commandThreadId}`,
        rejectedReceipt,
      );
    }

    if (this.quarantinedThreads.has(commandThreadId)) {
      const rejectedReceipt = { ...receipt, status: 'rejected' as const };
      this.persistReceipt(rejectedReceipt);
      throw new OrchestrationCommandDispatchError(
        `Session is unavailable: ${commandThreadId}`,
        rejectedReceipt,
      );
    }

    if (this.isPeerDelegationActivityRecord(commandThreadId)) {
      const rejectedReceipt = { ...receipt, status: 'rejected' as const };
      this.persistReceipt(rejectedReceipt);
      throw new OrchestrationCommandDispatchError(
        PEER_DELEGATION_ACTIVITY_READ_ONLY_ERROR,
        rejectedReceipt,
      );
    }

    if (
      command.type !== 'adoptSession' &&
      this.isReadOnlyAttachedSession(this.commandThreadId(command))
    ) {
      attachedSessionMutationRejected.add(1, {
        command_type: command.type,
        source: 'attached',
      });
      const rejectedReceipt = { ...receipt, status: 'rejected' as const };
      this.persistReceipt(rejectedReceipt);
      throw new OrchestrationCommandDispatchError(
        ATTACHED_SESSION_READ_ONLY_ERROR,
        rejectedReceipt,
      );
    }

    let steerMetricEngine = 'unknown';
    let steerMetricRecorded = false;
    try {
      switch (command.type) {
        case 'adoptSession':
          return this.adoption.adopt(
            command.sourceThreadId,
            receipt,
            context?.userId,
            context?.tenantExecutionContext,
            command.idempotencyKey,
          );
        case 'sendTurn': {
          // Monitor envelopes register here, at the one execution choke
          // point every first and successor turn crosses. No registration
          // means the normal Task/chat path is byte-for-byte unchanged.
          this.assertTurnAdmitted(command.input.threadId);
          const current = await this.readSession(
            command.input.threadId,
            INTERNAL_SESSION_READ_SCOPE,
          );
          if (
            current &&
            foldedSessionLifecycleState(current.session.lifecycleState) ===
              'completed'
          ) {
            throw new SessionEndedError();
          }
          const adapter = await resolveOrchestrationAdapterForThread({
            threadId: command.input.threadId,
            threadProviders: this.threadProviders,
            requireAdapter: (provider) => this.requireAdapter(provider),
            adapters: this.options.adapterRegistry.list(),
            // archive#3476: a turn is the one command that genuinely needs an
            // engine, so this is where a session restored at boot gets one.
            // Every "first turn" seam funnels here — foreground chat and its
            // continue route, the UI composer/queue drain/voice/`station
            // chat` (all of which POST /api/orchestration/chat), inbound
            // webhooks, Discord, delegated-task dispatch and continue, and
            // the recovery coordinator's own replay — because every one of
            // them ends at `dispatch({ type: 'sendTurn' })`.
            materializeSession: (threadId) =>
              this.materializeRecoveredSession(threadId),
          });
          const {
            reviewIsolation: _untrustedReviewIsolation,
            ...publicTurnInput
          } = command.input as ProviderSendTurnInput & {
            ambientContext?: string;
          };
          // archive#895 wave C: an engine with no native systemPrompt
          // channel gets its authored prompt delivered by prepending it
          // into THIS turn's ambientContext — the same choke point ordinary
          // ambient context (timezone, geolocation) already crosses —
          // but only on the session's genuine first turn (`current` was
          // read above, before this dispatch's own turn.started exists).
          const pendingPrompt = current
            ? pendingFirstTurnInstructions(current.events)
            : undefined;
          const turnInputWithFirstTurnPrompt = pendingPrompt
            ? {
                ...publicTurnInput,
                ambientContext: publicTurnInput.ambientContext?.trim()
                  ? `${pendingPrompt}\n${publicTurnInput.ambientContext}`
                  : pendingPrompt,
              }
            : publicTurnInput;
          let turnInput = stripReservedCapabilityMetadata(
            composeAmbientSendTurnInput(turnInputWithFirstTurnPrompt),
          );
          if (internal?.reviewIsolation) {
            turnInput = {
              ...turnInput,
              reviewIsolation: internal.reviewIsolation,
            };
          }
          turnInput = normalizeOmittedModelId(turnInput);
          const retainedModelId = this.sessionReadModel.get(
            turnInput.threadId,
          )?.model;
          const retainedModelRestatement =
            adapter.metadata.modelLaunch?.overridePerTurn === false &&
            typeof turnInput.modelId === 'string' &&
            typeof retainedModelId === 'string' &&
            turnInput.modelId.trim() !== '' &&
            turnInput.modelId.trim() === retainedModelId.trim();
          const turnRequestedOverride =
            typeof turnInput.modelId === 'string' &&
            turnInput.modelId.trim() !== '' &&
            !retainedModelRestatement;
          const turnPlan = this.modelLaunch.assertAcceptedModelLaunchPlan(
            adapter,
            turnInput.modelId,
            'turn',
            retainedModelId,
          );
          turnInput = {
            ...turnInput,
            ...(retainedModelRestatement ? { modelId: undefined } : {}),
            metadata: {
              ...turnInput.metadata,
              [MODEL_LAUNCH_PLAN_METADATA_KEY]: turnPlan,
              [MODEL_LAUNCH_REQUESTED_OVERRIDE_METADATA_KEY]:
                turnRequestedOverride,
              // Independent review MEDIUM-1: stamped ONLY on the dispatch
              // that genuinely composed a pending first-turn instructions
              // receipt into `turnInput.input` above — the delivering
              // adapter carries it onto its published `turn.started`'s own
              // metadata, so the delegate-seam disclosure can derive
              // 'delivered' from this turn's own record of what happened,
              // not merely from a turn having started.
              ...(pendingPrompt
                ? { [FIRST_TURN_INSTRUCTIONS_COMPOSED_METADATA_KEY]: true }
                : {}),
            },
          };
          turnInput =
            await this.modelLaunch.validateConnectedCliTurnModelSelector(
              adapter,
              turnInput,
            );
          const unsupportedTurnOptions = unsupportedModelOptionKeys(
            adapter.provider,
            turnInput.modelOptions,
          );
          if (unsupportedTurnOptions.length > 0) {
            throw new Error(
              unsupportedModelOptionError(
                adapter.provider,
                unsupportedTurnOptions[0],
                turnInput.threadId,
              ),
            );
          }
          const attachmentError = validateChatAttachments(
            turnInput.attachments ?? [],
          );
          if (attachmentError) {
            throw new Error(attachmentError);
          }
          const attachments = turnInput.attachments ?? [];
          if (
            attachments.some((attachment) => attachment.kind === 'image') &&
            !adapter.metadata.capabilities.includes('image-input')
          ) {
            throw new Error(
              `${adapter.metadata.displayName} does not support image attachments.`,
            );
          }
          if (
            attachments.some((attachment) => attachment.kind === 'file') &&
            !adapter.metadata.capabilities.includes('file-input')
          ) {
            throw new Error(
              `${adapter.metadata.displayName} does not support file attachments.`,
            );
          }
          // archive#1224 (offline): the crux of server-side turn
          // idempotency. A `clientTurnId` already claimed for this thread
          // means either (a) it was already resolved to a `turnId` by a
          // prior dispatch — hand that back verbatim instead of calling
          // `adapter.sendTurn` a second time — or (b) another dispatch with
          // the same key is still in flight (genuinely still executing —
          // NEVER assumed stale by elapsed time, see
          // `turn-idempotency.ts`'s file header) — wait (bounded) for it to
          // resolve rather than racing a second execution. Only a genuinely
          // new claim falls through to actually calling the adapter below.
          const clientTurnId = turnInput.clientTurnId;
          // archive#1224 HIGH fix (independent review): true only once this
          // dispatch has genuinely claimed ownership of `clientTurnId` — the
          // dedup-hit/in-flight branch below returns before this is ever
          // set, so it never touches a claim it doesn't own.
          let ownedClientTurnClaim:
            | import('./turn-deduplicator.js').TurnClaim
            | undefined;
          let receiptStatus: 'persisted' | 'unavailable' = 'persisted';
          if (clientTurnId) {
            const turnDeduplicator = this.turnDeduplicator;
            const claim = turnDeduplicator?.claim({
              threadId: turnInput.threadId,
              clientTurnId,
            });
            if (claim) {
              if (claim.kind === 'contended') {
                const existingTurnId =
                  claim.turnId ??
                  (await raceWithSignal(
                    turnDeduplicator!.awaitResolution({
                      threadId: turnInput.threadId,
                      clientTurnId,
                    }),
                    turnInput.signal,
                  ).catch(() => undefined));
                if (!existingTurnId) {
                  throw new Error(
                    `Turn ${clientTurnId} is already being processed for thread ${turnInput.threadId}.`,
                  );
                }
                orchestrationTurnDedup.add(1, {
                  provider: adapter.provider,
                  outcome: claim.turnId ? 'hit' : 'hit_inflight',
                });
                const dedupResolved: ProviderTurnStartResult = {
                  threadId: turnInput.threadId,
                  turnId: existingTurnId,
                };
                try {
                  this.persistReceipt(receipt);
                } catch {
                  receiptStatus = 'unavailable';
                }
                return {
                  receipt,
                  result: dedupResolved,
                  ...(receiptStatus === 'unavailable' ? { receiptStatus } : {}),
                };
              }
              ownedClientTurnClaim = claim.claim;
            }
          }
          // archive#1224 HIGH fix (independent review): everything from here
          // through the return below is wrapped in ONE try/finally so every
          // exit path — including `reserveAttachmentCapacity` throwing
          // before `adapter.sendTurn` is ever called, and
          // `assertAdapterCurrentAfterCommand` throwing AFTER it succeeds —
          // resolves or releases the claim. Two prior gaps (both silently
          // leaked the claim, either forever or until this thread's next
          // dedup attempt polled past the timeout) are closed by this.
          // `claimOutcome` flips to 'resolve' the moment the turn is
          // genuinely accepted by the adapter and NOT aborted — from that
          // point on, a later Station-side bookkeeping failure
          // (`assertAdapterCurrentAfterCommand`) must still resolve: the
          // adapter has already started the turn, so a retry must attach to
          // THAT turn rather than risk calling `adapter.sendTurn` a second
          // time.
          let claimOutcome: 'resolve' | 'release' | 'retain' = 'release';
          let obtainedResult: ProviderTurnStartResult | undefined;
          try {
            const attachmentReservationBytes = attachments.reduce(
              (total, attachment) => total + attachment.dataUrl.length,
              0,
            );
            this.options.eventStore?.reserveAttachmentCapacity(
              turnInput.threadId,
              attachmentReservationBytes,
            );
            let result: ProviderTurnStartResult;
            const startedAt = performance.now();
            try {
              throwIfAborted(turnInput.signal);
              this.assertAdapterCurrent(adapter);
              result = await this.sessionExecutionCoordinator.runTurnStart(
                turnInput.threadId,
                async (boundary) => {
                  const current = await this.readSession(
                    turnInput.threadId,
                    INTERNAL_SESSION_READ_SCOPE,
                  );
                  if (
                    current &&
                    foldedSessionLifecycleState(
                      current.session.lifecycleState,
                    ) === 'completed'
                  ) {
                    throw new SessionEndedError();
                  }
                  const invoke = async () => {
                    const begun = boundary.beginInvocation(
                      new Date().toISOString(),
                    );
                    if (begun.kind !== 'applied') {
                      claimOutcome = 'retain';
                      boundary.indeterminate(new Date().toISOString());
                      throw new SessionTurnStartIndeterminateError();
                    }
                    let providerAccepted = false;
                    let turnCorrelation:
                      | ReturnType<typeof createAuthorizedTurnCorrelation>
                      | undefined;
                    let nativeOutputRelay:
                      | ReturnType<typeof createNativeOutputRelayCompanion>
                      | undefined;
                    try {
                      // SessionExecutionCoordinator serializes this callback per
                      // thread, so one bounded in-flight origin is sufficient.
                      this.clientOriginTurns.begin(
                        turnInput.threadId,
                        context?.clientOrigin,
                        context?.principal,
                      );
                      // The Station-agent adapter owns the canonical provider
                      // turn id for this engine, so mint it before crossing its
                      // internal HTTP relay. The resulting ALS scope is only
                      // available to that relay's model invocation; external
                      // adapters ignore it and no caller can supply it through
                      // the public command schema. An ownerless/internal turn
                      // deliberately receives no correlation rather than an
                      // invented account join.
                      const accountId =
                        adapter.provider === 'station-agent'
                          ? (this.sessionAuthz.sessionOwnerUserId(
                              turnInput.threadId,
                            ) ?? context?.userId)
                          : undefined;
                      turnCorrelation =
                        typeof accountId === 'string' && accountId.trim() !== ''
                          ? createAuthorizedTurnCorrelation({
                              accountId,
                              sessionId: turnInput.threadId,
                              ...(turnInput.clientTurnId
                                ? { clientTurnId: turnInput.clientTurnId }
                                : {}),
                              ...((context?.tenantExecutionContext ??
                              boundTenant)
                                ? {
                                    tenantId: String(
                                      (context?.tenantExecutionContext ??
                                        boundTenant)!.tenantId,
                                    ),
                                  }
                                : {}),
                            })
                          : undefined;
                      // The native-output companion is composed only after the
                      // command's normal read authorization gate above. Its
                      // PrincipalRef is attribution; this live lease repeats
                      // authorization, adapter identity, quarantine, and exact
                      // turn generation on every native-call admission.
                      const nativeTurn = turnCorrelation;
                      if (
                        adapter.provider === 'station-agent' &&
                        nativeTurn &&
                        context?.principal &&
                        typeof context.userId === 'string' &&
                        context.userId.trim() !== ''
                      ) {
                        const nativeTurnId = nativeTurn.turnId;
                        const nativeWorkspaceIsolation =
                          this.readLatestSessionStartMetadata(
                            turnInput.threadId,
                          )?.workspaceIsolation;
                        nativeOutputRelay = createNativeOutputRelayCompanion({
                          workspaceRequired:
                            !!nativeWorkspaceIsolation &&
                            typeof nativeWorkspaceIsolation === 'object' &&
                            'mode' in nativeWorkspaceIsolation &&
                            nativeWorkspaceIsolation.mode === 'worktree',
                          authority: this.nativeOutputGrants,
                          facts: {
                            threadId: turnInput.threadId,
                            turnId: nativeTurnId,
                            principal: context.principal,
                            ...((context.tenantExecutionContext ?? boundTenant)
                              ? {
                                  tenantId: String(
                                    (context.tenantExecutionContext ??
                                      boundTenant)!.tenantId,
                                  ),
                                }
                              : {}),
                            adapterId: adapter.provider,
                            ...((this.sessionReadModel.get(turnInput.threadId)
                              ?.cwd ??
                            this.options.eventStore?.readSessionByThread(
                              turnInput.threadId,
                            )?.cwd)
                              ? {
                                  workspaceRoot:
                                    this.sessionReadModel.get(
                                      turnInput.threadId,
                                    )?.cwd ??
                                    this.options.eventStore?.readSessionByThread(
                                      turnInput.threadId,
                                    )?.cwd,
                                }
                              : {}),
                          },
                          sourceLease: {
                            isCurrent: () =>
                              this.nativeOutputTurnGenerations.get(
                                turnInput.threadId,
                              ) === nativeTurnId &&
                              !this.quarantinedThreads.has(
                                turnInput.threadId,
                              ) &&
                              this.isAdapterCurrent(adapter) &&
                              this.sessionAuthz.canReadSessionForCommand(
                                turnInput.threadId,
                                context.userId,
                                context.tenantExecutionContext ?? boundTenant,
                              ),
                          },
                          declarationOperation: this.nativeOutputDeclarations,
                        });
                        if (nativeOutputRelay) {
                          this.nativeOutputTurnGenerations.set(
                            turnInput.threadId,
                            nativeTurnId,
                          );
                        }
                      }
                      const nativeForeground =
                        adapter.provider === 'station-agent' &&
                        internal?.foregroundInvocationAdmission
                          ? createNativeForegroundRelay(
                              internal.foregroundInvocationAdmission,
                              {
                                threadId: turnInput.threadId,
                                workspaceRoot:
                                  this.sessionReadModel.get(turnInput.threadId)
                                    ?.cwd ??
                                  this.options.eventStore?.readSessionByThread(
                                    turnInput.threadId,
                                  )?.cwd,
                                userId: accountId!,
                                modelId: turnInput.modelId,
                                clientTurnId: turnInput.clientTurnId,
                                ambientContext: turnInput.ambientContext,
                              },
                            )
                          : undefined;
                      if (nativeForeground && !turnCorrelation)
                        throw new ForegroundInvocationUnavailableError();
                      const sendAdapter = () =>
                        nativeForeground
                          ? runWithNativeForegroundRelay(nativeForeground, () =>
                              adapter.sendTurn(turnInput),
                            )
                          : adapter.sendTurn(turnInput);
                      const accepted = await withTenantExecutionContext(
                        context?.tenantExecutionContext ?? boundTenant,
                        () =>
                          turnCorrelation
                            ? runWithAuthorizedTurnCorrelation(
                                turnCorrelation,
                                () =>
                                  nativeOutputRelay
                                    ? runWithNativeOutputRelayCompanion(
                                        nativeOutputRelay,
                                        sendAdapter,
                                      )
                                    : sendAdapter(),
                              )
                            : sendAdapter(),
                      );
                      providerAccepted = true;
                      // The provider has now named the exact turn. Publish a
                      // buffered early start before local settlement can turn
                      // the command indeterminate; receipt state cannot erase
                      // an already-observed canonical runtime fact.
                      const earlyOriginEvent = this.clientOriginTurns.settle(
                        turnInput.threadId,
                        accepted.turnId,
                        context?.clientOrigin,
                        context?.principal,
                      );
                      if (earlyOriginEvent) {
                        this.projectAndPublishEvent(earlyOriginEvent);
                      }
                      const settled = boundary.accepted(
                        accepted.turnId,
                        new Date().toISOString(),
                      );
                      if (settled.kind !== 'applied') {
                        claimOutcome = 'retain';
                        throw new SessionTurnStartIndeterminateError();
                      }
                      if (
                        !this.sessionExecutionCoordinator.markTurnAccepted(
                          turnInput.threadId,
                          accepted.turnId,
                        )
                      ) {
                        claimOutcome = 'retain';
                        throw new SessionTurnStartIndeterminateError();
                      }
                      return accepted;
                    } catch (error) {
                      if (!providerAccepted) {
                        this.clientOriginTurns.cancel(turnInput.threadId);
                        if (nativeOutputRelay && turnCorrelation) {
                          this.nativeOutputTurnGenerations.delete(
                            turnInput.threadId,
                          );
                          this.nativeOutputGrants.retireTerminal(
                            turnInput.threadId,
                            turnCorrelation.turnId,
                          );
                        }
                      }
                      if (error instanceof SessionTurnStartIndeterminateError) {
                        throw error;
                      }
                      claimOutcome = 'retain';
                      boundary.indeterminate(new Date().toISOString());
                      throw new SessionTurnStartIndeterminateError();
                    }
                  };
                  return internal?.foregroundInvocationAdmission
                    ? internal.foregroundInvocationAdmission.invoke(
                        adapter.provider === 'station-agent'
                          ? 'native-relay'
                          : 'turn',
                        {
                          threadId: turnInput.threadId,
                          // `sendTurn` carries no Agent/Project fields. The
                          // capability bound this exact thread at guarded
                          // start, so its captured identities are the only
                          // non-inferred facts available here.
                          agentId:
                            internal.foregroundInvocationAdmission.agentId,
                          projectSlug:
                            internal.foregroundInvocationAdmission.project.slug,
                          message: turnInput.displayInput ?? turnInput.input,
                        },
                        invoke,
                      )
                    : invoke();
                },
              );
            } catch (error) {
              if (!(error instanceof SessionTurnStartIndeterminateError)) {
                this.options.eventStore?.releaseAttachmentCapacity(
                  turnInput.threadId,
                  attachmentReservationBytes,
                );
              }
              throw error;
            }
            obtainedResult = result;
            // Durable provider acceptance is the authoritative no-replay
            // boundary. Everything below is projection/observation and may
            // fail without making this client turn executable again.
            claimOutcome = 'resolve';
            if (turnInput.signal?.aborted) {
              // The provider accepted the turn before cancellation. A
              // successful interrupt request is not canonical terminal
              // evidence, so retain the exact accepted boundary and resolve
              // the client-turn claim to this provider turn. A later exact
              // canonical terminal event owns boundary removal.
              try {
                await this.adapterRetirement.runCleanupWithinDeadline(
                  () =>
                    adapter
                      .interruptTurn(turnInput.threadId, result.turnId)
                      .then(() => undefined),
                  `${adapter.provider} aborted turn cleanup`,
                );
              } catch (error) {
                this.warnBestEffort(
                  'Accepted provider turn interrupt request failed',
                  {
                    provider: adapter.provider,
                    threadId: turnInput.threadId,
                    turnId: result.turnId,
                    error:
                      error instanceof Error ? error.message : String(error),
                  },
                );
              }
            }
            this.modelLaunch.recordAcceptedModelLaunchPlan(
              adapter,
              turnPlan,
              'turn',
              turnRequestedOverride,
            );
            try {
              this.assertAdapterCurrentAfterCommand(adapter);
            } catch (error) {
              this.warnBestEffort(
                'Provider adapter changed after accepted turn',
                {
                  provider: adapter.provider,
                  threadId: turnInput.threadId,
                  turnId: result.turnId,
                  error: error instanceof Error ? error.message : String(error),
                },
              );
            }
            try {
              adapterTurnDuration.record(performance.now() - startedAt, {
                provider: adapter.provider,
              });
              for (const attachment of attachments) {
                const attributes = {
                  provider: adapter.provider,
                  kind: attachment.kind,
                  mime_type: attachment.mimeType,
                };
                chatAttachmentsDispatched.add(1, attributes);
                chatAttachmentBytesDispatched.add(attachment.size, attributes);
              }
            } catch {
              // Accepted provider truth is authoritative over metrics.
            }
            try {
              this.persistReceipt(receipt);
            } catch (error) {
              receiptStatus = 'unavailable';
              this.warnBestEffort('Accepted turn receipt persistence failed', {
                provider: adapter.provider,
                threadId: turnInput.threadId,
                turnId: result.turnId,
                error: error instanceof Error ? error.message : String(error),
              });
            }
            try {
              this.monitoringBridge.onTurnDispatched({
                provider: adapter.provider,
                threadId: turnInput.threadId,
                turnId: result.turnId,
                prompt: turnInput.displayInput ?? turnInput.input,
              });
            } catch {
              // Monitoring is an observer and cannot overturn acceptance.
            }
            return {
              receipt,
              result,
              ...(receiptStatus === 'unavailable' ? { receiptStatus } : {}),
            };
          } finally {
            if (ownedClientTurnClaim) {
              if (claimOutcome === 'resolve' && obtainedResult) {
                ownedClientTurnClaim.resolve(obtainedResult.turnId);
              } else if (claimOutcome === 'release') {
                ownedClientTurnClaim.release();
              }
            }
            // UX audit T1 review: this is the one moment the service knows
            // which provider turn a client's dispatch key produced, so it is
            // where a Stop recorded before that turn existed gets bound to
            // it. A dispatch that RELEASED its claim produced no turn, so its
            // pending cancel is discarded rather than left armed to catch an
            // unrelated later one.
            this.cooperativeStop.bindPendingTurnInterrupt(
              turnInput.threadId,
              clientTurnId,
              claimOutcome === 'resolve' ? obtainedResult?.turnId : undefined,
            );
          }
        }
        case 'interruptTurn': {
          // archive#3493 residual 1: mid-materialisation there IS work to
          // cancel — the turn that triggered the start is about to be
          // announced, and the dormant branch would answer `no-active-turn`
          // and do nothing. `isDormantSessionThread` now reads a
          // materialising thread as NOT dormant, so this falls through to
          // adapter resolution, which cannot find the not-yet-bound engine
          // and takes the engine-session-not-yet path below — recording the
          // cancel for the thread's next `turn.started` and answering
          // `pending-turn-start`. No separate branch: injecting one here
          // proved redundant with that existing path.
          // archive#3476: a session restored at boot holds no engine, so
          // there is nothing running to interrupt and nothing to spawn one
          // for. Deliberately NOT materialised — starting an engine in order
          // to cancel it would be the whole defect this issue is about.
          if (this.isDormantSessionThread(command.threadId)) {
            this.persistReceipt(receipt);
            const dormant: InterruptTurnResult = {
              outcome: 'no-active-turn',
              threadId: command.threadId,
            };
            return { receipt, result: dormant };
          }
          let adapter: ProviderAdapterShape;
          try {
            adapter = await resolveOrchestrationAdapterForThread({
              threadId: command.threadId,
              threadProviders: this.threadProviders,
              requireAdapter: (provider) => this.requireAdapter(provider),
              adapters: this.options.adapterRegistry.list(),
            });
          } catch {
            // UX audit T1 (live verification): the engine session for this
            // thread does not exist YET. A dispatched turn takes 0.5-2.6s to
            // reach `turn.started`, and refusing the whole command inside that
            // window is what made every real Stop press fail with
            // `No provider session found for thread`. Record the cancel
            // against the thread instead — `consumeAdapterEvents` applies it
            // to that thread's next `turn.started` — and say exactly that,
            // rather than claiming a stop that has not happened.
            this.cooperativeStop.recordPendingTurnInterrupt(command.threadId, {
              expiresAt: Date.now() + PENDING_TURN_INTERRUPT_TTL_MS,
              startedTurnIds: new Set<string>(),
              ...(command.clientTurnId
                ? { clientTurnId: command.clientTurnId }
                : {}),
              ...(command.turnId ? { turnId: command.turnId } : {}),
            });
            this.persistReceipt(receipt);
            const pending: InterruptTurnResult = {
              outcome: 'pending-turn-start',
              threadId: command.threadId,
            };
            return { receipt, result: pending };
          }
          this.assertAdapterCurrent(adapter);
          // UX audit T1: the settlement this returns is the ONLY thing that
          // knows whether the engine acknowledged (session kept warm and
          // resumable) or the budget expired and Station tore the process
          // down. It used to be discarded, which left the composer free to
          // announce "User canceled the ongoing request" for a stop whose
          // outcome nothing had computed.
          const interrupted =
            await this.cooperativeStop.interruptUserTurnCooperatively(
              adapter,
              command.threadId,
              command.turnId,
            );
          if (
            interrupted.outcome === 'cooperative' ||
            interrupted.outcome === 'forced'
          ) {
            // Interrupt revokes now; the later terminal append remains the
            // normal retirement/cleanup boundary for non-interrupted turns.
            const nativeTurnId = this.nativeOutputTurnGenerations.get(
              command.threadId,
            );
            if (nativeTurnId) {
              this.nativeOutputTurnGenerations.delete(command.threadId);
              this.nativeOutputGrants.retireTerminal(
                command.threadId,
                nativeTurnId,
              );
            }
          }
          this.persistReceipt(receipt);
          return { receipt, result: interrupted };
        }
        case 'steerTurn': {
          // archive#3476: same as interrupt — no engine, therefore no live
          // turn to steer. `no-active-turn` is the existing vocabulary for
          // exactly this and is what the caller would have received anyway
          // once a freshly-restarted engine reported no turn in flight.
          if (this.isDormantSessionThread(command.threadId)) {
            const result: SteerTurnResult = {
              outcome: 'no-active-turn',
              threadId: command.threadId,
            };
            orchestrationSteerDispatches.add(1, {
              outcome: result.outcome,
              engine:
                this.sessionReadModel.get(command.threadId)?.provider ??
                'unknown',
            });
            steerMetricRecorded = true;
            this.persistReceipt(receipt);
            return { receipt, result };
          }
          const adapter = await resolveOrchestrationAdapterForThread({
            threadId: command.threadId,
            threadProviders: this.threadProviders,
            requireAdapter: (provider) => this.requireAdapter(provider),
            adapters: this.options.adapterRegistry.list(),
          });
          const matrix = ENGINE_CAPABILITY_MATRICES[adapter.provider];
          const engineId = matrix?.engineId ?? engineIdForAdapter(adapter);
          steerMetricEngine = engineId;
          const engineName =
            engineDisplayLabel(engineId) ?? adapter.metadata.displayName;
          if (!matrix?.midTurnSteer || !adapter.steerTurn) {
            const result: SteerTurnResult = {
              outcome: 'unsupported-engine',
              threadId: command.threadId,
              engineId,
              engineName,
            };
            orchestrationSteerDispatches.add(1, {
              outcome: result.outcome,
              engine: engineId,
            });
            steerMetricRecorded = true;
            this.persistReceipt(receipt);
            return { receipt, result };
          }
          // archive#3559: `activeTurnIdForEvents` folds via `nextActiveTurnId`,
          // which reads only `ACTIVE_TURN_FOLD_METHODS` and treats every
          // other canonical method as a pass-through no-op — so narrowing
          // the query to that shared list is bit-identical to folding the
          // full log (pinned by a differential test against all 27 canonical
          // methods, alongside `InternalStopSuppression.arm`'s narrowing —
          // see its docblock for the same idiom and the cost breakdown: row
          // count and `JSON.parse` savings, NOT attachment-blob hydration,
          // which fires only on `turn.started` and is paid identically
          // either way). Importing the constant, rather than a third
          // hand-duplicated literal, keeps this call site and
          // `InternalStopSuppression.arm` from drifting from EACH OTHER — it
          // does not, by itself, keep either in lockstep with
          // `nextActiveTurnId` gaining a sixth fold-relevant branch (a
          // hand-typed literal here would be no more exposed to that than
          // the constant is). That protection is the differential test's
          // job: it replays every non-fold-relevant method a second time
          // while a turn is genuinely open, so a sixth branch excluded from
          // this list diverges observably instead of firing into untracked
          // state.
          const activeTurnId = activeTurnIdForEvents(
            (
              this.options.eventStore?.listEventsByMethods(
                command.threadId,
                ACTIVE_TURN_FOLD_METHODS,
              ) ?? []
            ).map((stored) => stored.payload),
          );
          if (
            !activeTurnId ||
            (command.turnId && command.turnId !== activeTurnId)
          ) {
            const result: SteerTurnResult = {
              outcome: 'no-active-turn',
              threadId: command.threadId,
            };
            orchestrationSteerDispatches.add(1, {
              outcome: result.outcome,
              engine: engineId,
            });
            steerMetricRecorded = true;
            this.persistReceipt(receipt);
            return { receipt, result };
          }
          // archive#4075 stage 2 review round 1 (F2, MEDIUM/HIGH): a
          // steer's `turn.started (inputKind:'steer')` reuses the SAME
          // turnId as the turn it steers, so two concurrent steers on one
          // thread collide on the exact same `ClientOriginTurnPropagation`
          // key regardless of whether either carries a `clientOrigin`/
          // `principal` to reserve (`begin()`'s own `false` return
          // conflates "nothing to reserve" with "already reserved" — see
          // `inFlightSteers`'s docblock). This is the one true
          // serialization gate: a second steer arriving while an earlier
          // one on the SAME thread hasn't settled yet is refused outright,
          // never touching `begin`/`cancel`/`settle` for a slot this call
          // never won — a refused steer is honest; a misattributed one is
          // not.
          if (this.inFlightSteers.has(command.threadId)) {
            const result: SteerTurnResult = {
              outcome: 'concurrent-steer',
              threadId: command.threadId,
            };
            orchestrationSteerDispatches.add(1, {
              outcome: result.outcome,
              engine: engineId,
            });
            steerMetricRecorded = true;
            this.persistReceipt(receipt);
            return { receipt, result };
          }
          this.inFlightSteers.add(command.threadId);
          try {
            try {
              this.assertAdapterCurrent(adapter);
              // archive#4075 stage 2: the same begin/settle propagation
              // `sendTurn` uses above (:3700/:3751 in this file) — reserved
              // BEFORE the adapter call so the steer's own `turn.started
              // (inputKind:'steer')` (published asynchronously through the
              // adapter's own event queue, not synchronously here) picks up
              // the STEERING caller's origin/principal rather than the
              // dispatching caller's or none at all. `settle` reuses
              // `activeTurnId`: steer never mints a new turn id, it appends
              // to the one already open. The `inFlightSteers` gate above
              // means this thread can never have a second steer racing
              // here, so `begin()`'s return needs no check — exactly like
              // `sendTurn`'s own ignored-return call above.
              this.clientOriginTurns.begin(
                command.threadId,
                context?.clientOrigin,
                context?.principal,
              );
              try {
                await adapter.steerTurn(
                  command.threadId,
                  command.input,
                  activeTurnId,
                );
              } catch (steerError) {
                // Mirrors sendTurn's own `!providerAccepted` branch above
                // (:3780): the adapter never accepted this steer, so there
                // is no eventual `turn.started` to attribute — discard the
                // reservation rather than settling it into a permanently
                // unmatched `#accepted` entry.
                this.clientOriginTurns.cancel(command.threadId);
                throw steerError;
              }
              const earlySteerOriginEvent = this.clientOriginTurns.settle(
                command.threadId,
                activeTurnId,
                context?.clientOrigin,
                context?.principal,
              );
              if (earlySteerOriginEvent) {
                this.projectAndPublishEvent(earlySteerOriginEvent);
              }
              this.assertAdapterCurrentAfterCommand(adapter);
            } catch (error) {
              if (
                error instanceof ProviderTurnEndedError ||
                !this.isAdapterCurrent(adapter)
              ) {
                const result: SteerTurnResult = {
                  outcome: 'no-active-turn',
                  threadId: command.threadId,
                };
                orchestrationSteerDispatches.add(1, {
                  outcome: result.outcome,
                  engine: engineId,
                });
                steerMetricRecorded = true;
                this.persistReceipt(receipt);
                return { receipt, result };
              }
              throw error;
            }
          } finally {
            this.inFlightSteers.delete(command.threadId);
          }
          const result: SteerTurnResult = {
            outcome: 'steered',
            threadId: command.threadId,
            turnId: activeTurnId,
          };
          orchestrationSteerDispatches.add(1, {
            outcome: result.outcome,
            engine: engineId,
          });
          steerMetricRecorded = true;
          this.persistReceipt(receipt);
          return { receipt, result };
        }
        case 'respondToRequest': {
          const adapter = await resolveOrchestrationAdapterForThread({
            threadId: command.threadId,
            threadProviders: this.threadProviders,
            requireAdapter: (provider) => this.requireAdapter(provider),
            adapters: this.options.adapterRegistry.list(),
          });
          this.assertAdapterCurrent(adapter);
          await adapter.respondToRequest(
            command.threadId,
            command.requestId,
            command.decision,
          );
          this.assertAdapterCurrentAfterCommand(adapter);
          this.persistReceipt(receipt);
          return { receipt, result: undefined };
        }
        case 'stopSession': {
          // archive#3493 residual 1: a Stop that lands mid-materialisation
          // must tear down the engine that is starting, not report success
          // around it. Await the in-flight start (bounded by the
          // adapter-stop deadline below — never unbounded), then take the
          // live path against the bound adapter. A
          // start that FAILS leaves nothing to stop — its failure evidence
          // is already recorded on the thread (archive#1090) — so fall
          // through to the dormant branch against the persisted row, whose
          // `error` status the dormant write now preserves.
          const materializing = this.materializingSessions.get(
            command.threadId,
          );
          if (materializing) {
            // Bounded (fix-round HIGH): the wrapped promise settles on start
            // success AND failure — a failed start leaves nothing to stop,
            // so both fall through to the dormant check below — which makes
            // a rejection from the race unambiguously the deadline. Reuses
            // the adapter-stop deadline: a Stop that cannot settle within
            // the time an adapter is allowed to take stopping refuses,
            // typed, instead of hanging on a wedged `startSession`.
            const timeoutMs = this.adapterRetirement.adapterStopTimeoutMs();
            try {
              await this.adapterRetirement.runOperationWithinDeadline(
                materializing.then(
                  () => undefined,
                  () => undefined,
                ),
                `stopSession await of in-flight materialisation for ${command.threadId}`,
                Date.now() + timeoutMs,
              );
            } catch {
              throw new SessionStopWhileStartingError(
                command.threadId,
                timeoutMs,
              );
            }
          }
          // archive#3476: stopping a session restored at boot must not first
          // start it. There is no process to tear down, so the whole of
          // `stopUserSessionImmediately`'s observable effect is its two local
          // steps — persist the row as resumable, forget the live binding —
          // which is what this does.
          if (this.isDormantSessionThread(command.threadId)) {
            this.cooperativeStop.stopDormantSessionImmediately(
              command.threadId,
            );
            this.persistReceipt(receipt);
            return { receipt, result: undefined };
          }
          const adapter = await resolveOrchestrationAdapterForThread({
            threadId: command.threadId,
            threadProviders: this.threadProviders,
            requireAdapter: (provider) => this.requireAdapter(provider),
            adapters: this.options.adapterRegistry.list(),
          });
          this.assertAdapterCurrent(adapter);
          // `stopSession` owns irreversible internal cleanup (smokes,
          // quarantine, and explicit ownership reclamation). User Stop task
          // dispatches `interruptTurn`, which alone gets the bounded,
          // resumable cooperative protocol.
          await this.cooperativeStop.stopUserSessionImmediately(
            adapter,
            command.threadId,
          );
          this.persistReceipt(receipt);
          return { receipt, result: undefined };
        }
      }
    } catch (error) {
      if (command.type === 'steerTurn' && !steerMetricRecorded) {
        orchestrationSteerDispatches.add(1, {
          outcome: 'failed',
          engine: steerMetricEngine,
        });
      }
      const failedReceipt = {
        ...receipt,
        status:
          error instanceof ModelLaunchPlanUnavailableError ||
          error instanceof SessionReattachConflictError ||
          error instanceof SessionEndedError ||
          // archive#3493 fix round: a Stop refused because the session is
          // still starting is a refusal to act, not a failed action.
          error instanceof SessionStopWhileStartingError
            ? ('rejected' as const)
            : ('failed' as const),
      };
      this.persistReceipt(failedReceipt);
      throw new OrchestrationCommandDispatchError(
        error instanceof Error ? error.message : String(error),
        failedReceipt,
        undefined,
        'persisted',
        error instanceof SessionTurnStartIndeterminateError,
        // Narrowly forwarded: the ended-session refusal carries its code
        // through the wrapper so clients can translate it. Other
        // inner errors keep their existing (message-only) projection
        // deliberately — widening which codes leak through this seam is a
        // separate, per-code decision.
        error instanceof SessionEndedError ||
          error instanceof SessionStopWhileStartingError
          ? error.code
          : undefined,
      );
    }
  }

  /**
   * Run one explicit, bounded, no-tools chat turn and then erase its ephemeral
   * orchestration session. This is never called by inventory/menu reads.
   *
   * Forwarder: the behaviour lives in `ConnectionSmoke` (epic archive#4024,
   * archive#4195). `initialize()` stays HERE — this is one of the T9 latch-carrying
   * public forwarders, and the module must never take an `initialize` dep.
   */
  async runConnectionSmoke(
    input: ConnectionSmokeRunInput,
  ): Promise<ConnectionSmokeRunResult> {
    this.initialize();
    return this.connectionSmoke.runConnectionSmoke(input);
  }

  readCommandReceipt(
    commandId: string,
    authority: SessionReadScope,
  ): OrchestrationCommandReceipt | null {
    const receipt =
      this.options.eventStore?.readCommandReceipt(commandId) ?? null;
    return receipt &&
      this.sessionAuthz.canReadSession(receipt.threadId, authority)
      ? receipt
      : null;
  }

  listCommandReceipts(
    authority: SessionReadScope,
    threadId?: string,
  ): OrchestrationCommandReceipt[] {
    return (
      this.options.eventStore?.listCommandReceipts(threadId) ?? []
    ).filter((receipt) =>
      this.sessionAuthz.canReadSession(receipt.threadId, authority),
    );
  }

  seedSessionRecord(input: {
    threadId: string;
    provider: EngineId;
    model?: string;
    status?: ProviderSession['status'];
    controlMode?: ProviderSession['controlMode'];
    attachedSource?: ProviderSession['attachedSource'];
  }): ProviderSession {
    this.initialize();
    const now = new Date().toISOString();
    const session: ProviderSession = {
      provider: input.provider,
      threadId: input.threadId,
      status: input.status ?? 'ready',
      model: input.model,
      controlMode: input.controlMode,
      attachedSource: input.attachedSource,
      createdAt: now,
      updatedAt: now,
    };
    this.trackSession(
      session,
      this.options.adapterRegistry.get(input.provider),
    );
    this.options.eventStore?.upsertSession(session);
    return session;
  }

  /**
   * Ownership is checked from Station's own read model before any provider
   * adapter lookup. Attached sessions are not adapter-owned and must never
   * trigger discovery or a provider mutation while rejecting a command.
   */
  private isReadOnlyAttachedSession(threadId: string): boolean {
    const session =
      this.sessionReadModel.get(threadId) ??
      this.options.eventStore
        ?.readSessions()
        .find((candidate) => candidate.threadId === threadId);
    return session?.controlMode === 'read-only-attached';
  }

  private isPeerDelegationActivityRecord(threadId: string): boolean {
    if (!threadId.startsWith('peer-delegation:')) return false;
    return Boolean(
      this.sessionReadModel.get(threadId) ??
        this.options.eventStore?.readSessionByThread(threadId),
    );
  }

  /**
   * Read the Flow run bound to a session (null when the session is not
   * Flow-bound). REST callers use this to resolve the run id, then operate
   * through the existing /api/projects/:slug/flow routes.
   *
   * The view carries freshness alongside the run (archive#189 S1) so every
   * consumer states what the run has actually evaluated. `run.state.updated_at`
   * is not that: it moves on writes no gate was involved in, which is how the
   * gates pane came to read `step=plan status=active` for a run that had never
   * been evaluated at all.
   */
  async readSessionFlowRun(
    threadId: string,
    authority: SessionReadScope,
  ): Promise<
    (SessionFlowBinding & { run: FlowRunStatus } & FlowRunFreshness) | null
  > {
    this.initialize();
    return this.flowPolicy.readSessionFlowRun(threadId, authority);
  }

  /**
   * The Builder run joined to this session (archive#189 S4), read entirely
   * from the published sidecar contract.
   *
   * Deliberately a SEPARATE read from `readSessionFlowRun`, not a field on it.
   * Historical sessions may still carry a retired Station delivery binding,
   * while the Builder run is flow-agents-owned. Folding those into one figure
   * is precisely how a stalled legacy run got to look like Builder progress.
   * Callers render two rows or none.
   */
  async readSessionBuilderRun(
    threadId: string,
    authority: SessionReadScope,
  ): Promise<SessionBuilderRunView | null> {
    this.initialize();
    return this.flowPolicy.readSessionBuilderRun(threadId, authority);
  }

  /**
   * Attach evidence to the session's Flow run without the caller knowing the
   * run id (session -> run resolution happens here).
   */
  async attachSessionEvidence(
    threadId: string,
    options: AttachFlowEvidenceOptions,
  ): Promise<FlowEvidenceEntry> {
    this.initialize();
    return this.flowPolicy.attachSessionEvidence(threadId, options);
  }

  /**
   * Session-scoped `logger.child()` (archive#1897 logging slice 3): every
   * warn/debug this class emits while starting/reattaching a session goes
   * through the logger this returns, so those lines carry the SAME
   * `conversationId`/`agentSlug` bindings a `read_logs?q=<id>` query and a
   * `MonitoringEmitter` event key off (`logger-correlation.ts`). Falls back
   * to the un-bound instance logger when `options.logger.child` is absent
   * (a narrow `{ debug, warn }` test double, or a caller that never wired
   * the real seam) — this method never changes observable behavior beyond
   * the added bindings.
   */
  private sessionLogger(input: {
    threadId: string;
    metadata?: Record<string, unknown>;
  }): OrchestrationServiceOptions['logger'] {
    const agentSlug =
      typeof input.metadata?.agentSlug === 'string'
        ? input.metadata.agentSlug
        : undefined;
    return (
      this.options.logger.child?.(
        sessionCorrelationBindings({
          conversationId: input.threadId,
          agentSlug,
        }),
      ) ?? this.options.logger
    );
  }

  /**
   * Read the workflow sidecar binding + current durable state for a session
   * (null when the session is not task-bound).
   *
   * NO CALLER TODAY (archive#4218 review M1): the previous sentence here
   * claimed REST callers resolve the task slug through this method before
   * reading /api/projects/:slug/workflow. That route exists
   * (`routes/evidence/workflow-sidecars.ts`) but reaches the sidecar
   * service directly — nothing has ever resolved a slug here. Retained as
   * public surface, not because a caller depends on it.
   */
  async readSessionWorkflowState(
    threadId: string,
    authority: SessionReadScope,
  ): Promise<
    | (SessionWorkflowBinding & {
        state: ReturnType<WorkflowSidecarService['readState']>;
      })
    | null
  > {
    this.initialize();
    return this.flowPolicy.readSessionWorkflowState(threadId, authority);
  }

  private runtimeKindFor(provider: EngineId): string {
    if (provider === 'acp') return 'acp';
    return engineExecutionForAdapter(
      this.options.adapterRegistry.get(provider),
    );
  }

  private monitoringContextFor(threadId: string): {
    /** Absent when the session reported none (archive#3082). */
    slug?: string;
    conversationId: string;
    /** Absent when the session reported none. */
    userId?: string;
    model?: string;
  } | null {
    const attribution = this.sessionAttributionFor(threadId);
    if (!attribution) {
      if (!this.monitoringUnconfiguredThreads.has(threadId)) {
        this.monitoringUnconfiguredThreads.add(threadId);
        this.options.logger.debug(
          'Monitoring dropped turn for unconfigured session',
          { threadId },
        );
      }
      return null;
    }
    this.monitoringUnconfiguredThreads.delete(threadId);
    return attribution;
  }

  /**
   * Who a session belongs to, from its own `session.configured` record: the
   * agent slug, the conversation id it writes its transcript under, its user
   * and model. `null` when the session was never configured and therefore has
   * no attribution to state.
   *
   * ONE derivation with two consumers — monitoring spans above, and lifetime
   * analytics through {@link listSessionUsage} (archive#3245). The
   * conversation id in particular has to be the same answer in both places:
   * it is the join key that keeps a Station-engine chat, which exists in the
   * memory substrate AND here, from being counted twice.
   */
  private sessionAttributionFor(threadId: string): {
    slug?: string;
    conversationId: string;
    userId?: string;
    model?: string;
  } | null {
    const events =
      this.options.eventStore
        ?.listSessionProjectionEvents(threadId)
        .map((stored) => stored.payload) ?? [];
    const configured = [...events]
      .reverse()
      .find((event) => event.method === 'session.configured');
    if (configured?.method !== 'session.configured') return null;
    const metadata = configured.metadata ?? {};
    // No 'unknown' literal (archive#3082): an unreported slug is an absence,
    // and substituting a string makes it indistinguishable from an agent
    // actually named unknown — permanently, in the durable record.
    const slug =
      typeof metadata.agentSlug === 'string' && metadata.agentSlug
        ? metadata.agentSlug
        : undefined;
    return {
      slug,
      conversationId:
        typeof metadata.conversationId === 'string'
          ? metadata.conversationId
          : threadId,
      userId:
        typeof metadata.userId === 'string' && metadata.userId
          ? metadata.userId
          : undefined,
      model: configured.model,
    };
  }

  private async consumeAdapterEvents(
    adapter: ProviderAdapterShape,
    controller: AbortController,
  ): Promise<void> {
    let lastThreadId: string | undefined;
    let restart = false;
    try {
      for await (let event of adapter.streamEvents({
        signal: controller.signal,
      })) {
        if (!this.isAdapterCurrent(adapter)) continue;
        if (event.method === 'session.stop-settled') {
          // This is an orchestration-owned derivation. Accepting it from an
          // adapter would let an engine label a forced stop cooperative.
          this.options.logger.warn(
            'Ignored adapter-provided cooperative-stop outcome',
            { provider: adapter.provider, threadId: event.threadId },
          );
          continue;
        }
        event = await this.captureUsagePricingSnapshot(event);
        lastThreadId = event.threadId;
        const previousState = this.readCurrentLifecycleState(event.threadId);
        // archive#3581 review BLOCK 1: `turnIdentityAnchorForEvents`, NOT
        // `activeTurnIdForEvents` — this value is stamped onto the
        // persisted event's `sessionState` (below), which
        // `deriveLifecycleTransition`'s stamp early-return then honors
        // ahead of its own `acceptsTurnTerminalEvent` guard. The clearing
        // fold (`activeTurnIdForEvents`) answers "is a turn currently
        // open", which is `undefined` after a `runtime.error`/
        // `session.exited` — the exact permissive default that let a stale
        // terminal for an EARLIER turn get stamped `sessionState:
        // 'completed'` on disk after a LATER turn's own failure. The
        // identity-anchor fold retains the last-started turn's id across
        // that clear, matching what the read-time folds
        // (`deriveLifecycleTransition`/`deriveAgentRunStatus`) compute over
        // the identical bounded projection.
        const turnIdentityAnchor = turnIdentityAnchorForEvents(
          this.options.eventStore
            ?.listSessionProjectionEvents(event.threadId)
            .map((stored) => stored.payload) ?? [],
        );
        const normalized = normalizeCanonicalRuntimeEventLifecycle(
          event,
          previousState,
          turnIdentityAnchor,
        );
        if (!this.quarantinedThreads.has(normalized.threadId)) {
          this.sessionAdapters.set(normalized.threadId, adapter);
        }
        if (!this.projectAndPublishEvent(normalized)) continue;
        this.cooperativeStop.applyPendingTurnInterrupt(adapter, normalized);
        if (normalized.method === 'session.exited') {
          this.sessionAdapters.delete(normalized.threadId);
        }
        this.flowPolicy.applyPostHocToolPolicies(adapter, normalized);
        this.flowPolicy.spoolCommandEvidence(normalized);
        if (
          normalized.previousState &&
          normalized.sessionState &&
          normalized.previousState !== normalized.sessionState
        ) {
          sessionTransitions.add(1, {
            from_state: normalized.previousState,
            to_state: normalized.sessionState,
            runtime_kind: normalized.provider,
            source: normalized.transitionSource ?? 'runtime',
            reason: normalized.transitionReason ?? 'unknown',
            outcome: 'success',
          });
          this.recordStateDuration({
            previousState: normalized.previousState,
            nextEventAt: normalized.createdAt,
            previousEventAt:
              this.options.eventStore?.latestEventForSessionState(
                normalized.threadId,
                normalized.previousState,
              )?.createdAt,
            runtimeKind: normalized.provider,
          });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (controller.signal.aborted || !this.isAdapterCurrent(adapter)) return;
      restart = true;
      // A SQLITE_BUSY from the loop's own event-store work is not an agent
      // failure: the agent connection was fine and our store was locked —
      // typically by another Station process using the same Station home
      // (archive#3304). Name the store so the operator remedy (find the
      // second process) is discoverable instead of blaming the agent.
      const storeContention = isSqliteContentionError(error);
      if (storeContention) {
        orchestrationStoreContentionObserved.add(1, {
          site: 'adapter-event-stream',
        });
      }
      this.options.logger.warn('Provider adapter event stream stopped', {
        provider: adapter.provider,
        error: message,
      });
      // Surface the failure instead of going silent: a dead adapter stream would
      // otherwise leave the active conversation blank with no error. Emit a
      // runtime.error so it is persisted + published (and rendered inline by the
      // shared event-to-message projection) for every active affected thread.
      const affectedThreads = new Set(
        [...this.sessionAdapters]
          .filter(([, owner]) => owner === adapter)
          .map(([threadId]) => threadId),
      );
      if (lastThreadId) affectedThreads.add(lastThreadId);
      for (const threadId of affectedThreads) {
        // The surfacing publish writes to the SAME store that may have just
        // thrown BUSY. Under sustained contention it throws inside this
        // catch, which would escape through the fire-and-forget consumption
        // call and leave the REMAINING threads with no runtime.error at all.
        // One thread's failed surfacing must not silence the others.
        //
        // Note what the catch costs when it fires. This event is not a delta,
        // so it flushes that thread's buffered text on its way through the
        // coalescer (archive#3350) and a delivery failure on THAT flush now
        // propagates — landing here, where it is logged as a failure to
        // surface. The thread then gets no `runtime.error` at all, which is
        // the very message archive#3304 added to name the locked store. It is
        // the accepted cost of letting a synchronous delta failure reach the
        // stream's own recovery rather than being swallowed, and the shape
        // pre-dates coalescing (the publish itself could always throw here);
        // do not narrow the try to hide it.
        try {
          this.projectAndPublishEvent({
            eventId: crypto.randomUUID(),
            provider: adapter.provider,
            threadId,
            createdAt: new Date().toISOString(),
            method: 'runtime.error',
            severity: 'error',
            message: storeContention
              ? `Orchestration event store is locked (orchestration.sqlite): another Station process may be using this Station home. ${message}`
              : `Agent connection error: ${message}`,
            retriable: true,
          });
        } catch (surfacingError) {
          this.options.logger.warn(
            'Failed to surface adapter stream failure to thread',
            {
              provider: adapter.provider,
              threadId,
              error:
                surfacingError instanceof Error
                  ? surfacingError.message
                  : String(surfacingError),
            },
          );
        }
      }
    } finally {
      if (this.adapterEventControllers.get(adapter) === controller) {
        this.adapterEventControllers.delete(adapter);
      }
      if (restart && this.isAdapterCurrent(adapter)) {
        this.consumedAdapterEventStreams.delete(adapter);
        queueMicrotask(() => this.consumeCurrentAdapterEvents());
      }
    }
  }

  private async captureUsagePricingSnapshot(
    event: CanonicalRuntimeEvent,
  ): Promise<CanonicalRuntimeEvent> {
    if (
      event.method !== 'token-usage.updated' ||
      event.pricingSnapshot ||
      !this.options.pricingSnapshotCapture
    )
      return event;
    const model = this.sessionReadModel.get(event.threadId)?.model;
    if (!model) return event;
    try {
      const snapshot = await this.options.pricingSnapshotCapture.capture({
        provider: event.provider,
        model,
        observedAt: new Date().toISOString(),
      });
      return snapshot ? { ...event, pricingSnapshot: snapshot } : event;
    } catch (error) {
      // Pricing is an optional local estimate. A catalog outage cannot lose a
      // provider usage fact; its durable omission remains visibly unpriced.
      this.options.logger.warn('Usage pricing snapshot capture failed', {
        provider: event.provider,
        model,
        error: error instanceof Error ? error.message : String(error),
      });
      return event;
    }
  }

  private isAdapterCurrent(adapter: ProviderAdapterShape): boolean {
    return this.options.adapterRegistry.get(adapter.provider) === adapter;
  }

  private assertAdapterCurrent(adapter: ProviderAdapterShape): void {
    if (!this.isAdapterCurrent(adapter)) {
      throw new Error(
        `${adapter.provider} adapter was replaced before the command could run.`,
      );
    }
  }

  private assertAdapterCurrentAfterCommand(
    adapter: ProviderAdapterShape,
  ): void {
    if (!this.isAdapterCurrent(adapter)) {
      throw new Error(
        `${adapter.provider} adapter was replaced while the command was running.`,
      );
    }
  }

  private captureAdapterSessions(
    adapter: ProviderAdapterShape,
  ): Map<string, ProviderSession> {
    return new Map(
      [...this.sessionReadModel].filter(
        ([threadId, session]) =>
          this.sessionAdapters.get(threadId) === adapter &&
          session.status !== 'closed',
      ),
    );
  }

  private finalizeStoppedAdapterSessions(
    adapter: ProviderAdapterShape,
    sessions: Map<string, ProviderSession>,
    reason: string,
  ): void {
    for (const [threadId, session] of sessions) {
      if (
        this.sessionReadModel.get(threadId) !== session ||
        this.sessionAdapters.get(threadId) !== adapter
      ) {
        continue;
      }
      this.projectAndPublishEvent({
        eventId: crypto.randomUUID(),
        provider: adapter.provider,
        threadId,
        createdAt: new Date().toISOString(),
        method: 'session.exited',
        sessionId: threadId,
        reason,
      });
      this.forgetThreadState(threadId, {
        policyThreads: true,
        flowBoundThreads: true,
      });
    }
  }

  private stopAdapterEventConsumer(adapter: ProviderAdapterShape): void {
    const controller = this.adapterEventControllers.get(adapter);
    if (!controller) return;
    this.adapterEventControllers.delete(adapter);
    controller.abort(new Error(`${adapter.provider} adapter retired.`));
  }

  /**
   * The ONE teardown seam for a thread's in-memory state (epic archive#4024,
   * archive#4131; seam map trap T2). Before this existed there were six divergent
   * copies of "forget this thread", each clearing a different subset — the
   * map calls that the single largest correctness hazard in the
   * decomposition, because moving any per-thread map into a sub-service
   * meant picking one copy's subset and silently changing the other five.
   *
   * The five maps every site already cleared are unconditional. The aspects
   * below are DECLARED divergence: each caller passes exactly the subset it
   * historically cleared, so this slice changes no behavior — it makes the
   * divergence visible at one seam. A later slice that wants to converge a
   * subset changes a flag at a named call site and owns that decision in
   * review, instead of six copies drifting silently.
   *
   * Current declared subsets (update this table when a caller changes;
   * rows 1 AND 2's flags are DECLARED at the ctor seam — the
   * `forgetThreadState` dep closures handed to CredentialProfileRecovery
   * and CooperativeStop, in that construction order — which is also why
   * those sites sort first and second in file order):
   * | caller | policyThreads | flowBoundThreads | ownerCache | turnProgress |
   * |---|---|---|---|---|
   * | CredentialProfileRecovery.quarantineSession | yes | yes | — | — |
   * | CooperativeStop.forgetLiveUserSession | yes | — | — | yes |
   * | finalizeStoppedAdapterSessions | yes | yes | — | — |
   * | clearAbandonedAdoptionMemory | — | — | yes | — |
   * | recoverSessions.quarantineSession | yes | — | yes | — |
   * | evictCollidingAttachedAliases | — | — | yes | — |
   *
   * Deliberately NOT part of this seam: the deltaCoalescer flush/forget and
   * the quarantinedThreads guard (both are ordered BEFORE teardown at their
   * sites, with in-source comments carrying why), and the eventStore actions
   * (markSessionClosed / deleteThread — durable-store decisions, not memory
   * teardown).
   */
  private forgetThreadState(
    threadId: string,
    divergent: {
      policyThreads?: boolean;
      flowBoundThreads?: boolean;
      ownerCache?: boolean;
      turnProgress?: boolean;
    } = {},
  ): void {
    // Deletion, quarantine, and replacement all converge through this owned
    // teardown seam. Revoke before clearing the auth/adapter maps so a late
    // callback cannot observe a half-retired generation.
    const nativeTurnId = this.nativeOutputTurnGenerations.get(threadId);
    if (nativeTurnId) {
      this.nativeOutputTurnGenerations.delete(threadId);
      this.nativeOutputGrants.retireTerminal(threadId, nativeTurnId);
    }
    this.sessionAdapters.delete(threadId);
    this.threadProviders.delete(threadId);
    this.sessionReadModel.delete(threadId);
    this.sessionConnectionIds.delete(threadId);
    this.sessionAuthz.forgetTenantContext(threadId);
    if (divergent.policyThreads) this.flowPolicy.forgetPolicyBinding(threadId);
    if (divergent.flowBoundThreads) this.flowPolicy.forgetFlowBinding(threadId);
    if (divergent.ownerCache)
      this.sessionAuthz.invalidateSessionOwner(threadId);
    if (divergent.turnProgress) this.turnProgress.forgetThread(threadId);
  }

  private async readPrerequisites(
    adapter: ProviderAdapterShape,
    connectionId?: string,
  ): Promise<Prerequisite[]> {
    if (!adapter.getPrerequisites) return [];
    try {
      return await adapter.getPrerequisites({ connectionId });
    } catch (error) {
      this.options.logger.warn('Failed to read adapter prerequisites', {
        provider: adapter.provider,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  private async assertAdapterReady(
    adapter: ProviderAdapterShape,
    connectionId?: string,
  ): Promise<void> {
    const prerequisites = await this.readPrerequisites(adapter, connectionId);
    const readiness = resolveRuntimeAdapterReadiness({
      adapter,
      engineId: engineIdForAdapter(adapter),
      enabled: true,
      prerequisites,
    });
    const missing = requiredMissingPrerequisites(prerequisites);

    if (missing.length === 0) {
      if (readiness.state === 'configured') {
        return;
      }
      throw new Error(
        `${adapter.provider} runtime is not ready: ${readiness.reason ?? readiness.state}`,
      );
    }

    throw new Error(
      `${adapter.provider} prerequisites missing: ${missing
        .map((item) => item.name)
        .join(', ')}`,
    );
  }

  private requireAdapter(provider: EngineId): ProviderAdapterShape {
    const adapter = this.options.adapterRegistry.get(provider);
    if (!adapter) {
      throw new Error(`Provider adapter not registered: ${provider}`);
    }
    return adapter;
  }

  /** Registered adapter declaration for execution-target preflight. */
  getProviderAdapter(provider: EngineId): ProviderAdapterShape | undefined {
    return this.options.adapterRegistry.get(provider);
  }

  private commandProvider(command: OrchestrationCommand): EngineId | null {
    if (command.type === 'adoptSession') {
      return (
        this.sessionReadModel.get(command.sourceThreadId)?.provider ??
        this.options.eventStore
          ?.readSessions()
          .find((session) => session.threadId === command.sourceThreadId)
          ?.provider ??
        null
      );
    }
    if (command.type === 'startSession') {
      return command.input.provider;
    }
    if (command.type === 'sendTurn') {
      return this.threadProviders.get(command.input.threadId) ?? null;
    }
    return this.threadProviders.get(command.threadId) ?? null;
  }

  /**
   * The only model-capability gate before adapter invocation (body lives in
   * ModelLaunchPlanning — epic archive#4024, archive#4179). Kept as a forwarder
   * deliberately: a test reach-in casts and binds this exact 4-arg name,
   * and the recovery prepareModelLaunch closure routes through it — that
   * in-file caller is what keeps biome's unsafe pass from deleting a
   * method the test suite reaches only by cast. Do not "finish the job" by
   * rewiring the recovery closure direct.
   */
  private withAcceptedModelLaunchPlan(
    adapter: ProviderAdapterShape,
    input: ProviderSessionStartInput,
    lifecycle: 'start' | 'resume',
    retainedModelId?: string,
  ): ProviderSessionStartInput {
    return this.modelLaunch.withAcceptedModelLaunchPlan(
      adapter,
      input,
      lifecycle,
      retainedModelId,
    );
  }

  private warnBestEffort(
    message: string,
    attributes: Record<string, unknown>,
  ): void {
    try {
      this.options.logger.warn(message, attributes);
    } catch {
      // Diagnostics are observers and cannot overturn authoritative state.
    }
  }

  private commandThreadId(command: OrchestrationCommand): string {
    if (command.type === 'startSession' || command.type === 'sendTurn') {
      return command.input.threadId;
    }
    if (command.type === 'adoptSession') return command.sourceThreadId;
    return command.threadId;
  }

  private clearAbandonedAdoptionMemory(reservation: AdoptionReservation): void {
    this.forgetThreadState(reservation.targetThreadId, { ownerCache: true });
    try {
      this.options.eventStore?.deleteThread(reservation.targetThreadId);
    } catch (error) {
      this.logAdoptionCleanupFailure('session state', reservation, error);
    }
  }

  private logAdoptionCleanupFailure(
    resource: string,
    reservation: AdoptionReservation,
    error: unknown,
  ): void {
    this.options.logger.warn(`Failed to discard abandoned ${resource}`, {
      provider: reservation.provider,
      threadId: reservation.targetThreadId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private persistReceipt(receipt: OrchestrationCommandReceipt): void {
    this.options.eventStore?.appendCommandReceipt(receipt);
  }

  private trackSession(
    session: ProviderSession,
    adapter?: ProviderAdapterShape,
  ): void {
    if (this.quarantinedThreads.has(session.threadId)) return;
    if (this.ephemeralSessionThreads.has(session.threadId)) {
      session.ephemeral = true;
    }
    if (adapter) this.sessionAdapters.set(session.threadId, adapter);
    // Adapter list/refresh projections do not own Station's persisted command
    // context and commonly omit it. Omission is therefore not an authoritative
    // deletion: retain the private binding established by dispatch/recovery.
    // Explicit lifecycle/quarantine cleanup paths above remain responsible for
    // deleting a retired thread's binding.
    if (session.tenantExecutionContext) {
      this.sessionAuthz.bindTenantContext(
        session.threadId,
        session.tenantExecutionContext,
      );
    }
    trackOrchestrationSession({
      threadProviders: this.threadProviders,
      sessionReadModel: this.sessionReadModel,
      session,
    });
  }

  /**
   * A webhook turn's receipt and canonical events remain durable, but the
   * session is deliberately excluded from ordinary user-facing inventories.
   * Read the event-store marker as well as the live Set so restart cannot
   * turn an ephemeral webhook session back into a listed conversation.
   */
  private isEphemeralSession(threadId: string): boolean {
    if (this.ephemeralSessionThreads.has(threadId)) return true;
    if (this.sessionReadModel.get(threadId)?.ephemeral === true) return true;
    if (this.options.eventStore?.readSessionByThread(threadId)?.ephemeral)
      return true;
    return (
      this.readLatestSessionStartMetadata(threadId)?.[
        SESSION_VISIBILITY_METADATA_KEY
      ] === 'ephemeral'
    );
  }

  /**
   * Turn-provenance moved to `turn-provenance-sidecar.ts` (epic archive#4024, the
   * one leaf sub-cut inside a C2 that is otherwise closed by inspection).
   * This forwarder stays because `routes/orchestration/orchestration.ts`
   * calls it on the service and the suite drives it the same way — a public
   * surface, not dead code.
   */
  replayTurnProvenanceSidecar(event: CanonicalRuntimeEvent): {
    provenance?: ReturnType<
      TurnProvenanceSidecar['replaySidecarFor']
    >['provenance'];
  } {
    return this.turnProvenance.replaySidecarFor(event);
  }

  /** Read-only quiescence seam for derived projections that must not race a turn. */
  hasActiveTurn(threadId: string): boolean {
    return this.sessionExecutionCoordinator.hasActiveTurn(threadId);
  }

  /**
   * archive#3350: every event reaching the publish body below pays a
   * read-model projection, a SQLite append with four projections, an
   * execution-coordinator and recovery observation, a monitoring call and a
   * synchronous bus fan-out -- and each connected SSE client then pays its own
   * lookup and frame. Content deltas arrive per model token, so that chain ran
   * per token and blew the reconnect replay budgets besides.
   *
   * Deltas are therefore batched first. Anything that is not a coalescable
   * delta flushes the buffer for its thread BEFORE publishing, so a tool call,
   * an approval or a turn boundary can never overtake the text that preceded
   * it.
   */
  private projectAndPublishEvent(event: CanonicalRuntimeEvent): boolean {
    const originEvent = this.clientOriginTurns.apply(event);
    if (!originEvent) return true;
    event = originEvent;
    // Progress is a fact about the ENGINE producing output, not about what we
    // chose to publish. The turn-stall watchdog (archive#2959) observes here,
    // so it must see every raw delta as it arrives -- batching them for
    // persistence would otherwise make a healthy fast turn look stalled.
    // `publishCanonicalEvent` therefore skips re-observing a merged delta.
    // Gated on quarantine because this observation happens BEFORE the
    // quarantine gate in `publishCanonicalEvent`, which is where every other
    // event's observation happens. A provider stop is asynchronous, so deltas
    // keep arriving after `quarantinedThreads.add`; ungated, they re-arm the
    // stall watchdog and the execution coordinator for a session that has been
    // retired — the opposite of what quarantine is for.
    if (
      isCoalescableDelta(event) &&
      !this.quarantinedThreads.has(event.threadId)
    ) {
      this.sessionExecutionCoordinator.observe(event);
      this.turnProgress.observe(event);
    }
    // NOTE the changed meaning of `true` here: it says the coalescer TOOK the
    // event, not that it was published. A taken delta is published later —
    // through `publishCanonicalEvent`, which may itself decline it (a
    // quarantined thread) — so a `true` can now stand for an event that is
    // never published at all.
    //
    // That matters because the caller does more with `false` than decide
    // whether to publish again. `consumeAdapterEvents`' `if
    // (!this.projectAndPublishEvent(normalized)) continue;` also gates the
    // `session.exited` adapter cleanup, `applyPostHocToolPolicies`,
    // `spoolCommandEvidence` and the state-transition telemetry below it, so
    // taking a quarantined thread's delta stops short-circuiting those. That
    // is safe for a delta and only for a delta: both policy hooks return
    // immediately for any method that is not `tool.started`/`tool.completed`,
    // `session.exited` is not a delta, and the transition block needs
    // `previousState !== sessionState`, which a content delta never carries.
    // Anything wider than a coalescable delta must not start returning `true`
    // here without re-reading that loop.
    if (this.deltaCoalescer.offer(event)) return true;
    return this.publishCanonicalEvent(event);
  }

  private publishCanonicalEvent(event: CanonicalRuntimeEvent): boolean {
    // archive#1399 fix round (independent review, H1/M4/M6, hardened in fix
    // round 2 per B1/B4): a provenance-sanitizing writer — see
    // `ui-block-provenance.ts`'s docblock for why it is NOT the only one
    // (`AttachedSessionFollowService#appendAndPublish` is a second) and
    // `writer-inventory.test.ts` for the enumerated, ratcheted list.
    // Sanitizing HERE, before either `eventStore.appendEvent` (persistence)
    // or the event-bus publish (the live SSE frame) below, is what makes a
    // tool-emitted UI block's `derivedFrom`/`provenanceDigest`/
    // `attestationState` host-derived and identical whether a client reads
    // it live or replays it from storage. A no-op for every event that
    // isn't a `tool.completed` carrying a `uiBlock`/`uiBlocks`.
    //
    // The SAFE wrapper (B4): a sanitizer exception must never drop this
    // event or crash the adapter stream — it logs and forces every claiming
    // block unattested instead.
    event = safeSanitizeUIBlockEventProvenance(event, (message, meta) =>
      this.options.logger.warn(message, meta),
    );
    // T5 ordering, pinned by the source invariant in this file's test
    // suite: a stop must settle even for an event the quarantine gate
    // declines, or a stop on a quarantined thread never settles and rides
    // its full budget into a forced teardown of a completed turn.
    this.cooperativeStop.settleCompletedTurn(
      event.threadId,
      event.turnId,
      event.method,
    );
    const quarantined = this.quarantinedThreads.has(event.threadId);
    if (quarantined && event.method !== 'session.exited') return false;
    if (quarantined) this.quarantinedThreads.delete(event.threadId);
    // archive#2959: every canonical event this service actually persists and
    // publishes passes through here — adapter-streamed content/tool/state
    // events AND this service's own internally-derived terminal events
    // (`session.stop-settled`, the forced-path `turn.aborted`), which never
    // reach `consumeAdapterEvents`' loop at all. Feeding the watchdog here,
    // not there, is what lets it treat a Stop settling as the same kind of
    // turn-end as an ordinary completion.
    // A coalescable delta was already observed raw at the coalescing seam, so
    // the watchdog sees progress at the engine's rate rather than the publish
    // rate. Observing the merged event again would reset the window twice for
    // one stretch of text.
    if (!isCoalescableDelta(event)) this.turnProgress.observe(event);
    this.threadProviders.set(event.threadId, event.provider);
    if (event.method === 'session.exited') {
      this.clientOriginTurns.clearThread(event.threadId);
    }
    if (
      event.method === 'turn.completed' ||
      event.method === 'turn.aborted' ||
      event.method === 'runtime.error'
    ) {
      this.clientOriginTurns.retire(event.threadId, event.turnId);
    }
    // Adapter-agnostic activity telemetry: adapters stay metric-free (the
    // sessionStateDuration precedent), so provider activity notifications
    // are counted here at the projection boundary.
    if (event.method === 'extension.notification') {
      sessionActivityEvents.add(1, {
        provider: event.provider,
        namespace: event.namespace,
        kind: event.type,
      });
      if (event.type === 'task/settled') {
        const status = (event.payload as { status?: unknown } | null)?.status;
        sessionBackgroundTasks.add(1, {
          provider: event.provider,
          status: typeof status === 'string' ? status : 'unknown',
        });
        // Provider lifecycle notifications are aggregate observations only:
        // they carry no request/tenant authority and cannot make an internal
        // Station API call. Keep that classification explicit rather than
        // inventing a tenant from the event's thread.
        tenantExecutionContextOutcomes.add(
          1,
          tenantExecutionContextAttributes({
            operation: 'background',
            source: 'aggregate',
            outcome: 'skipped',
            reason: 'aggregate_safe',
          }),
        );
      }
    }
    const projectedEvent = this.options.eventStore
      ? this.options.eventStore.projectLiveEvent(event)
      : event;
    projectOrchestrationEventToReadModel({
      event: projectedEvent,
      threadProviders: this.threadProviders,
      sessionReadModel: this.sessionReadModel,
      eventStore: this.options.eventStore,
    });
    const declaredOutputs =
      projectedEvent.method === 'turn.completed' && projectedEvent.turnId
        ? this.nativeOutputDeclarations.takeTerminalAdmissions(
            projectedEvent.threadId,
            projectedEvent.turnId,
            projectedEvent.eventId,
          )
        : [];
    try {
      this.options.eventStore?.appendEvent(projectedEvent, declaredOutputs);
      if (declaredOutputs.length > 0) {
        this.nativeOutputDeclarations.commit(
          declaredOutputs.map((admission) => admission.handle),
        );
      }
    } catch (error) {
      // Same-call retry is possible only when SQLite rolled back.  Do not
      // consume a memory handle before its unique durable use index commits.
      this.nativeOutputDeclarations.rollback(
        declaredOutputs.map((admission) => admission.handle),
      );
      throw error;
    }
    // The event-store append is the retirement boundary. Do not use an
    // adapter's cleared activeTurnId or a queue-drain edge: a bound native
    // scope remains valid until its ordered durable terminal is committed.
    if (
      (projectedEvent.method === 'turn.completed' ||
        projectedEvent.method === 'turn.aborted' ||
        (projectedEvent.method === 'runtime.error' &&
          !isDeferredRetriableTurnError(projectedEvent))) &&
      projectedEvent.turnId
    ) {
      this.nativeOutputGrants.retireTerminal(
        projectedEvent.threadId,
        projectedEvent.turnId,
      );
      if (
        this.nativeOutputTurnGenerations.get(projectedEvent.threadId) ===
        projectedEvent.turnId
      ) {
        this.nativeOutputTurnGenerations.delete(projectedEvent.threadId);
      }
    }
    // Already observed raw at the coalescing seam above; observing the merged
    // delta again would double-count progress for one stretch of text.
    if (!isCoalescableDelta(event))
      this.sessionExecutionCoordinator.observe(projectedEvent);
    this.monitoringBridge.onRuntimeEvent(projectedEvent);
    // archive#3451 finding 5: a failed turn used to be either mis-counted as
    // `completed` (pre-#3442) or dropped from this metric entirely — count it
    // as its own outcome instead. Scoped to a turn-scoped, non-deferred
    // `runtime.error` (has a `turnId`, and is not codex's willRetry arm):
    // the deferred case is not a terminal outcome yet, so counting it now
    // would both undercount the eventual real terminal and, if one never
    // arrives, over-attribute failures that were really still retrying.
    if (
      projectedEvent.method === 'turn.completed' ||
      projectedEvent.method === 'turn.aborted' ||
      (projectedEvent.method === 'runtime.error' &&
        projectedEvent.turnId &&
        !isDeferredRetriableTurnError(projectedEvent))
    ) {
      try {
        this.usageTelemetry?.trackEngineTurn({
          engine: telemetryEngine(projectedEvent.provider),
          outcome:
            projectedEvent.method === 'turn.completed'
              ? 'completed'
              : event.method === 'turn.aborted'
                ? 'aborted'
                : 'failed',
        });
      } catch {
        // Terminal event projection remains authoritative when telemetry fails.
      }
    }
    // Recovery observes only after canonical persistence, so a restart can
    // reconstruct the source turn without copying its content into recovery.
    this.recoveryCoordinator?.observe(projectedEvent);
    // archive#1120: invalidate the session-owner cache BEFORE emitting on
    // the event bus, so any subscriber reacting to this same event (e.g.
    // the /events route's canUserReadSession gate) that re-derives
    // ownership never observes a stale cached entry for it. In the normal
    // case this is a no-op (nothing cached yet, or the re-affirmed owner is
    // identical) — it exists as a correctness backstop, not a hot path.
    //
    // Scope: this covers every event that flows through THIS function —
    // in practice every adapter-sourced event (consumeAdapterEvents ->
    // projectAndPublishEvent) plus this service's other same-path internal
    // publishes. It is NOT the only place a `session.started`/
    // `session.configured` event can reach the event bus: two other paths
    // publish independently of this function and are NOT covered by this
    // invalidation —
    //   - AttachedSessionFollowService.appendAndPublish (used for the
    //     read-only-attached envelope built by attachedSessionEnvelope())
    // The attached-session path is safe TODAY only because it never sets
    // `metadata.userId`
    // on a `session.started`/`session.configured` event, so
    // sessionOwnerUserId() never resolves (and therefore never caches) an
    // owner from them in the first place — see the cross-reference comments
    // at each site. This is a structural gap, not a proof: if either path
    // is ever changed to stamp `metadata.userId`, it must also route
    // through (or replicate) this invalidation, or a cached owner could go
    // stale silently.
    if (
      (projectedEvent.method === 'session.started' ||
        projectedEvent.method === 'session.configured') &&
      this.sessionAuthz.invalidateSessionOwner(projectedEvent.threadId)
    ) {
      sessionOwnerCacheOps.add(1, { outcome: 'invalidated' });
    }
    this.options.eventBus.emit(SERVER_EVENTS.ORCHESTRATION_EVENT, {
      event: projectedEvent,
      // archive#1410: a turn's provenance envelope rides ALONGSIDE the
      // canonical event, never inside it — the persisted event stays
      // byte-identical to what the adapter produced, and this stays a
      // projection (R5). Same shape as the SSE frame's derived `id:`
      // (`readEventGlobalSequence`): computed at publish time from the
      // store, attached per-frame.
      //
      // Why it must be here rather than left to the next REST refresh: the
      // live chat path commits the assistant bubble straight from the
      // stream (`finalizeAssistantTurn`) and never refetches, so without
      // this the card only appeared after a remount or reconnect — i.e.
      // "every assistant turn gets a card" was false on the primary path.
      ...this.turnProvenance.sidecarFor(projectedEvent),
    });
    // archive#1101: 'turn.event.projected' milestone — this is the single
    // dispatch point every turn.completed/turn.aborted event flows through
    // on its way to persistence, so it's the correct place to certify "this
    // event has been appended + projected + synchronously dispatched"
    // regardless of which adapter or code path produced the event. See the
    // receipt kind's doc comment (receipt-bus.ts) for exactly what this
    // does and does not guarantee — deliberately NOT named for full turn
    // quiescence, since async/fire-and-forget listener side effects are
    // not awaited here. Tests await this instead of a fixed
    // setTimeout()/poll loop after pushing a turn-completion event onto a
    // fake adapter.
    if (event.method === 'turn.completed' || event.method === 'turn.aborted') {
      receiptBus.publish({
        kind: 'turn.event.projected',
        threadId: event.threadId,
        turnId: event.turnId,
        reason: event.method === 'turn.completed' ? 'completed' : 'aborted',
      });
    }
    return true;
  }

  // archive#3557/#3558 fix-round review BLOCK 4: this is a THIRD WRITE path
  // over the bounded projection, not a read-only consumer — its result feeds
  // `consumeAdapterEvents`'s `previousState` into
  // `normalizeCanonicalRuntimeEventLifecycle`, which stamps
  // `previousState`/`sessionState`/`transitionReason` onto the event this
  // service is about to PERSIST (`projectAndPublishEvent` below). Before
  // event-store.ts's `latestTerminalEventForTurn` turn-scoping, a stale
  // thread-wide terminal entering `listSessionProjectionEvents`'s bounded set
  // could make this read `completed`/`canceled` for a session that had
  // actually moved on to a later turn, durably stamping that wrong
  // `previousState` onto every subsequent persisted event for the thread —
  // not just a display artifact, a written fact. Turn-scoping removes that
  // source of a stale terminal from the same bounded set this method reads,
  // so this call site is a beneficiary of that fix, not a second place that
  // needed its own change.
  private readCurrentLifecycleState(
    threadId: string,
  ): SessionLifecycleState | undefined {
    const session = this.sessionReadModel.get(threadId);
    if (!session) return undefined;
    const events = this.options.eventStore
      ?.listSessionProjectionEvents(threadId)
      .map((event) => event.payload);
    return projectSessionLifecycle({ session, events: events ?? [] })
      .lifecycleState;
  }

  private recordStateDuration(options: {
    previousState: SessionLifecycleState;
    nextEventAt: string;
    previousEventAt?: string;
    runtimeKind: string;
  }): void {
    if (!options.previousEventAt) return;
    const duration =
      new Date(options.nextEventAt).getTime() -
      new Date(options.previousEventAt).getTime();
    if (!Number.isFinite(duration) || duration < 0) return;
    sessionStateDuration.record(duration, {
      state: options.previousState,
      runtime_kind: options.runtimeKind,
    });
  }

  private async recoverSessions(): Promise<void> {
    await recoverOrchestrationSessions({
      adapterRegistry: this.options.adapterRegistry,
      eventStore: this.options.eventStore,
      requireTenantExecutionContext: this.options.requireTenantExecutionContext,
      validateRecoveredTenantExecutionContext:
        this.options.validateRecoveredTenantExecutionContext,
      quarantineSession: (session) => {
        // Flushes anything buffered and drops the first-paint marker. Every
        // other per-thread map is cleared here; this one was missed, and it is
        // the only one that does not self-clean.
        this.deltaCoalescer.forgetThread(session.threadId);
        this.quarantinedThreads.add(session.threadId);
        this.forgetThreadState(session.threadId, {
          policyThreads: true,
          ownerCache: true,
        });
      },
      trackSession: (session, adapter) => {
        // archive#3493 residual 2: recovery snapshots the persisted rows,
        // then awaits `adapter.hasSession` per session — a first turn racing
        // boot can materialise this thread inside that window, and
        // `trackOrchestrationSession` writes unconditionally (this store's
        // CAS-less read-modify-write class, cf. archive#1606). A live
        // binding means the read model already holds a NEWER row than the
        // boot snapshot: keep it, and keep the routing identity the live
        // start resolved.
        //
        // Disclosed residual: the adapter-TRUTHY half of the same race — a
        // live start that populates the adapter's own session map before
        // recovery's `hasSession` resolves makes recovery pass a bound
        // adapter, and the snapshot write goes through. It self-heals via
        // `listSessionReadModel`'s `listSessions()` pre-sync, which
        // re-tracks every row from the live adapters on the next read (NOT
        // via any event-store fold), and no repro reaching a wrong answer
        // through a public surface has been constructed.
        if (!adapter && this.sessionAdapters.has(session.threadId)) return;
        // Recovery bypasses the normal start-session dispatch path, which is
        // where this routing identity is ordinarily retained. Rehydrate it
        // only from the persisted start metadata: quota observations must
        // never be labelled with an inferred connection.
        const connectionId = this.readLatestSessionStartMetadata(
          session.threadId,
        )?.connectionId;
        if (typeof connectionId === 'string') {
          this.sessionConnectionIds.set(session.threadId, connectionId);
        }
        // archive#3476: `adapter` arrives only when it reported holding the
        // thread. Passing the registry's adapter unconditionally, as this
        // used to, asserted this process was holding an engine it had merely
        // restored a row for.
        this.trackSession(session, adapter);
      },
      logger: this.options.logger,
    });
    this.evictCollidingAttachedAliases();
  }

  /**
   * archive#3476: the engine-start half of recovery, shared by every caller
   * that needs a restored session to have a live engine.
   */
  private recoveredSessionStartOptions(): RecoveredSessionStartOptions {
    return {
      eventStore: this.options.eventStore,
      assertAdapterReady: (adapter, connectionId) =>
        this.assertAdapterReady(adapter, connectionId),
      trackStartedSession: (session, adapter) =>
        this.trackSession(session, adapter),
      logger: this.options.logger,
      resolveSessionAgent: this.options.resolveSessionAgent,
      // Round 4 (Codex): recovery bypassed the credential pin entirely, so a
      // restarted session ran a pinned agent on the connection's account.
      applyCredentialProfile: (input) =>
        this.applyAgentCredentialProfileRef(input),
      readSessionStartMetadata: (threadId) =>
        this.readLatestSessionStartMetadata(threadId),
      prepareModelLaunch: (adapter, input, retainedModelId) =>
        this.withAcceptedModelLaunchPlan(
          adapter,
          input,
          'resume',
          retainedModelId,
        ),
      recordAcceptedModelLaunch: (adapter, input) =>
        this.modelLaunch.recordAcceptedModelLaunchPlan(
          adapter,
          this.modelLaunch.modelLaunchPlanFromInput(input),
          'resume',
          this.modelLaunch.modelLaunchRequestedOverrideFromInput(input),
        ),
      admitEngineStart: (threadId) =>
        admitEngineStartForIntent(
          this.options.resourcePosture,
          this.options.logger,
          'recovery',
          { binding: threadId },
        ),
      // archive#1011: recovery replays only the cwd persisted at start, so a
      // project-bound session created before that resolution existed (or by a
      // client that never supplied one) keeps recovering with none — and the
      // engine keeps inheriting the server process's directory. Fill the gap
      // from the replayed `metadata.projectSlug`. Deliberately only when the
      // persisted cwd is ABSENT: a session that already has one is not the
      // archive#1011 case, and re-validating it here would close otherwise healthy
      // sessions whose directory is momentarily unavailable (an unmounted
      // volume, a not-yet-restored worktree) — recovery has always been
      // tolerant there and this fix is not the place to change that.
      resolveSessionCwd: (input) =>
        input.cwd
          ? input
          : resolveStartSessionCwd(
              input,
              this.options.listProjects,
              this.options.observeCwdShadow,
            ),
    };
  }

  /**
   * archive#3476: start the engine for a session this process restored at
   * boot but never spawned a process for.
   *
   * Returns `undefined` — leaving the caller's historical "no provider
   * session found" throw intact — for every thread that is NOT a dormant
   * restored session: unknown threads, quarantined threads, read-only
   * attached threads (which never own an engine), terminal rows, and
   * providers whose adapter is not registered here. A start that FAILS
   * throws, having already recorded the archive#1090 failure evidence, so
   * the turn fails loudly rather than reporting success into nothing.
   */
  private materializeRecoveredSession(
    threadId: string,
  ): Promise<ProviderAdapterShape | undefined> {
    const inFlight = this.materializingSessions.get(threadId);
    if (inFlight) return inFlight;
    const started = this.materializeRecoveredSessionOnce(threadId).finally(
      () => {
        this.materializingSessions.delete(threadId);
      },
    );
    this.materializingSessions.set(threadId, started);
    return started;
  }

  private async materializeRecoveredSessionOnce(
    threadId: string,
  ): Promise<ProviderAdapterShape | undefined> {
    if (this.quarantinedThreads.has(threadId)) return undefined;
    if (this.isReadOnlyAttachedSession(threadId)) return undefined;
    if (this.isPeerDelegationActivityRecord(threadId)) return undefined;
    const session =
      this.sessionReadModel.get(threadId) ??
      this.options.eventStore?.readSessionByThread(threadId);
    if (!session) return undefined;
    if (session.status === 'closed' || session.status === 'dead') {
      return undefined;
    }
    const adapter = this.options.adapterRegistry.get(session.provider);
    if (!adapter) return undefined;
    const tenantExecutionContext =
      this.sessionAuthz.tenantContextFor(threadId) ??
      session.tenantExecutionContext;
    await startRecoveredOrchestrationSession({
      session,
      adapter,
      ...(tenantExecutionContext ? { tenantExecutionContext } : {}),
      options: this.recoveredSessionStartOptions(),
    });
    return adapter;
  }

  /**
   * archive#3476: a thread this process knows about but holds no engine for.
   * The commands that do not need an engine (stop, interrupt, steer) read
   * this instead of materialising one just to tear it down.
   */
  private isDormantSessionThread(threadId: string): boolean {
    if (this.sessionAdapters.has(threadId)) return false;
    // archive#3493 residual 1: an engine is starting for this thread RIGHT
    // NOW. `sessionAdapters` is bound only after `adapter.startSession`
    // resolves (trackStartedSession), so for the whole start latency the
    // thread looks engine-free — and the engine-free branches would report
    // success while an engine comes up behind them. Mid-materialisation is
    // not dormant. Where each not-dormant command then lands differs by
    // intent: Stop awaits the start (bounded) and tears the engine down;
    // interrupt falls into the pending-cancel path, because cancel-intent
    // meaningfully applies to whatever turn starts next; steer hard-errors,
    // because a steer's additive input targets one SPECIFIC active turn and
    // queuing it against a turn that does not exist yet has no defensible
    // semantics.
    if (this.materializingSessions.has(threadId)) return false;
    const session =
      this.sessionReadModel.get(threadId) ??
      this.options.eventStore?.readSessionByThread(threadId);
    if (!session) return false;
    // A terminal row is NOT dormant — it is over. Recovery never restores it,
    // and the engine-free branches must not treat it as one: the stop branch
    // writes `status: 'ready'`, which on a `closed`/`dead` row would resurrect
    // a conversation the engine or the user already ended. These keep the
    // historical "No provider session found for thread" throw.
    return session.status !== 'closed' && session.status !== 'dead';
  }

  /**
   * archive#895 wave B (decided ambiguity A5): the latest persisted `session.started`
   * event's metadata for a thread, with the reserved
   * server-owned receipts stripped before reuse (they are facts from the
   * PREVIOUS start, not inputs to re-resolve). Re-resolves fresh via `resolveSessionAgent` rather than
   * trusting the stale receipt. `undefined` when no `session.started` event
   * survives for this thread (recovery still proceeds; ACP falls back to
   * its resume cursor's connectionId).
   */
  private readLatestSessionStartMetadata(
    threadId: string,
  ): Record<string, unknown> | undefined {
    const event = this.options.eventStore?.latestEventByMethod(
      threadId,
      'session.started',
    );
    const metadata = (event?.payload as { metadata?: Record<string, unknown> })
      ?.metadata;
    return metadata ? stripReservedOrchestrationMetadata(metadata) : undefined;
  }

  private evictCollidingAttachedAliases(): void {
    const eventStore = this.options.eventStore;
    if (!eventStore) return;
    const persisted = eventStore.readSessions();
    const ownedCursors = new Set(
      persisted
        .filter((session) => session.controlMode !== 'read-only-attached')
        .map(
          (session) => `${session.provider}:${String(session.resumeCursor)}`,
        ),
    );
    for (const reservation of this.adoptionLedger?.reservations() ?? []) {
      if (reservation.providerResumeCursor !== undefined) {
        ownedCursors.add(
          `${reservation.provider}:${String(reservation.providerResumeCursor)}`,
        );
      }
    }
    const aliases = new Map(
      [...persisted, ...this.sessionReadModel.values()]
        .filter((session) => session.controlMode === 'read-only-attached')
        .map((session) => [session.threadId, session]),
    );
    for (const alias of aliases.values()) {
      const externalId = alias.attachedSource?.externalSessionId;
      if (!externalId || !ownedCursors.has(`${alias.provider}:${externalId}`)) {
        continue;
      }
      this.forgetThreadState(alias.threadId, { ownerCache: true });
      eventStore.deleteThread(alias.threadId);
    }
  }
}

/**
 * SQLITE_BUSY (errcode 5) or its message, matching the detection the
 * migration retry helper uses (003-orchestration-events.ts). node:sqlite
 * carries the numeric code on `errcode`; the message check covers wrapped
 * errors that only preserved the text.
 */
function isSqliteContentionError(error: unknown): boolean {
  if ((error as { errcode?: unknown })?.errcode === 5) return true;
  return (
    error instanceof Error &&
    /SQLITE_BUSY|database is locked/i.test(error.message)
  );
}

/** Removes server execution authority from every public session response. */
function publicProviderSession(session: ProviderSession): ProviderSession {
  const { tenantExecutionContext: _tenantExecutionContext, ...publicSession } =
    session;
  return publicSession;
}

function bucketCount(count: number): string {
  if (count === 0) return '0';
  if (count <= 5) return '1_5';
  if (count <= 20) return '6_20';
  return '21_plus';
}

export { messageSearchExcerpt } from './session-transcript-reads.js';
