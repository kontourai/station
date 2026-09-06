import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter as NodeEventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AgentExecutionConfig } from '@kontourai/station-contracts/agent';
import {
  engineConnectionId,
  engineId,
} from '@kontourai/station-contracts/agent-identity';
import type { OrchestrationCommand } from '@kontourai/station-contracts/orchestration';
import { PENDING_TURN_INTERRUPT_TTL_MS } from '@kontourai/station-contracts/orchestration';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import type { ProjectTaskRoomGrant } from '@kontourai/station-contracts/project-task-room';
import { SESSION_CAPABILITY_DELIVERY_METADATA_KEY } from '@kontourai/station-contracts/provider';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import {
  INTERNAL_SESSION_READ_SCOPE,
  parseHostedTenantRegistry,
  sessionReadAuthorityFromRequest,
} from '@kontourai/station-contracts/tenancy';
import type { Prerequisite } from '@kontourai/station-contracts/tool';
import { assembleTurnProvenanceEnvelopes } from '@kontourai/station-shared/turn-provenance-fold';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { MonitoringEmitter } from '../../../monitoring/emitter.js';
import type {
  ProviderAdapterMetadata,
  ProviderAdapterShape,
  ProviderAdoptionHooks,
  ProviderInterruptTurnResult,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionAdoptInput,
  ProviderSessionStartInput,
  ProviderTurnStartResult,
} from '../../../providers/adapter-shape.js';
import { ProviderTurnEndedError } from '../../../providers/adapter-shape.js';
import { StationAgentAdapter } from '../../../providers/adapters/station-agent-adapter.js';
import type { IProviderAdapterRegistry } from '../../../providers/provider-interfaces.js';
import { AsyncEventQueue } from '../../../providers/sessions/async-event-queue.js';
import { createEnrichedAgentRoutes } from '../../../routes/agents/enriched-agents.js';
import { foregroundMessageObjectSchema } from '../../../routes/orchestration/orchestration.js';
import { currentTenantExecutionContext } from '../../../runtime/bootstrap/runtime-tenant-context.js';
import {
  INTERNAL_TURN_CORRELATION_HEADER,
  readAuthorizedTurnCorrelationHandoff,
} from '../../../runtime/conversation/authorized-turn-correlation.js';
import {
  adapterTurnDuration,
  attachedSessionMutationRejected,
  chatAttachmentBytesDispatched,
  chatAttachmentsDispatched,
  chatStartGate,
  conversationContinuationOutcomes,
  flowSessionGateChecks,
  modelLaunchResolutionTotal,
  orchestrationSteerDispatches,
  orchestrationStoreContentionObserved,
  orchestrationTurnStallDetections,
  sessionOwnerCacheOps,
  tenantExecutionContextOutcomes,
  turnProvenanceProjections,
} from '../../../telemetry/metrics.js';
import { createLogger } from '../../../utils/logger.js';
import { LOG_BINDING_KEYS } from '../../../utils/logger-correlation.js';
import { AgentPolicyService } from '../../agents/agent-policy-service.js';
import { ApprovalRegistry } from '../../approvals/approval-registry.js';
import { stationWorkflowActorKey } from '../../evidence/orchestration-workflow-sidecar.js';
import { buildSyntheticTrustBundle } from '../../evidence/trust-bundle.js';
import { VeritasReadinessService } from '../../evidence/veritas-readiness-service.js';
import { WorkflowSidecarService } from '../../evidence/workflow-sidecar-service.js';
import { FlowRunService } from '../../flow/flow-run-service.js';
import { receiptBus, waitForReceipt } from '../../infra/receipt-bus.js';
import { createRuntimeResourcePostureController } from '../../infra/resource-posture.js';
import { createServerLogReader } from '../../infra/server-log-reader.js';
import {
  installServerLogSink,
  resetServerLogSinkForTests,
} from '../../infra/server-log-store.js';
import { NotificationService } from '../../notifications/notification-service.js';
import type { CwdShadowSample } from '../../projects/project-resource-shadow.js';
import { composeTaskDispatcher } from '../../projects/task-dispatch-composition.js';
import { TaskGraphService } from '../../projects/task-graph-service.js';
import type { AdoptionLedger } from '../adoption-ledger.js';
import { canResolveConversationContinuation } from '../conversation-lineage.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import {
  AdoptionContinuationInProgressError,
  OrchestrationCommandDispatchError,
  OrchestrationService as RawOrchestrationService,
} from '../orchestration-service.js';
import { recoverOrchestrationSessions } from '../orchestration-session-state.js';
import {
  anyPersonalOrchestrationStreamPresenceSubject,
  OrchestrationStreamPresence,
} from '../orchestration-stream-presence.js';
import { createSessionAgentResolver } from '../session-agent-resolution.js';
import {
  ACTIVE_TURN_FOLD_METHODS,
  activeTurnIdForEvents,
} from '../session-lifecycle-service.js';
import {
  wireInternalStopRedispatchFailureNotifications,
  wireTurnCompletionNotifications,
} from '../turn-completion-notifications.js';

vi.mock('../../../telemetry/metrics.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../telemetry/metrics.js')>()),
  agentCapabilityUndelivered: { add: vi.fn() },
  attachedSessionMutationRejected: { add: vi.fn() },
  adapterReadiness: { add: vi.fn() },
  adapterSessionStartDuration: { record: vi.fn() },
  adapterTurnDuration: { record: vi.fn() },
  chatAttachmentBytesDispatched: { add: vi.fn() },
  chatAttachmentsDispatched: { add: vi.fn() },
  chatStartGate: { add: vi.fn() },
  conversationContinuationOutcomes: { add: vi.fn() },
  flowEvidenceAttached: { add: vi.fn() },
  flowEvidenceAutoSuperseded: { add: vi.fn() },
  flowExceptionsAccepted: { add: vi.fn() },
  flowGateEvaluations: { add: vi.fn() },
  flowReportsGenerated: { add: vi.fn() },
  flowRunsStarted: { add: vi.fn() },
  flowSessionGateChecks: { add: vi.fn() },
  modelLaunchResolutionTotal: { add: vi.fn() },
  orchestrationCommandsDispatched: { add: vi.fn() },
  orchestrationSteerDispatches: { add: vi.fn() },
  orchestrationStoreContentionObserved: { add: vi.fn() },
  orchestrationEventsPersisted: { add: vi.fn() },
  orchestrationEventWindowElisions: { add: vi.fn() },
  orchestrationEventPersistDuration: { record: vi.fn() },
  orchestrationTurnDedup: { add: vi.fn() },
  orchestrationTurnStallDetections: { add: vi.fn() },
  turnDedupClaims: { add: vi.fn() },
  policyChecks: { add: vi.fn() },
  sessionCwdResolution: { add: vi.fn() },
  sessionActivityEvents: { add: vi.fn() },
  sessionBackgroundTasks: { add: vi.fn() },
  projectResourceShadowComparisons: { add: vi.fn() },
  sessionOwnerCacheOps: { add: vi.fn() },
  sessionStateDuration: { record: vi.fn() },
  sessionTransitions: { add: vi.fn() },
  tenantExecutionContextAttributes: vi.fn((value) => value),
  tenantExecutionContextOutcomes: { add: vi.fn() },
  turnCompletionNotificationOps: { add: vi.fn() },
  turnProvenanceProjections: { add: vi.fn() },
  uiSessionBoardActions: { add: vi.fn() },
  uiSessionBoardLoadDuration: { record: vi.fn() },
  veritasReadinessDuration: { record: vi.fn() },
  veritasReadinessRuns: { add: vi.fn() },
  workflowSidecarBindings: { add: vi.fn() },
  workflowSidecarTransitions: { add: vi.fn() },
}));

async function waitFor<T>(
  read: () => T,
  matches: (value: T) => boolean,
  timeoutMs = 1000,
): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = read();
    if (matches(value)) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for test condition');
}

class FakeAdapter implements ProviderAdapterShape {
  readonly metadata: ProviderAdapterMetadata;
  readonly sessions = new Map<string, ProviderSession>();
  readonly events = new AsyncEventQueue<CanonicalRuntimeEvent>();
  readonly prerequisites: Prerequisite[];
  readonly startSession =
    vi.fn<(input: ProviderSessionStartInput) => Promise<ProviderSession>>();
  readonly adoptSession =
    vi.fn<
      (
        input: ProviderSessionAdoptInput,
        hooks?: ProviderAdoptionHooks,
      ) => Promise<ProviderSession>
    >();
  readonly discardSession = vi.fn<(threadId: string) => Promise<void>>();
  readonly sendTurn =
    vi.fn<(input: ProviderSendTurnInput) => Promise<ProviderTurnStartResult>>();
  readonly interruptTurn =
    vi.fn<
      (
        threadId: string,
        turnId?: string,
      ) => Promise<ProviderInterruptTurnResult>
    >();
  readonly steerTurn =
    vi.fn<(threadId: string, input: string, turnId: string) => Promise<void>>();
  readonly respondToRequest =
    vi.fn<
      (
        threadId: string,
        requestId: string,
        decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel',
      ) => Promise<void>
    >();
  readonly stopSession = vi.fn<(threadId: string) => Promise<void>>();
  readonly stopAll = vi.fn<() => Promise<void>>();
  readonly listModels =
    vi.fn<
      (options?: {
        signal?: AbortSignal;
        maxEntries?: number;
      }) => Promise<Array<{ id: string; name: string; originalId: string }>>
    >();

  constructor(
    readonly provider:
      | 'bedrock'
      | 'ollama'
      | 'claude'
      | 'codex'
      | 'muse'
      | 'acp'
      | 'station-agent',
    prerequisites: Prerequisite[] = [],
  ) {
    this.metadata = {
      displayName: `${provider} Runtime`,
      description: `${provider} adapter for tests`,
      capabilities:
        provider === 'claude'
          ? ['agent-runtime', 'image-input', 'file-input']
          : provider === 'codex' || provider === 'acp'
            ? ['agent-runtime', 'image-input']
            : ['agent-runtime'],
      engineId: engineId(
        provider === 'bedrock' ||
          provider === 'ollama' ||
          provider === 'station-agent'
          ? 'station'
          : provider,
      ),
      builtin: true,
      // archive#980: the private `station-agent` adapter carries the real
      // `engineId: 'station'` (station-agent-adapter.ts:237), so this fixture
      // resolves the same way as production.
      modelLaunch:
        provider === 'acp'
          ? {
              defaultAtStart: 'engine-selected',
              omissionAtResume: 'engine-selected',
              omissionPerTurn: 'engine-selected',
              overrideAtStart: false,
              overrideAtResume: false,
              overridePerTurn: false,
            }
          : {
              defaultAtStart: 'engine-selected',
              omissionAtResume: 'engine-selected',
              omissionPerTurn: 'engine-selected',
              overrideAtStart: true,
              overrideAtResume: true,
              overridePerTurn: true,
            },
    };
    this.prerequisites = prerequisites;
    this.startSession.mockImplementation(async (input) => {
      const now = new Date().toISOString();
      const session: ProviderSession = {
        provider: this.provider,
        threadId: input.threadId,
        status: 'ready',
        model: input.modelId,
        createdAt: now,
        updatedAt: now,
      };
      this.sessions.set(input.threadId, session);
      return session;
    });
    this.adoptSession.mockImplementation(async (input, hooks) => {
      const now = new Date().toISOString();
      const resumeCursor = `${input.sourceSessionId}:child`;
      await hooks?.onProviderChildCreated(resumeCursor);
      const session: ProviderSession = {
        provider: this.provider,
        threadId: input.threadId,
        status: 'ready',
        model: input.modelId,
        cwd: input.cwd,
        resumeCursor,
        controlMode: 'station-owned',
        createdAt: now,
        updatedAt: now,
      };
      this.sessions.set(input.threadId, session);
      return session;
    });
    this.sendTurn.mockImplementation(async (input) => ({
      threadId: input.threadId,
      turnId: `${this.provider}-turn`,
    }));
    this.interruptTurn.mockImplementation(async (_threadId, turnId) => ({
      outcome: 'cancelled',
      turnId: turnId ?? `${this.provider}-turn`,
    }));
    this.steerTurn.mockResolvedValue(undefined);
    this.respondToRequest.mockResolvedValue(undefined);
    this.stopSession.mockImplementation(async (threadId) => {
      this.sessions.delete(threadId);
    });
    this.discardSession.mockImplementation(async (threadId) => {
      this.sessions.delete(threadId);
    });
    this.stopAll.mockImplementation(async () => {
      this.sessions.clear();
    });
    this.listModels.mockResolvedValue(
      provider === 'claude'
        ? [
            {
              id: 'claude-sonnet',
              name: 'Claude Sonnet',
              originalId: 'claude-sonnet',
            },
          ]
        : provider === 'codex'
          ? [
              {
                id: 'gpt-5.4',
                name: 'GPT-5.4',
                originalId: 'gpt-5.4',
              },
            ]
          : [],
    );
  }

  async listSessions(): Promise<ProviderSession[]> {
    return [...this.sessions.values()];
  }

  async hasSession(threadId: string): Promise<boolean> {
    return this.sessions.has(threadId);
  }

  streamEvents(options?: {
    signal?: AbortSignal;
  }): AsyncIterable<CanonicalRuntimeEvent> {
    return this.events.iterable(options);
  }

  async getPrerequisites(_options?: {
    signal?: AbortSignal;
    connectionId?: string;
  }): Promise<Prerequisite[]> {
    return this.prerequisites;
  }
}

/**
 * A target-aware adapter stand-in: unlike the generic fake, it only confirms
 * cancellation for its actual active turn. This models adapters whose local
 * turn registry may have already settled or moved before Station's command.
 */
class TargetAwareInterruptAdapter extends FakeAdapter {
  activeTurnId: string | undefined;

  constructor(provider: 'claude' | 'station-agent', activeTurnId?: string) {
    super(provider);
    this.activeTurnId = activeTurnId;
    this.interruptTurn.mockImplementation(async (_threadId, turnId) => {
      if (!this.activeTurnId) return { outcome: 'no-active-turn' };
      if (turnId !== this.activeTurnId) {
        return { outcome: 'target-mismatch', activeTurnId: this.activeTurnId };
      }
      return { outcome: 'cancelled', turnId };
    });
  }
}

function installStationDeliveryFlow(cwd: string): void {
  const definitionsDir = join(cwd, '.flow', 'definitions');
  mkdirSync(definitionsDir, { recursive: true });
  writeFileSync(
    join(definitionsDir, 'station-delivery.json'),
    JSON.stringify({
      id: 'station-delivery',
      version: 'retired-test-fixture',
      steps: [{ id: 'verify', next: null }],
      gates: {},
    }),
  );
}

function createRegistry(
  adapters: ProviderAdapterShape[],
): IProviderAdapterRegistry {
  return {
    register() {},
    get(provider) {
      return adapters.find((adapter) => adapter.provider === provider);
    },
    list() {
      return adapters;
    },
  };
}

/**
 * archive#3476: boot recovery restores a session's state and starts no
 * engine, so a test that needs the recovered session LIVE has to do what a
 * user does — send it a turn. This drives the whole lazy-materialisation
 * path: `dispatch({sendTurn})` →
 * `resolveOrchestrationAdapterForThread`'s `materializeSession` hook →
 * `startRecoveredOrchestrationSession` → `adapter.startSession`.
 */
async function materializeBySendingATurn(
  service: OrchestrationService,
  threadId: string,
): Promise<void> {
  await service.dispatch({
    type: 'sendTurn',
    input: { threadId, input: 'first turn after restart' },
  });
}

function createReplaceableRegistry(
  initialAdapters: ProviderAdapterShape[],
): IProviderAdapterRegistry {
  const adapters = [...initialAdapters];
  const listeners = new Set<() => void>();
  return {
    register(adapter) {
      const existing = adapters.findIndex(
        (candidate) => candidate.provider === adapter.provider,
      );
      if (existing >= 0) adapters.splice(existing, 1, adapter);
      else adapters.push(adapter);
      for (const listener of listeners) listener();
    },
    get(provider) {
      return adapters.find((adapter) => adapter.provider === provider);
    },
    list() {
      return adapters;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((settle) => {
      resolve = settle;
    }),
    resolve: (value) => resolve(value),
  };
}

/**
 * This suite's historical service assertions are process-wide observer tests,
 * not request-authorization tests.  Their type surface can only issue the
 * named aggregate scope. Tests that assert a caller's access use a raw service
 * plus `personalReadAuthority()` or a minted hosted authority instead.
 */
function personalReadAuthority(userId: string) {
  return sessionReadAuthorityFromRequest(userId, undefined, undefined);
}

type InternalObserver = Omit<
  RawOrchestrationService,
  | 'listProviders'
  | 'sessionLifecycles'
  | 'listSessions'
  | 'listSessionReadModel'
  | 'listLoadedSessionReadModel'
  | 'listAgentRuns'
  | 'readAgentRun'
  | 'listProjectSessionBoard'
  | 'readSession'
  | 'readSessionEventPage'
  | 'readEventStreamReplay'
  | 'readSessionMessages'
  | 'readSessionUsage'
  | 'listSessionUsage'
  | 'canUserReadSession'
  | 'readSessionConversation'
  | 'listSessionConversations'
  | 'listAllSessionConversations'
  | 'listConversationHistoryPage'
  | 'readCommandReceipt'
  | 'listCommandReceipts'
  | 'readSessionFlowRun'
  | 'readSessionBuilderRun'
  | 'readSessionWorkflowState'
> & {
  sessionLifecycles: {
    transition(
      input: Omit<
        Parameters<
          RawOrchestrationService['sessionLifecycles']['transition']
        >[0],
        'authority'
      > & { authority?: SessionReadAuthority },
    ): ReturnType<RawOrchestrationService['sessionLifecycles']['transition']>;
  };
  listProviders(
    authority?: SessionReadAuthority,
  ): ReturnType<RawOrchestrationService['listProviders']>;
  listSessions(
    authority?: SessionReadAuthority,
  ): ReturnType<RawOrchestrationService['listSessions']>;
  listSessionReadModel(
    authority?: SessionReadAuthority,
  ): ReturnType<RawOrchestrationService['listSessionReadModel']>;
  listLoadedSessionReadModel(
    authority?: SessionReadAuthority,
  ): ReturnType<RawOrchestrationService['listLoadedSessionReadModel']>;
  listAgentRuns(
    authority?: SessionReadAuthority,
  ): ReturnType<RawOrchestrationService['listAgentRuns']>;
  readAgentRun(
    runId: string,
    authority?: SessionReadAuthority,
  ): ReturnType<RawOrchestrationService['readAgentRun']>;
  listProjectSessionBoard(
    projectSlug: string,
    authority?: SessionReadAuthority,
  ): ReturnType<RawOrchestrationService['listProjectSessionBoard']>;
  readSession(
    threadId: string,
    authority?: SessionReadAuthority,
  ): ReturnType<RawOrchestrationService['readSession']>;
  readSessionEventPage(
    threadId: string,
    options: { afterSequence: number; limit: number },
    authority?: SessionReadAuthority,
  ): ReturnType<RawOrchestrationService['readSessionEventPage']>;
  readEventStreamReplay(
    afterGlobalSequence: number,
    options: { threadId?: string; limit: number },
    authority?: SessionReadAuthority,
  ): ReturnType<RawOrchestrationService['readEventStreamReplay']>;
  readSessionMessages(
    threadId: string,
    authority?: SessionReadAuthority,
  ): ReturnType<RawOrchestrationService['readSessionMessages']>;
  readSessionUsage(
    threadId: string,
    authority?: SessionReadAuthority,
  ): ReturnType<RawOrchestrationService['readSessionUsage']>;
  listSessionUsage(
    authority?: SessionReadAuthority,
  ): ReturnType<RawOrchestrationService['listSessionUsage']>;
  canUserReadSession(
    threadId: string,
    authority?: SessionReadAuthority,
  ): ReturnType<RawOrchestrationService['canUserReadSession']>;
  readSessionConversation(
    threadId: string,
    authority?: SessionReadAuthority,
  ): ReturnType<RawOrchestrationService['readSessionConversation']>;
  listSessionConversations(
    agentSlug: string,
    authority?: SessionReadAuthority,
  ): ReturnType<RawOrchestrationService['listSessionConversations']>;
  listAllSessionConversations(
    authority?: SessionReadAuthority,
  ): ReturnType<RawOrchestrationService['listAllSessionConversations']>;
  listConversationHistoryPage(
    authority: SessionReadAuthority,
    options: { limit: number; cursor?: string; agentSlug?: string },
  ): ReturnType<RawOrchestrationService['listConversationHistoryPage']>;
  readCommandReceipt(
    commandId: string,
    authority?: SessionReadAuthority,
  ): ReturnType<RawOrchestrationService['readCommandReceipt']>;
  listCommandReceipts(
    threadId?: string,
  ): ReturnType<RawOrchestrationService['listCommandReceipts']>;
  readSessionFlowRun(
    threadId: string,
    authority?: SessionReadAuthority,
  ): ReturnType<RawOrchestrationService['readSessionFlowRun']>;
  readSessionBuilderRun(
    threadId: string,
    authority?: SessionReadAuthority,
  ): ReturnType<RawOrchestrationService['readSessionBuilderRun']>;
  readSessionWorkflowState(
    threadId: string,
    authority?: SessionReadAuthority,
  ): ReturnType<RawOrchestrationService['readSessionWorkflowState']>;
};

function internalObserver(
  options: ConstructorParameters<typeof RawOrchestrationService>[0],
): InternalObserver {
  const target = new RawOrchestrationService(options);
  const firstScope = new Set([
    'listProviders',
    'listSessions',
    'listSessionReadModel',
    'listLoadedSessionReadModel',
    'listAgentRuns',
    'listAllSessionConversations',
    'listConversationHistoryPage',
    'listSessionUsage',
  ]);
  const secondScope = new Set([
    'readAgentRun',
    'listProjectSessionBoard',
    'readSession',
    'readSessionMessages',
    'readSessionUsage',
    'canUserReadSession',
    'readSessionConversation',
    'listSessionConversations',
    'readCommandReceipt',
    'readSessionFlowRun',
    'readSessionBuilderRun',
    'readSessionWorkflowState',
  ]);
  return new Proxy(target, {
    get(instance, property, receiver) {
      const value = Reflect.get(instance, property, receiver);
      if (property === 'sessionLifecycles') {
        const lifecycles =
          value as RawOrchestrationService['sessionLifecycles'];
        return {
          transition: (
            input: Omit<
              Parameters<typeof lifecycles.transition>[0],
              'authority'
            > & { authority?: SessionReadAuthority },
          ) =>
            lifecycles.transition({
              ...input,
              authority: input.authority ?? INTERNAL_SESSION_READ_SCOPE,
            }),
        };
      }
      if (typeof property !== 'string' || typeof value !== 'function') {
        return value;
      }
      if (property === 'listCommandReceipts') {
        return (threadId?: string) =>
          value.call(instance, INTERNAL_SESSION_READ_SCOPE, threadId);
      }
      if (property === 'readEventStreamReplay') {
        return (
          after: number,
          options: unknown,
          authority?: SessionReadAuthority,
        ) =>
          value.call(
            instance,
            after,
            options,
            authority ?? INTERNAL_SESSION_READ_SCOPE,
          );
      }
      if (property === 'readSessionEventPage') {
        return (
          threadId: string,
          options: Record<string, unknown>,
          authority?: SessionReadAuthority,
        ) =>
          value.call(instance, threadId, {
            ...options,
            authority: authority ?? INTERNAL_SESSION_READ_SCOPE,
          });
      }
      const scopeIndex = firstScope.has(property)
        ? 0
        : secondScope.has(property)
          ? 1
          : undefined;
      if (scopeIndex === undefined) return value.bind(instance);
      return (...args: unknown[]) => {
        args[scopeIndex] ??= INTERNAL_SESSION_READ_SCOPE;
        return value.apply(instance, args);
      };
    },
  }) as unknown as InternalObserver;
}

type OrchestrationService = InternalObserver;

const OrchestrationService: new (
  options: ConstructorParameters<typeof RawOrchestrationService>[0],
) => InternalObserver = internalObserver as never;

describe('OrchestrationService', () => {
  let bedrock: FakeAdapter;
  let claude: FakeAdapter;
  let service: OrchestrationService;
  let eventBus: EventBus;
  let eventStore: EventStore;
  let adoptionLedger: AdoptionLedger;
  let flowRunService: FlowRunService;
  let workflowSidecarService: WorkflowSidecarService;
  let configuredProjects: Array<{ slug: string; workingDirectory?: string }>;
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'orchestration-service-'));
    configuredProjects = [];
    bedrock = new FakeAdapter('bedrock');
    claude = new FakeAdapter('claude', [
      {
        id: 'anthropic-api-key',
        name: 'Anthropic API key',
        status: 'installed',
        category: 'required',
        description: 'Used to access Claude Agent SDK.',
      },
    ]);
    eventBus = new EventBus();
    eventStore = new EventStore(join(tmp, 'orchestration.sqlite'));
    adoptionLedger = eventStore.createAdoptionLedger();
    flowRunService = new FlowRunService();
    workflowSidecarService = new WorkflowSidecarService({
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    // The whole suite runs with the policy service active: non-opted
    // workspaces must behave exactly as before (S3 regression proof,
    // mirroring how S1 slice 2 proved the Flow gate). The same applies to
    // the workflow sidecar service: sessions without metadata.taskSlug must
    // see zero behavior change.
    service = new OrchestrationService({
      adapterRegistry: createRegistry([bedrock, claude]),
      eventBus,
      eventStore,
      adoptionLedger,
      sessionOwnerCacheMaxEntries: 2,
      flowRunService,
      listProjects: () => configuredProjects,
      agentPolicyService: new AgentPolicyService({
        env: { ...process.env, SA_HOOK_PROFILE: '', SA_DISABLED_HOOKS: '' },
        logger: { debug: vi.fn(), warn: vi.fn() },
      }),
      workflowSidecarService,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
  });

  afterEach(() => {
    eventStore.close();
    rmSync(tmp, { recursive: true, force: true });
    // archive#1101: drop any dangling waitForReceipt()/subscribeForTest()
    // listener so one test's subscription can never observe or hang on a
    // later test's receipt-bus publishes.
    receiptBus.resetForTest();
  });

  test('public session metadata cannot mint a room execution binding', async () => {
    const threadId = 'public-metadata-binding';
    const result = await service.sessionCommands.execute(
      {
        type: 'start-session',
        input: {
          threadId,
          provider: 'claude',
          metadata: {
            roomExecutionBinding: {
              projectId: 'spoofed-project',
              taskId: 'spoofed-task',
            },
          },
        },
      },
      { userId: 'owner-user' },
    );
    expect(result.status).toBe('accepted');
    // A metadata-derived binding would make this exact server association conflict.
    expect(
      eventStore.bindProjectTaskRoomExecution({
        projectId: 'real-project',
        taskId: 'real-task',
        sessionId: threadId,
      }),
    ).toEqual({ kind: 'bound' });
  });

  test('source closure waits through real Task claim, provider creation and dispatch finalization', async () => {
    mkdirSync(join(tmp, 'transfer-task-graph'), { recursive: true });
    const graph = new TaskGraphService(join(tmp, 'transfer-task-graph'), {
      projectService: {
        getProject: (slug) => ({
          id: slug,
          slug,
          name: slug,
          workingDirectory: tmp,
          createdAt: '2026-09-05T00:00:00.000Z',
          updatedAt: '2026-09-05T00:00:00.000Z',
        }),
      },
    });
    const task = await graph.createTask({
      projectId: 'transfer-project',
      title: 'Bound execution',
      workItemRef: 'github:example/transfer#1',
    });
    const releaseClaim = deferred<void>();
    const releasePublication = deferred<void>();
    let claimEntered = false;
    let publicationEntered = false;
    const dispatcher = composeTaskDispatcher(
      graph,
      {
        orchestrationService: service,
        resolveProjectWorkspace: () => tmp,
        assignmentClaimService: {
          claim: vi.fn(async () => {
            claimEntered = true;
            await releaseClaim.promise;
            return {
              outcome: 'claimed',
              record: { claimed_at: '2026-09-05T00:00:00.000Z' },
            } as never;
          }),
          release: vi.fn(),
          status: vi.fn(),
        },
      },
      {
        prepareAgentStarted: async () => {
          publicationEntered = true;
          await releasePublication.promise;
        },
        publishAgentStarted: async () => {},
      },
    );
    const release = deferred<void>();
    let entered = false;
    const original = claude.startSession.getMockImplementation()!;
    claude.startSession.mockImplementationOnce(async (input) => {
      entered = true;
      await release.promise;
      return original(input);
    });
    const dispatched = dispatcher.dispatch(task.id, {
      runtimeConfig: { provider: 'claude', cwd: tmp },
    });
    const scope = {
      projectId: task.projectId,
      projectSlug: task.projectId,
      taskId: task.id,
    };
    const grant = <K extends 'discover' | 'home-transfer'>(capability: K) =>
      Object.freeze({
        schemaVersion: 'station.project-task-room-grant/v1',
        capability,
        opaqueToken: 'transfer-test',
      }) as ProjectTaskRoomGrant<K>;
    const room = eventStore.createProjectTaskRoomHistory({
      capabilities: {
        resolve: async ({ required }) => ({
          kind: 'granted',
          receipt: {
            receiptId: `transfer-test-${required}`,
            capability: required,
            scope,
            principal: {
              kind: 'operator',
              operatorId: 'operator',
              deviceId: 'device',
            },
            policyRevision: 'transfer-test-policy',
          },
        }),
      },
    });
    const intent = {
      grant: grant('home-transfer'),
      operationId: 'transfer-test-operation',
      sourceHomeRef: 'source',
      targetHomeRef: 'target',
    };
    try {
      await waitFor(
        () => claimEntered,
        (value) => value,
        5000,
      );
      expect(entered).toBe(false);
      await room.open({ grant: grant('discover') });
      expect(await room.sealSource(intent)).toEqual({
        kind: 'execution-pending',
      });
      releaseClaim.resolve();
      await waitFor(
        () => entered,
        (value) => value,
        5000,
      );
      expect(await room.sealSource(intent)).toEqual({
        kind: 'execution-pending',
      });
      release.resolve();
      await waitFor(
        () => publicationEntered,
        (value) => value,
        5000,
      );
      expect(await room.sealSource(intent)).toEqual({
        kind: 'execution-pending',
      });
      releasePublication.resolve();
      const result = await dispatched;
      expect(result.kind).toBe('dispatched');
      if (result.kind !== 'dispatched')
        throw new Error('Expected real Task dispatch');
      expect(await room.sealSource(intent)).toMatchObject({ kind: 'sealed' });
      const restarted = await service.startSessionInternal(
        {
          type: 'start-session',
          input: {
            threadId: result.result.dispatch.sessionId,
            provider: 'claude',
            cwd: tmp,
          },
        },
        {},
        {
          roomExecutionBinding: { projectId: task.projectId, taskId: task.id },
        },
      );
      expect(restarted.status).toBe('failed');
      expect(claude.startSession).toHaveBeenCalledTimes(1);
      await expect(
        service.dispatch({
          type: 'sendTurn',
          input: {
            threadId: result.result.dispatch.sessionId,
            input: 'after source closure',
          },
        }),
      ).rejects.toThrow('coordination is temporarily unavailable');
      expect(claude.sendTurn).not.toHaveBeenCalled();
    } finally {
      releaseClaim.resolve();
      releasePublication.resolve();
      release.resolve();
      await dispatched;
      await room.close();
    }
  });

  test('retains a possibly completed adapter start and refuses a duplicate provider call', async () => {
    claude.startSession.mockRejectedValueOnce(
      new Error('response lost after provider invocation'),
    );
    const command = {
      type: 'start-session' as const,
      input: {
        threadId: 'uncertain-provider-start',
        provider: 'claude' as const,
      },
    };
    const result = await service.sessionCommands.execute(command, {
      userId: 'owner-user',
    });
    expect(result).toMatchObject({
      status: 'indeterminate',
      receiptStatus: 'unavailable',
    });
    expect(
      eventStore
        .sessionTurnBoundaryAuthority()
        .hasPossibleEffect(command.input.threadId),
    ).toEqual({ kind: 'available', active: true });
    expect(eventStore.readCommandReceipt(result.receipt.commandId)).toBeNull();
    expect(claude.startSession).toHaveBeenCalledTimes(1);
    const retry = await service.sessionCommands.execute(command, {
      userId: 'owner-user',
    });
    expect(retry.status).not.toBe('accepted');
    expect(claude.startSession).toHaveBeenCalledTimes(1);
  });

  test('starts a session through the closed SessionCommandModule with its durable receipt', async () => {
    const outcome = await service.sessionCommands.execute(
      {
        type: 'start-session',
        input: { threadId: 'module-start', provider: 'claude' },
      },
      { userId: 'owner-user' },
    );

    expect(outcome).toMatchObject({
      status: 'accepted',
      session: { threadId: 'module-start', provider: 'claude' },
      receipt: { threadId: 'module-start', commandType: 'startSession' },
    });
    if (outcome.status !== 'accepted') throw new Error(outcome.message);
    expect(eventStore.readCommandReceipt(outcome.receipt.commandId)).toEqual(
      outcome.receipt,
    );
    expect(
      eventStore
        .sessionTurnBoundaryAuthority()
        .hasPossibleEffect('module-start'),
    ).toEqual({ kind: 'available', active: false });
  });

  /**
   * archive#4237: Station OBSERVES a connected runtime's tool calls, it does
   * not dispatch them. What it spools must therefore carry no exit code and no
   * duration — only the status the runtime itself reported.
   */
  test('spools an observed tool command without a fabricated exit code or duration', async () => {
    const threadId = 'spool-observed-4237';
    await service.dispatch({
      type: 'startSession',
      input: { threadId, provider: 'claude' },
    });
    // Only flow-bound threads spool at all.
    eventStore.appendEvent({
      eventId: 'evt-4237-flow-attached',
      provider: 'claude',
      threadId,
      createdAt: new Date().toISOString(),
      method: 'flow.run-attached',
      runId: 'run-1',
      definitionId: 'test-flow',
      cwd: '/workspace/flow',
      resumed: false,
    } as never);

    const spool = vi.spyOn(
      (
        service as unknown as {
          flowPolicy: {
            commandEvidenceBridge: {
              spool: (threadId: string, cmd: unknown) => void;
            };
          };
        }
      ).flowPolicy.commandEvidenceBridge,
      'spool',
    );

    const base = {
      provider: 'claude' as const,
      threadId,
      createdAt: new Date().toISOString(),
      itemId: 'item-1',
      toolCallId: 'call-4237',
    };
    claude.events.push({
      ...base,
      eventId: 'evt-4237-tool-start',
      method: 'tool.started',
      toolName: 'Bash',
      arguments: { command: 'npm test' },
    } as never);
    claude.events.push({
      ...base,
      eventId: 'evt-4237-tool-done',
      method: 'tool.completed',
      toolName: 'Bash',
      status: 'error',
      error: 'exit 1',
    } as never);

    const calls = await waitFor(
      () => spool.mock.calls,
      (recorded) => recorded.length > 0,
      5000,
    );

    expect(calls[0]?.[1]).toMatchObject({
      command: 'npm test',
      status: 'error',
      exitCode: null,
      durationMs: null,
    });
  });

  test('keeps a completed execution session terminal while reserving one durable child for its conversation', async () => {
    claude.startSession.mockImplementationOnce(async (input) => {
      const session = {
        provider: 'claude' as const,
        threadId: input.threadId,
        status: 'ready' as const,
        resumeCursor: { nativeSession: 'turn-one' },
        createdAt: '2026-08-24T00:00:00.000Z',
        updatedAt: '2026-08-24T00:00:00.000Z',
      };
      claude.sessions.set(input.threadId, session);
      return session;
    });
    const started = await service.sessionCommands.execute(
      {
        type: 'start-session',
        input: {
          threadId: 'conversation-continuation',
          provider: 'claude',
          metadata: { userId: 'owner-user', connectionId: 'connection-a' },
        },
      },
      { userId: 'owner-user' },
    );
    if (started.status !== 'accepted') throw new Error(started.message);
    eventStore.appendEvent({
      eventId: 'conversation-continuation-configured',
      provider: 'claude',
      threadId: 'conversation-continuation',
      sessionId: 'conversation-continuation',
      method: 'session.configured',
      metadata: {
        userId: 'owner-user',
        agentSlug: 'station',
        connectionId: 'connection-a',
      },
      createdAt: '2026-08-24T00:00:00.500Z',
    });
    eventStore.appendEvent({
      eventId: 'conversation-continuation-completed',
      provider: 'claude',
      threadId: 'conversation-continuation',
      sessionId: 'conversation-continuation',
      method: 'session.state-changed',
      from: 'running',
      to: 'completed',
      sessionState: 'completed',
      previousState: 'running',
      transitionReason: 'turn_completed',
      transitionSource: 'runtime',
      createdAt: '2026-08-24T00:00:01.000Z',
    });

    const lineageBeforeOpen = eventStore.conversationSessions(
      'conversation-continuation',
    );
    const open = await service.resolveConversationOpen(
      'conversation-continuation',
      personalReadAuthority('owner-user'),
    );
    expect(open).toMatchObject({
      status: 'resolved',
      currentSessionId: 'conversation-continuation',
      canContinue: true,
    });
    // A read proves eligibility only; it must not reserve the successor that
    // the later foreground continuation command owns.
    expect(
      eventStore.conversationSessions('conversation-continuation'),
    ).toEqual(lineageBeforeOpen);

    const completedDetail = await service.readCurrentConversationSession(
      'conversation-continuation',
      INTERNAL_SESSION_READ_SCOPE,
    );
    if (!completedDetail) throw new Error('expected completed session detail');
    for (const session of [
      {
        ...completedDetail.session,
        controlMode: 'read-only-attached' as const,
      },
      { ...completedDetail.session, pendingReview: true },
      { ...completedDetail.session, hasActiveTurn: true },
      {
        // Unanswerable for a reason the successor reserve path cannot
        // recover: the child could still resume but no adapter here can
        // drive it. (#834 made `past_resume` on a stopped child continuable,
        // so it is no longer a denial case — see the stopped-conversation
        // test below.)
        ...completedDetail.session,
        answerability: {
          answerable: false as const,
          qualification: 'provider_absent' as const,
          observedBy: 'orchestration-service-test',
          observedAt: '2026-08-24T00:00:01.000Z',
        },
      },
    ]) {
      expect(
        canResolveConversationContinuation({
          ...completedDetail,
          session,
        }),
      ).toBe(false);
    }
    // #834 both directions: the SAME completed child decorated exactly as a
    // detached (unloaded) process would decorate it — `past_resume` is the
    // steady state of every finished session after a restart — remains
    // continuable, because continuation reserves a successor rather than
    // answering a request on the current child.
    expect(
      canResolveConversationContinuation({
        ...completedDetail,
        session: {
          ...completedDetail.session,
          answerability: {
            answerable: false as const,
            qualification: 'past_resume' as const,
            observedBy: 'orchestration-service-test',
            observedAt: '2026-08-24T00:00:01.000Z',
          },
        },
      }),
    ).toBe(true);

    const incompatibleProvider = await service.resolveConversationContinuation(
      'conversation-continuation',
      INTERNAL_SESSION_READ_SCOPE,
      { provider: 'codex', connectionId: 'connection-a' },
    );
    expect(incompatibleProvider).toMatchObject({
      startRequired: true,
      transcriptSeed: expect.any(String),
    });
    expect(incompatibleProvider).not.toHaveProperty('resumeCursor');
    vi.mocked(conversationContinuationOutcomes.add).mockImplementationOnce(
      () => {
        throw new Error('telemetry exporter unavailable');
      },
    );
    const first = await service.resolveConversationContinuation(
      'conversation-continuation',
      INTERNAL_SESSION_READ_SCOPE,
      { provider: 'claude', connectionId: 'connection-a' },
    );
    expect(first).toMatchObject({
      sessionId: incompatibleProvider.sessionId,
      resumeCursor: { nativeSession: 'turn-one' },
    });
    const incompatibleConnection =
      await service.resolveConversationContinuation(
        'conversation-continuation',
        INTERNAL_SESSION_READ_SCOPE,
        { provider: 'claude', connectionId: 'connection-b' },
      );
    expect(incompatibleConnection).toMatchObject({
      sessionId: first.sessionId,
      transcriptSeed: expect.any(String),
    });
    expect(incompatibleConnection).not.toHaveProperty('resumeCursor');
    const concurrent = await service.resolveConversationContinuation(
      'conversation-continuation',
      INTERNAL_SESSION_READ_SCOPE,
      { provider: 'claude', connectionId: 'connection-a' },
    );
    expect(first).toMatchObject({ startRequired: true });
    expect(concurrent).toEqual(first);
    expect(first.sessionId).not.toBe('conversation-continuation');
    const child = await service.sessionCommands.execute(
      {
        type: 'start-session',
        input: {
          threadId: first.sessionId,
          provider: 'claude',
          metadata: {
            userId: 'owner-user',
            conversationId: 'conversation-continuation',
            connectionId: 'connection-a',
          },
        },
      },
      { userId: 'owner-user' },
    );
    if (child.status !== 'accepted') throw new Error(child.message);
    // Supervision is intentionally read-only: it follows the active child
    // without reserving another one, and therefore never treats the durable
    // Conversation id as though it were an execution Session id.
    await expect(
      service.readCurrentConversationSession(
        'conversation-continuation',
        INTERNAL_SESSION_READ_SCOPE,
      ),
    ).resolves.toMatchObject({
      session: { threadId: first.sessionId },
    });
    expect(
      eventStore.conversationSessions('conversation-continuation'),
    ).toHaveLength(2);
    await service.dispatch({
      type: 'sendTurn',
      input: {
        threadId: first.sessionId,
        input: 'What was the token from the first turn?',
      },
    });
    expect(claude.sendTurn).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: first.sessionId }),
    );
    await expect(
      service.resolveConversationContinuation(
        'conversation-continuation',
        INTERNAL_SESSION_READ_SCOPE,
        { provider: 'claude', connectionId: 'connection-a' },
      ),
    ).resolves.toEqual({ sessionId: first.sessionId, startRequired: false });
    eventStore.appendEvent({
      eventId: 'conversation-root-user-turn',
      provider: 'claude',
      threadId: 'conversation-continuation',
      turnId: 'root-turn',
      method: 'turn.started',
      prompt: 'root-token amber-42',
      createdAt: '2026-08-24T00:00:02.000Z',
    });
    eventStore.appendEvent({
      eventId: 'conversation-child-user-turn',
      provider: 'claude',
      threadId: first.sessionId,
      turnId: 'child-turn',
      method: 'turn.started',
      prompt: 'child-token teal-99',
      createdAt: '2026-08-24T00:00:03.000Z',
    });
    eventStore.appendEvent({
      eventId: 'conversation-child-completed',
      provider: 'claude',
      threadId: first.sessionId,
      sessionId: first.sessionId,
      method: 'session.state-changed',
      from: 'running',
      to: 'completed',
      sessionState: 'completed',
      previousState: 'running',
      transitionReason: 'turn_completed',
      transitionSource: 'runtime',
      createdAt: '2026-08-24T00:00:04.000Z',
    });
    const third = await service.resolveConversationContinuation(
      'conversation-continuation',
      INTERNAL_SESSION_READ_SCOPE,
      { provider: 'claude', connectionId: 'connection-b' },
    );
    expect(third).toMatchObject({
      startRequired: true,
      transcriptSeed: expect.stringContaining('root-token amber-42'),
    });
    expect(third.transcriptSeed).toContain('child-token teal-99');
    expect(third.transcriptSeed).not.toContain('connection-a');
    expect(
      eventStore.conversationSessions('conversation-continuation'),
    ).toHaveLength(3);
  });

  // #834: pressing Stop tears down and DETACHES the current child, whose
  // answerability decoration is then permanently `past_resume` — the exact
  // shape the #749/#814 continuation gate misread as "never writable again",
  // which made Stop kill the conversation forever. This drives the real
  // command pipeline (start → answered turn → stopSession dispatch) and
  // proves the conversation stays continuable through the successor reserve.
  test('#834: a stopped, unloaded conversation stays continuable and reserves a successor', async () => {
    claude.startSession.mockImplementationOnce(async (input) => {
      const session: ProviderSession = {
        provider: 'claude' as const,
        threadId: input.threadId,
        status: 'ready' as const,
        resumeCursor: { nativeSession: 'stopped-turn-one' },
        createdAt: '2026-08-29T00:00:00.000Z',
        updatedAt: '2026-08-29T00:00:00.000Z',
      };
      claude.sessions.set(input.threadId, session);
      return session;
    });
    const started = await service.sessionCommands.execute(
      {
        type: 'start-session',
        input: {
          threadId: 'conversation-stopped',
          provider: 'claude',
          metadata: { userId: 'owner-user', connectionId: 'connection-a' },
        },
      },
      { userId: 'owner-user' },
    );
    if (started.status !== 'accepted') throw new Error(started.message);
    eventStore.appendEvent({
      eventId: 'conversation-stopped-configured',
      provider: 'claude',
      threadId: 'conversation-stopped',
      sessionId: 'conversation-stopped',
      method: 'session.configured',
      metadata: {
        userId: 'owner-user',
        agentSlug: 'station',
        connectionId: 'connection-a',
      },
      createdAt: '2026-08-29T00:00:00.500Z',
    });
    eventStore.appendEvent({
      eventId: 'conversation-stopped-turn',
      provider: 'claude',
      threadId: 'conversation-stopped',
      turnId: 'stopped-turn',
      method: 'turn.started',
      prompt: 'stopped-token violet-13',
      createdAt: '2026-08-24T00:00:01.000Z',
    });
    eventStore.appendEvent({
      eventId: 'conversation-stopped-turn-completed',
      provider: 'claude',
      threadId: 'conversation-stopped',
      turnId: 'stopped-turn',
      method: 'turn.completed',
      createdAt: '2026-08-24T00:00:01.500Z',
    });
    eventStore.appendEvent({
      eventId: 'conversation-stopped-completed',
      provider: 'claude',
      threadId: 'conversation-stopped',
      sessionId: 'conversation-stopped',
      method: 'session.state-changed',
      from: 'running',
      to: 'completed',
      sessionState: 'completed',
      previousState: 'running',
      transitionReason: 'turn_completed',
      transitionSource: 'runtime',
      createdAt: '2026-08-24T00:00:02.000Z',
    });

    await service.dispatchWithReceipt(
      { type: 'stopSession', threadId: 'conversation-stopped' },
      { userId: 'owner-user' },
    );

    // Fixture-vs-reality guard: the stopped child must project the REAL
    // post-stop decoration (#834's population) — detached + past resume —
    // or this test is not exercising the defect's shape at all.
    const stoppedDetail = await service.readCurrentConversationSession(
      'conversation-stopped',
      INTERNAL_SESSION_READ_SCOPE,
    );
    if (!stoppedDetail) throw new Error('expected stopped session detail');
    expect(stoppedDetail.session.answerability).toMatchObject({
      answerable: false,
      qualification: 'past_resume',
    });

    // The authoritative open — the same composition the picker/reload paths
    // call — must resolve the stopped conversation continuable without
    // reserving the successor the mutating command owns.
    const lineageBeforeOpen = eventStore.conversationSessions(
      'conversation-stopped',
    );
    const open = await service.resolveConversationOpen(
      'conversation-stopped',
      personalReadAuthority('owner-user'),
    );
    expect(open).toMatchObject({
      status: 'resolved',
      currentSessionId: 'conversation-stopped',
      canContinue: true,
    });
    expect(eventStore.conversationSessions('conversation-stopped')).toEqual(
      lineageBeforeOpen,
    );

    // The mutating continuation reserves the successor from the stopped
    // predecessor — the #765 A1 / PR #796 recovery this gate had made
    // unreachable — carrying the predecessor's trusted cursor.
    const continued = await service.resolveConversationContinuation(
      'conversation-stopped',
      INTERNAL_SESSION_READ_SCOPE,
      { provider: 'claude', connectionId: 'connection-a' },
    );
    expect(continued).toMatchObject({
      startRequired: true,
      resumeCursor: { nativeSession: 'stopped-turn-one' },
    });
    expect(continued.sessionId).not.toBe('conversation-stopped');
    expect(
      eventStore.conversationSessions('conversation-stopped'),
    ).toHaveLength(2);
  });

  // #765 A1: a predecessor started with `persistSession: false` has no
  // durable engine transcript behind its cursor — the Claude adapter spawns
  // such sessions with `--no-session-persistence`, so a child start that
  // presents the cursor deterministically dies with the CLI's
  // "No conversation found with session ID: <uuid>". The continuation must
  // take the transcript-seed fresh child instead.
  test('#765 A1: a predecessor without engine persistence continues by transcript seed, never its cursor', async () => {
    claude.startSession.mockImplementationOnce(async (input) => {
      const session: ProviderSession = {
        provider: 'claude' as const,
        threadId: input.threadId,
        status: 'ready' as const,
        resumeCursor: 'unpersisted-native-session',
        // The live adapter records the start posture on its ProviderSession
        // (claude-adapter.ts `startTrackedSession`); this is that exact
        // shape for a chat started before #765 forced persistence on.
        persistSession: false,
        createdAt: '2026-08-29T00:00:00.000Z',
        updatedAt: '2026-08-29T00:00:00.000Z',
      };
      claude.sessions.set(input.threadId, session);
      return session;
    });
    const started = await service.sessionCommands.execute(
      {
        type: 'start-session',
        input: {
          threadId: 'conversation-unpersisted',
          provider: 'claude',
          metadata: { userId: 'owner-user', connectionId: 'connection-a' },
        },
      },
      { userId: 'owner-user' },
    );
    if (started.status !== 'accepted') throw new Error(started.message);
    eventStore.appendEvent({
      eventId: 'conversation-unpersisted-configured',
      provider: 'claude',
      threadId: 'conversation-unpersisted',
      sessionId: 'conversation-unpersisted',
      method: 'session.configured',
      metadata: { connectionId: 'connection-a' },
      createdAt: '2026-08-29T00:00:00.500Z',
    });
    eventStore.appendEvent({
      eventId: 'conversation-unpersisted-turn',
      provider: 'claude',
      threadId: 'conversation-unpersisted',
      turnId: 'unpersisted-turn',
      method: 'turn.started',
      prompt: 'first-turn-token coral-7',
      createdAt: '2026-08-29T00:00:00.750Z',
    });
    eventStore.appendEvent({
      eventId: 'conversation-unpersisted-completed',
      provider: 'claude',
      threadId: 'conversation-unpersisted',
      sessionId: 'conversation-unpersisted',
      method: 'session.state-changed',
      from: 'running',
      to: 'completed',
      sessionState: 'completed',
      previousState: 'running',
      transitionReason: 'turn_completed',
      transitionSource: 'runtime',
      createdAt: '2026-08-29T00:00:01.000Z',
    });

    const next = await service.resolveConversationContinuation(
      'conversation-unpersisted',
      INTERNAL_SESSION_READ_SCOPE,
      { provider: 'claude', connectionId: 'connection-a' },
    );
    expect(next).toMatchObject({
      startRequired: true,
      transcriptSeed: expect.stringContaining('first-turn-token coral-7'),
    });
    expect(next).not.toHaveProperty('resumeCursor');
  });

  // #765 A1: `dead` is the engine's own structured verdict that this binding
  // can never resume (archive#1827). Reserving the next child on the same
  // disproved cursor replays the identical failure forever; the continuation
  // must fall back to the transcript seed so a user's retry genuinely
  // recovers the conversation.
  test('#765 A1: a dead engine binding continues by transcript seed — its cursor is disproved, not reusable', async () => {
    claude.startSession.mockImplementationOnce(async (input) => {
      const session: ProviderSession = {
        provider: 'claude' as const,
        threadId: input.threadId,
        status: 'ready' as const,
        resumeCursor: 'disproved-native-session',
        persistSession: true,
        createdAt: '2026-08-29T01:00:00.000Z',
        updatedAt: '2026-08-29T01:00:00.000Z',
      };
      claude.sessions.set(input.threadId, session);
      return session;
    });
    const started = await service.sessionCommands.execute(
      {
        type: 'start-session',
        input: {
          threadId: 'conversation-dead-binding',
          provider: 'claude',
          metadata: { userId: 'owner-user', connectionId: 'connection-a' },
        },
      },
      { userId: 'owner-user' },
    );
    if (started.status !== 'accepted') throw new Error(started.message);
    eventStore.appendEvent({
      eventId: 'conversation-dead-configured',
      provider: 'claude',
      threadId: 'conversation-dead-binding',
      sessionId: 'conversation-dead-binding',
      method: 'session.configured',
      metadata: { connectionId: 'connection-a' },
      createdAt: '2026-08-29T01:00:00.500Z',
    });
    eventStore.appendEvent({
      eventId: 'conversation-dead-turn',
      provider: 'claude',
      threadId: 'conversation-dead-binding',
      turnId: 'dead-turn',
      method: 'turn.started',
      prompt: 'dead-binding-token violet-3',
      createdAt: '2026-08-29T01:00:00.750Z',
    });
    // The REAL arrival path: the adapter's structured terminal report
    // (claude-adapter-events.ts publishes exactly this on a `result` with
    // `is_error`), consumed through the live event pipeline so the read
    // model marks the binding dead the same way production does. The live
    // adapter also flips its OWN retained session record to 'dead'
    // (claude-adapter.ts `consumeMessages`' terminalResultObserved catch) —
    // mirrored here so a later read-model refresh from the adapter cannot
    // resurrect 'ready'.
    const liveRecord = claude.sessions.get('conversation-dead-binding');
    if (liveRecord) liveRecord.status = 'dead';
    claude.events.push({
      eventId: 'conversation-dead-runtime-error',
      provider: 'claude',
      threadId: 'conversation-dead-binding',
      turnId: 'dead-turn',
      method: 'runtime.error',
      severity: 'error',
      code: 'engine-session-binding-dead',
      retriable: false,
      message:
        'No conversation found with session ID: disproved-native-session',
      createdAt: '2026-08-29T01:00:01.000Z',
    } as never);
    await waitFor(
      () => eventStore.readSessionByThread('conversation-dead-binding'),
      (session) => session?.status === 'dead',
      5000,
    );

    const next = await service.resolveConversationContinuation(
      'conversation-dead-binding',
      INTERNAL_SESSION_READ_SCOPE,
      { provider: 'claude', connectionId: 'connection-a' },
    );
    expect(next).toMatchObject({
      startRequired: true,
      transcriptSeed: expect.stringContaining('dead-binding-token violet-3'),
    });
    // The seed must carry the user's words, never the engine's error prose.
    expect(next.transcriptSeed).not.toContain('No conversation found');
    expect(next).not.toHaveProperty('resumeCursor');
  });

  test.each([
    ['reserved', undefined],
    ['failed', 'failed'],
    ['indeterminate', 'indeterminate'],
  ] as const)(
    'reload keeps the canonical conversation readable through its %s unmaterialized boundary child',
    async (_label, transition) => {
      const conversationId = `boundary-read-${_label}`;
      eventStore.upsertSession({
        provider: 'claude',
        threadId: conversationId,
        status: 'closed',
        createdAt: '2026-08-25T00:00:00.000Z',
        updatedAt: '2026-08-25T00:00:00.000Z',
      });
      const boundary = await service.reserveConversationContextBoundary(
        conversationId,
        INTERNAL_SESSION_READ_SCOPE,
        {
          policy: 'empty-next-cold-start',
          idempotencyKey: `boundary-${_label}`,
          expectedCurrentSessionId: conversationId,
          actorId: 'owner-user',
        },
      );
      if (transition) {
        service.claimConversationContextBoundaryColdStart(
          boundary.boundaryId,
          `start-${_label}`,
        );
        service.releaseConversationContextBoundaryFailedClaim(
          boundary.boundaryId,
          transition === 'indeterminate',
        );
      }
      const reloaded = new OrchestrationService({
        adapterRegistry: createRegistry([bedrock, claude]),
        eventBus: new EventBus(),
        eventStore,
        logger: { debug: vi.fn(), warn: vi.fn() },
      });

      await expect(
        reloaded.readCurrentConversationSession(
          conversationId,
          INTERNAL_SESSION_READ_SCOPE,
        ),
      ).resolves.toMatchObject({ session: { threadId: conversationId } });
    },
  );

  test('a plain continuation reservation is readable through its predecessor, but an arbitrary missing child is not (#764)', async () => {
    eventStore.upsertSession({
      provider: 'claude',
      threadId: 'plain-reservation-root',
      status: 'closed',
      createdAt: '2026-08-25T00:00:00.000Z',
      updatedAt: '2026-08-25T00:00:00.000Z',
    });
    eventStore.reserveNextConversationSession({
      conversationId: 'plain-reservation-root',
      predecessorSessionId: 'plain-reservation-root',
      proposedSessionId: 'plain-reservation-root:session:reserved',
      createdAt: '2026-08-25T00:01:00.000Z',
    });

    // #764: a plain continuation reservation creates neither a context
    // boundary nor a handoff marker. Supervision must look through it to the
    // authorized predecessor instead of failing the whole conversation.
    await expect(
      service.readCurrentConversationSession(
        'plain-reservation-root',
        INTERNAL_SESSION_READ_SCOPE,
      ),
    ).resolves.toMatchObject({
      session: { threadId: 'plain-reservation-root' },
    });

    // A lineage child that is NOT the exact tail is still not a fallback:
    // this is the authorization-bypass shape the read must refuse.
    await expect(
      service.readCurrentConversationSession(
        'plain-reservation-root:session:reserved',
        INTERNAL_SESSION_READ_SCOPE,
      ),
    ).resolves.toBeNull();
  });

  test('a cancelled or otherwise non-active boundary marker is not looked through (#764)', async () => {
    // Both markers are written directly to the store: the service-level
    // cancel compensates the successor lineage row (the cancelled child must
    // not stay the canonical tail), so a survived cancelled marker at the
    // exact tail is only reachable as a raw marker — which is exactly the
    // input the marker validation in readCurrentConversationSession must
    // refuse. (The remaining equality checks — conversationId/predecessor/
    // successor identity — are defense-in-depth the store's own reserve
    // invariants make unreachable: a marker whose predecessor does not
    // belong to its conversation is rejected with `successor_exists`.)
    for (const [label, status] of [
      ['cancelled', 'cancelled'],
      ['consumed', 'consumed'],
    ] as const) {
      const conversationId = `boundary-${label}-root`;
      eventStore.upsertSession({
        provider: 'claude',
        threadId: conversationId,
        status: 'closed',
        createdAt: '2026-08-25T00:00:00.000Z',
        updatedAt: '2026-08-25T00:00:00.000Z',
      });
      eventStore.reserveNextConversationSession({
        conversationId,
        predecessorSessionId: conversationId,
        proposedSessionId: `${conversationId}:session:reserved`,
        createdAt: '2026-08-25T00:02:00.000Z',
      });
      eventStore.reserveConversationContextBoundary({
        boundaryId: `${label}-boundary`,
        conversationId,
        predecessorSessionId: conversationId,
        successorSessionId: `${conversationId}:session:reserved`,
        idempotencyKey: `${label}-boundary-key`,
        policy: 'empty-next-cold-start',
        status,
        actorId: 'owner-user',
        createdAt: '2026-08-25T00:02:01.000Z',
      });
      // The exact-tail boundary exists but its status is not active — the
      // marker validation must refuse the predecessor fallback, or a
      // cancelled/consumed boundary would keep authorizing reads.
      await expect(
        service.readCurrentConversationSession(
          conversationId,
          INTERNAL_SESSION_READ_SCOPE,
        ),
      ).resolves.toBeNull();
    }
  });

  test('a failed continuation start keeps status readable and a retried continue reuses the same reserved child (#764)', async () => {
    claude.startSession.mockImplementationOnce(async (input) => {
      const session = {
        provider: 'claude' as const,
        threadId: input.threadId,
        status: 'ready' as const,
        resumeCursor: { nativeSession: 'turn-one' },
        createdAt: '2026-08-24T00:00:00.000Z',
        updatedAt: '2026-08-24T00:00:00.000Z',
      };
      claude.sessions.set(input.threadId, session);
      return session;
    });
    const started = await service.sessionCommands.execute(
      {
        type: 'start-session',
        input: {
          threadId: 'conversation-failed-start',
          provider: 'claude',
          metadata: { userId: 'owner-user', connectionId: 'connection-a' },
        },
      },
      { userId: 'owner-user' },
    );
    if (started.status !== 'accepted') throw new Error(started.message);
    eventStore.appendEvent({
      eventId: 'failed-start-configured',
      provider: 'claude',
      threadId: 'conversation-failed-start',
      sessionId: 'conversation-failed-start',
      method: 'session.configured',
      metadata: { connectionId: 'connection-a' },
      createdAt: '2026-08-24T00:00:00.500Z',
    });
    eventStore.appendEvent({
      eventId: 'failed-start-completed',
      provider: 'claude',
      threadId: 'conversation-failed-start',
      sessionId: 'conversation-failed-start',
      method: 'session.state-changed',
      from: 'running',
      to: 'completed',
      sessionState: 'completed',
      previousState: 'running',
      transitionReason: 'turn_completed',
      transitionSource: 'runtime',
      createdAt: '2026-08-24T00:00:01.000Z',
    });

    const first = await service.resolveConversationContinuation(
      'conversation-failed-start',
      INTERNAL_SESSION_READ_SCOPE,
      { provider: 'claude', connectionId: 'connection-a' },
    );
    expect(first).toMatchObject({ startRequired: true });
    expect(first.sessionId).not.toBe('conversation-failed-start');

    // The child start fails (the ACP loadSession-fail-closed shape): the
    // durable reservation remains as the lineage tail, and supervision must
    // resolve through it to the predecessor rather than erroring.
    await expect(
      service.readCurrentConversationSession(
        'conversation-failed-start',
        INTERNAL_SESSION_READ_SCOPE,
      ),
    ).resolves.toMatchObject({
      session: { threadId: 'conversation-failed-start' },
    });

    // The retried continue reaches the reserved_unstarted recovery and
    // reuses the SAME reserved child identity.
    const retry = await service.resolveConversationContinuation(
      'conversation-failed-start',
      INTERNAL_SESSION_READ_SCOPE,
      { provider: 'claude', connectionId: 'connection-a' },
    );
    expect(retry).toEqual(first);
    expect(
      eventStore.conversationSessions('conversation-failed-start'),
    ).toHaveLength(2);
  });

  test.each([
    ['observed loadSession absent', false, 'transcriptSeed'],
    ['observed loadSession present', true, 'resumeCursor'],
    ['capability unknown', undefined, 'resumeCursor'],
  ] as const)(
    'continuation decides cursor-vs-seed before start when resume support is %s (#764)',
    async (_label, support, expectedField) => {
      claude.startSession.mockImplementationOnce(async (input) => {
        const session = {
          provider: 'claude' as const,
          threadId: input.threadId,
          status: 'ready' as const,
          resumeCursor: { nativeSession: 'turn-one' },
          createdAt: '2026-08-24T00:00:00.000Z',
          updatedAt: '2026-08-24T00:00:00.000Z',
        };
        claude.sessions.set(input.threadId, session);
        return session;
      });
      const started = await service.sessionCommands.execute(
        {
          type: 'start-session',
          input: {
            threadId: `conversation-resume-support-${String(support)}`,
            provider: 'claude',
            metadata: { userId: 'owner-user', connectionId: 'connection-a' },
          },
        },
        { userId: 'owner-user' },
      );
      if (started.status !== 'accepted') throw new Error(started.message);
      const conversationId = `conversation-resume-support-${String(support)}`;
      eventStore.appendEvent({
        eventId: `${conversationId}-configured`,
        provider: 'claude',
        threadId: conversationId,
        sessionId: conversationId,
        method: 'session.configured',
        metadata: { connectionId: 'connection-a' },
        createdAt: '2026-08-24T00:00:00.500Z',
      });
      eventStore.appendEvent({
        eventId: `${conversationId}-completed`,
        provider: 'claude',
        threadId: conversationId,
        sessionId: conversationId,
        method: 'session.state-changed',
        from: 'running',
        to: 'completed',
        sessionState: 'completed',
        previousState: 'running',
        transitionReason: 'turn_completed',
        transitionSource: 'runtime',
        createdAt: '2026-08-24T00:00:01.000Z',
      });

      const supported = new OrchestrationService({
        adapterRegistry: createRegistry([bedrock, claude]),
        eventBus: new EventBus(),
        eventStore,
        resumeCursorSupport: ({ provider, connectionId }) =>
          provider === 'claude' && connectionId === 'connection-a'
            ? support
            : undefined,
        logger: { debug: vi.fn(), warn: vi.fn() },
      });

      const resolved = await supported.resolveConversationContinuation(
        conversationId,
        INTERNAL_SESSION_READ_SCOPE,
        { provider: 'claude', connectionId: 'connection-a' },
      );
      expect(resolved).toMatchObject({
        startRequired: true,
        ...(expectedField === 'resumeCursor'
          ? { resumeCursor: { nativeSession: 'turn-one' } }
          : { transcriptSeed: expect.any(String) }),
      });
      if (expectedField === 'resumeCursor') {
        expect(resolved).not.toHaveProperty('transcriptSeed');
      } else {
        expect(resolved).not.toHaveProperty('resumeCursor');
      }
    },
  );

  test('reserves an idempotent explicit handoff without letting ordinary continuation start its target child', async () => {
    const handoffService = new OrchestrationService({
      adapterRegistry: createRegistry([claude]),
      eventBus,
      eventStore,
      resolveSessionAgent: createSessionAgentResolver({
        loadAgentSpec: async (slug) =>
          slug === 'station' || slug === 'agent-b'
            ? {
                name: slug === 'station' ? 'Station' : 'Handoff Agent',
                prompt: 'Continue the conversation safely.',
                execution: { agentConnectionId: engineConnectionId('claude') },
              }
            : null,
        resolveToolServer: async () => null,
        resolveSkillDir: async () => null,
      }),
      loadAgentPresentation: async (slug) =>
        slug === 'station'
          ? { name: 'Station', icon: 'station' }
          : slug === 'agent-b'
            ? { name: 'Handoff Agent', icon: 'sparkles' }
            : undefined,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    const root = await handoffService.sessionCommands.execute(
      {
        type: 'start-session',
        input: {
          threadId: 'handoff-conversation',
          provider: 'claude',
          metadata: { userId: 'owner-user', agentSlug: 'station' },
        },
      },
      { userId: 'owner-user' },
    );
    if (root.status !== 'accepted') throw new Error(root.message);
    eventStore.appendEvent({
      eventId: 'handoff-root-complete',
      provider: 'claude',
      threadId: 'handoff-conversation',
      sessionId: 'handoff-conversation',
      method: 'session.state-changed',
      from: 'running',
      to: 'completed',
      sessionState: 'completed',
      previousState: 'running',
      transitionReason: 'turn_completed',
      transitionSource: 'runtime',
      createdAt: '2026-08-24T01:00:00.000Z',
    });
    const request = {
      agentId: 'agent-b',
      environmentId: 'environment-a',
      connectionId: 'claude',
      idempotencyKey: 'handoff-request-a',
      messageDigest: 'message-a',
    };
    const boundary = await handoffService.reserveConversationContextBoundary(
      'handoff-conversation',
      INTERNAL_SESSION_READ_SCOPE,
      {
        policy: 'continue-from-history',
        idempotencyKey: 'handoff-boundary',
        expectedCurrentSessionId: 'handoff-conversation',
        actorId: 'owner-user',
      },
    );
    const first = await handoffService.prepareConversationHandoff(
      'handoff-conversation',
      INTERNAL_SESSION_READ_SCOPE,
      request,
    );
    const replay = await handoffService.prepareConversationHandoff(
      'handoff-conversation',
      INTERNAL_SESSION_READ_SCOPE,
      request,
    );
    expect(replay.marker.sessionId).toBe(first.marker.sessionId);
    expect(replay.contextBoundary).toMatchObject({
      boundaryId: boundary.boundaryId,
      successorSessionId: first.marker.sessionId,
      policy: 'continue-from-history',
      status: 'reserved',
    });
    expect(replay.transcriptSeed).toBe(first.transcriptSeed);
    expect(replay.carried).toEqual(first.carried);
    expect(replay.reset).toEqual(first.reset);
    await expect(
      handoffService.prepareConversationHandoff(
        'handoff-conversation',
        INTERNAL_SESSION_READ_SCOPE,
        { ...request, messageDigest: 'different-message' },
      ),
    ).rejects.toThrow(
      'idempotency key already names a different target or message',
    );
    expect(first.reset).toContain('sessionApprovals');
    expect(first.reset).toContain('taskWorkflowReferences');
    await expect(
      handoffService.readConversationHandoffStatus(
        'handoff-conversation',
        request.idempotencyKey,
        INTERNAL_SESSION_READ_SCOPE,
      ),
    ).resolves.toMatchObject({
      status: 'reserved',
      currentSessionId: first.marker.sessionId,
    });
    await expect(
      handoffService.readConversationHandoffStatus(
        'handoff-conversation',
        request.idempotencyKey,
        personalReadAuthority('different-owner'),
      ),
    ).resolves.toBeNull();
    await expect(
      handoffService.resolveConversationContinuation(
        'handoff-conversation',
        INTERNAL_SESSION_READ_SCOPE,
        { provider: 'claude', connectionId: 'claude' },
      ),
    ).rejects.toThrow('explicit Agent/engine handoff awaiting');

    const child = await handoffService.sessionCommands.execute(
      {
        type: 'start-session',
        input: {
          threadId: first.marker.sessionId,
          provider: 'claude',
          metadata: {
            userId: 'owner-user',
            conversationId: 'handoff-conversation',
            agentSlug: 'agent-b',
          },
        },
      },
      { userId: 'owner-user' },
    );
    if (child.status !== 'accepted') throw new Error(child.message);
    expect(claude.startSession).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        metadata: expect.objectContaining({
          agentSlug: 'station',
          agentName: 'Station',
          agentIcon: 'station',
        }),
      }),
    );
    expect(claude.startSession).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        metadata: expect.objectContaining({
          agentSlug: 'agent-b',
          agentName: 'Handoff Agent',
          agentIcon: 'sparkles',
        }),
      }),
    );
    const clientTurnId = `handoff:${createHash('sha256')
      .update(`handoff-conversation\0${request.idempotencyKey}`)
      .digest('hex')}`;
    const claim = eventStore.createTurnDeduplicator().claim({
      threadId: first.marker.sessionId,
      clientTurnId,
    });
    if (claim.kind !== 'owner') throw new Error('expected turn claim owner');
    claim.claim.resolve('handoff-provider-turn');
    eventStore.appendEvent({
      eventId: 'handoff-turn-started',
      provider: 'claude',
      threadId: first.marker.sessionId,
      turnId: 'handoff-provider-turn',
      method: 'turn.started',
      prompt: 'continue',
      createdAt: '2026-08-24T01:00:30.000Z',
    });
    await expect(
      handoffService.readConversationHandoffStatus(
        'handoff-conversation',
        request.idempotencyKey,
        INTERNAL_SESSION_READ_SCOPE,
      ),
    ).resolves.toMatchObject({
      status: 'accepted',
      providerTurnId: 'handoff-provider-turn',
    });
    eventStore.appendEvent({
      eventId: 'handoff-turn-completed',
      provider: 'claude',
      threadId: first.marker.sessionId,
      turnId: 'handoff-provider-turn',
      method: 'turn.completed',
      outputText: 'continued',
      createdAt: '2026-08-24T01:00:45.000Z',
    });
    eventStore.appendEvent({
      eventId: 'handoff-token-usage-after-completion',
      provider: 'claude',
      threadId: first.marker.sessionId,
      turnId: 'handoff-provider-turn',
      method: 'token-usage.updated',
      promptTokens: 3,
      completionTokens: 2,
      createdAt: '2026-08-24T01:00:46.000Z',
    });
    await expect(
      handoffService.readConversationHandoffStatus(
        'handoff-conversation',
        request.idempotencyKey,
        INTERNAL_SESSION_READ_SCOPE,
      ),
    ).resolves.toMatchObject({ status: 'completed' });
    eventStore.appendEvent({
      eventId: 'handoff-child-complete',
      provider: 'claude',
      threadId: first.marker.sessionId,
      sessionId: first.marker.sessionId,
      method: 'session.state-changed',
      from: 'running',
      to: 'completed',
      sessionState: 'completed',
      previousState: 'running',
      transitionReason: 'turn_completed',
      transitionSource: 'runtime',
      createdAt: '2026-08-24T01:01:00.000Z',
    });
    await expect(
      handoffService.resolveConversationContinuation(
        'handoff-conversation',
        INTERNAL_SESSION_READ_SCOPE,
        { provider: 'claude', connectionId: 'claude' },
      ),
    ).resolves.toMatchObject({ startRequired: true });
    await handoffService.shutdown();
  });

  test('an empty-boundary handoff retry rehydrates its boundary without a transcript seed', async () => {
    eventStore.upsertSession({
      provider: 'claude',
      threadId: 'empty-handoff-conversation',
      status: 'closed',
      createdAt: '2026-08-25T00:00:00.000Z',
      updatedAt: '2026-08-25T00:00:00.000Z',
    });
    const boundary = await service.reserveConversationContextBoundary(
      'empty-handoff-conversation',
      INTERNAL_SESSION_READ_SCOPE,
      {
        policy: 'empty-next-cold-start',
        idempotencyKey: 'empty-handoff-boundary',
        expectedCurrentSessionId: 'empty-handoff-conversation',
        actorId: 'owner-user',
      },
    );
    const input = {
      agentId: 'agent-b',
      environmentId: 'environment-a',
      idempotencyKey: 'empty-handoff',
      messageDigest: 'message-a',
    };
    const first = await service.prepareConversationHandoff(
      'empty-handoff-conversation',
      INTERNAL_SESSION_READ_SCOPE,
      input,
    );
    const replay = await service.prepareConversationHandoff(
      'empty-handoff-conversation',
      INTERNAL_SESSION_READ_SCOPE,
      input,
    );

    expect(first).not.toHaveProperty('transcriptSeed');
    expect(replay).not.toHaveProperty('transcriptSeed');
    expect(replay.contextBoundary).toMatchObject({
      boundaryId: boundary.boundaryId,
      status: 'reserved',
      policy: 'empty-next-cold-start',
    });
  });

  // archive#2821 hardening L3: `sessionVisibility` is now a reserved
  // metadata key (RESERVED_ORCHESTRATION_METADATA_KEYS), so the ordinary
  // public `sessionCommands.execute` seam strips it from every caller —
  // trusted or not, since the strip cannot tell them apart. The one
  // legitimate writer (the foreground webhook seam, `startSession` in
  // station-control-delegation.ts) routes through the internal-only
  // `startSessionInternal`/`ephemeralSessionVisibility` escape hatch instead
  // of relying on the metadata bag surviving the strip.
  test('retains an ephemeral start receipt while excluding its session from ordinary inventories after restart', async () => {
    const outcome = await service.startSessionInternal(
      {
        type: 'start-session',
        input: {
          threadId: 'webhook-ephemeral',
          provider: 'claude',
          metadata: {
            userId: 'owner-user',
            sessionVisibility: 'ephemeral',
          },
        },
      },
      { userId: 'owner-user' },
      { ephemeralSessionVisibility: true },
    );
    if (outcome.status !== 'accepted') throw new Error(outcome.message);

    expect(await service.listSessions()).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ threadId: 'webhook-ephemeral' }),
      ]),
    );
    expect(await service.listSessionReadModel()).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ threadId: 'webhook-ephemeral' }),
      ]),
    );
    expect(eventStore.readCommandReceipt(outcome.receipt.commandId)).toEqual(
      outcome.receipt,
    );
    expect(eventStore.readSessionByThread('webhook-ephemeral')).toMatchObject({
      ephemeral: true,
    });

    const restarted = new OrchestrationService({
      adapterRegistry: createRegistry([bedrock, claude]),
      eventBus: new EventBus(),
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    expect(await restarted.listSessionReadModel()).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ threadId: 'webhook-ephemeral' }),
      ]),
    );
  });

  // archive#2821 hardening L3 enforcement proof: without
  // `ephemeralSessionVisibility`, the SAME metadata shape a public
  // `startSession` command body could carry (an untyped `z.record`) must not
  // be able to hide an ordinary session from listings. This is the negative
  // control for the reservation above — it fails red if `sessionVisibility`
  // is removed from `RESERVED_ORCHESTRATION_METADATA_KEYS`.
  test('a public startSession command cannot forge sessionVisibility to hide its own session', async () => {
    const outcome = await service.sessionCommands.execute(
      {
        type: 'start-session',
        input: {
          threadId: 'forged-ephemeral',
          provider: 'claude',
          metadata: {
            userId: 'owner-user',
            sessionVisibility: 'ephemeral',
          },
        },
      },
      { userId: 'owner-user' },
    );
    if (outcome.status !== 'accepted') throw new Error(outcome.message);

    expect(await service.listSessions()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ threadId: 'forged-ephemeral' }),
      ]),
    );
    expect(await service.listSessionReadModel()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ threadId: 'forged-ephemeral' }),
      ]),
    );
    expect(eventStore.readSessionByThread('forged-ephemeral')).not.toEqual(
      expect.objectContaining({ ephemeral: true }),
    );
  });

  test('public start metadata cannot author conversation or Environment ownership', async () => {
    const outcome = await service.sessionCommands.execute(
      {
        type: 'start-session',
        input: {
          threadId: 'forged-conversation-owner',
          provider: 'claude',
          metadata: {
            userId: 'owner-user',
            conversationId: 'attacker-conversation',
            environmentId: 'attacker-environment',
          },
        },
      },
      { userId: 'owner-user' },
    );
    if (outcome.status !== 'accepted') throw new Error(outcome.message);

    expect(claude.startSession).toHaveBeenLastCalledWith(
      expect.objectContaining({
        metadata: expect.not.objectContaining({
          conversationId: expect.anything(),
          environmentId: expect.anything(),
        }),
      }),
    );
  });

  test('projects a durable peer delegation Activity record without claiming completion before peer evidence (#847)', async () => {
    service.recordPeerDelegationActivityDispatch({
      taskId: 'task:peer-847',
      conversationId: 'task:peer-847',
      prompt: 'Verify the release candidate',
      userId: 'owner-user',
      environment: {
        id: 'environment-peer',
        name: 'Station B',
        kind: 'peer',
      },
      target: { kind: 'agent', id: 'codex' },
    });

    const dispatched = (await service.listSessionReadModel()).find(
      (session) => session.delegation?.taskId === 'task:peer-847',
    );
    expect(dispatched).toMatchObject({
      lifecycleState: 'queued',
      displayTitle: 'Verify the release candidate',
      delegation: {
        taskId: 'task:peer-847',
        environmentId: 'environment-peer',
        environmentName: 'Station B',
        environmentKind: 'peer',
        targetKind: 'agent',
        targetId: 'codex',
      },
    });
    expect(dispatched?.lifecycleState).not.toBe('completed');

    expect(
      service.recordPeerDelegationActivityOutcome({
        taskId: 'task:peer-847',
        environmentId: 'environment-peer',
        status: 'completed',
      }),
    ).toBe(true);
    expect(
      (await service.listSessionReadModel()).find(
        (session) => session.delegation?.taskId === 'task:peer-847',
      ),
    ).toMatchObject({ lifecycleState: 'completed' });
  });

  test.each(['needs_input', 'review_pending'] as const)(
    'advances a queued peer Activity record through contract-derived hops to %s (#847 fix round)',
    async (status) => {
      service.recordPeerDelegationActivityDispatch({
        taskId: `task:peer-847-${status}`,
        conversationId: `task:peer-847-${status}`,
        prompt: `Observe ${status}`,
        userId: 'owner-user',
        environment: {
          id: 'environment-peer',
          name: 'Station B',
          kind: 'peer',
        },
        target: { kind: 'agent', id: 'codex' },
      });

      expect(
        service.recordPeerDelegationActivityOutcome({
          taskId: `task:peer-847-${status}`,
          environmentId: 'environment-peer',
          status,
        }),
      ).toBe(true);
      const projected = (await service.listSessionReadModel()).find(
        (session) => session.delegation?.taskId === `task:peer-847-${status}`,
      );
      expect(projected).toMatchObject({ lifecycleState: status });
      expect(projected?.eventCount).toBe(3);
    },
  );

  test('rejects local execution and recovery materialization for peer Activity records (#847 fix round)', async () => {
    const stationAgent = new FakeAdapter('station-agent');
    const peerService = new OrchestrationService({
      adapterRegistry: createRegistry([stationAgent]),
      eventBus: new EventBus(),
      eventStore,
      ownerlessSessionAccess: 'single-user-compat',
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    const threadId = peerService.recordPeerDelegationActivityDispatch({
      taskId: 'task:peer-847-non-executable',
      conversationId: 'task:peer-847-non-executable',
      prompt: 'Must remain remote',
      userId: 'owner-user',
      environment: {
        id: 'environment-peer',
        name: 'Station B',
        kind: 'peer',
      },
      target: { kind: 'agent', id: 'codex' },
    });

    await expect(
      peerService.dispatch({
        type: 'sendTurn',
        input: { threadId, input: 'run locally' },
      }),
    ).rejects.toThrow('Peer delegation Activity records are read-only.');
    await expect(
      (peerService as any).materializeRecoveredSession(threadId),
    ).resolves.toBeUndefined();
    expect(stationAgent.startSession).not.toHaveBeenCalled();
    expect(stationAgent.sendTurn).not.toHaveBeenCalled();
    expect(
      (await peerService.listSessionReadModel()).find(
        (session) => session.threadId === threadId,
      ),
    ).toMatchObject({ lifecycleState: 'queued' });
    await peerService.shutdown();
  });

  // archive#4543 MED-2: the combined test above asserts BOTH keys absent in
  // one `not.objectContaining({conversationId, environmentId})` — Jest/
  // Vitest's `objectContaining` requires every listed key to match, so
  // `not.objectContaining` is satisfied the moment EITHER key is missing.
  // Deleting just `ENVIRONMENT_ID_RESERVED_METADATA_KEY` from
  // `RESERVED_ORCHESTRATION_METADATA_KEYS` (leaving `conversationId`
  // reserved) would let `environmentId` through while `conversationId`
  // stays stripped — the combined test still passes, uncaught, across the
  // whole 1,795-test suite. These two are the independent negative
  // controls, mirroring `sessionVisibility`'s solo negative control above:
  // each fails red on its own if ITS key alone is removed from the list.
  test('a public startSession command cannot forge metadata.environmentId alone', async () => {
    const outcome = await service.sessionCommands.execute(
      {
        type: 'start-session',
        input: {
          threadId: 'forged-environment-owner-solo',
          provider: 'claude',
          metadata: {
            userId: 'owner-user',
            environmentId: 'attacker-environment',
          },
        },
      },
      { userId: 'owner-user' },
    );
    if (outcome.status !== 'accepted') throw new Error(outcome.message);

    expect(claude.startSession).toHaveBeenLastCalledWith(
      expect.objectContaining({
        metadata: expect.not.objectContaining({
          environmentId: expect.anything(),
        }),
      }),
    );
  });

  test('a public startSession command cannot forge metadata.conversationId alone', async () => {
    const outcome = await service.sessionCommands.execute(
      {
        type: 'start-session',
        input: {
          threadId: 'forged-conversation-owner-solo',
          provider: 'claude',
          metadata: {
            userId: 'owner-user',
            conversationId: 'attacker-conversation',
          },
        },
      },
      { userId: 'owner-user' },
    );
    if (outcome.status !== 'accepted') throw new Error(outcome.message);

    expect(claude.startSession).toHaveBeenLastCalledWith(
      expect.objectContaining({
        metadata: expect.not.objectContaining({
          conversationId: expect.anything(),
        }),
      }),
    );
  });

  test('internal foreground identity is re-stamped after the public metadata strip', async () => {
    const outcome = await service.startSessionInternal(
      {
        type: 'start-session',
        input: {
          threadId: 'trusted-conversation-owner',
          provider: 'claude',
          metadata: {
            conversationId: 'untrusted-placeholder',
            environmentId: 'untrusted-placeholder',
          },
        },
      },
      { userId: 'owner-user' },
      {
        conversationIdentity: {
          conversationId: 'trusted-conversation',
          environmentId: 'trusted-environment',
        },
      },
    );
    if (outcome.status !== 'accepted') throw new Error(outcome.message);

    expect(claude.startSession).toHaveBeenLastCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          conversationId: 'trusted-conversation',
          environmentId: 'trusted-environment',
        }),
      }),
    );
  });

  // Review L2: the escape hatch's safety rests on `input.ephemeral` being
  // unreachable from a request body — which holds today only because the
  // foreground schema strips unknown keys. This pins the REAL invariant at
  // the outer seam: a body carrying `ephemeral: true` produces a LISTED
  // session. A future `.passthrough()` or looser validator reddens this
  // rather than silently opening the privileged path.
  test('a request body carrying ephemeral:true cannot make its session ephemeral through the public foreground seam', async () => {
    const parsed = foregroundMessageObjectSchema.safeParse({
      target: { agent: 'station' },
      message: 'hello',
      ephemeral: true,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(
        (parsed.data as Record<string, unknown>).ephemeral,
      ).toBeUndefined();
    }
  });

  test('starts a session under an observed 99%-busy diagnostic', async () => {
    const startSession = vi.spyOn(claude, 'startSession');
    const healthyService = new OrchestrationService({
      adapterRegistry: createRegistry([claude]),
      eventBus,
      eventStore,
      resourcePosture: createRuntimeResourcePostureController({
        sample: async () => ({
          busyPercent: 99,
          cpuCount: 15,
          sampledAt: 100,
          sampleMs: 500,
          thresholdPercent: 85,
          source: 'test',
        }),
      }),
      logger: { debug: vi.fn(), warn: vi.fn() },
    });

    await expect(
      healthyService.dispatch(
        {
          type: 'startSession',
          input: { threadId: 'busy-diagnostic', provider: 'claude' },
        },
        { userId: 'owner-user' },
      ),
    ).resolves.toMatchObject({
      threadId: 'busy-diagnostic',
      provider: 'claude',
    });
    expect(startSession).toHaveBeenCalledOnce();
  });

  test('holds one global cold-start lease through provider startup across different threads', async () => {
    const originalStart = claude.startSession.getMockImplementation();
    if (!originalStart) throw new Error('expected fake start implementation');
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const startSession = claude.startSession.mockImplementationOnce(
      async (input) => {
        await firstGate;
        return await originalStart(input);
      },
    );
    const controller = createRuntimeResourcePostureController({
      sample: async () => ({
        busyPercent: 20,
        cpuCount: 15,
        sampledAt: Date.now(),
        sampleMs: 500,
        thresholdPercent: 85,
        source: 'test',
      }),
    });
    const service = new OrchestrationService({
      adapterRegistry: createRegistry([claude]),
      eventBus,
      eventStore,
      resourcePosture: controller,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });

    const first = service.startSessionInternal(
      {
        type: 'start-session',
        input: { threadId: 'start-lease-a', provider: 'claude' },
      },
      { userId: 'owner-user' },
      { resourceAdmissionIntent: 'interactive_user' },
    );
    await vi.waitFor(() => expect(startSession).toHaveBeenCalledOnce());
    await expect(
      service.startSessionInternal(
        {
          type: 'start-session',
          input: { threadId: 'start-lease-b', provider: 'claude' },
        },
        { userId: 'owner-user' },
        { resourceAdmissionIntent: 'interactive_user' },
      ),
    ).resolves.toMatchObject({
      status: 'rejected',
      code: 'resource_engine_start_capacity',
    });
    await expect(
      service.dispatch(
        {
          type: 'startSession',
          input: { threadId: 'start-lease-c', provider: 'claude' },
        },
        { userId: 'owner-user' },
      ),
    ).rejects.toMatchObject({
      code: 'resource_engine_start_capacity',
      retryable: true,
    });
    expect(startSession).toHaveBeenCalledOnce();
    releaseFirst();
    const firstOutcome = await first;
    if (firstOutcome.status !== 'accepted') {
      throw new Error(
        `first start did not settle accepted: ${firstOutcome.message}`,
      );
    }
    expect(firstOutcome.status).toBe('accepted');
  });

  test('maps an indeterminate SessionCommand result to an honest dispatch error', async () => {
    const session = {
      threadId: 'receipt-uncertain-session',
      provider: 'claude' as const,
      status: 'ready' as const,
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:00.000Z',
    };
    vi.spyOn(service.sessionCommands, 'execute').mockResolvedValueOnce({
      status: 'indeterminate',
      receipt: {
        commandId: 'receipt-uncertain-command',
        threadId: session.threadId,
        commandType: 'startSession',
        status: 'accepted',
        createdAt: '2026-08-13T00:00:00.000Z',
      },
      receiptStatus: 'unavailable',
      session,
      message:
        'Session started, but the accepted command receipt is unavailable.',
    });

    await expect(
      service.dispatchWithReceipt({
        type: 'startSession',
        input: { threadId: session.threadId, provider: 'claude' },
      }),
    ).rejects.toMatchObject({
      name: OrchestrationCommandDispatchError.name,
      receiptStatus: 'unavailable',
      indeterminateSession: session,
    });
  });

  test('fences lifecycle completion while a provider turn startup is unresolved', async () => {
    await service.dispatch({
      type: 'startSession',
      input: { threadId: 'lifecycle-turn-race', provider: 'claude' },
    });
    const accepted = deferred<ProviderTurnStartResult>();
    claude.sendTurn.mockImplementationOnce(() => accepted.promise);

    const dispatch = service.dispatch({
      type: 'sendTurn',
      input: { threadId: 'lifecycle-turn-race', input: 'Start work' },
    });
    await waitFor(
      () => claude.sendTurn.mock.calls.length,
      (calls) => calls === 1,
    );
    let lifecycleSettled = false;
    const lifecycle = service.sessionLifecycles
      .transition({
        threadId: 'lifecycle-turn-race',
        to: 'completed',
      })
      .finally(() => {
        lifecycleSettled = true;
      });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(lifecycleSettled).toBe(false);
    accepted.resolve({
      threadId: 'lifecycle-turn-race',
      turnId: 'lifecycle-turn-1',
    });
    await expect(dispatch).resolves.toEqual({
      threadId: 'lifecycle-turn-race',
      turnId: 'lifecycle-turn-1',
    });
    await expect(lifecycle).rejects.toThrow(/active turn/);

    claude.events.push({
      eventId: randomUUID(),
      provider: 'claude',
      threadId: 'lifecycle-turn-race',
      turnId: 'lifecycle-turn-1',
      createdAt: new Date().toISOString(),
      method: 'turn.completed',
      outputText: 'done',
    });
    await waitFor(
      () => eventStore.listEvents('lifecycle-turn-race'),
      (events) =>
        events.some((event) => event.payload.method === 'turn.completed'),
    );
    await expect(
      service.readSession('lifecycle-turn-race'),
    ).resolves.toMatchObject({ session: { lifecycleState: 'completed' } });
  });

  // archive#3581 review BLOCK 1: everything above proves the READ-side
  // folds (`deriveLifecycleTransition`/`deriveAgentRunStatus`,
  // `findTerminalFailureEvent`) reject a stale terminal correctly. It
  // proves NOTHING about the WRITE path, because every fixture in
  // `orchestration-session-state.test.ts`/`event-store.test.ts` either
  // hand-builds an events array with no `sessionState` field or appends
  // directly via `store.appendEvent`, bypassing
  // `normalizeCanonicalRuntimeEventLifecycle` entirely — neither carries the
  // byte shape the REAL writer produces. `consumeAdapterEvents`
  // (`orchestration-service.ts`) stamps `sessionState` onto every event
  // BEFORE persisting it, and `deriveLifecycleTransition`'s stamp
  // early-return honors that stamp ahead of its own identity guard — so a
  // stale terminal that gets stamped `sessionState: 'completed'` on write
  // sails past the read-side fix entirely. This test drives the adapter
  // event stream through the REAL `consumeAdapterEvents` (via
  // `FakeAdapter.events.push`, exactly like the test above), so the
  // `sessionState` on the persisted row is whatever production actually
  // writes — not an imagined shape. It must fail on a tree missing BLOCK 1's
  // fix (the write path folding `activeTurnIdForEvents` instead of
  // `turnIdentityAnchorForEvents`, or the stamp early-return not
  // distrusting a rejected terminal) and pass once both land.
  test('station#3581 review BLOCK 1: a stale turn.completed is not stamped completed at WRITE time, driven through consumeAdapterEvents end-to-end', async () => {
    const threadId = 'block1-write-path-stale-terminal';
    await service.dispatch({
      type: 'startSession',
      input: { threadId, provider: 'claude' },
    });

    claude.events.push({
      eventId: randomUUID(),
      provider: 'claude',
      threadId,
      turnId: 'turn-1',
      createdAt: '2026-08-19T00:00:01.000Z',
      method: 'turn.started',
      prompt: 'first turn',
    });
    claude.events.push({
      eventId: randomUUID(),
      provider: 'claude',
      threadId,
      turnId: 'turn-2',
      createdAt: '2026-08-19T00:00:02.000Z',
      method: 'turn.started',
      prompt: 'second turn',
    });
    // Closes turn-2 with a REAL failure — the event that used to erase
    // (via the old `activeTurnIdForEvents` write-path fold) which turn the
    // identity guard was protecting.
    claude.events.push({
      eventId: randomUUID(),
      provider: 'claude',
      threadId,
      turnId: 'turn-2',
      createdAt: '2026-08-19T00:00:03.000Z',
      method: 'runtime.error',
      severity: 'error',
      message: 'usage limit reached',
      retriable: false,
    });
    // The stale/orphaned terminal for turn-1, arriving after turn-2's real
    // failure — same shape as codex's late `'turn/completed'` notification
    // (archive#3572).
    claude.events.push({
      eventId: randomUUID(),
      provider: 'claude',
      threadId,
      turnId: 'turn-1',
      createdAt: '2026-08-19T00:00:04.000Z',
      method: 'turn.completed',
      finishReason: 'other',
    });

    await waitFor(
      () => eventStore.listEvents(threadId),
      (events) =>
        events.some(
          (event) =>
            event.payload.method === 'turn.completed' &&
            event.payload.turnId === 'turn-1',
        ),
    );

    // The write-time stamp is the thing under test: read the PERSISTED
    // row's own `sessionState` field directly — what
    // `normalizeCanonicalRuntimeEventLifecycle` actually wrote to disk for
    // this event, not a value a read-time fold recomputed afterward.
    const persistedStaleTerminal = eventStore
      .listEvents(threadId)
      .map((stored) => stored.payload)
      .find(
        (event) =>
          event.method === 'turn.completed' && event.turnId === 'turn-1',
      );
    expect(persistedStaleTerminal?.sessionState).not.toBe('completed');

    await expect(service.readSession(threadId)).resolves.toMatchObject({
      session: {
        lifecycleState: 'failed',
        blockedReason: 'usage limit reached',
      },
    });
  });

  /**
   * archive#4075 stage 2 acceptance: "two live clients — principal A
   * dispatches a turn while principal B [steers], both attributions
   * recorded correctly and distinctly on their respective turn.started
   * events." A genuine two-process/two-HTTP-credential run was not
   * attempted — see this repo's usual `docs/reference/cli.md` local-grant
   * scripted flow mints two PAIRED-DEVICE credentials for the SAME
   * personal-mode operator, which stage 1's resolver deliberately maps to
   * the IDENTICAL `human:local:operator` principal (personal mode has one
   * implicit operator by design); two genuinely DISTINCT principals need
   * either hosted-mode tenancy or a mix of a direct-loopback caller and a
   * caller presenting a real Tailscale Serve identity header, neither of
   * which this branch's environment can stand up. This test is therefore
   * the route-level-and-below floor: it drives the REAL dispatch ->
   * `ClientOriginTurnPropagation.begin/settle` -> adapter event queue ->
   * `consumeAdapterEvents` -> `projectAndPublishEvent`/`apply()` ->
   * `EventStore.appendEvent` pipeline end-to-end (via `claude.events.push`,
   * the same idiom `archive#3581 review BLOCK 1` above uses to prove a
   * write path rather than a hand-built fixture), passing two DISTINCT
   * `PrincipalRef`s as the dispatch context — the exact seam
   * `orchestration.ts`'s `resolveActorPrincipal` populates per request in
   * production — and reads back the two PERSISTED `turn.started` rows.
   */
  test('station#4075 stage 2: a dispatching principal and a later steering principal are stamped distinctly on their own persisted turn.started rows', async () => {
    const threadId = 'thread-4075-attribution';
    await service.dispatch({
      type: 'startSession',
      input: { threadId, provider: 'claude' },
    });

    const dispatchingPrincipal = {
      id: 'human:tailscale-serve:alice',
      kind: 'human' as const,
      display: 'Alice',
    };
    const steeringPrincipal = {
      id: 'human:tailscale-serve:bob',
      kind: 'human' as const,
      display: 'Bob',
    };

    // Principal A dispatches the initial turn — mirrors the real
    // claude-adapter.ts, which publishes its own `turn.started` (no
    // clientOrigin/principal — those are stamped by propagation) BEFORE
    // `sendTurn` resolves the accepted turnId.
    claude.sendTurn.mockImplementationOnce(async (input) => {
      claude.events.push({
        eventId: randomUUID(),
        provider: 'claude',
        threadId: input.threadId,
        turnId: 'turn-4075',
        createdAt: '2026-08-24T00:00:01.000Z',
        method: 'turn.started',
        prompt: input.input,
      });
      return { threadId: input.threadId, turnId: 'turn-4075' };
    });

    await expect(
      service.dispatch(
        { type: 'sendTurn', input: { threadId, input: 'from alice' } },
        { principal: dispatchingPrincipal },
      ),
    ).resolves.toMatchObject({ threadId, turnId: 'turn-4075' });

    await waitFor(
      () => eventStore.listEvents(threadId),
      (events) =>
        events.some(
          (event) =>
            event.payload.method === 'turn.started' &&
            !('inputKind' in event.payload),
        ),
    );

    // Principal B steers the SAME open turn — mirrors claude-adapter.ts's
    // own `steerTurn`, which publishes `turn.started (inputKind:'steer')`
    // reusing the existing turnId.
    claude.steerTurn.mockImplementationOnce(
      async (steerThreadId, steerInput, steerTurnId) => {
        claude.events.push({
          eventId: randomUUID(),
          provider: 'claude',
          threadId: steerThreadId,
          turnId: steerTurnId,
          createdAt: '2026-08-24T00:00:02.000Z',
          method: 'turn.started',
          prompt: steerInput,
          inputKind: 'steer',
        });
      },
    );

    await expect(
      service.dispatch(
        { type: 'steerTurn', threadId, input: 'from bob' },
        { principal: steeringPrincipal },
      ),
    ).resolves.toEqual({ outcome: 'steered', threadId, turnId: 'turn-4075' });

    await waitFor(
      () => eventStore.listEvents(threadId),
      (events) =>
        events.filter((event) => event.payload.method === 'turn.started')
          .length === 2,
    );

    const turnStarts = eventStore
      .listEvents(threadId)
      .filter((event) => event.payload.method === 'turn.started')
      .map((event) => event.payload);
    const dispatchTurnStarted = turnStarts.find(
      (event) => !('inputKind' in event),
    );
    const steerTurnStarted = turnStarts.find(
      (event) => (event as { inputKind?: string }).inputKind === 'steer',
    );

    expect(dispatchTurnStarted?.principal).toEqual(dispatchingPrincipal);
    expect(steerTurnStarted?.principal).toEqual(steeringPrincipal);
    expect(dispatchTurnStarted?.principal).not.toEqual(
      steerTurnStarted?.principal,
    );
  });

  /**
   * archive#4075 stage 2 review round 1 (F2, MEDIUM/HIGH): `sendTurn`'s
   * begin/settle runs INSIDE `sessionExecutionCoordinator.runTurnStart`,
   * which serializes distinct turn starts per thread; `steerTurn`'s
   * original case had no such wrap — two concurrent steers on one thread
   * could both proceed, and whichever adapter event landed second would
   * republish under the FIRST steerer's reservation: a misattributed
   * event. The fix adds a purpose-built `inFlightSteers` per-thread gate
   * (checking `begin()`'s own return was tried first and found
   * insufficient — its `false` return conflates "nothing to reserve" with
   * "already reserved", which broke the ordinary no-clientOrigin/
   * no-principal steer path entirely; see the class's docblock). This
   * proves the fix's contract: a second steer racing an in-flight one is
   * REFUSED (`outcome: 'concurrent-steer'`), the adapter is never even
   * called for it, and the eventual persisted steer `turn.started`
   * carries ONLY the first (winning) steerer's principal — never the
   * second's.
   */
  test('station#4075 stage 2: two steers racing on one thread — the second is refused, never misattributed', async () => {
    const threadId = 'thread-4075-concurrent-steer';
    await service.dispatch({
      type: 'startSession',
      input: { threadId, provider: 'claude' },
    });

    claude.sendTurn.mockImplementationOnce(async (input) => {
      claude.events.push({
        eventId: randomUUID(),
        provider: 'claude',
        threadId: input.threadId,
        turnId: 'turn-concurrent-steer',
        createdAt: '2026-08-24T00:00:01.000Z',
        method: 'turn.started',
        prompt: input.input,
      });
      return { threadId: input.threadId, turnId: 'turn-concurrent-steer' };
    });
    await service.dispatch({
      type: 'sendTurn',
      input: { threadId, input: 'start the turn' },
    });
    await waitFor(
      () => eventStore.listEvents(threadId),
      (events) =>
        events.some(
          (event) =>
            event.payload.method === 'turn.started' &&
            !('inputKind' in event.payload),
        ),
    );

    const principalA = {
      id: 'human:tailscale-serve:alice',
      kind: 'human' as const,
      display: 'Alice',
    };
    const principalB = {
      id: 'human:tailscale-serve:bob',
      kind: 'human' as const,
      display: 'Bob',
    };

    const steerAGate = deferred<void>();
    claude.steerTurn.mockImplementationOnce(async () => {
      await steerAGate.promise;
      claude.events.push({
        eventId: randomUUID(),
        provider: 'claude',
        threadId,
        turnId: 'turn-concurrent-steer',
        createdAt: '2026-08-24T00:00:02.000Z',
        method: 'turn.started',
        prompt: 'from A',
        inputKind: 'steer',
      });
    });

    const dispatchA = service.dispatch(
      { type: 'steerTurn', threadId, input: 'from A' },
      { principal: principalA },
    );
    // Wait until A has actually reached (and is now blocked inside)
    // `adapter.steerTurn` — at that point `begin()` has already succeeded
    // for A's reservation, so B's own `begin()` is guaranteed to observe
    // it in flight rather than racing on unpredictable microtask order.
    await waitFor(
      () => claude.steerTurn.mock.calls.length,
      (calls) => calls === 1,
    );

    const resultB = await service.dispatch(
      { type: 'steerTurn', threadId, input: 'from B' },
      { principal: principalB },
    );
    expect(resultB).toEqual({ outcome: 'concurrent-steer', threadId });
    // B's refusal never touched the adapter at all.
    expect(claude.steerTurn).toHaveBeenCalledTimes(1);

    steerAGate.resolve();
    await expect(dispatchA).resolves.toEqual({
      outcome: 'steered',
      threadId,
      turnId: 'turn-concurrent-steer',
    });

    await waitFor(
      () => eventStore.listEvents(threadId),
      (events) =>
        events.filter((event) => event.payload.method === 'turn.started')
          .length === 2,
    );
    const steerTurnStarted = eventStore
      .listEvents(threadId)
      .map((event) => event.payload)
      .find(
        (event) =>
          event.method === 'turn.started' &&
          (event as { inputKind?: string }).inputKind === 'steer',
      );
    expect(steerTurnStarted?.principal).toEqual(principalA);
    expect(steerTurnStarted?.principal).not.toEqual(principalB);
  });

  test('does not start a provider turn after lifecycle completion wins ownership', async () => {
    await service.dispatch({
      type: 'startSession',
      input: { threadId: 'completed-before-turn', provider: 'claude' },
    });
    await service.sessionLifecycles.transition({
      threadId: 'completed-before-turn',
      to: 'completed',
    });
    claude.sendTurn.mockClear();

    // The refusal is typed (`code: 'session_ended'`) with user-readable
    // prose and a `rejected` receipt: clients render/translate it as a
    // Station-side refusal on an ended session, never as an agent failure.
    await expect(
      service.dispatch({
        type: 'sendTurn',
        input: { threadId: 'completed-before-turn', input: 'Too late' },
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('This session has already ended'),
      code: 'session_ended',
      receipt: expect.objectContaining({ status: 'rejected' }),
    });
    expect(claude.sendTurn).not.toHaveBeenCalled();
  });

  test('retains a durable no-retry boundary when an adapter throws after possible effect', async () => {
    await service.dispatch({
      type: 'startSession',
      input: { threadId: 'ambiguous-turn-start', provider: 'claude' },
    });
    claude.sendTurn.mockImplementationOnce(async () => {
      throw new Error('response connection lost after provider acceptance');
    });

    await expect(
      service.dispatch({
        type: 'sendTurn',
        input: {
          threadId: 'ambiguous-turn-start',
          input: 'Start possible work',
          clientTurnId: 'client-turn-ambiguous',
        },
      }),
    ).rejects.toMatchObject({
      code: 'foreground_message_indeterminate',
      outcome: 'indeterminate',
    });
    expect(
      eventStore
        .sessionTurnBoundaryAuthority()
        .hasPossibleEffect('ambiguous-turn-start'),
    ).toEqual({ kind: 'available', active: true });
    await expect(
      service.sessionLifecycles.transition({
        threadId: 'ambiguous-turn-start',
        to: 'completed',
      }),
    ).rejects.toThrow(/active turn/);
    expect(claude.sendTurn).toHaveBeenCalledOnce();
  });

  /**
   * The coordinator's own test asserts `onOutcome` receives the right
   * classification, and stops there. The mapping from that callback into the
   * emitted event lives in THIS file, and was unpinned: hardcoding
   * `failure_kind: 'unknown'` at the call site passed 232 tests. A telemetry
   * event that reports a constant while a classifier sits right next to it is
   * worse than no event — it answers the question wrongly and confidently.
   */
  test("RECOVERY TELEMETRY DEFECT: the emitted event carries the classifier's verdict, not a constant", () => {
    const telemetry = {
      trackSessionRecovery: vi.fn(),
      trackEngineTurn: vi.fn(),
    };
    service.setUsageTelemetry(telemetry);
    const coordinatorOptions =
      (service as any).recoveryCoordinator?.options ??
      (service as any).recoveryCoordinatorOptions;
    expect(
      coordinatorOptions?.onOutcome,
      'no recovery-coordinator onOutcome hook is reachable from the service — the seam this test exists for has moved',
    ).toBeTypeOf('function');
    coordinatorOptions.onOutcome({
      failureKind: 'rate-limit',
      decision: 'wait-until-reset',
      outcome: 'resumed',
    });
    expect(
      telemetry.trackSessionRecovery,
      'the recovery event dropped the classifier verdict and reported something else',
    ).toHaveBeenCalledWith({
      failure_kind: 'rate-limit',
      decision: 'wait-until-reset',
      outcome: 'resumed',
    });
  });

  test('ENGINE TELEMETRY DEFECT: terminal turn projection records a closed engine and remains fail-open', () => {
    const telemetry = {
      trackSessionRecovery: vi.fn(),
      trackEngineTurn: vi.fn(() => {
        throw new Error('telemetry transport exploded');
      }),
    };
    service.setUsageTelemetry(telemetry);
    expect(() =>
      (service as any).projectAndPublishEvent({
        eventId: 'telemetry-completed',
        provider: 'codex',
        threadId: 'telemetry-thread',
        turnId: 'telemetry-turn',
        createdAt: '2026-08-11T12:00:00.000Z',
        method: 'turn.completed',
        finishReason: 'stop',
      }),
    ).not.toThrow('telemetry transport exploded');
    expect(
      telemetry.trackEngineTurn,
      'engine telemetry did not use terminal turn projection',
    ).toHaveBeenCalledWith({ engine: 'codex', outcome: 'completed' });
    expect(
      eventStore.listEventsForTurn('telemetry-thread', 'telemetry-turn'),
      'terminal event did not persist after telemetry failed',
    ).toHaveLength(1);
  });

  // archive#3451 finding 5: a turn-scoped, non-deferred runtime.error is a
  // genuine terminal outcome for this metric — before this fix it was
  // dropped entirely (neither 'completed' nor 'aborted' matched it).
  test('ENGINE TELEMETRY (station#3451 finding 5): a turn-scoped runtime.error records outcome: failed', () => {
    const telemetry = {
      trackSessionRecovery: vi.fn(),
      trackEngineTurn: vi.fn(),
    };
    service.setUsageTelemetry(telemetry);
    (service as any).projectAndPublishEvent({
      eventId: 'telemetry-failed',
      provider: 'codex',
      threadId: 'telemetry-thread-failed',
      turnId: 'telemetry-turn-failed',
      createdAt: '2026-08-18T12:00:00.000Z',
      method: 'runtime.error',
      severity: 'error',
      message: 'Codex turn failed.',
      retriable: false,
    });
    expect(telemetry.trackEngineTurn).toHaveBeenCalledWith({
      engine: 'codex',
      outcome: 'failed',
    });
  });

  // A codex deferred-retriable runtime.error is NOT a terminal outcome yet —
  // counting it now would either undercount the eventual real terminal or,
  // if a retry loop never resolves, over-attribute a failure that was still
  // retrying.
  test('ENGINE TELEMETRY (station#3451 finding 5): a codex deferred-retriable runtime.error is not counted', () => {
    const telemetry = {
      trackSessionRecovery: vi.fn(),
      trackEngineTurn: vi.fn(),
    };
    service.setUsageTelemetry(telemetry);
    (service as any).projectAndPublishEvent({
      eventId: 'telemetry-deferred',
      provider: 'codex',
      threadId: 'telemetry-thread-deferred',
      turnId: 'telemetry-turn-deferred',
      createdAt: '2026-08-18T12:00:00.000Z',
      method: 'runtime.error',
      severity: 'error',
      message: 'Codex runtime error',
      retriable: true,
    });
    expect(telemetry.trackEngineTurn).not.toHaveBeenCalled();
  });

  test('keeps a native-output grant through a deferred runtime error and retires it at the durable terminal', () => {
    const privateService = service as any;
    const authority = privateService.nativeOutputGrants;
    const grant = authority.issue(
      {
        threadId: 'native-deferred-thread',
        turnId: 'native-deferred-turn',
        adapterId: 'station-agent',
        principal: { ...humanPrincipal('test', 'owner-a', 'Owner A') },
        configurationLease: { revision: 1 },
      },
      { isCurrent: () => true },
    )!;
    const scope = authority.bindNativeCall(grant, 'native-deferred-call')!;
    privateService.nativeOutputTurnGenerations.set(
      'native-deferred-thread',
      'native-deferred-turn',
    );

    privateService.projectAndPublishEvent({
      eventId: 'native-deferred-error',
      provider: 'codex',
      threadId: 'native-deferred-thread',
      turnId: 'native-deferred-turn',
      createdAt: '2026-08-26T00:00:00.000Z',
      method: 'runtime.error',
      severity: 'error',
      message: 'retrying',
      retriable: true,
    });
    expect(authority.admit(scope)).not.toBeNull();

    privateService.projectAndPublishEvent({
      eventId: 'native-deferred-terminal',
      provider: 'codex',
      threadId: 'native-deferred-thread',
      turnId: 'native-deferred-turn',
      createdAt: '2026-08-26T00:00:01.000Z',
      method: 'turn.completed',
      finishReason: 'stop',
    });
    expect(authority.admit(scope)).toBeNull();
  });

  // A runtime.error with no turnId is session-scoped, not turn-scoped — this
  // metric only counts a resolved engine TURN.
  test('ENGINE TELEMETRY (station#3451 finding 5): a runtime.error with no turnId is not counted', () => {
    const telemetry = {
      trackSessionRecovery: vi.fn(),
      trackEngineTurn: vi.fn(),
    };
    service.setUsageTelemetry(telemetry);
    (service as any).projectAndPublishEvent({
      eventId: 'telemetry-no-turn',
      provider: 'claude',
      threadId: 'telemetry-thread-no-turn',
      createdAt: '2026-08-18T12:00:00.000Z',
      method: 'runtime.error',
      severity: 'error',
      message: 'Claude model failed: stream closed',
    });
    expect(telemetry.trackEngineTurn).not.toHaveBeenCalled();
  });

  test('rejects a cross-tenant command before adapter dispatch and persists the bound context', async () => {
    const alpha = { tenantId: 'alpha' as any, source: 'request' as const };
    const bravo = { tenantId: 'bravo' as any, source: 'request' as const };
    const started = await service.dispatchWithReceipt(
      {
        type: 'startSession',
        input: { threadId: 'tenant-bound', provider: 'bedrock' },
      },
      { tenantExecutionContext: alpha },
    );

    await expect(
      service.dispatchWithReceipt(
        {
          type: 'sendTurn',
          input: { threadId: 'tenant-bound', input: 'do not cross tenants' },
        },
        { tenantExecutionContext: bravo },
      ),
    ).rejects.toThrow('Tenant execution context does not match session');
    expect(bedrock.sendTurn).not.toHaveBeenCalled();
    expect(eventStore.readSessions()[0]?.tenantExecutionContext).toEqual(alpha);
    expect(started.result).not.toHaveProperty('tenantExecutionContext');
    expect(JSON.stringify(started.result)).not.toContain(
      'tenantExecutionContext',
    );
    await expect(service.listSessions()).resolves.not.toContainEqual(
      expect.objectContaining({ tenantExecutionContext: expect.anything() }),
    );
  });

  test('enforces direct hosted read authority across tenant, owner, and persisted-binding boundaries', async () => {
    const registry = parseHostedTenantRegistry({
      schemaVersion: 1,
      tenants: [
        { id: 'alpha', authority: 'alpha.station.test' },
        { id: 'bravo', authority: 'bravo.station.test' },
      ],
    });
    const context = (tenantId: 'alpha' | 'bravo') => ({
      tenantId: tenantId as any,
      source: 'request' as const,
    });
    const hosted = new RawOrchestrationService({
      adapterRegistry: createRegistry([bedrock, claude]),
      eventBus,
      eventStore,
      requireTenantExecutionContext: () => true,
      validateRecoveredTenantExecutionContext: (value) =>
        value && registry.tenants.some((tenant) => tenant.id === value.tenantId)
          ? value
          : undefined,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    const alpha = sessionReadAuthorityFromRequest(
      'same-user',
      { tenantId: registry.tenants[0]!.id },
      registry,
    );
    const bravo = sessionReadAuthorityFromRequest(
      'same-user',
      { tenantId: registry.tenants[1]!.id },
      registry,
    );
    const personal = sessionReadAuthorityFromRequest(
      'same-user',
      undefined,
      undefined,
    );
    for (const [threadId, tenant] of [
      ['alpha-thread', 'alpha'],
      ['bravo-thread', 'bravo'],
      ['ownerless-thread', 'alpha'],
    ] as const) {
      const session: ProviderSession = {
        provider: 'bedrock',
        threadId,
        status: 'ready',
        tenantExecutionContext: context(tenant),
        createdAt: '2026-08-08T00:00:00.000Z',
        updatedAt: '2026-08-08T00:00:00.000Z',
      };
      bedrock.sessions.set(threadId, session);
      eventStore.upsertSession(session);
      if (threadId !== 'ownerless-thread') {
        eventStore.appendEvent({
          eventId: `${threadId}-owner`,
          provider: 'bedrock',
          threadId,
          createdAt: '2026-08-08T00:00:00.000Z',
          method: 'session.configured',
          sessionId: threadId,
          metadata: { userId: 'same-user', agentSlug: 'station' },
        } as CanonicalRuntimeEvent);
      }
    }

    await expect(hosted.listSessions(alpha)).resolves.toEqual([
      expect.objectContaining({ threadId: 'alpha-thread' }),
    ]);
    await expect(hosted.readSession('alpha-thread', alpha)).resolves.toEqual(
      expect.objectContaining({
        session: expect.objectContaining({ threadId: 'alpha-thread' }),
      }),
    );
    await expect(
      hosted.listConversationHistoryPage(alpha, { limit: 1 }),
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ id: 'alpha-thread' })],
      hasMore: false,
    });
    await expect(hosted.readSession('bravo-thread', alpha)).resolves.toBeNull();
    await expect(
      hosted.readSession('ownerless-thread', alpha),
    ).resolves.toBeNull();
    await expect(hosted.readSession('alpha-thread', bravo)).resolves.toBeNull();
    await expect(
      hosted.readSession('alpha-thread', personal),
    ).resolves.toBeNull();
    await expect(
      (
        hosted as unknown as {
          listSessions(scope?: unknown): Promise<ProviderSession[]>;
        }
      ).listSessions(),
    ).resolves.toEqual([]);
    expect(() =>
      sessionReadAuthorityFromRequest(
        'same-user',
        { tenantId: 'unknown' as any },
        registry,
      ),
    ).toThrow('Unknown hosted tenant read authority');

    // Completion notification suppression resolves from the completed
    // session's private persisted binding, not its shared owner alone.
    const alphaPresence = hosted.resolveSessionPresenceSubject('alpha-thread');
    const bravoPresence = hosted.resolveSessionPresenceSubject('bravo-thread');
    expect(alphaPresence).toBeDefined();
    expect(bravoPresence).toBeDefined();
    const streamPresence = new OrchestrationStreamPresence();
    const releaseAlpha = streamPresence.connect(alphaPresence!);
    expect(streamPresence.isConnected(alphaPresence!)).toBe(true);
    expect(streamPresence.isConnected(bravoPresence!)).toBe(false);
    releaseAlpha();

    const local = new RawOrchestrationService({
      adapterRegistry: createRegistry([bedrock]),
      eventBus,
      eventStore,
      ownerlessSessionAccess: 'single-user-compat',
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    await expect(
      local.readSession('ownerless-thread', personal),
    ).resolves.toEqual(
      expect.objectContaining({
        session: expect.objectContaining({ threadId: 'ownerless-thread' }),
      }),
    );
  });

  test('resolves a personal ownerless session to the any-personal presence subject (slice 6 I10 guard)', () => {
    // The personal fallback branch of `resolveSessionPresenceSubject` — a
    // session with no recorded owner in a non-hosted deployment falls back
    // to the any-personal subject rather than resolving no subject at all.
    // Before this fixture, deleting the fallback ran the whole suite green:
    // the hosted test above only exercises tenant-bound subjects.
    const threadId = 'ownerless-presence-thread';
    eventStore.upsertSession({
      provider: 'bedrock',
      threadId,
      status: 'ready',
      createdAt: '2026-08-08T00:00:00.000Z',
      updatedAt: '2026-08-08T00:00:00.000Z',
    });
    const subject = service.resolveSessionPresenceSubject(threadId);
    expect(subject).toEqual(anyPersonalOrchestrationStreamPresenceSubject());
  });

  test('a freshly constructed hosted service authorizes a persisted tenant-bound command before any other call (slice 6 I11 guard)', async () => {
    // `canReadSessionForCommand` hydrates persisted tenant contexts BEFORE
    // its first authorization decision (its own comment: a freshly
    // constructed service must not mistake a valid persisted source for an
    // unbound one). Every other hosted fixture warms the service first, so
    // removing the hydrate ran green — this dispatch is the instance's
    // very first call, and without hydration the RIGHT caller reads
    // `Session not found:`.
    const threadId = 'cold-hosted-command-thread';
    const alpha = { tenantId: 'alpha' as any, source: 'request' as const };
    const session: ProviderSession = {
      provider: 'bedrock',
      threadId,
      status: 'ready',
      tenantExecutionContext: alpha,
      createdAt: '2026-08-08T00:00:00.000Z',
      updatedAt: '2026-08-08T00:00:00.000Z',
    };
    eventStore.upsertSession(session);
    eventStore.appendEvent({
      eventId: `${threadId}-owner`,
      provider: 'bedrock',
      threadId,
      createdAt: '2026-08-08T00:00:00.000Z',
      method: 'session.configured',
      sessionId: threadId,
      metadata: { userId: 'same-user', agentSlug: 'station' },
    } as CanonicalRuntimeEvent);
    const cold = new RawOrchestrationService({
      adapterRegistry: createRegistry([bedrock]),
      eventBus,
      eventStore,
      requireTenantExecutionContext: () => true,
      validateRecoveredTenantExecutionContext: (value) => value,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    const outcome = await cold
      .dispatchWithReceipt(
        { type: 'stopSession', threadId },
        { userId: 'same-user', tenantExecutionContext: alpha },
      )
      .then(
        () => 'resolved',
        (error: unknown) =>
          error instanceof Error ? error.message : String(error),
      );
    // Authorization must pass for the rightful caller; whatever stopSession
    // does next, it must NOT be the authz rejection.
    expect(outcome).toBe('resolved');
  });

  test('retains a command-established tenant binding across tenantless adapter list and refresh projections', async () => {
    const registry = parseHostedTenantRegistry({
      schemaVersion: 1,
      tenants: [
        { id: 'alpha', authority: 'alpha.station.test' },
        { id: 'bravo', authority: 'bravo.station.test' },
      ],
    });
    const hosted = new RawOrchestrationService({
      adapterRegistry: createRegistry([bedrock]),
      eventBus,
      eventStore,
      requireTenantExecutionContext: () => true,
      validateRecoveredTenantExecutionContext: (value) =>
        value && registry.tenants.some((tenant) => tenant.id === value.tenantId)
          ? value
          : undefined,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    const alpha = sessionReadAuthorityFromRequest(
      'shared-user',
      { tenantId: registry.tenants[0]!.id },
      registry,
    );
    const bravo = sessionReadAuthorityFromRequest(
      'shared-user',
      { tenantId: registry.tenants[1]!.id },
      registry,
    );
    const bound: ProviderSession = {
      provider: 'bedrock',
      threadId: 'adapter-refresh-bound',
      status: 'ready',
      tenantExecutionContext: {
        tenantId: registry.tenants[0]!.id,
        source: 'session',
      },
      createdAt: '2026-08-08T00:00:00.000Z',
      updatedAt: '2026-08-08T00:00:00.000Z',
    };
    bedrock.sessions.set(bound.threadId, bound);
    eventStore.upsertSession(bound);
    eventStore.appendEvent({
      eventId: 'adapter-refresh-owner',
      provider: 'bedrock',
      threadId: bound.threadId,
      createdAt: bound.createdAt,
      method: 'session.configured',
      sessionId: bound.threadId,
      metadata: { userId: 'shared-user' },
    } as CanonicalRuntimeEvent);

    // First observation establishes the private persisted binding. Real
    // adapters then commonly return a fresh inventory projection without
    // Station's private tenant field on subsequent list/refresh calls.
    await expect(hosted.listSessions(alpha)).resolves.toEqual([
      expect.objectContaining({ threadId: bound.threadId }),
    ]);
    bedrock.sessions.set(bound.threadId, {
      provider: 'bedrock',
      threadId: bound.threadId,
      status: 'ready',
      createdAt: bound.createdAt,
      updatedAt: '2026-08-08T00:01:00.000Z',
    });

    await expect(hosted.listProviders(alpha)).resolves.toEqual([
      expect.objectContaining({ provider: 'bedrock', activeSessions: 1 }),
    ]);
    await expect(hosted.listSessions(alpha)).resolves.toEqual([
      expect.objectContaining({ threadId: bound.threadId }),
    ]);
    expect(hosted.canUserReadSession(bound.threadId, alpha)).toBe(true);
    expect(hosted.canUserReadSession(bound.threadId, bravo)).toBe(false);
  });

  /**
   * archive#4075 stage 2 review round 3 (the ruling's composition
   * question): does the EXISTING hosted `canReadSession` predicate
   * (tenant match via the private binding index, AND an exact owner-id
   * match) compose correctly with `tenant:<id>` as a possible OWNER value,
   * with NO code change to the predicate itself? Both directions, same
   * tenant: an unidentified caller (principal `tenant:alpha`) reads a
   * session THAT SAME unidentified attribution owns; the SAME caller is
   * refused a session owned by an IDENTIFIED human in the identical
   * tenant. `PrincipalRef`'s kind-prefixed grammar makes `tenant:alpha`
   * and `human:tailscale-serve:alice` collision-free by construction, so
   * the pre-existing exact-owner-match conjunct partitions them with no
   * special-casing.
   */
  test('an unidentified hosted caller (tenant principal) reads a tenant-owned session but not a human-owned one in the SAME tenant', async () => {
    const registry = parseHostedTenantRegistry({
      schemaVersion: 1,
      tenants: [{ id: 'alpha', authority: 'alpha.station.test' }],
    });
    const hosted = new RawOrchestrationService({
      adapterRegistry: createRegistry([bedrock]),
      eventBus,
      eventStore,
      requireTenantExecutionContext: () => true,
      validateRecoveredTenantExecutionContext: (value) =>
        value && registry.tenants.some((tenant) => tenant.id === value.tenantId)
          ? value
          : undefined,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    const unidentifiedCaller = sessionReadAuthorityFromRequest(
      'tenant:alpha',
      { tenantId: registry.tenants[0]!.id },
      registry,
    );

    const tenantOwnedSession: ProviderSession = {
      provider: 'bedrock',
      threadId: 'tenant-owned-session',
      status: 'ready',
      tenantExecutionContext: {
        tenantId: registry.tenants[0]!.id,
        source: 'session',
      },
      createdAt: '2026-08-25T00:00:00.000Z',
      updatedAt: '2026-08-25T00:00:00.000Z',
    };
    bedrock.sessions.set(tenantOwnedSession.threadId, tenantOwnedSession);
    eventStore.upsertSession(tenantOwnedSession);
    eventStore.appendEvent({
      eventId: 'tenant-owned-owner',
      provider: 'bedrock',
      threadId: tenantOwnedSession.threadId,
      createdAt: tenantOwnedSession.createdAt,
      method: 'session.configured',
      sessionId: tenantOwnedSession.threadId,
      metadata: { userId: 'tenant:alpha' },
    } as CanonicalRuntimeEvent);

    const humanOwnedSession: ProviderSession = {
      provider: 'bedrock',
      threadId: 'human-owned-session',
      status: 'ready',
      tenantExecutionContext: {
        tenantId: registry.tenants[0]!.id,
        source: 'session',
      },
      createdAt: '2026-08-25T00:00:01.000Z',
      updatedAt: '2026-08-25T00:00:01.000Z',
    };
    bedrock.sessions.set(humanOwnedSession.threadId, humanOwnedSession);
    eventStore.upsertSession(humanOwnedSession);
    eventStore.appendEvent({
      eventId: 'human-owned-owner',
      provider: 'bedrock',
      threadId: humanOwnedSession.threadId,
      createdAt: humanOwnedSession.createdAt,
      method: 'session.configured',
      sessionId: humanOwnedSession.threadId,
      metadata: { userId: 'human:tailscale-serve:alice' },
    } as CanonicalRuntimeEvent);

    // `canReadSession`'s hosted branch checks the PRIVATE tenant-binding
    // index (`SessionAuthorization.tenantContexts`), populated only by
    // `trackSession` (called from `listSessions`/adapter refresh) or event-
    // store hydration — never by `upsertSession` alone. Mirrors the
    // proven "retains a command-established tenant binding..." test above.
    await hosted.listSessions(unidentifiedCaller);

    // Direction 1: the unidentified caller reads what it (collectively,
    // as the tenant) owns.
    expect(
      hosted.canUserReadSession(
        tenantOwnedSession.threadId,
        unidentifiedCaller,
      ),
    ).toBe(true);
    // Direction 2: the SAME unidentified caller, SAME tenant, is refused a
    // session an IDENTIFIED human in that tenant owns — the tenant-match
    // conjunct alone is not enough; the owner-id conjunct still applies.
    expect(
      hosted.canUserReadSession(humanOwnedSession.threadId, unidentifiedCaller),
    ).toBe(false);
  });

  test('quarantines an invalid read-only attached hosted row before tracking or provider recovery', async () => {
    const attached: ProviderSession = {
      provider: 'claude',
      threadId: 'invalid-attached-recovery',
      status: 'ready',
      controlMode: 'read-only-attached',
      attachedSource: {
        kind: 'claude-transcript',
        externalSessionId: 'invalid',
      },
      createdAt: '2026-08-08T00:00:00.000Z',
      updatedAt: '2026-08-08T00:00:00.000Z',
    };
    eventStore.upsertSession(attached);
    const trackSession = vi.fn();
    const quarantineSession = vi.fn();
    await recoverOrchestrationSessions({
      adapterRegistry: createRegistry([claude]),
      eventStore,
      trackSession,
      requireTenantExecutionContext: () => true,
      validateRecoveredTenantExecutionContext: () => undefined,
      quarantineSession,
      logger: { warn: vi.fn() },
    });
    expect(trackSession).not.toHaveBeenCalled();
    expect(quarantineSession).toHaveBeenCalledWith(attached);
    expect(claude.startSession).not.toHaveBeenCalled();
    expect(
      eventStore
        .readSessions()
        .find((session) => session.threadId === attached.threadId)?.status,
    ).toBe('closed');
  });

  test('emits closed, content-free start, continuation, and mismatch telemetry', async () => {
    const alpha = { tenantId: 'alpha' as any, source: 'request' as const };
    await service.dispatch(
      {
        type: 'startSession',
        input: { threadId: 'tenant-telemetry', provider: 'bedrock' },
      },
      { tenantExecutionContext: alpha },
    );
    await service.dispatch(
      {
        type: 'sendTurn',
        input: { threadId: 'tenant-telemetry', input: 'continue' },
      },
      { tenantExecutionContext: alpha },
    );
    await expect(
      service.dispatch(
        {
          type: 'sendTurn',
          input: { threadId: 'tenant-telemetry', input: 'reject' },
        },
        {
          tenantExecutionContext: {
            tenantId: 'bravo' as any,
            source: 'request',
          },
        },
      ),
    ).rejects.toThrow('Tenant execution context does not match session');

    const attributes = (
      tenantExecutionContextOutcomes.add as any
    ).mock.calls.map((call: unknown[]) => call[1]);
    expect(attributes).toEqual(
      expect.arrayContaining([
        {
          operation: 'start',
          source: 'request',
          outcome: 'accepted',
          reason: 'none',
        },
        {
          operation: 'continue',
          source: 'session',
          outcome: 'accepted',
          reason: 'none',
        },
        {
          operation: 'dispatch',
          source: 'session',
          outcome: 'rejected',
          reason: 'mismatch',
        },
      ]),
    );
    for (const value of attributes) {
      expect(Object.keys(value).sort()).toEqual([
        'operation',
        'outcome',
        'reason',
        'source',
      ]);
    }
  });

  test('classifies provider lifecycle background notifications as aggregate-safe without tenant authority', () => {
    (
      service as unknown as {
        projectAndPublishEvent(event: CanonicalRuntimeEvent): boolean;
      }
    ).projectAndPublishEvent({
      eventId: 'background-aggregate-safe',
      provider: 'claude',
      threadId: 'thread-not-authority',
      createdAt: new Date().toISOString(),
      method: 'extension.notification',
      namespace: 'provider',
      type: 'task/settled',
      payload: { status: 'completed' },
    });

    expect(tenantExecutionContextOutcomes.add).toHaveBeenCalledWith(1, {
      operation: 'background',
      source: 'aggregate',
      outcome: 'skipped',
      reason: 'aggregate_safe',
    });
  });

  test('fails closed for hosted starts without a server-owned tenant context', async () => {
    const hosted = new OrchestrationService({
      adapterRegistry: createRegistry([bedrock]),
      eventBus,
      eventStore,
      requireTenantExecutionContext: () => true,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });

    await expect(
      hosted.dispatch({
        type: 'startSession',
        input: { threadId: 'unbound-hosted-start', provider: 'bedrock' },
      }),
    ).rejects.toThrow('Tenant execution context is required');
    expect(bedrock.startSession).not.toHaveBeenCalled();
  });

  test('derives a forced cooperative-stop outcome at the budget boundary, retains the transcript, and cannot be caller-labelled', async () => {
    vi.useFakeTimers();
    try {
      const bounded = new OrchestrationService({
        adapterRegistry: createRegistry([claude]),
        eventBus,
        eventStore,
        cooperativeStopBudgetMs: 25,
        logger: { debug: vi.fn(), warn: vi.fn() },
      });
      const threadId = 'cooperative-stop-budget';
      await bounded.dispatch({
        type: 'startSession',
        input: { threadId, provider: 'claude' },
      });
      eventStore.appendEvent({
        eventId: 'cooperative-stop-started',
        provider: 'claude',
        threadId,
        turnId: 'turn-budget',
        createdAt: new Date().toISOString(),
        method: 'turn.started',
        prompt: 'write a receipt',
      });
      eventStore.appendEvent({
        eventId: 'cooperative-stop-partial',
        provider: 'claude',
        threadId,
        turnId: 'turn-budget',
        itemId: 'text-1',
        createdAt: new Date().toISOString(),
        method: 'content.text-delta',
        delta: 'partial receipt',
      });
      claude.interruptTurn.mockImplementationOnce(() => new Promise(() => {}));

      // The public command has no outcome field. Even a JavaScript caller
      // adding one cannot affect the race-derived event below.
      const first = bounded.dispatch({
        type: 'interruptTurn',
        threadId,
        outcome: 'cooperative',
      } as any);
      await vi.advanceTimersByTimeAsync(0);
      expect(claude.interruptTurn).toHaveBeenCalledOnce();
      const second = bounded.dispatch({ type: 'interruptTurn', threadId });

      await vi.advanceTimersByTimeAsync(24);
      expect(claude.stopSession).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await Promise.all([first, second]);

      expect(claude.stopSession).toHaveBeenCalledOnce();
      expect(
        eventStore
          .listEvents(threadId)
          .map((event) => event.payload)
          .filter((event) => event.method === 'session.stop-settled'),
      ).toEqual([
        expect.objectContaining({
          turnId: 'turn-budget',
          outcome: 'forced',
        }),
      ]);
      expect(
        eventStore
          .listEvents(threadId)
          .map((event) => event.payload)
          .filter((event) => event.method === 'runtime.error'),
      ).toEqual([]);
      expect(eventStore.readSessionByThread(threadId)).toEqual(
        expect.objectContaining({ status: 'ready' }),
      );
      expect(JSON.stringify(bounded.readSessionMessages(threadId))).toContain(
        'partial receipt',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test('recovery cancellation directly targets an unpersisted recovered turn without the user Stop budget', async () => {
    const recoveryService = new OrchestrationService({
      adapterRegistry: createRegistry([claude]),
      eventBus,
      eventStore,
      // A recovery cancel must not wait on this user-facing timeout.
      cooperativeStopBudgetMs: 60_000,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    const threadId = 'recovery-unpersisted-turn';
    await recoveryService.dispatch({
      type: 'startSession',
      input: { threadId, provider: 'claude' },
    });
    expect(
      eventStore
        .listEvents(threadId)
        .some((event) => event.payload.method === 'turn.started'),
    ).toBe(false);

    const recoveryDispatch = (
      recoveryService as unknown as {
        createRecoveryDispatchAdapter(): {
          interrupt?: (input: {
            threadId: string;
            turnId: string;
          }) => Promise<void>;
        };
      }
    ).createRecoveryDispatchAdapter();
    await recoveryDispatch.interrupt?.({
      threadId,
      turnId: 'recovered-turn-not-yet-persisted',
    });

    expect(claude.interruptTurn).toHaveBeenCalledWith(
      threadId,
      'recovered-turn-not-yet-persisted',
    );
    expect(claude.stopSession).not.toHaveBeenCalled();
  });

  test('records cooperative only when the engine acknowledgement settles before the budget, never hard-killing the session', async () => {
    vi.useFakeTimers();
    try {
      const bounded = new OrchestrationService({
        adapterRegistry: createRegistry([claude]),
        eventBus,
        eventStore,
        cooperativeStopBudgetMs: 25,
        logger: { debug: vi.fn(), warn: vi.fn() },
      });
      const threadId = 'cooperative-stop-acknowledged';
      await bounded.dispatch({
        type: 'startSession',
        input: { threadId, provider: 'claude' },
      });
      eventStore.appendEvent({
        eventId: 'cooperative-stop-ack-started',
        provider: 'claude',
        threadId,
        turnId: 'turn-ack',
        createdAt: new Date().toISOString(),
        method: 'turn.started',
        prompt: 'cancel me',
      });
      const acknowledgement = deferred<ProviderInterruptTurnResult>();
      claude.interruptTurn.mockImplementationOnce(
        () => acknowledgement.promise,
      );

      const stop = bounded.dispatch({ type: 'interruptTurn', threadId });
      acknowledgement.resolve({ outcome: 'cancelled', turnId: 'turn-ack' });
      await stop;
      await vi.advanceTimersByTimeAsync(25);

      expect(claude.stopSession).not.toHaveBeenCalled();
      expect(
        eventStore
          .listEvents(threadId)
          .map((event) => event.payload)
          .filter((event) => event.method === 'session.stop-settled'),
      ).toEqual([
        expect.objectContaining({ outcome: 'cooperative', turnId: 'turn-ack' }),
      ]);
      expect(
        eventStore
          .listEvents(threadId)
          .some((event) => event.payload.method === 'runtime.error'),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // UX audit T1: the settlement the two tests above assert as an EVENT is
  // also what the interrupt command now RETURNS. The composer had no way to
  // tell a cooperative stop (session resumable, engine process deliberately
  // kept warm) from a forced one (process torn down), so it announced "User
  // canceled the ongoing request" for both — a sentence describing the click,
  // not the outcome. These pin the returned derivation.
  test('the interrupt command returns the outcome the stop settled as', async () => {
    vi.useFakeTimers();
    try {
      const bounded = new OrchestrationService({
        adapterRegistry: createRegistry([claude]),
        eventBus,
        eventStore,
        cooperativeStopBudgetMs: 25,
        logger: { debug: vi.fn(), warn: vi.fn() },
      });
      const threadId = 'interrupt-result-cooperative';
      await bounded.dispatch({
        type: 'startSession',
        input: { threadId, provider: 'claude' },
      });
      eventStore.appendEvent({
        eventId: 'interrupt-result-ack-started',
        provider: 'claude',
        threadId,
        turnId: 'turn-ack-result',
        createdAt: new Date().toISOString(),
        method: 'turn.started',
        prompt: 'cancel me',
      });
      const acknowledgement = deferred<ProviderInterruptTurnResult>();
      claude.interruptTurn.mockImplementationOnce(
        () => acknowledgement.promise,
      );

      const stop = bounded.dispatch({ type: 'interruptTurn', threadId });
      acknowledgement.resolve({
        outcome: 'cancelled',
        turnId: 'turn-ack-result',
      });
      expect(await stop).toEqual({
        outcome: 'cooperative',
        threadId,
        turnId: 'turn-ack-result',
      });
      expect(claude.stopSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test('a forced stop returns forced, and a coalesced second press returns the same outcome once', async () => {
    vi.useFakeTimers();
    try {
      const bounded = new OrchestrationService({
        adapterRegistry: createRegistry([claude]),
        eventBus,
        eventStore,
        cooperativeStopBudgetMs: 25,
        logger: { debug: vi.fn(), warn: vi.fn() },
      });
      const threadId = 'interrupt-result-forced';
      await bounded.dispatch({
        type: 'startSession',
        input: { threadId, provider: 'claude' },
      });
      eventStore.appendEvent({
        eventId: 'interrupt-result-forced-started',
        provider: 'claude',
        threadId,
        turnId: 'turn-forced-result',
        createdAt: new Date().toISOString(),
        method: 'turn.started',
        prompt: 'cancel me',
      });
      claude.interruptTurn.mockImplementationOnce(() => new Promise(() => {}));

      const first = bounded.dispatch({ type: 'interruptTurn', threadId });
      await vi.advanceTimersByTimeAsync(0);
      // The double-press case: the second command rides the first task and
      // must report the SAME outcome rather than a second, different label.
      const second = bounded.dispatch({ type: 'interruptTurn', threadId });
      await vi.advanceTimersByTimeAsync(25);
      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(firstResult).toEqual({
        outcome: 'forced',
        threadId,
        turnId: 'turn-forced-result',
      });
      expect(secondResult).toEqual(firstResult);
      expect(claude.interruptTurn).toHaveBeenCalledOnce();
      expect(claude.stopSession).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  // UX audit T1 (live verification): a Stop pressed between "the turn was
  // dispatched" and "the engine session exists" was refused outright with
  // `No provider session found for thread` — and that window covered every
  // real press. The cancel is now recorded and applied to the turn the moment
  // it starts.
  test('an interrupt before the engine session exists is recorded and applied to the turn that starts', async () => {
    vi.useFakeTimers();
    try {
      const pending = new OrchestrationService({
        adapterRegistry: createRegistry([claude]),
        eventBus,
        eventStore,
        cooperativeStopBudgetMs: 25,
        logger: { debug: vi.fn(), warn: vi.fn() },
      });
      const threadId = 'interrupt-before-session';

      // No startSession has run for this thread: `hasSession` is false, which
      // is exactly the state that used to throw.
      expect(
        await pending.dispatch({ type: 'interruptTurn', threadId }),
      ).toEqual({ outcome: 'pending-turn-start', threadId });
      expect(claude.interruptTurn).not.toHaveBeenCalled();

      // Now the engine comes up and starts the turn the user already stopped.
      await pending.dispatch({
        type: 'startSession',
        input: { threadId, provider: 'claude' },
      });
      claude.events.push({
        eventId: 'interrupt-before-session-started',
        provider: 'claude',
        threadId,
        turnId: 'turn-late',
        createdAt: new Date().toISOString(),
        method: 'turn.started',
        prompt: 'count to forty',
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      expect(claude.interruptTurn).toHaveBeenCalledWith(threadId, 'turn-late');
    } finally {
      vi.useRealTimers();
    }
  });

  // UX audit T1 review (MEDIUM): keyed on the thread alone, a cancel whose
  // intended turn never started stayed armed for the whole TTL and would
  // interrupt whatever turn started next. Correlated by the dispatch key, it
  // can only ever reach the turn its own dispatch produced.
  test('a deferred cancel for one dispatch does not interrupt a different turn', async () => {
    vi.useFakeTimers();
    try {
      const pending = new OrchestrationService({
        adapterRegistry: createRegistry([claude]),
        eventBus,
        eventStore,
        cooperativeStopBudgetMs: 25,
        logger: { debug: vi.fn(), warn: vi.fn() },
      });
      const threadId = 'interrupt-correlated';

      expect(
        await pending.dispatch({
          type: 'interruptTurn',
          threadId,
          clientTurnId: 'dispatch-X',
        }),
      ).toEqual({ outcome: 'pending-turn-start', threadId });

      await pending.dispatch({
        type: 'startSession',
        input: { threadId, provider: 'claude' },
      });
      // A turn from a DIFFERENT dispatch starts first.
      claude.events.push({
        eventId: 'interrupt-correlated-other',
        provider: 'claude',
        threadId,
        turnId: 'turn-from-Y',
        createdAt: new Date().toISOString(),
        method: 'turn.started',
        prompt: 'someone else',
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      expect(claude.interruptTurn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test('a deferred cancel is bound to the turn its own dispatch produced', async () => {
    vi.useFakeTimers();
    try {
      const pending = new OrchestrationService({
        adapterRegistry: createRegistry([claude]),
        eventBus,
        eventStore,
        cooperativeStopBudgetMs: 25,
        logger: { debug: vi.fn(), warn: vi.fn() },
      });
      const threadId = 'interrupt-correlated-bound';
      // The live ordering: Stop is pressed while the engine session for this
      // thread does not exist yet, so the cancel is held.
      expect(
        await pending.dispatch({
          type: 'interruptTurn',
          threadId,
          clientTurnId: 'dispatch-X',
        }),
      ).toEqual({ outcome: 'pending-turn-start', threadId });

      await pending.dispatch({
        type: 'startSession',
        input: { threadId, provider: 'claude' },
      });
      claude.sendTurn.mockResolvedValueOnce({
        threadId,
        turnId: 'turn-from-X',
      });
      await pending.dispatch({
        type: 'sendTurn',
        input: { threadId, input: 'go', clientTurnId: 'dispatch-X' },
      });
      claude.events.push({
        eventId: 'interrupt-correlated-bound-started',
        provider: 'claude',
        threadId,
        turnId: 'turn-from-X',
        createdAt: new Date().toISOString(),
        method: 'turn.started',
        prompt: 'go',
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      expect(claude.interruptTurn).toHaveBeenCalledWith(
        threadId,
        'turn-from-X',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  // UX audit T1 review round 3 (HIGH): the ordering real adapters use. Claude
  // and ACP publish `turn.started` BEFORE `sendTurn` returns its id, so the
  // event-driven apply sees the start with no binding yet and correctly stands
  // down — and nothing re-applied when the binding arrived, so the intended
  // turn ran on despite Station having said it would be interrupted. Real
  // timers here on purpose: the point is the interleaving of the adapter's
  // stream with its own `sendTurn` resolution.
  test('a deferred cancel still lands when turn.started arrives before the dispatch binds', async () => {
    const started = new OrchestrationService({
      adapterRegistry: createRegistry([claude]),
      eventBus,
      eventStore,
      cooperativeStopBudgetMs: 25,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    const threadId = 'interrupt-start-before-bind';

    expect(
      await started.dispatch({
        type: 'interruptTurn',
        threadId,
        clientTurnId: 'dispatch-X',
      }),
    ).toEqual({ outcome: 'pending-turn-start', threadId });

    await started.dispatch({
      type: 'startSession',
      input: { threadId, provider: 'claude' },
    });

    claude.sendTurn.mockImplementationOnce(async (input) => {
      // The adapter's own ordering: the stream announces the turn first.
      claude.events.push({
        eventId: 'interrupt-start-before-bind-started',
        provider: 'claude',
        threadId: input.threadId,
        turnId: 'turn-from-X',
        createdAt: new Date().toISOString(),
        method: 'turn.started',
        prompt: 'go',
      });
      // Let `consumeAdapterEvents` project it before this call resolves.
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { threadId: input.threadId, turnId: 'turn-from-X' };
    });

    await started.dispatch({
      type: 'sendTurn',
      input: { threadId, input: 'go', clientTurnId: 'dispatch-X' },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(claude.interruptTurn).toHaveBeenCalledWith(threadId, 'turn-from-X');
  });

  // The wait has to be bounded by something other than luck: the TTL used to
  // be checked only when some later event happened to invoke the fold, so a
  // dispatch that never settled on a thread that went quiet left the cancel
  // armed indefinitely.
  test('a held cancel whose dispatch never settles is cleared at its TTL with no further events', async () => {
    vi.useFakeTimers();
    try {
      const abandoned = new OrchestrationService({
        adapterRegistry: createRegistry([claude]),
        eventBus,
        eventStore,
        cooperativeStopBudgetMs: 25,
        logger: { debug: vi.fn(), warn: vi.fn() },
      });
      const threadId = 'interrupt-never-settles';
      // Slice 10 moved the map into CooperativeStop (one-way); the TTL pin
      // reaches it through the collaborator, slice-6 SeamInternals style.
      const held = (
        abandoned as unknown as {
          cooperativeStop: { pendingTurnInterrupts: Map<string, unknown> };
        }
      ).cooperativeStop.pendingTurnInterrupts;

      await abandoned.dispatch({
        type: 'interruptTurn',
        threadId,
        clientTurnId: 'dispatch-never',
      });
      expect(held.has(threadId)).toBe(true);

      await vi.advanceTimersByTimeAsync(PENDING_TURN_INTERRUPT_TTL_MS + 10);

      expect(held.has(threadId)).toBe(false);
      expect(claude.interruptTurn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test('an interrupt with nothing running reports no-active-turn rather than a stop', async () => {
    const idle = new OrchestrationService({
      adapterRegistry: createRegistry([claude]),
      eventBus,
      eventStore,
      cooperativeStopBudgetMs: 25,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    const threadId = 'interrupt-result-idle';
    await idle.dispatch({
      type: 'startSession',
      input: { threadId, provider: 'claude' },
    });

    expect(await idle.dispatch({ type: 'interruptTurn', threadId })).toEqual({
      outcome: 'no-active-turn',
      threadId,
    });
    expect(claude.interruptTurn).not.toHaveBeenCalled();
  });

  test.each([
    ['no active adapter turn', undefined],
    ['adapter target mismatch', 'adapter-turn-other'],
  ])(
    'does not label a fulfilled interrupt %s as cooperative',
    async (_caseName, adapterTurnId) => {
      vi.useFakeTimers();
      try {
        const targetAware = new TargetAwareInterruptAdapter(
          'claude',
          adapterTurnId,
        );
        const bounded = new OrchestrationService({
          adapterRegistry: createRegistry([targetAware]),
          eventBus,
          eventStore,
          cooperativeStopBudgetMs: 25,
          logger: { debug: vi.fn(), warn: vi.fn() },
        });
        const threadId = `cooperative-stop-${adapterTurnId ?? 'none'}`;
        await bounded.dispatch({
          type: 'startSession',
          input: { threadId, provider: 'claude' },
        });
        eventStore.appendEvent({
          eventId: `${threadId}-started`,
          provider: 'claude',
          threadId,
          turnId: 'station-turn',
          createdAt: new Date().toISOString(),
          method: 'turn.started',
          prompt: 'cancel me',
        });

        const stop = bounded.dispatch({ type: 'interruptTurn', threadId });
        await vi.advanceTimersByTimeAsync(25);
        await stop;

        expect(targetAware.stopSession).toHaveBeenCalledWith(threadId);
        expect(
          eventStore
            .listEvents(threadId)
            .map((event) => event.payload)
            .filter((event) => event.method === 'session.stop-settled'),
        ).toEqual([
          expect.objectContaining({
            outcome: 'forced',
            turnId: 'station-turn',
          }),
        ]);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  test('does not target a completed turn on a sequential second Stop task', async () => {
    const bounded = new OrchestrationService({
      adapterRegistry: createRegistry([claude]),
      eventBus,
      eventStore,
      cooperativeStopBudgetMs: 25,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    const threadId = 'cooperative-stop-sequential';
    await bounded.dispatch({
      type: 'startSession',
      input: { threadId, provider: 'claude' },
    });
    eventStore.appendEvent({
      eventId: 'sequential-started',
      provider: 'claude',
      threadId,
      turnId: 'turn-sequential',
      createdAt: new Date().toISOString(),
      method: 'turn.started',
      prompt: 'cancel me',
    });
    claude.interruptTurn.mockImplementationOnce(async () => {
      eventStore.appendEvent({
        eventId: 'sequential-aborted',
        provider: 'claude',
        threadId,
        turnId: 'turn-sequential',
        createdAt: new Date().toISOString(),
        method: 'turn.aborted',
        reason: 'interrupted',
      });
      return { outcome: 'cancelled', turnId: 'turn-sequential' };
    });

    await bounded.dispatch({ type: 'interruptTurn', threadId });
    await bounded.dispatch({ type: 'interruptTurn', threadId });

    expect(claude.interruptTurn).toHaveBeenCalledTimes(1);
    expect(
      eventStore
        .listEvents(threadId)
        .map((event) => event.payload)
        .filter((event) => event.method === 'session.stop-settled'),
    ).toEqual([expect.objectContaining({ outcome: 'cooperative' })]);
  });

  test('keeps a naturally completed turn normal when it settles during cooperative-stop waiting', async () => {
    const bounded = new OrchestrationService({
      adapterRegistry: createRegistry([claude]),
      eventBus,
      eventStore,
      cooperativeStopBudgetMs: 50,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    const threadId = 'cooperative-stop-natural-completion';
    await bounded.dispatch({
      type: 'startSession',
      input: { threadId, provider: 'claude' },
    });
    eventStore.appendEvent({
      eventId: 'cooperative-stop-natural-started',
      provider: 'claude',
      threadId,
      turnId: 'turn-natural',
      createdAt: new Date().toISOString(),
      method: 'turn.started',
      prompt: 'finish normally',
    });
    const acknowledgement = deferred<ProviderInterruptTurnResult>();
    claude.interruptTurn.mockImplementationOnce(() => acknowledgement.promise);
    bounded.initialize();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const stop = bounded.dispatch({ type: 'interruptTurn', threadId });
    await vi.waitFor(() => expect(claude.interruptTurn).toHaveBeenCalledOnce());
    claude.events.push({
      eventId: 'cooperative-stop-natural-completed',
      provider: 'claude',
      threadId,
      turnId: 'turn-natural',
      createdAt: new Date().toISOString(),
      method: 'turn.completed',
      finishReason: 'stop',
      outputText: 'completed normally',
    });
    await stop;
    acknowledgement.resolve({ outcome: 'cancelled', turnId: 'turn-natural' });

    expect(claude.stopSession).not.toHaveBeenCalled();
    expect(
      eventStore
        .listEvents(threadId)
        .map((event) => event.payload)
        .some((event) => event.method === 'session.stop-settled'),
    ).toBe(false);
    expect(
      eventStore
        .listEvents(threadId)
        .map((event) => event.payload)
        .filter((event) => event.method === 'turn.completed'),
    ).toEqual([expect.objectContaining({ turnId: 'turn-natural' })]);
    await bounded.shutdown();
  });

  test("a quarantined thread's in-flight cooperative stop still settles as turn-completed (slice 10 I2 guard)", async () => {
    // The behavioral complement of the settle-order source invariant: no
    // prior fixture combined quarantine with an in-flight stop, so moving
    // the settle-read below the quarantine gate was suite-green. Here the
    // gate declines the turn.completed (quarantined thread), and the stop
    // must STILL settle as turn-completed rather than riding its budget
    // into a forced teardown of an already-finished turn.
    const bounded = new OrchestrationService({
      adapterRegistry: createRegistry([claude]),
      eventBus,
      eventStore,
      // Wide real-timer budget: this guard must not flake into a forced
      // teardown on a loaded host before the completion event lands.
      cooperativeStopBudgetMs: 2_000,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    const threadId = 'cooperative-stop-quarantined-settle';
    await bounded.dispatch({
      type: 'startSession',
      input: { threadId, provider: 'claude' },
    });
    eventStore.appendEvent({
      eventId: 'quarantined-settle-started',
      provider: 'claude',
      threadId,
      turnId: 'turn-quarantined',
      createdAt: new Date().toISOString(),
      method: 'turn.started',
      prompt: 'finish while quarantined',
    });
    const acknowledgement = deferred<ProviderInterruptTurnResult>();
    claude.interruptTurn.mockImplementationOnce(() => acknowledgement.promise);
    bounded.initialize();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const stop = bounded.dispatch({ type: 'interruptTurn', threadId });
    await vi.waitFor(() => expect(claude.interruptTurn).toHaveBeenCalledOnce());
    (
      bounded as unknown as { quarantinedThreads: Set<string> }
    ).quarantinedThreads.add(threadId);
    claude.events.push({
      eventId: 'quarantined-settle-completed',
      provider: 'claude',
      threadId,
      turnId: 'turn-quarantined',
      createdAt: new Date().toISOString(),
      method: 'turn.completed',
      finishReason: 'stop',
      outputText: 'done',
    });
    expect(await stop).toMatchObject({ outcome: 'turn-completed' });
    acknowledgement.resolve({
      outcome: 'cancelled',
      turnId: 'turn-quarantined',
    });
    expect(claude.stopSession).not.toHaveBeenCalled();
    await bounded.shutdown();
  });

  describe('content delta coalescing at the publish seam (station#3350)', () => {
    /** Every delta this suite streams belongs to one item of one turn. */
    function textDelta(
      threadId: string,
      turnId: string,
      eventId: string,
      delta: string,
    ): CanonicalRuntimeEvent {
      return {
        eventId,
        provider: 'bedrock',
        threadId,
        turnId,
        itemId: 'item-1',
        createdAt: new Date().toISOString(),
        method: 'content.text-delta',
        delta,
      } as unknown as CanonicalRuntimeEvent;
    }

    function publishedText(threadId: string): string[] {
      return eventStore
        .listEvents(threadId)
        .map((entry) => entry.payload)
        .filter((event) => event.method === 'content.text-delta')
        .map((event) => (event as unknown as { delta: string }).delta);
    }

    test('the coalesced text reaches the published stream rather than a buffer it re-enters', async () => {
      const threadId = 'delta-coalescing-published';
      await service.dispatch({
        type: 'startSession',
        input: { threadId, provider: 'bedrock' },
      });
      service.initialize();

      bedrock.events.push({
        eventId: 'coalesce-turn-started',
        provider: 'bedrock',
        threadId,
        turnId: 'turn-coalesce',
        createdAt: new Date().toISOString(),
        method: 'turn.started',
        prompt: 'stream some text',
      });
      const chunks = ['Hel', 'lo, ', 'wor', 'ld'];
      chunks.forEach((chunk, index) => {
        bedrock.events.push(
          textDelta(
            threadId,
            'turn-coalesce',
            `coalesce-chunk-${index}`,
            chunk,
          ),
        );
      });
      bedrock.events.push({
        eventId: 'coalesce-turn-completed',
        provider: 'bedrock',
        threadId,
        turnId: 'turn-coalesce',
        createdAt: new Date().toISOString(),
        method: 'turn.completed',
        finishReason: 'stop',
        outputText: 'Hello, world',
      });

      await waitFor(
        () => eventStore.listEvents(threadId).map((entry) => entry.payload),
        (events) => events.some((event) => event.method === 'turn.completed'),
      );

      // The property this test exists for: the coalescer's emit target must
      // be the publish BODY. Wired to `projectAndPublishEvent` instead, every
      // merged delta is re-offered to the coalescer it was just flushed from
      // and every token is silently lost — with the unit tests still green.
      expect(publishedText(threadId).join('')).toBe('Hello, world');
      // And it really coalesced: four deltas in, fewer events out.
      expect(publishedText(threadId).length).toBeLessThan(chunks.length);
    });

    test('the turn-stall watchdog observes each RAW delta exactly once', async () => {
      const threadId = 'delta-coalescing-watchdog';
      await service.dispatch({
        type: 'startSession',
        input: { threadId, provider: 'bedrock' },
      });
      // Epic archive#4024: the watchdog now lives inside the extracted
      // TurnProgressTracker; the reach-in follows it one level down.
      const watchdog = (
        service as unknown as {
          turnProgress: {
            watchdog: {
              observe(input: { method: string }, ...rest: unknown[]): void;
            };
          };
        }
      ).turnProgress.watchdog;
      const observe = vi.spyOn(watchdog, 'observe');
      service.initialize();

      bedrock.events.push({
        eventId: 'watchdog-turn-started',
        provider: 'bedrock',
        threadId,
        turnId: 'turn-watchdog',
        createdAt: new Date().toISOString(),
        method: 'turn.started',
        prompt: 'stream some text',
      });
      const chunks = ['one ', 'two ', 'three'];
      chunks.forEach((chunk, index) => {
        bedrock.events.push(
          textDelta(
            threadId,
            'turn-watchdog',
            `watchdog-chunk-${index}`,
            chunk,
          ),
        );
      });
      bedrock.events.push({
        eventId: 'watchdog-turn-completed',
        provider: 'bedrock',
        threadId,
        turnId: 'turn-watchdog',
        createdAt: new Date().toISOString(),
        method: 'turn.completed',
        finishReason: 'stop',
        outputText: 'one two three',
      });

      await waitFor(
        () => eventStore.listEvents(threadId).map((entry) => entry.payload),
        (events) => events.some((event) => event.method === 'turn.completed'),
      );

      // Progress is a fact about the ENGINE, so the watchdog must see the raw
      // stream: once per delta the adapter produced. Not zero (observing only
      // the merged event makes a healthy fast turn look stalled), and not
      // more (observing the merged event too resets the window twice for one
      // stretch of text).
      const deltaObservations = observe.mock.calls.filter(
        ([input]) =>
          (input as { threadId: string; method: string }).threadId ===
            threadId &&
          (input as { method: string }).method === 'content.text-delta',
      );
      expect(deltaObservations).toHaveLength(chunks.length);
      observe.mockRestore();
    });

    test('shutdown publishes text still held in the window', async () => {
      vi.useFakeTimers();
      try {
        const threadId = 'delta-coalescing-shutdown';
        await service.dispatch({
          type: 'startSession',
          input: { threadId, provider: 'bedrock' },
        });
        service.initialize();
        await vi.advanceTimersByTimeAsync(0);

        bedrock.events.push({
          eventId: 'shutdown-turn-started',
          provider: 'bedrock',
          threadId,
          turnId: 'turn-shutdown',
          createdAt: new Date().toISOString(),
          method: 'turn.started',
          prompt: 'stream some text',
        });
        bedrock.events.push(
          textDelta(threadId, 'turn-shutdown', 'shutdown-chunk-0', 'painted'),
        );
        bedrock.events.push(
          textDelta(threadId, 'turn-shutdown', 'shutdown-chunk-1', '-held'),
        );
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(0);

        // Precondition, so this cannot pass vacuously: the stream drained,
        // the first delta painted, and the second is still inside the window
        // (fake timers, so it has not fired).
        expect(publishedText(threadId)).toEqual(['painted']);

        // This thread's adapter binding is already torn down (an adapter
        // replacement finalized it while text was still in the window), so
        // nothing later in shutdown publishes a `session.exited` for it.
        // That distinction is the whole test: for a session still bound,
        // `session.exited` flushes the buffer on its way past the coalescing
        // seam, and `flushAll()` reads as load-bearing while being untested.
        // Here it is the only thing between the operator and lost text —
        // fault-injection-proven by deleting it and watching this go red.
        (
          service as unknown as { sessionAdapters: Map<string, unknown> }
        ).sessionAdapters.delete(threadId);

        const closing = service.shutdown();
        await vi.advanceTimersByTimeAsync(0);
        await closing;

        // A delta still buffered at shutdown is text the model produced and
        // the operator never saw.
        expect(publishedText(threadId).join('')).toBe('painted-held');
      } finally {
        vi.useRealTimers();
      }
    });

    test('quarantining a thread publishes the text it had already accepted', async () => {
      vi.useFakeTimers();
      try {
        const threadId = 'delta-coalescing-quarantine';
        await service.dispatch({
          type: 'startSession',
          input: { threadId, provider: 'bedrock' },
        });
        service.initialize();
        await vi.advanceTimersByTimeAsync(0);

        bedrock.events.push({
          eventId: 'quarantine-turn-started',
          provider: 'bedrock',
          threadId,
          turnId: 'turn-quarantine',
          createdAt: new Date().toISOString(),
          method: 'turn.started',
          prompt: 'stream some text',
        });
        bedrock.events.push(
          textDelta(threadId, 'turn-quarantine', 'quarantine-chunk-0', 'kept'),
        );
        bedrock.events.push(
          textDelta(
            threadId,
            'turn-quarantine',
            'quarantine-chunk-1',
            '-and-kept',
          ),
        );
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(0);
        expect(publishedText(threadId)).toEqual(['kept']);

        await (
          service as unknown as {
            quarantineCredentialProfileRecoverySession(
              threadId: string,
            ): Promise<void>;
          }
        ).quarantineCredentialProfileRecoverySession(threadId);

        // The buffered text was produced BEFORE the decision to quarantine
        // and the pre-coalescing publish chain had already persisted it.
        // Quarantine retires the session; it must not retroactively delete
        // output the operator had already been shown.
        expect(publishedText(threadId).join('')).toBe('kept-and-kept');
      } finally {
        vi.useRealTimers();
      }
    });

    test('a delta that arrives after quarantine does not re-arm the watchdog for the retired session', async () => {
      const threadId = 'delta-coalescing-quarantine-watchdog';
      await service.dispatch({
        type: 'startSession',
        input: { threadId, provider: 'bedrock' },
      });
      const internals = service as unknown as {
        turnProgress: {
          watchdog: {
            observe(input: { method: string }, ...rest: unknown[]): void;
          };
        };
        sessionExecutionCoordinator: {
          observe(event: { threadId: string }): void;
        };
      };
      const watchdog = internals.turnProgress.watchdog;
      const coordinator = internals.sessionExecutionCoordinator;
      service.initialize();

      bedrock.events.push(
        textDelta(threadId, 'turn-late', 'late-chunk-0', 'before'),
      );
      await waitFor(
        () => eventStore.listEvents(threadId).map((entry) => entry.payload),
        (events) =>
          events.some((event) => event.method === 'content.text-delta'),
      );

      await (
        service as unknown as {
          quarantineCredentialProfileRecoverySession(
            threadId: string,
          ): Promise<void>;
        }
      ).quarantineCredentialProfileRecoverySession(threadId);

      // Stopping the provider is asynchronous, so deltas keep arriving after
      // the guard is installed. Coalescing hoisted this observation AHEAD of
      // the quarantine gate that every other event's observation still sits
      // behind, which re-armed the stall watchdog and the execution
      // coordinator for a session Station has deliberately retired.
      const observe = vi.spyOn(watchdog, 'observe');
      const coordinatorObserve = vi.spyOn(coordinator, 'observe');
      bedrock.events.push(
        textDelta(threadId, 'turn-late', 'late-chunk-1', '-after'),
      );
      bedrock.events.push({
        eventId: 'late-marker',
        provider: 'bedrock',
        threadId: 'delta-coalescing-quarantine-watchdog-other',
        turnId: 'turn-marker',
        createdAt: new Date().toISOString(),
        method: 'turn.completed',
        finishReason: 'stop',
        outputText: 'marker',
      } as unknown as CanonicalRuntimeEvent);
      // The marker rides the same stream, so once it has been observed the
      // quarantined delta ahead of it has already been processed — this
      // cannot pass by merely racing the assertion.
      await waitFor(
        () => observe.mock.calls,
        (calls) =>
          calls.some(
            ([input]) =>
              (input as { threadId: string; method: string }).threadId ===
              'delta-coalescing-quarantine-watchdog-other',
          ),
      );

      expect(
        observe.mock.calls.filter(
          ([input]) =>
            (input as { threadId: string; method: string }).threadId ===
            threadId,
        ),
      ).toEqual([]);
      // The hoisted observation feeds BOTH; a gate that covered only the
      // watchdog would still re-arm the execution coordinator's boundaries for
      // the retired session.
      expect(
        coordinatorObserve.mock.calls.filter(
          ([event]) => event.threadId === threadId,
        ),
      ).toEqual([]);
      observe.mockRestore();
      coordinatorObserve.mockRestore();
    });
  });

  describe('forgetThreadState — the declared teardown seam (epic #4024 slice 2)', () => {
    // Fault injection during the slice proved the suite discriminates the
    // five CORE clears (dropping tenantContexts reds a tenancy test) but was
    // blind to every DIVERGENT-aspect flip: removing policyThreads from
    // forgetLiveUserSession or ownerCache from evictCollidingAttachedAliases
    // left 349/349 green. This block pins the seam's own contract with full
    // per-flag power — a declared aspect clears its map, an undeclared one
    // MUST leave it alone — so a later slice converging a subset changes a
    // reviewed flag, never silently. Per-site flag wiring remains
    // diff-reviewed against the seam docblock's table.
    interface SeamInternals {
      sessionAdapters: Map<string, unknown>;
      threadProviders: Map<string, unknown>;
      sessionReadModel: Map<string, unknown>;
      sessionConnectionIds: Map<string, unknown>;
      // Slice 6 (archive#4166) moved both authz indexes into the SessionAuthorization
      // collaborator; the seam still clears them on the SAME instance, so the
      // per-flag contract reaches them through the service's `sessionAuthz`.
      sessionAuthz: {
        tenantContexts: Map<string, unknown>;
        sessionOwnerCache: Map<string, unknown>;
      };
      // Slice 11 (archive#4218) moved both flow/policy caches into the
      // FlowPolicySidecar collaborator; the seam still clears them on the
      // SAME instance, so the per-flag contract reaches them through the
      // service's `flowPolicy`.
      flowPolicy: {
        policyThreads: Map<string, unknown>;
        flowBoundThreads: Map<string, unknown>;
      };
      turnProgress: { forgetThread(threadId: string): void };
      forgetThreadState(
        threadId: string,
        divergent?: {
          policyThreads?: boolean;
          flowBoundThreads?: boolean;
          ownerCache?: boolean;
          turnProgress?: boolean;
        },
      ): void;
    }

    const CORE = [
      'sessionAdapters',
      'threadProviders',
      'sessionReadModel',
      'sessionConnectionIds',
    ] as const;
    const ASPECT_MAPS = {
      policyThreads: 'policyThreads',
      flowBoundThreads: 'flowBoundThreads',
      ownerCache: 'sessionOwnerCache',
    } as const;

    const seed = (internals: SeamInternals, threadId: string) => {
      for (const field of CORE)
        internals[field].set(threadId, { seeded: true });
      internals.sessionAuthz.tenantContexts.set(threadId, { seeded: true });
      internals.flowPolicy.policyThreads.set(threadId, '/tmp/policy');
      internals.flowPolicy.flowBoundThreads.set(threadId, true);
      internals.sessionAuthz.sessionOwnerCache.set(threadId, 'owner-1');
    };

    test.each([
      // The distinct flag combinations the six call sites use — these pin
      // the SEAM's dispatch, not the sites (the source invariant below owns
      // site wiring).
      ['policy-and-flowbound', { policyThreads: true, flowBoundThreads: true }],
      ['policy-and-turnprogress', { policyThreads: true, turnProgress: true }],
      ['ownercache-only', { ownerCache: true }],
      ['policy-and-ownercache', { policyThreads: true, ownerCache: true }],
      // The empty subset: only the core five may clear.
      ['bare', {}],
    ] as const)(
      'subset %s clears exactly its declared aspects plus the core five',
      (label, divergent) => {
        const internals = service as unknown as SeamInternals;
        const threadId = `seam-${label}`;
        seed(internals, threadId);
        const forgotten: string[] = [];
        const originalForget = internals.turnProgress.forgetThread.bind(
          internals.turnProgress,
        );
        internals.turnProgress.forgetThread = (id: string) => {
          forgotten.push(id);
          originalForget(id);
        };
        try {
          internals.forgetThreadState(threadId, divergent);
        } finally {
          delete (internals.turnProgress as { forgetThread?: unknown })
            .forgetThread;
        }
        for (const field of CORE) {
          expect(internals[field].has(threadId), `${field} must clear`).toBe(
            false,
          );
        }
        expect(
          internals.sessionAuthz.tenantContexts.has(threadId),
          'tenantContexts must clear',
        ).toBe(false);
        for (const [flag, field] of Object.entries(ASPECT_MAPS)) {
          const declared = Boolean(
            (divergent as Record<string, boolean | undefined>)[flag],
          );
          const map = (
            {
              policyThreads: internals.flowPolicy.policyThreads,
              flowBoundThreads: internals.flowPolicy.flowBoundThreads,
              sessionOwnerCache: internals.sessionAuthz.sessionOwnerCache,
            } as Record<string, Map<string, unknown>>
          )[field];
          if (!map) throw new Error(`unmapped aspect field ${field}`);
          expect(
            map.has(threadId),
            `${field} cleared must equal declared=${declared}`,
          ).toBe(!declared);
        }
        expect(forgotten.includes(threadId)).toBe(
          Boolean((divergent as { turnProgress?: boolean }).turnProgress),
        );
      },
    );
  });

  describe('forgetThreadState call sites match the declared table (source invariant)', () => {
    // The per-flag contract above pins the SEAM; this pins the SITES.
    // Injection during the slice proved a call site silently dropping a flag
    // (forgetLiveUserSession losing policyThreads) stayed green under the
    // whole suite — so both the call sites' declared subsets AND the seam
    // docblock's table are derived from the source and compared to each
    // other: ONE truth, no third transcription to rot. Same genre as
    // orchestration-source-invariants.test.ts (read its header before
    // extending this — the docblock never writes the call form, which is why
    // the call-site regex cannot match its own rationale). A site changing
    // its subset must change the docblock table in the same diff, on
    // purpose. Callers without a braces argument cannot evade this: the
    // seam's `divergent` parameter has no default, so a bare call fails to
    // compile.
    test('every call site declares exactly the subset the seam docblock table records', () => {
      const source = readFileSync(
        join(__dirname, '..', 'orchestration-service.ts'),
        'utf8',
      );
      const sites = [
        ...source.matchAll(
          /forgetThreadState\(\s*[^,)]+,\s*\{([^}]*)\}\s*,?\s*\)/g,
        ),
      ].map((match) =>
        [...match[1].matchAll(/(\w+):\s*true/g)].map((flag) => flag[1]).sort(),
      );
      const FLAG_COLUMNS = [
        'policyThreads',
        'flowBoundThreads',
        'ownerCache',
        'turnProgress',
      ] as const;
      const docblockRows = [
        ...source.matchAll(
          /^\s*\* \| ([A-Za-z.]+) \| (yes|—) \| (yes|—) \| (yes|—) \| (yes|—) \|$/gm,
        ),
      ].map((row) =>
        FLAG_COLUMNS.filter((_flag, index) => row[index + 2] === 'yes').sort(),
      );
      expect(docblockRows).toHaveLength(6);
      expect(sites).toEqual(docblockRows);
    });
  });

  /** A class-member declaration at the file's two-space member indent. */
  const MEMBER_DECLARATION =
    /^ {2}(?:private |public |protected )?(?:static )?(?:readonly )?(?:async )?[A-Za-z_$][\w$]*\(/gm;

  /**
   * One method's body: from its declaration to whatever member is declared
   * NEXT, whichever that turns out to be.
   *
   * Review L6 (archive#4218) called out the previous form — a slice between two
   * NAMED markers — as not-a-body, since a member declared between them but
   * CALLED from above the gate keeps every relative index intact while
   * inverting the ordering the invariant exists to protect. That was not
   * hypothetical: applying this helper immediately showed
   * `captureUsagePricingSnapshot` had already landed between
   * `consumeAdapterEvents` and `isAdapterCurrent`, so the ingest scan was
   * reading two members as one body. Naming the next marker is what rots;
   * this finds it, so an insertion narrows the slice instead of widening it.
   */
  function readMethodBody(source: string, declaration: string): string {
    const start = source.indexOf(declaration);
    expect(
      start,
      `declaration not found: ${declaration}`,
    ).toBeGreaterThanOrEqual(0);
    const rest = source.slice(start + declaration.length);
    const next = [...rest.matchAll(MEMBER_DECLARATION)][0];
    expect(next, 'no member follows the scanned declaration').toBeDefined();
    return declaration + rest.slice(0, next?.index ?? rest.length);
  }

  describe('the cooperative-stop settle-read precedes the quarantine gate (source invariant)', () => {
    /**
     * Slice 10 (archive#4204): moving `settleCompletedTurn` below the quarantine
     * gate changes observable behavior ONLY for a quarantined thread with
     * an in-flight cooperative stop — a state no runtime fixture had ever
     * constructed, so the perturbation was 100% green under the whole
     * suite. The ordering's owner is this scan; its behavioral complement
     * is the I2 guard fixture beside the stop tests.
     */
    test('publishCanonicalEvent settles a completed stop before it can decline the event', () => {
      const source = readFileSync(
        join(__dirname, '..', 'orchestration-service.ts'),
        'utf8',
      );
      const body = readMethodBody(source, '\n  private publishCanonicalEvent(');
      const settle = body.indexOf('.settleCompletedTurn(');
      const gate = body.indexOf('this.quarantinedThreads.has(');
      expect(settle).toBeGreaterThanOrEqual(0);
      expect(gate).toBeGreaterThanOrEqual(0);
      expect(settle).toBeLessThan(gate);
      // Exactly one dispatch of the settle, file-wide (double-settle guard).
      // RAW scan, comments included: a service-side comment that writes the
      // literal call form `.settleCompletedTurn(` would red this on its own
      // rationale — keep prose references name-only (same warning as the
      // forgetThreadState invariant above).
      expect(source.split('.settleCompletedTurn(').length - 1).toBe(1);
    });
  });

  describe('the ingest policy/spool calls sit below the publish continue-gate (source invariant)', () => {
    /**
     * Slice 11 (archive#4218): the two FlowPolicySidecar ingest calls must run
     * ONLY for events the publish seam accepted — moving either above the
     * continue-gate changes observable behavior only for events the gate
     * declines (coalesced deltas, quarantined threads), populations no
     * runtime fixture combined with tool events before this slice. The
     * ordering's owner is this scan; its behavioral complement is the
     * quarantined-ingest guard in the S3 policy band. Prose that names the
     * calls stays name-only (no `this.flowPolicy.` + paren call form) or
     * this scan reds on its own rationale — same warning as the two
     * invariants above.
     */
    test('consumeAdapterEvents orders gate < post-hoc policy < command spool, each dispatched once file-wide', () => {
      const source = readFileSync(
        join(__dirname, '..', 'orchestration-service.ts'),
        'utf8',
      );
      const body = readMethodBody(
        source,
        '\n  private async consumeAdapterEvents(',
      );
      const gate = body.indexOf('if (!this.projectAndPublishEvent(');
      const postHoc = body.indexOf('.applyPostHocToolPolicies(');
      const spool = body.indexOf('.spoolCommandEvidence(');
      expect(gate).toBeGreaterThanOrEqual(0);
      expect(postHoc).toBeGreaterThan(gate);
      expect(spool).toBeGreaterThan(postHoc);
      // The gate must be the ONLY one in the body: with two, the ingest
      // calls could sit above the real gate and still be `> gate`.
      expect(body.split('if (!this.projectAndPublishEvent(').length - 1).toBe(
        1,
      );
      // Exactly one dispatch of each across the SERVICES TREE, not just this
      // file (review M2): before slice 11 both were private members of this
      // class, so "file-wide" was "everywhere". They are public members of an
      // exported class now — any module holding the sidecar can dispatch
      // them, and a second appender spooling the same event would double
      // every command into durable Flow evidence. RAW scan, comments
      // included, so prose naming them stays name-only.
      const servicesTree = readdirSync(join(__dirname, '..', '..'), {
        recursive: true,
        withFileTypes: true,
      })
        .filter((entry) => entry.isFile() && String(entry.name).endsWith('.ts'))
        .map((entry) => join(String(entry.parentPath), String(entry.name)))
        .filter((file) => !file.includes('__tests__'))
        .map((file) => readFileSync(file, 'utf8'))
        .join('\n');
      expect(servicesTree.split('.applyPostHocToolPolicies(').length - 1).toBe(
        1,
      );
      expect(servicesTree.split('.spoolCommandEvidence(').length - 1).toBe(1);
    });
  });

  describe('shutdown reads the retiring set before it drains (source invariant)', () => {
    /**
     * Slice 12 (archive#4024): `retiringAdapters()` and `shutdownRetirementTasks()`
     * used to be one expression over one map. Split across a module seam,
     * they are two calls that MUST happen at the same synchronous tick —
     * an await between them lets a retirement settle and drop out of the
     * set, after which the second arm stops an adapter the first arm is
     * already stopping. Nothing at any level observes that ordering, so
     * this scan owns it.
     */
    test('the two retirement reads are adjacent, with no await between them', () => {
      const source = readFileSync(
        join(__dirname, '..', 'orchestration-service.ts'),
        'utf8',
      );
      const body = readMethodBody(
        source,
        '\n  async shutdown(): Promise<void> {',
      );
      const set = body.indexOf('.retiringAdapters()');
      const drain = body.indexOf('.shutdownRetirementTasks()');
      expect(set).toBeGreaterThanOrEqual(0);
      expect(drain).toBeGreaterThan(set);
      // The window starts at the read, so an await IMMEDIATELY BEFORE it —
      // `const x = await this.adapterRetirement.retiringAdapters()`, if that
      // ever became async — would suspend outside the scan and stay green
      // while a retirement settles out of the drain map (review L2). Pin the
      // call's awaitless form directly.
      expect(body).toContain(
        'const retiringAdapters = this.adapterRetirement.retiringAdapters();',
      );
      // The ONLY await permitted between them is the one that opens the
      // `Promise.allSettled([` whose array literal CONTAINS the drain: that
      // await does not suspend until after the array is built, so the two
      // reads still happen at one tick. Any OTHER await does suspend, and
      // that is the hazard. RAW scan, comments included, so prose between
      // them stays name-only.
      const between = body
        .slice(set, drain)
        .replace('await Promise.allSettled([', '');
      expect(between).not.toMatch(/\bawait\b/);
      // Exactly one dispatch of each across the services tree: a second
      // drain would double-stop every retiring adapter.
      const servicesTree = readdirSync(join(__dirname, '..', '..'), {
        recursive: true,
        withFileTypes: true,
      })
        .filter((entry) => entry.isFile() && String(entry.name).endsWith('.ts'))
        .map((entry) => join(String(entry.parentPath), String(entry.name)))
        .filter((file) => !file.includes('__tests__'))
        .map((file) => readFileSync(file, 'utf8'))
        .join('\n');
      expect(servicesTree.split('.shutdownRetirementTasks(').length - 1).toBe(
        1,
      );
    });
  });

  describe('turn-stall detection (station#2959)', () => {
    test('detects a turn with no observed progress past its agent window — observe-only: counted, logged, and nothing terminated', async () => {
      vi.useFakeTimers();
      // archive#2959: mocked metrics are module-level and NOT cleared between
      // tests in this file (no global clearMocks), so a prior test's calls
      // to this same counter are still on the mock. Clear it so this test's
      // assertion reflects only what THIS test caused.
      vi.mocked(orchestrationTurnStallDetections.add).mockClear();
      try {
        const bounded = new OrchestrationService({
          adapterRegistry: createRegistry([bedrock]),
          eventBus,
          eventStore,
          cooperativeStopBudgetMs: 25,
          loadAgentExecutionConfig: async (slug) =>
            slug === 'stall-agent'
              ? {
                  agentConnectionId: engineConnectionId('bedrock'),
                  turnStallWindowMs: 200,
                }
              : undefined,
          logger: { debug: vi.fn(), warn: vi.fn() },
        });
        const threadId = 'turn-stall-detected';
        await bounded.dispatch({
          type: 'startSession',
          input: {
            threadId,
            provider: 'bedrock',
            metadata: { agentSlug: 'stall-agent' },
          },
        });
        bounded.initialize();
        await vi.advanceTimersByTimeAsync(0);

        // A LITERAL timestamp, deliberately not new Date(): the assertions
        // below pin that the projection's anchors are DERIVED from this
        // event's own createdAt. Any implementation that substitutes an
        // ambient clock reading (fake or real) can never equal this value.
        const turnStartedAt = '2026-08-24T00:00:00.000Z';
        bedrock.events.push({
          eventId: 'stall-turn-started',
          provider: 'bedrock',
          threadId,
          turnId: 'turn-stall',
          createdAt: turnStartedAt,
          method: 'turn.started',
          prompt: 'do something slow',
        });
        await vi.advanceTimersByTimeAsync(0);

        // No further progress event for the full 200ms declared window.
        await vi.advanceTimersByTimeAsync(200);
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(0);

        // OBSERVE-ONLY (review decision): detection counts and logs, and
        // terminates NOTHING. Both directions pinned — the counter fired,
        // and no interrupt, no stop-settled event exists.
        expect(orchestrationTurnStallDetections.add).toHaveBeenCalledWith(1, {
          provider: 'bedrock',
        });
        expect(bedrock.interruptTurn).not.toHaveBeenCalled();
        const stopSettled = eventStore
          .listEvents(threadId)
          .map((event) => event.payload)
          .filter((event) => event.method === 'session.stop-settled');
        expect(stopSettled).toEqual([]);

        // archive#4054: this is a watchdog-owned observation on the same
        // summary Home reads, not a synthetic terminal event or a new state
        // label. The value is captured from the real session projection so
        // the UI cannot accidentally pin an invented fixture shape (archive#1715).
        const afterSilence = (await bounded.listSessionReadModel()).find(
          (session) => session.threadId === threadId,
        );
        expect(afterSilence?.turnProgress).toMatchObject({
          lastProgressEventAt: turnStartedAt,
          progressSilence: {
            windowMs: 200,
            silentSinceEventAt: turnStartedAt,
            provider: 'bedrock',
          },
        });
        // detectedAt is the watchdog's own clock reading ("when noticed") —
        // this suite does not fake Date, so assert shape, not value.
        expect(
          Number.isFinite(
            Date.parse(
              afterSilence?.turnProgress?.progressSilence?.detectedAt ?? '',
            ),
          ),
        ).toBe(true);

        // The next watchdog progress event clears the marker reactively;
        // `lastEventAt` is not consulted to manufacture that transition.
        const progressAt = '2026-08-24T00:00:01.000Z';
        bedrock.events.push({
          eventId: 'stall-progress-after-observation',
          provider: 'bedrock',
          threadId,
          turnId: 'turn-stall',
          createdAt: progressAt,
          method: 'content.text-delta',
          itemId: 'text-1',
          delta: 'still working',
        });
        await vi.advanceTimersByTimeAsync(0);
        const afterProgress = (await bounded.listSessionReadModel()).find(
          (session) => session.threadId === threadId,
        )?.turnProgress;
        // Cleared MEANS cleared: assert the marker's absence explicitly, and
        // that the new anchor is the progress event's own createdAt.
        expect(afterProgress?.progressSilence).toBeUndefined();
        expect(afterProgress?.lastProgressEventAt).toBe(progressAt);

        // Ending the turn clears the observation too; terminal rendering is
        // otherwise unchanged and remains outside this slice.
        bedrock.events.push({
          eventId: 'stall-turn-completed-after-observation',
          provider: 'bedrock',
          threadId,
          turnId: 'turn-stall',
          createdAt: new Date().toISOString(),
          method: 'turn.completed',
          finishReason: 'stop',
          outputText: 'done',
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(
          (await bounded.listSessionReadModel()).find(
            (session) => session.threadId === threadId,
          )?.turnProgress,
        ).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    // archive#4054 fix round F2: an approval wait deliberately SUSPENDS observation
    // (SUSPEND_METHODS), so a marker fired before the wait must clear — a
    // frozen-but-growing "No progress events for 30m" during a human wait
    // would overclaim. After resume, a fresh full-window silence may
    // legitimately re-publish.
    test('clears a fired silence marker when the turn suspends for human input, and can re-fire after resume', async () => {
      vi.useFakeTimers();
      vi.mocked(orchestrationTurnStallDetections.add).mockClear();
      try {
        const bounded = new OrchestrationService({
          adapterRegistry: createRegistry([bedrock]),
          eventBus,
          eventStore,
          loadAgentExecutionConfig: async () => ({
            agentConnectionId: engineConnectionId('bedrock'),
            turnStallWindowMs: 200,
          }),
          logger: { debug: vi.fn(), warn: vi.fn() },
        });
        const threadId = 'turn-stall-suspend';
        await bounded.dispatch({
          type: 'startSession',
          input: {
            threadId,
            provider: 'bedrock',
            metadata: { agentSlug: 'stall-agent' },
          },
        });
        bounded.initialize();
        await vi.advanceTimersByTimeAsync(0);

        bedrock.events.push({
          eventId: 'suspend-turn-started',
          provider: 'bedrock',
          threadId,
          turnId: 'turn-suspend',
          createdAt: '2026-08-24T00:00:00.000Z',
          method: 'turn.started',
          prompt: 'do something slow',
        });
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(200);
        await vi.advanceTimersByTimeAsync(0);
        const readTurnProgress = async () =>
          (await bounded.listSessionReadModel()).find(
            (session) => session.threadId === threadId,
          )?.turnProgress;
        expect((await readTurnProgress())?.progressSilence).toBeDefined();

        bedrock.events.push({
          eventId: 'suspend-request-opened',
          provider: 'bedrock',
          threadId,
          turnId: 'turn-suspend',
          createdAt: '2026-08-24T00:00:01.000Z',
          method: 'request.opened',
          requestId: 'req-1',
          requestType: 'approval',
          title: 'Approve the slow thing',
        });
        await vi.advanceTimersByTimeAsync(0);
        expect((await readTurnProgress())?.progressSilence).toBeUndefined();
        // Delta-review F2: the discriminating interval. If request.opened had
        // merely RESET the watch (the non-suspend branch), two full windows of
        // silence here would fire a second detection and republish the marker.
        // A genuinely SUSPENDED watch is not timing at all: no marker, and the
        // observe-only counter stays at its single pre-suspension detection.
        const detectionsBeforeWait = vi.mocked(
          orchestrationTurnStallDetections.add,
        ).mock.calls.length;
        await vi.advanceTimersByTimeAsync(400);
        await vi.advanceTimersByTimeAsync(0);
        expect((await readTurnProgress())?.progressSilence).toBeUndefined();
        expect(
          vi.mocked(orchestrationTurnStallDetections.add).mock.calls.length,
        ).toBe(detectionsBeforeWait);

        bedrock.events.push({
          eventId: 'suspend-request-resolved',
          provider: 'bedrock',
          threadId,
          turnId: 'turn-suspend',
          createdAt: '2026-08-24T00:00:02.000Z',
          method: 'request.resolved',
          requestId: 'req-1',
          status: 'approved',
        });
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(200);
        await vi.advanceTimersByTimeAsync(0);
        expect((await readTurnProgress())?.progressSilence).toBeDefined();
      } finally {
        vi.useRealTimers();
      }
    });

    test('never flags a turn making steady progress at any rate, even far past the window in total elapsed time', async () => {
      vi.useFakeTimers();
      vi.mocked(orchestrationTurnStallDetections.add).mockClear();
      try {
        const bounded = new OrchestrationService({
          adapterRegistry: createRegistry([bedrock]),
          eventBus,
          eventStore,
          loadAgentExecutionConfig: async () => ({
            agentConnectionId: engineConnectionId('bedrock'),
            turnStallWindowMs: 100,
          }),
          logger: { debug: vi.fn(), warn: vi.fn() },
        });
        const threadId = 'turn-steady-progress';
        await bounded.dispatch({
          type: 'startSession',
          input: {
            threadId,
            provider: 'bedrock',
            metadata: { agentSlug: 'steady-agent' },
          },
        });
        bounded.initialize();
        await vi.advanceTimersByTimeAsync(0);

        bedrock.events.push({
          eventId: 'steady-turn-started',
          provider: 'bedrock',
          threadId,
          turnId: 'turn-steady',
          createdAt: new Date().toISOString(),
          method: 'turn.started',
          prompt: 'stream steadily',
        });
        await vi.advanceTimersByTimeAsync(0);

        // 12 chunks 90ms apart (< the 100ms window): total elapsed 1080ms —
        // nearly 11x the window — but no single gap between chunks exceeds it.
        for (let i = 0; i < 12; i += 1) {
          await vi.advanceTimersByTimeAsync(90);
          bedrock.events.push({
            eventId: `steady-chunk-${i}`,
            provider: 'bedrock',
            threadId,
            turnId: 'turn-steady',
            itemId: 'text-1',
            createdAt: new Date().toISOString(),
            method: 'content.text-delta',
            delta: `chunk ${i}`,
          });
          await vi.advanceTimersByTimeAsync(0);
        }
        expect(bedrock.interruptTurn).not.toHaveBeenCalled();

        bedrock.events.push({
          eventId: 'steady-turn-completed',
          provider: 'bedrock',
          threadId,
          turnId: 'turn-steady',
          createdAt: new Date().toISOString(),
          method: 'turn.completed',
          finishReason: 'stop',
          outputText: 'done',
        });
        await vi.advanceTimersByTimeAsync(0);

        expect(bedrock.interruptTurn).not.toHaveBeenCalled();
        expect(orchestrationTurnStallDetections.add).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    test('applies a per-agent turn-stall window override resolved through the real AgentExecutionConfig seam', async () => {
      vi.useFakeTimers();
      try {
        const bounded = new OrchestrationService({
          adapterRegistry: createRegistry([bedrock]),
          eventBus,
          eventStore,
          loadAgentExecutionConfig: async (slug) =>
            slug === 'fast-timeout-agent'
              ? {
                  agentConnectionId: engineConnectionId('bedrock'),
                  turnStallWindowMs: 50,
                }
              : undefined,
          logger: { debug: vi.fn(), warn: vi.fn() },
        });

        const overriddenThread = 'turn-stall-override';
        await bounded.dispatch({
          type: 'startSession',
          input: {
            threadId: overriddenThread,
            provider: 'bedrock',
            metadata: { agentSlug: 'fast-timeout-agent' },
          },
        });
        const defaultThread = 'turn-stall-default';
        await bounded.dispatch({
          type: 'startSession',
          input: {
            threadId: defaultThread,
            provider: 'bedrock',
            metadata: { agentSlug: 'plain-agent' },
          },
        });
        bounded.initialize();
        await vi.advanceTimersByTimeAsync(0);

        bedrock.events.push({
          eventId: 'override-turn-started',
          provider: 'bedrock',
          threadId: overriddenThread,
          turnId: 'turn-override',
          createdAt: new Date().toISOString(),
          method: 'turn.started',
          prompt: 'go',
        });
        bedrock.events.push({
          eventId: 'default-turn-started',
          provider: 'bedrock',
          threadId: defaultThread,
          turnId: 'turn-default',
          createdAt: new Date().toISOString(),
          method: 'turn.started',
          prompt: 'go',
        });
        await vi.advanceTimersByTimeAsync(0);

        // At 50ms elapsed: the overridden agent's 50ms window has elapsed
        // with no progress; the OTHER thread's default (3-minute) window has
        // not, even though it is the SAME shared adapter/service instance.
        await vi.advanceTimersByTimeAsync(50);
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(0);

        // Observe-only: the overridden window's expiry is visible as a
        // detection count, never as a termination. The default-window thread
        // has not expired, so exactly one detection exists — proving the
        // per-agent override, not merely that detection works at all.
        expect(orchestrationTurnStallDetections.add).toHaveBeenCalledTimes(1);
        expect(bedrock.interruptTurn).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    test('marks a user-initiated cooperative stop "user", distinguishing it from a stall-initiated stop', async () => {
      const bounded = new OrchestrationService({
        adapterRegistry: createRegistry([claude]),
        eventBus,
        eventStore,
        cooperativeStopBudgetMs: 25,
        logger: { debug: vi.fn(), warn: vi.fn() },
      });
      const threadId = 'turn-stop-user-initiated';
      await bounded.dispatch({
        type: 'startSession',
        input: { threadId, provider: 'claude' },
      });
      eventStore.appendEvent({
        eventId: 'user-stop-started',
        provider: 'claude',
        threadId,
        turnId: 'turn-user-stop',
        createdAt: new Date().toISOString(),
        method: 'turn.started',
        prompt: 'cancel me please',
      });

      await bounded.dispatch({ type: 'interruptTurn', threadId });

      const stopSettled = eventStore
        .listEvents(threadId)
        .map((event) => event.payload)
        .filter((event) => event.method === 'session.stop-settled');
      expect(stopSettled).toEqual([
        expect.objectContaining({
          outcome: 'cooperative',
          initiatedBy: 'user',
        }),
      ]);
    });

    test('cleans up: a turn that completes naturally leaves zero additional live timers behind', async () => {
      vi.useFakeTimers();
      try {
        const bounded = new OrchestrationService({
          adapterRegistry: createRegistry([claude]),
          eventBus,
          eventStore,
          logger: { debug: vi.fn(), warn: vi.fn() },
        });
        const threadId = 'turn-stall-natural-cleanup';
        await bounded.dispatch({
          type: 'startSession',
          input: { threadId, provider: 'claude' },
        });
        bounded.initialize();
        await vi.advanceTimersByTimeAsync(0);

        const baselineTimers = vi.getTimerCount();
        claude.events.push({
          eventId: 'cleanup-turn-started',
          provider: 'claude',
          threadId,
          turnId: 'turn-cleanup',
          createdAt: new Date().toISOString(),
          method: 'turn.started',
          prompt: 'finish fast',
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBeGreaterThan(baselineTimers);

        claude.events.push({
          eventId: 'cleanup-turn-completed',
          provider: 'claude',
          threadId,
          turnId: 'turn-cleanup',
          createdAt: new Date().toISOString(),
          method: 'turn.completed',
          finishReason: 'stop',
          outputText: 'done',
        });
        await vi.advanceTimersByTimeAsync(0);

        expect(vi.getTimerCount()).toBe(baselineTimers);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  test('keeps credential-recovery quarantine teardown immediate', async () => {
    const threadId = 'credential-quarantine-immediate';
    await service.dispatch({
      type: 'startSession',
      input: { threadId, provider: 'claude' },
    });

    await (
      service as unknown as {
        quarantineCredentialProfileRecoverySession(
          threadId: string,
        ): Promise<void>;
      }
    ).quarantineCredentialProfileRecoverySession(threadId);

    expect(claude.interruptTurn).not.toHaveBeenCalled();
    expect(claude.stopSession).toHaveBeenCalledWith(threadId);
  });

  /**
   * archive#3476 review MEDIUM-1: quarantine's docblock promises that "local
   * routing and persisted resumability are retired fail-closed", but its
   * durable half used to run only `if (adapter)` — a precondition that held
   * because boot recovery eagerly started every restored session. It no
   * longer does, and boot reconciliation quarantines exactly those dormant
   * threads. Without this, the row stays `ready`/resumable on disk, only the
   * in-memory guard retires it, and the guard dies with the process: the next
   * restart restores the thread as an ordinary, fully usable session on the
   * credential binding whose compensation just failed.
   */
  test('quarantining a session with no engine still closes its persisted row', async () => {
    const threadId = 'credential-quarantine-dormant';
    eventStore.upsertSession({
      provider: 'claude',
      threadId,
      status: 'ready',
      model: 'claude-sonnet',
      resumeCursor: { cursor: 'resume-quarantine-dormant' },
      createdAt: '2026-03-28T00:00:00.000Z',
      updatedAt: '2026-03-28T00:00:05.000Z',
    });
    service.initialize();
    await waitForReceipt(
      (receipt) => receipt.kind === 'session.recovery.completed',
    );
    // The precondition this fix exists for: restored, so no adapter is bound.
    expect(claude.startSession).not.toHaveBeenCalled();

    await (
      service as unknown as {
        quarantineCredentialProfileRecoverySession(
          threadId: string,
        ): Promise<void>;
      }
    ).quarantineCredentialProfileRecoverySession(threadId);

    // Nothing to tear down, and nothing spawned in order to tear it down...
    expect(claude.startSession).not.toHaveBeenCalled();
    expect(claude.stopSession).not.toHaveBeenCalled();
    // ...but the durable half ran anyway. `closed` is what survives the
    // process, and it is what stops the next boot restoring this thread.
    expect(
      eventStore
        .readSessions()
        .find((session) => session.threadId === threadId),
    ).toMatchObject({ provider: 'claude', status: 'closed' });
  });

  test('clears a tenant binding when the session is stopped', async () => {
    const alpha = { tenantId: 'alpha' as any, source: 'request' as const };
    await service.dispatch(
      {
        type: 'startSession',
        input: { threadId: 'tenant-cleanup', provider: 'bedrock' },
      },
      { tenantExecutionContext: alpha },
    );
    await service.dispatch(
      { type: 'stopSession', threadId: 'tenant-cleanup' },
      { tenantExecutionContext: alpha },
    );

    await expect(
      service.dispatch(
        {
          type: 'startSession',
          input: { threadId: 'tenant-cleanup', provider: 'bedrock' },
        },
        {
          tenantExecutionContext: {
            tenantId: 'bravo' as any,
            source: 'request',
          },
        },
      ),
    ).resolves.toEqual(expect.objectContaining({ threadId: 'tenant-cleanup' }));
  });

  test.each(['station-agent', 'claude', 'codex'] as const)(
    'restarts a credential-profile %s session with its server tenant input and ALS carrier',
    async (provider) => {
      const adapter = new FakeAdapter(provider);
      const restartService = new OrchestrationService({
        adapterRegistry: createRegistry([adapter]),
        eventBus,
        eventStore,
        logger: { debug: vi.fn(), warn: vi.fn() },
      });
      const alpha = {
        tenantId: 'alpha' as any,
        source: 'request' as const,
      };
      const threadId = `credential-restart-${provider}`;
      const defaultStart = adapter.startSession.getMockImplementation()!;
      const seenContexts: unknown[] = [];
      adapter.startSession.mockImplementation(async (input) => {
        seenContexts.push(currentTenantExecutionContext());
        return defaultStart(input);
      });
      await restartService.dispatch(
        {
          type: 'startSession',
          input: { threadId, provider },
        },
        { tenantExecutionContext: alpha },
      );
      adapter.startSession.mockClear();
      seenContexts.splice(0);

      await (
        restartService as unknown as {
          restartCredentialProfileProviderSession(input: {
            threadId: string;
            signal: AbortSignal;
            credentialProfileRef?: string;
          }): Promise<unknown>;
        }
      ).restartCredentialProfileProviderSession({
        threadId,
        signal: new AbortController().signal,
        credentialProfileRef: 'canary',
      });

      expect(adapter.startSession).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantExecutionContext: alpha,
          credentialProfileRef: 'canary',
        }),
      );
      expect(seenContexts).toEqual([alpha]);
      await restartService.shutdown();
    },
  );

  /**
   * archive#3476: boot reconciliation reaches this path
   * (`CredentialProfileRecovery.restoreSession`) for any thread that still
   * held a prepared credential-recovery intent at shutdown — i.e. a session
   * this process has only restored, never started. Resolving the adapter by
   * probing for a LIVE thread threw there, and the caller's response to a
   * throw is `quarantineSession`, which closes the row and destroys its
   * `resumeCursor`. Resolve by the session's persisted provider instead.
   */
  test('restarts a credential-profile session that boot only restored, without quarantining it', async () => {
    const threadId = 'credential-restart-dormant';
    eventStore.upsertSession({
      provider: 'claude',
      threadId,
      status: 'running',
      model: 'claude-sonnet',
      resumeCursor: { cursor: 'resume-dormant-credential' },
      createdAt: '2026-03-28T00:00:00.000Z',
      updatedAt: '2026-03-28T00:00:05.000Z',
    });
    service.initialize();
    await waitForReceipt(
      (receipt) => receipt.kind === 'session.recovery.completed',
    );

    await (
      service as unknown as {
        restartCredentialProfileProviderSession(input: {
          threadId: string;
          signal: AbortSignal;
          credentialProfileRef?: string;
        }): Promise<unknown>;
      }
    ).restartCredentialProfileProviderSession({
      threadId,
      signal: new AbortController().signal,
      credentialProfileRef: 'canary',
    });

    expect(claude.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId,
        resumeCursor: { cursor: 'resume-dormant-credential' },
        credentialProfileRef: 'canary',
      }),
    );
    // Nothing was running, so nothing was torn down.
    expect(claude.stopSession).not.toHaveBeenCalled();
  });

  /**
   * archive#3525: `restartCredentialProfileProviderSession` stops a session
   * mid-turn and immediately re-dispatches that same turn — the sharpest
   * case named in the issue, since a user not watching could otherwise be
   * told "your agent needs attention" about a turn Station is transparently
   * retrying on their behalf. `InternalStopSuppression.arm` must arm the
   * OPEN turn's id before the adapter's `stopSession` runs, so
   * `consumeInternalStopSuppression` can later report it as suppressed
   * exactly once.
   *
   * Fix round (BLOCKING 1): the fixture is a realistic multi-turn thread —
   * turn 1 completes with a `session.state-changed` on either side, THEN
   * turn 2 opens and is still running — not a single bare `turn.started`,
   * which is a shape no real adapter produces (bedrock/claude/codex all
   * publish `session.state-changed` around turns) and which let the original
   * version of this test pass while arming the WRONG (closed, turn-1) id on
   * any thread past its first prompted turn.
   */
  test('arms internal-stop suppression for the actually-open SECOND turn, not the closed first one, before tearing down a credential-profile session mid-turn', async () => {
    const adapter = new FakeAdapter('claude');
    const restartService = new OrchestrationService({
      adapterRegistry: createRegistry([adapter]),
      eventBus,
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    const threadId = 'credential-restart-second-turn-open';
    await restartService.dispatch({
      type: 'startSession',
      input: { threadId, provider: 'claude' },
    });
    const now = () => new Date().toISOString();
    eventStore.appendEvent({
      eventId: 'turn-1-started',
      provider: 'claude',
      threadId,
      turnId: 'turn-1',
      createdAt: now(),
      method: 'turn.started',
      prompt: 'first prompt',
    });
    eventStore.appendEvent({
      eventId: 'turn-1-running',
      provider: 'claude',
      threadId,
      createdAt: now(),
      method: 'session.state-changed',
      sessionId: threadId,
      from: 'idle',
      to: 'running',
    });
    eventStore.appendEvent({
      eventId: 'turn-1-completed',
      provider: 'claude',
      threadId,
      turnId: 'turn-1',
      createdAt: now(),
      method: 'turn.completed',
      finishReason: 'stop',
    });
    eventStore.appendEvent({
      eventId: 'turn-1-idle',
      provider: 'claude',
      threadId,
      createdAt: now(),
      method: 'session.state-changed',
      sessionId: threadId,
      from: 'running',
      to: 'idle',
    });
    eventStore.appendEvent({
      eventId: 'turn-2-started',
      provider: 'claude',
      threadId,
      turnId: 'turn-2',
      createdAt: now(),
      method: 'turn.started',
      prompt: 'second prompt, still running when credentials failed',
    });
    eventStore.appendEvent({
      eventId: 'turn-2-running',
      provider: 'claude',
      threadId,
      createdAt: now(),
      method: 'session.state-changed',
      sessionId: threadId,
      from: 'idle',
      to: 'running',
    });

    await (
      restartService as unknown as {
        restartCredentialProfileProviderSession(input: {
          threadId: string;
          signal: AbortSignal;
          credentialProfileRef?: string;
        }): Promise<unknown>;
      }
    ).restartCredentialProfileProviderSession({
      threadId,
      signal: new AbortController().signal,
      credentialProfileRef: 'canary',
    });

    expect(adapter.stopSession).toHaveBeenCalledWith(threadId);
    // The genuinely open turn (turn-2) is armed...
    expect(restartService.consumeInternalStopSuppression('turn-2')).toBe(true);
    // ...turn-1 (closed 4 events ago) is NOT — the pre-fix defect armed
    // exactly this id instead.
    expect(restartService.consumeInternalStopSuppression('turn-1')).toBe(false);
    // Consume-once: re-checking turn-2 after it was already consumed above
    // returns false, and an unrelated id was never armed at all.
    expect(restartService.consumeInternalStopSuppression('turn-2')).toBe(false);
    expect(
      restartService.consumeInternalStopSuppression('unrelated-turn'),
    ).toBe(false);
    await restartService.shutdown();
  });

  /**
   * archive#3525 fix round: the reviewer's exact ask — "one test standing up
   * the real `OrchestrationService` and the real
   * `wireTurnCompletionNotifications` together on a two-turn thread." Every
   * other test in this arc proved arming with a stub consumer or proved
   * consumption with a stub producer; nothing exercised BOTH real halves
   * together, which is precisely why BLOCKING 1 (arming the wrong turn id on
   * a multi-turn thread) survived. This wires the genuine listener from
   * `turn-completion-notifications.ts` onto a real `EventBus`, drives a real
   * codex-shaped `stopSession` (publishes `runtime.error` for the open turn
   * before `session.exited`, mirroring `codex-adapter-transport.ts`'s
   * `publishOrphanedTurnFailure`), and asserts NO push is scheduled for a
   * user who is not watching — the exact scenario archive#3525 exists to
   * fix, proven end-to-end rather than by reading either half in isolation.
   */
  test('BOTH REAL HALVES: a credential-profile restart on a two-turn thread schedules no "needs attention" push for the internal stop', async () => {
    const adapter = new FakeAdapter('codex');
    const notificationsDir = join(tmp, 'internal-stop-notifications');
    mkdirSync(notificationsDir, { recursive: true });
    const notificationBus = new EventBus();
    const notificationService = new NotificationService(
      notificationBus,
      notificationsDir,
      999_999,
    );
    const presence = new OrchestrationStreamPresence();
    const logger = { warn: vi.fn() };
    const restartService = new OrchestrationService({
      adapterRegistry: createRegistry([adapter]),
      eventBus: notificationBus,
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    // The real listener from turn-completion-notifications.ts, on the SAME
    // bus the OrchestrationService publishes to — not a stub consumer.
    wireTurnCompletionNotifications(
      notificationBus,
      restartService,
      presence,
      notificationService,
      logger,
    );
    await notificationService.start();

    const threadId = 'both-real-halves-credential-restart';
    await restartService.dispatch({
      type: 'startSession',
      input: { threadId, provider: 'codex' },
    });
    const now = () => new Date().toISOString();
    eventStore.appendEvent({
      eventId: 'both-halves-turn-1-started',
      provider: 'codex',
      threadId,
      turnId: 'turn-1',
      createdAt: now(),
      method: 'turn.started',
      prompt: 'first prompt',
    });
    eventStore.appendEvent({
      eventId: 'both-halves-turn-1-running',
      provider: 'codex',
      threadId,
      createdAt: now(),
      method: 'session.state-changed',
      sessionId: threadId,
      from: 'idle',
      to: 'running',
    });
    eventStore.appendEvent({
      eventId: 'both-halves-turn-1-completed',
      provider: 'codex',
      threadId,
      turnId: 'turn-1',
      createdAt: now(),
      method: 'turn.completed',
      finishReason: 'stop',
    });
    eventStore.appendEvent({
      eventId: 'both-halves-turn-1-idle',
      provider: 'codex',
      threadId,
      createdAt: now(),
      method: 'session.state-changed',
      sessionId: threadId,
      from: 'running',
      to: 'idle',
    });
    eventStore.appendEvent({
      eventId: 'both-halves-turn-2-started',
      provider: 'codex',
      threadId,
      turnId: 'turn-2',
      createdAt: now(),
      method: 'turn.started',
      prompt: 'second prompt, still running when credentials failed',
    });
    eventStore.appendEvent({
      eventId: 'both-halves-turn-2-running',
      provider: 'codex',
      threadId,
      createdAt: now(),
      method: 'session.state-changed',
      sessionId: threadId,
      from: 'idle',
      to: 'running',
    });

    // Mirrors codex-adapter-transport.ts's real stopSession publishing the
    // open turn's runtime.error terminal. Two disclosed boundaries this
    // mock does NOT exercise, deliberately: (1) it never publishes
    // `session.exited` at all (the real adapter's `runtime.error` truly
    // precedes it, but nothing here asserts that ordering); (2) `turnId:
    // 'turn-2'` is HARDCODED to match this fixture's seeded open turn,
    // where the real codex synthesis reads its own in-memory
    // `record.activeTurnId` — so this proves arm and synthesis agree BY
    // CONSTRUCTION, and cannot exercise the residual gap where a durable
    // read and the adapter's own in-memory state could diverge (see
    // `internalStopTurnIds`'s doc in internal-stop-suppression.ts).
    adapter.stopSession.mockImplementationOnce(async (stoppedThreadId) => {
      adapter.events.push({
        eventId: 'both-halves-orphaned-runtime-error',
        provider: 'codex',
        threadId: stoppedThreadId,
        turnId: 'turn-2',
        createdAt: now(),
        method: 'runtime.error',
        severity: 'error',
        message: 'Codex session was stopped before the turn finished.',
        code: 'codex-turn-orphaned',
      });
      adapter.sessions.delete(stoppedThreadId);
    });

    await (
      restartService as unknown as {
        restartCredentialProfileProviderSession(input: {
          threadId: string;
          signal: AbortSignal;
          credentialProfileRef?: string;
        }): Promise<unknown>;
      }
    ).restartCredentialProfileProviderSession({
      threadId,
      signal: new AbortController().signal,
      credentialProfileRef: 'canary',
    });

    await waitFor(
      () => eventStore.listEvents(threadId),
      (events) =>
        events.some(
          (event) =>
            event.payload.method === 'runtime.error' &&
            event.payload.turnId === 'turn-2',
        ),
    );
    await notificationService.drainAsyncDispatch();

    // The genuine end-to-end assertion: no "Your agent needs attention"
    // (or any) push for this internal-machinery stop.
    expect(await notificationService.list()).toHaveLength(0);

    await notificationService.shutdown();
    await restartService.shutdown();
  });

  /**
   * archive#3525 fix round FIX 1 (BLOCKING, the discriminating fixture named
   * by review): the arm in `restartCredentialProfileProviderSession` used to
   * be unconditional, but the reason suppression is correct is conditional —
   * "Station is about to transparently re-dispatch the exact same turn" is
   * only true when the restart SUCCEEDS. A path entered because credentials
   * just failed is exactly where `adapter.startSession` failing AGAIN is a
   * likely outcome, not an edge case. Without the fix, this scenario traded
   * archive#3525's false positive for a false negative on the SAME surface: a real
   * failure (nothing is retrying any more) would be silently swallowed.
   *
   * A first version of this fix (rescind the armed Set entry in a catch
   * block) does NOT work: the generic listener's suppression check reliably
   * wins its race against this multi-`await` failure path (proven — see
   * `internalStopTurnIds`'s doc), so by the time the catch runs the push is
   * already gone. The real fix is `SERVER_EVENTS.INTERNAL_STOP_REDISPATCH_FAILED`
   * plus `wireInternalStopRedispatchFailureNotifications`, wired here
   * alongside the generic listener exactly as `runtime-route-support.ts`
   * wires both in production.
   */
  test('BOTH REAL HALVES: a credential-profile restart that itself FAILS still pushes "needs attention" via the explicit redispatch-failure channel', async () => {
    const adapter = new FakeAdapter('codex');
    const notificationsDir = join(tmp, 'internal-stop-notifications-failed');
    mkdirSync(notificationsDir, { recursive: true });
    const notificationBus = new EventBus();
    const notificationService = new NotificationService(
      notificationBus,
      notificationsDir,
      999_999,
    );
    const presence = new OrchestrationStreamPresence();
    const logger = { warn: vi.fn() };
    const restartService = new OrchestrationService({
      adapterRegistry: createRegistry([adapter]),
      eventBus: notificationBus,
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    wireTurnCompletionNotifications(
      notificationBus,
      restartService,
      presence,
      notificationService,
      logger,
    );
    wireInternalStopRedispatchFailureNotifications(
      notificationBus,
      restartService,
      presence,
      notificationService,
      logger,
    );
    await notificationService.start();

    const threadId = 'both-real-halves-credential-restart-failure';
    await restartService.dispatch({
      type: 'startSession',
      input: { threadId, provider: 'codex' },
    });
    const now = () => new Date().toISOString();
    eventStore.appendEvent({
      eventId: 'failed-restart-turn-1-started',
      provider: 'codex',
      threadId,
      turnId: 'turn-1',
      createdAt: now(),
      method: 'turn.started',
      prompt: 'first prompt',
    });
    eventStore.appendEvent({
      eventId: 'failed-restart-turn-1-completed',
      provider: 'codex',
      threadId,
      turnId: 'turn-1',
      createdAt: now(),
      method: 'turn.completed',
      finishReason: 'stop',
    });
    eventStore.appendEvent({
      eventId: 'failed-restart-turn-2-started',
      provider: 'codex',
      threadId,
      turnId: 'turn-2',
      createdAt: now(),
      method: 'turn.started',
      prompt: 'second prompt, still running when credentials failed again',
    });

    // Same codex-shaped stopSession as the success case above, with the
    // same two disclosed boundaries (no session.exited, hardcoded turnId —
    // see that test's comment).
    adapter.stopSession.mockImplementationOnce(async (stoppedThreadId) => {
      adapter.events.push({
        eventId: 'failed-restart-orphaned-runtime-error',
        provider: 'codex',
        threadId: stoppedThreadId,
        turnId: 'turn-2',
        createdAt: now(),
        method: 'runtime.error',
        severity: 'error',
        message: 'Codex session was stopped before the turn finished.',
        code: 'codex-turn-orphaned',
      });
      adapter.sessions.delete(stoppedThreadId);
    });
    // The credentials that triggered this restart are STILL bad — the
    // adapter's own startSession (inside restartCredentialProfileProviderSession,
    // AFTER the initial setup dispatch above already consumed the default
    // implementation once) rejects again.
    adapter.startSession.mockRejectedValueOnce(
      new Error('credential still invalid'),
    );

    await expect(
      (
        restartService as unknown as {
          restartCredentialProfileProviderSession(input: {
            threadId: string;
            signal: AbortSignal;
            credentialProfileRef?: string;
          }): Promise<unknown>;
        }
      ).restartCredentialProfileProviderSession({
        threadId,
        signal: new AbortController().signal,
        credentialProfileRef: 'canary',
      }),
    ).rejects.toThrow('credential still invalid');

    await waitFor(
      () => eventStore.listEvents(threadId),
      (events) =>
        events.some(
          (event) =>
            event.payload.method === 'runtime.error' &&
            event.payload.turnId === 'turn-2',
        ),
    );
    await notificationService.drainAsyncDispatch();

    // The discriminating assertion: the restart failed, nothing is
    // retrying turn-2, so the orphaned runtime.error must NOT be
    // suppressed — the user needs to know.
    const notifications = await notificationService.list();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toEqual(
      expect.objectContaining({
        category: 'turn-failed',
        title: 'Your agent needs attention',
      }),
    );

    await notificationService.shutdown();
    await restartService.shutdown();
  });

  test('the credential-restart loop guard is wired from the coordinator to the live restarting set (slice 7 I5 guard)', () => {
    // `credentialRecoveryRestartingThreads` had ZERO test references
    // repo-wide: neutering `setRestarting`/`isCredentialRestarting` was
    // invisible (slice-7 plan I5). This pins the coordinator's option to
    // the live set; the double-restart skip it feeds is
    // session-recovery-coordinator.ts's own concern.
    // Slice 7 moved the set into CredentialProfileRecovery (one-way); the
    // coordinator's option must reach the SAME instance's setRestarting
    // writes.
    const internals = service as unknown as {
      credentialProfileRecovery: {
        setRestarting(threadId: string, restarting: boolean): void;
        isRestarting(threadId: string): boolean;
      };
      recoveryCoordinator?: {
        options: { isCredentialRestarting?: (threadId: string) => boolean };
      };
    };
    const isRestarting =
      internals.recoveryCoordinator?.options.isCredentialRestarting;
    expect(isRestarting).toBeDefined();
    expect(isRestarting?.('loop-guard-thread')).toBe(false);
    internals.credentialProfileRecovery.setRestarting(
      'loop-guard-thread',
      true,
    );
    expect(isRestarting?.('loop-guard-thread')).toBe(true);
    internals.credentialProfileRecovery.setRestarting(
      'loop-guard-thread',
      false,
    );
    expect(isRestarting?.('loop-guard-thread')).toBe(false);
    // The WRITER edge — the ctor's `setRestarting` closure handed to
    // createCredentialRecoveryModule — is a closure no runtime probe can
    // reach without driving a full recovery dispatch, so it is pinned as a
    // source invariant: the option must forward to the module's method
    // (review round 1: neutering that one closure would leave isRestarting
    // permanently false and let a credential-restart loop run unbounded).
    const ctorSource = readFileSync(
      join(__dirname, '..', 'orchestration-service.ts'),
      'utf8',
    );
    expect(ctorSource).toContain(
      'setRestarting: (threadId, restarting) =>\n' +
        '            this.credentialProfileRecovery.setRestarting(threadId, restarting),',
    );
  });

  test('BOTH REAL HALVES: a restart whose REPLAY dispatch fails still pushes "needs attention" for the stopped turn (slice 7 I7 guard)', async () => {
    // The sibling test above fails inside startSession (the C6e catch);
    // no test drove a sendTurn rejection AFTER a successful restart, so
    // deleting restartCredentialProfileRecoverySession's own catch (the
    // FIX 1 channel) was invisible (slice-7 plan I7).
    const adapter = new FakeAdapter('codex');
    const notificationsDir = join(tmp, 'internal-stop-notifications-replay');
    mkdirSync(notificationsDir, { recursive: true });
    const notificationBus = new EventBus();
    const notificationService = new NotificationService(
      notificationBus,
      notificationsDir,
      999_999,
    );
    const presence = new OrchestrationStreamPresence();
    const logger = { warn: vi.fn() };
    const restartService = new OrchestrationService({
      adapterRegistry: createRegistry([adapter]),
      eventBus: notificationBus,
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    wireTurnCompletionNotifications(
      notificationBus,
      restartService,
      presence,
      notificationService,
      logger,
    );
    wireInternalStopRedispatchFailureNotifications(
      notificationBus,
      restartService,
      presence,
      notificationService,
      logger,
    );
    await notificationService.start();

    const threadId = 'both-real-halves-replay-dispatch-failure';
    await restartService.dispatch({
      type: 'startSession',
      input: { threadId, provider: 'codex' },
    });
    const now = () => new Date().toISOString();
    eventStore.appendEvent({
      eventId: 'replay-fail-turn-1-started',
      provider: 'codex',
      threadId,
      turnId: 'turn-1',
      createdAt: now(),
      method: 'turn.started',
      prompt: 'running when credentials failed',
    });
    adapter.stopSession.mockImplementationOnce(async (stoppedThreadId) => {
      adapter.events.push({
        eventId: 'replay-fail-orphaned-runtime-error',
        provider: 'codex',
        threadId: stoppedThreadId,
        turnId: 'turn-1',
        createdAt: now(),
        method: 'runtime.error',
        severity: 'error',
        message: 'Codex session was stopped before the turn finished.',
        code: 'codex-turn-orphaned',
      });
      adapter.sessions.delete(stoppedThreadId);
    });
    // The restart itself SUCCEEDS (default startSession), but the replayed
    // turn cannot be dispatched.
    adapter.sendTurn.mockRejectedValueOnce(new Error('replay dispatch failed'));

    await expect(
      (
        restartService as unknown as {
          restartCredentialProfileRecoverySession(input: {
            threadId: string;
            input: string;
            recoveryCorrelationId: string;
            signal: AbortSignal;
            credentialProfileRef?: string;
          }): Promise<unknown>;
        }
      ).restartCredentialProfileRecoverySession({
        threadId,
        input: 'replayed prompt',
        recoveryCorrelationId: 'replay-fail-correlation',
        signal: new AbortController().signal,
        credentialProfileRef: 'canary',
      }),
    ).rejects.toThrow('replay dispatch failed');

    await waitFor(
      () => eventStore.listEvents(threadId),
      (events) =>
        events.some(
          (event) =>
            event.payload.method === 'runtime.error' &&
            event.payload.turnId === 'turn-1',
        ),
    );
    await notificationService.drainAsyncDispatch();

    const notifications = await notificationService.list();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toEqual(
      expect.objectContaining({
        category: 'turn-failed',
        title: 'Your agent needs attention',
      }),
    );

    await notificationService.shutdown();
    await restartService.shutdown();
  });

  test('independent review HIGH-1: restartCredentialProfileRecoverySession composes ambientContext into the adapter wire input (a pending first-turn instructions receipt riding it must not be silently dropped on a credential-profile recovery replay)', async () => {
    // `CredentialProfileRecovery.restartRecoverySession` used to call
    // `adapter.sendTurn({ input: input.input, ... })` directly, bypassing
    // the SAME ambientContext choke point (`composeAmbientSendTurnInput`)
    // the ordinary `dispatch({type:'sendTurn'})` path composes through — so
    // a pending first-turn instructions receipt (station#895 wave C), which
    // rides `ambientContext` exactly like ordinary ambient context, was
    // silently dropped on a credential-profile recovery replay while the
    // delegate-seam receipt still read the prompt 'delivered' (derived from
    // `turn.started` existing, which this call path itself creates).
    const adapter = new FakeAdapter('codex');
    const restartService = new OrchestrationService({
      adapterRegistry: createRegistry([adapter]),
      eventBus,
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    const threadId = 'credential-restart-first-turn-instructions';
    await restartService.dispatch({
      type: 'startSession',
      input: { threadId, provider: 'codex' },
    });
    adapter.sendTurn.mockClear();

    await (
      restartService as unknown as {
        restartCredentialProfileRecoverySession(input: {
          threadId: string;
          input: string;
          ambientContext?: string;
          recoveryCorrelationId: string;
          signal: AbortSignal;
          credentialProfileRef?: string;
        }): Promise<unknown>;
      }
    ).restartCredentialProfileRecoverySession({
      threadId,
      input: 'Hello',
      ambientContext: 'Be terse.',
      recoveryCorrelationId: 'first-turn-restart-correlation',
      signal: new AbortController().signal,
      credentialProfileRef: 'canary',
    });

    expect(adapter.sendTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        // Model-facing input carries the composed text, exactly like the
        // ordinary dispatch path (#685's composeAmbientSendTurnInput).
        input: 'Be terse.\nHello',
        // Transcript-facing text stays the typed text alone.
        displayInput: 'Hello',
        // Relay-only passthrough is preserved for the station-agent relay.
        ambientContext: 'Be terse.',
      }),
    );

    await restartService.shutdown();
  });

  /**
   * archive#3525 fix round MEDIUM 1: the arm and the `stopSession` call now
   * get their OWN `try`/`catch`, separate from the rest of the restart. If
   * `stopSession` itself rejects, the session was NEVER torn down (e.g.
   * codex's real `stopSession` rethrows when `terminateRecord` fails,
   * restores `record.stopped = false`, and never reaches
   * `publishOrphanedTurnFailure` — the turn keeps running), so no
   * `INTERNAL_STOP_REDISPATCH_FAILED` should fire, and the suppression must
   * be rescinded so the turn's own EVENTUAL genuine terminal (this test
   * simulates a normal completion) reaches the user normally.
   */
  test('BOTH REAL HALVES: a stopSession REJECTION pushes nothing, and the still-running turn still gets its normal completion push', async () => {
    const adapter = new FakeAdapter('codex');
    const notificationsDir = join(
      tmp,
      'internal-stop-notifications-teardown-failed',
    );
    mkdirSync(notificationsDir, { recursive: true });
    const notificationBus = new EventBus();
    const notificationService = new NotificationService(
      notificationBus,
      notificationsDir,
      999_999,
    );
    const presence = new OrchestrationStreamPresence();
    const logger = { warn: vi.fn() };
    const restartService = new OrchestrationService({
      adapterRegistry: createRegistry([adapter]),
      eventBus: notificationBus,
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    wireTurnCompletionNotifications(
      notificationBus,
      restartService,
      presence,
      notificationService,
      logger,
    );
    wireInternalStopRedispatchFailureNotifications(
      notificationBus,
      restartService,
      presence,
      notificationService,
      logger,
    );
    await notificationService.start();

    const threadId = 'both-real-halves-teardown-failed';
    await restartService.dispatch({
      type: 'startSession',
      input: { threadId, provider: 'codex' },
    });
    const now = () => new Date().toISOString();
    eventStore.appendEvent({
      eventId: 'teardown-failed-turn-1-started',
      provider: 'codex',
      threadId,
      turnId: 'turn-1',
      createdAt: now(),
      method: 'turn.started',
      prompt: 'first prompt',
    });
    eventStore.appendEvent({
      eventId: 'teardown-failed-turn-1-completed',
      provider: 'codex',
      threadId,
      turnId: 'turn-1',
      createdAt: now(),
      method: 'turn.completed',
      finishReason: 'stop',
    });
    eventStore.appendEvent({
      eventId: 'teardown-failed-turn-2-started',
      provider: 'codex',
      threadId,
      turnId: 'turn-2',
      createdAt: now(),
      method: 'turn.started',
      prompt: 'second prompt, still running when credentials failed',
    });

    // stopSession itself fails — mirrors codex's real stopSession rethrowing
    // when terminateRecord fails: NOTHING is torn down, and no
    // runtime.error is ever published for turn-2 (it is still running).
    adapter.stopSession.mockImplementationOnce(async () => {
      throw new Error('failed to terminate the codex process tree');
    });

    await expect(
      (
        restartService as unknown as {
          restartCredentialProfileProviderSession(input: {
            threadId: string;
            signal: AbortSignal;
            credentialProfileRef?: string;
          }): Promise<unknown>;
        }
      ).restartCredentialProfileProviderSession({
        threadId,
        signal: new AbortController().signal,
        credentialProfileRef: 'canary',
      }),
    ).rejects.toThrow('failed to terminate the codex process tree');

    await notificationService.drainAsyncDispatch();
    // The discriminating assertion: teardown failed, so nothing was ever
    // stopped — no "needs attention" push for a turn that is still alive.
    expect(await notificationService.list()).toHaveLength(0);

    // The turn was never actually stopped, so it goes on to complete
    // normally through the ordinary pipeline — proving the suppression was
    // RESCINDED (not left standing, which would have swallowed this too).
    adapter.events.push({
      eventId: 'teardown-failed-turn-2-completed',
      provider: 'codex',
      threadId,
      turnId: 'turn-2',
      createdAt: now(),
      method: 'turn.completed',
      finishReason: 'stop',
    });
    await waitFor(
      () => eventStore.listEvents(threadId),
      (events) =>
        events.some(
          (event) =>
            event.payload.method === 'turn.completed' &&
            event.payload.turnId === 'turn-2',
        ),
    );
    await notificationService.drainAsyncDispatch();
    const notifications = await notificationService.list();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toEqual(
      expect.objectContaining({
        category: 'turn-completed',
        title: 'Your agent finished',
      }),
    );

    await notificationService.shutdown();
    await restartService.shutdown();
  });

  test('does not arm internal-stop suppression when the credential-profile session has no open turn', async () => {
    const adapter = new FakeAdapter('claude');
    const restartService = new OrchestrationService({
      adapterRegistry: createRegistry([adapter]),
      eventBus,
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    const threadId = 'credential-restart-idle';
    await restartService.dispatch({
      type: 'startSession',
      input: { threadId, provider: 'claude' },
    });

    await (
      restartService as unknown as {
        restartCredentialProfileProviderSession(input: {
          threadId: string;
          signal: AbortSignal;
          credentialProfileRef?: string;
        }): Promise<unknown>;
      }
    ).restartCredentialProfileProviderSession({
      threadId,
      signal: new AbortController().signal,
      credentialProfileRef: 'canary',
    });

    expect(adapter.stopSession).toHaveBeenCalledWith(threadId);
    // No turn was open, so nothing should have been armed at all — a real
    // completion notification for a LATER turn on this thread must not find
    // a stray suppressed entry.
    expect(restartService.consumeInternalStopSuppression('claude-turn')).toBe(
      false,
    );
    await restartService.shutdown();
  });

  test('credential-profile replay resolves persisted agent and delegation before the replayed turn (#2732)', async () => {
    const adapter = new FakeAdapter('claude');
    const resolvedAgent = { slug: 'delegated-agent' };
    const resolveSessionAgent = vi.fn(
      async (input: ProviderSessionStartInput) => ({
        ...input,
        agent: resolvedAgent,
      }),
    );
    const restartService = new OrchestrationService({
      adapterRegistry: createRegistry([adapter]),
      eventBus,
      eventStore,
      resolveSessionAgent,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    const threadId = 'credential-restart-pre-tool-policy';
    const delegation = { taskId: 'delegated-task', denyApprovals: true };
    await restartService.dispatch({
      type: 'startSession',
      input: {
        threadId,
        provider: 'claude',
        metadata: { agentSlug: 'delegated-agent', delegation },
      },
    });
    // Credential restart must use the persisted start contract, rather than
    // the transient in-memory session. Seed it explicitly so this regression
    // remains deterministic regardless of adapter event-consumer timing.
    eventStore.appendEvent({
      eventId: 'credential-restart-pre-tool-started',
      provider: 'claude',
      threadId,
      createdAt: '2026-08-14T00:00:00.000Z',
      method: 'session.started',
      sessionId: threadId,
      metadata: { agentSlug: 'delegated-agent', delegation },
    } as CanonicalRuntimeEvent);
    adapter.startSession.mockClear();
    resolveSessionAgent.mockClear();

    const started = adapter.startSession.getMockImplementation()!;
    const lifecycle: string[] = [];
    adapter.startSession.mockImplementation(async (startInput) => {
      // Claude installs the shared PreToolUse evaluator from this resolved
      // start input. Record this seam so replay cannot precede that install.
      expect(startInput).toMatchObject({
        agent: resolvedAgent,
        metadata: { agentSlug: 'delegated-agent', delegation },
      });
      lifecycle.push('pre-tool-installed');
      return started(startInput);
    });
    adapter.sendTurn.mockImplementation(async (turn) => {
      expect(lifecycle).toEqual(['pre-tool-installed']);
      lifecycle.push('replayed');
      return { threadId: turn.threadId, turnId: 'credential-retry-turn' };
    });

    await (
      restartService as unknown as {
        restartCredentialProfileRecoverySession(input: {
          threadId: string;
          input: string;
          recoveryCorrelationId: string;
          signal: AbortSignal;
          credentialProfileRef?: string;
        }): Promise<unknown>;
      }
    ).restartCredentialProfileRecoverySession({
      threadId,
      input: 'replay after credential recovery',
      recoveryCorrelationId: 'credential-retry-2732',
      credentialProfileRef: 'credential-profile-2732',
      signal: new AbortController().signal,
    });

    expect(resolveSessionAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId,
        provider: 'claude',
        metadata: { agentSlug: 'delegated-agent', delegation },
      }),
      undefined,
    );
    expect(lifecycle).toEqual(['pre-tool-installed', 'replayed']);
    await restartService.shutdown();
  });

  test.each([
    ['missing', async () => null],
    [
      'load failure',
      async () => {
        throw new Error('agent spec load unavailable');
      },
    ],
  ])(
    'credential-profile replay fails closed when its persisted session agent has %s (#2732)',
    async (caseName, loadAgentSpec) => {
      const adapter = new FakeAdapter('claude');
      const resolveSessionAgent = createSessionAgentResolver({
        loadAgentSpec,
        resolveToolServer: async () => null,
        resolveSkillDir: async () => null,
      });
      const restartService = new OrchestrationService({
        adapterRegistry: createRegistry([adapter]),
        eventBus,
        eventStore,
        resolveSessionAgent,
        logger: { debug: vi.fn(), warn: vi.fn() },
      });
      const threadId = `credential-restart-agent-resolution-${caseName.replaceAll(' ', '-')}`;
      await restartService.dispatch({
        type: 'startSession',
        input: {
          threadId,
          provider: 'claude',
        },
      });
      eventStore.appendEvent({
        eventId: `${threadId}-started`,
        provider: 'claude',
        threadId,
        createdAt: '2026-08-14T00:00:00.000Z',
        method: 'session.started',
        sessionId: threadId,
        metadata: { agentSlug: 'unavailable-agent' },
      } as CanonicalRuntimeEvent);
      adapter.startSession.mockClear();
      adapter.sendTurn.mockClear();

      await expect(
        (
          restartService as unknown as {
            restartCredentialProfileRecoverySession(input: {
              threadId: string;
              input: string;
              recoveryCorrelationId: string;
              signal: AbortSignal;
            }): Promise<unknown>;
          }
        ).restartCredentialProfileRecoverySession({
          threadId,
          input: 'must not replay',
          recoveryCorrelationId: 'credential-retry-resolution-failure',
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(
        "Agent 'unavailable-agent' could not be resolved to an authored Agent definition",
      );

      expect(adapter.startSession).not.toHaveBeenCalled();
      expect(adapter.sendTurn).not.toHaveBeenCalled();
      await restartService.shutdown();
    },
  );

  test('omits agent slug and user id when the configured session reported none (#3082)', async () => {
    // The write site itself. monitoringContextFor used to substitute the
    // literal 'unknown' for both; reverting that change passed every other
    // test in the repo, because only the EMITTER's behaviour was covered —
    // nothing proved the service stopped manufacturing the value.
    const adapter = new FakeAdapter('claude');
    const persisted: Record<string, unknown>[] = [];
    const monitoringEmitter = new MonitoringEmitter(
      new NodeEventEmitter(),
      async (event) => {
        persisted.push(event);
      },
    );
    const service = new RawOrchestrationService({
      adapterRegistry: createRegistry([adapter]),
      eventBus,
      eventStore,
      monitoringEmitter,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    const threadId = 'agentless-monitoring';
    await service.dispatch({
      type: 'startSession',
      input: { threadId, provider: 'claude' },
    });
    eventStore.appendEvent({
      eventId: 'agentless-configured',
      provider: 'claude',
      threadId,
      createdAt: new Date().toISOString(),
      method: 'session.configured',
      sessionId: threadId,
      // No agentSlug, no userId — an agentless configured session.
      metadata: { conversationId: 'conversation-agentless' },
    } as CanonicalRuntimeEvent);
    (
      service as unknown as {
        monitoringBridge: {
          onTurnDispatched(input: {
            provider: string;
            threadId: string;
            turnId: string;
            prompt: string;
          }): void;
        };
      }
    ).monitoringBridge.onTurnDispatched({
      provider: 'claude',
      threadId,
      turnId: 'turn-agentless',
      prompt: 'hello',
    });
    await monitoringEmitter.flush();

    expect(persisted).toHaveLength(1);
    expect('station.agent.slug' in persisted[0]!).toBe(false);
    expect('station.user.id' in persisted[0]!).toBe(false);
    expect(JSON.stringify(persisted[0])).not.toContain('unknown');
    await service.shutdown();
  });

  test('registers a credential-profile recovery replay with monitoring before its events arrive', async () => {
    const adapter = new FakeAdapter('claude');
    const persisted: Record<string, unknown>[] = [];
    const monitoringEmitter = new MonitoringEmitter(
      new NodeEventEmitter(),
      async (event) => {
        persisted.push(event);
      },
    );
    const restartService = new RawOrchestrationService({
      adapterRegistry: createRegistry([adapter]),
      eventBus,
      eventStore,
      monitoringEmitter,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    const threadId = 'credential-monitoring-replay';
    await restartService.dispatch({
      type: 'startSession',
      input: { threadId, provider: 'claude' },
    });
    eventStore.appendEvent({
      eventId: 'credential-monitoring-configured',
      provider: 'claude',
      threadId,
      createdAt: new Date().toISOString(),
      method: 'session.configured',
      sessionId: threadId,
      metadata: {
        agentSlug: 'claude',
        conversationId: 'conversation-recovered',
        userId: 'u1',
      },
    } as CanonicalRuntimeEvent);
    await (
      restartService as unknown as {
        restartCredentialProfileRecoverySession(input: {
          threadId: string;
          input: string;
          recoveryCorrelationId: string;
          signal: AbortSignal;
        }): Promise<unknown>;
      }
    ).restartCredentialProfileRecoverySession({
      threadId,
      input: 'replay prompt',
      recoveryCorrelationId: 'recovery-1',
      signal: new AbortController().signal,
    });
    (
      restartService as unknown as {
        monitoringBridge: {
          onRuntimeEvent(event: CanonicalRuntimeEvent): void;
        };
      }
    ).monitoringBridge.onRuntimeEvent({
      eventId: 'credential-monitoring-completed',
      provider: 'claude',
      threadId,
      turnId: 'claude-turn',
      createdAt: new Date().toISOString(),
      method: 'turn.completed',
      outputText: 'recovered',
      finishReason: 'stop',
    } as CanonicalRuntimeEvent);
    await monitoringEmitter.flush();
    expect(persisted.map((event) => event['span.kind'])).toEqual([
      'start',
      'end',
    ]);
    await restartService.shutdown();
  });

  test('rejects an ACP model override before any adapter readiness or discovery interaction', async () => {
    const acp = new FakeAdapter('acp');
    acp.metadata.modelLaunch = {
      defaultAtStart: 'engine-selected',
      omissionAtResume: 'engine-selected',
      omissionPerTurn: 'engine-selected',
      overrideAtStart: false,
      overrideAtResume: false,
      overridePerTurn: false,
    };
    const acpService = new OrchestrationService({
      adapterRegistry: createRegistry([acp]),
      eventBus,
      eventStore,
      flowRunService,
      listProjects: () => configuredProjects,
      workflowSidecarService,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });

    const readiness = vi.spyOn(acp, 'getPrerequisites');
    await expect(
      acpService.dispatchWithReceipt({
        type: 'startSession',
        input: {
          threadId: 'acp-model-override',
          provider: 'acp',
          modelId: 'not-applied-by-acp',
        },
      }),
    ).rejects.toMatchObject({
      message: 'model-override-unsupported: override-unsupported',
      receipt: expect.objectContaining({ status: 'rejected' }),
    });

    expect(acp.startSession).not.toHaveBeenCalled();
    expect(readiness).not.toHaveBeenCalled();
    expect(acp.listModels).not.toHaveBeenCalled();
    expect(modelLaunchResolutionTotal.add).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        provider: 'acp',
        lifecycle: 'start',
        outcome: 'rejected',
        reason: 'override-unsupported',
      }),
    );
  });

  test('rejects a model override on a repeated ACP start instead of accepting the existing session', async () => {
    const acp = new FakeAdapter('acp');
    const acpService = new OrchestrationService({
      adapterRegistry: createRegistry([acp]),
      eventBus,
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    const threadId = 'existing-acp-model-override';

    await acpService.dispatch({
      type: 'startSession',
      input: { threadId, provider: 'acp' },
    });

    await expect(
      acpService.dispatchWithReceipt({
        type: 'startSession',
        input: {
          threadId,
          provider: 'acp',
          modelId: 'not-applied-by-acp',
        },
      }),
    ).rejects.toMatchObject({
      message: 'model-override-unsupported: override-unsupported',
      receipt: expect.objectContaining({ status: 'rejected' }),
    });
    expect(acp.startSession).toHaveBeenCalledTimes(1);
    expect(modelLaunchResolutionTotal.add).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        provider: 'acp',
        lifecycle: 'start',
        outcome: 'rejected',
        reason: 'override-unsupported',
      }),
    );
  });

  test('rejects an exact-match ACP selector when the existing session only reported that model', async () => {
    const acp = new FakeAdapter('acp');
    acp.startSession.mockImplementation(async (input) => {
      const now = new Date().toISOString();
      return {
        provider: 'acp',
        threadId: input.threadId,
        status: 'ready',
        model: 'runtime-reported-model',
        createdAt: now,
        updatedAt: now,
      };
    });
    const acpService = new OrchestrationService({
      adapterRegistry: createRegistry([acp]),
      eventBus,
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    const threadId = 'existing-acp-exact-model';

    await acpService.dispatch({
      type: 'startSession',
      input: { threadId, provider: 'acp' },
    });
    await expect(
      acpService.dispatchWithReceipt({
        type: 'startSession',
        input: { threadId, provider: 'acp', modelId: 'runtime-reported-model' },
      }),
    ).rejects.toMatchObject({
      message: 'model-override-unsupported: override-unsupported',
      receipt: expect.objectContaining({ status: 'rejected' }),
    });
    expect(acp.startSession).toHaveBeenCalledTimes(1);
  });

  test('rejects an exact-match selector for a capability-undeclared legacy adapter', async () => {
    const legacy = new FakeAdapter('claude');
    delete legacy.metadata.modelLaunch;
    legacy.startSession.mockImplementation(async (input) => {
      const now = new Date().toISOString();
      return {
        provider: 'claude',
        threadId: input.threadId,
        status: 'ready',
        model: 'legacy-reported-model',
        createdAt: now,
        updatedAt: now,
      };
    });
    const legacyService = new OrchestrationService({
      adapterRegistry: createRegistry([legacy]),
      eventBus,
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    const threadId = 'existing-legacy-exact-model';

    await legacyService.dispatch({
      type: 'startSession',
      input: { threadId, provider: 'claude' },
    });
    await expect(
      legacyService.dispatchWithReceipt({
        type: 'startSession',
        input: {
          threadId,
          provider: 'claude',
          modelId: 'legacy-reported-model',
        },
      }),
    ).rejects.toMatchObject({
      message: 'model-override-unsupported: override-unsupported',
      receipt: expect.objectContaining({ status: 'rejected' }),
    });
    expect(legacy.startSession).toHaveBeenCalledTimes(1);
  });

  test.each(['', '  \t  '])(
    'treats a blank reattach selector %j as omission',
    async (modelId) => {
      const acp = new FakeAdapter('acp');
      const acpService = new OrchestrationService({
        adapterRegistry: createRegistry([acp]),
        eventBus,
        eventStore,
        logger: { debug: vi.fn(), warn: vi.fn() },
      });
      const threadId = `existing-acp-blank-${modelId.length}`;

      await acpService.dispatch({
        type: 'startSession',
        input: { threadId, provider: 'acp' },
      });
      await expect(
        acpService.dispatch({
          type: 'startSession',
          input: { threadId, provider: 'acp', modelId },
        }),
      ).resolves.toMatchObject({ threadId, provider: 'acp' });
      expect(acp.startSession).toHaveBeenCalledTimes(1);
    },
  );

  test.each(
    (['bedrock', 'ollama'] as const).flatMap((provider) => [
      { provider, label: 'omitted', modelId: undefined },
      { provider, label: 'empty', modelId: '' },
      { provider, label: 'whitespace', modelId: '  \t  ' },
    ]),
  )(
    'accepts an idempotent $label selector on an existing $provider session without resolving a new launch plan',
    async ({ provider, modelId }) => {
      const stationModel = new FakeAdapter(provider);
      stationModel.metadata.modelLaunch = {
        defaultAtStart: 'station-resolved',
        omissionAtResume: 'retain-session-model',
        omissionPerTurn: 'retain-session-model',
        overrideAtStart: true,
        overrideAtResume: true,
        overridePerTurn: true,
        modelConnectionId: `${provider}-runtime`,
      };
      const stationService = new OrchestrationService({
        adapterRegistry: createRegistry([stationModel]),
        eventBus,
        eventStore,
        logger: { debug: vi.fn(), warn: vi.fn() },
      });
      const threadId = `existing-${provider}-${modelId?.length ?? 'omitted'}`;

      await stationService.dispatch({
        type: 'startSession',
        input: { threadId, provider, modelId: 'model-a' },
      });
      await expect(
        stationService.dispatch({
          type: 'startSession',
          input: {
            threadId,
            provider,
            ...(modelId === undefined ? {} : { modelId }),
          },
        }),
      ).resolves.toMatchObject({
        threadId,
        provider,
        model: 'model-a',
      });
      expect(stationModel.startSession).toHaveBeenCalledTimes(1);
    },
  );

  test('rejects a supported adapter model change on reattach instead of pretending to reconfigure it', async () => {
    const connected = new FakeAdapter('claude');
    const connectedService = new OrchestrationService({
      adapterRegistry: createRegistry([connected]),
      eventBus,
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    const threadId = 'existing-supported-model-change';

    await connectedService.dispatch({
      type: 'startSession',
      input: { threadId, provider: 'claude', modelId: 'model-a' },
    });

    await expect(
      connectedService.dispatchWithReceipt({
        type: 'startSession',
        input: { threadId, provider: 'claude', modelId: 'model-b' },
      }),
    ).rejects.toMatchObject({
      message: 'session-reattach-conflict: model-change',
      receipt: expect.objectContaining({ status: 'rejected' }),
    });
    expect(connected.startSession).toHaveBeenCalledTimes(1);
  });

  test.each(['bedrock', 'ollama'] as const)(
    'accepts an exact-match supported %s selector without redispatch',
    async (provider) => {
      const stationModel = new FakeAdapter(provider);
      stationModel.metadata.modelLaunch = {
        defaultAtStart: 'station-resolved',
        omissionAtResume: 'retain-session-model',
        omissionPerTurn: 'retain-session-model',
        overrideAtStart: true,
        overrideAtResume: true,
        overridePerTurn: true,
        modelConnectionId: `${provider}-runtime`,
      };
      const stationService = new OrchestrationService({
        adapterRegistry: createRegistry([stationModel]),
        eventBus,
        eventStore,
        logger: { debug: vi.fn(), warn: vi.fn() },
      });
      const threadId = `existing-${provider}-exact-model`;

      await stationService.dispatch({
        type: 'startSession',
        input: { threadId, provider, modelId: 'model-a' },
      });
      await expect(
        stationService.dispatch({
          type: 'startSession',
          input: { threadId, provider, modelId: 'model-a' },
        }),
      ).resolves.toMatchObject({ threadId, provider, model: 'model-a' });
      expect(stationModel.startSession).toHaveBeenCalledTimes(1);
    },
  );

  test.each(['bedrock', 'ollama'] as const)(
    'rejects a catalog-pending %s selector replacement on reattach',
    async (provider) => {
      const stationModel = new FakeAdapter(provider);
      stationModel.metadata.modelLaunch = {
        defaultAtStart: 'station-resolved',
        omissionAtResume: 'retain-session-model',
        omissionPerTurn: 'retain-session-model',
        overrideAtStart: true,
        overrideAtResume: true,
        overridePerTurn: true,
        modelConnectionId: `${provider}-runtime`,
      };
      const stationService = new OrchestrationService({
        adapterRegistry: createRegistry([stationModel]),
        eventBus,
        eventStore,
        logger: { debug: vi.fn(), warn: vi.fn() },
      });
      const threadId = `existing-${provider}-model-change`;

      await stationService.dispatch({
        type: 'startSession',
        input: { threadId, provider, modelId: 'model-a' },
      });

      await expect(
        stationService.dispatchWithReceipt({
          type: 'startSession',
          input: { threadId, provider, modelId: 'model-b' },
        }),
      ).rejects.toMatchObject({
        message: 'session-reattach-conflict: model-change',
        receipt: expect.objectContaining({ status: 'rejected' }),
      });
      expect(stationModel.startSession).toHaveBeenCalledTimes(1);
    },
  );

  test('rejects modelOptions on reattach even when the adapter normally supports them', async () => {
    const connected = new FakeAdapter('claude');
    const connectedService = new OrchestrationService({
      adapterRegistry: createRegistry([connected]),
      eventBus,
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    const threadId = 'existing-model-options-bypass';

    await connectedService.dispatch({
      type: 'startSession',
      input: { threadId, provider: 'claude', modelId: 'model-a' },
    });

    await expect(
      connectedService.dispatchWithReceipt({
        type: 'startSession',
        input: {
          threadId,
          provider: 'claude',
          modelId: 'model-a',
          modelOptions: { effort: 'high' },
        },
      }),
    ).rejects.toMatchObject({
      message: 'session-reattach-conflict: model-options-not-idempotent',
      receipt: expect.objectContaining({ status: 'rejected' }),
    });
    expect(connected.startSession).toHaveBeenCalledTimes(1);
  });

  test('strips forged model-selection receipts before ACP dispatch, projection, and recovery', async () => {
    const acp = new FakeAdapter('acp');
    acp.startSession.mockImplementation(async (input) => {
      const now = new Date().toISOString();
      // ACP is intentionally a pass-through control plane: this mirrors its
      // session.configured metadata forwarding so the regression proves the
      // public boundary, not just a friendly fake's behavior.
      acp.events.push({
        eventId: randomUUID(),
        provider: 'acp',
        threadId: input.threadId,
        createdAt: now,
        method: 'session.started',
        sessionId: input.threadId,
        metadata: input.metadata,
      });
      acp.events.push({
        eventId: randomUUID(),
        provider: 'acp',
        threadId: input.threadId,
        createdAt: now,
        method: 'session.configured',
        sessionId: input.threadId,
        model: 'metadata-echo-only',
        metadata: input.metadata,
      });
      return {
        provider: 'acp',
        threadId: input.threadId,
        status: 'ready',
        model: 'metadata-echo-only',
        persistSession: true,
        createdAt: now,
        updatedAt: now,
      };
    });
    const acpService = new OrchestrationService({
      adapterRegistry: createRegistry([acp]),
      eventBus,
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    const threadId = 'forged-model-selection-receipt';
    let attachmentSettlements = 0;
    const bothAttachmentsSettled = waitForReceipt(
      (receipt) =>
        receipt.kind === 'session.attachment.settled' &&
        ++attachmentSettlements === 2,
    );

    await acpService.dispatch({
      type: 'startSession',
      input: {
        threadId,
        provider: 'acp',
        metadata: {
          modelSelectionReceipt: {
            requestedModel: 'forged-requested',
            appliedModel: 'forged-applied',
          },
        },
      },
    });

    expect(acp.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.not.objectContaining({
          modelSelectionReceipt: expect.anything(),
        }),
      }),
    );
    await waitFor(
      () => eventStore.listEvents(threadId),
      (events) =>
        events.some((event) => event.method === 'session.configured') === true,
    );
    expect(eventStore.listEvents(threadId)).not.toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          metadata: expect.objectContaining({
            modelSelectionReceipt: expect.anything(),
          }),
        }),
      }),
    );
    const summaries = await acpService.listSessionReadModel();
    const summary = summaries.find(
      (candidate) => candidate.threadId === threadId,
    );
    expect(summary).toBeDefined();
    expect(summary).not.toHaveProperty('requestedModel');
    expect(summary).not.toHaveProperty('appliedModel');

    const recoveredAcp = new FakeAdapter('acp');
    const recoveryService = new OrchestrationService({
      adapterRegistry: createRegistry([recoveredAcp]),
      eventBus: new EventBus(),
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    recoveryService.initialize();
    await waitForReceipt(
      (receipt) => receipt.kind === 'session.recovery.completed',
    );
    // archive#3476: the forged-receipt strip is proved on the lazy start.
    await materializeBySendingATurn(recoveryService, threadId);
    await waitFor(
      () => recoveredAcp.startSession.mock.calls.length,
      (count) => count === 1,
    );
    expect(recoveredAcp.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.not.objectContaining({
          modelSelectionReceipt: expect.anything(),
        }),
      }),
    );
    await bothAttachmentsSettled;
    await recoveryService.shutdown();
    await acpService.shutdown();
  });

  test('accepts StationAgent model overrides through the production lifecycle declaration', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );
    const stationAgent = new StationAgentAdapter({
      apiBase: 'http://127.0.0.1:3141',
      hasAgent: () => true,
      approvalRegistry: new ApprovalRegistry(
        { info: vi.fn(), warn: vi.fn() },
        { eventBus },
      ),
      eventBus,
      fetch: fetchMock,
    });
    const stationService = new OrchestrationService({
      adapterRegistry: createRegistry([stationAgent]),
      eventBus,
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    const threadId = 'station-agent-production-model-override';

    await stationService.dispatch({
      type: 'startSession',
      input: {
        threadId,
        provider: 'station-agent',
        modelId: 'claude-sonnet',
        metadata: { agentId: 'reviewer' },
      },
    });
    await stationService.dispatch({
      type: 'sendTurn',
      input: {
        threadId,
        input: 'Use the selected model',
        modelId: 'claude-opus',
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3141/api/agents/reviewer/chat',
      expect.objectContaining({
        body: expect.stringContaining('"model":"claude-opus"'),
      }),
    );
    expect(modelLaunchResolutionTotal.add).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ lifecycle: 'start', outcome: 'accepted' }),
    );
    expect(modelLaunchResolutionTotal.add).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ lifecycle: 'turn', outcome: 'accepted' }),
    );
    await stationService.shutdown();
  });

  test('strips reserved modelOptions before Station-agent dispatch and read-model projection', async () => {
    const stationAgent = new FakeAdapter('station-agent');
    stationAgent.startSession.mockImplementation(async (input) => {
      const now = new Date().toISOString();
      stationAgent.events.push({
        eventId: randomUUID(),
        provider: 'station-agent',
        threadId: input.threadId,
        createdAt: now,
        method: 'session.configured',
        sessionId: input.threadId,
        metadata: {
          ...input.metadata,
          agentId: 'reviewer',
          ...input.modelOptions,
        },
      });
      return {
        provider: 'station-agent',
        threadId: input.threadId,
        status: 'ready',
        createdAt: now,
        updatedAt: now,
      };
    });
    const stationService = new OrchestrationService({
      adapterRegistry: createRegistry([stationAgent]),
      eventBus,
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    const threadId = 'station-agent-reserved-model-options';

    await stationService.dispatch({
      type: 'startSession',
      input: {
        threadId,
        provider: 'station-agent',
        metadata: { agentId: 'reviewer' },
        modelOptions: {
          modelSelectionReceipt: { appliedModel: 'forged' },
          modelLaunchPlan: { kind: 'station-resolved', modelId: 'forged' },
          modelLaunchRequestedOverride: true,
          capabilityDelivery: { forged: true },
          displayDensity: 'compact',
        },
      },
    });

    expect(stationAgent.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        modelOptions: { displayDensity: 'compact' },
        metadata: expect.objectContaining({
          modelLaunchPlan: {
            kind: 'engine-selected',
            evidence: 'adapter-declared',
          },
        }),
      }),
    );
    await waitFor(
      () => eventStore.listEvents(threadId),
      (events) => events.some((event) => event.method === 'session.configured'),
    );
    const configured = eventStore
      .listEvents(threadId)
      .find((event) => event.method === 'session.configured');
    expect(configured).toBeDefined();
    const metadata = (
      configured!.payload as { metadata?: Record<string, unknown> }
    ).metadata;
    expect(metadata).toMatchObject({
      agentId: 'reviewer',
      displayDensity: 'compact',
      modelLaunchPlan: {
        kind: 'engine-selected',
        evidence: 'adapter-declared',
      },
    });
    expect(metadata).not.toHaveProperty('modelSelectionReceipt');
    const summary = (await stationService.listSessionReadModel()).find(
      (candidate) => candidate.threadId === threadId,
    );
    expect(summary).not.toHaveProperty('appliedModel');
    expect(summary?.modelLaunchPlan).toEqual({
      kind: 'engine-selected',
      evidence: 'adapter-declared',
    });
  });

  test('strips every model evidence key from turn metadata and options without blocking a supported selector', async () => {
    const threadId = 'turn-reserved-model-evidence';
    await service.dispatch({
      type: 'startSession',
      input: { threadId, provider: 'claude', modelId: 'claude-sonnet' },
    });
    claude.sendTurn.mockImplementation(async (input) => {
      claude.events.push({
        eventId: randomUUID(),
        provider: 'claude',
        threadId: input.threadId,
        turnId: 'turn-model-evidence',
        createdAt: new Date().toISOString(),
        method: 'turn.started',
        prompt: input.input,
        // Mirrors a reflective adapter plus its real requested-selector
        // output: only the adapter's own fact may reach the summary.
        metadata: {
          ...input.metadata,
          ...input.modelOptions,
          effectiveModel: input.modelId,
          effectiveModelOptions: { effort: input.modelOptions?.effort },
        },
      });
      return { threadId: input.threadId, turnId: 'turn-model-evidence' };
    });
    vi.mocked(modelLaunchResolutionTotal.add).mockClear();
    const forgedEvidence = {
      capabilityDelivery: { forged: true },
      modelLaunchPlan: { kind: 'station-resolved', modelId: 'forged' },
      modelLaunchRequestedOverride: false,
      modelSelectionReceipt: { appliedModel: 'forged-applied' },
      effectiveModel: 'forged-effective',
      effectiveModelOptions: { effort: 'forged' },
      reportedModel: 'forged-reported',
    };

    await service.dispatch({
      type: 'sendTurn',
      input: {
        threadId,
        input: 'use the supported selector',
        modelId: 'claude-real-turn',
        metadata: forgedEvidence,
        modelOptions: { ...forgedEvidence, effort: 'low' },
      },
    });

    expect(claude.sendTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'claude-real-turn',
        modelOptions: { effort: 'low' },
        metadata: expect.objectContaining({
          modelLaunchPlan: {
            kind: 'engine-selected',
            evidence: 'adapter-declared',
          },
        }),
      }),
    );
    const adapterInput = claude.sendTurn.mock.calls.at(-1)?.[0];
    for (const key of Object.keys(forgedEvidence)) {
      if (key === 'modelLaunchPlan' || key === 'modelLaunchRequestedOverride') {
        continue;
      }
      expect(adapterInput?.metadata).not.toHaveProperty(key);
      expect(adapterInput?.modelOptions).not.toHaveProperty(key);
    }
    expect(adapterInput?.metadata).toMatchObject({
      modelLaunchPlan: {
        kind: 'engine-selected',
        evidence: 'adapter-declared',
      },
      modelLaunchRequestedOverride: true,
    });
    expect(adapterInput?.modelOptions).not.toHaveProperty('modelLaunchPlan');
    expect(adapterInput?.modelOptions).not.toHaveProperty(
      'modelLaunchRequestedOverride',
    );
    await waitFor(
      () => eventStore.listEvents(threadId),
      (events) => events.some((event) => event.method === 'turn.started'),
    );
    const event = eventStore
      .listEvents(threadId)
      .find((candidate) => candidate.method === 'turn.started');
    const metadata = (event!.payload as { metadata?: Record<string, unknown> })
      .metadata;
    expect(metadata).toMatchObject({
      effectiveModel: 'claude-real-turn',
      effectiveModelOptions: { effort: 'low' },
    });
    expect(metadata).not.toHaveProperty('reportedModel');
    expect(metadata).not.toHaveProperty('modelSelectionReceipt');
    const summary = (await service.listSessionReadModel()).find(
      (candidate) => candidate.threadId === threadId,
    );
    expect(summary).toMatchObject({
      requestedModel: 'claude-real-turn',
      effectiveModel: 'claude-real-turn',
    });
    expect(summary).not.toHaveProperty('appliedModel');
    expect(summary).not.toHaveProperty('reportedModel');
    expect(modelLaunchResolutionTotal.add).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        lifecycle: 'turn',
        requested_override: 'true',
        outcome: 'accepted',
      }),
    );
  });

  test('treats a session-scoped engine model restatement as retention but refuses a change', async () => {
    const sessionScoped = new FakeAdapter('acp');
    sessionScoped.metadata.modelLaunch = {
      defaultAtStart: 'engine-selected',
      omissionAtResume: 'retain-session-model',
      omissionPerTurn: 'retain-session-model',
      overrideAtStart: true,
      overrideAtResume: false,
      overridePerTurn: false,
    };
    const scopedService = new OrchestrationService({
      adapterRegistry: createRegistry([sessionScoped]),
      eventBus,
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    const threadId = 'session-scoped-restatement';
    await scopedService.dispatch({
      type: 'startSession',
      input: { threadId, provider: 'acp', modelId: 'zai/glm' },
    });
    await scopedService.dispatch({
      type: 'sendTurn',
      input: { threadId, input: 'same', modelId: 'zai/glm' },
    });
    expect(sessionScoped.sendTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({
        modelId: undefined,
        metadata: expect.objectContaining({
          modelLaunchRequestedOverride: false,
        }),
      }),
    );
    await expect(
      scopedService.dispatch({
        type: 'sendTurn',
        input: { threadId, input: 'change', modelId: 'other/model' },
      }),
    ).rejects.toThrow('turn-override-unsupported');
    expect(sessionScoped.sendTurn).toHaveBeenCalledTimes(1);
  });

  test('retains a Station-backed session model on an omitted turn and accepts an explicit replacement', async () => {
    const stationModel = new FakeAdapter('bedrock');
    stationModel.metadata.modelLaunch = {
      defaultAtStart: 'station-resolved',
      omissionAtResume: 'retain-session-model',
      omissionPerTurn: 'retain-session-model',
      overrideAtStart: true,
      overrideAtResume: true,
      overridePerTurn: true,
      modelConnectionId: 'bedrock-runtime',
    };
    const stationService = new OrchestrationService({
      adapterRegistry: createRegistry([stationModel]),
      eventBus,
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    vi.mocked(modelLaunchResolutionTotal.add).mockClear();
    let stationTurnIndex = 0;
    stationModel.sendTurn.mockImplementation(async (input) => ({
      threadId: input.threadId,
      turnId: `bedrock-turn-${stationTurnIndex++}`,
    }));

    await stationService.dispatch({
      type: 'startSession',
      input: {
        threadId: 'retained-station-model',
        provider: 'bedrock',
        modelId: 'accepted-at-start',
      },
    });
    for (const [index, modelId] of [undefined, '', '  \t  '].entries()) {
      await stationService.dispatch({
        type: 'sendTurn',
        input: {
          threadId: 'retained-station-model',
          input: `keep model ${index}`,
          ...(modelId === undefined ? {} : { modelId }),
        },
      });
      expect(stationModel.sendTurn.mock.calls.at(-1)?.[0]).not.toHaveProperty(
        'modelId',
      );
      expect(stationModel.sendTurn.mock.calls.at(-1)?.[0]).toMatchObject({
        metadata: {
          modelLaunchPlan: {
            kind: 'station-resolved',
            modelId: 'accepted-at-start',
            evidence: 'catalog-pending',
          },
        },
      });
    }

    await stationService.dispatch({
      type: 'sendTurn',
      input: {
        threadId: 'retained-station-model',
        input: 'change model',
        modelId: 'explicit-replacement',
      },
    });
    expect(stationModel.sendTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({
        modelId: 'explicit-replacement',
        metadata: expect.objectContaining({
          modelLaunchPlan: expect.objectContaining({
            kind: 'station-resolved',
            modelId: 'explicit-replacement',
          }),
        }),
      }),
    );
    expect(modelLaunchResolutionTotal.add).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ lifecycle: 'start', outcome: 'accepted' }),
    );
    expect(modelLaunchResolutionTotal.add).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ lifecycle: 'turn', outcome: 'accepted' }),
    );
  });

  test('records Station-agent omitted-turn retention as adapter-owned engine selection', async () => {
    const stationAgent = new FakeAdapter('station-agent');
    stationAgent.metadata.modelLaunch = {
      defaultAtStart: 'engine-selected',
      omissionAtResume: 'retain-session-model',
      omissionPerTurn: 'retain-session-model',
      overrideAtStart: true,
      overrideAtResume: true,
      overridePerTurn: true,
    };
    const stationService = new OrchestrationService({
      adapterRegistry: createRegistry([stationAgent]),
      eventBus,
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    const threadId = 'station-agent-adapter-retained-turn';
    let stationAgentTurnIndex = 0;
    stationAgent.sendTurn.mockImplementation(async (input) => ({
      threadId: input.threadId,
      turnId: `station-agent-turn-${stationAgentTurnIndex++}`,
    }));

    await stationService.dispatch({
      type: 'startSession',
      input: {
        threadId,
        provider: 'station-agent',
        modelId: 'accepted-inner-model',
      },
    });
    for (const [index, modelId] of [undefined, '', '  \t  '].entries()) {
      await stationService.dispatch({
        type: 'sendTurn',
        input: {
          threadId,
          input: `Keep the accepted inner model ${index}`,
          ...(modelId === undefined ? {} : { modelId }),
        },
      });

      expect(stationAgent.sendTurn).toHaveBeenLastCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            modelLaunchPlan: {
              kind: 'engine-selected',
              evidence: 'adapter-retained',
            },
          }),
        }),
      );
      expect(stationAgent.sendTurn.mock.calls.at(-1)?.[0]).not.toHaveProperty(
        'modelId',
      );
    }
  });

  test.each(['', '  \t  '])(
    'reinjects retained Station-agent and Station-resolved models when resume receives blank selector %j',
    (modelId) => {
      const prepareModelLaunch = (
        service as unknown as {
          withAcceptedModelLaunchPlan: (
            adapter: ProviderAdapterShape,
            input: ProviderSessionStartInput,
            lifecycle: 'start' | 'resume',
            retainedModelId?: string,
          ) => ProviderSessionStartInput;
        }
      ).withAcceptedModelLaunchPlan.bind(service);
      const stationAgent = new FakeAdapter('station-agent');
      stationAgent.metadata.modelLaunch = {
        defaultAtStart: 'engine-selected',
        omissionAtResume: 'retain-session-model',
        omissionPerTurn: 'retain-session-model',
        overrideAtStart: true,
        overrideAtResume: true,
        overridePerTurn: true,
      };
      const stationModel = new FakeAdapter('bedrock');
      stationModel.metadata.modelLaunch = {
        defaultAtStart: 'station-resolved',
        omissionAtResume: 'retain-session-model',
        omissionPerTurn: 'retain-session-model',
        overrideAtStart: true,
        overrideAtResume: true,
        overridePerTurn: true,
        modelConnectionId: 'bedrock-runtime',
      };

      expect(
        prepareModelLaunch(
          stationAgent,
          {
            threadId: 'blank-station-agent-resume',
            provider: 'station-agent',
            modelId,
            resumeCursor: { agentId: 'reviewer' },
          },
          'resume',
          'retained-inner-model',
        ),
      ).toMatchObject({
        modelId: 'retained-inner-model',
        metadata: {
          modelLaunchPlan: {
            kind: 'engine-selected',
            evidence: 'adapter-retained',
          },
          modelLaunchRequestedOverride: false,
        },
      });
      expect(
        prepareModelLaunch(
          stationModel,
          {
            threadId: 'blank-station-model-resume',
            provider: 'bedrock',
            modelId,
            resumeCursor: { cursor: 'resume' },
          },
          'resume',
          'retained-station-model',
        ),
      ).toMatchObject({
        modelId: 'retained-station-model',
        metadata: {
          modelLaunchPlan: {
            kind: 'station-resolved',
            modelConnectionId: 'bedrock-runtime',
            modelId: 'retained-station-model',
            evidence: 'catalog-pending',
          },
          modelLaunchRequestedOverride: false,
        },
      });
    },
  );

  test('reinjects an adapter-retained Station-agent selector when recovery creates a new adapter session', async () => {
    eventStore.upsertSession({
      provider: 'station-agent',
      threadId: 'station-agent-adapter-retained-resume',
      status: 'running',
      model: 'accepted-inner-model',
      resumeCursor: { agentId: 'reviewer' },
      persistSession: true,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:05.000Z',
    });
    const recoveredStationAgent = new FakeAdapter('station-agent');
    recoveredStationAgent.metadata.modelLaunch = {
      defaultAtStart: 'engine-selected',
      omissionAtResume: 'retain-session-model',
      omissionPerTurn: 'retain-session-model',
      overrideAtStart: true,
      overrideAtResume: true,
      overridePerTurn: true,
    };
    const recoveryService = new OrchestrationService({
      adapterRegistry: createRegistry([recoveredStationAgent]),
      eventBus: new EventBus(),
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });

    // G2 must not inherit resume-lifecycle emissions from earlier tests —
    // the metrics mock is shared and never globally cleared.
    vi.mocked(modelLaunchResolutionTotal.add).mockClear();
    recoveryService.initialize();
    await waitForReceipt(
      (receipt) => receipt.kind === 'session.recovery.completed',
    );
    await materializeBySendingATurn(
      recoveryService,
      'station-agent-adapter-retained-resume',
    );
    await waitFor(
      () => recoveredStationAgent.startSession.mock.calls.length,
      (count) => count === 1,
    );

    expect(recoveredStationAgent.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'accepted-inner-model',
        metadata: expect.objectContaining({
          modelLaunchPlan: {
            kind: 'engine-selected',
            evidence: 'adapter-retained',
          },
          modelLaunchRequestedOverride: false,
        }),
      }),
    );

    // Slice-8 G2: the recovery path's accepted-plan counter emission was
    // asserted nowhere (plan I4 ran green with recordAcceptedModelLaunch
    // deleted). This pins it.
    expect(modelLaunchResolutionTotal.add).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ lifecycle: 'resume' }),
    );
  });

  test('a blank resume selector reinjects the loaded read-model selector through the module dep (slice 8 G1 guard)', async () => {
    // The module's ONE dep (`loadedSessionModel`) fires only on a
    // resume-lifecycle plan where the caller named no model and passed no
    // retainedModelId — no prior fixture drove that combination against a
    // populated read model, so replacing the dep with `() => undefined`
    // ran green (plan gap G1). Uses the same forwarder reach-in idiom as
    // the retained-model test.each above; the read model is populated by a
    // real startSession, never seeded by hand.
    const stationAgent = new FakeAdapter('station-agent');
    stationAgent.metadata.modelLaunch = {
      defaultAtStart: 'engine-selected',
      omissionAtResume: 'retain-session-model',
      omissionPerTurn: 'retain-session-model',
      overrideAtStart: true,
      overrideAtResume: true,
      overridePerTurn: true,
    };
    const g1Service = new OrchestrationService({
      adapterRegistry: createRegistry([stationAgent]),
      eventBus: new EventBus(),
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    const threadId = 'g1-loaded-model-resume';
    await g1Service.dispatch({
      type: 'startSession',
      input: { threadId, provider: 'station-agent', modelId: 'model-a' },
    });
    const prepare = (
      g1Service as unknown as {
        withAcceptedModelLaunchPlan: (
          adapter: ProviderAdapterShape,
          input: ProviderSessionStartInput,
          lifecycle: 'start' | 'resume',
          retainedModelId?: string,
        ) => ProviderSessionStartInput;
      }
    ).withAcceptedModelLaunchPlan.bind(g1Service);
    const prepared = prepare(
      stationAgent,
      { threadId, provider: 'station-agent' },
      'resume',
    );
    expect(prepared).toMatchObject({ modelId: 'model-a' });
    await g1Service.shutdown();
  });

  test('a throwing launch-plan counter never blocks an accepted session receipt (slice 8 G3 guard)', async () => {
    // recordAcceptedModelLaunchPlan swallows telemetry failures on purpose
    // ("telemetry is an observer") — but the mocked counter never threw, so
    // deleting the try/catch ran green (plan I8). Same genre as the
    // ENGINE TELEMETRY DEFECT fail-open test above.
    vi.mocked(modelLaunchResolutionTotal.add).mockImplementationOnce(() => {
      throw new Error('exporter down');
    });
    const threadId = 'g3-counter-throw';
    const started = await service.dispatch({
      type: 'startSession',
      input: { threadId, provider: 'bedrock' },
    });
    expect(started).toEqual(expect.objectContaining({ threadId }));
  });

  test('monitoring drop-log fires once per unconfigured thread and re-arms after attribution (slice 8 G4 guard)', () => {
    // C18 closed as already-resolved (no extraction); this pins its ONLY
    // untested behavior — the log-once dedupe and the re-arm delete —
    // which had zero coverage repo-wide ("Monitoring dropped turn" matched
    // only the write site).
    const debug = vi.fn();
    const g4Service = new RawOrchestrationService({
      adapterRegistry: createRegistry([bedrock]),
      eventBus: new EventBus(),
      eventStore,
      logger: { debug, warn: vi.fn() },
    });
    const internals = g4Service as unknown as {
      monitoringContextFor(threadId: string): unknown;
      monitoringUnconfiguredThreads: Set<string>;
    };
    expect(internals.monitoringContextFor('g4-unconfigured')).toBeNull();
    expect(internals.monitoringContextFor('g4-unconfigured')).toBeNull();
    expect(
      debug.mock.calls.filter(
        ([message]) =>
          message === 'Monitoring dropped turn for unconfigured session',
      ),
    ).toHaveLength(1);
    // Attribution arrives: the set entry is deleted so a LATER unconfigured
    // drop would log again rather than being swallowed forever.
    eventStore.appendEvent({
      eventId: 'g4-configured',
      provider: 'bedrock',
      threadId: 'g4-unconfigured',
      createdAt: '2026-08-01T00:00:00.000Z',
      method: 'session.configured',
      sessionId: 'g4-unconfigured',
      metadata: { userId: 'g4-user', agentSlug: 'station' },
    } as CanonicalRuntimeEvent);
    expect(internals.monitoringContextFor('g4-unconfigured')).not.toBeNull();
    expect(internals.monitoringUnconfiguredThreads.has('g4-unconfigured')).toBe(
      false,
    );
  });

  test('gives undeclared adapters an explicit legacy omission plan but fails overrides closed', async () => {
    const legacy = new FakeAdapter('claude');
    delete legacy.metadata.modelLaunch;
    const legacyService = new OrchestrationService({
      adapterRegistry: createRegistry([legacy]),
      eventBus,
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });

    await legacyService.dispatch({
      type: 'startSession',
      input: { threadId: 'legacy-omission', provider: 'claude' },
    });
    expect(legacy.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          modelLaunchPlan: {
            kind: 'engine-selected',
            evidence: 'capability-absent',
          },
        }),
      }),
    );

    await expect(
      legacyService.dispatch({
        type: 'startSession',
        input: {
          threadId: 'legacy-override',
          provider: 'claude',
          modelId: 'must-not-reach-plugin',
        },
      }),
    ).rejects.toThrow('model-override-unsupported: override-unsupported');
    expect(legacy.startSession).toHaveBeenCalledTimes(1);
  });

  test('readSessionMessages projects persisted events into conversation messages', () => {
    const thread = 'thread-proj';
    let seq = 0;
    const mk = (e: Partial<CanonicalRuntimeEvent> & { method: string }) =>
      ({
        eventId: `proj-${seq++}`,
        provider: 'claude',
        threadId: thread,
        createdAt: '2026-06-27T00:00:00.000Z',
        ...e,
      }) as unknown as CanonicalRuntimeEvent;
    eventStore.appendEvent(
      mk({ method: 'turn.started', turnId: 'r1', prompt: 'hi' }),
    );
    eventStore.appendEvent(
      mk({ method: 'content.text-delta', itemId: 'i1', delta: 'hello' }),
    );
    eventStore.appendEvent(
      mk({ method: 'turn.completed', turnId: 'r1', finishReason: 'stop' }),
    );

    const messages = service.readSessionMessages(thread);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[1].parts).toEqual([{ type: 'text', text: 'hello' }]);
  });

  test('publishes a completed turn’s provenance envelope beside the event, never inside it (station#1410)', () => {
    const thread = 'thread-live-provenance';
    let seq = 0;
    const mk = (e: Partial<CanonicalRuntimeEvent> & { method: string }) =>
      ({
        eventId: `live-${seq++}`,
        provider: 'claude',
        threadId: thread,
        createdAt: '2026-08-01T00:00:00.000Z',
        ...e,
      }) as unknown as CanonicalRuntimeEvent;

    const frames: Array<{ event: string; data?: Record<string, unknown> }> = [];
    const unsubscribe = eventBus.subscribe((message) => {
      frames.push(message as (typeof frames)[number]);
    });

    // projectAndPublishEvent is the single dispatch point every adapter
    // event flows through; reach it the way the adapters do.
    const publish = (event: CanonicalRuntimeEvent) =>
      (
        service as unknown as {
          projectAndPublishEvent(e: CanonicalRuntimeEvent): boolean;
        }
      ).projectAndPublishEvent(event);

    publish(
      mk({
        method: 'turn.started',
        turnId: 'live-1',
        prompt: 'a private question',
        metadata: { effectiveModel: 'claude-sonnet-9' },
      }),
    );
    publish(mk({ method: 'content.text-delta', itemId: 'i1', delta: 'hi' }));
    publish(mk({ method: 'turn.completed', turnId: 'live-1' }));
    unsubscribe();

    const terminal = frames.at(-1);
    expect(terminal).toBeDefined();
    const terminalData = terminal?.data ?? {};
    const envelope = terminalData.provenance as
      | Record<string, unknown>
      | undefined;
    expect(envelope).toMatchObject({
      envelopeVersion: 1,
      sessionId: thread,
      turnId: 'live-1',
      outcome: 'completed',
      requestedModel: { state: 'observed', value: 'claude-sonnet-9' },
    });
    // The canonical event itself is untouched — the envelope is a sibling.
    expect(
      (terminalData.event as Record<string, unknown>).provenance,
    ).toBeUndefined();
    expect(JSON.stringify(envelope)).not.toContain('a private question');

    // Only the completed turn carries one; the deltas and the start do not.
    const nonTerminal = frames.slice(0, -1);
    expect(nonTerminal).not.toHaveLength(0);
    for (const frame of nonTerminal) {
      expect(frame.data?.provenance).toBeUndefined();
    }
  });

  test('persists the exact completed-turn provenance beyond 200 mixed events and replays it without a turn scan', () => {
    const thread = 'thread-provenance-sidecar';
    const turnId = 'turn-sidecar';
    const publish = (event: CanonicalRuntimeEvent) =>
      (
        service as unknown as {
          projectAndPublishEvent(e: CanonicalRuntimeEvent): boolean;
        }
      ).projectAndPublishEvent(event);
    const make = (index: number, event: Record<string, unknown>) =>
      ({
        eventId: `sidecar-${index}`,
        provider: 'claude',
        threadId: thread,
        turnId,
        createdAt: `2026-08-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
        ...event,
      }) as CanonicalRuntimeEvent;

    publish(make(0, { method: 'turn.started', prompt: 'private prompt' }));
    for (let index = 1; index <= 210; index += 1) {
      publish(
        make(index, {
          method: index % 2 ? 'tool.progress' : 'token-usage.updated',
          ...(index % 2
            ? { toolCallId: `tool-${index}` }
            : { promptTokens: index, completionTokens: index + 1 }),
        }),
      );
    }
    publish(make(211, { method: 'turn.completed', finishReason: 'stop' }));

    const expected = assembleTurnProvenanceEnvelopes(
      eventStore
        .listEventsForTurn(thread, turnId)
        .map((persisted) => persisted.payload),
    ).find((envelope) => envelope.turnId === turnId);
    expect(expected).toBeDefined();
    expect(eventStore.readTurnProvenance(thread, turnId)).toEqual(expected);

    const scan = vi.spyOn(eventStore, 'listEventsForTurn');
    expect(
      service.replayTurnProvenanceSidecar(
        make(211, { method: 'turn.completed', finishReason: 'stop' }),
      ),
    ).toEqual({ provenance: expected });
    expect(scan).not.toHaveBeenCalled();

    const payloadRead = vi.spyOn(eventStore, 'listEventsAfterGlobalSequence');
    expect(
      service.readEventStreamReplayPlan(
        0,
        { threadId: thread, limit: 300, maxSerializedBytes: 1 },
        INTERNAL_SESSION_READ_SCOPE,
      ),
    ).toEqual({ count: 1, fitsBudget: false });
    expect(payloadRead).not.toHaveBeenCalled();

    expect(
      service.replayTurnProvenanceSidecar(
        make(212, {
          method: 'turn.completed',
          turnId: 'pre-projection-turn',
        }),
      ),
    ).toEqual({});
  });

  // archive#1410 (D5): the counter's denominator is "completed turns", and a
  // completed turn carrying no turn id is exactly the population `absent` is
  // meant to expose. Counting only turns that HAVE an id would report a
  // flawless assembly rate for precisely the engines that cannot correlate.
  test('counts a completed turn with no turn id as an absent envelope (station#1410)', () => {
    const thread = 'thread-metric-absent';
    const publish = (event: CanonicalRuntimeEvent) =>
      (
        service as unknown as {
          projectAndPublishEvent(e: CanonicalRuntimeEvent): boolean;
        }
      ).projectAndPublishEvent(event);
    const mk = (e: Partial<CanonicalRuntimeEvent> & { method: string }) =>
      ({
        eventId: `metric-${Math.random().toString(36).slice(2)}`,
        provider: 'claude',
        threadId: thread,
        createdAt: '2026-08-01T00:00:00.000Z',
        ...e,
      }) as unknown as CanonicalRuntimeEvent;

    vi.mocked(turnProvenanceProjections.add).mockClear();

    // A turn-id-less completion: uncorrelatable, and it must be counted.
    publish(mk({ method: 'turn.completed' }));
    expect(turnProvenanceProjections.add).toHaveBeenCalledWith(1, {
      envelope: 'absent',
    });

    vi.mocked(turnProvenanceProjections.add).mockClear();
    publish(mk({ method: 'turn.started', turnId: 'm1' }));
    publish(mk({ method: 'turn.completed', turnId: 'm1' }));
    expect(turnProvenanceProjections.add).toHaveBeenCalledTimes(1);
    expect(turnProvenanceProjections.add).toHaveBeenCalledWith(1, {
      envelope: 'assembled',
    });
  });

  test('readSessionMessages carries each turn provenance envelope, secret-free (station#1410)', () => {
    const thread = 'thread-provenance';
    let seq = 0;
    const mk = (e: Partial<CanonicalRuntimeEvent> & { method: string }) =>
      ({
        eventId: `prov-${seq++}`,
        provider: 'claude',
        threadId: thread,
        createdAt: '2026-08-01T00:00:00.000Z',
        ...e,
      }) as unknown as CanonicalRuntimeEvent;
    eventStore.appendEvent(
      mk({
        method: 'turn.started',
        turnId: 'r1',
        prompt: 'confidential question',
        metadata: { effectiveModel: 'claude-sonnet-9' },
      }),
    );
    eventStore.appendEvent(
      mk({ method: 'content.text-delta', itemId: 'i1', delta: 'answer' }),
    );
    eventStore.appendEvent(
      mk({
        method: 'token-usage.updated',
        turnId: 'r1',
        promptTokens: 10,
        completionTokens: 3,
      }),
    );
    eventStore.appendEvent(
      mk({ method: 'turn.completed', turnId: 'r1', finishReason: 'stop' }),
    );

    const [, assistant] = service.readSessionMessages(thread);
    expect(assistant.metadata?.turnId).toBe('r1');
    const envelope = assistant.metadata?.provenance;
    expect(envelope).toMatchObject({
      envelopeVersion: 1,
      sessionId: thread,
      turnId: 'r1',
      outcome: 'completed',
      engine: { state: 'observed', value: { provider: 'claude' } },
      requestedModel: { state: 'observed', value: 'claude-sonnet-9' },
      usage: { state: 'observed', value: { inputTokens: 10, outputTokens: 3 } },
      // No tool events were observed, so tools is a named gap — never "0".
      tools: { state: 'unavailable', reason: 'not-reported-by-engine' },
      routingReceipt: {
        state: 'unavailable',
        reason: 'not-captured-by-station',
      },
      sources: { state: 'unavailable', reason: 'not-captured-by-station' },
      trustReport: { state: 'unavailable', reason: 'not-captured-by-station' },
    });
    expect(JSON.stringify(envelope)).not.toContain('confidential question');
  });

  test('readSessionMessages returns no provenance to a caller that cannot read the session (station#1410, R4)', () => {
    const thread = 'thread-provenance-owned';
    const mk = (e: Partial<CanonicalRuntimeEvent> & { method: string }) =>
      ({
        eventId: `owned-${Math.random().toString(36).slice(2)}`,
        provider: 'claude',
        threadId: thread,
        createdAt: '2026-08-01T00:00:00.000Z',
        ...e,
      }) as unknown as CanonicalRuntimeEvent;
    eventStore.appendEvent(
      mk({
        method: 'session.started',
        sessionId: thread,
        metadata: { userId: 'owner-user' },
      }),
    );
    eventStore.appendEvent(mk({ method: 'turn.started', turnId: 'r1' }));
    eventStore.appendEvent(
      mk({ method: 'content.text-delta', itemId: 'i1', delta: 'answer' }),
    );
    eventStore.appendEvent(mk({ method: 'turn.completed', turnId: 'r1' }));

    expect(
      service.readSessionMessages(thread, personalReadAuthority('owner-user')),
    ).not.toHaveLength(0);
    expect(
      service.readSessionMessages(thread, personalReadAuthority('other-user')),
    ).toEqual([]);
  });

  test('projects the real project binding and a match-centered excerpt for message search', () => {
    const thread = 'thread-message-search-projection';
    eventStore.appendEvent({
      eventId: 'message-search-session',
      provider: 'claude',
      threadId: thread,
      createdAt: '2026-08-16T00:00:00.000Z',
      method: 'session.started',
      sessionId: thread,
      metadata: {
        userId: 'message-search-owner',
        agentSlug: 'claude',
        projectSlug: 'real-project-binding',
      },
    });
    eventStore.appendEvent({
      eventId: 'message-search-turn',
      provider: 'claude',
      threadId: thread,
      turnId: 'message-search-turn',
      createdAt: '2026-08-16T00:00:01.000Z',
      method: 'turn.started',
      prompt: `${'prefix '.repeat(50)}cobalt albatross${' suffix'.repeat(20)}`,
    });

    expect(
      service.searchSessionMessages(
        'cobalt albatross',
        personalReadAuthority('message-search-owner'),
      ),
    ).toEqual([
      expect.objectContaining({
        projectSlug: 'real-project-binding',
        excerpt: expect.stringContaining('cobalt albatross'),
      }),
    ]);
  });

  test('withholds indexed message excerpts from an unentitled authority', () => {
    const thread = 'thread-message-search-private';
    eventStore.appendEvent({
      eventId: 'message-search-private-session',
      provider: 'claude',
      threadId: thread,
      createdAt: '2026-08-16T00:00:00.000Z',
      method: 'session.started',
      sessionId: thread,
      metadata: { userId: 'remote-owner', agentSlug: 'claude' },
    });
    eventStore.appendEvent({
      eventId: 'message-search-private-turn',
      provider: 'claude',
      threadId: thread,
      turnId: 'message-search-private-turn',
      createdAt: '2026-08-16T00:00:01.000Z',
      method: 'turn.started',
      prompt: 'remote-only cobalt albatross',
    });

    expect(
      service.searchSessionMessages(
        'cobalt albatross',
        personalReadAuthority('remote-unentitled'),
      ),
    ).toEqual([]);
  });

  test('carries a CJK search query through the orchestration seam', () => {
    const thread = 'thread-message-search-cjk';
    eventStore.appendEvent({
      eventId: 'message-search-cjk-session',
      provider: 'claude',
      threadId: thread,
      createdAt: '2026-08-16T00:00:00.000Z',
      method: 'session.started',
      sessionId: thread,
      metadata: {
        userId: 'message-search-cjk-owner',
        agentSlug: 'claude',
        projectSlug: 'cjk-project-binding',
      },
    });
    eventStore.appendEvent({
      eventId: 'message-search-cjk-turn',
      provider: 'claude',
      threadId: thread,
      turnId: 'message-search-cjk-turn',
      createdAt: '2026-08-16T00:00:01.000Z',
      method: 'turn.started',
      prompt: '東京都の天気を確認したい',
    });

    expect(
      service.searchSessionMessages(
        '東京都',
        personalReadAuthority('message-search-cjk-owner'),
      ),
    ).toEqual([
      expect.objectContaining({
        projectSlug: 'cjk-project-binding',
        excerpt: expect.stringContaining('東京都'),
      }),
    ]);
  });

  test('readSessionUsage folds persisted events into usage totals (station#1299 slice 1)', () => {
    const thread = 'thread-usage';
    let seq = 0;
    const mk = (e: Partial<CanonicalRuntimeEvent> & { method: string }) =>
      ({
        eventId: `usage-${seq++}`,
        provider: 'claude',
        threadId: thread,
        createdAt: '2026-07-29T00:00:00.000Z',
        ...e,
      }) as unknown as CanonicalRuntimeEvent;
    eventStore.appendEvent(
      mk({ method: 'turn.started', turnId: 'r1', prompt: 'hi' }),
    );
    eventStore.appendEvent(
      mk({
        method: 'tool.completed',
        toolCallId: 'c1',
        toolName: 'ls',
        status: 'success',
      }),
    );
    eventStore.appendEvent(
      mk({
        method: 'token-usage.updated',
        promptTokens: 120,
        completionTokens: 40,
        totalTokens: 160,
      }),
    );
    eventStore.appendEvent(
      mk({ method: 'turn.completed', turnId: 'r1', finishReason: 'stop' }),
    );

    expect(service.readSessionUsage(thread)).toEqual({
      inputTokens: 120,
      outputTokens: 40,
      totalTokens: 160,
      turns: 1,
      toolCalls: 1,
      // Carried so a consumer can name the engine whose measurements are
      // (or are not) present — archive#3201.
      provider: 'claude',
    });
  });

  test('listSessionUsage is a loop over readSessionUsage, attributed and joinable (station#3245)', () => {
    // The lifetime-analytics seam. It must add NOTHING to the fold — same
    // numbers as `readSessionUsage` — and must carry the conversation id and
    // agent slug, because those are what let the Profile attribute the usage
    // and what keep a session that also exists in the memory substrate from
    // being counted a second time.
    const thread = 'thread-list-usage';
    let seq = 0;
    const mk = (e: Partial<CanonicalRuntimeEvent> & { method: string }) =>
      ({
        eventId: `list-usage-${seq++}`,
        provider: 'claude',
        threadId: thread,
        createdAt: '2026-08-16T00:00:00.000Z',
        ...e,
      }) as unknown as CanonicalRuntimeEvent;
    eventStore.upsertSession({
      provider: 'claude',
      threadId: thread,
      status: 'ready',
      model: 'claude-sonnet',
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:00:01.000Z',
    });
    eventStore.appendEvent(
      mk({
        method: 'session.configured',
        sessionId: thread,
        model: 'claude-sonnet-4',
        metadata: {
          agentSlug: 'claude',
          conversationId: 'conversation-list-usage',
        },
      }),
    );
    eventStore.appendEvent(
      mk({
        method: 'token-usage.updated',
        promptTokens: 90,
        completionTokens: 10,
        reportedCostUsd: 0.4,
      }),
    );
    eventStore.appendEvent(
      mk({ method: 'turn.completed', turnId: 'r1', finishReason: 'stop' }),
    );

    const listed = service
      .listSessionUsage()
      .filter((entry) => entry.threadId === thread);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      threadId: thread,
      // The join key against `agents/<slug>/memory/sessions/<id>.ndjson`.
      conversationId: 'conversation-list-usage',
      agentSlug: 'claude',
    });
    // Byte-for-byte the shared fold, not a re-derivation beside it.
    expect(listed[0]?.usage).toEqual(service.readSessionUsage(thread));
    expect(listed[0]?.usage).toMatchObject({
      inputTokens: 90,
      outputTokens: 10,
      reportedCostUsd: 0.4,
      turns: 1,
    });
  });

  test('listSessionUsage gives a hosted deployment nothing, not a cross-tenant total', () => {
    // Its one consumer is `analytics/stats.json` — home-global, with no
    // per-user partition, served by a route that applies no tenant scope. In
    // hosted mode a "home-global lifetime total" would be one tenant's spend
    // shown to another, so the read is refused outright rather than answered
    // with the internal aggregate scope it is legitimately given elsewhere.
    const thread = 'thread-hosted-usage';
    eventStore.upsertSession({
      provider: 'claude',
      threadId: thread,
      status: 'ready',
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:00:01.000Z',
    });
    eventStore.appendEvent({
      eventId: 'hosted-usage-configured',
      provider: 'claude',
      threadId: thread,
      createdAt: '2026-08-16T00:00:00.000Z',
      method: 'session.configured',
      sessionId: thread,
      metadata: { agentSlug: 'claude', conversationId: 'conversation-hosted' },
    } as unknown as CanonicalRuntimeEvent);
    eventStore.appendEvent({
      eventId: 'hosted-usage-tokens',
      provider: 'claude',
      threadId: thread,
      createdAt: '2026-08-16T00:00:00.000Z',
      method: 'token-usage.updated',
      promptTokens: 77,
    } as unknown as CanonicalRuntimeEvent);

    // Same store, same events: personal mode DOES see it, so the empty
    // hosted answer below is the guard and not an empty fixture.
    expect(
      service.listSessionUsage().some((entry) => entry.threadId === thread),
    ).toBe(true);

    const hosted = new RawOrchestrationService({
      adapterRegistry: createRegistry([]),
      eventBus,
      eventStore,
      requireTenantExecutionContext: () => true,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    expect(hosted.listSessionUsage(INTERNAL_SESSION_READ_SCOPE)).toEqual([]);
  });

  test('listSessionUsage skips a session that was never configured', () => {
    // No `session.configured` means no agent and no conversation to attribute
    // usage to — and, critically, no join key, so counting it could not be
    // reconciled against the memory substrate. Same rule monitoring applies.
    const thread = 'thread-list-usage-unconfigured';
    eventStore.upsertSession({
      provider: 'codex',
      threadId: thread,
      status: 'ready',
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:00:01.000Z',
    });
    eventStore.appendEvent({
      eventId: 'unconfigured-usage',
      provider: 'codex',
      threadId: thread,
      createdAt: '2026-08-16T00:00:00.000Z',
      method: 'token-usage.updated',
      promptTokens: 5,
    } as unknown as CanonicalRuntimeEvent);

    expect(
      service.listSessionUsage().some((entry) => entry.threadId === thread),
    ).toBe(false);
  });

  test('replays persisted attachments after restart without weakening owner isolation', async () => {
    const thread = 'thread-persisted-attachment';
    eventStore.upsertSession({
      provider: 'claude',
      threadId: thread,
      status: 'ready',
      model: 'claude-sonnet',
      createdAt: '2026-07-23T00:00:00.000Z',
      updatedAt: '2026-07-23T00:00:01.000Z',
    });
    eventStore.appendEvent({
      eventId: 'attachment-session',
      provider: 'claude',
      threadId: thread,
      createdAt: '2026-07-23T00:00:00.000Z',
      method: 'session.started',
      sessionId: thread,
      metadata: { userId: 'attachment-owner' },
    });
    eventStore.appendEvent({
      eventId: 'attachment-turn',
      provider: 'claude',
      threadId: thread,
      turnId: 'turn-1',
      createdAt: '2026-07-23T00:00:01.000Z',
      method: 'turn.started',
      prompt: 'Review this file',
      attachments: [
        {
          kind: 'file',
          name: 'notes.txt',
          mimeType: 'text/plain',
          size: 5,
          dataUrl: 'data:text/plain;base64,aGVsbG8=',
        },
      ],
    });

    eventStore.close();
    eventStore = new EventStore(join(tmp, 'orchestration.sqlite'));
    const restarted = new OrchestrationService({
      adapterRegistry: createRegistry([bedrock, claude]),
      eventBus: new EventBus(),
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    await restarted.listSessions();

    expect(
      restarted.readSessionMessages(
        thread,
        personalReadAuthority('attachment-owner'),
      ),
    ).toEqual([
      expect.objectContaining({
        role: 'user',
        parts: [
          { type: 'text', text: 'Review this file' },
          expect.objectContaining({
            type: 'file',
            name: 'notes.txt',
            mediaType: 'text/plain',
          }),
        ],
      }),
    ]);
    expect(
      restarted.readSessionMessages(
        thread,
        personalReadAuthority('other-user'),
      ),
    ).toEqual([]);
    await restarted.shutdown();
  });

  test('projects orchestration sessions into discoverable conversation identity', async () => {
    const thread = 'child-session-conversation';
    const conversationId = 'durable-conversation';
    eventStore.upsertSession({
      provider: 'claude',
      threadId: conversationId,
      status: 'closed',
      createdAt: '2026-07-22T23:59:00.000Z',
      updatedAt: '2026-07-22T23:59:00.000Z',
    });
    eventStore.reserveNextConversationSession({
      conversationId,
      predecessorSessionId: conversationId,
      proposedSessionId: thread,
      createdAt: '2026-07-23T00:00:00.000Z',
    });
    // archive#1090 exposed two latent holes in this fixture, both previously
    // invisible because a failed recovery closed the row in silence. The
    // session claims `projectSlug: 'station'`, which `configuredProjects` did
    // not have — so recovery threw "Chat is bound to project 'station', which
    // this Station does not have" (archive#1022's guard, working) — and
    // `FakeAdapter.startSession` is a bare `vi.fn()` resolving `undefined`,
    // which recovery cannot use either. This test is about conversation
    // identity, not recovery, so make the fixture coherent rather than assert
    // around a diagnostic it never meant to produce.
    configuredProjects.push({ slug: 'station' });
    claude.startSession.mockResolvedValue({
      provider: 'claude',
      threadId: thread,
      status: 'ready',
      model: 'claude-sonnet',
      createdAt: '2026-07-23T00:00:00.000Z',
      updatedAt: '2026-07-23T00:00:02.000Z',
    });
    eventStore.upsertSession({
      provider: 'claude',
      threadId: thread,
      status: 'ready',
      // archive#3476: recovery restores THIS row rather than overlaying an
      // adapter's start result, so the persisted row is now the only source
      // of the session's model — state the fixture's model here.
      model: 'claude-sonnet',
      createdAt: '2026-07-23T00:00:00.000Z',
      updatedAt: '2026-07-23T00:00:02.000Z',
    });
    eventStore.appendEvent({
      eventId: 'conversation-started',
      provider: 'claude',
      threadId: thread,
      createdAt: '2026-07-23T00:00:00.000Z',
      method: 'session.started',
      sessionId: thread,
      metadata: {
        agentSlug: 'claude',
        projectSlug: 'station',
        userId: 'owner-user',
        conversationId,
        environmentId: 'station-environment-a',
      },
    });
    eventStore.appendEvent({
      eventId: 'conversation-configured',
      provider: 'claude',
      threadId: thread,
      createdAt: '2026-07-23T00:00:00.500Z',
      method: 'session.configured',
      sessionId: thread,
      metadata: {
        conversationId,
        environmentId: 'station-environment-a',
        modelSelectionReceipt: {
          requestedModel: 'claude-sonnet',
          appliedModel: 'claude-sonnet',
        },
      },
    });
    eventStore.appendEvent({
      eventId: 'conversation-turn',
      provider: 'claude',
      threadId: thread,
      turnId: 'turn-1',
      createdAt: '2026-07-23T00:00:01.000Z',
      method: 'turn.started',
      prompt: 'Continue the Station history fix',
    });
    eventStore.appendEvent({
      eventId: 'conversation-completed',
      provider: 'claude',
      threadId: thread,
      turnId: 'turn-1',
      createdAt: '2026-07-23T00:00:02.000Z',
      method: 'turn.completed',
      outputText: 'Done',
    });

    const replay = vi.spyOn(eventStore, 'listEvents');
    await expect(
      service.sessionQueries.read(
        { type: 'conversation', threadId: thread },
        personalReadAuthority('owner-user'),
      ),
    ).resolves.toMatchObject({
      status: 'found',
      conversation: {
        id: conversationId,
        agentSlug: 'claude',
        projectSlug: 'station',
        title: 'Continue the Station history fix',
        messageCount: 2,
      },
      messages: [
        expect.objectContaining({ role: 'user' }),
        expect.objectContaining({ role: 'assistant' }),
      ],
    });
    expect(replay).toHaveBeenCalledTimes(1);
    replay.mockRestore();

    await expect(
      service.readSessionConversation(
        thread,
        personalReadAuthority('owner-user'),
      ),
    ).resolves.toMatchObject({
      id: conversationId,
      agentSlug: 'claude',
      environmentId: 'station-environment-a',
      acceptedModel: 'claude-sonnet',
      projectSlug: 'station',
      title: 'Continue the Station history fix',
      messageCount: 2,
    });
    await expect(
      service.readSessionConversation(
        thread,
        personalReadAuthority('other-user'),
      ),
    ).resolves.toBeNull();
    expect(
      service.readSessionMessages(thread, personalReadAuthority('other-user')),
    ).toEqual([]);
    await expect(
      service.listSessionConversations(
        'claude',
        personalReadAuthority('owner-user'),
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        id: conversationId,
        environmentId: 'station-environment-a',
        acceptedModel: 'claude-sonnet',
        title: 'Continue the Station history fix',
      }),
    ]);

    // S2 of archive#1302: the global counterpart folds every agent's sessions
    // (not one) and enriches each item with the live session fields the
    // inventory contract adds on top of what `readSessionConversation`
    // already returns.
    await expect(
      service.listAllSessionConversations(personalReadAuthority('owner-user')),
    ).resolves.toEqual([
      expect.objectContaining({
        id: conversationId,
        source: 'runtime',
        agentSlug: 'claude',
        projectSlug: 'station',
        title: 'Continue the Station history fix',
        messageCount: 2,
        mutable: false,
        provider: 'claude',
      }),
    ]);
    // Same ACL as `readSessionConversation`/`listSessionConversations` above
    // — a user who can't read the session doesn't see it in the global fold.
    await expect(
      service.listAllSessionConversations(personalReadAuthority('other-user')),
    ).resolves.toEqual([]);

    const fullInventory = await service.listAllSessionConversations(
      personalReadAuthority('owner-user'),
    );
    const indexedPage = await service.listConversationHistoryPage(
      personalReadAuthority('owner-user'),
      { limit: 1 },
    );
    expect(indexedPage).toMatchObject({ hasMore: false });
    expect(indexedPage.items).toEqual([
      expect.objectContaining({
        id: conversationId,
        projectSlug: fullInventory[0]?.projectSlug,
        controlMode: fullInventory[0]?.controlMode,
        provider: fullInventory[0]?.provider,
        model: fullInventory[0]?.model,
        acceptedModel: fullInventory[0]?.acceptedModel,
        environmentId: fullInventory[0]?.environmentId,
        lifecycleState: fullInventory[0]?.lifecycleState,
        pendingReview: fullInventory[0]?.pendingReview,
        hasActiveTurn: fullInventory[0]?.hasActiveTurn,
        // `observedAt` is stamped `new Date()` independently by each read,
        // so comparing the two whole objects only passes when both land in
        // the same millisecond. Compare the DERIVED half — which is what
        // "the two projections agree" actually means.
        answerability: expect.objectContaining({
          answerable: fullInventory[0]?.answerability.answerable,
        }),
      }),
    ]);

    const newerThread = 'child-session-conversation-newer';
    eventStore.reserveNextConversationSession({
      conversationId,
      predecessorSessionId: thread,
      proposedSessionId: newerThread,
      createdAt: '2026-07-23T00:03:00.000Z',
    });
    eventStore.upsertSession({
      provider: 'claude',
      threadId: newerThread,
      status: 'ready',
      model: 'claude-opus',
      createdAt: '2026-07-23T00:03:00.000Z',
      updatedAt: '2026-07-23T00:03:02.000Z',
    });
    eventStore.appendEvent({
      eventId: 'newer-child-started',
      provider: 'claude',
      threadId: newerThread,
      createdAt: '2026-07-23T00:03:00.000Z',
      method: 'session.started',
      sessionId: newerThread,
      metadata: {
        agentSlug: 'claude',
        userId: 'owner-user',
        conversationId,
        environmentId: 'station-environment-a',
      },
    });
    eventStore.appendEvent({
      eventId: 'newer-child-configured',
      provider: 'claude',
      threadId: newerThread,
      createdAt: '2026-07-23T00:03:01.000Z',
      method: 'session.configured',
      sessionId: newerThread,
      metadata: {
        conversationId,
        environmentId: 'station-environment-a',
        modelSelectionReceipt: {
          requestedModel: 'claude-opus',
          appliedModel: 'claude-opus',
        },
      },
    });
    eventStore.appendEvent({
      eventId: 'newer-child-turn',
      provider: 'claude',
      threadId: newerThread,
      turnId: 'newer-turn',
      createdAt: '2026-07-23T00:03:02.000Z',
      method: 'turn.started',
      prompt: 'Continue with the current child session',
    });

    await expect(
      service.listAllSessionConversations(personalReadAuthority('owner-user')),
    ).resolves.toEqual([
      expect.objectContaining({
        id: conversationId,
        acceptedModel: 'claude-opus',
        environmentId: 'station-environment-a',
        title: 'Continue the Station history fix',
        messageCount: 3,
        createdAt: '2026-07-23T00:00:00.000Z',
      }),
    ]);
  });

  test('reads one persisted conversation target without polling adapters or replaying a denied thread', async () => {
    const thread = 'thread-targeted-query';
    eventStore.upsertSession({
      provider: 'claude',
      threadId: thread,
      status: 'ready',
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
    });
    eventStore.appendEvent({
      eventId: 'targeted-query-started',
      provider: 'claude',
      threadId: thread,
      createdAt: '2026-08-12T00:00:00.000Z',
      method: 'session.started',
      sessionId: thread,
      metadata: { userId: 'owner-user', agentSlug: 'claude' },
    });
    const adapterListSessions = vi.spyOn(claude, 'listSessions');
    const readAllSessions = vi.spyOn(eventStore, 'readSessions');
    const readTargetSession = vi.spyOn(eventStore, 'readSessionByThread');
    const replay = vi.spyOn(eventStore, 'listEvents');

    await expect(
      service.sessionQueries.read(
        { type: 'conversation', threadId: 'missing-thread' },
        personalReadAuthority('owner-user'),
      ),
    ).resolves.toEqual({ status: 'not-found' });
    await expect(
      service.sessionQueries.read(
        { type: 'conversation', threadId: thread },
        personalReadAuthority('other-user'),
      ),
    ).resolves.toEqual({ status: 'not-found' });

    expect(readTargetSession).toHaveBeenNthCalledWith(1, 'missing-thread');
    expect(readTargetSession).toHaveBeenNthCalledWith(2, thread);
    expect(readAllSessions).not.toHaveBeenCalled();
    expect(adapterListSessions).not.toHaveBeenCalled();
    expect(replay).not.toHaveBeenCalled();
  });

  // S2 of archive#1302's flagged perf hazard: `readSessionConversation` derives a
  // title by reading each session's full message history — expensive at
  // scale. `listAllSessionConversations` caps to
  // `CONVERSATION_HISTORY_MAX_ENTRIES` (100) BEFORE that derivation runs, so
  // a population several times the cap should still only pay the
  // title-derivation cost for the capped window, not for every session that
  // exists. Not a strict perf gate (wall-clock varies by environment/CI
  // load) — the meaningful assertion is the cap itself; the logged duration
  // is a disclosed measurement for the PR, not an enforced threshold.
  test('S2 of #1302: caps recency window before title derivation over a large synthetic population', async () => {
    // Settle `initialize()`'s fire-and-forget recovery reconciliation
    // (`startReconciliation().then(() => recoverSessions())`) against the
    // empty store BEFORE seeding synthetic sessions directly into the event
    // store below — otherwise that background chain races the test's own
    // `afterEach` (`eventStore.close()`), which the archive#1101 fix elsewhere in
    // this file documents the same way.
    service.initialize();
    await waitForReceipt(
      (receipt) => receipt.kind === 'session.recovery.completed',
    );

    const totalSessions = 300;
    for (let i = 0; i < totalSessions; i++) {
      const threadId = `perf-thread-${i}`;
      const createdAt = new Date(2026, 0, 1, 0, 0, i).toISOString();
      eventStore.upsertSession({
        provider: 'claude',
        threadId,
        status: 'ready',
        createdAt,
        updatedAt: createdAt,
      });
      eventStore.appendEvent({
        eventId: `${threadId}-started`,
        provider: 'claude',
        threadId,
        createdAt,
        method: 'session.started',
        sessionId: threadId,
        metadata: {
          agentSlug: 'claude',
          userId: 'owner-user',
        },
      });
      eventStore.appendEvent({
        eventId: `${threadId}-turn`,
        provider: 'claude',
        threadId,
        turnId: 'turn-1',
        createdAt,
        method: 'turn.started',
        prompt: `Synthetic session ${i}`,
      });
    }

    const startedAt = performance.now();
    const items = await service.listAllSessionConversations(
      personalReadAuthority('owner-user'),
    );
    const durationMs = performance.now() - startedAt;

    // CONVERSATION_HISTORY_MAX_ENTRIES — the cap runs before title
    // derivation, so this count (not `totalSessions`) bounds the
    // title-derivation work.
    expect(items).toHaveLength(100);
    console.info(
      `[perf] listAllSessionConversations over ${totalSessions} synthetic sessions, capped to ${items.length}: ${durationMs.toFixed(1)}ms`,
    );
  }, 20_000);

  // archive#4466: `listSessionReadModel` backs `/api/orchestration/sessions/read-model`,
  // which the Activity view hits on mount and re-polls. It used to fold every
  // visible thread by calling `eventStore.listSessionProjectionEvents(threadId)`
  // (and `countEventsByThread(threadId)`) inside a `.map` — roughly a dozen
  // separate indexed SQL round trips PER THREAD, so the read's total query
  // count scaled with the population instead of being bounded. This is not a
  // strict perf gate (wall-clock varies by environment/CI load, matching the
  // disclosed-measurement convention `S2 of archive#1302` above uses) — the
  // meaningful assertions are the batched query-count bound and the exact
  // set of returned threads; the logged duration is a disclosed measurement
  // for the PR, not an enforced threshold.
  test('station#4466: folds a large synthetic population through the batched projection read', async () => {
    // A dedicated store/service, not the shared `service`/`eventStore`
    // fixture: that fixture's `sessionOwnerCacheMaxEntries: 2` (set for the
    // suite's own LRU-eviction tests) would force a `sessionOwnerUserId`
    // cache miss — a real but UNRELATED per-thread SQL cost — on almost
    // every thread, drowning out the query-count signal this test exists to
    // pin. A realistic cache size (the production default) isolates the
    // measurement to the projection/count fold this fix changed.
    const perfTmp = mkdtempSync(join(tmpdir(), 'orchestration-service-perf-'));
    const perfEventStore = new EventStore(
      join(perfTmp, 'orchestration.sqlite'),
    );
    const perfAdoptionLedger = perfEventStore.createAdoptionLedger();
    const perfService = new OrchestrationService({
      adapterRegistry: createRegistry([new FakeAdapter('claude')]),
      eventBus: new EventBus(),
      eventStore: perfEventStore,
      adoptionLedger: perfAdoptionLedger,
      flowRunService: new FlowRunService(),
      listProjects: () => [],
      agentPolicyService: new AgentPolicyService({
        env: { ...process.env, SA_HOOK_PROFILE: '', SA_DISABLED_HOOKS: '' },
        logger: { debug: vi.fn(), warn: vi.fn() },
      }),
      workflowSidecarService: new WorkflowSidecarService({
        logger: { debug: vi.fn(), warn: vi.fn() },
      }),
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    try {
      // Settle `initialize()`'s fire-and-forget recovery reconciliation
      // against the EMPTY store before seeding synthetic sessions below —
      // the same reason the `S2 of archive#1302` test above does this: recovery is
      // a one-time startup scan, not a per-poll cost, and left unsettled it
      // would race the seeding loop and contaminate this test's query count
      // with its own (unrelated, one-time) per-session reads.
      perfService.initialize();
      await waitForReceipt(
        (receipt) => receipt.kind === 'session.recovery.completed',
      );

      const totalSessions = 400;
      for (let i = 0; i < totalSessions; i++) {
        const threadId = `read-model-perf-thread-${i}`;
        const createdAt = new Date(2026, 0, 1, 0, 0, i).toISOString();
        perfEventStore.upsertSession({
          provider: 'claude',
          threadId,
          status: 'ready',
          createdAt,
          updatedAt: createdAt,
        });
        perfEventStore.appendEvent({
          eventId: `${threadId}-started`,
          provider: 'claude',
          threadId,
          createdAt,
          method: 'session.started',
          sessionId: threadId,
          metadata: { agentSlug: 'claude', userId: 'owner-user' },
        });
        perfEventStore.appendEvent({
          eventId: `${threadId}-configured`,
          provider: 'claude',
          threadId,
          createdAt,
          method: 'session.configured',
          sessionId: threadId,
          model: 'claude-sonnet-4-5',
        });
        perfEventStore.appendEvent({
          eventId: `${threadId}-turn1-started`,
          provider: 'claude',
          threadId,
          turnId: 'turn-1',
          createdAt,
          method: 'turn.started',
          prompt: `Synthetic prompt ${i}`,
        });
        perfEventStore.appendEvent({
          eventId: `${threadId}-turn1-completed`,
          provider: 'claude',
          threadId,
          turnId: 'turn-1',
          createdAt,
          method: 'turn.completed',
          finishReason: 'stop',
        } as any);
        perfEventStore.appendEvent({
          eventId: `${threadId}-turn2-started`,
          provider: 'claude',
          threadId,
          turnId: 'turn-2',
          createdAt,
          method: 'turn.started',
          prompt: `Synthetic follow-up ${i}`,
        });
        perfEventStore.appendEvent({
          eventId: `${threadId}-turn2-completed`,
          provider: 'claude',
          threadId,
          turnId: 'turn-2',
          createdAt,
          method: 'turn.completed',
          finishReason: 'stop',
        } as any);
      }

      const rawDb = (perfEventStore as unknown as { db: DatabaseSync }).db;
      let observedQueries = 0;
      const shapeCounts = new Map<string, number>();
      const originalPrepare = rawDb.prepare.bind(rawDb);
      const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();
      rawDb.prepare = ((sql: string) => {
        observedQueries += 1;
        const shape = normalize(sql);
        shapeCounts.set(shape, (shapeCounts.get(shape) ?? 0) + 1);
        return originalPrepare(sql);
      }) as typeof originalPrepare;

      const startedAt = performance.now();
      const items = await perfService.listSessionReadModel(
        personalReadAuthority('owner-user'),
      );
      const durationMs = performance.now() - startedAt;
      rawDb.prepare = originalPrepare;

      expect(items).toHaveLength(totalSessions);

      // The direct proof of the fix: each bounded batched-query shape fires
      // EXACTLY ONCE for the whole 400-thread population (they all fit in
      // one 500-id chunk), never once per thread.
      const countOfShapeContaining = (needle: string) =>
        [...shapeCounts.entries()]
          .filter(([shape]) => shape.includes(needle))
          .reduce((sum, [, count]) => sum + count, 0);
      // fetchRankedMethodFacts: the two-phase, payload-deferred ranking over
      // PROJECTION_FOLD_METHODS.
      expect(
        countOfShapeContaining(
          'PARTITION BY thread_id, method ORDER BY sequence DESC',
        ),
      ).toBe(1);
      // fetchLatestAnyEvent: same two-phase shape, unfiltered by method (no
      // comma before ORDER BY distinguishes it from the query above).
      expect(
        countOfShapeContaining('PARTITION BY thread_id ORDER BY sequence DESC'),
      ).toBe(1);
      // fetchFirstTurnStartedWithPrompt: the JSON-predicate query, still one
      // shot for the whole population.
      expect(
        countOfShapeContaining("typeof(json_extract(payload, '$.prompt'))"),
      ).toBe(1);
      // fetchTurnScopedEvent for the turn-scoped terminal: every seeded
      // thread's latest turn (turn-2) has a matching `turn.completed`, so
      // this companion query fires once (chunked pairs, all in one chunk).
      // `PARTITION BY thread_id, turn_id ORDER BY sequence DESC` is unique to
      // this query (the ranked-method query above partitions by
      // `thread_id, method`, not `thread_id, turn_id`).
      expect(
        countOfShapeContaining(
          'PARTITION BY thread_id, turn_id ORDER BY sequence DESC',
        ),
      ).toBe(1);
      // fetchTurnScopedEvent for latestCurrentTurnRuntimeErrorEvent's own-
      // turn-start lookup: NO thread in this corpus has a `runtime.error`,
      // so the pairs list is empty and the query is skipped entirely — zero
      // calls proves the empty-list short-circuit, not just its presence.
      // `PARTITION BY thread_id, turn_id ORDER BY sequence ASC` is unique to
      // this (skipped) query.
      expect(
        countOfShapeContaining(
          'PARTITION BY thread_id, turn_id ORDER BY sequence ASC',
        ),
      ).toBe(0);
      expect(
        countOfShapeContaining(
          'FROM orchestration_session_projection_facts AS fact',
        ),
      ).toBe(1);
      expect(
        countOfShapeContaining('FROM orchestration_request_state AS current'),
      ).toBe(1);
      expect(
        countOfShapeContaining(
          'SELECT thread_id AS threadId, COUNT(*) AS c FROM orchestration_events WHERE thread_id IN',
        ),
      ).toBe(1);

      // archive#4466 investigation note (not this fix's scope): the total
      // query count is still well above 4, because `isEphemeralSession`
      // (called once per thread from this same method's readable-thread
      // filter, BEFORE the batched fold below it) and
      // `canReadSession`'s owner-cache miss (session-authorization.ts,
      // unavoidable for a never-before-seen thread regardless of cache
      // size) each cost one additional per-thread SQL round trip,
      // independent of this fix. Retired, this fold alone would have cost
      // roughly a dozen per-thread round trips PER FACT — table stakes is
      // confirming the total stays a small multiple of `totalSessions`
      // (one query per thread per SURVIVING per-thread cost), never a
      // `totalSessions * dozen` blowup.
      expect(observedQueries).toBeLessThan(totalSessions * 5);
      console.info(
        `[perf] listSessionReadModel over ${totalSessions} synthetic sessions (2 turns each): ${durationMs.toFixed(1)}ms, ${observedQueries} prepared statements`,
      );
    } finally {
      perfEventStore.close();
      rmSync(perfTmp, { recursive: true, force: true });
    }
  }, 60_000);

  // archive#4466: `listAgentRuns` is `listSessionReadModel`'s copy-pasted
  // sibling — same `.map` over `listSessionProjectionEvents`/
  // `countEventsByThread` per thread, in this same service. Switched to the
  // same batched primitives; this pins the wiring the way the route test
  // for `/sessions/read-model` does, at the service boundary.
  test('station#4466: listAgentRuns reads every visible thread through the batched projection query, not one per thread', async () => {
    const threadIds = [
      'agent-runs-batch-a',
      'agent-runs-batch-b',
      'agent-runs-batch-c',
    ];
    for (const threadId of threadIds) {
      eventStore.upsertSession({
        provider: 'claude',
        threadId,
        status: 'ready',
        createdAt: '2026-08-26T00:00:00.000Z',
        updatedAt: '2026-08-26T00:00:00.000Z',
      });
      eventStore.appendEvent({
        eventId: `${threadId}-started`,
        provider: 'claude',
        threadId,
        createdAt: '2026-08-26T00:00:00.000Z',
        method: 'session.started',
        sessionId: threadId,
        metadata: { agentSlug: 'claude', userId: 'owner-user' },
      });
      eventStore.appendEvent({
        eventId: `${threadId}-turn-started`,
        provider: 'claude',
        threadId,
        turnId: 'turn-1',
        createdAt: '2026-08-26T00:00:00.000Z',
        method: 'turn.started',
        prompt: `prompt for ${threadId}`,
      });
    }

    const batchedCalls: Array<readonly string[]> = [];
    const originalBatched =
      eventStore.listSessionProjectionEventsForThreads.bind(eventStore);
    eventStore.listSessionProjectionEventsForThreads = ((
      ids: readonly string[],
    ) => {
      batchedCalls.push(ids);
      return originalBatched(ids);
    }) as typeof eventStore.listSessionProjectionEventsForThreads;
    let singleThreadCalls = 0;
    const originalSingle =
      eventStore.listSessionProjectionEvents.bind(eventStore);
    eventStore.listSessionProjectionEvents = ((id: string) => {
      singleThreadCalls += 1;
      return originalSingle(id);
    }) as typeof eventStore.listSessionProjectionEvents;

    const runs = await service.listAgentRuns(
      personalReadAuthority('owner-user'),
    );

    eventStore.listSessionProjectionEventsForThreads = originalBatched;
    eventStore.listSessionProjectionEvents = originalSingle;

    expect(runs.map((run) => run.sessionId).sort()).toEqual(
      [...threadIds].sort(),
    );
    expect(batchedCalls).toHaveLength(1);
    expect([...batchedCalls[0]!].sort()).toEqual([...threadIds].sort());
    expect(singleThreadCalls).toBe(0);
  });

  test('routes commands to the adapter that owns the session thread', async () => {
    const startCommand: OrchestrationCommand = {
      type: 'startSession',
      input: {
        threadId: 'thread-1',
        provider: 'claude',
        modelId: 'claude-sonnet',
      },
    };
    const session = await service.dispatch(startCommand);
    expect(session).toMatchObject({
      provider: 'claude',
      threadId: 'thread-1',
    });

    await service.dispatch({
      type: 'sendTurn',
      input: { threadId: 'thread-1', input: 'hello' },
    });
    expect(claude.sendTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread-1',
        input: 'hello',
        metadata: expect.objectContaining({
          modelLaunchPlan: {
            kind: 'engine-selected',
            evidence: 'adapter-declared',
          },
        }),
      }),
    );
    expect(bedrock.sendTurn).not.toHaveBeenCalled();
  });

  test('binds an authorized Station-agent turn correlation before crossing the internal chat relay', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );
    const stationAgent = new StationAgentAdapter({
      apiBase: 'http://127.0.0.1:3141',
      hasAgent: () => true,
      eventBus,
      approvalRegistry: new ApprovalRegistry(
        { info: vi.fn(), warn: vi.fn() },
        { eventBus },
      ),
      fetch: fetchMock,
    });
    const stationService = new OrchestrationService({
      adapterRegistry: createRegistry([stationAgent]),
      eventBus,
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    await stationService.dispatch(
      {
        type: 'startSession',
        input: {
          threadId: 'fleet-authorized-session',
          provider: 'station-agent',
          metadata: { agentId: 'reviewer' },
        },
      },
      { userId: 'account-a' },
    );
    // The HTTP route stamps this server-derived owner before it calls the
    // service. This unit test enters the service directly, so model that
    // already-authorized boundary explicitly rather than making an owner up
    // in the correlation code itself.
    eventStore.appendEvent({
      eventId: 'fleet-authorized-owner',
      provider: 'station-agent',
      threadId: 'fleet-authorized-session',
      createdAt: new Date().toISOString(),
      method: 'session.configured',
      sessionId: 'fleet-authorized-session',
      metadata: { userId: 'account-a', agentId: 'reviewer' },
    } as CanonicalRuntimeEvent);

    const turn = await stationService.dispatch(
      {
        type: 'sendTurn',
        input: {
          threadId: 'fleet-authorized-session',
          input: 'private prompt stays out of correlation',
          clientTurnId: 'fleet-redelivery',
        },
      },
      { userId: 'account-a' },
    );
    const redelivery = await stationService.dispatch(
      {
        type: 'sendTurn',
        input: {
          threadId: 'fleet-authorized-session',
          input: 'private prompt stays out of correlation',
          clientTurnId: 'fleet-redelivery',
        },
      },
      { userId: 'account-a' },
    );

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    const correlation = readAuthorizedTurnCorrelationHandoff(
      headers[INTERNAL_TURN_CORRELATION_HEADER],
    );
    if (
      !turn ||
      !('turnId' in turn) ||
      !redelivery ||
      !('turnId' in redelivery)
    ) {
      throw new Error('Expected both dispatches to return provider turn ids');
    }
    expect(correlation).toMatchObject({
      accountId: 'account-a',
      sessionId: 'fleet-authorized-session',
      turnId: turn.turnId,
    });
    expect(correlation?.correlationId).toMatch(/^fleet:[0-9a-f]{64}$/u);
    expect(redelivery.turnId).toBe(turn.turnId);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(headers)).not.toContain('private prompt');
  });

  test('sendTurn composes ambient context into the model-facing input at the dispatch choke point (#685)', async () => {
    await service.dispatch({
      type: 'startSession',
      input: {
        threadId: 'thread-ambient',
        provider: 'claude',
        modelId: 'claude-sonnet',
      },
    });

    await service.dispatch({
      type: 'sendTurn',
      input: {
        threadId: 'thread-ambient',
        input: 'what time is it?',
        ambientContext: '[Timezone: America/Denver]',
      },
    });

    // The adapter receives the composed model input, typed display text,
    // relay-only ambient context, and the server-owned launch plan.
    expect(claude.sendTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread-ambient',
        input: '[Timezone: America/Denver]\nwhat time is it?',
        displayInput: 'what time is it?',
        ambientContext: '[Timezone: America/Denver]',
        metadata: expect.objectContaining({
          modelLaunchPlan: expect.any(Object),
        }),
      }),
    );
  });

  test('sendTurn without ambient context reaches the adapter unchanged (#685 passthrough)', async () => {
    await service.dispatch({
      type: 'startSession',
      input: {
        threadId: 'thread-plain',
        provider: 'claude',
        modelId: 'claude-sonnet',
      },
    });

    await service.dispatch({
      type: 'sendTurn',
      input: { threadId: 'thread-plain', input: 'hello there' },
    });

    expect(claude.sendTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread-plain',
        input: 'hello there',
        metadata: expect.objectContaining({
          modelLaunchPlan: expect.any(Object),
        }),
      }),
    );
  });

  test('instructionsInFirstTurn (#895 wave C): a pending first-turn receipt is prepended once, never re-prepended, and the persisted turn keeps only the typed prompt (so a continuation transcript seed built from it can never duplicate it)', async () => {
    // Muse has no native systemPrompt channel — session-agent-resolution.ts
    // falls back to `channel: 'first-turn'` for it (see the matrix's
    // `instructionsInFirstTurn` cell). This adapter double is a minimal
    // stand-in for muse-adapter.ts's own real behavior: it spreads
    // `input.metadata` into `session.started` (so the receipt lands
    // durably), and stamps `turn.started`'s `prompt` from
    // `input.displayInput ?? input.input` (so it persists the TYPED text
    // only) — both mirror the production adapter exactly.
    const museFirstTurn = new FakeAdapter('muse');
    museFirstTurn.startSession.mockImplementation(async (input) => {
      const now = new Date().toISOString();
      museFirstTurn.events.push({
        eventId: randomUUID(),
        provider: 'muse',
        threadId: input.threadId,
        createdAt: now,
        method: 'session.started',
        sessionId: input.threadId,
        initialState: 'created',
        metadata: { ...input.metadata },
      });
      return {
        provider: 'muse',
        threadId: input.threadId,
        status: 'ready',
        createdAt: now,
        updatedAt: now,
      };
    });
    let turnCounter = 0;
    museFirstTurn.sendTurn.mockImplementation(async (input) => {
      turnCounter += 1;
      const turnId = `muse-turn-${turnCounter}`;
      museFirstTurn.events.push({
        eventId: randomUUID(),
        provider: 'muse',
        threadId: input.threadId,
        turnId,
        createdAt: new Date().toISOString(),
        method: 'turn.started',
        prompt: input.displayInput ?? input.input,
      });
      return { threadId: input.threadId, turnId };
    });

    const resolveSessionAgent = createSessionAgentResolver({
      loadAgentSpec: async () => ({
        name: 'Muse Agent',
        prompt: 'Be terse.',
      }),
      resolveToolServer: async () => null,
      resolveSkillDir: async () => null,
    });
    const museService = new OrchestrationService({
      adapterRegistry: createRegistry([museFirstTurn]),
      eventBus,
      eventStore,
      resolveSessionAgent,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    const threadId = 'thread-muse-first-turn-instructions';

    await museService.dispatch({
      type: 'startSession',
      input: {
        threadId,
        provider: 'muse',
        modelId: 'muse-spark-1.2-contributor',
        metadata: { agentSlug: 'muse-agent' },
      },
    });
    await waitFor(
      () => eventStore.listEvents(threadId),
      (events) => events.some((event) => event.method === 'session.started'),
    );

    await museService.dispatch({
      type: 'sendTurn',
      input: { threadId, input: 'Hello' },
    });

    // The composed model input carries the authored prompt ahead of the
    // typed text; the typed text alone remains the transcript-facing value.
    // Independent review MEDIUM-1: the dispatch that genuinely composed the
    // pending receipt ALSO stamps the server-owned
    // firstTurnInstructionsComposed marker into the turn's own metadata —
    // the delivering adapter carries it onto turn.started, which is what
    // lets the delegate seam derive 'delivered' from THIS turn's own
    // record rather than merely from a turn having started.
    expect(museFirstTurn.sendTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        input: 'Be terse.\nHello',
        displayInput: 'Hello',
        metadata: expect.objectContaining({
          firstTurnInstructionsComposed: true,
        }),
      }),
    );

    await waitFor(
      () => eventStore.listEvents(threadId),
      (events) => events.some((event) => event.method === 'turn.started'),
    );
    const firstTurnStarted = eventStore
      .listEvents(threadId)
      .find((event) => event.method === 'turn.started');
    expect(firstTurnStarted).toBeDefined();
    // The persisted transcript prompt is the TYPED text only. #895 wave C's
    // conversation-lineage.ts `continuationTranscriptSeed` builds a
    // continuation child's seed exclusively from this same persisted field
    // (user/assistant `part.text`, never `ambientContext`), so a fresh child
    // session's own first-turn receipt is the ONLY place the authored prompt
    // can ever appear in its composed input — never twice from a
    // transcript that already baked it in once.
    expect((firstTurnStarted!.payload as { prompt?: string }).prompt).toBe(
      'Hello',
    );

    museFirstTurn.sendTurn.mockClear();
    await museService.dispatch({
      type: 'sendTurn',
      input: { threadId, input: 'Again' },
    });

    // A second turn on the SAME session: current.events already carries the
    // first turn.started, so the receipt is never re-read as pending — and
    // the marker is never stamped on a turn that composed nothing.
    expect(museFirstTurn.sendTurn).toHaveBeenCalledWith(
      expect.objectContaining({ input: 'Again' }),
    );
    expect(museFirstTurn.sendTurn).not.toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.stringContaining('Be terse.') }),
    );
    const secondTurnCall = museFirstTurn.sendTurn.mock.calls.at(-1)?.[0] as
      | { metadata?: Record<string, unknown> }
      | undefined;
    expect(secondTurnCall?.metadata?.firstTurnInstructionsComposed).not.toBe(
      true,
    );

    await museService.shutdown();
  });

  test('sendTurn validates attachments before dispatch and records successful bytes', async () => {
    await service.dispatch({
      type: 'startSession',
      input: {
        threadId: 'thread-attachment',
        provider: 'claude',
        modelId: 'claude-sonnet',
      },
    });
    const attachment = {
      kind: 'image' as const,
      name: 'screen.png',
      mimeType: 'image/png' as const,
      size: 5,
      dataUrl: 'data:image/png;base64,aGVsbG8=',
    };

    await service.dispatch({
      type: 'sendTurn',
      input: {
        threadId: 'thread-attachment',
        input: 'inspect this',
        attachments: [attachment],
      },
    });

    expect(claude.sendTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread-attachment',
        input: 'inspect this',
        attachments: [attachment],
        metadata: expect.objectContaining({
          modelLaunchPlan: expect.any(Object),
        }),
      }),
    );
    expect(chatAttachmentsDispatched.add).toHaveBeenCalledWith(1, {
      provider: 'claude',
      kind: 'image',
      mime_type: 'image/png',
    });
    expect(chatAttachmentBytesDispatched.add).toHaveBeenCalledWith(5, {
      provider: 'claude',
      kind: 'image',
      mime_type: 'image/png',
    });
  });

  test('sendTurn rejects forged attachment metadata before adapter dispatch', async () => {
    await service.dispatch({
      type: 'startSession',
      input: {
        threadId: 'thread-forged-attachment',
        provider: 'claude',
        modelId: 'claude-sonnet',
      },
    });
    claude.sendTurn.mockClear();

    await expect(
      service.dispatch({
        type: 'sendTurn',
        input: {
          threadId: 'thread-forged-attachment',
          input: 'inspect this',
          attachments: [
            {
              kind: 'image',
              name: 'screen.png',
              mimeType: 'image/png',
              size: 99,
              dataUrl: 'data:image/png;base64,aGVsbG8=',
            },
          ],
        },
      }),
    ).rejects.toThrow('does not match its declared type and size');

    expect(claude.sendTurn).not.toHaveBeenCalled();
  });

  test('sendTurn rejects attachment kinds the selected adapter does not advertise', async () => {
    await service.dispatch({
      type: 'startSession',
      input: {
        threadId: 'thread-unsupported-attachment',
        provider: 'bedrock',
        modelId: 'managed-model',
      },
    });
    bedrock.sendTurn.mockClear();
    vi.mocked(chatAttachmentsDispatched.add).mockClear();

    await expect(
      service.dispatch({
        type: 'sendTurn',
        input: {
          threadId: 'thread-unsupported-attachment',
          input: 'inspect this',
          attachments: [
            {
              kind: 'image',
              name: 'screen.png',
              mimeType: 'image/png',
              size: 5,
              dataUrl: 'data:image/png;base64,aGVsbG8=',
            },
          ],
        },
      }),
    ).rejects.toThrow('does not support image attachments');

    expect(bedrock.sendTurn).not.toHaveBeenCalled();
    expect(chatAttachmentsDispatched.add).not.toHaveBeenCalled();
  });

  describe('station#1885 — station-agent image attachments', () => {
    // Uses the REAL StationAgentAdapter (not FakeAdapter) so the capability
    // declaration under test is the production one; only the inner /chat relay
    // is mocked. Pre-fix this threw "Station agents does not support image
    // attachments." at the gate because the adapter declared no image-input.
    function buildStationAgentService(
      fetchMock: ReturnType<typeof vi.fn<typeof fetch>>,
    ) {
      const stationAgent = new StationAgentAdapter({
        apiBase: 'http://127.0.0.1:3141',
        hasAgent: () => true,
        approvalRegistry: new ApprovalRegistry(
          { info: vi.fn(), warn: vi.fn() },
          { eventBus },
        ),
        eventBus,
        fetch: fetchMock,
      });
      return new OrchestrationService({
        adapterRegistry: createRegistry([stationAgent]),
        eventBus,
        eventStore,
        logger: { debug: vi.fn(), warn: vi.fn() },
      });
    }

    test('accepts an image attachment and forwards it through the relay as multipart input', async () => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          new ReadableStream({
            start(controller) {
              const enc = new TextEncoder();
              controller.enqueue(
                enc.encode(
                  `data: ${JSON.stringify({ type: 'finish', finishReason: 'stop' })}\n\ndata: [DONE]\n\n`,
                ),
              );
              controller.close();
            },
          }),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        ),
      );
      const stationService = buildStationAgentService(fetchMock);
      const threadId = 'thread-1885-image';

      await stationService.dispatch({
        type: 'startSession',
        input: {
          threadId,
          provider: 'station-agent',
          modelId: 'claude-sonnet',
          metadata: { agentId: 'reviewer' },
        },
      });

      // The defect: pre-fix this dispatch threw at the capability gate before
      // the adapter ever ran. Post-fix the gate passes AND the attachment is
      // carried through the relay body (not silently dropped).
      await stationService.dispatch({
        type: 'sendTurn',
        input: {
          threadId,
          input: 'describe this image',
          attachments: [
            {
              kind: 'image',
              name: 'screen.png',
              mimeType: 'image/png',
              size: 5,
              dataUrl: 'data:image/png;base64,aGVsbG8=',
            },
          ],
        },
      });

      const relayBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
      // The relay input must be the multipart array shape /chat accepts, with
      // the image carried as a file part — proving the attachment reaches the
      // downstream pipeline rather than being dropped after the gate passed.
      expect(Array.isArray(relayBody.input)).toBe(true);
      expect(relayBody.input[0].role).toBe('user');
      const filePart = relayBody.input[0].parts.find(
        (part: { type: string }) => part.type === 'file',
      );
      expect(filePart).toEqual({
        type: 'file',
        url: 'data:image/png;base64,aGVsbG8=',
        mediaType: 'image/png',
      });
      const textPart = relayBody.input[0].parts.find(
        (part: { type: string }) => part.type === 'text',
      );
      expect(textPart).toEqual({ type: 'text', text: 'describe this image' });
      await stationService.shutdown();
    });

    test('still refuses a file attachment the station-agent adapter does not advertise', async () => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('ok', { status: 200 }));
      const stationService = buildStationAgentService(fetchMock);
      const threadId = 'thread-1885-file';

      await stationService.dispatch({
        type: 'startSession',
        input: {
          threadId,
          provider: 'station-agent',
          modelId: 'claude-sonnet',
          metadata: { agentId: 'reviewer' },
        },
      });

      await expect(
        stationService.dispatch({
          type: 'sendTurn',
          input: {
            threadId,
            input: 'review this document',
            attachments: [
              {
                kind: 'file',
                name: 'notes.pdf',
                mimeType: 'application/pdf',
                size: 5,
                dataUrl: 'data:application/pdf;base64,aGVsbG8=',
              },
            ],
          },
        }),
      ).rejects.toThrow('does not support file attachments');

      expect(fetchMock).not.toHaveBeenCalled();
      await stationService.shutdown();
    });
  });

  describe('sendTurn client-turn idempotency (station#1224 offline slice 2)', () => {
    test('two sendTurn dispatches with the SAME clientTurnId execute the adapter only once', async () => {
      await service.dispatch({
        type: 'startSession',
        input: {
          threadId: 'thread-dedup',
          provider: 'claude',
          modelId: 'claude-sonnet',
        },
      });
      claude.sendTurn.mockClear();

      const first = await service.dispatch({
        type: 'sendTurn',
        input: {
          threadId: 'thread-dedup',
          input: 'hello',
          clientTurnId: 'client-turn-1',
        },
      });
      const second = await service.dispatch({
        type: 'sendTurn',
        input: {
          threadId: 'thread-dedup',
          input: 'hello',
          clientTurnId: 'client-turn-1',
        },
      });

      expect(claude.sendTurn).toHaveBeenCalledTimes(1);
      // The deduped second dispatch hands back the SAME turnId as the
      // original — the caller can treat it as "the turn already landed"
      // rather than getting nothing.
      expect(second).toEqual(first);
      expect(
        eventStore.createTurnDeduplicator().claim({
          threadId: 'thread-dedup',
          clientTurnId: 'client-turn-1',
        }),
      ).toEqual({
        kind: 'contended',
        turnId: (first as { turnId: string }).turnId,
      });
    });

    test('a DIFFERENT clientTurnId on the same thread executes independently', async () => {
      await service.dispatch({
        type: 'startSession',
        input: {
          threadId: 'thread-dedup-distinct',
          provider: 'claude',
          modelId: 'claude-sonnet',
        },
      });
      claude.sendTurn.mockClear();
      claude.sendTurn
        .mockResolvedValueOnce({
          threadId: 'thread-dedup-distinct',
          turnId: 'claude-turn-a',
        })
        .mockResolvedValueOnce({
          threadId: 'thread-dedup-distinct',
          turnId: 'claude-turn-b',
        });

      await service.dispatch({
        type: 'sendTurn',
        input: {
          threadId: 'thread-dedup-distinct',
          input: 'first',
          clientTurnId: 'client-turn-a',
        },
      });
      await service.dispatch({
        type: 'sendTurn',
        input: {
          threadId: 'thread-dedup-distinct',
          input: 'second',
          clientTurnId: 'client-turn-b',
        },
      });

      expect(claude.sendTurn).toHaveBeenCalledTimes(2);
    });

    test('retains accepted truth when interrupt fails before a later terminal', async () => {
      await service.dispatch({
        type: 'startSession',
        input: {
          threadId: 'thread-accepted-abort',
          provider: 'claude',
          modelId: 'claude-sonnet',
        },
      });
      claude.sendTurn.mockClear();
      const controller = new AbortController();
      claude.sendTurn.mockImplementationOnce(async () => {
        controller.abort();
        return {
          threadId: 'thread-accepted-abort',
          turnId: 'accepted-before-abort',
        };
      });
      claude.interruptTurn.mockRejectedValueOnce(
        new Error('interrupt transport failed'),
      );

      await expect(
        service.dispatch({
          type: 'sendTurn',
          input: {
            threadId: 'thread-accepted-abort',
            input: 'run once',
            clientTurnId: 'client-accepted-abort',
            signal: controller.signal,
          },
        }),
      ).resolves.toMatchObject({ turnId: 'accepted-before-abort' });
      expect(claude.interruptTurn).toHaveBeenCalledWith(
        'thread-accepted-abort',
        'accepted-before-abort',
      );
      expect(
        eventStore.createTurnDeduplicator().claim({
          threadId: 'thread-accepted-abort',
          clientTurnId: 'client-accepted-abort',
        }),
      ).toEqual({ kind: 'contended', turnId: 'accepted-before-abort' });
      expect(
        eventStore
          .sessionTurnBoundaryAuthority()
          .hasPossibleEffect('thread-accepted-abort'),
      ).toEqual({ kind: 'available', active: true });

      await expect(
        service.dispatch({
          type: 'sendTurn',
          input: {
            threadId: 'thread-accepted-abort',
            input: 'run once',
            clientTurnId: 'client-accepted-abort',
          },
        }),
      ).resolves.toMatchObject({ turnId: 'accepted-before-abort' });
      expect(claude.sendTurn).toHaveBeenCalledOnce();

      (
        service as unknown as {
          projectAndPublishEvent(event: CanonicalRuntimeEvent): boolean;
        }
      ).projectAndPublishEvent({
        eventId: 'terminal:thread-accepted-abort',
        provider: 'claude',
        threadId: 'thread-accepted-abort',
        turnId: 'accepted-before-abort',
        createdAt: new Date().toISOString(),
        method: 'turn.completed',
        outputText: 'late effect completed',
      });
      expect(
        eventStore
          .sessionTurnBoundaryAuthority()
          .hasPossibleEffect('thread-accepted-abort'),
      ).toEqual({ kind: 'available', active: false });
    });

    test('retains accepted truth when the engine acknowledges an interrupt', async () => {
      await service.dispatch({
        type: 'startSession',
        input: {
          threadId: 'thread-accepted-interrupt-ack',
          provider: 'claude',
          modelId: 'claude-sonnet',
        },
      });
      claude.sendTurn.mockClear();
      const controller = new AbortController();
      claude.sendTurn.mockImplementationOnce(async () => {
        controller.abort();
        return {
          threadId: 'thread-accepted-interrupt-ack',
          turnId: 'accepted-before-interrupt-ack',
        };
      });

      await expect(
        service.dispatch({
          type: 'sendTurn',
          input: {
            threadId: 'thread-accepted-interrupt-ack',
            input: 'run once',
            clientTurnId: 'client-accepted-interrupt-ack',
            signal: controller.signal,
          },
        }),
      ).resolves.toMatchObject({ turnId: 'accepted-before-interrupt-ack' });
      expect(claude.interruptTurn).toHaveBeenCalledWith(
        'thread-accepted-interrupt-ack',
        'accepted-before-interrupt-ack',
      );
      expect(
        eventStore.createTurnDeduplicator().claim({
          threadId: 'thread-accepted-interrupt-ack',
          clientTurnId: 'client-accepted-interrupt-ack',
        }),
      ).toEqual({
        kind: 'contended',
        turnId: 'accepted-before-interrupt-ack',
      });
      expect(
        eventStore
          .sessionTurnBoundaryAuthority()
          .hasPossibleEffect('thread-accepted-interrupt-ack'),
      ).toEqual({ kind: 'available', active: true });

      await expect(
        service.dispatch({
          type: 'sendTurn',
          input: {
            threadId: 'thread-accepted-interrupt-ack',
            input: 'run once',
            clientTurnId: 'client-accepted-interrupt-ack',
          },
        }),
      ).resolves.toMatchObject({ turnId: 'accepted-before-interrupt-ack' });
      expect(claude.sendTurn).toHaveBeenCalledOnce();
    });

    test('returns the accepted turn when interrupt cleanup times out', async () => {
      const timeoutAdapter = new FakeAdapter('claude');
      const timeoutService = new OrchestrationService({
        adapterRegistry: createRegistry([timeoutAdapter]),
        eventBus,
        eventStore,
        adapterStopTimeoutMs: 10,
        logger: { debug: vi.fn(), warn: vi.fn() },
      });
      const controller = new AbortController();
      timeoutAdapter.sendTurn.mockImplementationOnce(async () => {
        controller.abort();
        return {
          threadId: 'thread-accepted-timeout',
          turnId: 'accepted-before-timeout',
        };
      });
      timeoutAdapter.interruptTurn.mockImplementationOnce(
        () => new Promise<ProviderInterruptTurnResult>(() => undefined),
      );
      await timeoutService.dispatch({
        type: 'startSession',
        input: {
          threadId: 'thread-accepted-timeout',
          provider: 'claude',
          modelId: 'claude-sonnet',
        },
      });

      await expect(
        timeoutService.dispatch({
          type: 'sendTurn',
          input: {
            threadId: 'thread-accepted-timeout',
            input: 'run once',
            clientTurnId: 'client-accepted-timeout',
            signal: controller.signal,
          },
        }),
      ).resolves.toMatchObject({ turnId: 'accepted-before-timeout' });
      expect(timeoutAdapter.sendTurn).toHaveBeenCalledOnce();
      expect(
        eventStore.createTurnDeduplicator().claim({
          threadId: 'thread-accepted-timeout',
          clientTurnId: 'client-accepted-timeout',
        }),
      ).toEqual({ kind: 'contended', turnId: 'accepted-before-timeout' });
    });

    test('keeps the exact accepted client claim when a post-accept observer throws', async () => {
      await service.dispatch({
        type: 'startSession',
        input: {
          threadId: 'thread-accepted-observer-fault',
          provider: 'claude',
          modelId: 'claude-sonnet',
        },
      });
      claude.sendTurn.mockClear();
      claude.sendTurn.mockResolvedValueOnce({
        threadId: 'thread-accepted-observer-fault',
        turnId: 'accepted-before-observer-fault',
      });
      vi.mocked(adapterTurnDuration.record).mockImplementationOnce(() => {
        throw new Error('metrics observer failed');
      });

      await expect(
        service.dispatch({
          type: 'sendTurn',
          input: {
            threadId: 'thread-accepted-observer-fault',
            input: 'run once',
            clientTurnId: 'client-observer-fault',
          },
        }),
      ).resolves.toMatchObject({ turnId: 'accepted-before-observer-fault' });
      await expect(
        service.dispatch({
          type: 'sendTurn',
          input: {
            threadId: 'thread-accepted-observer-fault',
            input: 'run once',
            clientTurnId: 'client-observer-fault',
          },
        }),
      ).resolves.toMatchObject({ turnId: 'accepted-before-observer-fault' });
      expect(claude.sendTurn).toHaveBeenCalledOnce();
    });

    test('returns accepted truth when an observer throws without clientTurnId', async () => {
      await service.dispatch({
        type: 'startSession',
        input: {
          threadId: 'thread-unkeyed-observer-fault',
          provider: 'claude',
          modelId: 'claude-sonnet',
        },
      });
      claude.sendTurn.mockClear();
      claude.sendTurn.mockResolvedValueOnce({
        threadId: 'thread-unkeyed-observer-fault',
        turnId: 'accepted-unkeyed-observer-fault',
      });
      vi.mocked(adapterTurnDuration.record).mockImplementationOnce(() => {
        throw new Error('metrics observer failed');
      });

      await expect(
        service.dispatch({
          type: 'sendTurn',
          input: {
            threadId: 'thread-unkeyed-observer-fault',
            input: 'run once',
          },
        }),
      ).resolves.toMatchObject({
        turnId: 'accepted-unkeyed-observer-fault',
      });
      expect(claude.sendTurn).toHaveBeenCalledOnce();
    });

    test('reports unavailable receipt durability without losing an accepted turn', async () => {
      await service.dispatch({
        type: 'startSession',
        input: {
          threadId: 'thread-receipt-unavailable',
          provider: 'claude',
          modelId: 'claude-sonnet',
        },
      });
      claude.sendTurn.mockResolvedValueOnce({
        threadId: 'thread-receipt-unavailable',
        turnId: 'accepted-receipt-unavailable',
      });
      vi.spyOn(eventStore, 'appendCommandReceipt').mockImplementationOnce(
        () => {
          throw new Error('receipt storage unavailable');
        },
      );

      await expect(
        service.dispatchWithReceipt({
          type: 'sendTurn',
          input: {
            threadId: 'thread-receipt-unavailable',
            input: 'run once',
          },
        }),
      ).resolves.toMatchObject({
        receiptStatus: 'unavailable',
        result: { turnId: 'accepted-receipt-unavailable' },
      });
    });

    test('omitting clientTurnId never dedups — every dispatch executes (back-compat)', async () => {
      await service.dispatch({
        type: 'startSession',
        input: {
          threadId: 'thread-no-dedup',
          provider: 'claude',
          modelId: 'claude-sonnet',
        },
      });
      claude.sendTurn.mockClear();
      claude.sendTurn
        .mockResolvedValueOnce({
          threadId: 'thread-no-dedup',
          turnId: 'claude-turn-no-dedup-1',
        })
        .mockResolvedValueOnce({
          threadId: 'thread-no-dedup',
          turnId: 'claude-turn-no-dedup-2',
        });

      await service.dispatch({
        type: 'sendTurn',
        input: { threadId: 'thread-no-dedup', input: 'one' },
      });
      await service.dispatch({
        type: 'sendTurn',
        input: { threadId: 'thread-no-dedup', input: 'two' },
      });

      expect(claude.sendTurn).toHaveBeenCalledTimes(2);
    });

    test('an adapter error after invocation retains the claim and never re-executes', async () => {
      await service.dispatch({
        type: 'startSession',
        input: {
          threadId: 'thread-dedup-retry',
          provider: 'claude',
          modelId: 'claude-sonnet',
        },
      });
      claude.sendTurn.mockClear();
      claude.sendTurn.mockRejectedValueOnce(new Error('transient failure'));

      await expect(
        service.dispatch({
          type: 'sendTurn',
          input: {
            threadId: 'thread-dedup-retry',
            input: 'hello',
            clientTurnId: 'client-turn-ambiguous',
          },
        }),
      ).rejects.toMatchObject({
        code: 'foreground_message_indeterminate',
        outcome: 'indeterminate',
      });
      expect(
        eventStore.createTurnDeduplicator().claim({
          threadId: 'thread-dedup-retry',
          clientTurnId: 'client-turn-ambiguous',
        }),
      ).toEqual({ kind: 'contended', turnId: undefined });

      claude.sendTurn.mockImplementation(async (input) => ({
        threadId: input.threadId,
        turnId: 'claude-turn',
      }));
      await expect(
        service.dispatch({
          type: 'sendTurn',
          input: {
            threadId: 'thread-dedup-retry',
            input: 'hello',
            clientTurnId: 'client-turn-after-ambiguous',
          },
        }),
      ).rejects.toThrow(/already being processed|turn start in progress/);

      expect(claude.sendTurn).toHaveBeenCalledTimes(1);
    });

    test('station#1224 CRITICAL fix — the missing test: a still-running turn resolves AFTER a concurrent replay has already started polling, and the adapter executes EXACTLY ONCE', async () => {
      await service.dispatch({
        type: 'startSession',
        input: {
          threadId: 'thread-dedup-inflight',
          provider: 'claude',
          modelId: 'claude-sonnet',
        },
      });
      claude.sendTurn.mockClear();
      const inFlight = deferred<ProviderTurnStartResult>();
      claude.sendTurn.mockReturnValueOnce(inFlight.promise);

      const firstDispatch = service.dispatch({
        type: 'sendTurn',
        input: {
          threadId: 'thread-dedup-inflight',
          input: 'hello',
          clientTurnId: 'client-turn-inflight',
        },
      });
      // Let the first dispatch's claim land (everything up to
      // `adapter.sendTurn` is synchronous/microtask work; the deferred
      // `inFlight` promise is the only thing actually pending) before the
      // second one starts, so it observes an in-flight (not yet resolved)
      // claim rather than racing the first claim.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(claude.sendTurn).toHaveBeenCalledTimes(1);

      const secondDispatch = service.dispatch({
        type: 'sendTurn',
        input: {
          threadId: 'thread-dedup-inflight',
          input: 'hello',
          clientTurnId: 'client-turn-inflight',
        },
      });

      // Give the second dispatch's poll loop (200ms interval by default)
      // several iterations to actually run WHILE the turn is still
      // genuinely unresolved — proving it is waiting, not racing a second
      // execution or falling through on elapsed time.
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(claude.sendTurn).toHaveBeenCalledTimes(1);

      // ONLY NOW does the original, still-running turn resolve.
      inFlight.resolve({
        threadId: 'thread-dedup-inflight',
        turnId: 'claude-turn-inflight',
      });

      const [first, second] = await Promise.all([
        firstDispatch,
        secondDispatch,
      ]);
      // The crux: the concurrent replay never triggered a second
      // `adapter.sendTurn` call, even though it started polling well before
      // the original resolved.
      expect(claude.sendTurn).toHaveBeenCalledTimes(1);
      expect(second).toEqual(first);
    });
  });

  test('startSession expands a stored literal-~ working directory before it reaches the adapter (#686 review HIGH-1)', async () => {
    // Project workingDirectory is persisted with a literal `~` (see
    // terminal-service); adapters spawn/chdir with the value, so the
    // resolver must expand exactly like every other server-side consumer.
    //
    // HOME is redirected at the temp dir so the expanded path can actually
    // exist: since archive#791 the resolver fails closed on a missing directory, and
    // asserting expansion against a path nobody created would only prove the
    // two behaviours had been wired together wrongly.
    const previousHome = process.env.HOME;
    process.env.HOME = tmp;
    mkdirSync(join(tmp, 'station-686-tilde'), { recursive: true });
    configuredProjects.push({
      slug: 'proj-tilde',
      workingDirectory: '~/station-686-tilde',
    });
    const claudeLocal = new FakeAdapter('claude');
    const localService = new OrchestrationService({
      adapterRegistry: createRegistry([claudeLocal]),
      eventBus,
      eventStore,
      listProjects: () => configuredProjects,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });

    await localService.dispatch({
      type: 'startSession',
      input: {
        threadId: 'thread-cwd-tilde',
        provider: 'claude',
        modelId: 'claude-sonnet',
        metadata: { projectSlug: 'proj-tilde' },
      },
    });

    expect(claudeLocal.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: join(homedir(), 'station-686-tilde'),
      }),
    );
    process.env.HOME = previousHome;
  });

  test('startSession refuses a project whose working directory no longer exists (#791)', async () => {
    // Fail closed rather than dropping the cwd: an adapter with no cwd spawns
    // in the server's own directory, so an agent asked to work on a project
    // would quietly read and write somewhere else entirely.
    configuredProjects.push({
      slug: 'proj-791',
      workingDirectory: join(tmp, 'deleted-project-791'),
    });
    const claudeLocal = new FakeAdapter('claude');
    const localService = new OrchestrationService({
      adapterRegistry: createRegistry([claudeLocal]),
      eventBus,
      eventStore,
      listProjects: () => configuredProjects,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });

    await expect(
      localService.dispatch({
        type: 'startSession',
        input: {
          threadId: 'thread-791',
          provider: 'claude',
          modelId: 'claude-sonnet',
          metadata: { projectSlug: 'proj-791' },
        },
      }),
    ).rejects.toThrow(/working directory no longer exists/);
    expect(claudeLocal.startSession).not.toHaveBeenCalled();
  });

  test('startSession resolves metadata.projectSlug to the project working directory for claude, codex, and acp (#686)', async () => {
    const projectDir = join(tmp, 'project-686');
    mkdirSync(projectDir, { recursive: true });
    configuredProjects.push({ slug: 'proj-686', workingDirectory: projectDir });

    const claudeLocal = new FakeAdapter('claude');
    const codex = new FakeAdapter('codex');
    const acp = new FakeAdapter('acp');
    const localService = new OrchestrationService({
      adapterRegistry: createRegistry([claudeLocal, codex, acp]),
      eventBus,
      eventStore,
      listProjects: () => configuredProjects,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });

    const cases = [
      {
        adapter: claudeLocal,
        threadId: 'thread-cwd-claude',
        modelId: 'claude-sonnet',
      },
      { adapter: codex, threadId: 'thread-cwd-codex', modelId: 'gpt-5.4' },
      { adapter: acp, threadId: 'thread-cwd-acp', modelId: undefined },
    ];
    for (const { adapter, threadId, modelId } of cases) {
      await localService.dispatch({
        type: 'startSession',
        input: {
          threadId,
          provider: adapter.provider,
          modelId,
          metadata: { projectSlug: 'proj-686' },
        },
      });
      // Adapter-input boundary: the session-start command carries the
      // server-resolved project working directory as cwd.
      expect(adapter.startSession).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId,
          cwd: projectDir,
          metadata: expect.objectContaining({ projectSlug: 'proj-686' }),
        }),
      );
    }
  });

  test('startSession defaults a non-directory-bound chat to $HOME, never the server cwd (#1023)', async () => {
    // A project with no workingDirectory is an organizational scope, not a
    // directory binding (Station seeds exactly one: `default`). The UI
    // promises "~ (defaults to home)" for it — the engine now actually gets
    // $HOME instead of inheriting whatever directory the server happened to
    // start from (the install root on dev/service installs).
    configuredProjects.push({ slug: 'no-workdir' });

    await service.dispatch({
      type: 'startSession',
      input: {
        threadId: 'thread-no-workdir',
        provider: 'claude',
        modelId: 'claude-sonnet',
        metadata: { projectSlug: 'no-workdir' },
      },
    });
    expect(claude.startSession.mock.calls.at(-1)?.[0].cwd).toBe(homedir());
    // archive#1174: a defaulted $HOME is flagged as such, distinguishing it
    // from a real project/user cwd that just happens to sit at $HOME — the
    // Claude adapter's cwd-less skills overlay keys off this exact flag.
    expect(claude.startSession.mock.calls.at(-1)?.[0].cwdDefaulted).toBe(true);

    await service.dispatch({
      type: 'startSession',
      input: {
        threadId: 'thread-no-slug',
        provider: 'claude',
        modelId: 'claude-sonnet',
      },
    });
    expect(claude.startSession.mock.calls.at(-1)?.[0].cwd).toBe(homedir());
    expect(claude.startSession.mock.calls.at(-1)?.[0].cwdDefaulted).toBe(true);
  });

  test('startSession leaves ACP unbound chats to the adapter connection default (#1023 review)', async () => {
    // The ACP adapter has its own documented fallback chain
    // (input.cwd ?? config.cwd ?? managed session workspace); the resolver's
    // default must not shadow the
    // connection-configured directory, so it still hands ACP an undefined
    // cwd. archive#1403 moved the END of that chain to a private workspace so
    // deferring here never exposes HOME or the server directory — pinned at
    // the adapter and workspace-helper tests.
    const acp = new FakeAdapter('acp');
    const localService = new OrchestrationService({
      adapterRegistry: createRegistry([acp]),
      eventBus,
      eventStore,
      listProjects: () => configuredProjects,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    await localService.dispatch({
      type: 'startSession',
      input: {
        threadId: 'thread-acp-unbound',
        provider: 'acp',
        modelId: undefined,
      },
    });
    expect(acp.startSession.mock.calls.at(-1)?.[0].cwd).toBeUndefined();
    // archive#1174: still no real project/user cwd, even though this
    // provider's own resolution chain leaves `cwd` itself untouched here.
    expect(acp.startSession.mock.calls.at(-1)?.[0].cwdDefaulted).toBe(true);
  });

  test('startSession refuses a chat bound to a project this Station does not have (#1011)', async () => {
    // Was a fail-open: the adapter got no cwd at all and the engine inherited
    // the SERVER's working directory ($HOME in the desktop app), so a chat the
    // UI shows as project-bound read and wrote the wrong files.
    await expect(
      service.dispatch({
        type: 'startSession',
        input: {
          threadId: 'thread-no-project',
          provider: 'claude',
          modelId: 'claude-sonnet',
          metadata: { projectSlug: 'missing-project' },
        },
      }),
    ).rejects.toThrow(
      /bound to project 'missing-project', which this Station does not have/,
    );
    expect(claude.startSession).not.toHaveBeenCalled();
  });

  test('startSession expands a tilde in a caller-supplied cwd (#1011)', async () => {
    // `station chat --project=<slug>` and station-control delegation both pass
    // the project's stored workingDirectory through verbatim, and Station
    // stores it with a literal `~`. Unexpanded, no chdir can satisfy it and
    // the engine never reaches the project.
    const previousHome = process.env.HOME;
    process.env.HOME = tmp;
    mkdirSync(join(tmp, 'station-1011-supplied'), { recursive: true });
    configuredProjects.push({
      slug: 'proj-supplied-tilde',
      workingDirectory: '~/station-1011-supplied',
    });

    await service.dispatch({
      type: 'startSession',
      input: {
        threadId: 'thread-supplied-tilde',
        provider: 'claude',
        modelId: 'claude-sonnet',
        cwd: '~/station-1011-supplied',
        metadata: { projectSlug: 'proj-supplied-tilde' },
      },
    });
    expect(claude.startSession.mock.calls.at(-1)?.[0].cwd).toBe(
      join(homedir(), 'station-1011-supplied'),
    );
    process.env.HOME = previousHome;
  });

  test('startSession keeps an explicit cwd inside the bound project (#686)', async () => {
    const projectDir = join(tmp, 'project-explicit');
    const worktreeDir = join(projectDir, 'nested-worktree');
    mkdirSync(worktreeDir, { recursive: true });
    configuredProjects.push({
      slug: 'proj-explicit',
      workingDirectory: projectDir,
    });

    await service.dispatch({
      type: 'startSession',
      input: {
        threadId: 'thread-explicit-cwd',
        provider: 'claude',
        modelId: 'claude-sonnet',
        cwd: worktreeDir,
        metadata: { projectSlug: 'proj-explicit' },
      },
    });
    expect(claude.startSession.mock.calls.at(-1)?.[0].cwd).toBe(worktreeDir);
    // archive#1174: a real, explicit project-bound cwd is never flagged as
    // defaulted -- the Claude adapter's cwd-less skills overlay must never
    // engage for a session that has an actual project/user cwd.
    expect(
      claude.startSession.mock.calls.at(-1)?.[0].cwdDefaulted,
    ).toBeUndefined();
  });

  test('startSession refuses an explicit cwd outside the bound project (#1011)', async () => {
    const projectDir = join(tmp, 'project-outside');
    const outsideDir = join(tmp, 'somewhere-else');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    configuredProjects.push({
      slug: 'proj-outside',
      workingDirectory: projectDir,
    });

    await expect(
      service.dispatch({
        type: 'startSession',
        input: {
          threadId: 'thread-outside-cwd',
          provider: 'claude',
          modelId: 'claude-sonnet',
          cwd: outsideDir,
          metadata: { projectSlug: 'proj-outside' },
        },
      }),
    ).rejects.toThrow(/is outside project 'proj-outside'/);
    expect(claude.startSession).not.toHaveBeenCalled();
  });

  test('startSession refuses a caller-supplied cwd that does not exist (#1011)', async () => {
    await expect(
      service.dispatch({
        type: 'startSession',
        input: {
          threadId: 'thread-missing-cwd',
          provider: 'claude',
          modelId: 'claude-sonnet',
          cwd: join(tmp, 'never-created'),
        },
      }),
    ).rejects.toThrow(/Requested working directory does not exist/);
    expect(claude.startSession).not.toHaveBeenCalled();
  });

  test('startSession refuses an explicit cwd that does not exist (#978, mirrors #791)', async () => {
    await expect(
      service.dispatch({
        type: 'startSession',
        input: {
          threadId: 'thread-cwd-missing-978',
          provider: 'claude',
          modelId: 'claude-sonnet',
          cwd: join(tmp, 'never-created'),
        },
      }),
    ).rejects.toThrow(/Requested working directory does not exist/);
    expect(claude.startSession).not.toHaveBeenCalled();
  });

  // archive#1501. The shadow's whole value is that it observes the
  // seam over REAL traffic without being able to change it, so these tests
  // assert both halves: every branch and every engine family produces a
  // sample, and nothing the observer does reaches the session.
  describe('resolveStartSessionCwd migration shadow (station#1501 slice 3a)', () => {
    /**
     * The seam hands the observer to `setImmediate`, so these assertions need
     * the check phase drained before the sample exists.
     *
     * This drain is NOT proof that the dispatch is deferred, and an earlier
     * revision of this comment claimed it was. Postponing an assertion can
     * only ever make it easier to satisfy, so every test in this block passes
     * identically against a direct call. The discriminating assertion — that
     * the observer has not run at the instant the helper returns — lives in
     * `project-resource-shadow.test.ts`, against the exported
     * `dispatchCwdShadow`.
     */
    const flushShadowDispatch = () =>
      new Promise<void>((resolve) => setImmediate(resolve));

    function serviceWithShadow(
      adapters: FakeAdapter[],
      observeCwdShadow: (sample: CwdShadowSample) => void,
    ): OrchestrationService {
      return new OrchestrationService({
        adapterRegistry: createRegistry(adapters),
        eventBus,
        eventStore,
        listProjects: () => configuredProjects,
        observeCwdShadow,
        logger: { debug: vi.fn(), warn: vi.fn() },
      });
    }

    test('samples the project resolution for every engine family that reaches this seam', async () => {
      // Claude, Codex, ACP-connected CLIs and Station's own agent relay all
      // settle their cwd here; a shadow that only sees one of them would
      // justify slice 3c on a quarter of the traffic.
      const projectDir = join(tmp, 'project-shadow-families');
      mkdirSync(projectDir, { recursive: true });
      configuredProjects.push({
        slug: 'proj-shadow',
        workingDirectory: projectDir,
      });
      const samples: CwdShadowSample[] = [];
      const adapters = (
        ['claude', 'codex', 'acp', 'station-agent'] as const
      ).map((kind) => new FakeAdapter(kind));
      const localService = serviceWithShadow(adapters, (sample) => {
        samples.push(sample);
      });

      for (const adapter of adapters) {
        await localService.dispatch({
          type: 'startSession',
          input: {
            threadId: `thread-shadow-${adapter.provider}`,
            provider: adapter.provider,
            metadata: { projectSlug: 'proj-shadow' },
          },
        });
        // Unchanged behavior is the point: the session still launches in the
        // project directory the baseline path resolved.
        expect(adapter.startSession.mock.calls.at(-1)?.[0].cwd).toBe(
          projectDir,
        );
      }

      await flushShadowDispatch();
      expect(samples.map((entry) => entry.provider)).toEqual([
        'claude',
        'codex',
        'acp',
        'station-agent',
      ]);
      for (const entry of samples) {
        expect(entry.projectSlug).toBe('proj-shadow');
        expect(entry.baseline).toEqual({ kind: 'directory', path: projectDir });
      }
    });

    test('samples the directory-less project as the deliberate no-directory terminus, not as a failure', async () => {
      configuredProjects.push({ slug: 'proj-shadow-scope' });
      const samples: CwdShadowSample[] = [];
      const claudeLocal = new FakeAdapter('claude');
      const localService = serviceWithShadow([claudeLocal], (sample) => {
        samples.push(sample);
      });

      await localService.dispatch({
        type: 'startSession',
        input: {
          threadId: 'thread-shadow-scope',
          provider: 'claude',
          metadata: { projectSlug: 'proj-shadow-scope' },
        },
      });

      await flushShadowDispatch();
      expect(samples).toEqual([
        {
          projectSlug: 'proj-shadow-scope',
          provider: 'claude',
          baseline: { kind: 'no-directory' },
        },
      ]);
      expect(claudeLocal.startSession.mock.calls.at(-1)?.[0].cwdDefaulted).toBe(
        true,
      );
    });

    test('samples the #791 fail-closed branch BEFORE the throw', async () => {
      const gone = join(tmp, 'project-shadow-gone');
      configuredProjects.push({
        slug: 'proj-shadow-791',
        workingDirectory: gone,
      });
      const samples: CwdShadowSample[] = [];
      const localService = serviceWithShadow([new FakeAdapter('claude')], (s) =>
        samples.push(s),
      );

      await expect(
        localService.dispatch({
          type: 'startSession',
          input: {
            threadId: 'thread-shadow-791',
            provider: 'claude',
            metadata: { projectSlug: 'proj-shadow-791' },
          },
        }),
      ).rejects.toThrow(/working directory no longer exists/);
      await flushShadowDispatch();
      expect(samples).toEqual([
        {
          projectSlug: 'proj-shadow-791',
          provider: 'claude',
          baseline: { kind: 'missing-directory', path: gone },
        },
      ]);
    });

    test('samples the unknown-project branch BEFORE the throw', async () => {
      const samples: CwdShadowSample[] = [];
      const localService = serviceWithShadow([new FakeAdapter('claude')], (s) =>
        samples.push(s),
      );

      await expect(
        localService.dispatch({
          type: 'startSession',
          input: {
            threadId: 'thread-shadow-unknown',
            provider: 'claude',
            metadata: { projectSlug: 'ghost-project' },
          },
        }),
      ).rejects.toThrow(/which this Station does not have/);
      await flushShadowDispatch();
      expect(samples).toEqual([
        {
          projectSlug: 'ghost-project',
          provider: 'claude',
          baseline: { kind: 'project-not-found' },
        },
      ]);
    });

    test('does not sample an unbound chat: there is no project resolution to shadow', async () => {
      const samples: CwdShadowSample[] = [];
      const claudeLocal = new FakeAdapter('claude');
      const localService = serviceWithShadow([claudeLocal], (s) =>
        samples.push(s),
      );

      await localService.dispatch({
        type: 'startSession',
        input: { threadId: 'thread-shadow-unbound', provider: 'claude' },
      });
      await flushShadowDispatch();
      expect(samples).toEqual([]);
      expect(claudeLocal.startSession.mock.calls.at(-1)?.[0].cwdDefaulted).toBe(
        true,
      );
    });

    test('a THROWING observer cannot break a session start', async () => {
      // The option contract says implementations must not throw. Relying on
      // that would make the guarantee documentary; this proves it structural.
      const projectDir = join(tmp, 'project-shadow-hostile');
      mkdirSync(projectDir, { recursive: true });
      configuredProjects.push({
        slug: 'proj-shadow-hostile',
        workingDirectory: projectDir,
      });
      const claudeLocal = new FakeAdapter('claude');
      const localService = serviceWithShadow([claudeLocal], () => {
        throw new Error('shadow exploded');
      });

      await localService.dispatch({
        type: 'startSession',
        input: {
          threadId: 'thread-shadow-hostile',
          provider: 'claude',
          metadata: { projectSlug: 'proj-shadow-hostile' },
        },
      });
      // Drained deliberately: the throw now happens inside the deferred
      // callback, so without this the assertion would pass even if the seam
      // stopped containing it (and an uncaught throw in the check phase would
      // surface as an unhandled error instead).
      await flushShadowDispatch();
      expect(claudeLocal.startSession.mock.calls.at(-1)?.[0].cwd).toBe(
        projectDir,
      );
    });

    test('the caller-supplied-cwd branches are unchanged, and the sample still describes the PROJECT', async () => {
      // A caller cwd wins over the project directory but must stay inside it.
      // The resolver answers for the project resource, so that is what the
      // shadow compares — not the session's final cwd.
      const projectDir = join(tmp, 'project-shadow-supplied');
      const nested = join(projectDir, 'worktree');
      const outside = join(tmp, 'outside-shadow');
      mkdirSync(nested, { recursive: true });
      mkdirSync(outside, { recursive: true });
      configuredProjects.push({
        slug: 'proj-shadow-supplied',
        workingDirectory: projectDir,
      });
      const samples: CwdShadowSample[] = [];
      const claudeLocal = new FakeAdapter('claude');
      const localService = serviceWithShadow([claudeLocal], (s) =>
        samples.push(s),
      );

      await localService.dispatch({
        type: 'startSession',
        input: {
          threadId: 'thread-shadow-inside',
          provider: 'claude',
          cwd: nested,
          metadata: { projectSlug: 'proj-shadow-supplied' },
        },
      });
      expect(claudeLocal.startSession.mock.calls.at(-1)?.[0].cwd).toBe(nested);

      await expect(
        localService.dispatch({
          type: 'startSession',
          input: {
            threadId: 'thread-shadow-outside',
            provider: 'claude',
            cwd: outside,
            metadata: { projectSlug: 'proj-shadow-supplied' },
          },
        }),
      ).rejects.toThrow(/is outside project 'proj-shadow-supplied'/);

      await flushShadowDispatch();
      expect(samples).toHaveLength(2);
      for (const entry of samples) {
        expect(entry.baseline).toEqual({ kind: 'directory', path: projectDir });
      }
    });

    test('RECOVERY traffic is shadowed too — the population most likely to carry a stale directory', async () => {
      // Recovery re-settles the cwd of every session restored at boot
      // (archive#1011), through the SAME seam. A shadow wired only to live starts
      // would make "the record is empty" cheap to satisfy in exactly the
      // wrong way: sessions created before a checkout moved are the ones
      // whose project resolution is most likely to have changed under them.
      //
      // An ACP session bound to a directory-less project is the reachable
      // shape here: its start leaves `cwd` unset by design (the adapter owns
      // a connection-level fallback), so the persisted row has no cwd and
      // recovery re-resolves rather than replaying one.
      configuredProjects.push({ slug: 'proj-shadow-recovery' });
      const acpStart = new FakeAdapter('acp');
      const startService = new OrchestrationService({
        adapterRegistry: createRegistry([acpStart]),
        eventBus,
        eventStore,
        listProjects: () => configuredProjects,
        logger: { debug: vi.fn(), warn: vi.fn() },
      });
      await startService.dispatch({
        type: 'startSession',
        input: {
          threadId: 'thread-shadow-recovery',
          provider: 'acp',
          persistSession: true,
          metadata: { projectSlug: 'proj-shadow-recovery' },
        },
      });
      expect(acpStart.startSession.mock.calls.at(-1)?.[0].cwd).toBeUndefined();
      // The persisted `session.started` event is what recovery replays the
      // project binding from (`readLatestSessionStartMetadata`). `FakeAdapter`
      // emits no events of its own, so record the one production would.
      eventStore.appendEvent({
        eventId: randomUUID(),
        provider: 'acp',
        threadId: 'thread-shadow-recovery',
        createdAt: '2026-08-01T00:00:00.000Z',
        method: 'session.started',
        sessionId: 'thread-shadow-recovery',
        metadata: { projectSlug: 'proj-shadow-recovery' },
      } as unknown as CanonicalRuntimeEvent);

      const samples: CwdShadowSample[] = [];
      const acpRecovered = new FakeAdapter('acp');
      const recoveryService = new OrchestrationService({
        adapterRegistry: createRegistry([acpRecovered]),
        eventBus: new EventBus(),
        eventStore,
        listProjects: () => configuredProjects,
        observeCwdShadow: (sample) => {
          samples.push(sample);
        },
        logger: { debug: vi.fn(), warn: vi.fn() },
      });
      recoveryService.initialize();
      await waitForReceipt(
        (receipt) => receipt.kind === 'session.recovery.completed',
      );
      // archive#3476: the cwd re-settlement moved with the rest of the start
      // pipeline to first use, so drive it the way a user does.
      await materializeBySendingATurn(
        recoveryService,
        'thread-shadow-recovery',
      );

      await waitFor(
        () => samples.length,
        (count) => count > 0,
      );
      expect(samples).toContainEqual({
        projectSlug: 'proj-shadow-recovery',
        provider: 'acp',
        baseline: { kind: 'no-directory' },
      });
    });

    test('an unwired shadow leaves the seam byte-for-byte as it was', async () => {
      // The default in every existing test and in any installation that has
      // not enabled it.
      const projectDir = join(tmp, 'project-shadow-unwired');
      mkdirSync(projectDir, { recursive: true });
      configuredProjects.push({
        slug: 'proj-shadow-unwired',
        workingDirectory: projectDir,
      });
      const claudeLocal = new FakeAdapter('claude');
      const localService = new OrchestrationService({
        adapterRegistry: createRegistry([claudeLocal]),
        eventBus,
        eventStore,
        listProjects: () => configuredProjects,
        logger: { debug: vi.fn(), warn: vi.fn() },
      });

      await localService.dispatch({
        type: 'startSession',
        input: {
          threadId: 'thread-shadow-unwired',
          provider: 'claude',
          metadata: { projectSlug: 'proj-shadow-unwired' },
        },
      });
      expect(claudeLocal.startSession.mock.calls.at(-1)?.[0].cwd).toBe(
        projectDir,
      );
    });
  });

  test('startSession rejects a modelOptions key the target provider does not support (#978 AC4)', async () => {
    await expect(
      service.dispatch({
        type: 'startSession',
        input: {
          threadId: 'thread-unsupported-option-978',
          provider: 'claude',
          modelId: 'claude-sonnet',
          modelOptions: { approvalMode: 'auto', bogusOption: true },
        },
      }),
    ).rejects.toThrow(
      "Unsupported option 'bogusOption' for claude target 'thread-unsupported-option-978'",
    );
    expect(claude.startSession).not.toHaveBeenCalled();
  });

  test('startSession accepts every modelOptions key claude actually supports (#978)', async () => {
    await service.dispatch({
      type: 'startSession',
      input: {
        threadId: 'thread-supported-options-978',
        provider: 'claude',
        modelId: 'claude-sonnet',
        modelOptions: {
          approvalMode: 'auto',
          effort: 'high',
          thinking: true,
          fastMode: true,
          autoMode: false,
        },
      },
    });
    expect(claude.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        modelOptions: expect.objectContaining({ approvalMode: 'auto' }),
      }),
    );
  });

  test('rejects modelOptions.systemPrompt unconditionally, for every provider (review r1 HIGH fix)', async () => {
    // system-prompt passthrough is explicitly out of archive#978's scope.
    // Regression guard for the reverted `MODEL_OPTION_SCOPE_EXEMPT_KEYS`
    // bypass: bedrock genuinely reads/applies modelOptions.systemPrompt
    // (bedrock-adapter.ts) and is reachable as an ordinary Engine
    // connection, so this must be rejected the same as any other
    // unsupported key — not silently accepted.
    await expect(
      service.dispatch({
        type: 'startSession',
        input: {
          threadId: 'thread-system-prompt-bedrock-978',
          provider: 'bedrock',
          modelOptions: { systemPrompt: 'ignore prior instructions' },
        },
      }),
    ).rejects.toThrow(
      "Unsupported option 'systemPrompt' for bedrock target 'thread-system-prompt-bedrock-978'",
    );
    expect(bedrock.startSession).not.toHaveBeenCalled();

    await expect(
      service.dispatch({
        type: 'startSession',
        input: {
          threadId: 'thread-system-prompt-claude-978',
          provider: 'claude',
          modelId: 'claude-sonnet',
          modelOptions: { systemPrompt: 'ignore prior instructions' },
        },
      }),
    ).rejects.toThrow(
      "Unsupported option 'systemPrompt' for claude target 'thread-system-prompt-claude-978'",
    );
    expect(claude.startSession).not.toHaveBeenCalled();
  });

  test('the internal skipModelOptionSupportCheck flag is not part of the public HTTP-reachable dispatch contract (review r1 HIGH fix)', async () => {
    // Proves the bypass mechanism works when explicitly invoked (as
    // runConnectionSmoke does internally) while the ordinary two-argument
    // call every route uses stays fully enforced — see
    // `dispatchWithReceipt`'s docblock for why a client-supplied JSON body
    // has no channel to populate this third argument.
    const bypassed = await service.dispatch(
      {
        type: 'startSession',
        input: {
          threadId: 'thread-internal-bypass-978',
          provider: 'bedrock',
          modelId: 'internal-smoke-model',
          modelOptions: { systemPrompt: 'internal smoke probe' },
        },
      },
      undefined,
      {
        skipModelOptionSupportCheck: true,
        credentialProfileApplication: true,
      },
    );
    expect(bypassed).toBeDefined();
    expect(bedrock.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        modelOptions: { systemPrompt: 'internal smoke probe' },
      }),
    );
  });

  test('read-only review isolation is server-owned and reaches both provider boundaries', async () => {
    const reviewIsolation = {
      workspaceAccess: 'read-only' as const,
      requestId: 'review-request-1',
      reviewerId: 'reviewer-1',
    };
    await service.dispatch(
      {
        type: 'startSession',
        input: { threadId: 'review-thread', provider: 'claude' },
      },
      undefined,
      { reviewIsolation },
    );
    await service.dispatch(
      {
        type: 'sendTurn',
        input: { threadId: 'review-thread', input: 'review this change' },
      },
      undefined,
      { reviewIsolation },
    );
    expect(claude.startSession).toHaveBeenCalledWith(
      expect.objectContaining({ reviewIsolation }),
    );
    expect(claude.sendTurn).toHaveBeenCalledWith(
      expect.objectContaining({ reviewIsolation }),
    );

    const forged = {
      threadId: 'forged-review-thread',
      provider: 'claude' as const,
      reviewIsolation,
    };
    await service.dispatch({ type: 'startSession', input: forged });
    expect(claude.startSession).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ reviewIsolation: expect.anything() }),
    );
  });

  test('ordinary session dispatch cannot select a server-owned credential profile', async () => {
    // Simulate an untyped/in-process caller deliberately forging the
    // provider-only field that the public OrchestrationCommand omits.
    const forgedInput: ProviderSessionStartInput = {
      threadId: 'thread-forged-credential-profile',
      provider: 'claude',
      credentialProfileRef: 'canary',
    };
    await expect(
      service.dispatch({
        type: 'startSession',
        input: forgedInput,
      }),
    ).rejects.toThrow(
      'Credential profile selection is reserved for Station-managed recovery.',
    );
    expect(claude.startSession).not.toHaveBeenCalled();
  });

  test('failed credential-session quarantine blocks rediscovery and event reprojection until confirmed exit', async () => {
    const threadId = 'thread-quarantined-credential-profile';
    await service.dispatch({
      type: 'startSession',
      input: {
        threadId,
        provider: 'claude',
        modelId: 'claude-sonnet',
      },
    });
    claude.stopSession.mockRejectedValueOnce(
      new Error('provider termination failed'),
    );

    await (
      service as unknown as {
        quarantineCredentialProfileRecoverySession(
          value: string,
        ): Promise<void>;
      }
    ).quarantineCredentialProfileRecoverySession(threadId);

    expect(claude.sessions.has(threadId)).toBe(true);
    await expect(
      service.dispatch({
        type: 'sendTurn',
        input: { threadId, input: 'must not reach candidate credentials' },
      }),
    ).rejects.toThrow(`Session is unavailable: ${threadId}`);
    expect(claude.sendTurn).not.toHaveBeenCalled();

    claude.events.push({
      eventId: 'quarantined-configured',
      provider: 'claude',
      threadId,
      createdAt: '2026-07-29T15:00:00.000Z',
      method: 'session.configured',
      sessionId: threadId,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      eventStore
        .listEvents(threadId)
        .some((entry) => entry.id === 'quarantined-configured'),
    ).toBe(false);

    claude.sessions.delete(threadId);
    claude.events.push({
      eventId: 'quarantined-exited',
      provider: 'claude',
      threadId,
      createdAt: '2026-07-29T15:00:01.000Z',
      method: 'session.exited',
      sessionId: threadId,
      exitCode: 1,
    });
    await waitFor(
      () => eventStore.listEvents(threadId),
      (events) => events.some((entry) => entry.id === 'quarantined-exited'),
    );
  });

  test('sendTurn rejects a modelOptions key the target provider does not support (#978 AC4/AC6)', async () => {
    await service.dispatch({
      type: 'startSession',
      input: {
        threadId: 'thread-turn-unsupported-978',
        provider: 'claude',
        modelId: 'claude-sonnet',
      },
    });
    await expect(
      service.dispatch({
        type: 'sendTurn',
        input: {
          threadId: 'thread-turn-unsupported-978',
          input: 'hello',
          modelOptions: { bogusOption: true },
        },
      }),
    ).rejects.toThrow(
      "Unsupported option 'bogusOption' for claude target 'thread-turn-unsupported-978'",
    );
  });

  test('startSession routes the input through resolveSessionAgent before adapter dispatch (#895)', async () => {
    const resolveSessionAgent = vi.fn(async (input: any) => ({
      ...input,
      agent: { slug: 'resolved-agent' },
    }));
    const localService = new OrchestrationService({
      adapterRegistry: createRegistry([claude]),
      eventBus,
      eventStore,
      listProjects: () => configuredProjects,
      resolveSessionAgent,
      loadAgentPresentation: async () => ({
        name: 'Immutable Agent Name',
        icon: 'sparkles',
      }),
      logger: { debug: vi.fn(), warn: vi.fn() },
    });

    await localService.dispatch({
      type: 'startSession',
      input: {
        threadId: 'thread-resolve-agent',
        provider: 'claude',
        modelId: 'claude-sonnet',
        metadata: { agentSlug: 'my-agent' },
      },
    });

    expect(resolveSessionAgent).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'thread-resolve-agent' }),
      undefined,
    );
    expect(claude.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: { slug: 'resolved-agent' },
        metadata: expect.objectContaining({
          agentSlug: 'my-agent',
          agentName: 'Immutable Agent Name',
          agentIcon: 'sparkles',
        }),
      }),
    );
  });

  test('bounds fresh Agent presentation snapshots and does not relabel a legacy resumed Session', async () => {
    const adapter = new FakeAdapter('claude');
    const icons: Record<string, string> = {
      'bounded-agent': 'brand:opencode',
      'overlong-icon-agent': 'x'.repeat(17),
      'data-icon-agent': 'data:image/png;base64,PRIVATE',
      'path-icon-agent': '/private/agent.png',
      'unknown-brand-agent': 'brand:unknown',
    };
    const localService = new OrchestrationService({
      adapterRegistry: createRegistry([adapter]),
      eventBus: new EventBus(),
      eventStore,
      resolveSessionAgent: async (input) => ({
        ...input,
        agent: { slug: String(input.metadata?.agentSlug) },
      }),
      loadAgentPresentation: async (slug) => ({
        name: `Agent ${'n'.repeat(120)}`,
        icon: icons[slug],
      }),
      logger: { debug: vi.fn(), warn: vi.fn() },
    });

    await localService.dispatch({
      type: 'startSession',
      input: {
        threadId: 'fresh-agent-presentation',
        provider: 'claude',
        metadata: { agentSlug: 'bounded-agent' },
      },
    });
    for (const agentSlug of [
      'overlong-icon-agent',
      'data-icon-agent',
      'path-icon-agent',
      'unknown-brand-agent',
    ]) {
      await localService.dispatch({
        type: 'startSession',
        input: {
          threadId: `unsafe-${agentSlug}`,
          provider: 'claude',
          metadata: { agentSlug },
        },
      });
    }
    await localService.dispatch({
      type: 'startSession',
      input: {
        threadId: 'legacy-resumed-presentation',
        provider: 'claude',
        resumeCursor: 'legacy-provider-session',
        metadata: { agentSlug: 'bounded-agent' },
      },
    });

    const metadataFor = (threadId: string) =>
      adapter.startSession.mock.calls.find(
        ([input]) => input.threadId === threadId,
      )?.[0].metadata;
    const freshMetadata = metadataFor('fresh-agent-presentation');
    expect(freshMetadata?.agentName).toHaveLength(100);
    expect(freshMetadata?.agentIcon).toBe('brand:opencode');
    const resumedMetadata = metadataFor('legacy-resumed-presentation');
    expect(resumedMetadata).not.toHaveProperty('agentName');
    expect(resumedMetadata).not.toHaveProperty('agentIcon');
    for (const agentSlug of [
      'overlong-icon-agent',
      'data-icon-agent',
      'path-icon-agent',
      'unknown-brand-agent',
    ]) {
      expect(metadataFor(`unsafe-${agentSlug}`)).not.toHaveProperty(
        'agentIcon',
      );
    }
    const persistedMetadata = JSON.stringify(
      adapter.startSession.mock.calls.map(([input]) => input.metadata),
    );
    expect(persistedMetadata).not.toContain('data:image');
    expect(persistedMetadata).not.toContain('/private/agent.png');
    await localService.shutdown();
  });

  test.each([
    ['missing', async () => null],
    [
      'load failure',
      async () => {
        throw new Error('agent spec load unavailable');
      },
    ],
  ])(
    'Claude start fails closed when its canonical session agent has %s (#2732)',
    async (_caseName, loadAgentSpec) => {
      const adapter = new FakeAdapter('claude');
      const localService = new OrchestrationService({
        adapterRegistry: createRegistry([adapter]),
        eventBus,
        eventStore,
        resolveSessionAgent: createSessionAgentResolver({
          loadAgentSpec,
          resolveToolServer: async () => null,
          resolveSkillDir: async () => null,
        }),
        logger: { debug: vi.fn(), warn: vi.fn() },
      });

      await expect(
        localService.dispatch({
          type: 'startSession',
          input: {
            threadId: `thread-unresolved-claude-${_caseName.replaceAll(' ', '-')}`,
            provider: 'claude',
            metadata: { agentSlug: 'unavailable-agent' },
          },
        }),
      ).rejects.toThrow(
        "Agent 'unavailable-agent' could not be resolved to an authored Agent definition",
      );
      expect(adapter.startSession).not.toHaveBeenCalled();
      await localService.shutdown();
    },
  );

  test('catalog target readiness agrees with Claude session dispatch for every listed target (#2845)', async () => {
    const authoredSpec = {
      name: 'Authored Claude Agent',
      prompt: 'Review the change.',
      execution: { agentConnectionId: engineConnectionId('claude') },
    };
    const catalog = createEnrichedAgentRoutes({
      agentMetadataMap: new Map([
        [
          'claude',
          {
            slug: 'claude',
            name: 'Claude Code',
            execution: { agentConnectionId: engineConnectionId('claude') },
          },
        ],
        [
          'authored-claude',
          {
            slug: 'authored-claude',
            name: 'Authored Claude Agent',
            execution: { agentConnectionId: engineConnectionId('claude') },
          },
        ],
      ]),
      activeAgents: new Map(),
      loadAgent: async (slug: string) => {
        if (slug === 'authored-claude') return authoredSpec;
        throw new Error(`No authored Agent '${slug}'`);
      },
      listAgents: async () => [
        {
          slug: 'claude',
          name: 'Claude Code',
          execution: { agentConnectionId: engineConnectionId('claude') },
        },
        {
          slug: 'authored-claude',
          name: 'Authored Claude Agent',
          execution: { agentConnectionId: engineConnectionId('claude') },
        },
      ],
      getDefaultAgentIds: async () => new Set(['claude']),
      defaultModel: 'unused',
      defaultTools: { mcpServers: [], autoApprove: [] },
      getRuntimeConnections: async () => [
        {
          id: 'claude',
          type: 'claude',
          provider: 'claude',
          name: 'Claude Code',
          enabled: true,
          status: 'ready',
          engineId: 'claude',
        },
      ],
      logger: { warn: vi.fn(), error: vi.fn() },
    } as never);

    const response = await catalog.request('/');
    const body = (await response.json()) as { data: Array<any> };
    expect(response.status).toBe(200);
    expect(body.data).toHaveLength(2);

    for (const target of body.data) {
      const adapter = new FakeAdapter('claude');
      const localService = new OrchestrationService({
        adapterRegistry: createRegistry([adapter]),
        eventBus,
        eventStore,
        resolveSessionAgent: createSessionAgentResolver({
          loadAgentSpec: async (slug) =>
            slug === 'authored-claude' ? authoredSpec : null,
          resolveToolServer: async () => null,
          resolveSkillDir: async () => null,
        }),
        logger: { debug: vi.fn(), warn: vi.fn() },
      });
      const dispatch = localService.dispatch({
        type: 'startSession',
        input: {
          threadId: `thread-target-agreement-${target.slug}`,
          provider: 'claude',
          metadata: { agentSlug: target.slug },
        },
      });

      if (target.available === false) {
        await expect(dispatch).rejects.toThrow(
          `Agent '${target.slug}' could not be resolved to an authored Agent definition, so this session cannot start. Enable this engine by creating an Agent for it — new chats will run as that Agent.`,
        );
        expect(target.unavailableReason).toMatch(
          /no authored Agent definition.*creating an Agent/i,
        );
        expect(adapter.startSession).not.toHaveBeenCalled();
      } else {
        await expect(dispatch).resolves.toBeDefined();
        expect(adapter.startSession).toHaveBeenCalledWith(
          expect.objectContaining({
            agent: expect.objectContaining({ slug: target.slug }),
          }),
        );
      }
      await localService.shutdown();
    }

    expect(body.data.find((target) => target.slug === 'claude')).toMatchObject({
      available: false,
      unavailableReason: expect.stringMatching(/no authored Agent definition/i),
    });
    expect(
      body.data.find((target) => target.slug === 'authored-claude'),
    ).not.toHaveProperty('available');
  });

  test('agent-less startSession without a configured resolver reaches the adapter unchanged (#895)', async () => {
    // `service` (the suite default) is constructed without resolveSessionAgent.
    await service.dispatch({
      type: 'startSession',
      input: {
        threadId: 'thread-no-resolver',
        provider: 'claude',
        modelId: 'claude-sonnet',
      },
    });

    const startInput = claude.startSession.mock.calls.at(-1)?.[0];
    expect(startInput).not.toHaveProperty('agent');
    expect(startInput?.metadata).not.toHaveProperty('agentSlug');
  });

  test('ACP start fails closed when its session agent has no authored spec (#3027)', async () => {
    // archive#3027 flipped archive#2732's ACP best-effort contract: the
    // authored-spec gate is symmetric across every delivery-capable engine,
    // and kiro/opencode reach it as provider 'acp' — exactly the providers a
    // claude-only (or any name-listed) gate silently missed.
    const adapter = new FakeAdapter('acp');
    const localService = new OrchestrationService({
      adapterRegistry: createRegistry([adapter]),
      eventBus,
      eventStore,
      resolveSessionAgent: createSessionAgentResolver({
        loadAgentSpec: async () => null,
        resolveToolServer: async () => null,
        resolveSkillDir: async () => null,
      }),
      logger: { debug: vi.fn(), warn: vi.fn() },
    });

    await expect(
      localService.dispatch({
        type: 'startSession',
        input: {
          threadId: 'thread-unresolved-acp-agent',
          provider: 'acp',
          metadata: { agentSlug: 'unavailable-agent' },
        },
      }),
    ).rejects.toThrow(
      "Agent 'unavailable-agent' could not be resolved to an authored Agent definition",
    );
    expect(adapter.startSession).not.toHaveBeenCalled();
    await localService.shutdown();
  });

  test.each(['codex', 'muse'] as const)(
    '%s start fails closed when its session agent has no authored spec (#3027)',
    async (provider) => {
      // Composed coverage for every delivery-capable provider, not just the
      // claude/acp pair: the gate's symmetry claim is only proven where the
      // real resolver + dispatch pipeline enforces it.
      const adapter = new FakeAdapter(provider);
      const localService = new OrchestrationService({
        adapterRegistry: createRegistry([adapter]),
        eventBus,
        eventStore,
        resolveSessionAgent: createSessionAgentResolver({
          loadAgentSpec: async () => null,
          resolveToolServer: async () => null,
          resolveSkillDir: async () => null,
        }),
        logger: { debug: vi.fn(), warn: vi.fn() },
      });

      await expect(
        localService.dispatch({
          type: 'startSession',
          input: {
            threadId: `thread-unresolved-${provider}-agent`,
            provider,
            metadata: { agentSlug: 'unavailable-agent' },
          },
        }),
      ).rejects.toThrow(
        "Agent 'unavailable-agent' could not be resolved to an authored Agent definition",
      );
      expect(adapter.startSession).not.toHaveBeenCalled();
      await localService.shutdown();
    },
  );

  test('a provider with no session-delivery concept is not gated on resolver attachment (#3027)', async () => {
    // `sessionDeliveryChannels('bedrock')` is undefined: Station's own
    // engine and the managed model runtimes load authored specs themselves,
    // so the session resolver's deliberate no-op for them must not read as
    // a missing spec.
    const adapter = new FakeAdapter('bedrock');
    const localService = new OrchestrationService({
      adapterRegistry: createRegistry([adapter]),
      eventBus,
      eventStore,
      resolveSessionAgent: createSessionAgentResolver({
        loadAgentSpec: async () => null,
        resolveToolServer: async () => null,
        resolveSkillDir: async () => null,
      }),
      logger: { debug: vi.fn(), warn: vi.fn() },
    });

    await localService.dispatch({
      type: 'startSession',
      input: {
        threadId: 'thread-station-engine-agent',
        provider: 'bedrock',
        metadata: { agentSlug: 'authored-station-agent' },
      },
    });

    expect(adapter.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'bedrock',
        metadata: expect.objectContaining({
          agentSlug: 'authored-station-agent',
        }),
      }),
    );
    await localService.shutdown();
  });

  test('startSession strips client-forged capability and host-action provenance before resolution', async () => {
    const resolveSessionAgent = vi.fn(async (input: any) => ({
      ...input,
      agent: { slug: 'my-agent' },
    }));
    const localService = new OrchestrationService({
      adapterRegistry: createRegistry([claude]),
      eventBus,
      eventStore,
      listProjects: () => configuredProjects,
      resolveSessionAgent,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });

    await localService.dispatch({
      type: 'startSession',
      input: {
        threadId: 'thread-strip-forged-metadata',
        provider: 'claude',
        modelId: 'claude-sonnet',
        metadata: {
          agentSlug: 'my-agent',
          capabilityDelivery: { agentSlug: 'forged-agent' },
          workspacePaneHostAction: {
            pluginId: 'forged',
            actionId: 'forged',
            installationGeneration: 'forged',
          },
        },
      },
    });

    expect(resolveSessionAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ agentSlug: 'my-agent' }),
      }),
      undefined,
    );
    expect(
      resolveSessionAgent.mock.calls.at(-1)?.[0].metadata,
    ).not.toHaveProperty('workspacePaneHostAction');
    expect(claude.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ agentSlug: 'my-agent' }),
      }),
    );
  });

  test('rejects attached-session mutations before adapter lookup', async () => {
    const threadId = 'external:claude:session-1';
    eventStore.upsertSession({
      provider: 'claude',
      threadId,
      status: 'closed',
      controlMode: 'read-only-attached',
      attachedSource: {
        kind: 'claude-transcript',
        externalSessionId: 'session-1',
      },
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
    });
    const hasSession = vi.spyOn(claude, 'hasSession');
    const listSessions = vi.spyOn(claude, 'listSessions');

    const commands: OrchestrationCommand[] = [
      { type: 'sendTurn', input: { threadId, input: 'mutate' } },
      { type: 'interruptTurn', threadId },
      {
        type: 'respondToRequest',
        threadId,
        requestId: 'request-1',
        decision: 'accept',
      },
      { type: 'stopSession', threadId },
    ];

    for (const command of commands) {
      await expect(service.dispatch(command)).rejects.toThrow(
        'Attached sessions are read-only.',
      );
    }
    await expect(
      service.sessionLifecycles.transition({ threadId, to: 'blocked' }),
    ).rejects.toThrow('Attached sessions are read-only.');

    expect(hasSession).not.toHaveBeenCalled();
    expect(listSessions).not.toHaveBeenCalled();
    expect(claude.sendTurn).not.toHaveBeenCalled();
    expect(claude.interruptTurn).not.toHaveBeenCalled();
    expect(claude.respondToRequest).not.toHaveBeenCalled();
    expect(claude.stopSession).not.toHaveBeenCalled();
    expect(attachedSessionMutationRejected.add).toHaveBeenCalledTimes(4);
    expect(attachedSessionMutationRejected.add).toHaveBeenCalledWith(1, {
      command_type: 'sendTurn',
      source: 'attached',
    });
    const receipts = eventStore.listCommandReceipts(threadId);
    expect(receipts).toHaveLength(4);
    expect(receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          commandType: 'sendTurn',
          status: 'rejected',
        }),
        expect.objectContaining({
          commandType: 'interruptTurn',
          status: 'rejected',
        }),
        expect.objectContaining({
          commandType: 'respondToRequest',
          status: 'rejected',
        }),
        expect.objectContaining({
          commandType: 'stopSession',
          status: 'rejected',
        }),
      ]),
    );
  });

  // archive#1462: adoption binds the child to exactly one project. Before the
  // fix this picked whichever of the two `listProjects()` yielded first and
  // adopted into it silently.
  test('refuses to adopt an attached source whose workspace is configured as two projects', async () => {
    const sourceThreadId = 'external:claude:ambiguous-source';
    const projectRoot = join(tmp, 'ambiguous-project');
    const nestedCwd = join(projectRoot, 'packages', 'app');
    mkdirSync(nestedCwd, { recursive: true });
    installStationDeliveryFlow(projectRoot);
    configuredProjects.push(
      { slug: 'beta', workingDirectory: projectRoot },
      { slug: 'alpha', workingDirectory: projectRoot },
    );
    eventStore.upsertSession({
      provider: 'claude',
      threadId: sourceThreadId,
      status: 'ready',
      cwd: nestedCwd,
      controlMode: 'read-only-attached',
      attachedSource: {
        kind: 'claude-transcript',
        externalSessionId: 'vendor-ambiguous',
      },
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    });

    await expect(
      service.dispatch({ type: 'adoptSession', sourceThreadId }),
    ).rejects.toThrow(/configured as more than one project \(alpha, beta\)/);
    expect(claude.adoptSession).not.toHaveBeenCalled();
  });

  test('adopts an attached source into a new writable child without mutating the source', async () => {
    const sourceThreadId = 'external:claude:source';
    const projectRoot = join(tmp, 'project');
    const nestedCwd = join(projectRoot, 'packages', 'app');
    mkdirSync(nestedCwd, { recursive: true });
    installStationDeliveryFlow(projectRoot);
    configuredProjects.push({ slug: 'project', workingDirectory: projectRoot });
    eventStore.upsertSession({
      provider: 'claude',
      threadId: sourceThreadId,
      status: 'ready',
      cwd: nestedCwd,
      controlMode: 'read-only-attached',
      attachedSource: {
        kind: 'claude-transcript',
        externalSessionId: 'vendor-source',
      },
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
    });

    const detectWorkspace = vi.spyOn(flowRunService, 'detectWorkspace');
    const child = await service.dispatch(
      {
        type: 'adoptSession',
        sourceThreadId,
      },
      {
        tenantExecutionContext: { tenantId: 'alpha' as any, source: 'request' },
      },
    );

    expect(child).toMatchObject({
      provider: 'claude',
      controlMode: 'station-owned',
    });
    expect(child).not.toHaveProperty('cwd');
    expect(child).not.toHaveProperty('resumeCursor');
    expect(child?.threadId).not.toBe(sourceThreadId);
    expect(claude.adoptSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceSessionId: 'vendor-source',
        cwd: realpathSync(nestedCwd),
        sourceKind: 'claude-transcript',
        metadata: expect.objectContaining({
          adoptedFromThreadId: sourceThreadId,
          modelLaunchPlan: {
            kind: 'engine-selected',
            evidence: 'adapter-declared',
          },
        }),
        tenantExecutionContext: { tenantId: 'alpha', source: 'request' },
      }),
      expect.objectContaining({
        onProviderChildCreated: expect.any(Function),
      }),
    );
    expect(modelLaunchResolutionTotal.add).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        provider: 'claude',
        lifecycle: 'resume',
        outcome: 'accepted',
        requested_override: 'false',
      }),
    );
    expect(detectWorkspace).not.toHaveBeenCalled();
    expect(
      eventStore
        .listEvents(child!.threadId)
        .filter((event) => event.method === 'flow.run-attached'),
    ).toEqual([]);
    await service.dispatch({
      type: 'sendTurn',
      input: { threadId: child!.threadId, input: 'continue here' },
    });
    expect(claude.sendTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: child!.threadId,
        input: 'continue here',
        metadata: expect.objectContaining({
          modelLaunchPlan: expect.any(Object),
        }),
      }),
    );
    expect(eventStore.readSessions()).toContainEqual(
      expect.objectContaining({
        threadId: sourceThreadId,
        controlMode: 'read-only-attached',
        attachedSource: expect.objectContaining({
          externalSessionId: 'vendor-source',
        }),
      }),
    );
  });

  test('rejects an unavailable retained adoption plan before readiness or provider fork', async () => {
    const sourceThreadId = 'external:bedrock:unavailable-adoption';
    const projectRoot = join(tmp, 'unavailable-adoption-project');
    mkdirSync(projectRoot, { recursive: true });
    installStationDeliveryFlow(projectRoot);
    configuredProjects.push({ slug: 'project', workingDirectory: projectRoot });
    eventStore.upsertSession({
      provider: 'bedrock',
      threadId: sourceThreadId,
      status: 'ready',
      cwd: projectRoot,
      model: 'source-model',
      controlMode: 'read-only-attached',
      attachedSource: {
        kind: 'bedrock-transcript',
        externalSessionId: 'source-session',
      },
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    });
    bedrock.metadata.modelLaunch = {
      defaultAtStart: 'station-resolved',
      omissionAtResume: 'retain-session-model',
      omissionPerTurn: 'retain-session-model',
      overrideAtStart: true,
      overrideAtResume: true,
      overridePerTurn: true,
      // Deliberately absent: a retained Station-backed selector cannot be
      // accepted without the execution connection that validates it.
    };
    const readiness = vi.spyOn(bedrock, 'getPrerequisites');
    vi.mocked(modelLaunchResolutionTotal.add).mockClear();

    await expect(
      service.dispatchWithReceipt({ type: 'adoptSession', sourceThreadId }),
    ).rejects.toThrow(
      'Station could not continue this attached session. No continuation was kept.',
    );

    expect(readiness).not.toHaveBeenCalled();
    expect(bedrock.adoptSession).not.toHaveBeenCalled();
    expect(modelLaunchResolutionTotal.add).toHaveBeenCalledTimes(1);
    expect(modelLaunchResolutionTotal.add).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        provider: 'bedrock',
        lifecycle: 'resume',
        requested_override: 'false',
        outcome: 'rejected',
        reason: 'model-required',
      }),
    );
    expect(eventStore.listCommandReceipts(sourceThreadId)).toEqual([]);
    expect(
      eventStore
        .listEvents()
        .filter((event) => event.method === 'session.started'),
    ).toEqual([]);
  });

  test('an adopted session inherits the adopting caller as owner and is unreadable by a different user (station#1165)', async () => {
    // Reproduces archive#1165: `AttachedSessionAdoption.adopt` must stamp the
    // adopting caller's userId into the adapter's `adoptSession` metadata the same
    // way `startSession` is stamped server-side at the `/commands` route
    // (`orchestration.ts`'s `userId: deps.getUserId?.() ?? getCachedUser().alias`),
    // so the resulting session.started/session.configured event carries a
    // real owner instead of leaving the adopted thread permanently
    // ownerless. `ownerlessSessionAccess: 'single-user-compat'` mirrors
    // `runtime-initialize.ts`'s production default so this test exercises
    // the exact policy archive#1165 is about (under this suite's default `deny`
    // policy, the pre-existing source-thread precheck wouldn't even let a
    // userId-bearing dispatch through, masking the bug this test targets).
    const sourceThreadId = 'external:claude:source-1165';
    const projectRoot = join(tmp, 'project-1165');
    mkdirSync(projectRoot, { recursive: true });
    installStationDeliveryFlow(projectRoot);
    const localProjects = [
      { slug: 'project-1165', workingDirectory: projectRoot },
    ];
    const claudeLocal = new FakeAdapter('claude', [
      {
        id: 'anthropic-api-key',
        name: 'Anthropic API key',
        status: 'installed',
        category: 'required',
        description: 'Used to access Claude Agent SDK.',
      },
    ]);
    const localService = new OrchestrationService({
      adapterRegistry: createRegistry([claudeLocal]),
      eventBus,
      eventStore,
      flowRunService,
      listProjects: () => localProjects,
      workflowSidecarService,
      ownerlessSessionAccess: 'single-user-compat',
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    localService.initialize();
    eventStore.upsertSession({
      provider: 'claude',
      threadId: sourceThreadId,
      status: 'ready',
      cwd: projectRoot,
      controlMode: 'read-only-attached',
      attachedSource: {
        kind: 'claude-transcript',
        externalSessionId: 'vendor-source-1165',
      },
      createdAt: '2026-07-28T00:00:00.000Z',
      updatedAt: '2026-07-28T00:00:00.000Z',
    });

    const child = await localService.dispatch(
      { type: 'adoptSession', sourceThreadId },
      { userId: 'adopter-user' },
    );
    const childThreadId = (child as { threadId: string }).threadId;

    // The stamped identity reaches the adapter — no client-suppliable
    // channel exists to spoof it (`adoptSessionCommandSchema` carries no
    // `metadata` field at all, unlike `startSession`'s body).
    expect(claudeLocal.adoptSession).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          adoptedFromThreadId: sourceThreadId,
          userId: 'adopter-user',
        }),
      }),
      expect.objectContaining({ onProviderChildCreated: expect.any(Function) }),
    );

    // Simulate the real adapter's session.configured publish (every
    // adapter's `adoptSession` funnels into the same session.started/
    // session.configured path a normal `startSession` uses — see
    // claude-adapter.ts's `startTrackedSession`,
    // `metadata: { ...input.metadata, cwd: input.cwd }`) to prove
    // ownership resolves end-to-end through `canUserReadSession`, the same
    // shape the `session-owner cache (archive#1120)` suite uses below.
    claudeLocal.events.push({
      eventId: `evt-adopted-configured-${childThreadId}`,
      provider: 'claude',
      threadId: childThreadId,
      createdAt: '2026-07-28T00:00:01.000Z',
      method: 'session.configured',
      sessionId: childThreadId,
      metadata: { userId: 'adopter-user' },
    } as CanonicalRuntimeEvent);
    // The adoption commit itself already persists a `flow.run-attached`
    // event for `childThreadId` (`commitAdoptedSession`), so a bare
    // `length > 0` wait would resolve on that instead of the
    // `session.configured` frame pushed above — wait specifically for the
    // pushed event to land.
    await waitFor(
      () =>
        eventStore
          .listEvents(childThreadId)
          .some((entry) => entry.payload.method === 'session.configured'),
      (found) => found,
    );

    expect(
      localService.canUserReadSession(
        childThreadId,
        personalReadAuthority('adopter-user'),
      ),
    ).toBe(true);
    expect(
      localService.canUserReadSession(
        childThreadId,
        personalReadAuthority('someone-else'),
      ),
    ).toBe(false);
  });

  test('refuses adoption when the source provider lacks independent-continuation support', async () => {
    const sourceThreadId = 'external:bedrock:source';
    const projectRoot = join(tmp, 'project');
    mkdirSync(projectRoot, { recursive: true });
    configuredProjects.push({ slug: 'project', workingDirectory: projectRoot });
    eventStore.upsertSession({
      provider: 'bedrock',
      threadId: sourceThreadId,
      status: 'ready',
      cwd: projectRoot,
      controlMode: 'read-only-attached',
      attachedSource: { kind: 'test', externalSessionId: 'vendor-source' },
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
    });
    Object.defineProperty(bedrock, 'adoptSession', { value: undefined });

    await expect(
      service.dispatch({ type: 'adoptSession', sourceThreadId }),
    ).rejects.toThrow('does not support continuing attached sessions');
    expect(bedrock.startSession).not.toHaveBeenCalled();
  });

  test('adoption does not inspect or depend on a Flow workspace', async () => {
    const sourceThreadId = 'external:claude:flow-source';
    const projectRoot = join(tmp, 'project');
    mkdirSync(projectRoot, { recursive: true });
    configuredProjects.push({ slug: 'project', workingDirectory: projectRoot });
    eventStore.upsertSession({
      provider: 'claude',
      threadId: sourceThreadId,
      status: 'ready',
      cwd: projectRoot,
      controlMode: 'read-only-attached',
      attachedSource: {
        kind: 'claude-transcript',
        externalSessionId: 'vendor-flow-source',
      },
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
    });
    vi.spyOn(flowRunService, 'detectWorkspace').mockRejectedValueOnce(
      new Error('invalid Flow workspace'),
    );

    await expect(
      service.dispatch({ type: 'adoptSession', sourceThreadId }),
    ).resolves.toMatchObject({ controlMode: 'station-owned' });

    expect(flowRunService.detectWorkspace).not.toHaveBeenCalled();
    expect(claude.adoptSession).toHaveBeenCalledOnce();
    expect(claude.discardSession).not.toHaveBeenCalled();
  });

  test('coalesces concurrent same-key adoption while creating exactly one provider fork', async () => {
    const sourceThreadId = 'external:claude:concurrent';
    const projectRoot = join(tmp, 'concurrent-project');
    mkdirSync(projectRoot, { recursive: true });
    installStationDeliveryFlow(projectRoot);
    configuredProjects.push({ slug: 'project', workingDirectory: projectRoot });
    eventStore.upsertSession({
      provider: 'claude',
      threadId: sourceThreadId,
      status: 'ready',
      cwd: projectRoot,
      controlMode: 'read-only-attached',
      attachedSource: {
        kind: 'claude-transcript',
        externalSessionId: 'vendor-concurrent',
      },
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
    });
    const pending = deferred<ProviderSession>();
    claude.adoptSession.mockReturnValueOnce(pending.promise);

    const idempotencyKey = '22222222-2222-4222-8222-222222222222';
    const first = service.dispatch({
      type: 'adoptSession',
      sourceThreadId,
      idempotencyKey,
    });
    await vi.waitFor(() => expect(claude.adoptSession).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(adoptionLedger.reservations()).toEqual([
      expect.objectContaining({ status: 'forking' }),
    ]);
    const second = service.dispatch({
      type: 'adoptSession',
      sourceThreadId,
      idempotencyKey,
    });
    const input = claude.adoptSession.mock.calls[0]![0];
    pending.resolve({
      provider: 'claude',
      threadId: input.threadId,
      status: 'ready',
      cwd: input.cwd,
      resumeCursor: 'vendor-concurrent-child',
      createdAt: '2026-07-22T00:00:01.000Z',
      updatedAt: '2026-07-22T00:00:01.000Z',
    });
    await expect(first).resolves.toMatchObject({ provider: 'claude' });
    await expect(second).resolves.toMatchObject({
      provider: 'claude',
      alreadyAdopted: true,
    });
    expect(claude.adoptSession).toHaveBeenCalledOnce();
  });

  test('different keys and missing keys preserve distinct Continue intents', async () => {
    const sourceThreadId = 'external:claude:distinct-intents';
    const projectRoot = join(tmp, 'distinct-intents-project');
    mkdirSync(projectRoot, { recursive: true });
    installStationDeliveryFlow(projectRoot);
    configuredProjects.push({ slug: 'project', workingDirectory: projectRoot });
    eventStore.upsertSession({
      provider: 'claude',
      threadId: sourceThreadId,
      status: 'ready',
      cwd: projectRoot,
      controlMode: 'read-only-attached',
      attachedSource: {
        kind: 'claude-transcript',
        externalSessionId: 'vendor-distinct-intents',
      },
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
    });

    const results = [
      await service.dispatch({
        type: 'adoptSession',
        sourceThreadId,
        idempotencyKey: '33333333-3333-4333-8333-333333333333',
      }),
      await service.dispatch({
        type: 'adoptSession',
        sourceThreadId,
        idempotencyKey: '44444444-4444-4444-8444-444444444444',
      }),
    ];
    // Keyless keeps the PRE-EXISTING source-scoped dedup (pinned separately
    // by the hosted tenant-validation test): a keyless adoption of a source
    // that already has a live continuation JOINS it — it does not mint a
    // third. Distinct keys remain distinct intents.
    const legacyFirst = await service.dispatch({
      type: 'adoptSession',
      sourceThreadId,
    });
    const legacySecond = await service.dispatch({
      type: 'adoptSession',
      sourceThreadId,
    });

    expect(new Set(results.map((result) => result?.threadId)).size).toBe(2);
    expect(legacyFirst?.threadId).toBe(legacySecond?.threadId);
    expect(results.map((result) => result?.threadId)).toContain(
      legacyFirst?.threadId,
    );
    expect(claude.adoptSession).toHaveBeenCalledTimes(2);
  });

  test('returns the persisted continuation after restart without forking again', async () => {
    const sourceThreadId = 'external:claude:restart';
    const projectRoot = join(tmp, 'restart-project');
    mkdirSync(projectRoot, { recursive: true });
    installStationDeliveryFlow(projectRoot);
    configuredProjects.push({ slug: 'project', workingDirectory: projectRoot });
    eventStore.upsertSession({
      provider: 'claude',
      threadId: sourceThreadId,
      status: 'ready',
      cwd: projectRoot,
      controlMode: 'read-only-attached',
      attachedSource: {
        kind: 'claude-transcript',
        externalSessionId: 'vendor-restart',
      },
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
    });
    const first = await service.dispatch({
      type: 'adoptSession',
      sourceThreadId,
      idempotencyKey: '11111111-1111-4111-8111-111111111111',
    });
    const restarted = new OrchestrationService({
      adapterRegistry: createRegistry([bedrock, claude]),
      eventBus,
      eventStore,
      flowRunService,
      listProjects: () => configuredProjects,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });

    const second = await restarted.dispatch({
      type: 'adoptSession',
      sourceThreadId,
      idempotencyKey: '11111111-1111-4111-8111-111111111111',
    });

    expect(second).toEqual({ ...first, alreadyAdopted: true });
    expect(claude.adoptSession).toHaveBeenCalledOnce();
    expect(eventStore.readSessions()).toContainEqual(
      expect.objectContaining({
        threadId: first!.threadId,
        continuationSourceThreadId: sourceThreadId,
        persistSession: true,
      }),
    );
  });

  test('joins the committed winner when the adoption store reports a unique-key conflict', async () => {
    const sourceThreadId = 'external:claude:cross-process-winner';
    const winnerThreadId = 'winner-continuation';
    const idempotencyKey = '55555555-5555-4555-8555-555555555555';
    const projectRoot = join(tmp, 'cross-process-winner-project');
    mkdirSync(projectRoot, { recursive: true });
    installStationDeliveryFlow(projectRoot);
    configuredProjects.push({ slug: 'project', workingDirectory: projectRoot });
    eventStore.upsertSession({
      provider: 'claude',
      threadId: sourceThreadId,
      status: 'ready',
      cwd: projectRoot,
      controlMode: 'read-only-attached',
      attachedSource: {
        kind: 'claude-transcript',
        externalSessionId: 'vendor-cross-process-winner',
      },
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
    });
    eventStore.upsertSession({
      provider: 'claude',
      threadId: winnerThreadId,
      status: 'ready',
      cwd: projectRoot,
      resumeCursor: 'vendor-winner-child',
      continuationSourceThreadId: sourceThreadId,
      adoptionIdempotencyKey: idempotencyKey,
      persistSession: true,
      createdAt: '2026-07-22T00:00:01.000Z',
      updatedAt: '2026-07-22T00:00:01.000Z',
    });

    const originalReadSessions = eventStore.readSessions.bind(eventStore);
    const originalUpsertSession = eventStore.upsertSession.bind(eventStore);
    let constraintRaised = false;
    vi.spyOn(eventStore, 'readSessions').mockImplementation(() =>
      originalReadSessions().filter(
        (session) => constraintRaised || session.threadId !== winnerThreadId,
      ),
    );
    vi.spyOn(eventStore, 'upsertSession').mockImplementation((session) => {
      if (session.continuationSourceThreadId === sourceThreadId) {
        constraintRaised = true;
        const constraint = new Error(
          'UNIQUE constraint failed: provider_session_state.adoption_idempotency_key',
        ) as Error & { code: string };
        constraint.code = 'SQLITE_CONSTRAINT_UNIQUE';
        throw constraint;
      }
      originalUpsertSession(session);
    });

    await expect(
      service.dispatch({
        type: 'adoptSession',
        sourceThreadId,
        idempotencyKey,
      }),
    ).resolves.toMatchObject({
      threadId: winnerThreadId,
      status: 'ready',
      alreadyAdopted: true,
    });
    expect(claude.adoptSession).toHaveBeenCalledOnce();
    expect(claude.discardSession).toHaveBeenCalledOnce();
  });

  test('reports typed retryable in-progress when a same-key reservation winner has not committed yet', async () => {
    const sourceThreadId = 'external:claude:cross-process-pending';
    const idempotencyKey = '77777777-7777-4777-8777-777777777777';
    const projectRoot = join(tmp, 'cross-process-pending-project');
    mkdirSync(projectRoot, { recursive: true });
    configuredProjects.push({ slug: 'project', workingDirectory: projectRoot });
    eventStore.upsertSession({
      provider: 'claude',
      threadId: sourceThreadId,
      status: 'ready',
      cwd: projectRoot,
      controlMode: 'read-only-attached',
      attachedSource: {
        kind: 'claude-transcript',
        externalSessionId: 'vendor-cross-process-pending',
      },
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
    });
    vi.spyOn(adoptionLedger, 'reserve').mockReturnValueOnce({
      kind: 'contended',
    });

    const dispatch = service.dispatch({
      type: 'adoptSession',
      sourceThreadId,
      idempotencyKey,
    });
    await expect(dispatch).rejects.toMatchObject({
      code: 'adoption_continuation_in_progress',
      retryable: true,
      message: 'Continuation is being created — retry shortly.',
    });
    await expect(dispatch).rejects.toBeInstanceOf(
      AdoptionContinuationInProgressError,
    );
    expect(claude.adoptSession).not.toHaveBeenCalled();
  });

  test('a keyed re-request returns its terminal continuation instead of creating a replacement', async () => {
    const sourceThreadId = 'external:claude:terminal-continuation';
    const idempotencyKey = '66666666-6666-4666-8666-666666666666';
    const projectRoot = join(tmp, 'terminal-continuation-project');
    mkdirSync(projectRoot, { recursive: true });
    configuredProjects.push({ slug: 'project', workingDirectory: projectRoot });
    eventStore.upsertSession({
      provider: 'claude',
      threadId: sourceThreadId,
      status: 'ready',
      cwd: projectRoot,
      controlMode: 'read-only-attached',
      attachedSource: {
        kind: 'claude-transcript',
        externalSessionId: 'vendor-terminal-continuation',
      },
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
    });
    eventStore.upsertSession({
      provider: 'claude',
      threadId: 'terminal-child',
      status: 'closed',
      cwd: projectRoot,
      resumeCursor: 'vendor-terminal-child',
      continuationSourceThreadId: sourceThreadId,
      adoptionIdempotencyKey: idempotencyKey,
      persistSession: true,
      createdAt: '2026-07-22T00:00:01.000Z',
      updatedAt: '2026-07-22T00:00:02.000Z',
    });

    await expect(
      service.dispatch({
        type: 'adoptSession',
        sourceThreadId,
        idempotencyKey,
      }),
    ).resolves.toMatchObject({
      threadId: 'terminal-child',
      status: 'closed',
      alreadyAdopted: true,
    });
    expect(claude.adoptSession).not.toHaveBeenCalled();
  });

  test('evicts a recovered attached alias for a Station-owned provider cursor', async () => {
    const projectRoot = join(tmp, 'recovered-collision');
    mkdirSync(projectRoot, { recursive: true });
    configuredProjects.push({ slug: 'project', workingDirectory: projectRoot });
    const aliasThreadId = 'external:claude:vendor-child';
    eventStore.upsertSession({
      provider: 'claude',
      threadId: aliasThreadId,
      status: 'ready',
      cwd: projectRoot,
      controlMode: 'read-only-attached',
      attachedSource: {
        kind: 'claude-transcript',
        externalSessionId: 'vendor-child',
      },
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
    });
    eventStore.upsertSession({
      provider: 'claude',
      threadId: 'station-child',
      status: 'ready',
      cwd: projectRoot,
      resumeCursor: 'vendor-child',
      continuationSourceThreadId: 'external:claude:original-source',
      persistSession: true,
      createdAt: '2026-07-22T00:00:01.000Z',
      updatedAt: '2026-07-22T00:00:01.000Z',
    });

    service.initialize();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const sessions = await service.listSessionReadModel();

    expect(sessions.map((session) => session.threadId)).not.toContain(
      aliasThreadId,
    );
    expect(
      eventStore.readSessions().map((session) => session.threadId),
    ).not.toContain(aliasThreadId);
    await expect(
      service.dispatch({ type: 'adoptSession', sourceThreadId: aliasThreadId }),
    ).rejects.toThrow('Attached session not found');
    expect(claude.adoptSession).not.toHaveBeenCalled();
  });

  // archive#1867: `listSessionReadModel` feeds the SSE `/events` snapshot and
  // must never trigger an unbounded synchronous `listEvents(threadId)` over a
  // thread with a very large event log — that single `.all()` wedged the whole
  // server. It uses the complete, method-targeted projection + COUNT pair so
  // old load-bearing facts remain authoritative and `eventCount` stays true.
  // Deliberately writes a 5k-event delta (see the assertions below: the
  // point is that facts at the START of a very large transcript survive,
  // which a bounded recent-tail read would lose). 5,000 is chosen against
  // the numeric tails on the reads this path could plausibly be rewritten
  // to use (`LIMIT 1001` on the recent-by-thread read, 250 on the paged
  // read, 1,000 recent events / 100 records in conversation history) with a
  // 5x margin, so a tail-shaped regression still loses the head facts. The
  // reads the fold actually uses are bounded by projection cardinality, not
  // by a row cap -- which is what the `< 60` guard below pins directly and
  // at any fixture size. The previous 50k proved nothing more and cost ~30s
  // of synchronous appends alone (~125s under corpus load), making this one
  // test the critical path of its ordinary shard. Budget the fixture
  // explicitly rather than relying on the 30s default.
  test('listSessionReadModel uses a complete targeted projection and accurate total count (station#1867)', {
    timeout: 60_000,
  }, async () => {
    const threadId = 'read-model-bounded-1867';
    const now = '2026-07-22T00:00:00.000Z';
    eventStore.upsertSession({
      provider: 'claude',
      threadId,
      status: 'ready',
      createdAt: now,
      updatedAt: now,
    });
    eventStore.appendEvent({
      eventId: 'evt-1867-flow-at-zero',
      provider: 'claude',
      threadId,
      createdAt: new Date(1_699_999_999_000).toISOString(),
      method: 'flow.run-attached',
      runId: 'run-older-than-transcript',
      definitionId: 'targeted-projection',
      cwd: '/workspace/flow',
      resumed: false,
    } as never);
    eventStore.appendEvent({
      eventId: 'evt-1867-policy-at-zero',
      provider: 'claude',
      threadId,
      createdAt: new Date(1_699_999_999_500).toISOString(),
      method: 'policy.hooks-attached',
      cwd: '/workspace/policy',
    } as never);
    const total = 5_000;
    for (let i = 0; i < total; i += 1) {
      eventStore.appendEvent({
        eventId: `evt-1867-rm-${i}`,
        provider: 'claude',
        threadId,
        createdAt: new Date(1_700_000_000_000 + i * 1000).toISOString(),
        method: 'content.text-delta',
        itemId: `item-${i}`,
        delta: `chunk-${i}`,
      });
    }
    service.initialize();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const listEventsSpy = vi.spyOn(eventStore, 'listEvents');
    // archive#4466 review remediation: assert bounded WORK, not just that a
    // named method was called with the right threadId. An earlier version
    // of this test spied `listSessionProjectionEventsForThreads` and
    // `countEventsByThreads` and asserted only `toHaveBeenCalledWith(...)` —
    // that passed even when the first version of
    // `listSessionProjectionEventsForThreads` fetched EVERY one of this
    // fixture's 5,002 rows unfiltered (an independent review caught it: the
    // spy watched a NAME, not the row/attachment work behind it). `mapEventRow`
    // (called once per SQL row actually materialized with its payload) and
    // `hydrateAttachments` (called once per `mapEventRow`, and the one that
    // does the expensive `readFileSync`/SHA-256/`touch()` for `turn.started`
    // attachments) are the two chokepoints unboundedness would show up at —
    // spying THESE and asserting a small constant is the guard that would
    // have caught the retired implementation.
    const eventStoreInternals = eventStore as unknown as {
      mapEventRow: (row: unknown) => unknown;
      hydrateAttachments: (event: unknown) => unknown;
    };
    const mapEventRowSpy = vi.spyOn(eventStoreInternals, 'mapEventRow');
    const hydrateAttachmentsSpy = vi.spyOn(
      eventStoreInternals,
      'hydrateAttachments',
    );
    const projectionSpy = vi.spyOn(
      eventStore,
      'listSessionProjectionEventsForThreads',
    );
    const countSpy = vi.spyOn(eventStore, 'countEventsByThreads');

    const summary = (await service.listSessionReadModel()).find(
      (candidate) => candidate.threadId === threadId,
    );

    expect(summary).toBeDefined();
    // eventCount is the TRUE total from COUNT(*), not the bounded tail length.
    expect(summary?.eventCount).toBe(total + 2);
    // The unbounded read must NOT be on the snapshot path.
    expect(listEventsSpy).not.toHaveBeenCalled();
    // The complete method-targeted projection + count are the bounded work.
    expect(projectionSpy).toHaveBeenCalledWith(
      expect.arrayContaining([threadId]),
    );
    expect(countSpy).toHaveBeenCalled();
    // THE bounded-work guard: this thread has 5,002 rows, but the fold's
    // reachable rows are bounded by construction, independent of transcript
    // length: at most 2 ranked rows per PROJECTION_FOLD_METHOD (first+last,
    // 11 methods) plus the latest-any-method, first-prompted, turn-terminal
    // and own-turn-start companions — ~26 on a maximally fold-rich thread
    // (delta review measured 25). 60 = that derivation with margin; the
    // defect this guards produced 5,002, two orders of magnitude away,
    // so the headroom costs no power while letting the fixture grow a
    // turn.started without a false red.
    expect(mapEventRowSpy.mock.calls.length).toBeLessThan(60);
    expect(hydrateAttachmentsSpy.mock.calls.length).toBeLessThan(60);

    // The facts at the beginning of a 5k-delta transcript remain available
    // to their consumers. A recent tail would make both of these false/null.
    const targetedService = service as unknown as {
      flowPolicy: {
        isFlowBoundThread(id: string): boolean;
        resolvePolicyCwd(id: string): string | null;
      };
    };
    expect(targetedService.flowPolicy.isFlowBoundThread(threadId)).toBe(true);
    expect(targetedService.flowPolicy.resolvePolicyCwd(threadId)).toBe(
      '/workspace/policy',
    );

    listEventsSpy.mockRestore();
    mapEventRowSpy.mockRestore();
    hydrateAttachmentsSpy.mockRestore();
    projectionSpy.mockRestore();
    countSpy.mockRestore();
  });

  test('reconciles a crash-before-cursor reservation through provider lookup', async () => {
    const projectRoot = join(tmp, 'ambiguous-crash');
    mkdirSync(projectRoot, { recursive: true });
    const now = '2026-07-22T00:00:00.000Z';
    const stranded = adoptionLedger.reserve({
      sourceThreadId: 'external:claude:ambiguous',
      targetThreadId: 'ambiguous-child',
      ownerId: 'crashed-owner',
      ownerPid: -1,
      provider: 'claude',
      sourceSessionId: 'vendor-ambiguous',
      sourceKind: 'claude-transcript',
      cwd: projectRoot,
      projectRoot,
      createdAt: now,
      updatedAt: now,
    });
    expect(stranded.kind).toBe('owner');
    if (stranded.kind === 'owner') stranded.adoption.markForking();

    service.initialize();
    await waitFor(
      () => adoptionLedger.reservations().length,
      (count) => count === 0,
    );

    expect(claude.discardSession).toHaveBeenCalledWith('ambiguous-child', {
      adoptionKey: 'ambiguous-child',
      createdAt: now,
      cwd: projectRoot,
      resumeCursor: undefined,
    });
    expect(claude.adoptSession).not.toHaveBeenCalled();
  });

  test('retains a provider cursor tombstone when rollback deletion fails and retries it on restart', async () => {
    const sourceThreadId = 'external:claude:rollback-retry';
    const projectRoot = join(tmp, 'rollback-retry');
    mkdirSync(projectRoot, { recursive: true });
    installStationDeliveryFlow(projectRoot);
    configuredProjects.push({ slug: 'project', workingDirectory: projectRoot });
    eventStore.upsertSession({
      provider: 'claude',
      threadId: sourceThreadId,
      status: 'ready',
      cwd: projectRoot,
      controlMode: 'read-only-attached',
      attachedSource: {
        kind: 'claude-transcript',
        externalSessionId: 'vendor-rollback-retry',
      },
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
    });
    vi.spyOn(adoptionLedger, 'reserve').mockImplementationOnce((input) => {
      const reserved = eventStore.createAdoptionLedger().reserve(input);
      if (reserved.kind !== 'owner') return reserved;
      return {
        kind: 'owner',
        adoption: {
          ...reserved.adoption,
          commit: () => {
            throw new Error('commit interrupted');
          },
        },
      };
    });
    claude.discardSession.mockRejectedValueOnce(
      new Error('delete unavailable'),
    );

    await expect(
      service.dispatch({ type: 'adoptSession', sourceThreadId }),
    ).rejects.toThrow('Continuation cleanup is pending');

    expect(adoptionLedger.reservations()).toEqual([
      expect.objectContaining({
        sourceThreadId,
        status: 'rollback-pending',
        providerResumeCursor: 'vendor-rollback-retry:child',
        providerCleanupComplete: false,
      }),
    ]);
    expect(
      adoptionLedger.reservesProviderCursor(
        'claude',
        'vendor-rollback-retry:child',
      ),
    ).toBe(true);

    await service.shutdown();
    const restarted = new OrchestrationService({
      adapterRegistry: createRegistry([bedrock, claude]),
      eventBus,
      eventStore,
      flowRunService,
      listProjects: () => configuredProjects,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    restarted.initialize();
    await waitFor(
      () => adoptionLedger.reservations().length,
      (count) => count === 0,
    );
    expect(claude.discardSession).toHaveBeenCalledTimes(2);
  });

  test('rejects a concurrent duplicate start before adapter ownership can be overwritten', async () => {
    const pending = deferred<ProviderSession>();
    claude.startSession.mockReturnValueOnce(pending.promise);
    const command: OrchestrationCommand = {
      type: 'startSession',
      input: {
        threadId: 'duplicate-start',
        provider: 'claude',
        modelId: 'claude-sonnet',
      },
    };

    const first = service.dispatch(command);
    await vi.waitFor(() => expect(claude.startSession).toHaveBeenCalledOnce());
    await expect(service.dispatch(command)).rejects.toThrow('already starting');

    const now = new Date().toISOString();
    pending.resolve({
      provider: 'claude',
      threadId: 'duplicate-start',
      status: 'ready',
      model: 'claude-sonnet',
      createdAt: now,
      updatedAt: now,
    });
    await expect(first).resolves.toMatchObject({ threadId: 'duplicate-start' });
    expect(claude.startSession).toHaveBeenCalledOnce();
  });

  test('starts consuming events from adapters registered after initialization', async () => {
    const registry = createReplaceableRegistry([bedrock, claude]);
    const dynamicService = new OrchestrationService({
      adapterRegistry: registry,
      eventBus,
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    dynamicService.initialize();
    await dynamicService.dispatch({
      type: 'startSession',
      input: {
        threadId: 'replaced-thread',
        provider: 'claude',
        modelId: 'claude-sonnet',
      },
    });
    const replacement = new FakeAdapter('claude');

    registry.register(replacement);
    claude.events.push({
      eventId: 'retired-adapter-event',
      provider: 'claude',
      threadId: 'retired-thread',
      createdAt: '2026-07-19T00:00:00.000Z',
      method: 'session.started',
      sessionId: 'retired-thread',
      initialState: 'created',
    });
    replacement.events.push({
      eventId: 'dynamic-adapter-event',
      provider: 'claude',
      threadId: 'dynamic-thread',
      createdAt: '2026-07-19T00:00:00.000Z',
      method: 'session.started',
      sessionId: 'dynamic-thread',
      initialState: 'created',
    });

    await waitFor(
      () => eventStore.listEvents('dynamic-thread'),
      (events) => events.some((event) => event.id === 'dynamic-adapter-event'),
    );
    await waitFor(
      () => claude.stopAll.mock.calls.length,
      (calls) => calls === 1,
    );
    await waitFor(
      () =>
        eventStore
          .readSessions()
          .find((session) => session.threadId === 'replaced-thread')?.status,
      (status) => status === 'closed',
    );
    expect(
      eventStore
        .listEvents('replaced-thread')
        .map((event) => event.payload)
        .find((event) => event.method === 'session.exited'),
    ).toMatchObject({ reason: 'adapter_replaced' });
    await expect(
      dynamicService.dispatch({
        type: 'sendTurn',
        input: { threadId: 'replaced-thread', input: 'hello' },
      }),
    ).rejects.toThrow('No provider session found');
    expect(replacement.sendTurn).not.toHaveBeenCalled();
    expect(eventStore.listEvents('retired-thread')).toEqual([]);
    await dynamicService.shutdown();
  });

  test('does not launch through an adapter replaced during model validation', async () => {
    const validating = new FakeAdapter('claude');
    const models =
      deferred<Array<{ id: string; name: string; originalId: string }>>();
    validating.listModels.mockReturnValueOnce(models.promise);
    const registry = createReplaceableRegistry([validating]);
    const dynamicService = new OrchestrationService({
      adapterRegistry: registry,
      eventBus,
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    const launch = dynamicService.dispatch({
      type: 'startSession',
      input: {
        threadId: 'validation-race',
        provider: 'claude',
        modelId: 'claude-sonnet',
      },
    });
    await vi.waitFor(() => expect(validating.listModels).toHaveBeenCalled());

    registry.register(new FakeAdapter('claude'));
    models.resolve([
      {
        id: 'claude-sonnet',
        name: 'Claude Sonnet',
        originalId: 'claude-sonnet-native',
      },
    ]);

    await expect(launch).rejects.toThrow('replaced before');
    expect(validating.startSession).not.toHaveBeenCalled();
    await dynamicService.shutdown();
  });

  test('does not send a turn through an adapter replaced during model validation', async () => {
    const validating = new FakeAdapter('claude');
    validating.sessions.set('turn-race', {
      provider: 'claude',
      threadId: 'turn-race',
      status: 'ready',
      model: 'claude-sonnet',
      createdAt: '2026-07-19T00:00:00.000Z',
      updatedAt: '2026-07-19T00:00:00.000Z',
    });
    const models =
      deferred<Array<{ id: string; name: string; originalId: string }>>();
    validating.listModels.mockReturnValueOnce(models.promise);
    const registry = createReplaceableRegistry([validating]);
    const dynamicService = new OrchestrationService({
      adapterRegistry: registry,
      eventBus,
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    const turn = dynamicService.dispatch({
      type: 'sendTurn',
      input: {
        threadId: 'turn-race',
        input: 'hello',
        modelId: 'claude-sonnet',
      },
    });
    await vi.waitFor(() => expect(validating.listModels).toHaveBeenCalled());

    registry.register(new FakeAdapter('claude'));
    models.resolve([
      {
        id: 'claude-sonnet',
        name: 'Claude Sonnet',
        originalId: 'claude-sonnet',
      },
    ]);

    await expect(turn).rejects.toThrow('replaced before');
    expect(validating.sendTurn).not.toHaveBeenCalled();
    await dynamicService.shutdown();
  });

  test('preserves accepted turn truth when its adapter is replaced during send', async () => {
    const sending = new FakeAdapter('claude');
    const registry = createReplaceableRegistry([sending]);
    const dynamicService = new OrchestrationService({
      adapterRegistry: registry,
      eventBus,
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    await dynamicService.dispatch({
      type: 'startSession',
      input: {
        threadId: 'send-race',
        provider: 'claude',
        modelId: 'claude-sonnet',
      },
    });
    const sent = deferred<ProviderTurnStartResult>();
    sending.sendTurn.mockReturnValueOnce(sent.promise);

    const turn = dynamicService.dispatchWithReceipt({
      type: 'sendTurn',
      input: { threadId: 'send-race', input: 'hello' },
    });
    await vi.waitFor(() => expect(sending.sendTurn).toHaveBeenCalledOnce());
    registry.register(new FakeAdapter('claude'));
    sent.resolve({ threadId: 'send-race', turnId: 'stale-turn' });

    await expect(turn).resolves.toMatchObject({
      receipt: expect.objectContaining({ status: 'accepted' }),
      result: { threadId: 'send-race', turnId: 'stale-turn' },
    });
    await waitFor(
      () =>
        eventStore
          .readSessions()
          .find((session) => session.threadId === 'send-race')?.status,
      (status) => status === 'closed',
    );
    await dynamicService.shutdown();
  });

  test('stops a session completed by an adapter replaced during launch', async () => {
    const launching = new FakeAdapter('claude');
    const started = deferred<ProviderSession>();
    launching.startSession.mockReturnValueOnce(started.promise);
    const registry = createReplaceableRegistry([launching]);
    const dynamicService = new OrchestrationService({
      adapterRegistry: registry,
      eventBus,
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    const launch = dynamicService.dispatch({
      type: 'startSession',
      input: {
        threadId: 'start-race',
        provider: 'claude',
        modelId: 'claude-sonnet',
      },
    });
    await vi.waitFor(() => expect(launching.startSession).toHaveBeenCalled());

    registry.register(new FakeAdapter('claude'));
    started.resolve({
      provider: 'claude',
      threadId: 'start-race',
      status: 'ready',
      model: 'claude-sonnet',
      createdAt: '2026-07-19T00:00:00.000Z',
      updatedAt: '2026-07-19T00:00:00.000Z',
    });

    await expect(launch).rejects.toThrow('replaced while');
    expect(launching.stopSession).toHaveBeenCalledWith('start-race');
    expect(
      eventStore
        .readSessions()
        .find((session) => session.threadId === 'start-race'),
    ).toBeUndefined();
    await dynamicService.shutdown();
  });

  test('stops every current adapter during orchestration shutdown', async () => {
    await service.dispatch({
      type: 'startSession',
      input: {
        threadId: 'shutdown-session',
        provider: 'claude',
        modelId: 'claude-sonnet',
      },
    });

    await service.shutdown();

    expect(bedrock.stopAll).toHaveBeenCalledTimes(1);
    expect(claude.stopAll).toHaveBeenCalledTimes(1);
    expect(
      eventStore
        .readSessions()
        .find((session) => session.threadId === 'shutdown-session')?.status,
    ).toBe('closed');
    expect(
      eventStore
        .listEvents('shutdown-session')
        .map((event) => event.payload)
        .find((event) => event.method === 'session.exited'),
    ).toMatchObject({ reason: 'orchestration_shutdown' });
  });

  test('bounds shutdown when an adapter cleanup never settles', async () => {
    claude.stopAll.mockReturnValueOnce(new Promise(() => {}));
    const boundedService = new OrchestrationService({
      adapterRegistry: createRegistry([claude]),
      eventBus,
      eventStore,
      adapterStopTimeoutMs: 10,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    boundedService.initialize();

    await expect(boundedService.shutdown()).rejects.toThrow(
      'Provider adapter shutdown failed',
    );
  });

  test('disposes native-output grants before a failing provider shutdown can leave a late callback live', async () => {
    const failing = new FakeAdapter('claude');
    failing.stopAll.mockRejectedValueOnce(new Error('stop failed'));
    const boundedService = new OrchestrationService({
      adapterRegistry: createRegistry([failing]),
      eventBus,
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    const authority = (boundedService as any).nativeOutputGrants;
    const grant = authority.issue(
      {
        threadId: 'shutdown-native-thread',
        turnId: 'shutdown-native-turn',
        adapterId: 'station-agent',
        principal: { ...humanPrincipal('test', 'owner-a', 'Owner A') },
        configurationLease: { revision: 1 },
      },
      { isCurrent: () => true },
    )!;
    const scope = authority.bindNativeCall(grant, 'shutdown-native-call')!;

    await expect(boundedService.shutdown()).rejects.toThrow(
      'Provider adapter shutdown failed',
    );
    expect(authority.admit(scope)).toBeNull();
  });

  test('retains timed-out replacement cleanup for shutdown accounting', async () => {
    const retired = new FakeAdapter('claude');
    retired.stopAll.mockReturnValue(new Promise(() => {}));
    const registry = createReplaceableRegistry([retired]);
    const boundedService = new OrchestrationService({
      adapterRegistry: registry,
      eventBus,
      eventStore,
      adapterStopTimeoutMs: 10,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    boundedService.initialize();

    registry.register(new FakeAdapter('claude'));
    await vi.waitFor(() => expect(retired.stopAll).toHaveBeenCalledOnce());

    await expect(boundedService.shutdown()).rejects.toThrow(
      'Provider adapter shutdown failed',
    );
    expect(retired.stopAll).toHaveBeenCalledOnce();
  });

  test('shutdown does not double-stop an adapter that is still current AND retiring (slice 12 K4 guard)', async () => {
    // The behavioral complement of the shutdown-ordering invariant. Every
    // pre-existing fixture retires an adapter the registry has already
    // REPLACED, so the retiring adapter is absent from `currentAdapters`
    // and the `!retiringAdapters.has(adapter)` filter is unreachable —
    // deleting the filter was green across the whole suite. The filter only
    // decides anything for an adapter that is both current and retiring,
    // which is exactly what an obsolete-session cleanup failure produces.
    const current = new FakeAdapter('claude');
    let releaseStop: (() => void) | undefined;
    let stopAllCalls = 0;
    // Only the FIRST stop is deferred. A second one (which is the defect
    // this guard exists to catch) resolves immediately, so the failure
    // surfaces as the call-count assertion below rather than as a deadline
    // timeout that never reaches it (review L1).
    current.stopAll.mockImplementation(() => {
      stopAllCalls += 1;
      if (stopAllCalls > 1) return Promise.resolve();
      return new Promise<void>((resolve) => {
        releaseStop = resolve;
      });
    });
    const bounded = new OrchestrationService({
      adapterRegistry: createRegistry([current]),
      eventBus,
      eventStore,
      adapterStopTimeoutMs: 2_000,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    bounded.initialize();

    // Retire it WITHOUT replacing it: the adapter stays current.
    (
      bounded as unknown as {
        adapterRetirement: {
          retire(adapter: ProviderAdapterShape): void;
        };
      }
    ).adapterRetirement.retire(current);
    await vi.waitFor(() => expect(current.stopAll).toHaveBeenCalledOnce());

    const shutdown = bounded.shutdown();
    releaseStop?.();
    await shutdown;

    // Once, not twice: the retirement drain owns this adapter, and the
    // current-adapter arm must skip it.
    expect(current.stopAll).toHaveBeenCalledOnce();
  });

  test('retries a settled replacement cleanup failure during shutdown', async () => {
    const retired = new FakeAdapter('claude');
    retired.stopAll
      .mockRejectedValueOnce(new Error('first cleanup failed'))
      .mockImplementationOnce(async () => retired.sessions.clear());
    const registry = createReplaceableRegistry([retired]);
    const retryingService = new OrchestrationService({
      adapterRegistry: registry,
      eventBus,
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    await retryingService.dispatch({
      type: 'startSession',
      input: {
        threadId: 'retry-retirement',
        provider: 'claude',
        modelId: 'claude-sonnet',
      },
    });

    registry.register(new FakeAdapter('claude'));
    await vi.waitFor(() => expect(retired.stopAll).toHaveBeenCalledOnce());
    await retryingService.shutdown();

    expect(retired.stopAll).toHaveBeenCalledTimes(2);
    expect(
      eventStore
        .readSessions()
        .find((session) => session.threadId === 'retry-retirement')?.status,
    ).toBe('closed');
  });

  test('does not confirm provider replacement while adapter retirement is unresolved', async () => {
    const retired = new FakeAdapter('claude');
    retired.stopAll.mockRejectedValue(new Error('cleanup failed'));
    const registry = createReplaceableRegistry([retired]);
    const guardedService = new OrchestrationService({
      adapterRegistry: registry,
      eventBus,
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    guardedService.initialize();

    registry.register(new FakeAdapter('claude'));
    await vi.waitFor(() => expect(retired.stopAll).toHaveBeenCalledOnce());

    await expect(
      guardedService.settleProviderAdapterRetirements(),
    ).rejects.toThrow('retirement was not confirmed');
    retired.stopAll.mockResolvedValue(undefined);
    await guardedService.shutdown();
  });

  test('completes one smoke turn and deletes its ephemeral session artifacts', async () => {
    claude.sendTurn.mockImplementationOnce(async (input) => {
      const turnId = 'claude-smoke-turn';
      queueMicrotask(() =>
        claude.events.push({
          eventId: 'claude-smoke-complete',
          provider: 'claude',
          threadId: input.threadId,
          turnId,
          createdAt: new Date().toISOString(),
          method: 'turn.completed',
          finishReason: 'stop',
          outputText: 'STATION_SMOKE_OK',
        }),
      );
      return { threadId: input.threadId, turnId };
    });

    const result = await service.runConnectionSmoke({
      connectionId: 'claude',
      provider: 'claude',
      modelId: 'claude-sonnet',
      cwd: tmp,
      timeoutMs: 1_000,
    });

    expect(result).toMatchObject({
      ok: true,
      model: 'claude-sonnet',
    });
    expect(claude.sendTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.stringContaining('STATION_SMOKE_OK'),
        modelId: 'claude-sonnet',
      }),
    );
    expect(claude.stopSession).toHaveBeenCalledTimes(1);
    expect(claude.sessions.size).toBe(0);
    expect(eventStore.readSessions()).toEqual([]);
    expect(eventStore.listEvents()).toEqual([]);
    expect(eventStore.listCommandReceipts()).toEqual([]);
  });

  test('a completed smoke invalidates its thread in the session-owner cache (slice 9 I4 guard)', async () => {
    // The cleanup pair at the smoke's tail is deleteThread THEN
    // invalidateSessionOwner. The delete had three observers; the owner
    // invalidation had NONE anywhere in the suite (plan injection I4 ran
    // green with the dep a no-op) — a stale positive owner for a recycled
    // smoke thread id would authorize reads against a thread that no
    // longer exists.
    const internals = service as unknown as {
      sessionAuthz: { invalidateSessionOwner(threadId: string): boolean };
    };
    const invalidate = vi.spyOn(
      internals.sessionAuthz,
      'invalidateSessionOwner',
    );
    const deleteSpy = vi.spyOn(eventStore, 'deleteThread');
    claude.sendTurn.mockImplementationOnce(async (input) => {
      const turnId = 'claude-smoke-owner-turn';
      queueMicrotask(() =>
        claude.events.push({
          eventId: 'claude-smoke-owner-complete',
          provider: 'claude',
          threadId: input.threadId,
          turnId,
          createdAt: new Date().toISOString(),
          method: 'turn.completed',
          finishReason: 'stop',
          outputText: 'STATION_SMOKE_OK',
        }),
      );
      return { threadId: input.threadId, turnId };
    });

    const result = await service.runConnectionSmoke({
      connectionId: 'claude',
      provider: 'claude',
      modelId: 'claude-sonnet',
      cwd: tmp,
      timeoutMs: 1_000,
    });
    expect(result).toMatchObject({ ok: true });
    const smokeCalls = invalidate.mock.calls.filter(([threadId]) =>
      String(threadId).startsWith('station-smoke-claude-'),
    );
    // >= 1, not === 1: publishCanonicalEvent ALSO invalidates on
    // session.started/configured (a real adapter emits those), and pinning
    // an exact count would false-pass a dropped tail invalidation the
    // moment the fixture grows one (review round 1). The ORDERING pin
    // below is what proves the tail pair: the smoke's own invalidation
    // runs after its deleteThread.
    expect(smokeCalls.length).toBeGreaterThanOrEqual(1);
    const smokeDelete = deleteSpy.mock.calls.findIndex(([threadId]) =>
      String(threadId).startsWith('station-smoke-claude-'),
    );
    expect(smokeDelete).toBeGreaterThanOrEqual(0);
    const lastInvalidate = invalidate.mock.invocationCallOrder.at(-1);
    const smokeDeleteOrder = deleteSpy.mock.invocationCallOrder[smokeDelete];
    expect(lastInvalidate).toBeGreaterThan(smokeDeleteOrder ?? Infinity);
    deleteSpy.mockRestore();
    invalidate.mockRestore();
  });

  test('accepts the required smoke response after outer whitespace is trimmed', async () => {
    claude.sendTurn.mockImplementationOnce(async (input) => {
      const turnId = 'claude-whitespace-smoke-turn';
      queueMicrotask(() =>
        claude.events.push({
          eventId: 'claude-whitespace-smoke-complete',
          provider: 'claude',
          threadId: input.threadId,
          turnId,
          createdAt: new Date().toISOString(),
          method: 'turn.completed',
          finishReason: 'stop',
          outputText: ' \n STATION_SMOKE_OK \t ',
        }),
      );
      return { threadId: input.threadId, turnId };
    });

    await expect(
      service.runConnectionSmoke({
        connectionId: 'claude',
        provider: 'claude',
        cwd: tmp,
        // The assertion is about reasoning-only content classification, not a
        // one-second latency SLA. The complete related corpus can delay this
        // synthetic event loop on a two-core runner, so retain a bounded but
        // non-racy operation window.
        timeoutMs: 5_000,
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  test('preserves the typed empty-response failure without retaining output', async () => {
    claude.sendTurn.mockImplementationOnce(async (input) => {
      const turnId = 'claude-empty-smoke-turn';
      queueMicrotask(() =>
        claude.events.push({
          eventId: 'claude-empty-smoke-complete',
          provider: 'claude',
          threadId: input.threadId,
          turnId,
          createdAt: new Date().toISOString(),
          method: 'turn.completed',
          finishReason: 'stop',
          outputText: '',
        }),
      );
      return { threadId: input.threadId, turnId };
    });

    await expect(
      service.runConnectionSmoke({
        connectionId: 'claude',
        provider: 'claude',
        cwd: tmp,
        timeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reasonCode: 'empty-response',
      reason: 'The smoke turn completed without an assistant response.',
      action:
        'Check the selected model and runtime logs, then run the smoke again.',
    });
  });

  test('rejects cross-tenant hosted adoption before reservation/fork and passes the matching tenant through ALS', async () => {
    const sourceThreadId = 'external:claude:tenant-adoption';
    const projectRoot = join(tmp, 'tenant-adoption-project');
    const nestedCwd = join(projectRoot, 'packages', 'app');
    const alpha = { tenantId: 'alpha' as any, source: 'request' as const };
    mkdirSync(nestedCwd, { recursive: true });
    installStationDeliveryFlow(projectRoot);
    configuredProjects.push({ slug: 'project', workingDirectory: projectRoot });
    eventStore.upsertSession({
      provider: 'claude',
      threadId: sourceThreadId,
      status: 'ready',
      cwd: nestedCwd,
      controlMode: 'read-only-attached',
      attachedSource: {
        kind: 'claude-transcript',
        externalSessionId: 'vendor-tenant-adoption',
      },
      tenantExecutionContext: alpha,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    });

    await expect(
      service.dispatch(
        { type: 'adoptSession', sourceThreadId },
        {
          tenantExecutionContext: {
            tenantId: 'bravo' as any,
            source: 'request',
          },
        },
      ),
    ).rejects.toThrow('Tenant execution context does not match session');
    expect(claude.adoptSession).not.toHaveBeenCalled();
    expect(adoptionLedger.reservations()).toEqual([]);

    const defaultAdopt = claude.adoptSession.getMockImplementation()!;
    let adapterContext: unknown;
    claude.adoptSession.mockImplementation(async (input, hooks) => {
      adapterContext = currentTenantExecutionContext();
      return defaultAdopt(input, hooks);
    });
    await service.dispatch(
      { type: 'adoptSession', sourceThreadId },
      { tenantExecutionContext: alpha },
    );
    expect(claude.adoptSession).toHaveBeenCalledWith(
      expect.objectContaining({ tenantExecutionContext: alpha }),
      expect.anything(),
    );
    expect(adapterContext).toEqual({ tenantId: 'alpha', source: 'request' });
  });

  test('validates idempotent hosted adoption against the request tenant before returning a receipt', async () => {
    const sourceThreadId = 'external:claude:tenant-idempotent-adoption';
    const projectRoot = join(tmp, 'tenant-idempotent-adoption-project');
    const alpha = { tenantId: 'alpha' as any, source: 'request' as const };
    mkdirSync(projectRoot, { recursive: true });
    installStationDeliveryFlow(projectRoot);
    configuredProjects.push({ slug: 'project', workingDirectory: projectRoot });
    eventStore.upsertSession({
      provider: 'claude',
      threadId: sourceThreadId,
      status: 'ready',
      cwd: projectRoot,
      controlMode: 'read-only-attached',
      attachedSource: {
        kind: 'claude-transcript',
        externalSessionId: 'vendor-tenant-idempotent',
      },
      tenantExecutionContext: alpha,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    });
    eventStore.appendEvent({
      eventId: 'tenant-idempotent-owner',
      provider: 'claude',
      threadId: sourceThreadId,
      createdAt: '2026-08-01T00:00:00.000Z',
      method: 'session.configured',
      sessionId: sourceThreadId,
      metadata: { userId: 'adopter-user' },
    } as CanonicalRuntimeEvent);
    const first = await service.dispatchWithReceipt(
      { type: 'adoptSession', sourceThreadId },
      { userId: 'adopter-user', tenantExecutionContext: alpha },
    );
    if (!first.result) throw new Error('expected adopted session');
    eventStore.appendEvent({
      eventId: 'tenant-idempotent-child-owner',
      provider: 'claude',
      threadId: first.result.threadId,
      createdAt: '2026-08-01T00:00:01.000Z',
      method: 'session.configured',
      sessionId: first.result.threadId,
      metadata: { userId: 'adopter-user' },
    } as CanonicalRuntimeEvent);
    const hosted = new OrchestrationService({
      adapterRegistry: createRegistry([bedrock, claude]),
      eventBus,
      eventStore,
      flowRunService,
      listProjects: () => configuredProjects,
      requireTenantExecutionContext: () => true,
      validateRecoveredTenantExecutionContext: (context) =>
        context?.tenantId === alpha.tenantId ? context : undefined,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });

    await expect(
      hosted.dispatchWithReceipt(
        { type: 'adoptSession', sourceThreadId },
        { userId: 'adopter-user', tenantExecutionContext: alpha },
      ),
    ).resolves.toMatchObject({ result: first.result });
    expect(claude.adoptSession).toHaveBeenCalledOnce();

    const acceptedReceiptsBeforeRejections = eventStore
      .listCommandReceipts(sourceThreadId)
      .filter((receipt) => receipt.status === 'accepted').length;
    await expect(
      hosted.dispatchWithReceipt({ type: 'adoptSession', sourceThreadId }),
    ).rejects.toThrow('Attached session not found');
    await expect(
      hosted.dispatchWithReceipt(
        { type: 'adoptSession', sourceThreadId },
        {
          userId: 'adopter-user',
          tenantExecutionContext: {
            tenantId: 'bravo' as any,
            source: 'request',
          },
        },
      ),
    ).rejects.toThrow('Tenant execution context does not match session');
    expect(
      eventStore
        .listCommandReceipts(sourceThreadId)
        .filter((receipt) => receipt.status === 'accepted'),
    ).toHaveLength(acceptedReceiptsBeforeRejections);
    expect(claude.adoptSession).toHaveBeenCalledOnce();
  });

  test.each([
    ['prefixed response', 'Confirmed: STATION_SMOKE_OK'],
    ['suffixed response', 'STATION_SMOKE_OK confirmed'],
    ['markdown-wrapped response', '**STATION_SMOKE_OK**'],
    ['markdown-fenced response', '```text\nSTATION_SMOKE_OK\n```'],
    ['unrelated response', 'The connection appears to be healthy.'],
  ])(
    'rejects an %s without retaining assistant output',
    async (_, outputText) => {
      claude.sendTurn.mockImplementationOnce(async (input) => {
        const turnId = 'claude-unexpected-smoke-turn';
        queueMicrotask(() =>
          claude.events.push({
            eventId: 'claude-unexpected-smoke-complete',
            provider: 'claude',
            threadId: input.threadId,
            turnId,
            createdAt: new Date().toISOString(),
            method: 'turn.completed',
            finishReason: 'stop',
            outputText,
          }),
        );
        return { threadId: input.threadId, turnId };
      });

      const result = await service.runConnectionSmoke({
        connectionId: 'claude',
        provider: 'claude',
        cwd: tmp,
        timeoutMs: 1_000,
      });

      expect(result).toMatchObject({
        ok: false,
        reasonCode: 'unexpected-response',
        reason:
          'The assistant response did not exactly match the required smoke confirmation.',
        action:
          'Check the selected model or runtime instructions, then run the explicit smoke again.',
      });
      if (result.ok)
        throw new Error('Expected the smoke response to be rejected');
      if (outputText) expect(result.reason).not.toContain(outputText);
    },
  );

  test('uses exact projected assistant output when the completion omits output text', async () => {
    claude.sendTurn.mockImplementationOnce(async (input) => {
      const turnId = 'claude-projected-smoke-turn';
      queueMicrotask(() => {
        claude.events.push({
          eventId: 'claude-projected-smoke-delta',
          provider: 'claude',
          threadId: input.threadId,
          turnId,
          createdAt: new Date().toISOString(),
          method: 'content.text-delta',
          itemId: 'claude-projected-smoke-item',
          delta: 'STATION_SMOKE_OK',
        });
        claude.events.push({
          eventId: 'claude-projected-smoke-complete',
          provider: 'claude',
          threadId: input.threadId,
          turnId,
          createdAt: new Date().toISOString(),
          method: 'turn.completed',
          finishReason: 'stop',
        });
      });
      return { threadId: input.threadId, turnId };
    });

    await expect(
      service.runConnectionSmoke({
        connectionId: 'claude',
        provider: 'claude',
        cwd: tmp,
        timeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  test('rejects an exact terminal smoke response when canonical streamed output contradicts it', async () => {
    claude.sendTurn.mockImplementationOnce(async (input) => {
      const turnId = 'claude-contradictory-smoke-turn';
      queueMicrotask(() => {
        claude.events.push({
          eventId: 'claude-contradictory-smoke-delta',
          provider: 'claude',
          threadId: input.threadId,
          turnId,
          createdAt: new Date().toISOString(),
          method: 'content.text-delta',
          itemId: 'claude-contradictory-smoke-item',
          delta: 'not the required confirmation',
        });
        claude.events.push({
          eventId: 'claude-contradictory-smoke-complete',
          provider: 'claude',
          threadId: input.threadId,
          turnId,
          createdAt: new Date().toISOString(),
          method: 'turn.completed',
          finishReason: 'stop',
          outputText: 'STATION_SMOKE_OK',
        });
      });
      return { threadId: input.threadId, turnId };
    });

    await expect(
      service.runConnectionSmoke({
        connectionId: 'claude',
        provider: 'claude',
        cwd: tmp,
        timeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reasonCode: 'unexpected-response',
    });
  });

  test('does not let terminal output override whitespace-only canonical text', async () => {
    claude.sendTurn.mockImplementationOnce(async (input) => {
      const turnId = 'claude-whitespace-contradiction-smoke-turn';
      queueMicrotask(() => {
        claude.events.push({
          eventId: 'claude-whitespace-contradiction-smoke-delta',
          provider: 'claude',
          threadId: input.threadId,
          turnId,
          createdAt: new Date().toISOString(),
          method: 'content.text-delta',
          itemId: 'claude-whitespace-contradiction-smoke-item',
          delta: ' \n\t ',
        });
        claude.events.push({
          eventId: 'claude-whitespace-contradiction-smoke-complete',
          provider: 'claude',
          threadId: input.threadId,
          turnId,
          createdAt: new Date().toISOString(),
          method: 'turn.completed',
          finishReason: 'stop',
          outputText: 'STATION_SMOKE_OK',
        });
      });
      return { threadId: input.threadId, turnId };
    });

    await expect(
      service.runConnectionSmoke({
        connectionId: 'claude',
        provider: 'claude',
        cwd: tmp,
        timeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({ ok: false, reasonCode: 'empty-response' });
  });

  test('does not count reasoning-only smoke content as a visible response', async () => {
    claude.sendTurn.mockImplementationOnce(async (input) => {
      const turnId = 'claude-reasoning-only-smoke-turn';
      queueMicrotask(() => {
        claude.events.push({
          eventId: 'claude-reasoning-only-smoke-delta',
          provider: 'claude',
          threadId: input.threadId,
          turnId,
          createdAt: new Date().toISOString(),
          method: 'content.reasoning-delta',
          itemId: 'claude-reasoning-only-smoke-item',
          delta: 'STATION_SMOKE_OK',
        });
        claude.events.push({
          eventId: 'claude-reasoning-only-smoke-complete',
          provider: 'claude',
          threadId: input.threadId,
          turnId,
          createdAt: new Date().toISOString(),
          method: 'turn.completed',
          finishReason: 'stop',
        });
      });
      return { threadId: input.threadId, turnId };
    });

    await expect(
      service.runConnectionSmoke({
        connectionId: 'claude',
        provider: 'claude',
        cwd: tmp,
        timeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({ ok: false, reasonCode: 'empty-response' });
  });

  test('accepts canonical visible text when it follows reasoning content', async () => {
    claude.sendTurn.mockImplementationOnce(async (input) => {
      const turnId = 'claude-reasoning-and-text-smoke-turn';
      queueMicrotask(() => {
        claude.events.push({
          eventId: 'claude-reasoning-and-text-smoke-reasoning',
          provider: 'claude',
          threadId: input.threadId,
          turnId,
          createdAt: new Date().toISOString(),
          method: 'content.reasoning-delta',
          itemId: 'claude-reasoning-and-text-smoke-item',
          delta: 'I will provide the required confirmation.',
        });
        claude.events.push({
          eventId: 'claude-reasoning-and-text-smoke-text',
          provider: 'claude',
          threadId: input.threadId,
          turnId,
          createdAt: new Date().toISOString(),
          method: 'content.text-delta',
          itemId: 'claude-reasoning-and-text-smoke-item',
          delta: 'STATION_SMOKE_OK',
        });
        claude.events.push({
          eventId: 'claude-reasoning-and-text-smoke-complete',
          provider: 'claude',
          threadId: input.threadId,
          turnId,
          createdAt: new Date().toISOString(),
          method: 'turn.completed',
          finishReason: 'stop',
        });
      });
      return { threadId: input.threadId, turnId };
    });

    await expect(
      service.runConnectionSmoke({
        connectionId: 'claude',
        provider: 'claude',
        cwd: tmp,
        timeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  test('times out a silent smoke without leaving a live or persisted session', async () => {
    claude.sendTurn.mockImplementationOnce(async (input) => {
      queueMicrotask(() => {
        claude.events.push({
          eventId: 'silent-smoke-started',
          provider: 'claude',
          threadId: input.threadId,
          turnId: 'silent-smoke-turn',
          createdAt: new Date().toISOString(),
          method: 'turn.started',
          prompt: input.input,
        });
      });
      return { threadId: input.threadId, turnId: 'silent-smoke-turn' };
    });
    const result = await service.runConnectionSmoke({
      connectionId: 'claude',
      provider: 'claude',
      modelId: 'claude-sonnet',
      cwd: tmp,
      timeoutMs: 20,
    });

    expect(result).toMatchObject({ ok: false, reasonCode: 'timeout' });
    expect(claude.sessions.size).toBe(0);
    expect(eventStore.readSessions()).toEqual([]);
    expect(eventStore.listEvents()).toEqual([]);
    expect(eventStore.listCommandReceipts()).toEqual([]);
    expect(claude.interruptTurn).not.toHaveBeenCalled();
    expect(claude.stopSession).toHaveBeenCalledOnce();
  });

  /**
   * archive#3525: a connection smoke's turn is never a user conversation —
   * it exists only to prove connectivity — so its own diagnostic timeout
   * ending the turn mid-flight must not be able to push "your agent needs
   * attention" (nothing keys suppression on the `stationSmoke` metadata
   * marker or any thread-id prefix, so this proves the actual mechanism:
   * `InternalStopSuppression.arm` reads the open turn id from durable
   * projection before the timeout's `stopSession` dispatch tears it down).
   */
  test('arms internal-stop suppression for a smoke turn that times out mid-flight', async () => {
    claude.sendTurn.mockImplementationOnce(async (input) => {
      queueMicrotask(() => {
        claude.events.push({
          eventId: 'suppressed-smoke-started',
          provider: 'claude',
          threadId: input.threadId,
          turnId: 'suppressed-smoke-turn',
          createdAt: new Date().toISOString(),
          method: 'turn.started',
          prompt: input.input,
        });
      });
      return { threadId: input.threadId, turnId: 'suppressed-smoke-turn' };
    });
    const result = await service.runConnectionSmoke({
      connectionId: 'claude',
      provider: 'claude',
      modelId: 'claude-sonnet',
      cwd: tmp,
      timeoutMs: 20,
    });

    expect(result).toMatchObject({ ok: false, reasonCode: 'timeout' });
    expect(claude.stopSession).toHaveBeenCalledOnce();
    expect(
      service.consumeInternalStopSuppression('suppressed-smoke-turn'),
    ).toBe(true);
  });

  test('bounds a smoke whose session startup never acknowledges', async () => {
    claude.startSession.mockImplementationOnce(
      () => new Promise<ProviderSession>(() => {}),
    );
    const boundedService = new OrchestrationService({
      adapterRegistry: createRegistry([bedrock, claude]),
      eventBus,
      eventStore,
      adapterStopTimeoutMs: 10,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });

    const result = await boundedService.runConnectionSmoke({
      connectionId: 'claude',
      provider: 'claude',
      modelId: 'claude-sonnet',
      cwd: tmp,
      timeoutMs: 20,
    });

    expect(result).toMatchObject({ ok: false, reasonCode: 'cleanup-failed' });
    expect(eventStore.readSessions()).toEqual([]);
  });

  test('bounds a smoke whose turn startup never acknowledges and cleans its session', async () => {
    claude.sendTurn.mockImplementationOnce(
      () => new Promise<ProviderTurnStartResult>(() => {}),
    );

    const result = await service.runConnectionSmoke({
      connectionId: 'claude',
      provider: 'claude',
      modelId: 'claude-sonnet',
      cwd: tmp,
      timeoutMs: 20,
    });

    expect(result).toMatchObject({ ok: false, reasonCode: 'timeout' });
    expect(claude.sessions.size).toBe(0);
    expect(eventStore.readSessions()).toEqual([]);
  });

  test('restarts adapter event consumption after a bounded queue overflow', async () => {
    const events = new AsyncEventQueue<CanonicalRuntimeEvent>(1);
    (claude as any).events = events;
    const warn = vi.fn();
    const isolated = new OrchestrationService({
      adapterRegistry: createRegistry([claude]),
      eventBus,
      eventStore,
      logger: { debug: vi.fn(), warn },
    });
    isolated.initialize();
    await isolated.dispatch({
      type: 'startSession',
      input: {
        threadId: 'overflow-thread',
        provider: 'claude',
        modelId: 'claude-sonnet',
      },
    });
    const runtimeEvent = (eventId: string): CanonicalRuntimeEvent =>
      ({
        eventId,
        provider: 'claude',
        threadId: 'overflow-thread',
        createdAt: new Date().toISOString(),
        method: 'content.text-delta',
        itemId: eventId,
        delta: eventId,
      }) as CanonicalRuntimeEvent;

    expect(events.push(runtimeEvent('before-overflow-1'))).toBe(true);
    expect(events.push(runtimeEvent('before-overflow-2'))).toBe(true);
    expect(events.push(runtimeEvent('before-overflow-3'))).toBe(false);
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        'Provider adapter event stream stopped',
        expect.objectContaining({ provider: 'claude' }),
      ),
    );
    expect(
      eventStore
        .listEvents('overflow-thread')
        .map((event) => event.payload)
        .find((event) => event.method === 'runtime.error'),
    ).toMatchObject({ retriable: true });

    expect(events.push(runtimeEvent('after-overflow'))).toBe(true);
    await vi.waitFor(() =>
      expect(
        eventStore
          .listEvents('overflow-thread')
          .some((event) => event.payload.eventId === 'after-overflow'),
      ).toBe(true),
    );

    expect(events.push(runtimeEvent('second-overflow-1'))).toBe(true);
    expect(events.push(runtimeEvent('second-overflow-2'))).toBe(true);
    expect(events.push(runtimeEvent('second-overflow-3'))).toBe(false);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(2));
    expect(events.push(runtimeEvent('after-second-overflow'))).toBe(true);
    await vi.waitFor(() =>
      expect(
        eventStore
          .listEvents('overflow-thread')
          .some((event) => event.payload.eventId === 'after-second-overflow'),
      ).toBe(true),
    );
    await isolated.shutdown();
  });

  // archive#3304: a SQLITE_BUSY from the stream loop's own event-store work
  // rendered as "Agent connection error: database is locked" — a mislabel:
  // the agent connection was fine and our own store was locked, typically by
  // another Station process using the same home.
  test('names the event store, not the agent connection, when the stream loop hits SQLITE_BUSY', async () => {
    const events = new AsyncEventQueue<CanonicalRuntimeEvent>(16);
    (claude as any).events = events;
    const warn = vi.fn();
    const isolated = new OrchestrationService({
      adapterRegistry: createRegistry([claude]),
      eventBus,
      eventStore,
      logger: { debug: vi.fn(), warn },
    });
    isolated.initialize();
    await isolated.dispatch({
      type: 'startSession',
      input: {
        threadId: 'store-busy-thread',
        provider: 'claude',
        modelId: 'claude-sonnet',
      },
    });
    const runtimeEvent = (eventId: string): CanonicalRuntimeEvent =>
      ({
        eventId,
        provider: 'claude',
        threadId: 'store-busy-thread',
        createdAt: new Date().toISOString(),
        method: 'content.text-delta',
        itemId: eventId,
        delta: eventId,
      }) as CanonicalRuntimeEvent;

    // The real node:sqlite BUSY shape.
    vi.spyOn(eventStore, 'listSessionProjectionEvents').mockImplementationOnce(
      () => {
        throw Object.assign(new Error('database is locked'), {
          errcode: 5,
          code: 'ERR_SQLITE_ERROR',
        });
      },
    );
    expect(events.push(runtimeEvent('busy-victim'))).toBe(true);
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        'Provider adapter event stream stopped',
        expect.objectContaining({ provider: 'claude' }),
      ),
    );
    const contentionError = eventStore
      .listEvents('store-busy-thread')
      .map((event) => event.payload)
      .find((event) => event.method === 'runtime.error');
    expect(contentionError).toMatchObject({ retriable: true });
    expect((contentionError as { message?: string })?.message).toContain(
      'Orchestration event store is locked (orchestration.sqlite)',
    );
    expect((contentionError as { message?: string })?.message).toContain(
      'another Station process may be using this Station home',
    );
    expect((contentionError as { message?: string })?.message).not.toContain(
      'Agent connection error',
    );
    expect(orchestrationStoreContentionObserved.add).toHaveBeenCalledWith(1, {
      site: 'adapter-event-stream',
    });

    // errcode-only discrimination: a message the fallback regex misses must
    // still classify as contention through the errcode === 5 branch.
    vi.spyOn(eventStore, 'listSessionProjectionEvents').mockImplementationOnce(
      () => {
        throw Object.assign(new Error('busy handler declined to wait'), {
          errcode: 5,
          code: 'ERR_SQLITE_ERROR',
        });
      },
    );
    expect(events.push(runtimeEvent('errcode-victim'))).toBe(true);
    await vi.waitFor(() =>
      expect(
        eventStore
          .listEvents('store-busy-thread')
          .map((event) => event.payload)
          .filter((event) => event.method === 'runtime.error'),
      ).toHaveLength(2),
    );
    const errcodeOnlyError = eventStore
      .listEvents('store-busy-thread')
      .map((event) => event.payload)
      .filter((event) => event.method === 'runtime.error')
      .at(-1);
    expect((errcodeOnlyError as { message?: string })?.message).toContain(
      'Orchestration event store is locked (orchestration.sqlite)',
    );

    // Control: a non-BUSY stream failure keeps the agent-connection wording.
    vi.spyOn(eventStore, 'listSessionProjectionEvents').mockImplementationOnce(
      () => {
        throw new Error('adapter stream exploded');
      },
    );
    expect(events.push(runtimeEvent('generic-victim'))).toBe(true);
    await vi.waitFor(() =>
      expect(
        eventStore
          .listEvents('store-busy-thread')
          .map((event) => event.payload)
          .filter((event) => event.method === 'runtime.error'),
      ).toHaveLength(3),
    );
    const genericError = eventStore
      .listEvents('store-busy-thread')
      .map((event) => event.payload)
      .filter((event) => event.method === 'runtime.error')
      .at(-1);
    expect((genericError as { message?: string })?.message).toBe(
      'Agent connection error: adapter stream exploded',
    );
    await isolated.shutdown();
  });

  // Fix-round finding on archive#3304: the per-thread surfacing publish
  // writes to the SAME locked store. Under sustained BUSY it threw inside
  // the catch, escaped via the fire-and-forget consumption call, and the
  // remaining threads never received their runtime.error.
  test('one thread failing to surface a stream failure does not silence the other threads', async () => {
    const events = new AsyncEventQueue<CanonicalRuntimeEvent>(16);
    (claude as any).events = events;
    const warn = vi.fn();
    const unhandled: unknown[] = [];
    const captureUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', captureUnhandled);
    try {
      const isolated = new OrchestrationService({
        adapterRegistry: createRegistry([claude]),
        eventBus,
        eventStore,
        logger: { debug: vi.fn(), warn },
      });
      isolated.initialize();
      await isolated.dispatch({
        type: 'startSession',
        input: {
          threadId: 'surfacing-blocked-thread',
          provider: 'claude',
          modelId: 'claude-sonnet',
        },
      });
      await isolated.dispatch({
        type: 'startSession',
        input: {
          threadId: 'surfacing-healthy-thread',
          provider: 'claude',
          modelId: 'claude-sonnet',
        },
      });
      vi.spyOn(
        eventStore,
        'listSessionProjectionEvents',
      ).mockImplementationOnce(() => {
        throw Object.assign(new Error('database is locked'), { errcode: 5 });
      });
      const appendEvent = eventStore.appendEvent.bind(eventStore);
      const appendSpy = vi
        .spyOn(eventStore, 'appendEvent')
        .mockImplementation((event) => {
          if (
            event.method === 'runtime.error' &&
            event.threadId === 'surfacing-blocked-thread'
          ) {
            throw Object.assign(new Error('database is locked'), {
              errcode: 5,
            });
          }
          return appendEvent(event);
        });
      expect(
        events.push({
          eventId: 'busy-trigger',
          provider: 'claude',
          threadId: 'surfacing-blocked-thread',
          createdAt: new Date().toISOString(),
          method: 'content.text-delta',
          itemId: 'busy-trigger',
          delta: 'x',
        } as CanonicalRuntimeEvent),
      ).toBe(true);
      await vi.waitFor(() =>
        expect(warn).toHaveBeenCalledWith(
          'Failed to surface adapter stream failure to thread',
          expect.objectContaining({
            provider: 'claude',
            threadId: 'surfacing-blocked-thread',
            error: 'database is locked',
          }),
        ),
      );
      await vi.waitFor(() =>
        expect(
          eventStore
            .listEvents('surfacing-healthy-thread')
            .map((event) => event.payload)
            .filter((event) => event.method === 'runtime.error'),
        ).toHaveLength(1),
      );
      const healthyError = eventStore
        .listEvents('surfacing-healthy-thread')
        .map((event) => event.payload)
        .find((event) => event.method === 'runtime.error');
      expect((healthyError as { message?: string })?.message).toContain(
        'Orchestration event store is locked (orchestration.sqlite)',
      );
      appendSpy.mockRestore();
      // Give the escaped-rejection path a tick before asserting silence.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
      await isolated.shutdown();
    } finally {
      process.off('unhandledRejection', captureUnhandled);
    }
  });

  test('stops a smoke session when startup fails after adapter ownership is tracked', async () => {
    vi.spyOn(eventStore, 'upsertSession').mockImplementationOnce(() => {
      throw new Error('persistence unavailable');
    });

    const result = await service.runConnectionSmoke({
      connectionId: 'claude',
      provider: 'claude',
      modelId: 'claude-sonnet',
      cwd: tmp,
      timeoutMs: 20,
    });

    expect(result).toMatchObject({ ok: false, reasonCode: 'start-failed' });
    expect(claude.stopSession).toHaveBeenCalledTimes(1);
    expect(claude.sessions.size).toBe(0);
    expect(eventStore.readSessions()).toEqual([]);
    expect(eventStore.listEvents()).toEqual([]);
    expect(eventStore.listCommandReceipts()).toEqual([]);
  });

  test('keeps a failed-cleanup smoke visible instead of hiding a live session', async () => {
    claude.stopSession.mockRejectedValueOnce(new Error('stop failed'));

    await expect(
      service.runConnectionSmoke({
        connectionId: 'claude',
        provider: 'claude',
        modelId: 'claude-sonnet',
        cwd: tmp,
        timeoutMs: 20,
      }),
    ).resolves.toMatchObject({ ok: false, reasonCode: 'cleanup-failed' });

    expect(claude.sessions.size).toBe(1);
    expect(eventStore.readSessions()).toHaveLength(1);
    expect(eventStore.listCommandReceipts()).not.toEqual([]);
  });

  test('shares one bounded cleanup grace between ownership detection and cleanup', async () => {
    claude.startSession.mockImplementationOnce((input) => {
      const now = new Date().toISOString();
      claude.sessions.set(input.threadId, {
        provider: 'claude',
        threadId: input.threadId,
        status: 'ready',
        createdAt: now,
        updatedAt: now,
      });
      return new Promise<ProviderSession>(() => {});
    });
    vi.spyOn(claude, 'hasSession').mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 8));
      return true;
    });
    claude.stopSession.mockImplementationOnce(
      () => new Promise<void>(() => {}),
    );
    const boundedService = new OrchestrationService({
      adapterRegistry: createRegistry([bedrock, claude]),
      eventBus,
      eventStore,
      adapterStopTimeoutMs: 10,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });

    const result = await boundedService.runConnectionSmoke({
      connectionId: 'claude',
      provider: 'claude',
      modelId: 'claude-sonnet',
      cwd: tmp,
      timeoutMs: 20,
    });

    expect(result).toMatchObject({ ok: false, reasonCode: 'cleanup-failed' });
    expect(result.durationMs).toBeGreaterThanOrEqual(20);
    expect(result.durationMs).toBeLessThan(100);
    expect(claude.stopSession).toHaveBeenCalledOnce();
  });

  test('arms internal-stop suppression when a timed-out smoke is cleaned through adapter ownership (slice 9 I6 guard)', async () => {
    // The SECOND arm site — the adapter-owns-timed-out branch — had no
    // observer (plan injection I6 ran green with the call deleted): no
    // fixture put an open turn in the fold on that branch, because
    // startSession never resolves there so the smoke itself dispatches no
    // turn. This fixture has the adapter register the session AND emit
    // turn.started for the captured smoke threadId before hanging, so the
    // arm can resolve an open turn — then proves armed-and-never-rescinded
    // exactly as the mid-flight test does for the first site.
    let smokeThreadId = '';
    claude.startSession.mockImplementationOnce((input) => {
      const now = new Date().toISOString();
      smokeThreadId = input.threadId;
      claude.sessions.set(input.threadId, {
        provider: 'claude',
        threadId: input.threadId,
        status: 'ready',
        createdAt: now,
        updatedAt: now,
      });
      eventStore.appendEvent({
        eventId: 'smoke-owns-turn-started',
        provider: 'claude',
        threadId: input.threadId,
        turnId: 'smoke-owns-open-turn',
        createdAt: now,
        method: 'turn.started',
        prompt: 'smoke',
      });
      return new Promise<ProviderSession>(() => {});
    });
    vi.spyOn(claude, 'hasSession').mockImplementation(async () => true);
    claude.stopSession.mockImplementationOnce(async (stoppedThreadId) => {
      claude.sessions.delete(stoppedThreadId);
    });
    const armService = new OrchestrationService({
      adapterRegistry: createRegistry([bedrock, claude]),
      eventBus,
      eventStore,
      adapterStopTimeoutMs: 50,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });

    await armService.runConnectionSmoke({
      connectionId: 'claude',
      provider: 'claude',
      modelId: 'claude-sonnet',
      cwd: tmp,
      timeoutMs: 20,
    });
    expect(smokeThreadId).not.toBe('');
    // Pin that BRANCH 2 armed it: `hasSession` is called only on the
    // adapter-owns branch inside this method — without this, the assertion
    // below is satisfiable by the first arm site too (review round 1).
    expect(claude.hasSession).toHaveBeenCalled();
    expect(
      armService.consumeInternalStopSuppression('smoke-owns-open-turn'),
    ).toBe(true);
    await armService.shutdown();
  });

  test('reports cleanup failure when startup can acquire ownership after the cleanup grace', async () => {
    vi.useFakeTimers();
    try {
      const deleteThread = vi.spyOn(eventStore, 'deleteThread');
      claude.startSession.mockImplementationOnce(async (input) => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        const now = new Date().toISOString();
        const session: ProviderSession = {
          provider: 'claude',
          threadId: input.threadId,
          status: 'ready',
          createdAt: now,
          updatedAt: now,
        };
        claude.sessions.set(input.threadId, session);
        return session;
      });
      const boundedService = new OrchestrationService({
        adapterRegistry: createRegistry([bedrock, claude]),
        eventBus,
        eventStore,
        adapterStopTimeoutMs: 10,
        logger: { debug: vi.fn(), warn: vi.fn() },
      });

      const resultPromise = boundedService.runConnectionSmoke({
        connectionId: 'claude',
        provider: 'claude',
        modelId: 'claude-sonnet',
        cwd: tmp,
        timeoutMs: 20,
      });
      await vi.advanceTimersByTimeAsync(30);
      const result = await resultPromise;

      expect(result).toMatchObject({ ok: false, reasonCode: 'cleanup-failed' });
      expect(result.durationMs).toBe(30);
      expect(deleteThread).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(10);
      expect(claude.stopSession).toHaveBeenCalledOnce();
      expect(claude.sessions.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test('returns and exposes command receipts without changing dispatch compatibility', async () => {
    const response = await service.dispatchWithReceipt({
      type: 'startSession',
      input: {
        threadId: 'thread-receipt',
        provider: 'claude',
        modelId: 'claude-sonnet',
      },
    });

    expect(response.result).toMatchObject({
      provider: 'claude',
      threadId: 'thread-receipt',
    });
    expect(response.receipt).toEqual({
      commandId: expect.any(String),
      threadId: 'thread-receipt',
      commandType: 'startSession',
      status: 'accepted',
      createdAt: expect.any(String),
    });
    expect(service.readCommandReceipt(response.receipt.commandId)).toEqual(
      response.receipt,
    );
    expect(service.listCommandReceipts('thread-receipt')).toEqual([
      response.receipt,
    ]);

    await expect(
      service.dispatch({
        type: 'sendTurn',
        input: { threadId: 'thread-receipt', input: 'hello' },
      }),
    ).resolves.toEqual({
      threadId: 'thread-receipt',
      turnId: 'claude-turn',
    });
  });

  test('persists failed command receipts for rejected commands', async () => {
    await expect(
      service.dispatchWithReceipt({
        type: 'sendTurn',
        input: { threadId: 'missing-thread', input: 'hello' },
      }),
    ).rejects.toMatchObject({
      receipt: expect.objectContaining({
        threadId: 'missing-thread',
        commandType: 'sendTurn',
        status: 'failed',
      }),
    });

    expect(service.listCommandReceipts('missing-thread')).toEqual([
      expect.objectContaining({
        threadId: 'missing-thread',
        commandType: 'sendTurn',
        status: 'failed',
      }),
    ]);
  });

  test('records chat start gate outcomes across managed, connected, and ACP adapters', async () => {
    const codex = new FakeAdapter('codex');
    const acp = new FakeAdapter('acp');
    const crossRuntimeService = new OrchestrationService({
      adapterRegistry: createRegistry([bedrock, codex, acp]),
      eventBus,
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });

    await crossRuntimeService.dispatch({
      type: 'startSession',
      input: { threadId: 'managed-thread', provider: 'bedrock' },
    });
    await crossRuntimeService.dispatch({
      type: 'startSession',
      input: {
        threadId: 'connected-thread',
        provider: 'codex',
        modelId: 'gpt-5.4',
      },
    });
    await crossRuntimeService.dispatch({
      type: 'startSession',
      input: { threadId: 'acp-thread', provider: 'acp' },
    });

    expect(chatStartGate.add).toHaveBeenCalledWith(1, {
      agent_type: 'station',
      runtime_type: 'bedrock',
      outcome: 'allowed',
      reason: 'adapter_configured',
    });
    expect(chatStartGate.add).toHaveBeenCalledWith(1, {
      agent_type: 'external',
      runtime_type: 'codex',
      outcome: 'allowed',
      reason: 'adapter_configured',
    });
    expect(chatStartGate.add).toHaveBeenCalledWith(1, {
      agent_type: 'acp',
      runtime_type: 'acp',
      outcome: 'allowed',
      reason: 'adapter_configured',
    });
  });

  test('lists providers with prerequisites and active session counts', async () => {
    await service.dispatch({
      type: 'startSession',
      input: {
        threadId: 'thread-3',
        provider: 'claude',
        modelId: 'claude-sonnet',
      },
    });

    const providers = await service.listProviders();
    expect(providers).toEqual([
      {
        provider: 'bedrock',
        prerequisites: [],
        activeSessions: 0,
      },
      {
        provider: 'claude',
        prerequisites: [
          {
            id: 'anthropic-api-key',
            name: 'Anthropic API key',
            status: 'installed',
            category: 'required',
            description: 'Used to access Claude Agent SDK.',
          },
        ],
        activeSessions: 1,
      },
    ]);
  });

  test('station#980 Wave 0 (AC3): excludes the private station-agent adapter from provider inventory', async () => {
    const stationAgent = new FakeAdapter('station-agent');
    const guardedService = new OrchestrationService({
      adapterRegistry: createRegistry([bedrock, claude, stationAgent]),
      eventBus,
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });

    await guardedService.dispatch({
      type: 'startSession',
      input: {
        threadId: 'thread-station-agent-inventory',
        provider: 'station-agent',
        metadata: { agentId: 'writer-bot' },
      },
    });

    const providers = await guardedService.listProviders();
    // The private adapter must never surface as a selectable provider (the
    // whole point of AC3 — it stays dispatchable via `get`/`dispatch` above,
    // just absent from any inventory-shaped list), while its sibling public
    // adapters are unaffected.
    expect(providers.map((p) => p.provider)).toEqual(['bedrock', 'claude']);
    expect(providers.some((p) => p.provider === 'station-agent')).toBe(false);
  });

  test("station#980 Wave 1: a station-agent session for a managed agent lands an event-store row and surfaces in listAgentRuns with engineExecution:'station' and agent+model metadata", async () => {
    const stationAgent = new FakeAdapter('station-agent');
    const stationAgentService = new OrchestrationService({
      adapterRegistry: createRegistry([bedrock, claude, stationAgent]),
      eventBus,
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });

    // Mirrors what `delegateTask`'s station-agent branch and the CLI/UI
    // flip (Waves 2/3) both do: startSession(provider:'station-agent',
    // metadata:{agentId}) + sendTurn, then the adapter's own `session.
    // configured`/`turn.completed` events land in the event store.
    eventStore.upsertSession({
      provider: 'station-agent',
      threadId: 'thread-managed-chat',
      status: 'running',
      model: 'claude-sonnet',
      createdAt: '2026-07-27T00:00:00.000Z',
      updatedAt: '2026-07-27T00:00:01.000Z',
    });
    eventStore.appendEvent({
      provider: 'station-agent',
      threadId: 'thread-managed-chat',
      eventId: 'evt-managed-configured',
      createdAt: '2026-07-27T00:00:00.500Z',
      method: 'session.configured',
      metadata: { agentId: 'writer-bot' },
      model: 'claude-sonnet',
    } as any);
    eventStore.appendEvent({
      provider: 'station-agent',
      threadId: 'thread-managed-chat',
      eventId: 'evt-managed-turn-completed',
      createdAt: '2026-07-27T00:00:02.000Z',
      method: 'turn.completed',
      turnId: 'turn-1',
      finishReason: 'stop',
    } as any);

    const runs = await stationAgentService.listAgentRuns();
    const run = runs.find((r) => r.sessionId === 'thread-managed-chat');
    // No run-projection/run-service change was needed to get here (per the
    // archive#980 architecture map): a station-agent session is a first-class
    // run the moment it exists, exactly like any other provider's.
    expect(run).toMatchObject({
      runId: 'thread-managed-chat',
      sessionId: 'thread-managed-chat',
      providerId: 'station-agent',
      source: 'orchestration',
      engineExecution: 'station',
      status: 'completed',
    });

    // Agent + model identity is discoverable off the persisted session row
    // and the `session.configured` event — exactly what a run/session detail
    // read (`GET /api/orchestration/sessions/:threadId`) surfaces.
    const persisted = eventStore
      .readSessions()
      .find((session) => session.threadId === 'thread-managed-chat');
    expect(persisted?.model).toBe('claude-sonnet');
    const configured = eventStore
      .listEvents('thread-managed-chat')
      .map((event) => event.payload)
      .find((event: any) => event.method === 'session.configured') as any;
    expect(configured?.metadata?.agentId).toBe('writer-bot');
  });

  test('returns runtime models for a provider when the adapter exposes them', async () => {
    claude.listModels.mockResolvedValue([
      {
        id: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        originalId: 'claude-sonnet-4-6',
      },
    ]);

    await expect(service.getProviderModels('claude')).resolves.toEqual([
      {
        id: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        originalId: 'claude-sonnet-4-6',
      },
    ]);
    await expect(service.getProviderModels('codex')).resolves.toEqual([]);
  });

  test("falls back to the adapter knownModels catalog when the picker's live catalog is empty (station#977)", async () => {
    (claude.metadata as any).knownModels = [
      { id: 'sonnet', name: 'Sonnet' },
      { id: 'opus', name: 'Opus' },
    ];
    claude.listModels.mockResolvedValue([]);

    await expect(service.getProviderModels('claude')).resolves.toEqual([
      { id: 'sonnet', name: 'Sonnet', originalId: 'sonnet' },
      { id: 'opus', name: 'Opus', originalId: 'opus' },
    ]);
  });

  // Guard (archive#977): the connected-CLI softening above is scoped to
  // claude/codex only — a Station-engine provider like bedrock must never
  // be routed through the deferred-to-engine gate at all. (Station-engine
  // model resolution's own exact-match rejection lives entirely outside
  // OrchestrationService — see runtime-provider-resolution.test.ts's
  // "rejects an unsupported preferred model" coverage, untouched by this
  // change.)
  test('never applies the connected-CLI model gate to a Station-engine provider', async () => {
    await service.dispatch({
      type: 'startSession',
      input: {
        threadId: 'bedrock-arbitrary-model',
        provider: 'bedrock',
        modelId: 'not-a-real-model-id',
      },
    });
    expect(bedrock.startSession).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'not-a-real-model-id' }),
    );
  });

  test('defensively bounds and validates adapter-owned model results', async () => {
    claude.listModels.mockResolvedValue([
      {
        id: 'x'.repeat(513),
        name: 'invalid',
        originalId: 'invalid',
      },
      ...Array.from({ length: 1_005 }, (_, index) => ({
        id: `model-${index}`,
        name: `Model ${index}`,
        originalId: `model-${index}`,
      })),
    ]);

    const models = await service.getProviderModels('claude');

    expect(models).toHaveLength(1_000);
    expect(models[0]?.id).toBe('model-0');
    expect(models.at(-1)?.id).toBe('model-999');
  });

  test('bounds and cancels runtime model discovery through the adapter contract', async () => {
    const controller = new AbortController();
    let operationSignal: AbortSignal | undefined;
    claude.listModels.mockImplementation(async (options) => {
      operationSignal = options?.signal;
      return [];
    });

    await service.getProviderModels('claude', {
      signal: controller.signal,
    });

    expect(claude.listModels).toHaveBeenCalledWith({
      signal: expect.any(AbortSignal),
      maxEntries: 1000,
    });
    expect(operationSignal).not.toBe(controller.signal);
  });

  test('aborts stalled runtime model discovery at the service deadline', async () => {
    vi.useFakeTimers();
    try {
      let operationSignal: AbortSignal | undefined;
      claude.listModels.mockImplementation(
        (options) =>
          new Promise((_, reject) => {
            operationSignal = options?.signal;
            options?.signal?.addEventListener(
              'abort',
              () => reject(options.signal?.reason),
              { once: true },
            );
          }),
      );

      const pending = service.getProviderModels('claude');
      const assertion = expect(pending).rejects.toThrow(
        'claude model discovery timed out.',
      );
      await vi.advanceTimersByTimeAsync(5_000);

      await assertion;
      expect(operationSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test('does not let plugin metadata opt into unbounded abort settlement', async () => {
    vi.useFakeTimers();
    try {
      (claude.metadata as any).abortSettlement = 'await';
      claude.listModels.mockImplementation(() => new Promise(() => {}));

      const pending = service.getProviderModels('claude');
      const assertion = expect(pending).rejects.toThrow(
        'claude model discovery timed out.',
      );
      await vi.advanceTimersByTimeAsync(5_000);

      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test('propagates caller cancellation through the service-owned signal', async () => {
    const controller = new AbortController();
    let operationSignal: AbortSignal | undefined;
    claude.listModels.mockImplementation(
      (options) =>
        new Promise((_, reject) => {
          operationSignal = options?.signal;
          options?.signal?.addEventListener(
            'abort',
            () => reject(options.signal?.reason),
            { once: true },
          );
        }),
    );

    const pending = service.getProviderModels('claude', {
      signal: controller.signal,
    });
    controller.abort(new Error('client disconnected'));

    await expect(pending).rejects.toThrow('client disconnected');
    expect(operationSignal?.aborted).toBe(true);
  });

  test('passes an empty selector through to the engine when there is no local default (station#1154)', async () => {
    // The FakeAdapter carries no `metadata.defaultModel` (unlike the real
    // ClaudeAdapter, archive#977). archive#1154: this used to throw
    // "requires an exact model selector" — but codex genuinely has no
    // enumerable default (archive#977 deliberately left it unset, no
    // hardcoded guess) and works fine launched with no --model at all, so
    // Station imposing a hard requirement here was inconsistent with archive#977's
    // own defer-to-engine design. No explicit selector and no local default
    // now defers to the engine instead of rejecting: the input is passed
    // through unchanged (modelId stays undefined) and the adapter's own
    // startSession is invoked, letting the engine fall back to its built-in
    // default.
    await service.dispatch({
      type: 'startSession',
      input: { threadId: 'missing-model', provider: 'claude' },
    });
    expect(claude.startSession).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'missing-model' }),
    );
    // `objectContaining` treats an absent key as a mismatch, not a pass —
    // assert the actual call payload has no `modelId` key at all (the
    // pass-through returns `input` unchanged, it does not add
    // `modelId: undefined`).
    expect(claude.startSession.mock.calls[0][0]).not.toHaveProperty('modelId');
  });

  // archive#1154: codex deliberately carries no `metadata.defaultModel`
  // (archive#977 — there is no verifiable engine-wide default to hardcode),
  // so it hits the "no local default" branch on every no-`--model` launch.
  // Unlike the other archive#977 regression tests above (which simulate "no
  // default" via a claude FakeAdapter with `defaultModel` unset), these
  // exercise the real codex shape end to end: a codex adapter registered
  // with no `metadata.defaultModel` at all.
  test('starts a codex session with no explicit model and no local default by deferring to the engine (station#1154)', async () => {
    const codex = new FakeAdapter('codex');
    const codexService = new OrchestrationService({
      adapterRegistry: createRegistry([bedrock, codex]),
      eventBus,
      eventStore,
      flowRunService,
      listProjects: () => configuredProjects,
      workflowSidecarService,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });

    await codexService.dispatch({
      type: 'startSession',
      input: { threadId: 'codex-no-model', provider: 'codex' },
    });

    expect(codex.startSession).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'codex-no-model' }),
    );
    expect(codex.startSession.mock.calls[0][0]).not.toHaveProperty('modelId');
  });

  test.each(['', '  \t  '])(
    'normalizes a blank Codex start selector %j to omission',
    async (modelId) => {
      const codex = new FakeAdapter('codex');
      const codexService = new OrchestrationService({
        adapterRegistry: createRegistry([bedrock, codex]),
        eventBus,
        eventStore,
        logger: { debug: vi.fn(), warn: vi.fn() },
      });
      const threadId = `codex-start-blank-${modelId.length}`;

      await codexService.dispatch({
        type: 'startSession',
        input: { threadId, provider: 'codex', modelId },
      });

      expect(codex.startSession).toHaveBeenCalledWith(
        expect.objectContaining({ threadId }),
      );
      expect(codex.startSession.mock.calls[0][0]).not.toHaveProperty('modelId');
    },
  );

  test('sends a codex turn with no explicit model and no local default by deferring to the engine (station#1154)', async () => {
    const codex = new FakeAdapter('codex');
    const codexService = new OrchestrationService({
      adapterRegistry: createRegistry([bedrock, codex]),
      eventBus,
      eventStore,
      flowRunService,
      listProjects: () => configuredProjects,
      workflowSidecarService,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });

    await codexService.dispatch({
      type: 'startSession',
      input: { threadId: 'codex-turn-no-model', provider: 'codex' },
    });
    codex.sendTurn.mockClear();

    await codexService.dispatch({
      type: 'sendTurn',
      input: { threadId: 'codex-turn-no-model', input: 'hi' },
    });

    expect(codex.sendTurn).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'codex-turn-no-model' }),
    );
    expect(codex.sendTurn.mock.calls[0][0]).not.toHaveProperty('modelId');
  });

  test('normalizes an explicit blank Codex selector to omission when there is no local default (station#1154)', async () => {
    const codex = new FakeAdapter('codex');
    const codexService = new OrchestrationService({
      adapterRegistry: createRegistry([bedrock, codex]),
      eventBus,
      eventStore,
      flowRunService,
      listProjects: () => configuredProjects,
      workflowSidecarService,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });

    await codexService.dispatch({
      type: 'startSession',
      input: { threadId: 'codex-turn-blank-model', provider: 'codex' },
    });
    codex.sendTurn.mockClear();

    await codexService.dispatch({
      type: 'sendTurn',
      input: { threadId: 'codex-turn-blank-model', input: 'hi', modelId: '' },
    });

    expect(codex.sendTurn).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'codex-turn-blank-model' }),
    );
    expect(codex.sendTurn.mock.calls[0][0]).not.toHaveProperty('modelId');
  });

  // Regression: an external engine WITH an explicit model still goes
  // through the catalog/defer path unchanged by the archive#1154 fix — the
  // pass-through only applies when the resolved selector is empty.
  test('still validates an explicit codex model selector against the catalog (station#1154 regression)', async () => {
    const codex = new FakeAdapter('codex');
    const codexService = new OrchestrationService({
      adapterRegistry: createRegistry([bedrock, codex]),
      eventBus,
      eventStore,
      flowRunService,
      listProjects: () => configuredProjects,
      workflowSidecarService,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });

    await codexService.dispatch({
      type: 'startSession',
      input: {
        threadId: 'codex-explicit-model',
        provider: 'codex',
        modelId: 'gpt-5.4',
      },
    });

    expect(codex.startSession).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'gpt-5.4' }),
    );
  });

  // archive#977 ("local default + defer to engine"): an explicit selector
  // that misses Station's own (live or known) catalog is no longer treated
  // as "nothing is launchable" for an external engine — Station's catalog is
  // advisory, not authoritative, for claude/codex. The engine itself is the
  // authority on whether the selector is actually valid.
  test('defers an unrecognized explicit selector to the engine instead of rejecting it', async () => {
    await service.dispatch({
      type: 'startSession',
      input: {
        threadId: 'unknown-model',
        provider: 'claude',
        modelId: 'not-in-catalog',
      },
    });
    expect(claude.startSession).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'not-in-catalog' }),
    );
  });

  test('falls back to the adapter default model when no selector is requested (station#977)', async () => {
    (claude.metadata as any).defaultModel = 'sonnet';
    claude.listModels.mockResolvedValue([
      {
        id: 'sonnet',
        name: 'Sonnet',
        originalId: 'claude-sonnet-4-6-20260701',
      },
    ]);

    await service.dispatch({
      type: 'startSession',
      input: { threadId: 'default-model-session', provider: 'claude' },
    });

    expect(claude.startSession).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'claude-sonnet-4-6-20260701' }),
    );
  });

  test('falls back to knownModels when the live/cached catalog is empty (station#977)', async () => {
    (claude.metadata as any).knownModels = [
      { id: 'sonnet', name: 'Sonnet' },
      { id: 'opus', name: 'Opus' },
    ];
    claude.listModels.mockResolvedValue([]);

    await service.dispatch({
      type: 'startSession',
      input: {
        threadId: 'known-models-session',
        provider: 'claude',
        modelId: 'opus',
      },
    });

    // knownModels carry no separate wire-format id — originalId mirrors id.
    expect(claude.startSession).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'opus' }),
    );
  });

  test('revalidates an explicit connected-runtime selector on every turn, deferring an unrecognized one to the engine', async () => {
    await service.dispatch({
      type: 'startSession',
      input: {
        threadId: 'turn-selector',
        provider: 'claude',
        modelId: 'claude-sonnet',
      },
    });
    claude.sendTurn.mockClear();
    claude.sendTurn
      .mockResolvedValueOnce({
        threadId: 'turn-selector',
        turnId: 'claude-turn-selector-1',
      })
      .mockResolvedValueOnce({
        threadId: 'turn-selector',
        turnId: 'claude-turn-selector-2',
      });

    // archive#977: a turn-level selector that misses the catalog is also
    // deferred to the engine now, not rejected.
    await service.dispatch({
      type: 'sendTurn',
      input: {
        threadId: 'turn-selector',
        input: 'hello',
        modelId: 'not-in-catalog',
      },
    });
    expect(claude.sendTurn).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'not-in-catalog' }),
    );
    claude.sendTurn.mockClear();

    await service.dispatch({
      type: 'sendTurn',
      input: {
        threadId: 'turn-selector',
        input: 'hello',
        modelId: 'claude-sonnet',
      },
    });
    expect(claude.sendTurn).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'claude-sonnet' }),
    );
  });

  test('forwards provider-native selectors after validating public catalog ids', async () => {
    claude.listModels.mockResolvedValue([
      {
        id: 'sonnet',
        name: 'Claude Sonnet',
        originalId: 'claude-sonnet-4-6-20260701',
      },
    ]);

    await service.dispatch({
      type: 'startSession',
      input: {
        threadId: 'aliased-selector',
        provider: 'claude',
        modelId: 'sonnet',
      },
    });
    expect(claude.startSession).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'claude-sonnet-4-6-20260701' }),
    );

    await service.dispatch({
      type: 'sendTurn',
      input: {
        threadId: 'aliased-selector',
        input: 'hello',
        modelId: 'sonnet',
      },
    });
    expect(claude.sendTurn).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'claude-sonnet-4-6-20260701' }),
    );
  });

  test('bounds connected runtime selector validation at the service deadline', async () => {
    vi.useFakeTimers();
    try {
      let operationSignal: AbortSignal | undefined;
      claude.listModels.mockImplementation(
        (options) =>
          new Promise((_, reject) => {
            operationSignal = options?.signal;
            options?.signal?.addEventListener(
              'abort',
              () => reject(options.signal?.reason),
              { once: true },
            );
          }),
      );

      const pending = service.dispatch({
        type: 'startSession',
        input: {
          threadId: 'stalled-model-validation',
          provider: 'claude',
          modelId: 'claude-sonnet-4-6',
        },
      });
      const assertion = expect(pending).rejects.toThrow(
        'claude model validation timed out.',
      );
      await vi.advanceTimersByTimeAsync(5_000);

      await assertion;
      expect(operationSignal?.aborted).toBe(true);
      expect(claude.startSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * archive#3476: a restored session must be a real, usable session before
   * anything starts an engine for it — listed, readable, and reporting its
   * state honestly. The measured defect was 18 engines spawned 36 seconds
   * after boot for conversations nobody had opened; this is what replaces
   * them.
   */
  test('a session restored without an engine is listed and readable, and says it is not attached', async () => {
    eventStore.upsertSession({
      provider: 'claude',
      threadId: 'thread-listed-without-engine',
      status: 'ready',
      model: 'claude-sonnet',
      cwd: '/workspace/project',
      resumeCursor: { cursor: 'resume-listed' },
      createdAt: '2026-03-28T00:00:00.000Z',
      updatedAt: '2026-03-28T00:00:05.000Z',
    });

    service.initialize();
    await waitForReceipt(
      (receipt) => receipt.kind === 'session.recovery.completed',
    );
    await waitForReceipt(
      (receipt) => receipt.kind === 'session.attachment.settled',
    );

    expect(claude.startSession).not.toHaveBeenCalled();

    const listed = (await service.listSessionReadModel()).find(
      (candidate) => candidate.threadId === 'thread-listed-without-engine',
    );
    expect(listed).toMatchObject({
      threadId: 'thread-listed-without-engine',
      provider: 'claude',
      model: 'claude-sonnet',
      cwd: '/workspace/project',
      // The cursor that makes it resumable survives into the read model.
      resumeCursor: { cursor: 'resume-listed' },
      // `isLoaded` is the discriminating assertion here: every other field
      // above would still be listed straight off the persisted row if
      // recovery restored nothing at all. It means "this process holds the
      // session in its in-memory read model", which after archive#3476 is
      // what a restored session is — not "an engine is live", which is what
      // `answerability`'s attachment half reports.
      isLoaded: true,
    });

    const detail = await service.readSession('thread-listed-without-engine');
    expect(detail?.session.threadId).toBe('thread-listed-without-engine');
    // Honest about the thing that IS different: nothing is holding it. It
    // stays answerable because it can still resume and its provider is
    // registered — a live approval is not hidden by the deferral.
    expect(detail?.session.answerability).toEqual({ answerable: true });
  });

  test('two concurrent first turns on one restored session materialise ONE engine', async () => {
    const threadId = 'thread-concurrent-first-turn';
    eventStore.upsertSession({
      provider: 'claude',
      threadId,
      status: 'running',
      model: 'claude-sonnet',
      resumeCursor: { cursor: 'resume-concurrent' },
      createdAt: '2026-03-28T00:00:00.000Z',
      updatedAt: '2026-03-28T00:00:05.000Z',
    });
    service.initialize();
    await waitForReceipt(
      (receipt) => receipt.kind === 'session.recovery.completed',
    );

    // Hold the start open so both turns are genuinely in flight across it.
    const defaultStart = claude.startSession.getMockImplementation()!;
    let releaseStart: (() => void) | undefined;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    claude.startSession.mockImplementation(async (input) => {
      await startGate;
      return defaultStart(input);
    });

    // `allSettled`: whether the SECOND turn is accepted, deduplicated, or
    // reported indeterminate is the turn layer's business and is not what
    // this pins. The engine count is.
    const turns = Promise.allSettled([
      service.dispatch({
        type: 'sendTurn',
        input: { threadId, input: 'first' },
      }),
      service.dispatch({
        type: 'sendTurn',
        input: { threadId, input: 'second' },
      }),
    ]);
    releaseStart?.();
    await turns;

    expect(claude.startSession).toHaveBeenCalledTimes(1);
  });

  /**
   * archive#3476: the commands that do NOT need an engine. Starting one in
   * order to stop, interrupt, or steer it would be the same defect this
   * issue removes, so each takes an engine-free branch — and each must still
   * do the useful half of its job.
   */
  describe('a restored session with no engine still answers the engine-free commands', () => {
    const restoreSession = async (threadId: string) => {
      eventStore.upsertSession({
        provider: 'claude',
        threadId,
        status: 'running',
        model: 'claude-sonnet',
        resumeCursor: { cursor: 'resume-engine-free' },
        createdAt: '2026-03-28T00:00:00.000Z',
        updatedAt: '2026-03-28T00:00:05.000Z',
      });
      service.initialize();
      await waitForReceipt(
        (receipt) => receipt.kind === 'session.recovery.completed',
      );
    };

    test('stopSession closes it out as resumable without spawning an engine to kill', async () => {
      const threadId = 'thread-dormant-stop';
      await restoreSession(threadId);

      await service.dispatch({ type: 'stopSession', threadId });

      expect(claude.startSession).not.toHaveBeenCalled();
      expect(claude.stopSession).not.toHaveBeenCalled();
      // The same two guarantees the live stop gives: the row stays
      // resumable (never `closed`, which would NULL `resumeCursor`)...
      expect(
        eventStore
          .readSessions()
          .find((session) => session.threadId === threadId),
      ).toMatchObject({
        status: 'ready',
        resumeCursor: { cursor: 'resume-engine-free' },
      });
      // ...and this process no longer holds it in memory. It is still
      // LISTED — a stopped conversation does not vanish — so `isLoaded` is
      // what discriminates, the same field the restored-session test above
      // asserts true.
      expect(
        (await service.listSessionReadModel()).find(
          (session) => session.threadId === threadId,
        ),
      ).toMatchObject({ isLoaded: false });
    });

    test('stopSession refuses a terminal row rather than resurrecting it as resumable', async () => {
      const threadId = 'thread-closed-not-dormant';
      eventStore.upsertSession({
        provider: 'claude',
        threadId,
        status: 'closed',
        createdAt: '2026-03-28T00:00:00.000Z',
        updatedAt: '2026-03-28T00:00:05.000Z',
      });
      service.initialize();
      await waitForReceipt(
        (receipt) => receipt.kind === 'session.recovery.completed',
      );

      await expect(
        service.dispatch({ type: 'stopSession', threadId }),
      ).rejects.toThrow(`No provider session found for thread: ${threadId}`);

      expect(
        eventStore
          .readSessions()
          .find((session) => session.threadId === threadId)?.status,
      ).toBe('closed');
    });

    test('interruptTurn accepts and starts nothing — there is no turn to cancel', async () => {
      const threadId = 'thread-dormant-interrupt';
      await restoreSession(threadId);

      // UX audit T1: the dormant path now names what it observed rather than
      // answering `undefined` — the composer must be able to say "there was
      // no turn running to stop" instead of claiming a cancellation.
      await expect(
        service.dispatch({ type: 'interruptTurn', threadId }),
      ).resolves.toEqual({ outcome: 'no-active-turn', threadId });

      expect(claude.startSession).not.toHaveBeenCalled();
      expect(claude.interruptTurn).not.toHaveBeenCalled();
    });

    /**
     * The other command that reaches a restored session. `startSession` on
     * an existing thread is a REATTACH, and the reattach branch requires
     * both an in-memory session and the adapter holding it — a pairing that
     * was impossible before archive#3476 and is now the ordinary state of
     * every session restored at boot. Without materialising first it fails
     * with "Session already exists for thread".
     */
    test('startSession reattaches a restored session by materialising it first', async () => {
      const threadId = 'thread-dormant-reattach';
      await restoreSession(threadId);

      const outcome = await service.dispatchWithReceipt({
        type: 'startSession',
        input: { threadId, provider: 'claude' },
      });

      expect(outcome.receipt.status).toBe('accepted');
      expect(claude.startSession).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId,
          resumeCursor: { cursor: 'resume-engine-free' },
        }),
      );
    });

    /**
     * archive#3476 review HIGH-1: `startSession` is the one command whose
     * ownership gate lives INSIDE the session command module —
     * `dispatchWithReceipt` short-circuits to the module before its own
     * `canReadSessionForCommand` check, and `assertStartAllowed` only checks
     * tenant presence and credential reservation. So the module's `canRead`
     * throw is the only thing standing between a `POST
     * /api/orchestration/commands` body naming somebody else's thread and an
     * engine spawned with the OWNER's cwd, credential profile and tenant
     * context — plus, on a failed start, a durable `runtime.error` written
     * into the owner's conversation and their row flipped to `error`.
     * Materialisation must therefore stay BELOW that throw.
     */
    test('an unauthorized startSession on another user’s restored session starts no engine', async () => {
      const threadId = 'thread-dormant-unauthorized-start';
      await restoreSession(threadId);
      // Ownership is established by the first `session.configured` /
      // `session.started` event carrying a `metadata.userId`.
      eventStore.appendEvent({
        provider: 'claude',
        threadId,
        eventId: 'evt-dormant-owner',
        createdAt: '2026-03-28T00:00:01.000Z',
        method: 'session.configured',
        sessionId: threadId,
        metadata: { userId: 'owner-user' },
      } as CanonicalRuntimeEvent);

      await expect(
        service.dispatchWithReceipt(
          { type: 'startSession', input: { threadId, provider: 'claude' } },
          { userId: 'other-user' },
        ),
      ).rejects.toThrow(`Session not found: ${threadId}`);

      // The whole point: refused BEFORE any side effect. Not one engine.
      expect(claude.startSession).toHaveBeenCalledTimes(0);
      // And the owner's row is untouched — still resumable, not `error`.
      expect(
        eventStore
          .readSessions()
          .find((session) => session.threadId === threadId),
      ).toMatchObject({
        status: 'running',
        resumeCursor: { cursor: 'resume-engine-free' },
      });

      // The owner is unaffected by the attempt: their own reattach still
      // materialises exactly one engine.
      await service.dispatchWithReceipt(
        { type: 'startSession', input: { threadId, provider: 'claude' } },
        { userId: 'owner-user' },
      );
      expect(claude.startSession).toHaveBeenCalledTimes(1);
    });

    test('steerTurn reports no-active-turn rather than materialising an engine', async () => {
      const threadId = 'thread-dormant-steer';
      await restoreSession(threadId);

      await expect(
        service.dispatch({ type: 'steerTurn', threadId, input: 'also do X' }),
      ).resolves.toMatchObject({ outcome: 'no-active-turn', threadId });

      expect(claude.startSession).not.toHaveBeenCalled();
    });

    /** A startSession whose resolution the test controls, for driving the
     * materialisation window (archive#3493 residual 1). */
    const gateStartSessionOnce = () => {
      const gate = deferred<void>();
      claude.startSession.mockImplementationOnce(async (input) => {
        await gate.promise;
        const now = new Date().toISOString();
        const session: ProviderSession = {
          provider: 'claude',
          threadId: input.threadId,
          status: 'ready',
          model: input.modelId,
          createdAt: now,
          updatedAt: now,
        };
        claude.sessions.set(input.threadId, session);
        return session;
      });
      return gate;
    };

    /**
     * archive#3493 residual 1: `sessionAdapters` is bound only after
     * `adapter.startSession` resolves, so for the whole start latency a
     * materialising thread used to read dormant — and a Stop inside that
     * window wrote the row `ready`, forgot the binding, and returned
     * success while an engine came up behind it. A Stop must land on the
     * engine it raced.
     */
    test('a Stop during materialisation tears down the engine it raced instead of reporting success around it', async () => {
      const threadId = 'thread-materialising-stop';
      await restoreSession(threadId);
      const gate = gateStartSessionOnce();

      const turn = materializeBySendingATurn(service, threadId).catch(
        () => undefined,
      );
      await vi.waitFor(() => expect(claude.startSession).toHaveBeenCalled());

      const stop = service.dispatch({ type: 'stopSession', threadId });
      // Pre-fix the dormant branch settled the Stop inside the window
      // without touching the engine; now it awaits the start and stops the
      // REAL process rather than narrating around it.
      gate.resolve(undefined);
      await stop;
      await turn;

      expect(claude.stopSession).toHaveBeenCalledWith(threadId);
    });

    /**
     * archive#3493 residual 1, the interrupt half: mid-materialisation there
     * IS work to cancel — the turn that triggered the start is about to be
     * announced. `no-active-turn` (do nothing, report done) was the lie;
     * the honest answer is the same one the engine-session-not-yet path
     * gives, `pending-turn-start`, which arms the cancel for that thread's
     * next `turn.started`.
     */
    test('an interrupt during materialisation records a pending cancel instead of claiming no turn exists', async () => {
      const threadId = 'thread-materialising-interrupt';
      await restoreSession(threadId);
      const gate = gateStartSessionOnce();

      const turn = materializeBySendingATurn(service, threadId).catch(
        () => undefined,
      );
      await vi.waitFor(() => expect(claude.startSession).toHaveBeenCalled());

      await expect(
        service.dispatch({ type: 'interruptTurn', threadId }),
      ).resolves.toEqual({ outcome: 'pending-turn-start', threadId });

      gate.resolve(undefined);
      await turn;
      expect(claude.interruptTurn).not.toHaveBeenCalled();
    });

    /**
     * archive#3493 residual 1, the steer half: only `isDormantSessionThread`'s
     * mid-materialisation guard protects steer, so this pins that the guard
     * is load-bearing — a steer inside the window must not resolve
     * `no-active-turn` (a turn is imminent; "nothing to steer" is the same
     * lie shape). The live path it falls to throws the historical
     * no-session error instead: honest, if blunt.
     */
    test('a steer during materialisation does not claim no turn exists', async () => {
      const threadId = 'thread-materialising-steer';
      await restoreSession(threadId);
      const gate = gateStartSessionOnce();

      const turn = materializeBySendingATurn(service, threadId).catch(
        () => undefined,
      );
      await vi.waitFor(() => expect(claude.startSession).toHaveBeenCalled());

      await expect(
        service.dispatch({ type: 'steerTurn', threadId, input: 'also do X' }),
      ).rejects.toThrow(`No provider session found for thread: ${threadId}`);

      gate.resolve(undefined);
      await turn;
      expect(claude.steerTurn).not.toHaveBeenCalled();
    });

    /**
     * archive#3493 fix-round HIGH: the Stop's await on an in-flight
     * materialisation is bounded by the adapter-stop deadline. A wedged
     * `adapter.startSession` (this deferred never resolves) must not turn a
     * Stop press into a forever-hang — on expiry the command refuses with a
     * typed error naming the state, and does NOT fall through to the
     * dormant write (which would report success around a live start).
     */
    test('a Stop on a wedged start refuses, typed, at the adapter-stop deadline instead of hanging', async () => {
      const threadId = 'thread-materialising-stop-wedged';
      await restoreSession(threadId);
      claude.startSession.mockImplementationOnce(
        () => new Promise<never>(() => {}),
      );

      const turn = materializeBySendingATurn(service, threadId).catch(
        () => undefined,
      );
      await vi.waitFor(() => expect(claude.startSession).toHaveBeenCalled());

      vi.useFakeTimers();
      try {
        const stop = service.dispatch({ type: 'stopSession', threadId }).then(
          () => 'settled-without-error',
          (error: unknown) => error,
        );
        await vi.advanceTimersByTimeAsync(5_001);
        const failure = await stop;

        expect(failure).toBeInstanceOf(OrchestrationCommandDispatchError);
        const dispatchError = failure as OrchestrationCommandDispatchError;
        expect(dispatchError.code).toBe('session_start_in_flight');
        expect(dispatchError.message).toContain('still starting');
        // The message says "retry", so the classification must agree —
        // delta review caught these contradicting each other.
        expect(dispatchError.retryable).toBe(true);
        expect(dispatchError.receipt.status).toBe('rejected');
        // The refusal did NOT take the dormant branch behind the wedged
        // start: no teardown was claimed and the row is untouched.
        expect(claude.stopSession).not.toHaveBeenCalled();
        expect(
          eventStore
            .readSessions()
            .find((session) => session.threadId === threadId)?.status,
        ).toBe('running');
      } finally {
        vi.useRealTimers();
        void turn;
      }
    });

    /**
     * archive#3493 fix-1/fix-3 seam, end-to-end: a materialisation that
     * FAILS records archive#1090's `error` row; a Stop landing after that
     * failure takes the dormant branch (the settled start left nothing
     * live) and must preserve the `error` marker rather than promote the
     * row to `ready`.
     */
    test('a Stop after a failed materialisation keeps the error row error', async () => {
      const threadId = 'thread-failed-start-then-stop';
      await restoreSession(threadId);
      claude.startSession.mockRejectedValueOnce(
        new Error('engine spawn failed'),
      );

      await materializeBySendingATurn(service, threadId).catch(() => undefined);
      // The failed start recorded its evidence: the row reads `error`.
      await vi.waitFor(() =>
        expect(
          eventStore
            .readSessions()
            .find((session) => session.threadId === threadId)?.status,
        ).toBe('error'),
      );

      await service.dispatch({ type: 'stopSession', threadId });

      expect(claude.stopSession).not.toHaveBeenCalled();
      expect(
        eventStore
          .readSessions()
          .find((session) => session.threadId === threadId),
      ).toMatchObject({
        status: 'error',
        resumeCursor: { cursor: 'resume-engine-free' },
      });
    });

    /**
     * archive#3493 residual 3: `error` is archive#1090's row-level marker
     * that a start failed, and boot recovery deliberately keeps retrying
     * such rows. A dormant Stop used to write `status: 'ready'` over it —
     * erasing the summary state every list and the next recovery read
     * first, while the `runtime.error` evidence survived underneath.
     */
    test('a dormant Stop keeps an error row error instead of promoting it to ready', async () => {
      const threadId = 'thread-dormant-error-stop';
      eventStore.upsertSession({
        provider: 'claude',
        threadId,
        status: 'error',
        model: 'claude-sonnet',
        resumeCursor: { cursor: 'resume-engine-free' },
        createdAt: '2026-03-28T00:00:00.000Z',
        updatedAt: '2026-03-28T00:00:05.000Z',
      });
      service.initialize();
      await waitForReceipt(
        (receipt) => receipt.kind === 'session.recovery.completed',
      );

      await service.dispatch({ type: 'stopSession', threadId });

      expect(claude.startSession).not.toHaveBeenCalled();
      expect(
        eventStore
          .readSessions()
          .find((session) => session.threadId === threadId),
      ).toMatchObject({
        status: 'error',
        resumeCursor: { cursor: 'resume-engine-free' },
      });
    });

    /**
     * archive#3493 residual 6: the model-change conflict used to be raised
     * only by `validateReattach`, which needs the adapter — so a dormant
     * session's conflicting reattach spawned the engine first and refused
     * after. The conflict is answerable from the persisted row alone and
     * must refuse before the spawn.
     */
    test('a model-change reattach on a dormant session refuses before the engine spawns', async () => {
      const threadId = 'thread-dormant-model-change';
      await restoreSession(threadId);

      const failure = await service
        .dispatchWithReceipt({
          type: 'startSession',
          input: { threadId, provider: 'claude', modelId: 'claude-haiku' },
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      expect(failure).toBeInstanceOf(OrchestrationCommandDispatchError);
      const dispatchError = failure as OrchestrationCommandDispatchError;
      expect(dispatchError.message).toContain('model-change');
      expect(dispatchError.receipt.status).toBe('rejected');
      // The whole point: refused with zero side effects. Not one engine.
      expect(claude.startSession).not.toHaveBeenCalled();
    });
  });

  test('persists adapter events and recovers resumable sessions on startup', async () => {
    eventStore.upsertSession({
      provider: 'claude',
      threadId: 'thread-9',
      status: 'running',
      model: 'claude-sonnet',
      resumeCursor: { cursor: 'resume-1' },
      createdAt: '2026-03-28T00:00:00.000Z',
      updatedAt: '2026-03-28T00:00:05.000Z',
    });

    service.initialize();
    // archive#1101: was `await new Promise((resolve) => setTimeout(resolve, 0));`
    // — a fixed one-tick wait for the fire-and-forget
    // `startReconciliation().then(() => recoverSessions())` chain to
    // settle. Under load a single tick is not guaranteed to be enough
    // (archive#1045), and it's provably not a signal of anything in particular
    // when it IS enough. Await the actual milestone instead.
    await waitForReceipt(
      (receipt) => receipt.kind === 'session.recovery.completed',
    );

    // archive#3476: restoring state starts no engine...
    expect(claude.startSession).not.toHaveBeenCalled();
    // ...and the first turn materialises it, with the persisted cursor.
    await materializeBySendingATurn(service, 'thread-9');

    expect(claude.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread-9',
        provider: 'claude',
        resumeCursor: { cursor: 'resume-1' },
        // archive#1023: recovery carries no directory binding, so the resumed
        // engine gets the same explicit $HOME default as any unbound start.
        cwd: homedir(),
      }),
    );

    const event: CanonicalRuntimeEvent = {
      eventId: 'evt-77',
      provider: 'claude',
      threadId: 'thread-9',
      createdAt: '2026-03-28T00:00:06.000Z',
      method: 'session.state-changed',
      sessionId: 'thread-9',
      from: 'idle',
      to: 'running',
    };
    claude.events.push(event);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(eventStore.listEvents('thread-9')).toEqual([
      expect.objectContaining({
        id: 'evt-77',
        payload: expect.objectContaining({
          ...event,
          sessionState: 'running',
          // archive#1073: the recovered session's attach events no longer fabricate
          // 'running' — before this state-change it was truthfully 'queued'.
          previousState: 'queued',
        }),
      }),
    ]);
    expect(eventStore.readSessions()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          threadId: 'thread-9',
          provider: 'claude',
          status: 'running',
        }),
      ]),
    );
  });

  test('recoverOrchestrationSessions replays the persisted session.started metadata (minus the reserved capabilityDelivery key) and applies resolveSessionAgent before adapter.startSession (#895 wave B)', async () => {
    eventStore.appendEvent({
      eventId: 'evt-session-started-recovery',
      provider: 'claude',
      threadId: 'thread-recovery-agent',
      createdAt: '2026-03-01T00:00:00.000Z',
      method: 'session.started',
      sessionId: 'thread-recovery-agent',
      initialState: 'created',
      metadata: {
        agentSlug: 'my-agent',
        cwd: '/workspace/project',
        [SESSION_CAPABILITY_DELIVERY_METADATA_KEY]: {
          agentSlug: 'my-agent',
          skills: { source: 'agent', requested: ['writing'], undelivered: [] },
        },
      },
    } as any);
    eventStore.upsertSession({
      provider: 'claude',
      threadId: 'thread-recovery-agent',
      status: 'running',
      model: 'claude-sonnet',
      cwd: '/workspace/project',
      persistSession: true,
      createdAt: '2026-03-01T00:00:00.000Z',
      updatedAt: '2026-03-01T00:00:05.000Z',
    });

    const resolveSessionAgent = vi.fn(async (input: any) => ({
      ...input,
      agent: {
        slug: 'my-agent',
        skills: [{ id: 'writing', dir: '/skills/writing' }],
      },
    }));
    const recoveryService = new OrchestrationService({
      adapterRegistry: createRegistry([bedrock, claude]),
      eventBus,
      eventStore,
      resolveSessionAgent,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });

    recoveryService.initialize();
    // archive#1101: was a fixed setTimeout(0) tick — see the first
    // recovery-milestone conversion above for the rationale.
    await waitForReceipt(
      (receipt) => receipt.kind === 'session.recovery.completed',
    );
    // archive#3476: the metadata replay + agent resolution now run when the
    // conversation is first used, not at boot.
    await materializeBySendingATurn(recoveryService, 'thread-recovery-agent');

    expect(resolveSessionAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread-recovery-agent',
        metadata: expect.objectContaining({
          agentSlug: 'my-agent',
          cwd: '/workspace/project',
        }),
      }),
    );
    expect(claude.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread-recovery-agent',
        metadata: expect.objectContaining({
          agentSlug: 'my-agent',
          cwd: '/workspace/project',
        }),
        agent: {
          slug: 'my-agent',
          skills: [{ id: 'writing', dir: '/skills/writing' }],
        },
      }),
    );
  });

  test('recoverOrchestrationSessions replays the LATEST persisted session.started metadata when multiple exist for a thread (#895 wave B review LOW)', async () => {
    eventStore.appendEvent({
      eventId: 'evt-session-started-old',
      provider: 'claude',
      threadId: 'thread-recovery-latest-metadata',
      createdAt: '2026-03-01T00:00:00.000Z',
      method: 'session.started',
      sessionId: 'thread-recovery-latest-metadata',
      initialState: 'created',
      metadata: { agentSlug: 'agent-old', cwd: '/workspace/old' },
    } as any);
    eventStore.appendEvent({
      eventId: 'evt-session-started-new',
      provider: 'claude',
      threadId: 'thread-recovery-latest-metadata',
      createdAt: '2026-03-01T01:00:00.000Z',
      method: 'session.started',
      sessionId: 'thread-recovery-latest-metadata',
      initialState: 'created',
      metadata: { agentSlug: 'agent-new', cwd: '/workspace/new' },
    } as any);
    eventStore.upsertSession({
      provider: 'claude',
      threadId: 'thread-recovery-latest-metadata',
      status: 'running',
      model: 'claude-sonnet',
      cwd: '/workspace/new',
      createdAt: '2026-03-01T00:00:00.000Z',
      updatedAt: '2026-03-01T01:00:05.000Z',
    });

    const recoveryService = new OrchestrationService({
      adapterRegistry: createRegistry([bedrock, claude]),
      eventBus,
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });

    recoveryService.initialize();
    await waitForReceipt(
      (receipt) => receipt.kind === 'session.recovery.completed',
    );
    await materializeBySendingATurn(
      recoveryService,
      'thread-recovery-latest-metadata',
    );

    expect(claude.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread-recovery-latest-metadata',
        metadata: expect.objectContaining({
          agentSlug: 'agent-new',
          cwd: '/workspace/new',
        }),
      }),
    );
  });

  test('a throwing resolveSessionAgent logs and recovery continues into adapter.startSession (#895 wave B review LOW)', async () => {
    eventStore.upsertSession({
      provider: 'claude',
      threadId: 'thread-recovery-resolver-throws',
      status: 'running',
      model: 'claude-sonnet',
      cwd: '/workspace/project',
      createdAt: '2026-03-01T00:00:00.000Z',
      updatedAt: '2026-03-01T00:00:05.000Z',
    });

    const resolveSessionAgent = vi.fn(async () => {
      throw new Error('boom: resolver exploded');
    });
    const warn = vi.fn();
    const recoveryService = new OrchestrationService({
      adapterRegistry: createRegistry([bedrock, claude]),
      eventBus,
      eventStore,
      resolveSessionAgent,
      logger: { debug: vi.fn(), warn },
    });

    recoveryService.initialize();
    await waitForReceipt(
      (receipt) => receipt.kind === 'session.recovery.completed',
    );
    await materializeBySendingATurn(
      recoveryService,
      'thread-recovery-resolver-throws',
    );

    expect(resolveSessionAgent).toHaveBeenCalled();
    expect(claude.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread-recovery-resolver-throws',
      }),
    );
    expect(warn).toHaveBeenCalledWith(
      'resolveSessionAgent failed during session recovery; continuing without a resolved agent definition',
      expect.objectContaining({
        threadId: 'thread-recovery-resolver-throws',
      }),
    );
    expect(eventStore.readSessions()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          threadId: 'thread-recovery-resolver-throws',
          status: 'ready',
        }),
      ]),
    );
  });

  test('rejects startSession when required prerequisites are missing', async () => {
    const blockedClaude = new FakeAdapter('claude', [
      {
        name: 'ANTHROPIC_API_KEY',
        status: 'missing',
        description: 'Claude credentials',
        id: 'anthropic-api-key',
        category: 'required',
      },
    ]);
    const blockedService = new OrchestrationService({
      adapterRegistry: createRegistry([bedrock, blockedClaude]),
      eventBus,
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });

    await expect(
      blockedService.dispatch({
        type: 'startSession',
        input: { threadId: 'blocked-thread', provider: 'claude' },
      }),
    ).rejects.toThrow(/claude prerequisites missing: ANTHROPIC_API_KEY/i);
    expect(blockedClaude.startSession).not.toHaveBeenCalled();
    expect(chatStartGate.add).toHaveBeenCalledWith(1, {
      agent_type: 'external',
      runtime_type: 'claude',
      outcome: 'blocked',
      reason: 'missing_prerequisites',
    });
  });

  test('checks only the selected external connection prerequisites on start', async () => {
    const acp = new FakeAdapter('acp');
    const missingCursor: Prerequisite = {
      name: 'Cursor login',
      status: 'missing',
      description: 'Cursor credentials',
      id: 'cursor-login',
      category: 'required',
    };
    const prerequisites = vi
      .spyOn(acp, 'getPrerequisites')
      .mockImplementation(async (options) =>
        options?.connectionId === 'opencode' ? [] : [missingCursor],
      );
    const scopedService = new OrchestrationService({
      adapterRegistry: createRegistry([bedrock, acp]),
      eventBus,
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });

    await expect(
      scopedService.dispatch({
        type: 'startSession',
        input: {
          threadId: 'opencode-thread',
          provider: 'acp',
          metadata: { connectionId: 'opencode' },
        },
      }),
    ).resolves.toBeDefined();
    expect(prerequisites).toHaveBeenCalledWith({
      connectionId: 'opencode',
    });
    expect(acp.startSession).toHaveBeenCalledOnce();
  });

  test('rejects startSession when the adapter cannot provide agent runtime chat', async () => {
    const modelOnly = new FakeAdapter('codex');
    (modelOnly.metadata as any).capabilities = ['llm'];
    const blockedService = new OrchestrationService({
      adapterRegistry: createRegistry([bedrock, modelOnly]),
      eventBus,
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });

    await expect(
      blockedService.dispatch({
        type: 'startSession',
        input: { threadId: 'blocked-thread', provider: 'codex' },
      }),
    ).rejects.toThrow(/runtime is not ready/i);
    expect(modelOnly.startSession).not.toHaveBeenCalled();
    expect(chatStartGate.add).toHaveBeenCalledWith(1, {
      agent_type: 'external',
      runtime_type: 'codex',
      outcome: 'blocked',
      reason: 'runtime_not_ready',
    });
  });

  test('routes interrupt and approval commands after resolving session ownership dynamically', async () => {
    const codex = new FakeAdapter('codex');
    const routingService = new OrchestrationService({
      adapterRegistry: createRegistry([bedrock, claude, codex]),
      eventBus,
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    codex.sessions.set('thread-codex', {
      provider: 'codex',
      threadId: 'thread-codex',
      status: 'running',
      createdAt: '2026-03-28T00:00:00.000Z',
      updatedAt: '2026-03-28T00:00:00.000Z',
    });
    // Since archive#2907 an interrupt is a bounded cooperative stop, which needs a
    // turn to target: with no active turn in the projection it returns before
    // reaching the adapter. Seed one so this test still proves what it is
    // about — that the command is ROUTED to the owning adapter — rather than
    // silently asserting nothing.
    eventStore.appendEvent({
      eventId: 'routing-codex-turn-started',
      provider: 'codex',
      threadId: 'thread-codex',
      turnId: 'turn-1',
      createdAt: '2026-03-28T00:00:01.000Z',
      method: 'turn.started',
      prompt: 'route me',
    });
    codex.interruptTurn.mockResolvedValueOnce({
      outcome: 'cancelled',
      turnId: 'turn-1',
    });

    await routingService.dispatch({
      type: 'interruptTurn',
      threadId: 'thread-codex',
      turnId: 'turn-1',
    });
    await routingService.dispatch({
      type: 'respondToRequest',
      threadId: 'thread-codex',
      requestId: 'req-1',
      decision: 'accept',
    });

    expect(codex.interruptTurn).toHaveBeenCalledWith('thread-codex', 'turn-1');
    expect(codex.respondToRequest).toHaveBeenCalledWith(
      'thread-codex',
      'req-1',
      'accept',
    );
  });

  // archive#3473 paths 3/4: a codex deferred-retriable `runtime.error`
  // (willRetry) must not make Stop a silent no-op. Before this fix,
  // `interruptUserTurnCooperatively` re-derived "no active turn" from the
  // same fold `hasActiveTurn` intentionally under-reports through and
  // early-returned WITHOUT ever calling `adapter.interruptTurn`.
  test('Stop still reaches adapter.interruptTurn through a codex deferred-retriable runtime.error', async () => {
    const codex = new FakeAdapter('codex');
    const routingService = new OrchestrationService({
      adapterRegistry: createRegistry([bedrock, claude, codex]),
      eventBus,
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    codex.sessions.set('thread-codex-retry', {
      provider: 'codex',
      threadId: 'thread-codex-retry',
      status: 'running',
      createdAt: '2026-08-18T00:00:00.000Z',
      updatedAt: '2026-08-18T00:00:00.000Z',
    });
    eventStore.appendEvent({
      eventId: 'retry-turn-started',
      provider: 'codex',
      threadId: 'thread-codex-retry',
      turnId: 'turn-1',
      createdAt: '2026-08-18T00:00:01.000Z',
      method: 'turn.started',
      prompt: 'go',
    });
    eventStore.appendEvent({
      eventId: 'retry-runtime-error',
      provider: 'codex',
      threadId: 'thread-codex-retry',
      turnId: 'turn-1',
      createdAt: '2026-08-18T00:00:02.000Z',
      method: 'runtime.error',
      severity: 'error',
      message: 'Codex runtime error',
      retriable: true,
    });
    codex.interruptTurn.mockResolvedValueOnce({
      outcome: 'cancelled',
      turnId: 'turn-1',
    });

    // No turnId supplied — mirrors the client's `openTurnId` already having
    // been cleared client-side by the runtime.error (turnHandlers.ts).
    await routingService.dispatch({
      type: 'interruptTurn',
      threadId: 'thread-codex-retry',
    });

    expect(codex.interruptTurn).toHaveBeenCalledWith(
      'thread-codex-retry',
      'turn-1',
    );
  });

  // archive#3524: the archive#3473 fix above only closed this gap for a session's
  // FIRST turn — `firstTurnStartedWithPrompt` always retains turn 1's start,
  // so the eviction archive#3524 describes never manifested there. This is the SAME
  // scenario for a SECOND turn: before the event-store fix, the bounded fact
  // set read `{ turn.started(turn-1), runtime.error(turn-2) }` — turn-2's own
  // `turn.started` had no slot — and `interruptibleTurnIdForEvents` fell
  // through the fail-closed identity guard to `undefined`, so Stop was a
  // silent no-op for every turn after the first.
  test('Stop reaches adapter.interruptTurn through a codex deferred-retriable runtime.error on the SECOND turn (station#3524)', async () => {
    const codex = new FakeAdapter('codex');
    const routingService = new OrchestrationService({
      adapterRegistry: createRegistry([bedrock, claude, codex]),
      eventBus,
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    codex.sessions.set('thread-codex-retry-2', {
      provider: 'codex',
      threadId: 'thread-codex-retry-2',
      status: 'running',
      createdAt: '2026-08-18T00:00:00.000Z',
      updatedAt: '2026-08-18T00:00:00.000Z',
    });
    eventStore.appendEvent({
      eventId: 'first-turn-started',
      provider: 'codex',
      threadId: 'thread-codex-retry-2',
      turnId: 'turn-1',
      createdAt: '2026-08-18T00:00:01.000Z',
      method: 'turn.started',
      prompt: 'go',
    });
    eventStore.appendEvent({
      eventId: 'first-turn-completed',
      provider: 'codex',
      threadId: 'thread-codex-retry-2',
      turnId: 'turn-1',
      createdAt: '2026-08-18T00:00:02.000Z',
      method: 'turn.completed',
      finishReason: 'stop',
      outputText: 'Done.',
    });
    eventStore.appendEvent({
      eventId: 'second-turn-started',
      provider: 'codex',
      threadId: 'thread-codex-retry-2',
      turnId: 'turn-2',
      createdAt: '2026-08-18T00:00:03.000Z',
      method: 'turn.started',
      prompt: 'go again',
    });
    eventStore.appendEvent({
      eventId: 'second-turn-retriable-error',
      provider: 'codex',
      threadId: 'thread-codex-retry-2',
      turnId: 'turn-2',
      createdAt: '2026-08-18T00:00:04.000Z',
      method: 'runtime.error',
      severity: 'error',
      message: 'Codex runtime error',
      retriable: true,
    });
    codex.interruptTurn.mockResolvedValueOnce({
      outcome: 'cancelled',
      turnId: 'turn-2',
    });

    // No turnId supplied — mirrors the client's `openTurnId` already having
    // been cleared client-side by the runtime.error (turnHandlers.ts).
    await routingService.dispatch({
      type: 'interruptTurn',
      threadId: 'thread-codex-retry-2',
    });

    expect(codex.interruptTurn).toHaveBeenCalledWith(
      'thread-codex-retry-2',
      'turn-2',
    );
  });

  // Negative control: a NON-retriable codex runtime.error is a real terminal
  // fact — Stop must stay a no-op (matches pre-fix behavior, and matches
  // `activeTurnIdForEvents`/`hasActiveTurn`).
  test('Stop stays a no-op through a definitive (non-retriable) codex runtime.error', async () => {
    const codex = new FakeAdapter('codex');
    const routingService = new OrchestrationService({
      adapterRegistry: createRegistry([bedrock, claude, codex]),
      eventBus,
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    codex.sessions.set('thread-codex-terminal', {
      provider: 'codex',
      threadId: 'thread-codex-terminal',
      status: 'running',
      createdAt: '2026-08-18T00:00:00.000Z',
      updatedAt: '2026-08-18T00:00:00.000Z',
    });
    eventStore.appendEvent({
      eventId: 'terminal-turn-started',
      provider: 'codex',
      threadId: 'thread-codex-terminal',
      turnId: 'turn-1',
      createdAt: '2026-08-18T00:00:01.000Z',
      method: 'turn.started',
      prompt: 'go',
    });
    eventStore.appendEvent({
      eventId: 'terminal-runtime-error',
      provider: 'codex',
      threadId: 'thread-codex-terminal',
      turnId: 'turn-1',
      createdAt: '2026-08-18T00:00:02.000Z',
      method: 'runtime.error',
      severity: 'error',
      message: "You've hit your usage limit.",
      retriable: false,
    });

    await routingService.dispatch({
      type: 'interruptTurn',
      threadId: 'thread-codex-terminal',
    });

    expect(codex.interruptTurn).not.toHaveBeenCalled();
  });

  test('enforces mid-turn steer capability and active-turn state before adapter dispatch', async () => {
    const codex = new FakeAdapter('codex');
    const routingService = new OrchestrationService({
      adapterRegistry: createRegistry([claude, codex]),
      eventBus,
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    for (const adapter of [claude, codex]) {
      adapter.sessions.set(`thread-${adapter.provider}`, {
        provider: adapter.provider,
        threadId: `thread-${adapter.provider}`,
        status: 'running',
        createdAt: '2026-08-14T00:00:00.000Z',
        updatedAt: '2026-08-14T00:00:00.000Z',
      });
    }
    const event = (
      threadId: string,
      turnId: string,
    ): CanonicalRuntimeEvent => ({
      eventId: `event-${threadId}`,
      provider: 'claude',
      threadId,
      createdAt: '2026-08-14T00:00:00.000Z',
      method: 'turn.started',
      turnId,
      prompt: 'initial',
    });
    eventStore.appendEvent(event('thread-claude', 'turn-live'));
    claude.steerTurn.mockImplementation(async (threadId, input, turnId) => {
      eventStore.appendEvent({
        eventId: 'event-steer',
        provider: 'claude',
        threadId,
        createdAt: '2026-08-14T00:00:01.000Z',
        method: 'turn.started',
        turnId,
        prompt: input,
        inputKind: 'steer',
      });
    });

    await expect(
      routingService.dispatch({
        type: 'steerTurn',
        threadId: 'thread-claude',
        input: 'redirect',
      }),
    ).resolves.toEqual({
      outcome: 'steered',
      threadId: 'thread-claude',
      turnId: 'turn-live',
    });
    expect(claude.steerTurn).toHaveBeenCalledWith(
      'thread-claude',
      'redirect',
      'turn-live',
    );
    expect(eventStore.listEvents('thread-claude')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({
            method: 'turn.started',
            inputKind: 'steer',
            prompt: 'redirect',
          }),
        }),
      ]),
    );
    expect(
      routingService
        .readSessionMessages('thread-claude')
        .find((message) => message.metadata?.inputKind === 'steer'),
    ).toMatchObject({
      role: 'user',
      parts: [{ type: 'text', text: 'redirect' }],
      metadata: { inputKind: 'steer' },
    });

    await expect(
      routingService.dispatch({
        type: 'steerTurn',
        threadId: 'thread-codex',
        input: 'redirect',
      }),
    ).resolves.toMatchObject({
      outcome: 'unsupported-engine',
      engineId: 'codex',
      engineName: 'Codex',
    });
    expect(codex.steerTurn).not.toHaveBeenCalled();

    await expect(
      routingService.dispatch({
        type: 'steerTurn',
        threadId: 'thread-claude',
        input: 'late',
        turnId: 'stale-turn',
      }),
    ).resolves.toEqual({
      outcome: 'no-active-turn',
      threadId: 'thread-claude',
    });
    expect(claude.steerTurn).toHaveBeenCalledTimes(1);

    claude.steerTurn.mockRejectedValueOnce(new ProviderTurnEndedError());
    await expect(
      routingService.dispatch({
        type: 'steerTurn',
        threadId: 'thread-claude',
        input: 'closed-race',
      }),
    ).resolves.toEqual({
      outcome: 'no-active-turn',
      threadId: 'thread-claude',
    });

    claude.steerTurn.mockRejectedValueOnce(new Error('adapter exploded'));
    await expect(
      routingService.dispatch({
        type: 'steerTurn',
        threadId: 'thread-claude',
        input: 'failure',
      }),
    ).rejects.toBeInstanceOf(OrchestrationCommandDispatchError);
    expect(orchestrationSteerDispatches.add).toHaveBeenCalledWith(1, {
      outcome: 'failed',
      engine: 'claude',
    });
  });

  // archive#3559: steerTurn's active-turn lookup was narrowed from the
  // unbounded `listEvents(threadId)` (fewer SQL rows plus skipped
  // `JSON.parse` per excluded row — NOT attachment-blob hydration, which
  // fires only on `turn.started` and is paid identically either way; see
  // `InternalStopSuppression.arm`'s docblock for the corrected account and
  // archive#1867 for the original unbounded-read incident this narrowing is
  // still worth avoiding for) to `listEventsByMethods` scoped to exactly the
  // methods `nextActiveTurnId` inspects. This test pins two
  // things a mis-scoped method list would break: (1) `listEvents` is never
  // called on this path, and (2) the method list is COMPLETE — a
  // `turn.aborted` event really does close the turn, not just a
  // `turn.completed` one. An incomplete narrowing (e.g. omitting
  // `turn.aborted`) would still fold in only `turn.started`, leaving the
  // aborted turn reading as active and wrongly calling `adapter.steerTurn`.
  test('steerTurn resolves the active turn via listEventsByMethods, never the unbounded listEvents, and treats an aborted turn as closed (station#3559)', async () => {
    const routingService = new OrchestrationService({
      adapterRegistry: createRegistry([claude]),
      eventBus,
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    claude.sessions.set('thread-claude-aborted', {
      provider: 'claude',
      threadId: 'thread-claude-aborted',
      status: 'running',
      createdAt: '2026-08-14T00:00:00.000Z',
      updatedAt: '2026-08-14T00:00:00.000Z',
    });
    eventStore.appendEvent({
      eventId: 'event-aborted-start',
      provider: 'claude',
      threadId: 'thread-claude-aborted',
      createdAt: '2026-08-14T00:00:00.000Z',
      method: 'turn.started',
      turnId: 'turn-will-abort',
      prompt: 'initial',
    } as CanonicalRuntimeEvent);
    eventStore.appendEvent({
      eventId: 'event-aborted-abort',
      provider: 'claude',
      threadId: 'thread-claude-aborted',
      createdAt: '2026-08-14T00:00:01.000Z',
      method: 'turn.aborted',
      turnId: 'turn-will-abort',
    } as CanonicalRuntimeEvent);

    const listEventsSpy = vi.spyOn(eventStore, 'listEvents');
    const listEventsByMethodsSpy = vi.spyOn(eventStore, 'listEventsByMethods');

    await expect(
      routingService.dispatch({
        type: 'steerTurn',
        threadId: 'thread-claude-aborted',
        input: 'too late',
      }),
    ).resolves.toEqual({
      outcome: 'no-active-turn',
      threadId: 'thread-claude-aborted',
    });
    expect(claude.steerTurn).not.toHaveBeenCalled();
    expect(listEventsSpy).not.toHaveBeenCalledWith('thread-claude-aborted');
    expect(listEventsByMethodsSpy).toHaveBeenCalledWith(
      'thread-claude-aborted',
      [
        'turn.started',
        'turn.completed',
        'turn.aborted',
        'runtime.error',
        'session.exited',
      ],
    );
  });

  // archive#3559 fix round finding 5: the spy assertion above pins the exact
  // method list, but that alone does not prove the narrowing is
  // BEHAVIOURALLY bit-identical to folding the full log — dropping
  // `turn.completed`, `runtime.error`, or `session.exited` from the literal
  // would still pass a spy assertion built the same way. This is the
  // differential proof: append one event of EVERY canonical method (all 27
  // — `packages/contracts/src/runtime-events.ts`'s `CanonicalRuntimeEvent`
  // union), fold `listEvents` (the full log) and `listEventsByMethods`
  // narrowed to `ACTIVE_TURN_FOLD_METHODS` through the SAME
  // `activeTurnIdForEvents`, and assert the results agree — CHECKED AFTER
  // EVERY APPEND, not only once at the end.
  //
  // The checkpoint-per-event shape is load-bearing, not cosmetic: a fold is
  // sequential, so only the LAST turn-lifecycle event before a checkpoint
  // determines its answer — a later `turn.started` unconditionally
  // overwrites whatever an earlier terminal event did. A single
  // end-of-sequence comparison (the first version of this test) proved only
  // that the FINAL terminal method in the fixture (`turn.aborted`) mattered;
  // fault injection on the real fix round caught this: dropping
  // `session.exited` — which was positioned before any turn had opened —
  // reddened only the literal spy assertion above, not this test, because at
  // that point in the sequence excluding it was already a no-op on BOTH
  // sides. Checking after every event makes each of the 5 relevant methods
  // individually load-bearing at its own checkpoint, immediately after it
  // fires and before any subsequent `turn.started` can paper over its
  // absence.
  //
  // Independent review, delta round: everything above proves the 5 methods
  // in `ACTIVE_TURN_FOLD_METHODS` are NECESSARY — it does not prove the
  // other 22 are SAFE TO OMIT while a turn is actually open, because the
  // first pass only ever fired them before any `turn.started`, where
  // `activeTurnId` is already `undefined` on both sides and any divergence
  // is unobservable. Proven live by injection: adding a 6th method to
  // `nextActiveTurnId`'s branches (`session.stop-settled` closing the turn)
  // WITHOUT adding it to `ACTIVE_TURN_FOLD_METHODS` — exactly the future
  // change these comments warn about — passed every test in this file,
  // including this one, at 332/332 green. The remedy below replays all 22
  // no-ops a SECOND time, this time while `turn-open` is live, so a 6th
  // fold-relevant method the narrowed query excludes now diverges from the
  // full log observably (`fromNarrowed` keeps reporting the turn open,
  // `fromFullLog` does not) instead of firing into a state neither side is
  // tracking yet.
  test('listEventsByMethods(ACTIVE_TURN_FOLD_METHODS) folds bit-identically to the full listEvents log across every canonical method, checked after every event (station#3559)', () => {
    const threadId = 'differential-all-methods';
    eventStore.upsertSession({
      provider: 'claude',
      threadId,
      status: 'ready',
      createdAt: '2026-08-20T00:00:00.000Z',
      updatedAt: '2026-08-20T00:00:00.000Z',
    });

    // The 22 methods `nextActiveTurnId` treats as pass-through no-ops —
    // every canonical method NOT in `ACTIVE_TURN_FOLD_METHODS`. Typed as
    // `CanonicalRuntimeEvent['method'][]`, not a bare `as const` string
    // array, so a typo (e.g. 'tool.complete') is a compile error here at
    // zero runtime cost — a better guard than the fixed-length assertion
    // below, which only catches a WRONG COUNT, not a wrong NAME.
    //
    // What it does NOT catch: a 28th canonical method this list fails to
    // grow into. A `readonly T[]` accepts any SUBSET, so a missing member
    // typechecks, and the count assertion stays 22 on both sides — proven
    // by adding a 28th union member and getting zero new tsc errors.
    // Coverage would silently decay to 27-of-28. Real exhaustiveness needs
    // a mapped-type construction, deliberately not added: the typo guard
    // is worth having on its own, and a comment claiming protection the
    // types do not provide is worse than no comment.
    const NON_FOLD_METHODS: readonly CanonicalRuntimeEvent['method'][] = [
      'session.started',
      'session.configured',
      'session.state-changed',
      'session.stop-settled',
      'content.text-delta',
      'content.reasoning-delta',
      'tool.started',
      'tool.progress',
      'tool.completed',
      'request.opened',
      'request.resolved',
      'runtime.warning',
      'token-usage.updated',
      'flow.run-attached',
      'flow.gate-verdict',
      'policy.hooks-attached',
      'policy.stop-verdict',
      'platform.mutation',
      'workflow.state-changed',
      'plan.updated',
      'extension.notification',
      'conversation.forked',
    ];
    // 22 no-ops + the 5 fold-relevant methods = all 27 canonical methods.
    // Deliberately a fixed literal, NOT `27 - ACTIVE_TURN_FOLD_METHODS.length`
    // — that form was tried first and self-defeated the differential proof
    // below: shrinking `ACTIVE_TURN_FOLD_METHODS` (the exact injection this
    // test exists to catch) also shrinks the expected side of THIS
    // assertion, so it fails here on a count mismatch instead of failing
    // below on an actual fold divergence, and the failure message stops
    // naming which method or turn was affected.
    expect(NON_FOLD_METHODS.length).toBe(22);

    let seq = 0;
    let ts = Date.parse('2026-08-20T00:00:00.000Z');
    const append = (
      method: string,
      extra: Record<string, unknown> = {},
    ): void => {
      eventStore.appendEvent({
        eventId: `evt-differential-${seq++}`,
        provider: 'claude',
        threadId,
        createdAt: new Date(ts++).toISOString(),
        method,
        ...extra,
      } as unknown as CanonicalRuntimeEvent);
    };
    const assertFoldsAgree = (expected: string | undefined): void => {
      const fromFullLog = activeTurnIdForEvents(
        eventStore.listEvents(threadId).map((stored) => stored.payload),
      );
      const fromNarrowed = activeTurnIdForEvents(
        eventStore
          .listEventsByMethods(threadId, ACTIVE_TURN_FOLD_METHODS)
          .map((stored) => stored.payload),
      );
      expect(fromNarrowed).toBe(fromFullLog);
      // Not just equal — pin what they equal, so a future change that
      // accidentally makes BOTH sides wrong the same way still reds here.
      expect(fromFullLog).toBe(expected);
    };

    // Every non-fold-relevant method really is a no-op on both sides, with
    // no open turn to hide a divergence behind.
    for (const method of NON_FOLD_METHODS) {
      // `request.opened`/`request.resolved` need `requestId` to satisfy
      // `EventStore.appendEvent`'s own persistence invariant
      // (`persistedRequestId` throws on an empty one) — irrelevant to the
      // fold itself.
      append(
        method,
        method === 'request.opened' || method === 'request.resolved'
          ? { requestId: 'req-differential' }
          : {},
      );
    }
    assertFoldsAgree(undefined);

    // Each of the 4 terminal methods gets its own turn, closed immediately
    // by that method and checked before the next `turn.started` can
    // overwrite the evidence.
    append('turn.started', { turnId: 'turn-completed-case' });
    assertFoldsAgree('turn-completed-case');
    append('turn.completed', { turnId: 'turn-completed-case' });
    assertFoldsAgree(undefined);

    append('turn.started', { turnId: 'turn-aborted-case' });
    assertFoldsAgree('turn-aborted-case');
    append('turn.aborted', { turnId: 'turn-aborted-case' });
    assertFoldsAgree(undefined);

    append('turn.started', { turnId: 'turn-runtime-error-case' });
    assertFoldsAgree('turn-runtime-error-case');
    append('runtime.error');
    assertFoldsAgree(undefined);

    append('turn.started', { turnId: 'turn-session-exited-case' });
    assertFoldsAgree('turn-session-exited-case');
    append('session.exited');
    assertFoldsAgree(undefined);

    // Final open turn, nothing closes it — the realistic `steerTurn`
    // mid-turn case, and proof the narrowing still reports "open" correctly
    // after every prior terminal method has already fired once.
    append('turn.started', { turnId: 'turn-open' });
    assertFoldsAgree('turn-open');

    // Replay every non-fold-relevant method a SECOND time, now while
    // `turn-open` is genuinely live — this is what proves the 22 are safe
    // to OMIT, not just that the 5 are necessary (the first pass above only
    // fired them before any turn existed, where excluding one is
    // unobservable on either side). If `nextActiveTurnId` ever gains a 6th
    // branch that closes or otherwise mutates the active turn on one of
    // these methods, without that method being added to
    // `ACTIVE_TURN_FOLD_METHODS`, this loop is where it diverges: the full
    // log would see it and close/change the turn, the narrowed query would
    // never see the row at all and keep reporting `turn-open`.
    for (const method of NON_FOLD_METHODS) {
      append(
        method,
        method === 'request.opened' || method === 'request.resolved'
          ? { requestId: 'req-differential-live' }
          : {},
      );
      assertFoldsAgree('turn-open');
    }
  });

  test('fans in adapter events from multiple providers and persists them', async () => {
    service.initialize();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const bedrockEvent: CanonicalRuntimeEvent = {
      eventId: 'evt-bedrock',
      provider: 'bedrock',
      threadId: 'thread-bedrock',
      createdAt: '2026-03-28T00:00:00.000Z',
      method: 'session.started',
      sessionId: 'thread-bedrock',
      initialState: 'created',
    };
    const claudeEvent: CanonicalRuntimeEvent = {
      eventId: 'evt-claude',
      provider: 'claude',
      threadId: 'thread-claude',
      createdAt: '2026-03-28T00:00:01.000Z',
      method: 'request.opened',
      requestId: 'req-2',
      requestType: 'approval',
      title: 'Allow Read',
    };

    bedrock.events.push(bedrockEvent);
    claude.events.push(claudeEvent);

    await waitFor(
      () => eventStore.listEvents().map((event) => event.id),
      (eventIds) =>
        eventIds.length === 2 &&
        eventIds[0] === 'evt-bedrock' &&
        eventIds[1] === 'evt-claude',
    );
    expect(eventStore.listEvents()).toEqual([
      expect.objectContaining({
        id: 'evt-bedrock',
        payload: expect.objectContaining(bedrockEvent),
      }),
      expect.objectContaining({
        id: 'evt-claude',
        payload: expect.objectContaining(claudeEvent),
      }),
    ]);
  });

  test('lists merged session read-model summaries for loaded and persisted sessions', async () => {
    service.initialize();
    await new Promise((resolve) => setTimeout(resolve, 0));
    bedrock.sessions.set('thread-bedrock', {
      provider: 'bedrock',
      threadId: 'thread-bedrock',
      status: 'running',
      model: 'nova',
      createdAt: '2026-04-11T00:00:00.000Z',
      updatedAt: '2026-04-11T00:00:01.000Z',
    });
    eventStore.upsertSession({
      provider: 'claude',
      threadId: 'thread-persisted',
      status: 'ready',
      model: 'sonnet',
      createdAt: '2026-04-11T00:00:02.000Z',
      updatedAt: '2026-04-11T00:00:03.000Z',
    });
    eventStore.appendEvent({
      provider: 'claude',
      threadId: 'thread-persisted',
      eventId: 'evt-1',
      createdAt: '2026-04-11T00:00:04.000Z',
      method: 'session.configured',
      sessionId: 'thread-persisted',
      model: 'sonnet',
    } as any);

    const sessions = await service.listSessionReadModel();

    expect(sessions).toEqual([
      expect.objectContaining({
        threadId: 'thread-bedrock',
        isLoaded: true,
        isPersisted: false,
      }),
      expect.objectContaining({
        threadId: 'thread-persisted',
        isLoaded: false,
        isPersisted: true,
        eventCount: 1,
        lastEventMethod: 'session.configured',
      }),
    ]);
  });

  test('projects the latest turn origin and honest diversity through the persisted session read model', async () => {
    const base = '2026-08-30T12:00:00.000Z';
    for (const threadId of [
      'thread-two-origins',
      'thread-no-turns',
      'thread-unattributed-turn',
      'thread-latest-unattributed',
    ]) {
      eventStore.upsertSession({
        provider: 'claude',
        threadId,
        status: 'ready',
        createdAt: base,
        updatedAt: base,
      });
    }

    const mobileDeviceOrigin = {
      version: 1 as const,
      actor: { kind: 'device' as const, deviceId: 'pixel-10' },
      reported: { version: 1 as const, surface: 'mobile' as const, build: '1' },
    };
    const desktopOperatorOrigin = {
      version: 1 as const,
      actor: { kind: 'operator' as const },
      reported: {
        version: 1 as const,
        surface: 'desktop' as const,
        build: '2',
      },
    };
    eventStore.appendEvent({
      eventId: 'origin-turn-mobile',
      provider: 'claude',
      threadId: 'thread-two-origins',
      turnId: 'turn-mobile',
      method: 'turn.started',
      createdAt: '2026-08-30T12:00:01.000Z',
      clientOrigin: mobileDeviceOrigin,
    } as any);
    eventStore.appendEvent({
      eventId: 'origin-turn-desktop-latest',
      provider: 'claude',
      threadId: 'thread-two-origins',
      turnId: 'turn-desktop',
      method: 'turn.started',
      createdAt: '2026-08-30T12:00:02.000Z',
      clientOrigin: desktopOperatorOrigin,
    } as any);
    eventStore.appendEvent({
      eventId: 'origin-turn-mobile-again',
      provider: 'claude',
      threadId: 'thread-two-origins',
      turnId: 'turn-mobile-again',
      method: 'turn.started',
      createdAt: '2026-08-30T12:00:02.500Z',
      clientOrigin: mobileDeviceOrigin,
    } as any);
    eventStore.appendEvent({
      eventId: 'origin-turn-desktop-actually-latest',
      provider: 'claude',
      threadId: 'thread-two-origins',
      turnId: 'turn-desktop-again',
      method: 'turn.started',
      createdAt: '2026-08-30T12:00:02.750Z',
      clientOrigin: desktopOperatorOrigin,
    } as any);
    eventStore.appendEvent({
      eventId: 'unattributed-turn',
      provider: 'claude',
      threadId: 'thread-unattributed-turn',
      turnId: 'turn-without-origin',
      method: 'turn.started',
      createdAt: '2026-08-30T12:00:03.000Z',
    } as any);
    eventStore.appendEvent({
      eventId: 'older-attributed-turn',
      provider: 'claude',
      threadId: 'thread-latest-unattributed',
      turnId: 'turn-older-attributed',
      method: 'turn.started',
      createdAt: '2026-08-30T12:00:04.000Z',
      clientOrigin: mobileDeviceOrigin,
    } as any);
    eventStore.appendEvent({
      eventId: 'latest-unattributed-turn',
      provider: 'claude',
      threadId: 'thread-latest-unattributed',
      turnId: 'turn-latest-unattributed',
      method: 'turn.started',
      createdAt: '2026-08-30T12:00:05.000Z',
    } as any);

    const sessions = await service.listSessionReadModel();
    const byThread = new Map(
      sessions.map((session) => [session.threadId, session]),
    );

    // The intentionally later desktop event makes this fail if the fold takes
    // the first attributed turn rather than the most recent turn.
    expect(byThread.get('thread-two-origins')?.turnOrigin).toEqual({
      latest: desktopOperatorOrigin,
      hasOtherOrigins: true,
    });
    // Absence is structural: neither case can masquerade as a concrete
    // `{ actor: unknown, surface: unknown }` value in a renderer.
    expect(byThread.get('thread-no-turns')).not.toHaveProperty('turnOrigin');
    expect(byThread.get('thread-unattributed-turn')).not.toHaveProperty(
      'turnOrigin',
    );
    expect(byThread.get('thread-latest-unattributed')).not.toHaveProperty(
      'turnOrigin',
    );
  });

  test('reads one session detail with canonical event history', async () => {
    eventStore.upsertSession({
      provider: 'claude',
      threadId: 'thread-detail',
      status: 'ready',
      model: 'sonnet',
      createdAt: '2026-04-11T00:00:00.000Z',
      updatedAt: '2026-04-11T00:00:01.000Z',
    });
    eventStore.appendEvent({
      provider: 'claude',
      threadId: 'thread-detail',
      eventId: 'evt-1',
      createdAt: '2026-04-11T00:00:02.000Z',
      method: 'turn.started',
      turnId: 'turn-1',
    } as any);
    eventStore.appendEvent({
      provider: 'claude',
      threadId: 'thread-detail',
      eventId: 'evt-2',
      createdAt: '2026-04-11T00:00:03.000Z',
      method: 'turn.completed',
      turnId: 'turn-1',
      finishReason: 'stop',
    } as any);

    const detail = await service.readSession('thread-detail');

    expect(detail).toEqual({
      session: expect.objectContaining({
        threadId: 'thread-detail',
        isPersisted: true,
        eventCount: 2,
        lastEventMethod: 'turn.completed',
      }),
      events: [
        expect.objectContaining({ method: 'turn.started', turnId: 'turn-1' }),
        expect.objectContaining({
          method: 'turn.completed',
          turnId: 'turn-1',
          finishReason: 'stop',
        }),
      ],
    });
  });

  test('aggregates a root conversation and rejects a child session id as a conversation fallback', async () => {
    const rootId = 'conversation-window-root';
    const childId = 'conversation-window-child';
    eventStore.upsertSession({
      provider: 'codex',
      threadId: rootId,
      status: 'closed',
      createdAt: '2026-08-24T01:00:00.000Z',
      updatedAt: '2026-08-24T01:00:01.000Z',
    });
    eventStore.appendEvent({
      provider: 'codex',
      threadId: rootId,
      eventId: 'root-configured',
      createdAt: '2026-08-24T01:00:01.500Z',
      method: 'session.configured',
      sessionId: rootId,
      metadata: {
        agentSlug: 'codex',
        agentName: 'Historical Codex',
        agentIcon: 'terminal',
      },
    });
    eventStore.appendEvent({
      provider: 'codex',
      threadId: rootId,
      eventId: 'root-configured-later-without-presentation',
      createdAt: '2026-08-24T01:00:04.000Z',
      method: 'session.configured',
      sessionId: rootId,
      metadata: { agentSlug: 'codex' },
    });
    eventStore.reserveConversationHandoff({
      conversationId: rootId,
      predecessorSessionId: rootId,
      sessionId: childId,
      idempotencyKey: 'handoff-window-key',
      targetAgentId: 'claude',
      targetEnvironmentId: 'environment-current',
      targetConnectionId: 'claude',
      targetModelId: 'gpt-5',
      messageDigest: 'handoff-window-digest',
      createdAt: '2026-08-24T01:00:02.000Z',
    });
    eventStore.upsertSession({
      provider: 'codex',
      threadId: childId,
      status: 'closed',
      createdAt: '2026-08-24T01:00:02.000Z',
      updatedAt: '2026-08-24T01:00:03.000Z',
    });
    eventStore.appendEvent({
      provider: 'claude',
      threadId: childId,
      eventId: 'child-configured',
      createdAt: '2026-08-24T01:00:03.500Z',
      method: 'session.configured',
      sessionId: childId,
      metadata: {
        agentSlug: 'claude',
        agentName: 'Historical Claude',
        agentIcon: 'sparkles',
      },
    });
    eventStore.appendEvent({
      provider: 'claude',
      threadId: childId,
      eventId: 'child-configured-later-without-presentation',
      createdAt: '2026-08-24T01:00:04.500Z',
      method: 'session.configured',
      sessionId: childId,
      metadata: { agentSlug: 'claude' },
    });
    for (const [threadId, turnId, prompt] of [
      [rootId, 'turn-root', 'first question'],
      [childId, 'turn-child', 'second question'],
    ] as const) {
      eventStore.appendEvent({
        provider: 'codex',
        threadId,
        turnId,
        eventId: `${turnId}-started`,
        createdAt: '2026-08-24T01:00:04.000Z',
        method: 'turn.started',
        prompt,
      });
    }

    const root = await service.readConversationEventWindow(rootId, {
      authority: INTERNAL_SESSION_READ_SCOPE,
      turnLimit: 10,
    });
    const child = await service.readConversationEventWindow(childId, {
      authority: INTERNAL_SESSION_READ_SCOPE,
      turnLimit: 10,
    });

    expect(root?.conversationId).toBe(rootId);
    expect(root?.currentSessionId).toBe(childId);
    expect(root?.sessionLineage).toEqual([
      {
        sessionId: rootId,
        agentSlug: 'codex',
        agentDisplayName: 'Historical Codex',
        agentIcon: 'terminal',
      },
      {
        sessionId: childId,
        agentSlug: 'claude',
        agentDisplayName: 'Historical Claude',
        agentIcon: 'sparkles',
      },
    ]);
    expect(root?.events.map((item) => item.event.threadId)).toEqual([
      rootId,
      childId,
    ]);
    expect(root?.handoffs).toEqual([
      expect.objectContaining({
        predecessorSessionId: rootId,
        sessionId: childId,
        targetAgentId: 'claude',
        targetConnectionId: 'claude',
        targetModelId: 'gpt-5',
        carried: [
          'authorizedTranscript',
          'ownerTenantWorkspace',
          'targetAgentModel',
        ],
        reset: expect.arrayContaining([
          'providerNativeCursor',
          'taskWorkflowReferences',
        ]),
      }),
    ]);
    expect(child).toBeNull();
  });

  test.each([
    ['reserved', undefined],
    ['failed', 'failed'],
    ['indeterminate', 'indeterminate'],
  ] as const)(
    'reload reads a %s boundary through its authorized predecessor while retaining the child identity',
    async (_label, transition) => {
      const rootId = `conversation-window-boundary-${_label}`;
      const childId = `${rootId}:child`;
      eventStore.upsertSession({
        provider: 'claude',
        threadId: rootId,
        status: 'closed',
        createdAt: '2026-08-25T00:00:00.000Z',
        updatedAt: '2026-08-25T00:00:00.000Z',
      });
      eventStore.appendEvent({
        provider: 'claude',
        threadId: rootId,
        eventId: `${rootId}:turn`,
        turnId: `${rootId}:turn`,
        createdAt: '2026-08-25T00:00:01.000Z',
        method: 'turn.started',
        prompt: 'persisted predecessor transcript',
      });
      eventStore.reserveConversationContextBoundary({
        boundaryId: `boundary-window-${_label}`,
        conversationId: rootId,
        predecessorSessionId: rootId,
        successorSessionId: childId,
        idempotencyKey: `boundary-window-${_label}`,
        policy: 'empty-next-cold-start',
        status: 'reserved',
        actorId: 'owner-user',
        createdAt: '2026-08-25T00:00:02.000Z',
      });
      if (transition) {
        service.claimConversationContextBoundaryColdStart(
          `boundary-window-${_label}`,
          `start-window-${_label}`,
        );
        service.releaseConversationContextBoundaryFailedClaim(
          `boundary-window-${_label}`,
          transition === 'indeterminate',
        );
      }

      const window = await service.readConversationEventWindow(rootId, {
        authority: INTERNAL_SESSION_READ_SCOPE,
        turnLimit: 10,
      });

      expect(window).toMatchObject({
        conversationId: rootId,
        currentSessionId: childId,
        session: { threadId: rootId },
      });
      expect(window?.events).toEqual([
        expect.objectContaining({
          event: expect.objectContaining({
            threadId: rootId,
            eventId: `${rootId}:turn`,
          }),
        }),
      ]);
    },
  );

  test('fails closed for a missing latest child without an exact boundary or handoff', async () => {
    const rootId = 'conversation-window-unrelated-child';
    eventStore.upsertSession({
      provider: 'claude',
      threadId: rootId,
      status: 'closed',
      createdAt: '2026-08-25T00:00:00.000Z',
      updatedAt: '2026-08-25T00:00:00.000Z',
    });
    eventStore.reserveNextConversationSession({
      conversationId: rootId,
      predecessorSessionId: rootId,
      proposedSessionId: `${rootId}:missing`,
      createdAt: '2026-08-25T00:00:01.000Z',
    });

    await expect(
      service.readConversationEventWindow(rootId, {
        authority: INTERNAL_SESSION_READ_SCOPE,
        turnLimit: 10,
      }),
    ).resolves.toBeNull();
  });

  test.each(['boundary', 'handoff'] as const)(
    'does not fold a materialized foreign-owner/tenant %s child through its predecessor',
    async (kind) => {
      const rootId = `conversation-window-denied-${kind}`;
      const childId = `${rootId}:child`;
      const alpha = {
        tenantId: 'tenant-alpha' as any,
        source: 'request' as const,
      };
      const bravo = {
        tenantId: 'tenant-bravo' as any,
        source: 'request' as const,
      };
      eventStore.upsertSession({
        provider: 'claude',
        threadId: rootId,
        status: 'closed',
        tenantExecutionContext: alpha,
        createdAt: '2026-08-25T00:00:00.000Z',
        updatedAt: '2026-08-25T00:00:00.000Z',
      });
      eventStore.appendEvent({
        eventId: `${rootId}:configured`,
        provider: 'claude',
        threadId: rootId,
        sessionId: rootId,
        createdAt: '2026-08-25T00:00:01.000Z',
        method: 'session.configured',
        metadata: { userId: 'owner-user' },
      });
      if (kind === 'boundary') {
        eventStore.reserveConversationContextBoundary({
          boundaryId: `${kind}-denied`,
          conversationId: rootId,
          predecessorSessionId: rootId,
          successorSessionId: childId,
          idempotencyKey: `${kind}-denied`,
          policy: 'empty-next-cold-start',
          status: 'reserved',
          actorId: 'owner-user',
          createdAt: '2026-08-25T00:00:02.000Z',
        });
      } else {
        eventStore.reserveConversationHandoff({
          conversationId: rootId,
          predecessorSessionId: rootId,
          sessionId: childId,
          idempotencyKey: `${kind}-denied`,
          targetAgentId: 'codex',
          targetEnvironmentId: 'environment-a',
          messageDigest: 'message-a',
          createdAt: '2026-08-25T00:00:02.000Z',
        });
      }
      eventStore.upsertSession({
        provider: 'claude',
        threadId: childId,
        status: 'closed',
        tenantExecutionContext: bravo,
        createdAt: '2026-08-25T00:00:03.000Z',
        updatedAt: '2026-08-25T00:00:03.000Z',
      });
      eventStore.appendEvent({
        eventId: `${childId}:configured`,
        provider: 'claude',
        threadId: childId,
        sessionId: childId,
        createdAt: '2026-08-25T00:00:04.000Z',
        method: 'session.configured',
        metadata: { userId: 'foreign-user' },
      });
      const registry = parseHostedTenantRegistry({
        schemaVersion: 1,
        tenants: [
          { id: 'tenant-alpha' as any, authority: 'alpha.station.test' },
        ],
      });
      const hosted = new OrchestrationService({
        adapterRegistry: createRegistry([bedrock, claude]),
        eventBus: new EventBus(),
        eventStore,
        requireTenantExecutionContext: () => true,
        validateRecoveredTenantExecutionContext: (context) =>
          context?.tenantId === alpha.tenantId ? context : undefined,
        logger: { debug: vi.fn(), warn: vi.fn() },
      });

      await expect(
        hosted.readConversationEventWindow(rootId, {
          authority: sessionReadAuthorityFromRequest(
            'owner-user',
            { tenantId: alpha.tenantId },
            registry,
          ),
          turnLimit: 10,
        }),
      ).resolves.toBeNull();
    },
  );

  test('keeps the explicit one-session fallback for an unlinked legacy record', async () => {
    const legacyId = 'conversation-window-legacy';
    eventStore.upsertSession({
      provider: 'codex',
      threadId: legacyId,
      status: 'closed',
      createdAt: '2026-08-24T01:01:00.000Z',
      updatedAt: '2026-08-24T01:01:01.000Z',
    });
    eventStore.appendEvent({
      provider: 'codex',
      threadId: legacyId,
      turnId: 'turn-legacy',
      eventId: 'turn-legacy-started',
      createdAt: '2026-08-24T01:01:02.000Z',
      method: 'turn.started',
      prompt: 'legacy question',
    });
    service.initialize();
    const database = new DatabaseSync(join(tmp, 'orchestration.sqlite'));
    database
      .prepare(
        'DELETE FROM orchestration_conversation_sessions WHERE session_id = ?',
      )
      .run(legacyId);
    database.close();

    const legacy = await service.readConversationEventWindow(legacyId, {
      authority: INTERNAL_SESSION_READ_SCOPE,
      turnLimit: 10,
    });

    expect(legacy?.conversationId).toBe(legacyId);
    expect(legacy?.currentSessionId).toBe(legacyId);
    expect(legacy?.events.map((item) => item.event.eventId)).toEqual([
      'turn-legacy-started',
    ]);
  });

  test('reads a bounded sequenced event page while retaining full session summary', async () => {
    eventStore.upsertSession({
      provider: 'codex',
      threadId: 'thread-page',
      status: 'running',
      createdAt: '2026-04-11T00:00:00.000Z',
      updatedAt: '2026-04-11T00:00:04.000Z',
    });
    const events: CanonicalRuntimeEvent[] = [
      {
        provider: 'codex',
        threadId: 'thread-page',
        eventId: 'evt-1',
        createdAt: '2026-04-11T00:00:01.000Z',
        method: 'session.configured',
        sessionId: 'thread-page',
        metadata: {
          taskId: 'thread-page',
          environmentId: 'environment-current',
          environmentName: 'Current environment',
          targetKind: 'agent-app',
          targetId: 'codex',
          userId: 'user-1',
        },
      },
      {
        provider: 'codex',
        threadId: 'thread-page',
        eventId: 'evt-2',
        createdAt: '2026-04-11T00:00:02.000Z',
        method: 'turn.started',
        turnId: 'turn-1',
        prompt: 'private prompt',
      },
      {
        provider: 'codex',
        threadId: 'thread-page',
        eventId: 'evt-3',
        createdAt: '2026-04-11T00:00:03.000Z',
        method: 'content.text-delta',
        itemId: 'item-1',
        delta: 'hello',
      },
    ];
    events.forEach((event) => eventStore.appendEvent(event));

    const page = await service.readSessionEventPage(
      'thread-page',
      {
        afterSequence: 1,
        limit: 1,
      },
      personalReadAuthority('user-1'),
    );

    expect(page).toEqual({
      session: expect.objectContaining({
        threadId: 'thread-page',
        eventCount: 3,
        delegation: {
          taskId: 'thread-page',
          environmentId: 'environment-current',
          environmentName: 'Current environment',
          targetKind: 'agent-app',
          targetId: 'codex',
        },
      }),
      events: [
        {
          sequence: 2,
          event: expect.objectContaining({
            eventId: 'evt-2',
            method: 'turn.started',
          }),
        },
      ],
      hasMore: true,
      nextSequence: 2,
    });
    await expect(
      service.readSessionEventPage(
        'thread-page',
        {
          afterSequence: 0,
          limit: 1,
        },
        personalReadAuthority('user-2'),
      ),
    ).resolves.toBeNull();
  });

  test('readSessionEventPage discovers an adapter-only session through the listSessions fan-out (slice 5 I7 guard)', async () => {
    // The page read's first line — `await listSessions(INTERNAL)` — LOOKS
    // like dead code because its return value is discarded. It is not: the
    // fan-out `trackSession`s every adapter session into the read model,
    // which is the ONLY way a session that has never been persisted via
    // `upsertSession` becomes readable here. Every other fixture on this
    // path seeds the store first, so deleting that call stayed green
    // (seam-map C9 trap; slice-5 plan injection I7). This fixture seeds the
    // ADAPTER only.
    const threadId = 'thread-adapter-only-page';
    claude.sessions.set(threadId, {
      provider: 'claude',
      threadId,
      status: 'running',
      createdAt: '2026-04-11T00:00:00.000Z',
      updatedAt: '2026-04-11T00:00:01.000Z',
    });
    eventStore.appendEvent({
      provider: 'claude',
      threadId,
      eventId: 'evt-adapter-only-1',
      createdAt: '2026-04-11T00:00:01.000Z',
      method: 'turn.started',
      turnId: 'turn-1',
      prompt: 'seed',
    });

    // No explicit authority: the suite Proxy injects INTERNAL, matching the
    // InternalObserver declaration (the typed third param takes only a
    // SessionReadAuthority).
    const page = await service.readSessionEventPage(threadId, {
      afterSequence: 0,
      limit: 10,
    });
    expect(page).not.toBeNull();
    expect(page?.session.threadId).toBe(threadId);
    expect(page?.session.provider).toBe('claude');
  });

  test('keeps summary facts older than a turn window (station#1867)', async () => {
    const threadId = 'thread-window-summary-facts';
    eventStore.upsertSession({
      provider: 'claude',
      threadId,
      status: 'ready',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    });
    eventStore.appendEvent({
      provider: 'claude',
      threadId,
      eventId: 'window-configured-first',
      createdAt: '2026-08-01T00:00:01.000Z',
      method: 'session.configured',
      sessionId: threadId,
      metadata: { taskId: 'task-before-the-window' },
    } as never);
    eventStore.appendEvent({
      provider: 'claude',
      threadId,
      turnId: 'turn-window-old',
      eventId: 'window-old-turn',
      createdAt: '2026-08-01T00:00:02.000Z',
      method: 'turn.started',
      prompt: 'old turn',
    } as never);
    eventStore.appendEvent({
      provider: 'claude',
      threadId,
      turnId: 'turn-window-new',
      eventId: 'window-new-turn',
      createdAt: '2026-08-01T00:00:03.000Z',
      method: 'turn.started',
      prompt: 'new turn',
    } as never);

    const window = await service.readSessionEventWindow(threadId, {
      turnLimit: 1,
      authority: INTERNAL_SESSION_READ_SCOPE,
    });

    expect(window?.events.map((entry) => entry.event.eventId)).toEqual([
      'window-new-turn',
    ]);
    expect(window?.session.delegation).toMatchObject({
      taskId: 'task-before-the-window',
    });
  });

  /**
   * archive#3386. The store labels which budget withheld an event's payload;
   * this mapper is where that label had to survive, and where dropping it
   * would have left the marker true server-side and absent on the wire — the
   * exact shape of the defect it exists to close.
   */
  test("forwards the store's per-event elision label onto the wire", async () => {
    const threadId = 'thread-window-elision';
    eventStore.upsertSession({
      provider: 'claude',
      threadId,
      status: 'ready',
      createdAt: '2026-08-19T00:00:00.000Z',
      updatedAt: '2026-08-19T00:00:00.000Z',
    });
    eventStore.appendEvent({
      provider: 'claude',
      threadId,
      turnId: 'turn-elided',
      eventId: 'window-elided-turn',
      createdAt: '2026-08-19T00:00:01.000Z',
      method: 'turn.started',
      // Past `snapshotEvent`'s serialized ceiling.
      prompt: 'p'.repeat(8_000),
    } as never);
    eventStore.appendEvent({
      provider: 'claude',
      threadId,
      turnId: 'turn-elided',
      eventId: 'window-whole-tool',
      createdAt: '2026-08-19T00:00:02.000Z',
      method: 'tool.completed',
      toolCallId: 'tool-1',
      output: 'short',
    } as never);

    const window = await service.readSessionEventWindow(threadId, {
      turnLimit: 1,
      authority: INTERNAL_SESSION_READ_SCOPE,
    });

    const byId = new Map(
      (window?.events ?? []).map((entry) => [entry.event.eventId, entry]),
    );
    const elidedTurn = byId.get('window-elided-turn');
    expect(elidedTurn?.elided).toBe('byte_limit');
    expect((elidedTurn?.event as { prompt?: string })?.prompt).toBeUndefined();
    // Absence is the other half of the contract: a whole event must not
    // carry a label, or the label distinguishes nothing.
    expect(byId.get('window-whole-tool')?.elided).toBeUndefined();
  });

  test('scopes session reads and existing-session commands to the recorded owner', async () => {
    eventStore.upsertSession({
      provider: 'claude',
      threadId: 'thread-ownerless',
      status: 'ready',
      createdAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:01.000Z',
    });
    await expect(
      service.readSession(
        'thread-ownerless',
        personalReadAuthority('owner-user'),
      ),
    ).resolves.toBeNull();

    const ownedSession: ProviderSession = {
      provider: 'bedrock',
      threadId: 'thread-owned',
      status: 'ready',
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:01.000Z',
    };
    bedrock.sessions.set(ownedSession.threadId, ownedSession);
    eventStore.upsertSession(ownedSession);
    eventStore.appendEvent({
      provider: 'bedrock',
      threadId: ownedSession.threadId,
      eventId: 'evt-owned',
      createdAt: '2026-07-22T00:00:00.000Z',
      method: 'session.configured',
      sessionId: ownedSession.threadId,
      metadata: { userId: 'owner-user' },
    } as CanonicalRuntimeEvent);

    await expect(
      service.listSessions(personalReadAuthority('other-user')),
    ).resolves.toEqual([]);
    await expect(
      service.listSessionReadModel(personalReadAuthority('other-user')),
    ).resolves.toEqual([]);
    await expect(
      service.readSession(
        ownedSession.threadId,
        personalReadAuthority('other-user'),
      ),
    ).resolves.toBeNull();
    expect(
      service.readSessionMessages(
        ownedSession.threadId,
        personalReadAuthority('other-user'),
      ),
    ).toEqual([]);
    const unauthorizedCommands: OrchestrationCommand[] = [
      {
        type: 'sendTurn',
        input: { threadId: ownedSession.threadId, input: 'private' },
      },
      {
        type: 'interruptTurn',
        threadId: ownedSession.threadId,
        turnId: 'turn-private',
      },
      {
        type: 'respondToRequest',
        threadId: ownedSession.threadId,
        requestId: 'request-private',
        decision: 'decline',
      },
      { type: 'stopSession', threadId: ownedSession.threadId },
      { type: 'adoptSession', sourceThreadId: ownedSession.threadId },
    ];
    for (const command of unauthorizedCommands) {
      await expect(
        service.dispatchWithReceipt(command, { userId: 'other-user' }),
      ).rejects.toThrow(`Session not found: ${ownedSession.threadId}`);
    }
    await expect(
      service.dispatchWithReceipt(
        {
          type: 'startSession',
          input: {
            provider: 'bedrock',
            threadId: ownedSession.threadId,
          },
        },
        { userId: 'other-user' },
      ),
    ).rejects.toThrow(`Session not found: ${ownedSession.threadId}`);
    await expect(
      service.sessionLifecycles.transition({
        threadId: ownedSession.threadId,
        authority: personalReadAuthority('other-user'),
        to: 'blocked',
      }),
    ).rejects.toThrow(`Session not found: ${ownedSession.threadId}`);
    expect(bedrock.sendTurn).not.toHaveBeenCalled();
    expect(bedrock.interruptTurn).not.toHaveBeenCalled();
    expect(bedrock.respondToRequest).not.toHaveBeenCalled();
    expect(bedrock.stopSession).not.toHaveBeenCalled();
    expect(bedrock.adoptSession).not.toHaveBeenCalled();

    await expect(
      service.listSessions(personalReadAuthority('owner-user')),
    ).resolves.toEqual([
      expect.objectContaining({
        provider: 'bedrock',
        threadId: ownedSession.threadId,
        status: 'ready',
      }),
    ]);
    await expect(
      service.readSession(
        ownedSession.threadId,
        personalReadAuthority('owner-user'),
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        session: expect.objectContaining({ threadId: ownedSession.threadId }),
      }),
    );
  });

  describe('session-owner cache (station#1120)', () => {
    // `sessionOwnerCacheOps` is a module-level mock shared across every
    // test in this file (accumulates calls unless cleared) — start each
    // test in this block with a clean call log so assertions below only
    // reflect that test's own lookups.
    beforeEach(() => {
      vi.mocked(sessionOwnerCacheOps.add).mockClear();
      // `consumeCurrentAdapterEvents()` only starts draining `claude.events`
      // once the service is initialized — must run before any push below.
      service.initialize();
    });

    // Mirrors the shape of the `/events` SSE route's per-event,
    // per-connected-client `canUserReadSession` gate
    // (orchestration.ts ~:879), which is what motivated the cache.
    function pushSessionConfigured(
      threadId: string,
      ownerUserId: string,
      eventId = `evt-configured-${threadId}`,
    ): void {
      claude.events.push({
        eventId,
        provider: 'claude',
        threadId,
        createdAt: '2026-07-28T00:00:00.000Z',
        method: 'session.configured',
        sessionId: threadId,
        metadata: { userId: ownerUserId },
      } as CanonicalRuntimeEvent);
    }

    test('a burst of N events for one thread performs exactly ONE ownership resolution against the store, not N', async () => {
      pushSessionConfigured('thread-burst', 'owner-user');
      await waitFor(
        () => eventStore.listEvents('thread-burst').length,
        (count) => count > 0,
      );

      // archive#3495: ownership resolution is now a single SQL read that
      // returns at most one row (same predicate, same ordering, same first
      // hit as the scan it replaces). The amplification property this suite
      // exists to pin is unchanged — count the store read that actually
      // happens.
      const listEventsSpy = vi.spyOn(eventStore, 'findSessionOwnerUserId');
      const burstSize = 50;
      for (let i = 0; i < burstSize; i += 1) {
        expect(
          service.canUserReadSession(
            'thread-burst',
            personalReadAuthority('owner-user'),
          ),
        ).toBe(true);
      }

      const callsForThread = listEventsSpy.mock.calls.filter(
        (call) => call[0] === 'thread-burst',
      );
      expect(callsForThread).toHaveLength(1);
      expect(sessionOwnerCacheOps.add).toHaveBeenCalledWith(1, {
        outcome: 'miss',
      });
      expect(sessionOwnerCacheOps.add).toHaveBeenCalledWith(1, {
        outcome: 'hit',
      });
      const hitCalls = (sessionOwnerCacheOps.add as any).mock.calls.filter(
        ([, attrs]: [number, { outcome: string }]) => attrs.outcome === 'hit',
      );
      expect(hitCalls).toHaveLength(burstSize - 1);
      listEventsSpy.mockRestore();
    });

    test('preserves identical allow/deny outcomes for owner, non-owner, and unknown-thread cases', async () => {
      pushSessionConfigured('thread-owned', 'owner-a');
      await waitFor(
        () => eventStore.listEvents('thread-owned').length,
        (count) => count > 0,
      );

      // Owner: allowed, and allowed again from the cache.
      expect(
        service.canUserReadSession(
          'thread-owned',
          personalReadAuthority('owner-a'),
        ),
      ).toBe(true);
      expect(
        service.canUserReadSession(
          'thread-owned',
          personalReadAuthority('owner-a'),
        ),
      ).toBe(true);
      // Non-owner: denied, including on a cache hit for the thread's owner
      // entry (the cache is keyed by thread, not by requester, so a
      // cache hit still re-compares against the correct owner).
      expect(
        service.canUserReadSession(
          'thread-owned',
          personalReadAuthority('other-user'),
        ),
      ).toBe(false);
      // Unknown thread: never seen by the store at all — falls through to
      // a full (miss) read every time and is denied by this suite's
      // default `ownerlessSessionAccess` (fail-closed, unset === deny).
      expect(
        service.canUserReadSession(
          'thread-never-existed',
          personalReadAuthority('anyone'),
        ),
      ).toBe(false);
      expect(
        service.canUserReadSession(
          'thread-never-existed',
          personalReadAuthority('anyone'),
        ),
      ).toBe(false);
    });

    test('a cache hit for a thread whose latest event is a read-only-attached (ownerless) envelope stays denied, never cached positive', async () => {
      // A read-only-attached session's session.started/session.configured
      // envelope never carries metadata.userId (attached-session-follow-
      // service.ts's attachedSessionEnvelope) — sessionOwnerUserId must
      // keep returning undefined (never caching a stand-in owner), so
      // access stays denied under this suite's default deny policy on
      // every call, not just the first.
      claude.events.push({
        eventId: 'evt-attached-started',
        provider: 'claude',
        threadId: 'thread-attached',
        createdAt: '2026-07-28T00:00:00.000Z',
        method: 'session.started',
        sessionId: 'thread-attached',
        initialState: 'created',
        metadata: { controlMode: 'read-only-attached' },
      } as CanonicalRuntimeEvent);
      await waitFor(
        () => eventStore.listEvents('thread-attached').length,
        (count) => count > 0,
      );

      // archive#3495: ownership resolution is now a single SQL read that
      // returns at most one row (same predicate, same ordering, same first
      // hit as the scan it replaces). The amplification property this suite
      // exists to pin is unchanged — count the store read that actually
      // happens.
      const listEventsSpy = vi.spyOn(eventStore, 'findSessionOwnerUserId');
      expect(
        service.canUserReadSession(
          'thread-attached',
          personalReadAuthority('anyone'),
        ),
      ).toBe(false);
      expect(
        service.canUserReadSession(
          'thread-attached',
          personalReadAuthority('anyone'),
        ),
      ).toBe(false);
      // Never cached: both calls fall through to a full store read.
      const callsForThread = listEventsSpy.mock.calls.filter(
        (call) => call[0] === 'thread-attached',
      );
      expect(callsForThread).toHaveLength(2);
      listEventsSpy.mockRestore();
    });

    test('invalidates a cached owner when a further session.configured event lands for the same thread (defense-in-depth against a stale hit)', async () => {
      pushSessionConfigured('thread-reowned', 'owner-a', 'evt-configured-1');
      await waitFor(
        () => eventStore.listEvents('thread-reowned').length,
        (count) => count > 0,
      );

      // Populate the cache with the original owner.
      expect(
        service.canUserReadSession(
          'thread-reowned',
          personalReadAuthority('owner-a'),
        ),
      ).toBe(true);
      expect(
        service.canUserReadSession(
          'thread-reowned',
          personalReadAuthority('owner-a'),
        ),
      ).toBe(true);

      // archive#4075 stage 2: `EventStore.appendEvent` now REJECTS a
      // second ownership-shaped event that disagrees with the thread's
      // first owner — the exact write-path invariant this test's own
      // comment already named as normally preventing a real owner change.
      // Reaching the "out of band" disagreement this test is actually
      // about (a stale cache hit surviving a store that somehow ended up
      // disagreeing — corruption, a hand-edit, a pre-guard migration; see
      // the guard's own docblock) now requires bypassing `appendEvent`
      // with a raw insert, not `pushSessionConfigured` a second time
      // (which the guard would correctly refuse).
      const raw = (
        eventStore as unknown as { db: InstanceType<typeof DatabaseSync> }
      ).db;
      raw
        .prepare(
          `INSERT INTO orchestration_events
            (id, provider, thread_id, method, payload, created_at, sequence, global_sequence)
           VALUES (?, 'claude', 'thread-reowned', 'session.configured', ?, ?, ?, ?)`,
        )
        .run(
          'evt-configured-2-raw',
          JSON.stringify({
            eventId: 'evt-configured-2-raw',
            provider: 'claude',
            threadId: 'thread-reowned',
            createdAt: '2026-07-28T00:00:01.000Z',
            method: 'session.configured',
            metadata: { userId: 'owner-b' },
          }),
          '2026-07-28T00:00:01.000Z',
          2,
          2,
        );

      // A further session.configured NOTIFICATION for the SAME thread,
      // through the real adapter-event path — this one AGREES with the
      // now-current (raw-inserted) owner, so the guard admits it, and its
      // arrival is what must invalidate the stale cache entry rather than
      // let a hit keep returning the old owner.
      pushSessionConfigured('thread-reowned', 'owner-b', 'evt-configured-3');
      await waitFor(
        () => eventStore.listEvents('thread-reowned').length,
        (count) => count > 2,
      );

      expect(
        service.canUserReadSession(
          'thread-reowned',
          personalReadAuthority('owner-a'),
        ),
      ).toBe(false);
      expect(
        service.canUserReadSession(
          'thread-reowned',
          personalReadAuthority('owner-b'),
        ),
      ).toBe(true);
      expect(sessionOwnerCacheOps.add).toHaveBeenCalledWith(1, {
        outcome: 'invalidated',
      });
    });

    test('bounds the cache size, evicting the least-recently-used entry once the ceiling is exceeded', async () => {
      const ceiling = 2;
      const overflowThreadId = `thread-owner-cache-overflow-${ceiling}`;
      for (let i = 0; i <= ceiling; i += 1) {
        pushSessionConfigured(`thread-owner-cache-overflow-${i}`, `owner-${i}`);
      }
      await waitFor(
        () => eventStore.listEvents(overflowThreadId).length,
        (count) => count > 0,
        // Use the service's test-only small capacity to prove the exact LRU
        // behavior without turning 2,049 serialized adapter events into a
        // host-load benchmark.
        1_000,
      );

      // Resolve+cache all ceiling+1 threads, oldest (index 0) first —
      // pushes the cache one entry past its bound and evicts index 0.
      for (let i = 0; i <= ceiling; i += 1) {
        expect(
          service.canUserReadSession(
            `thread-owner-cache-overflow-${i}`,
            personalReadAuthority(`owner-${i}`),
          ),
        ).toBe(true);
      }
      expect(sessionOwnerCacheOps.add).toHaveBeenCalledWith(1, {
        outcome: 'evicted',
      });

      // archive#3495: ownership resolution is now a single SQL read that
      // returns at most one row (same predicate, same ordering, same first
      // hit as the scan it replaces). The amplification property this suite
      // exists to pin is unchanged — count the store read that actually
      // happens.
      const listEventsSpy = vi.spyOn(eventStore, 'findSessionOwnerUserId');
      // The evicted (oldest) entry is a fresh miss again.
      expect(
        service.canUserReadSession(
          'thread-owner-cache-overflow-0',
          personalReadAuthority('owner-0'),
        ),
      ).toBe(true);
      expect(
        listEventsSpy.mock.calls.filter(
          (call) => call[0] === 'thread-owner-cache-overflow-0',
        ),
      ).toHaveLength(1);
      // The most-recently-inserted entry survived the eviction.
      expect(
        service.canUserReadSession(
          overflowThreadId,
          personalReadAuthority(`owner-${ceiling}`),
        ),
      ).toBe(true);
      expect(
        listEventsSpy.mock.calls.filter((call) => call[0] === overflowThreadId),
      ).toHaveLength(0);
      listEventsSpy.mockRestore();
    }, 15_000);
  });

  test('lists read-only agent run summaries from orchestration events', async () => {
    eventStore.upsertSession({
      provider: 'claude',
      threadId: 'thread-run',
      status: 'running',
      model: 'sonnet',
      createdAt: '2026-04-11T00:00:00.000Z',
      updatedAt: '2026-04-11T00:00:01.000Z',
    });
    eventStore.appendEvent({
      provider: 'claude',
      threadId: 'thread-run',
      eventId: 'evt-request',
      createdAt: '2026-04-11T00:00:02.000Z',
      method: 'request.opened',
      requestId: 'req-1',
      requestType: 'approval',
      title: 'Allow command',
    } as any);

    const runs = await service.listAgentRuns();
    const run = await service.readAgentRun('thread-run');

    expect(runs).toEqual([
      expect.objectContaining({
        runId: 'thread-run',
        sessionId: 'thread-run',
        providerId: 'claude',
        source: 'orchestration',
        engineExecution: 'external',
        status: 'waiting_for_approval',
        retryEligible: false,
      }),
    ]);
    expect(run).toMatchObject({
      runId: 'thread-run',
      status: 'waiting_for_approval',
    });
  });

  test('lists project-scoped session board rows and enforces lifecycle transitions', async () => {
    eventStore.upsertSession({
      provider: 'claude',
      threadId: 'thread-board',
      status: 'running',
      model: 'sonnet',
      createdAt: '2026-05-03T10:00:00.000Z',
      updatedAt: '2026-05-03T10:00:01.000Z',
    });
    eventStore.appendEvent({
      provider: 'claude',
      threadId: 'thread-board',
      eventId: 'evt-configured',
      createdAt: '2026-05-03T10:00:00.000Z',
      method: 'session.configured',
      sessionId: 'thread-board',
      model: 'sonnet',
      metadata: { projectSlug: 'alpha', agentSlug: 'reviewer' },
    } as any);
    eventStore.appendEvent({
      provider: 'claude',
      threadId: 'thread-board',
      eventId: 'evt-review',
      createdAt: '2026-05-03T10:00:02.000Z',
      method: 'request.opened',
      requestId: 'req-board',
      requestType: 'approval',
      title: 'Review change',
    } as any);

    const rows = await service.listProjectSessionBoard('alpha');
    expect(rows).toEqual([
      expect.objectContaining({
        sessionId: 'thread-board',
        lifecycleState: 'review_pending',
        pendingReview: true,
        projectSlug: 'alpha',
        assignedAgentSlug: 'reviewer',
        agentType: 'external',
      }),
    ]);

    const transitioned = await service.sessionLifecycles.transition({
      threadId: 'thread-board',
      to: 'blocked',
      reason: 'blocked_by_user',
      source: 'user_action',
      message: 'Needs human review',
    });

    expect(transitioned).toEqual(
      expect.objectContaining({
        lifecycleState: 'blocked',
        previousLifecycleState: 'review_pending',
        blockedReason: 'Needs human review',
      }),
    );
  });

  test('lists an attached session on its configured project without delegation metadata', async () => {
    eventStore.upsertSession({
      provider: 'claude',
      threadId: 'external:claude:session-board',
      status: 'running',
      controlMode: 'read-only-attached',
      attachedSource: {
        kind: 'claude-transcript',
        externalSessionId: 'session-board',
      },
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
    });
    eventStore.appendEvent({
      provider: 'claude',
      threadId: 'external:claude:session-board',
      eventId: 'attached-session-configured',
      createdAt: '2026-07-22T00:00:00.000Z',
      method: 'session.configured',
      sessionId: 'external:claude:session-board',
      metadata: { projectSlug: 'alpha' },
    } as any);

    await expect(service.listProjectSessionBoard('alpha')).resolves.toEqual([
      expect.objectContaining({
        sessionId: 'external:claude:session-board',
        controlMode: 'read-only-attached',
        projectSlug: 'alpha',
      }),
    ]);
  });

  /**
   * archive#1090. This test used to be named "marks persisted sessions closed
   * when resume fails during recovery" and asserted `status: 'closed'` — it
   * pinned the defect. Closing was wrong in three ways, all measured on
   * origin/main (1e5b45d2) with a real ACP connection: the user got no
   * reason (the message reached the server log only, the thread's events
   * still ended at `session.configured`), the row was skipped by every later
   * recovery pass so retrying could not help, and `markSessionClosed` NULLs
   * `resume_cursor`, destroying the record of which native session the
   * transcript belonged to.
   *
   * Refusing to reopen stays correct — the ACP fingerprint check exists so a
   * running agent is never silently relocated (archive#1089) — so this asserts the
   * refusal is now legible, not that it stopped happening.
   */
  test('keeps a session recoverable and records why when resume fails during recovery (#1090)', async () => {
    claude.startSession.mockRejectedValueOnce(new Error('resume failed'));
    eventStore.upsertSession({
      provider: 'claude',
      threadId: 'thread-closed',
      status: 'running',
      model: 'claude-sonnet',
      resumeCursor: { cursor: 'resume-2' },
      createdAt: '2026-03-28T00:00:00.000Z',
      updatedAt: '2026-03-28T00:00:05.000Z',
    });

    service.initialize();
    // archive#1101: was a fixed setTimeout(0) tick. The
    // 'session.recovery.completed' receipt fires once the whole recovery
    // pass finishes regardless of per-session outcome, so it's the correct
    // signal here too — this test exercises the FAILURE path (startSession
    // rejects) rather than the happy path the other two conversions cover.
    await waitForReceipt(
      (receipt) => receipt.kind === 'session.recovery.completed',
    );
    // archive#3476: the refused resume now happens on first use. The turn
    // fails loudly rather than reporting success into nothing, and the
    // durable archive#1090 evidence below is unchanged.
    await expect(
      materializeBySendingATurn(service, 'thread-closed'),
    ).rejects.toThrow('resume failed');

    expect(eventStore.readSessions()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          threadId: 'thread-closed',
          provider: 'claude',
          status: 'error',
          // Preserved, where markSessionClosed NULLed it.
          resumeCursor: { cursor: 'resume-2' },
        }),
      ]),
    );

    const diagnostics = eventStore
      .listEvents('thread-closed')
      .map((event) => event.payload)
      .filter((payload: any) => payload.method === 'runtime.error');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      severity: 'error',
      code: 'SESSION_START_INDETERMINATE',
      retriable: false,
      message: expect.stringContaining('resume failed'),
    });
    expect(
      eventStore
        .sessionTurnBoundaryAuthority()
        .hasPossibleEffect('thread-closed'),
    ).toEqual({ kind: 'available', active: true });
  });

  test('recovery re-settles a project-bound session that was persisted without a cwd (#1011)', async () => {
    // The pre-#686 shape: a project-bound session whose persisted record has
    // no cwd. Recovery replays only what was persisted, so without
    // re-resolution the engine keeps relaunching in the SERVER's directory.
    const projectDir = join(tmp, 'project-recovered');
    mkdirSync(projectDir, { recursive: true });
    configuredProjects.push({
      slug: 'proj-recovered',
      workingDirectory: projectDir,
    });
    eventStore.upsertSession({
      provider: 'claude',
      threadId: 'thread-recovered-cwd',
      status: 'running',
      model: 'claude-sonnet',
      createdAt: '2026-07-27T00:00:00.000Z',
      updatedAt: '2026-07-27T00:00:05.000Z',
    });
    eventStore.appendEvent({
      provider: 'claude',
      threadId: 'thread-recovered-cwd',
      eventId: 'evt-recovered-started',
      createdAt: '2026-07-27T00:00:00.000Z',
      method: 'session.started',
      sessionId: 'thread-recovered-cwd',
      initialState: 'created',
      metadata: { projectSlug: 'proj-recovered' },
    } as any);

    service.initialize();
    await waitForReceipt(
      (receipt) => receipt.kind === 'session.recovery.completed',
    );
    await materializeBySendingATurn(service, 'thread-recovered-cwd');

    expect(claude.startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread-recovered-cwd',
        cwd: projectDir,
      }),
    );
  });

  describe('Flow-gated sessions', () => {
    /** Single-step definition; missing evidence blocks (no route-back). */
    const BLOCKING_DEFINITION = {
      id: 'delivery',
      version: '1',
      steps: [{ id: 'build', next: null }],
      gates: {
        'build-gate': {
          step: 'build',
          expects: [
            {
              id: 'tests-passed',
              kind: 'trust.bundle',
              required: true,
              description: 'Tests pass for the change.',
              bundle_claim: {
                claimType: 'quality.tests',
                accepted_statuses: ['assumed'],
              },
            },
          ],
        },
      },
    };

    /** Same gate but routes back on missing evidence with attempt budget. */
    const ROUTED_DEFINITION = {
      ...BLOCKING_DEFINITION,
      id: 'routed-delivery',
      gates: {
        'build-gate': {
          ...BLOCKING_DEFINITION.gates['build-gate'],
          on_route_back: {
            missing_evidence: 'build',
            default: 'build',
          },
          route_back_policy: { max_attempts: 2, on_exceeded: 'block' },
        },
      },
    };

    const flowWorkspaces: string[] = [];

    afterEach(() => {
      for (const dir of flowWorkspaces.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    function createFlowWorkspace(): string {
      const cwd = mkdtempSync(join(tmpdir(), 'orchestration-flow-'));
      flowWorkspaces.push(cwd);
      const definitionsDir = join(cwd, '.flow', 'definitions');
      mkdirSync(definitionsDir, { recursive: true });
      writeFileSync(
        join(definitionsDir, 'delivery.json'),
        JSON.stringify(BLOCKING_DEFINITION, null, 2),
      );
      writeFileSync(
        join(definitionsDir, 'routed-delivery.json'),
        JSON.stringify(ROUTED_DEFINITION, null, 2),
      );
      writeFileSync(
        join(definitionsDir, 'station-delivery.json'),
        JSON.stringify(
          { ...BLOCKING_DEFINITION, id: 'station-delivery' },
          null,
          2,
        ),
      );
      return cwd;
    }

    function writeEvidence(cwd: string, name = 'tests.json'): string {
      // Flow 1.3.x gate evidence is a Hachure TrustBundle (quality.tests at
      // status `assumed`), not a bare legacy claim file.
      writeFileSync(
        join(cwd, name),
        JSON.stringify(
          buildSyntheticTrustBundle({
            claimType: 'quality.tests',
            subjectId: 'evidence',
          }),
        ),
      );
      return name;
    }

    async function startFlowSession(
      threadId: string,
      cwd: string,
      metadata?: Record<string, unknown>,
    ): Promise<void> {
      await service.dispatch({
        type: 'startSession',
        input: {
          threadId,
          provider: 'claude',
          modelId: 'claude-sonnet',
          cwd,
          metadata: metadata ?? { flowDefinition: 'delivery' },
        },
      });
    }

    test('adoption never auto-attaches the legacy workspace Flow', async () => {
      const cwd = createFlowWorkspace();
      configuredProjects.push({ slug: 'flow', workingDirectory: cwd });
      const sourceThreadId = 'external:claude:flow-adopt';
      eventStore.upsertSession({
        provider: 'claude',
        threadId: sourceThreadId,
        status: 'ready',
        cwd,
        controlMode: 'read-only-attached',
        attachedSource: {
          kind: 'claude-transcript',
          externalSessionId: 'vendor-flow-adopt',
        },
        createdAt: '2026-07-22T00:00:00.000Z',
        updatedAt: '2026-07-22T00:00:00.000Z',
      });

      const child = await service.dispatch({
        type: 'adoptSession',
        sourceThreadId,
      });

      expect(child).toBeDefined();
      expect(
        eventStore
          .listEvents(child!.threadId)
          .map((entry) => entry.payload.method),
      ).not.toContain('flow.run-attached');
      await expect(
        service.readSessionFlowRun(child!.threadId),
      ).resolves.toBeNull();
    });

    test('adoption ignores an absent or invalid station-delivery definition', async () => {
      const cwd = createFlowWorkspace();
      writeFileSync(
        join(cwd, '.flow', 'definitions', 'station-delivery.json'),
        '{"id":"station-delivery"}',
      );
      configuredProjects.push({ slug: 'flow', workingDirectory: cwd });
      const sourceThreadId = 'external:claude:no-station-delivery';
      eventStore.upsertSession({
        provider: 'claude',
        threadId: sourceThreadId,
        status: 'ready',
        cwd,
        controlMode: 'read-only-attached',
        attachedSource: {
          kind: 'claude-transcript',
          externalSessionId: 'vendor-no-station-delivery',
        },
        createdAt: '2026-07-22T00:00:00.000Z',
        updatedAt: '2026-07-22T00:00:00.000Z',
      });

      await expect(
        service.dispatch({ type: 'adoptSession', sourceThreadId }),
      ).resolves.toMatchObject({ controlMode: 'station-owned' });

      expect(claude.adoptSession).toHaveBeenCalledOnce();
      expect(adoptionLedger.reservations()).toEqual([]);
    });

    test('does not create or discard a Flow run when child persistence fails', async () => {
      const cwd = createFlowWorkspace();
      configuredProjects.push({ slug: 'flow', workingDirectory: cwd });
      const sourceThreadId = 'external:claude:persist-failure';
      eventStore.upsertSession({
        provider: 'claude',
        threadId: sourceThreadId,
        status: 'ready',
        cwd,
        controlMode: 'read-only-attached',
        attachedSource: {
          kind: 'claude-transcript',
          externalSessionId: 'vendor-persist-failure',
        },
        createdAt: '2026-07-22T00:00:00.000Z',
        updatedAt: '2026-07-22T00:00:00.000Z',
      });
      const discardRun = vi.spyOn(flowRunService, 'discardRun');
      vi.spyOn(eventStore, 'upsertSession').mockImplementationOnce(() => {
        throw new Error('database unavailable');
      });

      await expect(
        service.dispatch({ type: 'adoptSession', sourceThreadId }),
      ).rejects.toThrow('Station could not continue this attached session');

      expect(discardRun).not.toHaveBeenCalled();
      expect(claude.discardSession).toHaveBeenCalledOnce();
    });

    async function sessionEvents(threadId: string) {
      const detail = await service.readSession(threadId);
      if (!detail) throw new Error(`Session not found: ${threadId}`);
      return detail;
    }

    test('does not auto-attach or adopt station-delivery on ordinary session start', async () => {
      const cwd = createFlowWorkspace();
      const detectWorkspace = vi.spyOn(flowRunService, 'detectWorkspace');

      await service.dispatch({
        type: 'startSession',
        input: {
          threadId: 'no-implicit-flow',
          provider: 'claude',
          modelId: 'claude-sonnet',
          cwd,
        },
      });
      await service.dispatch({
        type: 'startSession',
        input: {
          threadId: 'no-legacy-flow',
          provider: 'claude',
          modelId: 'claude-sonnet',
          cwd,
          metadata: { flowDefinition: 'station-delivery' },
        },
      });

      expect(detectWorkspace).not.toHaveBeenCalled();
      expect(await service.readSessionFlowRun('no-implicit-flow')).toBeNull();
      expect(await service.readSessionFlowRun('no-legacy-flow')).toBeNull();
      expect(
        existsSync(
          join(cwd, '.kontourai', 'flow', 'runs', 'session-no-implicit-flow'),
        ),
      ).toBe(false);
    });

    test('creates an explicitly requested standard Flow run, idempotently re-attaching', async () => {
      const cwd = createFlowWorkspace();
      await startFlowSession('flow-attach', cwd);

      expect(
        existsSync(
          join(
            cwd,
            '.kontourai',
            'flow',
            'runs',
            'session-flow-attach',
            'state.json',
          ),
        ),
      ).toBe(true);
      const detail = await sessionEvents('flow-attach');
      expect(
        detail.events.filter((event) => event.method === 'flow.run-attached'),
      ).toEqual([
        expect.objectContaining({
          method: 'flow.run-attached',
          runId: 'session-flow-attach',
          definitionId: 'delivery',
          cwd,
          resumed: false,
        }),
      ]);

      // The standard Flow definition is explicit; Station never chooses one
      // merely because a workspace contains definitions.
      const flowRun = await service.readSessionFlowRun('flow-attach');
      expect(flowRun).toMatchObject({
        runId: 'session-flow-attach',
        definitionId: 'delivery',
        cwd,
      });
      expect(flowRun?.run.state.params).toMatchObject({
        session_thread_id: 'flow-attach',
        definition_selection: 'explicit',
      });

      // Re-dispatching startSession for the same thread resumes the run.
      await startFlowSession('flow-attach', cwd);
      const afterResume = await sessionEvents('flow-attach');
      const attachEvents = afterResume.events.filter(
        (event) => event.method === 'flow.run-attached',
      );
      expect(attachEvents).toHaveLength(2);
      expect(attachEvents[1]).toMatchObject({
        runId: 'session-flow-attach',
        resumed: true,
      });
    });

    test('blocks completion while a gate is open and surfaces the exception path', async () => {
      const cwd = createFlowWorkspace();
      await startFlowSession('flow-block', cwd);

      await expect(
        service.sessionLifecycles.transition({
          threadId: 'flow-block',
          to: 'completed',
        }),
      ).rejects.toThrow(/Flow gate verdict: block/);

      const detail = await sessionEvents('flow-block');
      expect(detail.session.lifecycleState).not.toBe('completed');
      expect(
        detail.events.filter((event) => event.method === 'flow.gate-verdict'),
      ).toEqual([
        expect.objectContaining({
          verdict: 'block',
          runId: 'session-flow-block',
          gateId: 'build-gate',
          missing: ['tests-passed'],
          exceptionRequired: true,
        }),
      ]);
      expect(flowSessionGateChecks.add).toHaveBeenCalledWith(1, {
        verdict: 'block',
        definition: 'delivery',
      });
    });

    test('emits route-back guidance instead of completing when the gate routes back', async () => {
      const cwd = createFlowWorkspace();
      await startFlowSession('flow-route', cwd, {
        flowDefinition: 'routed-delivery',
      });

      const flowRun = await service.readSessionFlowRun('flow-route');
      expect(flowRun?.definitionId).toBe('routed-delivery');
      expect(flowRun?.run.state.params).toMatchObject({
        definition_selection: 'explicit',
      });

      await expect(
        service.sessionLifecycles.transition({
          threadId: 'flow-route',
          to: 'completed',
        }),
      ).rejects.toThrow(/Flow gate verdict: route-back/);

      const detail = await sessionEvents('flow-route');
      expect(detail.session.lifecycleState).not.toBe('completed');
      const verdicts = detail.events.filter(
        (event) => event.method === 'flow.gate-verdict',
      );
      expect(verdicts).toEqual([
        expect.objectContaining({
          verdict: 'route-back',
          runId: 'session-flow-route',
          gateId: 'build-gate',
          routeBackTo: 'build',
          attempt: 1,
          maxAttempts: 2,
          missing: ['tests-passed'],
        }),
      ]);
      const verdict = verdicts[0] as { nextAction?: string };
      expect(typeof verdict.nextAction).toBe('string');
      expect(verdict.nextAction?.length).toBeGreaterThan(0);
    });

    test('completes the session with a report link once all gates pass', async () => {
      const cwd = createFlowWorkspace();
      await startFlowSession('flow-pass', cwd);

      await service.attachSessionEvidence('flow-pass', {
        gate: 'build-gate',
        file: writeEvidence(cwd),
        kind: 'trust.bundle',
      });

      const session = await service.sessionLifecycles.transition({
        threadId: 'flow-pass',
        to: 'completed',
      });
      expect(session.lifecycleState).toBe('completed');

      const detail = await sessionEvents('flow-pass');
      expect(
        detail.events.filter((event) => event.method === 'flow.gate-verdict'),
      ).toEqual([
        expect.objectContaining({
          verdict: 'pass',
          runId: 'session-flow-pass',
          reportPaths: {
            json: '.kontourai/flow/runs/session-flow-pass/report.json',
            markdown: '.kontourai/flow/runs/session-flow-pass/report.md',
          },
        }),
      ]);
      const passRunDir = join(
        cwd,
        '.kontourai',
        'flow',
        'runs',
        'session-flow-pass',
      );
      expect(existsSync(join(passRunDir, 'report.json'))).toBe(true);
      expect(existsSync(join(passRunDir, 'report.md'))).toBe(true);
      // archive#290: nothing mirrors generated run state back into `.flow/runs`.
      expect(existsSync(join(cwd, '.flow', 'runs'))).toBe(false);
    }, 15_000);

    test('an accepted exception unblocks completion on re-evaluation', async () => {
      const cwd = createFlowWorkspace();
      await startFlowSession('flow-exception', cwd);

      await expect(
        service.sessionLifecycles.transition({
          threadId: 'flow-exception',
          to: 'completed',
        }),
      ).rejects.toThrow(/Flow gate verdict: block/);

      // Same call the existing flow-runs REST route performs.
      await flowRunService.acceptException(cwd, 'session-flow-exception', {
        gate: 'build-gate',
        reason: 'known flake, tracked upstream',
        authority: 'team-lead',
      });

      const session = await service.sessionLifecycles.transition({
        threadId: 'flow-exception',
        to: 'completed',
      });
      expect(session.lifecycleState).toBe('completed');

      const detail = await sessionEvents('flow-exception');
      const verdicts = detail.events.filter(
        (event) => event.method === 'flow.gate-verdict',
      );
      expect(
        verdicts.map((event) => (event as { verdict: string }).verdict),
      ).toEqual(['block', 'pass']);
    });

    test('non-Flow workspace sessions behave exactly as before', async () => {
      vi.mocked(flowSessionGateChecks.add).mockClear();
      const cwd = mkdtempSync(join(tmpdir(), 'orchestration-plain-'));
      flowWorkspaces.push(cwd);
      await startFlowSession('plain-thread', cwd);

      const detail = await sessionEvents('plain-thread');
      expect(
        detail.events.filter((event) => event.method.startsWith('flow.')),
      ).toEqual([]);
      expect(await service.readSessionFlowRun('plain-thread')).toBeNull();
      await expect(
        service.attachSessionEvidence('plain-thread', {
          gate: 'build-gate',
          file: 'tests.json',
        }),
      ).rejects.toThrow(/No Flow run bound to session/);

      const session = await service.sessionLifecycles.transition({
        threadId: 'plain-thread',
        to: 'completed',
      });
      expect(session.lifecycleState).toBe('completed');
      expect(flowSessionGateChecks.add).not.toHaveBeenCalled();
      expect(existsSync(join(cwd, '.flow'))).toBe(false);
    });

    /**
     * The fixture class archive#189 found missing. Every other Flow fixture in
     * this file gates step 0, so none of them could reach the state the
     * shipped `station-delivery` definition is always in: its first step
     * `plan` declares no gate, bare `evaluate` throws `no gate for current
     * step`, and the completion gate — the only automated evaluator — turns
     * that into `wait`. The run therefore never advances and never evaluates,
     * while `state.updated_at` keeps looking fresh.
     */
    describe('a definition whose first step has no gate (station#189)', () => {
      const UNGATED_FIRST_STEP_DEFINITION = {
        id: 'ungated-delivery',
        version: '1',
        steps: [
          { id: 'plan', next: 'build' },
          { id: 'build', next: null },
        ],
        gates: {
          'build-gate': {
            step: 'build',
            expects: [
              {
                id: 'tests-passed',
                kind: 'trust.bundle',
                required: true,
                description: 'Tests pass for the change.',
                bundle_claim: {
                  claimType: 'quality.tests',
                  accepted_statuses: ['assumed'],
                },
              },
            ],
          },
        },
      };

      /** Expects a claim type no command-evidence pattern can produce. */
      const UNROUTABLE_CLAIMS_DEFINITION = {
        ...UNGATED_FIRST_STEP_DEFINITION,
        id: 'unroutable-delivery',
        gates: {
          'build-gate': {
            step: 'build',
            expects: [
              {
                id: 'unproducible',
                kind: 'trust.bundle',
                required: true,
                description: 'A claim no command pattern produces.',
                bundle_claim: {
                  claimType: 'governance.unproducible',
                  accepted_statuses: ['assumed'],
                },
              },
            ],
          },
        },
      };

      function createUngatedWorkspace(): string {
        const cwd = mkdtempSync(join(tmpdir(), 'orchestration-flow-ungated-'));
        flowWorkspaces.push(cwd);
        const definitionsDir = join(cwd, '.flow', 'definitions');
        mkdirSync(definitionsDir, { recursive: true });
        writeFileSync(
          join(definitionsDir, 'ungated-delivery.json'),
          JSON.stringify(UNGATED_FIRST_STEP_DEFINITION, null, 2),
        );
        writeFileSync(
          join(definitionsDir, 'unroutable-delivery.json'),
          JSON.stringify(UNROUTABLE_CLAIMS_DEFINITION, null, 2),
        );
        return cwd;
      }

      test('the session flow-run view reports never-evaluated, not a fresh step', async () => {
        const cwd = createUngatedWorkspace();
        await startFlowSession('flow-ungated', cwd, {
          flowDefinition: 'ungated-delivery',
        });

        const view = await service.readSessionFlowRun('flow-ungated');
        expect(view).toMatchObject({
          definitionId: 'ungated-delivery',
          lastEvaluatedAt: null,
          blockedReason: 'ungated-step',
          gateOutcomeCount: 0,
          evidenceCount: 0,
        });
        expect(view?.run.state.current_step).toBe('plan');
        expect(view?.run.openGates).toEqual([]);

        // The divergence the view exists to expose: `updated_at` is as recent
        // as the attach that wrote it, and means nothing about evaluation.
        const updatedAtMs = Date.parse(
          view?.run.state.updated_at as unknown as string,
        );
        expect(Number.isNaN(updatedAtMs)).toBe(false);
        expect(Date.now() - updatedAtMs).toBeLessThan(60_000);
      });

      test('the run-attached event carries the freshness the chat surfaces render', async () => {
        const cwd = createUngatedWorkspace();
        await startFlowSession('flow-ungated-event', cwd, {
          flowDefinition: 'ungated-delivery',
        });

        const detail = await sessionEvents('flow-ungated-event');
        expect(
          detail.events.filter((event) => event.method === 'flow.run-attached'),
        ).toEqual([
          expect.objectContaining({
            method: 'flow.run-attached',
            definitionId: 'ungated-delivery',
            currentStep: 'plan',
            freshness: {
              lastEvaluatedAt: null,
              blockedReason: 'ungated-step',
              gateOutcomeCount: 0,
              evidenceCount: 0,
            },
          }),
        ]);
      });

      test('completion waits and the view still reports never evaluated', async () => {
        const cwd = createUngatedWorkspace();
        await startFlowSession('flow-ungated-complete', cwd, {
          flowDefinition: 'ungated-delivery',
        });

        await expect(
          service.sessionLifecycles.transition({
            threadId: 'flow-ungated-complete',
            to: 'completed',
          }),
        ).rejects.toThrow(/Flow gate verdict: wait/);

        const view = await service.readSessionFlowRun('flow-ungated-complete');
        expect(view).toMatchObject({
          lastEvaluatedAt: null,
          blockedReason: 'ungated-step',
          gateOutcomeCount: 0,
        });

        // The verdict event carries the SAME derivation the view returns, so
        // the chat surfaces and the flow-run view cannot disagree about one
        // run. Nothing else may compute this.
        const detail = await sessionEvents('flow-ungated-complete');
        const verdict = detail.events.find(
          (event) => event.method === 'flow.gate-verdict',
        ) as { freshness?: unknown; currentStep?: string } | undefined;
        expect(verdict?.currentStep).toBe('plan');
        expect(verdict?.freshness).toEqual({
          lastEvaluatedAt: null,
          blockedReason: 'ungated-step',
          gateOutcomeCount: 0,
          evidenceCount: 0,
        });
      });

      test('warns at attach when no expected claim type can be produced', async () => {
        const cwd = createUngatedWorkspace();
        await startFlowSession('flow-unroutable', cwd, {
          flowDefinition: 'unroutable-delivery',
        });

        const detail = await sessionEvents('flow-unroutable');
        const warnings = detail.events.filter(
          (event) =>
            event.method === 'runtime.warning' &&
            event.code === 'flow.unreachable-gate-claims',
        );
        expect(warnings).toHaveLength(1);
        const warning = warnings[0] as {
          message: string;
          details?: Record<string, unknown>;
        };
        expect(warning.message).toContain('governance.unproducible');
        expect(warning.message).toContain('quality.static-checks');
        expect(warning.details).toMatchObject({
          definitionId: 'unroutable-delivery',
          severity: 'all',
          expectedClaimTypes: ['governance.unproducible'],
          unreachableGates: [
            {
              gateId: 'build-gate',
              unproducibleClaimTypes: ['governance.unproducible'],
            },
          ],
        });
        expect(warning.details?.routableClaimTypes).toContain('quality.tests');
      });

      test('re-attaching the same run does not repeat the warning', async () => {
        const cwd = createUngatedWorkspace();
        await startFlowSession('flow-unroutable-twice', cwd, {
          flowDefinition: 'unroutable-delivery',
        });
        // Same thread id → same deterministic run id → the resume path. The
        // definition cannot have changed, so a second warning would only be
        // noise in a history that already carries it.
        await startFlowSession('flow-unroutable-twice', cwd, {
          flowDefinition: 'unroutable-delivery',
        });

        const detail = await sessionEvents('flow-unroutable-twice');
        expect(
          detail.events.filter((event) => event.method === 'flow.run-attached'),
        ).toHaveLength(2);
        expect(
          detail.events.filter(
            (event) =>
              event.method === 'runtime.warning' &&
              event.code === 'flow.unreachable-gate-claims',
          ),
        ).toHaveLength(1);
      });

      test('stays silent when the definition and the routing policy intersect', async () => {
        const cwd = createUngatedWorkspace();
        await startFlowSession('flow-routable', cwd, {
          flowDefinition: 'ungated-delivery',
        });

        const detail = await sessionEvents('flow-routable');
        expect(
          detail.events.filter(
            (event) =>
              event.method === 'runtime.warning' &&
              event.code === 'flow.unreachable-gate-claims',
          ),
        ).toEqual([]);
      });
    });

    describe('readiness auto-attach at completion (S1c)', () => {
      /** Single readiness-gated step expecting the Veritas readiness claim. */
      const READINESS_DEFINITION = {
        id: 'readiness-delivery',
        version: '1',
        steps: [{ id: 'readiness', next: null }],
        gates: {
          'readiness-gate': {
            step: 'readiness',
            expects: [
              {
                id: 'merge-readiness',
                kind: 'trust.bundle',
                required: true,
                description: 'Veritas merge readiness for the working tree.',
                bundle_claim: {
                  claimType: 'governance.merge-readiness',
                  accepted_statuses: ['assumed'],
                },
              },
            ],
            on_route_back: {
              missing_evidence: 'readiness',
              default: 'readiness',
            },
            route_back_policy: { max_attempts: 2, on_exceeded: 'block' },
          },
        },
      };

      function readinessCliStdout(): string {
        const json = {
          evidenceCheckRan: true,
          reportArtifactPath: '.kontourai/veritas/evidence/veritas-123.json',
          reportRunId: 'veritas-123',
          reportSourceKind: 'working-tree',
          message: 'Evidence Check and report completed.',
        };
        return `\nevidence-check passthrough\n${JSON.stringify(json, null, 2)}\n`;
      }

      function createReadinessWorkspace(
        options: { veritas?: boolean } = {},
      ): string {
        const cwd = mkdtempSync(join(tmpdir(), 'orchestration-readiness-'));
        flowWorkspaces.push(cwd);
        const definitionsDir = join(cwd, '.flow', 'definitions');
        mkdirSync(definitionsDir, { recursive: true });
        writeFileSync(
          join(definitionsDir, 'readiness-delivery.json'),
          JSON.stringify(READINESS_DEFINITION, null, 2),
        );
        if (options.veritas !== false) {
          mkdirSync(join(cwd, '.veritas', 'evidence'), { recursive: true });
          writeFileSync(
            join(cwd, '.veritas', 'evidence', 'veritas-123.json'),
            JSON.stringify({
              record_schema_version: 1,
              run_id: 'veritas-123',
              governance_state: { state: 'current' },
              selected_evidence_checks: [
                {
                  id: 'required-evidence-check',
                  label: 'npm test',
                  evidence_check_result: { passed: true, exitCode: 0 },
                },
              ],
              policy_results: [],
              recommendations: [],
              override_or_bypass: false,
              trust: {},
            }),
          );
          const binDir = join(cwd, 'node_modules', '.bin');
          mkdirSync(binDir, { recursive: true });
          writeFileSync(
            join(
              binDir,
              process.platform === 'win32' ? 'veritas.cmd' : 'veritas',
            ),
            '#!/bin/sh\nexit 0\n',
          );
        }
        return cwd;
      }

      let gatedStore: EventStore | undefined;

      afterEach(() => {
        gatedStore?.close();
        gatedStore = undefined;
      });

      function createGatedService(readinessExitCode: number) {
        const adapter = new FakeAdapter('claude');
        gatedStore = new EventStore(
          join(tmp, 'orchestration-readiness.sqlite'),
        );
        const runCli = vi.fn(async () => ({
          stdout: readinessCliStdout(),
          stderr: '',
          exitCode: readinessExitCode,
        }));
        const gated = new OrchestrationService({
          adapterRegistry: createRegistry([adapter]),
          eventBus: new EventBus(),
          eventStore: gatedStore,
          flowRunService: new FlowRunService(),
          veritasReadinessService: new VeritasReadinessService({ runCli }),
          logger: { debug: vi.fn(), warn: vi.fn() },
        });
        return { gated, runCli };
      }

      test('auto-runs readiness, attaches it, and completes when the tree is ready', async () => {
        const cwd = createReadinessWorkspace();
        const { gated, runCli } = createGatedService(0);
        await gated.dispatch({
          type: 'startSession',
          input: {
            threadId: 'auto-ready',
            provider: 'claude',
            modelId: 'claude-sonnet',
            cwd,
            metadata: { flowDefinition: 'readiness-delivery' },
          },
        });

        const session = await gated.sessionLifecycles.transition({
          threadId: 'auto-ready',
          to: 'completed',
        });
        expect(session.lifecycleState).toBe('completed');
        expect(runCli).toHaveBeenCalledTimes(1);

        const detail = await gated.readSession('auto-ready');
        const verdicts = detail?.events.filter(
          (event) => event.method === 'flow.gate-verdict',
        );
        expect(verdicts).toEqual([
          expect.objectContaining({
            verdict: 'pass',
            autoReadiness: { outcome: 'attached' },
          }),
        ]);

        const flowRun = await gated.readSessionFlowRun('auto-ready');
        expect(flowRun?.run.manifest.evidence).toEqual([
          expect.objectContaining({
            gate_id: 'readiness-gate',
            kind: 'trust.bundle',
            producer: 'veritas',
            bundle: expect.objectContaining({
              claims: expect.arrayContaining([
                expect.objectContaining({
                  claimType: 'governance.merge-readiness',
                  status: 'assumed',
                }),
              ]),
            }),
          }),
        ]);
      });

      test('keeps the verdict and reports the reason when not Veritas-configured', async () => {
        const cwd = createReadinessWorkspace({ veritas: false });
        const { gated, runCli } = createGatedService(0);
        await gated.dispatch({
          type: 'startSession',
          input: {
            threadId: 'auto-unconfigured',
            provider: 'claude',
            modelId: 'claude-sonnet',
            cwd,
            metadata: { flowDefinition: 'readiness-delivery' },
          },
        });

        await expect(
          gated.sessionLifecycles.transition({
            threadId: 'auto-unconfigured',
            to: 'completed',
          }),
        ).rejects.toThrow(/Flow gate verdict: route-back/);
        expect(runCli).not.toHaveBeenCalled();

        const detail = await gated.readSession('auto-unconfigured');
        const verdicts = detail?.events.filter(
          (event) => event.method === 'flow.gate-verdict',
        );
        expect(verdicts).toEqual([
          expect.objectContaining({
            verdict: 'route-back',
            missing: ['merge-readiness'],
            autoReadiness: {
              outcome: 'not-configured',
              reason: expect.stringContaining('no-veritas-dir'),
            },
          }),
        ]);
      });

      test('keeps the verdict and attaches nothing when readiness is not-ready', async () => {
        const cwd = createReadinessWorkspace();
        const { gated, runCli } = createGatedService(1);
        await gated.dispatch({
          type: 'startSession',
          input: {
            threadId: 'auto-not-ready',
            provider: 'claude',
            modelId: 'claude-sonnet',
            cwd,
            metadata: { flowDefinition: 'readiness-delivery' },
          },
        });

        await expect(
          gated.sessionLifecycles.transition({
            threadId: 'auto-not-ready',
            to: 'completed',
          }),
        ).rejects.toThrow(/Flow gate verdict: route-back/);
        expect(runCli).toHaveBeenCalledTimes(1);

        const detail = await gated.readSession('auto-not-ready');
        const verdicts = detail?.events.filter(
          (event) => event.method === 'flow.gate-verdict',
        );
        expect(verdicts).toEqual([
          expect.objectContaining({
            verdict: 'route-back',
            autoReadiness: expect.objectContaining({ outcome: 'not-ready' }),
          }),
        ]);

        const flowRun = await gated.readSessionFlowRun('auto-not-ready');
        expect(flowRun?.run.manifest.evidence).toEqual([]);
      });
    });
  });

  describe('Flow Agents policy enforcement (S3)', () => {
    const policyWorkspaces: string[] = [];

    afterEach(() => {
      for (const dir of policyWorkspaces.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    /** Opted-in workspace: has `.flow-agents/` (and no `.flow/`). */
    function createPolicyWorkspace(): string {
      const cwd = mkdtempSync(join(tmpdir(), 'orchestration-policy-'));
      policyWorkspaces.push(cwd);
      mkdirSync(join(cwd, '.flow-agents'), { recursive: true });
      return cwd;
    }

    /**
     * Canonical stop-goal-fit trigger: an active delivery artifact.
     *
     * flow-agents 3.x's stop-goal-fit hook reads active-work markdown only
     * from the durable `.kontourai/flow-agents/` root (its own internal
     * `flowAgentsArtifactRootsForRead` no longer falls back to the legacy
     * `.flow-agents/` dir — see local-artifact-paths.ts's doc comment for the
     * station-side half of this split). The workspace's `.flow-agents/` dir
     * still independently satisfies station's OWN opt-in detection
     * (`isWorkspaceOptedIn`, which checks both roots), so this writes the
     * delivery artifact into the new canonical root the hook actually scans.
     */
    function writeActiveDelivery(cwd: string): void {
      const taskDir = join(cwd, '.kontourai', 'flow-agents', 'demo-task');
      mkdirSync(taskDir, { recursive: true });
      writeFileSync(
        join(taskDir, 'demo--deliver.md'),
        ['status: executing', 'type: deliver', '', '# Demo', ''].join('\n'),
      );
    }

    async function startPolicySession(
      threadId: string,
      cwd: string,
      taskSlug?: string,
    ): Promise<void> {
      await service.dispatch({
        type: 'startSession',
        input: {
          threadId,
          provider: 'claude',
          modelId: 'claude-sonnet',
          cwd,
          ...(taskSlug ? { metadata: { taskSlug } } : {}),
        },
      });
    }

    function createStrictService(adapters: ProviderAdapterShape[]) {
      return new OrchestrationService({
        adapterRegistry: createRegistry(adapters),
        eventBus,
        eventStore,
        flowRunService,
        workflowSidecarService,
        agentPolicyService: new AgentPolicyService({
          env: {
            ...process.env,
            SA_HOOK_PROFILE: 'strict',
            SA_DISABLED_HOOKS: '',
          },
          logger: { debug: vi.fn(), warn: vi.fn() },
        }),
        logger: { debug: vi.fn(), warn: vi.fn() },
      });
    }

    test('binds policy hooks on session start in a .flow-agents workspace (event-sourced)', async () => {
      const cwd = createPolicyWorkspace();
      await startPolicySession('policy-attach', cwd);

      const detail = await service.readSession('policy-attach');
      expect(
        detail?.events.filter(
          (event) => event.method === 'policy.hooks-attached',
        ),
      ).toEqual([
        expect.objectContaining({
          method: 'policy.hooks-attached',
          cwd,
          profile: 'standard',
          engine: 'native',
        }),
      ]);
    });

    test('stop-goal-fit default: completion proceeds with the warn verdict recorded in history', async () => {
      const cwd = createPolicyWorkspace();
      writeActiveDelivery(cwd);
      await startPolicySession('policy-warn', cwd, 'demo-task');
      workflowSidecarService.transition(cwd, 'demo-task', {
        status: 'in_progress',
        phase: 'execution',
      });

      const session = await service.sessionLifecycles.transition({
        threadId: 'policy-warn',
        to: 'completed',
      });
      expect(session.lifecycleState).toBe('completed');

      const detail = await service.readSession('policy-warn');
      const verdicts = detail?.events.filter(
        (event) => event.method === 'policy.stop-verdict',
      );
      expect(verdicts).toEqual([
        expect.objectContaining({
          method: 'policy.stop-verdict',
          policy: 'stop-goal-fit',
          verdict: 'warn',
          strict: false,
        }),
      ]);
      const verdict = verdicts?.[0] as { warnings: string[] };
      expect(verdict.warnings.join('\n')).toMatch(/still status:executing/);
    });

    test('stop-goal-fit strict: blocks completion beside the Flow gate', async () => {
      const cwd = createPolicyWorkspace();
      writeActiveDelivery(cwd);
      const strictClaude = new FakeAdapter('claude', [
        {
          id: 'anthropic-api-key',
          name: 'Anthropic API key',
          status: 'installed',
          category: 'required',
          description: 'Used to access Claude Agent SDK.',
        },
      ]);
      const strict = createStrictService([strictClaude]);
      await strict.dispatch({
        type: 'startSession',
        input: {
          threadId: 'policy-block',
          provider: 'claude',
          modelId: 'claude-sonnet',
          cwd,
          metadata: { taskSlug: 'demo-task' },
        },
      });
      workflowSidecarService.transition(cwd, 'demo-task', {
        status: 'in_progress',
        phase: 'execution',
      });

      await expect(
        strict.sessionLifecycles.transition({
          threadId: 'policy-block',
          to: 'completed',
        }),
      ).rejects.toThrow(/Policy stop-goal-fit verdict: block/);

      const detail = await strict.readSession('policy-block');
      expect(detail?.session.lifecycleState).not.toBe('completed');
      expect(
        detail?.events.filter(
          (event) => event.method === 'policy.stop-verdict',
        ),
      ).toEqual([
        expect.objectContaining({
          verdict: 'block',
          strict: true,
        }),
      ]);
    });

    test('post-hoc config-protection: connected-runtime protected-config writes surface as runtime warnings', async () => {
      const cwd = createPolicyWorkspace();
      await startPolicySession('policy-posthoc', cwd);

      const base = {
        provider: 'claude' as const,
        threadId: 'policy-posthoc',
        createdAt: new Date().toISOString(),
        itemId: 'item-1',
        toolCallId: 'call-1',
      };
      claude.events.push({
        ...base,
        eventId: 'evt-tool-start',
        method: 'tool.started',
        toolName: 'write_file',
        arguments: { path: join(cwd, 'biome.json'), content: '{}' },
      });
      claude.events.push({
        ...base,
        eventId: 'evt-tool-done',
        method: 'tool.completed',
        toolName: 'write_file',
        status: 'success',
      });

      const events = await waitFor(
        () =>
          eventStore.listEvents('policy-posthoc').map((event) => event.payload),
        (payloads) =>
          payloads.some(
            (event) =>
              event.method === 'runtime.warning' &&
              event.code === 'policy.config-protection.post-hoc',
          ),
      );
      const warning = events.find(
        (event) =>
          event.method === 'runtime.warning' &&
          event.code === 'policy.config-protection.post-hoc',
      );
      expect(warning).toMatchObject({
        severity: 'warning',
        message: expect.stringContaining('biome.json'),
      });
      // Post-hoc means observed, not blocked: the warning says so.
      expect((warning as { message: string }).message).toMatch(/cannot block/i);
    });

    test('managed-runtime tool events are NOT post-hoc checked (pre-execution seam owns them)', async () => {
      const cwd = createPolicyWorkspace();
      await service.dispatch({
        type: 'startSession',
        input: { threadId: 'policy-managed', provider: 'bedrock', cwd },
      });

      const base = {
        provider: 'bedrock' as const,
        threadId: 'policy-managed',
        createdAt: new Date().toISOString(),
        itemId: 'item-1',
        toolCallId: 'call-1',
      };
      bedrock.events.push({
        ...base,
        eventId: 'evt-tool-start',
        method: 'tool.started',
        toolName: 'write_file',
        arguments: { path: join(cwd, 'biome.json'), content: '{}' },
      });
      bedrock.events.push({
        ...base,
        eventId: 'evt-tool-done',
        method: 'tool.completed',
        toolName: 'write_file',
        status: 'success',
      });

      await waitFor(
        () =>
          eventStore.listEvents('policy-managed').map((event) => event.payload),
        (payloads) =>
          payloads.some((event) => event.method === 'tool.completed'),
      );
      expect(
        eventStore
          .listEvents('policy-managed')
          .map((event) => event.payload)
          .filter((event) => event.method === 'runtime.warning'),
      ).toEqual([]);
    });

    test('non-opted workspace: zero policy events, completion unchanged', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'orchestration-plain-policy-'));
      policyWorkspaces.push(cwd);
      await startPolicySession('policy-plain', cwd);

      const session = await service.sessionLifecycles.transition({
        threadId: 'policy-plain',
        to: 'completed',
      });
      expect(session.lifecycleState).toBe('completed');

      const detail = await service.readSession('policy-plain');
      expect(
        detail?.events.filter((event) => event.method.startsWith('policy.')),
      ).toEqual([]);
      expect(existsSync(join(cwd, '.flow-agents'))).toBe(false);
    });
    test("a quarantined thread's tool events never reach post-hoc policy or command spool (slice 11 I8b guard)", async () => {
      // The behavioral complement of the ingest-positions source invariant:
      // no prior fixture combined quarantine with tool events, so moving
      // the two ingest calls above the publish continue-gate was
      // suite-green. Power arm below: an identical event on an admitted
      // thread DOES write both pending maps, proving this fixture reaches
      // the mutations the quarantined arm asserts absent.
      const cwd = createPolicyWorkspace();
      await startPolicySession('policy-quarantined-ingest', cwd);
      await startPolicySession('policy-ingest-power', cwd);
      const flowPolicy = (
        service as unknown as {
          flowPolicy: {
            pendingPolicyWrites: Map<string, string>;
            pendingCommandSpools: Map<string, unknown>;
            flowBoundThreads: Map<string, boolean>;
          };
        }
      ).flowPolicy;
      // Make the spool arm REACHABLE for both threads: cache them as
      // flow-bound so a tool.started that got past the gate WOULD spool.
      flowPolicy.flowBoundThreads.set('policy-quarantined-ingest', true);
      flowPolicy.flowBoundThreads.set('policy-ingest-power', true);
      (
        service as unknown as { quarantinedThreads: Set<string> }
      ).quarantinedThreads.add('policy-quarantined-ingest');

      const toolStarted = (threadId: string, toolCallId: string) => ({
        eventId: `evt-${toolCallId}`,
        provider: 'claude' as const,
        threadId,
        createdAt: new Date().toISOString(),
        itemId: 'item-1',
        toolCallId,
        method: 'tool.started' as const,
        toolName: 'write_file',
        arguments: { path: join(cwd, 'biome.json'), command: 'echo hi' },
      });
      // Push order = processing order on the shared adapter stream: once
      // the power thread's entry lands, the quarantined event has already
      // been fully processed (or dropped at the gate).
      claude.events.push(toolStarted('policy-quarantined-ingest', 'call-q'));
      claude.events.push(toolStarted('policy-ingest-power', 'call-p'));
      await waitFor(
        () => flowPolicy.pendingPolicyWrites,
        (writes) => writes.has('policy-ingest-power:call-p'),
      );
      expect(
        flowPolicy.pendingCommandSpools.has('policy-ingest-power:call-p'),
      ).toBe(true);
      expect(
        flowPolicy.pendingPolicyWrites.has('policy-quarantined-ingest:call-q'),
      ).toBe(false);
      expect(
        flowPolicy.pendingCommandSpools.has('policy-quarantined-ingest:call-q'),
      ).toBe(false);
    });
  });

  describe('Durable workflow sidecars (S3 item 2)', () => {
    const taskWorkspaces: string[] = [];

    afterEach(() => {
      for (const dir of taskWorkspaces.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    function createTaskWorkspace(): string {
      const cwd = mkdtempSync(join(tmpdir(), 'orchestration-task-'));
      taskWorkspaces.push(cwd);
      return cwd;
    }

    function writeRoutedDeliveryDefinition(cwd: string): void {
      const definitionsDir = join(cwd, '.flow', 'definitions');
      mkdirSync(definitionsDir, { recursive: true });
      writeFileSync(
        join(definitionsDir, 'routed-delivery.json'),
        JSON.stringify({
          id: 'routed-delivery',
          version: '1',
          steps: [{ id: 'build', next: null }],
          gates: {
            'build-gate': {
              step: 'build',
              expects: [
                {
                  id: 'tests-passed',
                  kind: 'trust.bundle',
                  required: true,
                  description: 'Tests pass for the change.',
                  bundle_claim: {
                    claimType: 'quality.tests',
                    accepted_statuses: ['assumed'],
                  },
                },
              ],
              on_route_back: { missing_evidence: 'build', default: 'build' },
              route_back_policy: { max_attempts: 3, on_exceeded: 'block' },
            },
          },
        }),
      );
    }

    async function workflowEvents(
      activeService: OrchestrationService,
      threadId: string,
    ) {
      const detail = await activeService.readSession(threadId);
      if (!detail) throw new Error(`Session not found: ${threadId}`);
      return detail.events.filter(
        (event) => event.method === 'workflow.state-changed',
      );
    }

    test('binds an explicit metadata.taskSlug to a fresh sidecar on session start', async () => {
      const cwd = createTaskWorkspace();
      await service.dispatch({
        type: 'startSession',
        input: {
          threadId: 'task-fresh',
          provider: 'claude',
          modelId: 'claude-sonnet',
          cwd,
          metadata: { taskSlug: 'demo-task' },
        },
      });

      // The durable file exists and is schema-valid…
      const state = workflowSidecarService.readState(cwd, 'demo-task');
      expect(state).toMatchObject({
        schema_version: '1.0',
        task_slug: 'demo-task',
        status: 'new',
        phase: 'pickup',
        next_action: { status: 'continue' },
      });
      // …and the binding is event-sourced in session history.
      expect(await workflowEvents(service, 'task-fresh')).toEqual([
        expect.objectContaining({
          method: 'workflow.state-changed',
          taskSlug: 'demo-task',
          cwd,
          ownership: 'station-owned',
          status: 'new',
          phase: 'pickup',
          trigger: 'session-start',
          resumed: false,
        }),
      ]);
    });

    test('no taskSlug: zero workflow events, no sidecar created', async () => {
      const cwd = createTaskWorkspace();
      await service.dispatch({
        type: 'startSession',
        input: {
          threadId: 'task-none',
          provider: 'claude',
          modelId: 'claude-sonnet',
          cwd,
        },
      });

      expect(await workflowEvents(service, 'task-none')).toEqual([]);
      expect(existsSync(join(cwd, '.flow-agents'))).toBe(false);

      const session = await service.sessionLifecycles.transition({
        threadId: 'task-none',
        to: 'completed',
      });
      expect(session.lifecycleState).toBe('completed');
      expect(existsSync(join(cwd, '.flow-agents'))).toBe(false);
    });

    test('RUNTIME SWITCH (the L3 proof): a workflow started under one runtime continues under another with the same durable state', async () => {
      // Two stub adapters of DIFFERENT runtime kinds sharing one
      // orchestration layer — the harness equivalent of switching a task
      // from a Claude-runtime session to a Codex-runtime session.
      const codex = new FakeAdapter('codex');
      const switchService = new OrchestrationService({
        adapterRegistry: createRegistry([claude, codex]),
        eventBus,
        eventStore,
        flowRunService,
        workflowSidecarService,
        logger: { debug: vi.fn(), warn: vi.fn() },
      });

      // The workspace is plain (no Flow definitions): the sidecar ALONE
      // carries the workflow across the switch.
      const cwd = createTaskWorkspace();
      const taskSlug = 'switch-proof';

      // ── Session A (runtime X = claude) picks up the task. ──
      await switchService.dispatch({
        type: 'startSession',
        input: {
          threadId: 'session-a',
          provider: 'claude',
          modelId: 'claude-sonnet',
          cwd,
          metadata: { taskSlug },
        },
      });
      expect(
        (await workflowEvents(switchService, 'session-a'))[0],
      ).toMatchObject({
        provider: 'claude',
        taskSlug,
        status: 'new',
        phase: 'pickup',
        resumed: false,
      });
      expect(
        readdirSync(join(cwd, '.kontourai', 'flow-agents', 'current')),
      ).toHaveLength(1);

      // Session A advances the workflow and records exactly where it
      // stopped. The memory lives in the WORKSPACE sidecar, not in any
      // runtime's session state — that is the whole trick.
      workflowSidecarService.transition(
        cwd,
        taskSlug,
        {
          status: 'not_verified',
          phase: 'verification',
          nextAction: {
            status: 'needs_user',
            summary: 'Verify the readiness gate wiring before delivering',
          },
        },
        { trigger: 'manual' },
      );

      // Session A ends without completing (handoff, compaction, or the
      // user simply switching runtimes).
      await switchService.dispatch({
        type: 'stopSession',
        threadId: 'session-a',
      });

      // ── Session B (runtime Y = codex) starts with the SAME task slug. ──
      await switchService.dispatch({
        type: 'startSession',
        input: {
          threadId: 'session-b',
          provider: 'codex',
          modelId: 'gpt-5.4',
          cwd,
          metadata: { taskSlug },
        },
      });

      // B's binding event carries A's state verbatim: status, phase, and
      // the recorded next action all survive the runtime switch.
      expect(
        (await workflowEvents(switchService, 'session-b'))[0],
      ).toMatchObject({
        provider: 'codex',
        taskSlug,
        status: 'not_verified',
        phase: 'verification',
        nextActionStatus: 'needs_user',
        nextActionSummary: 'Verify the readiness gate wiring before delivering',
        trigger: 'session-start',
        resumed: true,
      });
      expect(
        readdirSync(join(cwd, '.kontourai', 'flow-agents', 'current')),
      ).toHaveLength(2);
      const resumed = await switchService.readSessionWorkflowState('session-b');
      expect(resumed).toMatchObject({
        taskSlug,
        cwd,
        state: expect.objectContaining({ status: 'not_verified' }),
      });

      // The S3-A steering seam reads the SAME file: managed-agent context
      // assembly injects A's recorded state through the canonical
      // workflow-steering hook — no Station-specific plumbing in between.
      const steering = new AgentPolicyService({
        env: { ...process.env, SA_HOOK_PROFILE: '', SA_DISABLED_HOOKS: '' },
        logger: { debug: vi.fn(), warn: vi.fn() },
      }).steeringContext({
        cwd,
        actorKey: stationWorkflowActorKey('session-b'),
      });
      expect(steering).toContain(taskSlug);
      expect(steering).toContain(
        'Verify the readiness gate wiring before delivering',
      );

      // Session B finishes the SAME workflow: completion marks the task
      // delivered, and the transition is again event-sourced.
      await switchService.sessionLifecycles.transition({
        threadId: 'session-b',
        to: 'completed',
      });
      expect(workflowSidecarService.readState(cwd, taskSlug)).toMatchObject({
        status: 'delivered',
        phase: 'done',
        next_action: { status: 'done' },
      });
      const bEvents = await workflowEvents(switchService, 'session-b');
      expect(bEvents.at(-1)).toMatchObject({
        provider: 'codex',
        taskSlug,
        status: 'delivered',
        phase: 'done',
        trigger: 'completion',
      });
    }, 15_000);

    test('flow gate verdict writes its guidance into the sidecar before rejecting completion', async () => {
      const cwd = createTaskWorkspace();
      writeRoutedDeliveryDefinition(cwd);

      await service.dispatch({
        type: 'startSession',
        input: {
          threadId: 'task-gated',
          provider: 'claude',
          modelId: 'claude-sonnet',
          cwd,
          metadata: {
            taskSlug: 'gated-task',
            flowDefinition: 'routed-delivery',
          },
        },
      });

      await expect(
        service.sessionLifecycles.transition({
          threadId: 'task-gated',
          to: 'completed',
        }),
      ).rejects.toThrow(/Flow gate verdict: route-back/);

      // The verdict's guidance is now the task's durable next action: the
      // next session (any runtime) resumes from what the gate said.
      const state = workflowSidecarService.readState(cwd, 'gated-task');
      expect(state).toMatchObject({
        status: 'in_progress',
        next_action: { status: 'continue' },
      });
      expect(state?.next_action.summary.length).toBeGreaterThan(0);

      const events = await workflowEvents(service, 'task-gated');
      expect(events.at(-1)).toMatchObject({
        taskSlug: 'gated-task',
        ownership: 'station-owned',
        status: 'in_progress',
        trigger: 'gate-verdict',
        resumed: true,
      });
      // And the session is NOT completed.
      const detail = await service.readSession('task-gated');
      expect(detail?.session.lifecycleState).not.toBe('completed');
    });

    /**
     * archive#189 S4. These exercise the whole read path — session events ->
     * binding/cwd -> real sidecar files on disk -> join — rather than the
     * pure resolver alone, because the wiring is where a join can silently
     * read the wrong workspace.
     */
    describe('readSessionBuilderRun', () => {
      function writeBuilderSidecar(
        cwd: string,
        taskSlug: string,
        runtimeSessionValue: string | null,
        updatedAt = new Date().toISOString(),
      ): void {
        workflowSidecarService.writeState(cwd, taskSlug, {
          schema_version: '1.0',
          task_slug: taskSlug,
          status: 'in_progress',
          phase: 'execution',
          updated_at: updatedAt,
          run_correlation: {
            schema_version: '1.0',
            correlation_id: `run-${taskSlug}`,
            identities: {
              runtime_session: runtimeSessionValue
                ? { status: 'present', value: runtimeSessionValue }
                : {
                    status: 'unsupported',
                    reason: 'the runtime does not expose a session identity',
                  },
              runtime_turn: {
                status: 'unavailable',
                reason: 'no turn identity at run start',
              },
              flow_run: { status: 'present', value: taskSlug },
              flow_step: {
                status: 'unavailable',
                reason: 'the envelope spans changing Flow steps',
              },
              work_item: { status: 'present', value: `local:${taskSlug}` },
              agent: { status: 'present', value: 'codex:thread:Kontour' },
              delegation_trace: {
                status: 'unsupported',
                reason: 'no delegation trace context',
              },
              delegation_span: {
                status: 'unsupported',
                reason: 'no delegation span context',
              },
              terminal_record: {
                status: 'unavailable',
                reason: 'no terminal record at run start',
              },
            },
          },
          flow_run: {
            run_id: taskSlug,
            definition_id: 'builder.build',
            definition_version: '1.3',
            status: 'active',
            current_step: 'verify',
            run_ref: `.kontourai/flow/runs/${taskSlug}`,
            open_gate_ids: ['verify-gate'],
          },
          next_action: { status: 'continue', summary: 'Keep going' },
        });
      }

      function overwriteStateAsExternalWriter(
        cwd: string,
        taskSlug: string,
        summary: string,
      ): { path: string; bytes: string } {
        const path = join(
          cwd,
          '.kontourai',
          'flow-agents',
          taskSlug,
          'state.json',
        );
        const state = JSON.parse(readFileSync(path, 'utf8')) as Record<
          string,
          unknown
        >;
        state.updated_at = '2099-01-01T00:00:00.000Z';
        state.next_action = { status: 'continue', summary };
        const bytes = `${JSON.stringify(state, null, 2)}\n`;
        writeFileSync(path, bytes, 'utf8');
        return { path, bytes };
      }

      test('joins the Builder run Station itself started the session against', async () => {
        const cwd = createTaskWorkspace();
        writeBuilderSidecar(cwd, 'builder-task', null);

        await service.dispatch({
          type: 'startSession',
          input: {
            threadId: 'builder-session',
            provider: 'claude',
            modelId: 'claude-sonnet',
            cwd,
            metadata: { taskSlug: 'builder-task' },
          },
        });

        expect(
          await service.readSessionBuilderRun('builder-session'),
        ).toMatchObject({
          matchKind: 'started-by-station',
          // The run itself declares no runtime session — the join stands
          // anyway, and the row says both things.
          identityStatus: 'unsupported',
          taskSlug: 'builder-task',
          runRef: '.kontourai/flow/runs/builder-task',
          flowRun: { definition_id: 'builder.build', current_step: 'verify' },
        });
      });

      /**
       * A session Station did not start against a task has no workflow
       * binding, so the join reads the workspace off the session summary —
       * which real adapters populate from `input.cwd` (claude-adapter.ts's
       * returned `ProviderSession`, and again on `session.configured`). The
       * shared FakeAdapter omits it, so these tests supply it the same way a
       * real adapter would.
       */
      function startSessionReturnsCwd(): void {
        claude.startSession.mockImplementationOnce(async (input) => {
          const now = new Date().toISOString();
          return {
            provider: 'claude',
            threadId: input.threadId,
            status: 'ready',
            model: input.modelId,
            cwd: input.cwd,
            createdAt: now,
            updatedAt: now,
          };
        });
      }

      test('joins a session Station did not start on an exact runtime_session match', async () => {
        const cwd = createTaskWorkspace();
        writeBuilderSidecar(cwd, 'external-task', 'unstarted-session');
        writeBuilderSidecar(cwd, 'someone-elses-task', 'a-different-thread');

        startSessionReturnsCwd();
        await service.dispatch({
          type: 'startSession',
          input: {
            threadId: 'unstarted-session',
            provider: 'claude',
            modelId: 'claude-sonnet',
            cwd,
          },
        });

        expect(
          await service.readSessionBuilderRun('unstarted-session'),
        ).toMatchObject({
          matchKind: 'correlation-matched',
          identityStatus: 'present',
          taskSlug: 'external-task',
        });
      });

      test('renders unavailable rather than the only run in the workspace when it names another session', async () => {
        const cwd = createTaskWorkspace();
        writeBuilderSidecar(cwd, 'codex-task', 'a-codex-cli-thread-id');

        startSessionReturnsCwd();
        await service.dispatch({
          type: 'startSession',
          input: {
            threadId: 'station-session',
            provider: 'claude',
            modelId: 'claude-sonnet',
            cwd,
          },
        });

        const view = await service.readSessionBuilderRun('station-session');
        expect(view).toMatchObject({
          matchKind: 'none',
          identityStatus: 'unavailable',
        });
        expect(view?.taskSlug).toBeUndefined();
        expect(view?.flowRun).toBeUndefined();
      });

      test('returns null for a session whose workspace has no Builder runs', async () => {
        const cwd = createTaskWorkspace();
        await service.dispatch({
          type: 'startSession',
          input: {
            threadId: 'plain-builder-session',
            provider: 'claude',
            modelId: 'claude-sonnet',
            cwd,
          },
        });

        expect(
          await service.readSessionBuilderRun('plain-builder-session'),
        ).toBeNull();
      });

      test('returns null for an unknown session', async () => {
        expect(
          await service.readSessionBuilderRun('no-such-thread'),
        ).toBeNull();
      });

      test('a decoy directory declaring the same slug cannot shadow the bound task (review L1)', async () => {
        // The bound task is read by exact path. A scan would be shadowable:
        // `listTasks` dedupes by DIRECTORY name but reports `state.task_slug`,
        // so this decoy — different directory, same declared slug, newer
        // `updated_at` — sorts ahead of the real one.
        const cwd = createTaskWorkspace();
        writeBuilderSidecar(cwd, 'builder-task', null);
        const decoyDir = join(cwd, '.kontourai', 'flow-agents', 'decoy');
        mkdirSync(decoyDir, { recursive: true });
        writeFileSync(
          join(decoyDir, 'state.json'),
          JSON.stringify({
            schema_version: '1.0',
            task_slug: 'builder-task',
            status: 'delivered',
            phase: 'done',
            updated_at: '2099-01-01T00:00:00.000Z',
            flow_run: {
              run_id: 'decoy',
              definition_id: 'builder.build',
              definition_version: '1.3',
              status: 'completed',
              current_step: 'learn',
              run_ref: '.kontourai/flow/runs/decoy',
              open_gate_ids: [],
            },
            next_action: { status: 'done', summary: 'decoy' },
          }),
        );
        // The scan really is shadowed — which is why the bound path must not
        // use it.
        expect(
          workflowSidecarService
            .listTasks(cwd)
            .find((entry) => entry.taskSlug === 'builder-task')?.flowRun
            ?.run_id,
        ).toBe('decoy');

        await service.dispatch(
          {
            type: 'startSession',
            input: {
              threadId: 'shadowed-session',
              provider: 'claude',
              modelId: 'claude-sonnet',
              cwd,
              metadata: { taskSlug: 'builder-task' },
            },
          },
          undefined,
          { workflowSidecarAttachMode: 'read-only-join' },
        );

        expect(
          await service.readSessionBuilderRun('shadowed-session'),
        ).toMatchObject({
          matchKind: 'started-by-station',
          taskSlug: 'builder-task',
          flowRun: { run_id: 'builder-task', current_step: 'verify' },
        });
      });

      test('a dispatch-join binds and joins WITHOUT writing the live run state.json (review M1)', async () => {
        // The sidecar belongs to a Builder run flow-agents is driving. The
        // ordinary attach touches `updated_at` through a read-modify-
        // whole-file-write, and Flow's run store has no compare-and-set
        // (flow#201), so a concurrent CLI write inside that window would be
        // silently clobbered by Station's stale snapshot.
        const cwd = createTaskWorkspace();
        writeBuilderSidecar(cwd, 'live-run', null);
        const statePath = join(
          cwd,
          '.kontourai',
          'flow-agents',
          'live-run',
          'state.json',
        );
        const before = readFileSync(statePath);

        await service.dispatch(
          {
            type: 'startSession',
            input: {
              threadId: 'dispatch-join',
              provider: 'claude',
              modelId: 'claude-sonnet',
              cwd,
              metadata: { taskSlug: 'live-run' },
            },
          },
          undefined,
          { workflowSidecarAttachMode: 'read-only-join' },
        );

        // Byte-identical: the read-side join wrote nothing.
        expect(readFileSync(statePath)).toEqual(before);
        // ...and it still bound the session, and the row still joins.
        expect(
          (await workflowEvents(service, 'dispatch-join')).at(-1),
        ).toMatchObject({
          taskSlug: 'live-run',
          ownership: 'read-only-join',
          resumed: true,
        });

        // The bound path resolves its task by exact read and must not run the
        // workspace scan at all (L1's second layer, `tasks: binding ? []`).
        // Nothing observable in the RESULT distinguishes "scanned but ignored
        // it" from "never scanned", so the call itself is the only available
        // pin.
        const listTasksSpy = vi.spyOn(workflowSidecarService, 'listTasks');
        try {
          expect(
            await service.readSessionBuilderRun('dispatch-join'),
          ).toMatchObject({
            matchKind: 'started-by-station',
            taskSlug: 'live-run',
            flowRun: { definition_id: 'builder.build' },
          });
          expect(listTasksSpy).not.toHaveBeenCalled();
        } finally {
          listTasksSpy.mockRestore();
        }
      });

      test('a joined Builder run preserves an external writer byte-for-byte through completion', async () => {
        const cwd = createTaskWorkspace();
        const taskSlug = 'completion-owned-externally';
        writeBuilderSidecar(cwd, taskSlug, null);
        await service.dispatch(
          {
            type: 'startSession',
            input: {
              threadId: 'read-only-completion',
              provider: 'claude',
              modelId: 'claude-sonnet',
              cwd,
              metadata: { taskSlug },
            },
          },
          undefined,
          { workflowSidecarAttachMode: 'read-only-join' },
        );

        // A Builder process publishes newer routing state after Station has
        // joined. Completion must not rewrite any byte of that external fact.
        const external = overwriteStateAsExternalWriter(
          cwd,
          taskSlug,
          'Builder advanced after Station joined',
        );
        await expect(
          service.sessionLifecycles.transition({
            threadId: 'read-only-completion',
            to: 'completed',
          }),
        ).resolves.toMatchObject({ lifecycleState: 'completed' });

        expect(readFileSync(external.path, 'utf8')).toBe(external.bytes);
        expect(await workflowEvents(service, 'read-only-completion')).toEqual([
          expect.objectContaining({
            taskSlug,
            ownership: 'read-only-join',
            trigger: 'session-start',
          }),
        ]);
      });

      test('a joined Builder run preserves an external writer byte-for-byte through a non-pass gate verdict', async () => {
        const cwd = createTaskWorkspace();
        const taskSlug = 'verdict-owned-externally';
        writeRoutedDeliveryDefinition(cwd);
        writeBuilderSidecar(cwd, taskSlug, null);
        await service.dispatch(
          {
            type: 'startSession',
            input: {
              threadId: 'read-only-verdict',
              provider: 'claude',
              modelId: 'claude-sonnet',
              cwd,
              metadata: { taskSlug, flowDefinition: 'routed-delivery' },
            },
          },
          undefined,
          { workflowSidecarAttachMode: 'read-only-join' },
        );

        const external = overwriteStateAsExternalWriter(
          cwd,
          taskSlug,
          'Builder rerouted while Station evaluated its gate',
        );
        await expect(
          service.sessionLifecycles.transition({
            threadId: 'read-only-verdict',
            to: 'completed',
          }),
        ).rejects.toThrow(/Flow gate verdict: route-back/);

        expect(readFileSync(external.path, 'utf8')).toBe(external.bytes);
        expect(await workflowEvents(service, 'read-only-verdict')).toEqual([
          expect.objectContaining({
            taskSlug,
            ownership: 'read-only-join',
            trigger: 'session-start',
          }),
        ]);
      });

      test('an ownership-ambiguous persisted binding fails closed on completion', async () => {
        const cwd = createTaskWorkspace();
        const taskSlug = 'ambiguous-ownership';
        await service.dispatch({
          type: 'startSession',
          input: {
            threadId: 'ambiguous-completion',
            provider: 'claude',
            modelId: 'claude-sonnet',
            cwd,
            metadata: { taskSlug },
          },
        });
        eventStore.appendEvent({
          eventId: randomUUID(),
          provider: 'claude',
          threadId: 'ambiguous-completion',
          createdAt: new Date().toISOString(),
          method: 'workflow.state-changed',
          taskSlug,
          cwd,
          status: 'in_progress',
          phase: 'execution',
          nextActionStatus: 'continue',
          nextActionSummary: 'Legacy binding without ownership',
          trigger: 'session-start',
          resumed: true,
        } as CanonicalRuntimeEvent);
        const external = overwriteStateAsExternalWriter(
          cwd,
          taskSlug,
          'Ambiguous authority must not mutate this',
        );

        await service.sessionLifecycles.transition({
          threadId: 'ambiguous-completion',
          to: 'completed',
        });

        expect(readFileSync(external.path, 'utf8')).toBe(external.bytes);
      });

      test('a corrupt bound sidecar renders the broken-binding row, not silence', async () => {
        // `readState` returns null for a MISSING sidecar but THROWS for a
        // malformed one. Unwrapped, that throw reaches this method's outer
        // fail-open catch and produces NO ROW — which is how Station says
        // "there is no Builder run here". A corrupt run would then be
        // indistinguishable from an absent one.
        const cwd = createTaskWorkspace();
        writeBuilderSidecar(cwd, 'corrupt-run', null);
        await service.dispatch(
          {
            type: 'startSession',
            input: {
              threadId: 'corrupt-session',
              provider: 'claude',
              modelId: 'claude-sonnet',
              cwd,
              metadata: { taskSlug: 'corrupt-run' },
            },
          },
          undefined,
          { workflowSidecarAttachMode: 'read-only-join' },
        );

        // Truncate the real file on disk, after the binding was recorded.
        const statePath = join(
          cwd,
          '.kontourai',
          'flow-agents',
          'corrupt-run',
          'state.json',
        );
        writeFileSync(statePath, readFileSync(statePath, 'utf8').slice(0, 40));
        expect(() =>
          workflowSidecarService.readState(cwd, 'corrupt-run'),
        ).toThrow();

        const view = await service.readSessionBuilderRun('corrupt-session');
        expect(view).toMatchObject({
          matchKind: 'started-by-station',
          identityStatus: 'unavailable',
          taskSlug: 'corrupt-run',
          taskSidecarUnreadable: true,
        });
        expect(view?.reason).toContain('no longer readable');
        expect(view?.flowRun).toBeUndefined();
      });

      test('the default attach mode still touches the sidecar Station owns', async () => {
        // The no-touch rule is scoped to the read-side join, not applied
        // globally: a workflow Station itself owns must still record activity,
        // or this fix would silently disable the durable-memory path.
        //
        // The fixture is seeded with a deliberately old `updated_at` rather
        // than "now". Comparing two same-run timestamps would rest the whole
        // pin on a millisecond clock tick landing between the two writes —
        // green by luck, and red by luck too. Against a 2020 baseline any real
        // write is unambiguously later.
        const cwd = createTaskWorkspace();
        const seeded = '2020-01-01T00:00:00.000Z';
        writeBuilderSidecar(cwd, 'owned-run', null, seeded);

        await service.dispatch({
          type: 'startSession',
          input: {
            threadId: 'owned-session',
            provider: 'claude',
            modelId: 'claude-sonnet',
            cwd,
            metadata: { taskSlug: 'owned-run' },
          },
        });

        const after = workflowSidecarService.readState(cwd, 'owned-run');
        expect(Date.parse(after?.updated_at ?? '')).toBeGreaterThan(
          Date.parse(seeded),
        );
      });

      test('a read-only join whose sidecar vanished binds nothing rather than creating it', async () => {
        const cwd = createTaskWorkspace();
        await service.dispatch(
          {
            type: 'startSession',
            input: {
              threadId: 'vanished-join',
              provider: 'claude',
              modelId: 'claude-sonnet',
              cwd,
              metadata: { taskSlug: 'never-existed' },
            },
          },
          undefined,
          { workflowSidecarAttachMode: 'read-only-join' },
        );

        expect(
          existsSync(join(cwd, '.kontourai', 'flow-agents', 'never-existed')),
        ).toBe(false);
        expect(await workflowEvents(service, 'vanished-join')).toHaveLength(0);
      });
    });
  });
});

// ── Session-lifecycle logger.child correlation (archive#1897 logging slice 3) ──

describe('OrchestrationService — session lifecycle logger correlation', () => {
  let tmp: string;
  let logDirectory: string;
  let eventStore: EventStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'orchestration-correlation-'));
    logDirectory = mkdtempSync(
      join(tmpdir(), 'orchestration-correlation-logs-'),
    );
    installServerLogSink({ directory: logDirectory });
    eventStore = new EventStore(join(tmp, 'orchestration.sqlite'));
  });

  afterEach(() => {
    eventStore.close();
    resetServerLogSinkForTests();
    rmSync(tmp, { recursive: true, force: true });
    rmSync(logDirectory, { recursive: true, force: true });
    receiptBus.resetForTest();
  });

  test('a successful session start logs "Session started" through a conversation+agent-bound child logger, retrievable via ServerLogReader q=<threadId>', async () => {
    const bedrock = new FakeAdapter('bedrock');
    const realLogger = createLogger({
      name: 'orchestration-lifecycle-correlation-test',
      level: 'debug',
    });
    const service = new OrchestrationService({
      adapterRegistry: createRegistry([bedrock]),
      eventBus: new EventBus(),
      eventStore,
      listProjects: () => [],
      logger: realLogger,
    });

    await service.dispatchWithReceipt({
      type: 'startSession',
      input: {
        threadId: 'conv-lifecycle-1',
        provider: 'bedrock',
        metadata: { agentSlug: 'station' },
      },
    });

    await new Promise((resolve) => setImmediate(resolve));
    const reader = createServerLogReader({ directory: logDirectory });
    const result = await reader.query({ q: 'conv-lifecycle-1' });
    const started = result.entries.find((e) => e.msg === 'Session started');
    expect(started).toBeDefined();
    expect(started?.[LOG_BINDING_KEYS.CONVERSATION_ID]).toBe(
      'conv-lifecycle-1',
    );
    expect(started?.[LOG_BINDING_KEYS.AGENT_SLUG]).toBe('station');
  });

  test('a fail-open policy-hook binding failure warns through the SAME session-bound child logger', async () => {
    const bedrock = new FakeAdapter('bedrock');
    const realLogger = createLogger({
      name: 'orchestration-lifecycle-correlation-test-2',
      level: 'debug',
    });
    const cwd = mkdtempSync(join(tmpdir(), 'orchestration-correlation-cwd-'));
    const throwingPolicyService = {
      isWorkspaceOptedIn: () => {
        throw new Error('synthetic policy check failure');
      },
      profile: 'default',
      engineAvailable: false,
    } as unknown as AgentPolicyService;
    const service = new OrchestrationService({
      adapterRegistry: createRegistry([bedrock]),
      eventBus: new EventBus(),
      eventStore,
      listProjects: () => [],
      agentPolicyService: throwingPolicyService,
      logger: realLogger,
    });

    await service.dispatchWithReceipt({
      type: 'startSession',
      input: {
        threadId: 'conv-lifecycle-2',
        provider: 'bedrock',
        cwd,
        metadata: { agentSlug: 'station' },
      },
    });

    await new Promise((resolve) => setImmediate(resolve));
    const reader = createServerLogReader({ directory: logDirectory });
    const result = await reader.query({ q: 'conv-lifecycle-2', level: 'warn' });
    const warned = result.entries.find(
      (e) => e.msg === 'Failed to bind policy hooks to session',
    );
    expect(warned).toBeDefined();
    expect(warned?.[LOG_BINDING_KEYS.CONVERSATION_ID]).toBe('conv-lifecycle-2');
    expect(warned?.[LOG_BINDING_KEYS.AGENT_SLUG]).toBe('station');
  });
});

// archive#3530: credential profiles already store one app-home per account
// (`credentialProfileStorageId(engineId, ref)`), but selection lived on the
// CONNECTION, so every agent on an engine shared one account. An agent can now
// name its own via `execution.credentialProfileRef`, applied at the shared
// start seam so ordinary starts and credential restarts both honor it.
describe('OrchestrationService — agent-pinned credential profile', () => {
  let tmp: string;
  let eventStore: EventStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'orchestration-credential-profile-'));
    eventStore = new EventStore(join(tmp, 'orchestration.sqlite'));
  });

  afterEach(() => {
    eventStore.close();
    rmSync(tmp, { recursive: true, force: true });
    receiptBus.resetForTest();
  });

  const startWith = async (options: {
    execution?: AgentExecutionConfig;
    loadThrows?: boolean;
    agentSlug?: string | undefined;
    credentialProfileRef?: string;
  }) => {
    const bedrock = new FakeAdapter('bedrock');
    const service = new OrchestrationService({
      adapterRegistry: createRegistry([bedrock]),
      eventBus: new EventBus(),
      eventStore,
      listProjects: () => [],
      loadAgentExecutionConfig: async () => {
        if (options.loadThrows) throw new Error('agent store unavailable');
        return options.execution;
      },
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    await service.dispatch({
      type: 'startSession',
      input: {
        threadId: 'credential-profile-thread',
        provider: 'bedrock',
        ...(options.credentialProfileRef
          ? { credentialProfileRef: options.credentialProfileRef }
          : {}),
        ...(options.agentSlug === undefined
          ? {}
          : { metadata: { agentSlug: options.agentSlug } }),
      },
    });
    return bedrock.startSession.mock.calls.at(-1)?.[0];
  };

  test("applies the agent's pinned credential profile to the provider session start", async () => {
    const input = await startWith({
      agentSlug: 'work-agent',
      execution: {
        agentConnectionId: engineConnectionId('bedrock'),
        credentialProfileRef: 'work-account',
      },
    });
    expect(input?.credentialProfileRef).toBe('work-account');
  });

  test('two agents on one engine reach two different accounts', async () => {
    const work = await startWith({
      agentSlug: 'work-agent',
      execution: {
        agentConnectionId: engineConnectionId('bedrock'),
        credentialProfileRef: 'work-account',
      },
    });
    const personal = await startWith({
      agentSlug: 'personal-agent',
      execution: {
        agentConnectionId: engineConnectionId('bedrock'),
        credentialProfileRef: 'personal-account',
      },
    });
    expect(work?.credentialProfileRef).toBe('work-account');
    expect(personal?.credentialProfileRef).toBe('personal-account');
  });

  // The public dispatch surface refuses a caller-supplied ref outright
  // ("reserved for Station-managed recovery"). Pinning an agent must not open
  // that hole: an agent pin is read from the agent's own persisted definition,
  // never accepted from the session-start caller.
  test('the public start path still refuses a caller-supplied credential profile ref', async () => {
    await expect(
      startWith({
        agentSlug: 'work-agent',
        credentialProfileRef: 'caller-supplied',
      }),
    ).rejects.toThrow(/reserved for Station-managed recovery/);
  });

  // Credential recovery deliberately supplies a candidate ref to try, through
  // the internal escape hatch. A retry that ignored the candidate in favor of
  // the agent's pin would defeat recovery, so the pin only ever FILLS an
  // absent value.
  test("Station-managed recovery's explicit ref wins over the agent pin", async () => {
    const bedrock = new FakeAdapter('bedrock');
    const service = new OrchestrationService({
      adapterRegistry: createRegistry([bedrock]),
      eventBus: new EventBus(),
      eventStore,
      listProjects: () => [],
      loadAgentExecutionConfig: async () => ({
        agentConnectionId: engineConnectionId('bedrock'),
        credentialProfileRef: 'work-account',
      }),
      logger: { debug: vi.fn(), warn: vi.fn() },
    });

    // `OrchestrationStartSessionInput` deliberately OMITS credentialProfileRef
    // — that is the type-level half of "reserved for Station-managed
    // recovery", with the runtime `in input` check as the second layer. The
    // production path that legitimately carries a ref
    // (`restartCredentialProfileProviderSession`) builds a
    // `ProviderSessionStartInput` directly rather than going through this
    // command type, so the cast here reproduces that shape rather than
    // widening the command contract. Everything from the guard onward is the
    // real path, unlocked by `credentialProfileApplication`.
    const recoveryCommand = {
      type: 'start-session' as const,
      input: {
        threadId: 'credential-profile-recovery',
        provider: 'bedrock' as const,
        credentialProfileRef: 'recovery-candidate',
        metadata: { agentSlug: 'work-agent' },
      },
    };
    const outcome = await service.startSessionInternal(
      recoveryCommand as unknown as Parameters<
        typeof service.startSessionInternal
      >[0],
      {},
      { credentialProfileApplication: true },
    );
    if (outcome.status !== 'accepted') throw new Error(outcome.message);

    expect(
      bedrock.startSession.mock.calls.at(-1)?.[0]?.credentialProfileRef,
    ).toBe('recovery-candidate');
  });

  // Every degradation path must leave today's behavior byte-identical, so the
  // connection's own active profile still resolves downstream.
  test('an agent with no pin leaves the start input untouched', async () => {
    const input = await startWith({
      agentSlug: 'unpinned-agent',
      execution: { agentConnectionId: engineConnectionId('bedrock') },
    });
    expect(input?.credentialProfileRef).toBeUndefined();
  });

  test('an agent-less session leaves the start input untouched', async () => {
    const input = await startWith({ agentSlug: undefined });
    expect(input?.credentialProfileRef).toBeUndefined();
  });

  test('a blank pin is treated as no preference, not as a profile named ""', async () => {
    const input = await startWith({
      agentSlug: 'blank-agent',
      execution: {
        agentConnectionId: engineConnectionId('bedrock'),
        credentialProfileRef: '   ',
      },
    });
    expect(input?.credentialProfileRef).toBeUndefined();
  });

  // This previously asserted the OPPOSITE — that a failed load degrades to the
  // connection's profile — on the reasoning that it means "no preference".
  // Independent review (Codex) called that a HIGH, correctly: the load failing
  // means we do not know WHETHER the agent expressed one, and those are
  // different facts. Continuing ran a pinned agent on whatever account the
  // connection selected, billing and attributing the turn to the wrong
  // account, silently.
  //
  // It now fails the start. That is a real availability regression for an
  // erroring agent store, taken deliberately: a loud refusal is recoverable,
  // a turn on the wrong account is not.
  test('a failing execution-config load fails the start rather than guessing the account', async () => {
    await expect(
      startWith({ agentSlug: 'broken-agent', loadThrows: true }),
    ).rejects.toThrow(/could not be read|which account/i);
  });
});
