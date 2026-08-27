// Type-only imports back into the service module: erased at runtime, so no
// import cycle exists.
import type { FlowEvidenceEntry } from '@kontourai/flow';
import { isRetiredFlowDefinition } from '@kontourai/station-contracts';
import type { OrchestrationSessionDetail } from '@kontourai/station-contracts/orchestration';
import type { ProviderKind } from '@kontourai/station-contracts/provider';
import type {
  CanonicalRuntimeEvent,
  FlowGateVerdictEvent,
  FlowRunFreshness,
} from '@kontourai/station-contracts/runtime-events';
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
import type { SessionBuilderRunView } from '@kontourai/station-contracts/workflow';
import type { SessionLifecycleState } from '../../../packages/contracts/src/session-lifecycle.js';
import type { ProviderAdapterShape } from '../../providers/adapter-shape.js';
// IMPORTANT (T12): the suite vi.mocks '../../../telemetry/metrics.js' by
// resolved module id; from this directory the compliant specifier is
// '../../telemetry/metrics.js'. A barrel or different depth silently gets
// the REAL counters under a mocked suite and reds an unrelated assertion.
import {
  flowSessionGateChecks,
  uiSessionBoardActions,
  workflowSidecarBindings,
} from '../../telemetry/metrics.js';
import {
  type AgentPolicyService,
  extractToolFilePath,
  resolveSessionPolicyBinding,
} from '../agents/agent-policy-service.js';
import { DefaultCommandEvidenceRoutingPolicy } from '../evidence/command-evidence-routing-policy.js';
import {
  attachWorkflowSidecarForSessionStart,
  buildWorkflowStateChangedEvent,
  resolveSessionWorkflowBinding,
  type SessionWorkflowBinding,
  stationWorkflowActorKey,
  type WorkflowSidecarAttachMode,
  workflowPatchForCompletion,
  workflowPatchForGateVerdict,
} from '../evidence/orchestration-workflow-sidecar.js';
import {
  readBoundTaskState,
  resolveSessionBuilderRun,
} from '../evidence/session-builder-run-join.js';
import type { VeritasReadinessService } from '../evidence/veritas-readiness-service.js';
import type { WorkflowSidecarService } from '../evidence/workflow-sidecar-service.js';
import { FlowCommandEvidenceBridge } from '../flow/flow-command-evidence-bridge.js';
import { FlowReadinessBridge } from '../flow/flow-readiness-bridge.js';
import { deriveFlowRunFreshness } from '../flow/flow-run-freshness.js';
import type {
  AttachFlowEvidenceOptions,
  FlowRunService,
  FlowRunStatus,
} from '../flow/flow-run-service.js';
import { FlowRunNotFoundError } from '../flow/flow-run-service.js';
import {
  attachFlowRunForSessionStart,
  evaluateFlowCompletionGate,
  type FlowAttachWarning,
  resolveSessionFlowBinding,
  type SessionFlowBinding,
} from '../flow/orchestration-flow-gate.js';
// Type-only import back into the service module: erased at runtime, so no
// import cycle exists.
import type { SessionReadScope } from './orchestration-service.js';

/**
 * Pull a shell command line out of a tool call's arguments. Connected runtimes
 * name the argument differently (`command`/`cmd`/`script`); returns null when
 * none is present (the tool is not a command runner, or has no command).
 */
function extractToolCommand(toolInput: unknown): string | null {
  if (!toolInput || typeof toolInput !== 'object') return null;
  const record = toolInput as Record<string, unknown>;
  for (const key of ['command', 'cmd', 'script']) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/** Normalize a tool-call output/error payload to a string for evidence. */
function stringifyToolPayload(payload: unknown): string {
  if (payload === undefined || payload === null) return '';
  if (typeof payload === 'string') return payload;
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

type FlowPolicyLogger = {
  debug(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
};

export interface FlowPolicySidecarDeps {
  /**
   * Called, not captured, in METHOD bodies: reads the LIVE option per call.
   * Read ONCE in the ctor for the two bridges — see the ctor docblock for
   * why the two read styles deliberately differ.
   */
  flowRunService: () => FlowRunService | undefined;
  /** Ctor-only (the readiness bridge's second guard); no method body reads it. */
  veritasReadinessService: () => VeritasReadinessService | undefined;
  agentPolicyService: () => AgentPolicyService | undefined;
  workflowSidecarService: () => WorkflowSidecarService | undefined;
  /**
   * C2's projection+publish. Returns boolean in-service; every site here
   * discards it, so this is `void` on purpose (CooperativeStop precedent).
   */
  publishEvent: (event: CanonicalRuntimeEvent) => void;
  /**
   * The SERVICE forwarder, never a lower collaborator: the four public
   * readers keep their T9 `initialize()` latch on the service side, and
   * this read must compose identically to in-service.
   */
  readSession: (
    threadId: string,
    authority: SessionReadScope,
  ) => Promise<OrchestrationSessionDetail | null>;
  /** C7 stays on the service (`listAgentRuns` shares its helper). */
  runtimeKindFor: (provider: ProviderKind) => string;
  /** The module-level helper C7 also uses — a dep, never a copy. */
  engineExecutionForAdapter: (adapter: ProviderAdapterShape) => string;
  /**
   * The `?.` and `?.payload` are absorbed at the ctor seam so this module
   * never sees the event store, and C7's terminal rename inherits one
   * named reader (T13).
   */
  latestEventPayloadByMethod: (
    threadId: string,
    method: CanonicalRuntimeEvent['method'],
  ) => CanonicalRuntimeEvent | undefined;
  logger: FlowPolicyLogger;
}

/**
 * Flow run / policy hooks / workflow sidecar (epic #4024 slice 11, #4218):
 * the C15 cluster — seven owned fields, fourteen methods, the biggest
 * island in the remaining core (fourteen moved bodies; the class declares
 * seventeen members — the two `forget*` seam accessors and the
 * `prepareCompletion` entry point are new here). Load-bearing orderings (T5): the two
 * ingest calls (`applyPostHocToolPolicies`, `spoolCommandEvidence`) sit
 * BELOW the spine's "coalescer took it" continue-gate (pinned by a source
 * invariant); inside `prepareCompletion` the flow gate runs BEFORE the
 * policy stop gate and the sidecar `apply` is deferred to the lifecycle
 * module's REVALIDATED events; the binder order is flow run → sidecar →
 * policy hooks (the flow attach writes the event `isFlowBoundThread`
 * later reads back). The teardown flags for `policyThreads`/
 * `flowBoundThreads` stay INSIDE the service's `forgetThreadState` seam
 * (T10(3)); this module exposes `forgetPolicyBinding`/`forgetFlowBinding`
 * accessors. No Map handle crosses the seam (T13); the three counters
 * import from the T12-compliant specifier.
 */
export class FlowPolicySidecar {
  private readonly readinessBridge?: FlowReadinessBridge;
  private readonly commandEvidenceBridge?: FlowCommandEvidenceBridge;
  /** Same instance the command-evidence bridge routes with (station#189 S2). */
  private readonly commandEvidenceRoutingPolicy =
    new DefaultCommandEvidenceRoutingPolicy();
  /**
   * threadId -> policy workspace cwd, null when known-unbound. Fed by
   * policy.hooks-attached events and lazily rehydrated from the event store
   * so recovered sessions stay policy-bound across restarts.
   */
  private readonly policyThreads = new Map<string, string | null>();
  /** `${threadId}:${toolCallId}` -> write target (post-hoc quality gate). */
  private readonly pendingPolicyWrites = new Map<string, string>();
  /**
   * `${threadId}:${toolCallId}` -> { command, toolName } captured from a
   * `tool.started` event, awaiting its `tool.completed` to spool as command
   * evidence (S1a slice 3).
   */
  private readonly pendingCommandSpools = new Map<
    string,
    { command: string; toolName: string }
  >();
  /** threadId -> is flow-bound (cached; gates command-evidence spooling). */
  private readonly flowBoundThreads = new Map<string, boolean>();

  /**
   * The bridges read `flowRunService`/`veritasReadinessService` EAGERLY,
   * once, at construction — matching the original ctor semantics and
   * preserving routing-policy IDENTITY (the bridge must route with the
   * same instance this module hands to flow attachment). Method bodies
   * read `deps.flowRunService()` LAZILY per call. Do not unify the two
   * styles: eager-everywhere breaks the live-option reads; lazy-everywhere
   * rebuilds bridges per call and breaks identity.
   */
  constructor(private readonly deps: FlowPolicySidecarDeps) {
    const flowRunService = deps.flowRunService();
    const readinessService = deps.veritasReadinessService();
    if (flowRunService && readinessService) {
      this.readinessBridge = new FlowReadinessBridge({
        flowRunService,
        readinessService,
      });
    }
    if (flowRunService) {
      this.commandEvidenceBridge = new FlowCommandEvidenceBridge({
        flowRunService,
        policy: this.commandEvidenceRoutingPolicy,
      });
    }
  }

  /**
   * The completion choke point, whole: the two gates IN ORDER — flow gate
   * first (it can throw and its verdict feeds the sidecar patch), policy
   * stop gate second — and the deferred sidecar `apply` the lifecycle
   * module invokes against its REVALIDATED events. Handed to
   * `createSessionLifecycleModule` as `prepareCompletion`; that ctor
   * closure is its only caller (T4: callback-only).
   */
  async prepareCompletion(input: {
    threadId: string;
    provider: ProviderKind;
    events: CanonicalRuntimeEvent[];
    fromState: SessionLifecycleState;
  }): Promise<{ apply(events: CanonicalRuntimeEvent[]): void }> {
    const flowVerdict = await this.enforceFlowCompletionGate(input);
    await this.enforcePolicyStopGate(input);
    return {
      apply: (events) =>
        this.applyWorkflowSidecarTransition({
          threadId: input.threadId,
          provider: input.provider,
          events,
          patch: workflowPatchForCompletion(flowVerdict),
          trigger: 'completion',
        }),
    };
  }

  /** Seam aspect `policyThreads` (T2). Drops the cached policy-cwd binding. */
  forgetPolicyBinding(threadId: string): void {
    this.policyThreads.delete(threadId);
  }

  /** Seam aspect `flowBoundThreads` (T2). Drops the cached flow-bound verdict. */
  forgetFlowBinding(threadId: string): void {
    this.flowBoundThreads.delete(threadId);
  }

  /**
   * Read the Flow run bound to a session (null when the session is not
   * Flow-bound). REST callers use this to resolve the run id, then operate
   * through the existing /api/projects/:slug/flow routes.
   *
   * The view carries freshness alongside the run (station#189 S1) so every
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
    const flowRunService = this.deps.flowRunService();
    if (!flowRunService) return null;
    const detail = await this.deps.readSession(threadId, authority);
    if (!detail) return null;
    const binding = resolveSessionFlowBinding(detail.events);
    if (!binding) return null;
    const run = await flowRunService.getRun(binding.cwd, binding.runId);
    const freshness = deriveFlowRunFreshness({
      state: run.state,
      openGates: run.openGates,
      manifestEvidence: run.manifest.evidence,
    });
    return { ...binding, run, ...freshness };
  }

  /**
   * The Builder run joined to this session (station#189 S4), read entirely
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
    const sidecarService = this.deps.workflowSidecarService();
    if (!sidecarService) return null;
    const detail = await this.deps.readSession(threadId, authority);
    if (!detail) return null;
    const binding = resolveSessionWorkflowBinding(detail.events);
    // The binding's own cwd wins when Station recorded one: it is the
    // workspace the sidecar was actually written in, which a later session
    // summary can no longer be assumed to agree with.
    const cwd = binding?.cwd ?? detail.session.cwd;
    if (!cwd) return null;
    try {
      return resolveSessionBuilderRun({
        threadId,
        binding,
        // Exact read for the bound task (never picked out of the scan below —
        // see `boundTaskState`), and the scan only for the correlation path.
        // The read is wrapped because a corrupt sidecar must render the
        // broken-binding row, not fall through this method's outer catch into
        // no row at all — see `readBoundTaskState`.
        boundTaskState: binding
          ? readBoundTaskState(sidecarService, binding, (error) => {
              this.deps.logger.warn(
                'Bound Builder task sidecar is unreadable',
                {
                  threadId,
                  taskSlug: binding.taskSlug,
                  error: error instanceof Error ? error.message : String(error),
                },
              );
            })
          : null,
        tasks: binding ? [] : sidecarService.listTasks(cwd),
      });
    } catch (error) {
      // Fail-open like every other sidecar read on this path: an unreadable
      // workspace is "no join available", never a failed session read.
      this.deps.logger.warn('Failed to resolve session Builder run', {
        threadId,
        cwd,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Attach evidence to the session's Flow run without the caller knowing the
   * run id (session -> run resolution happens here).
   */
  async attachSessionEvidence(
    threadId: string,
    options: AttachFlowEvidenceOptions,
  ): Promise<FlowEvidenceEntry> {
    const flowRunService = this.deps.flowRunService();
    if (!flowRunService) {
      throw new FlowRunNotFoundError('Flow run service is not configured');
    }
    const detail = await this.deps.readSession(
      threadId,
      INTERNAL_SESSION_READ_SCOPE,
    );
    if (!detail) {
      throw new FlowRunNotFoundError(`Session not found: ${threadId}`);
    }
    const binding = resolveSessionFlowBinding(detail.events);
    if (!binding) {
      throw new FlowRunNotFoundError(
        `No Flow run bound to session: ${threadId}`,
      );
    }
    return flowRunService.attachEvidence(binding.cwd, binding.runId, options);
  }

  /**
   * Bind only a caller-declared standard Flow definition. The retired
   * `station-delivery` lifecycle and alphabetical workspace fallback must
   * never create a run merely because a session started in a Flow workspace.
   */
  async bindExplicitFlowRunToSession(
    input: {
      threadId: string;
      provider: ProviderKind;
      cwd?: string;
      metadata?: Record<string, unknown>;
    },
    logger: FlowPolicyLogger = this.deps.logger,
  ): Promise<void> {
    const flowRunService = this.deps.flowRunService();
    const definition = input.metadata?.flowDefinition;
    if (
      !flowRunService ||
      !input.cwd ||
      typeof definition !== 'string' ||
      definition.length === 0 ||
      isRetiredFlowDefinition(definition)
    ) {
      return;
    }
    try {
      const warnings: FlowAttachWarning[] = [];
      const event = await attachFlowRunForSessionStart({
        flowRunService,
        input,
        routingPolicy: this.commandEvidenceRoutingPolicy,
        emitWarning: (warning) => warnings.push(warning),
        logger,
      });
      if (event) this.deps.publishEvent(event);
      for (const warning of warnings) {
        logger.warn(warning.message, {
          threadId: input.threadId,
          code: warning.code,
          ...warning.details,
        });
        this.deps.publishEvent({
          eventId: crypto.randomUUID(),
          provider: input.provider,
          threadId: input.threadId,
          createdAt: new Date().toISOString(),
          method: 'runtime.warning',
          severity: 'warning',
          message: warning.message,
          code: warning.code,
          details: warning.details,
        });
      }
    } catch (error) {
      logger.warn('Failed to bind explicit Flow run to session', {
        threadId: input.threadId,
        cwd: input.cwd,
        definition,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Completion choke point: a Flow-bound session may only transition to
   * 'completed' on a 'pass' verdict. Every check emits a `flow.gate-verdict`
   * event (guidance lands in session history); non-pass verdicts reject the
   * transition. Sessions without a Flow binding pass through unchanged.
   */
  private async enforceFlowCompletionGate(options: {
    threadId: string;
    provider: ProviderKind;
    events: CanonicalRuntimeEvent[];
    fromState: SessionLifecycleState;
  }): Promise<FlowGateVerdictEvent | undefined> {
    const flowRunService = this.deps.flowRunService();
    if (!flowRunService) return undefined;
    const binding = resolveSessionFlowBinding(options.events);
    if (!binding) return undefined;

    const verdictEvent = await evaluateFlowCompletionGate({
      flowRunService,
      binding,
      provider: options.provider,
      threadId: options.threadId,
      readinessBridge: this.readinessBridge,
      commandEvidenceBridge: this.commandEvidenceBridge,
      logger: this.deps.logger,
    });
    this.deps.publishEvent(verdictEvent);
    flowSessionGateChecks.add(1, {
      verdict: verdictEvent.verdict,
      definition: binding.definitionId,
    });

    if (verdictEvent.verdict !== 'pass') {
      // The verdict's guidance outlives this session: a task-bound sidecar
      // records it as the durable next_action before the transition is
      // rejected, so the NEXT session (any runtime kind) resumes from it.
      this.applyWorkflowSidecarTransition({
        threadId: options.threadId,
        provider: options.provider,
        events: options.events,
        patch: workflowPatchForGateVerdict(verdictEvent),
        trigger: 'gate-verdict',
      });
      uiSessionBoardActions.add(1, {
        action: 'completed',
        outcome: `flow_gate_${verdictEvent.verdict}`,
        state: options.fromState,
      });
      const guidance =
        verdictEvent.nextAction ?? verdictEvent.summary ?? 'gate not satisfied';
      throw new Error(
        `Flow gate verdict: ${verdictEvent.verdict} — ${guidance}`,
      );
    }
    return verdictEvent;
  }

  /**
   * Bind a starting session to its durable workflow sidecar when the caller
   * passed an explicit `metadata.taskSlug` (mirroring `metadata.flowDefinition`).
   * The emitted `workflow.state-changed` event is the event-sourced binding;
   * the sidecar file is the durable cross-runtime memory. Fail-open: binding
   * errors are logged, never block session start.
   */
  bindWorkflowSidecarToSession(
    input: {
      threadId: string;
      provider: ProviderKind;
      cwd?: string;
      metadata?: Record<string, unknown>;
    },
    mode?: WorkflowSidecarAttachMode,
    logger: FlowPolicyLogger = this.deps.logger,
  ): void {
    const sidecarService = this.deps.workflowSidecarService();
    if (!sidecarService) return;
    try {
      const event = attachWorkflowSidecarForSessionStart({
        sidecarService,
        input,
        ...(mode ? { mode } : {}),
      });
      if (event) {
        this.deps.publishEvent(event);
        workflowSidecarBindings.add(1, {
          resumed: String(event.resumed),
          runtime_kind: this.deps.runtimeKindFor(input.provider),
        });
      }
    } catch (error) {
      logger.warn('Failed to bind workflow sidecar to session', {
        threadId: input.threadId,
        cwd: input.cwd,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Apply a sidecar transition for a workflow-bound session and publish the
   * `workflow.state-changed` event. No-op for unbound sessions; fail-open on
   * sidecar errors (the lifecycle transition itself must not be disturbed by
   * sidecar bookkeeping).
   */
  private applyWorkflowSidecarTransition(options: {
    threadId: string;
    provider: ProviderKind;
    events: CanonicalRuntimeEvent[];
    patch: Parameters<WorkflowSidecarService['transition']>[2];
    trigger: 'gate-verdict' | 'completion';
  }): void {
    const sidecarService = this.deps.workflowSidecarService();
    if (!sidecarService) return;
    const binding = resolveSessionWorkflowBinding(options.events);
    if (!binding) return;
    if (binding.ownership === 'read-only-join') return;
    if (binding.ownership !== 'station-owned') {
      this.deps.logger.warn(
        'Refused workflow sidecar transition with ambiguous ownership',
        {
          threadId: options.threadId,
          taskSlug: binding.taskSlug,
          trigger: options.trigger,
        },
      );
      return;
    }
    try {
      const state = sidecarService.transition(
        binding.cwd,
        binding.taskSlug,
        options.patch,
        { trigger: options.trigger },
      );
      this.deps.publishEvent(
        buildWorkflowStateChangedEvent({
          provider: options.provider,
          threadId: options.threadId,
          cwd: binding.cwd,
          state,
          ownership: binding.ownership,
          trigger: options.trigger,
          resumed: true,
        }),
      );
    } catch (error) {
      this.deps.logger.warn('Workflow sidecar transition failed (fail-open)', {
        threadId: options.threadId,
        taskSlug: binding.taskSlug,
        trigger: options.trigger,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Read the workflow sidecar binding + current durable state for a session
   * (null when the session is not task-bound).
   *
   * NO CALLER TODAY (station#4218 review M1): the previous sentence here
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
    const sidecarService = this.deps.workflowSidecarService();
    if (!sidecarService) return null;
    const detail = await this.deps.readSession(threadId, authority);
    if (!detail) return null;
    const binding = resolveSessionWorkflowBinding(detail.events);
    if (!binding) return null;
    return {
      ...binding,
      state: sidecarService.readState(binding.cwd, binding.taskSlug),
    };
  }

  /**
   * Bind Flow Agents policy enforcement to a session starting in an opted-in
   * workspace (the workspace has `.flow-agents/`). Event-sourced like the
   * Flow run binding: the policy.hooks-attached event in session history is
   * authoritative and survives restarts. Fail-open: binding errors are
   * logged, never block session start.
   */
  bindPolicyHooksToSession(
    input: {
      threadId: string;
      provider: ProviderKind;
      cwd?: string;
    },
    logger: FlowPolicyLogger = this.deps.logger,
  ): void {
    const policyService = this.deps.agentPolicyService();
    if (!policyService || !input.cwd) return;
    try {
      if (!policyService.isWorkspaceOptedIn(input.cwd)) return;
      this.policyThreads.set(input.threadId, input.cwd);
      this.deps.publishEvent({
        eventId: crypto.randomUUID(),
        provider: input.provider,
        threadId: input.threadId,
        createdAt: new Date().toISOString(),
        method: 'policy.hooks-attached',
        cwd: input.cwd,
        profile: policyService.profile,
        engine: policyService.engineAvailable ? 'native' : 'typescript',
      });
    } catch (error) {
      logger.warn('Failed to bind policy hooks to session', {
        threadId: input.threadId,
        cwd: input.cwd,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Completion choke point for the stop-goal-fit policy, evaluated beside
   * the Flow gate. Every check on a policy-bound session emits a
   * `policy.stop-verdict` event when there are findings; only strict mode
   * ('block') rejects the transition — the default surfaces warnings into
   * session history and lets the completion proceed.
   */
  private async enforcePolicyStopGate(options: {
    threadId: string;
    provider: ProviderKind;
    events: CanonicalRuntimeEvent[];
    fromState: SessionLifecycleState;
  }): Promise<void> {
    const policyService = this.deps.agentPolicyService();
    if (!policyService) return;
    const binding = resolveSessionPolicyBinding(options.events);
    if (!binding) return;

    const result = await policyService.checkStop(
      {
        cwd: binding.cwd,
        actorKey: stationWorkflowActorKey(options.threadId),
      },
      { runtimeKind: this.deps.runtimeKindFor(options.provider) },
    );
    if (result.verdict === 'pass') return;

    this.deps.publishEvent({
      eventId: crypto.randomUUID(),
      provider: options.provider,
      threadId: options.threadId,
      createdAt: new Date().toISOString(),
      method: 'policy.stop-verdict',
      policy: 'stop-goal-fit',
      verdict: result.verdict,
      warnings: result.warnings,
      strict: result.strict,
    });

    if (result.verdict === 'block') {
      uiSessionBoardActions.add(1, {
        action: 'completed',
        outcome: 'policy_stop_goal_fit_block',
        state: options.fromState,
      });
      const guidance = result.warnings[0] ?? 'goal fit incomplete';
      throw new Error(`Policy stop-goal-fit verdict: block — ${guidance}`);
    }
  }

  /**
   * Post-hoc policy seam for runtimes Station cannot pre-empt (connected and
   * ACP agents own their tool dispatch — Station only sees tool events after
   * the fact on the adapter stream). Protected-config writes and quality-gate
   * findings surface as `runtime.warning` events in session history; managed
   * agents are skipped here because their pre-execution hook seam already
   * enforces these policies before dispatch.
   */
  applyPostHocToolPolicies(
    adapter: ProviderAdapterShape,
    event: CanonicalRuntimeEvent,
  ): void {
    const policyService = this.deps.agentPolicyService();
    if (!policyService) return;
    if (this.deps.engineExecutionForAdapter(adapter) === 'station') return;
    const cwd = this.resolvePolicyCwd(event.threadId);
    if (!cwd) return;

    try {
      if (event.method === 'tool.started') {
        if (!policyService.isWriteTool(event.toolName)) return;
        const filePath = extractToolFilePath(event.arguments);
        if (!filePath) return;
        this.pendingPolicyWrites.set(
          `${event.threadId}:${event.toolCallId}`,
          filePath,
        );
        const verdict = policyService.checkToolCall(
          event.toolName,
          event.arguments,
          { cwd, runtimeKind: this.deps.runtimeKindFor(event.provider) },
        );
        if (verdict.decision === 'block') {
          this.deps.publishEvent({
            eventId: crypto.randomUUID(),
            provider: event.provider,
            threadId: event.threadId,
            createdAt: new Date().toISOString(),
            method: 'runtime.warning',
            severity: 'warning',
            code: 'policy.config-protection.post-hoc',
            message:
              `Config-protection policy flagged ${event.toolName} on ` +
              `${filePath} (post-hoc — this runtime dispatches tools ` +
              `natively, so Station cannot block): ${verdict.reason ?? ''}`.trim(),
            details: { toolName: event.toolName, filePath },
          });
        }
        return;
      }

      if (event.method === 'tool.completed') {
        const key = `${event.threadId}:${event.toolCallId}`;
        const filePath = this.pendingPolicyWrites.get(key);
        if (!filePath) return;
        this.pendingPolicyWrites.delete(key);
        if (event.status !== 'success') return;
        const { warnings } = policyService.afterWrite(filePath, {
          cwd,
          runtimeKind: this.deps.runtimeKindFor(event.provider),
        });
        for (const warning of warnings) {
          this.deps.publishEvent({
            eventId: crypto.randomUUID(),
            provider: event.provider,
            threadId: event.threadId,
            createdAt: new Date().toISOString(),
            method: 'runtime.warning',
            severity: 'warning',
            code: 'policy.quality-gate',
            message: warning,
            details: { toolName: event.toolName, filePath },
          });
        }
      }
    } catch (error) {
      this.deps.logger.warn('Post-hoc policy check failed (fail-open)', {
        threadId: event.threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Spool command-tool output for flow command-evidence auto-attach (S1a slice
   * 3). On `tool.started` the command line is remembered (correlated by
   * toolCallId); on `tool.completed` the captured output is handed to the
   * command-evidence bridge. The bridge/routing policy decides later whether
   * any spooled command actually satisfies an open gate, so this stage is
   * deliberately permissive about which tools it captures. Fail-open: spooling
   * never disrupts the event stream.
   */
  spoolCommandEvidence(event: CanonicalRuntimeEvent): void {
    const bridge = this.commandEvidenceBridge;
    if (!bridge) return;
    if (event.method !== 'tool.started' && event.method !== 'tool.completed') {
      return;
    }
    if (!this.isFlowBoundThread(event.threadId)) return;

    try {
      if (event.method === 'tool.started') {
        const command = extractToolCommand(event.arguments);
        if (!command) return;
        this.pendingCommandSpools.set(`${event.threadId}:${event.toolCallId}`, {
          command,
          toolName: event.toolName,
        });
        return;
      }

      // tool.completed
      const key = `${event.threadId}:${event.toolCallId}`;
      const pending = this.pendingCommandSpools.get(key);
      if (!pending) return;
      this.pendingCommandSpools.delete(key);

      const output =
        event.status === 'error'
          ? stringifyToolPayload(event.error ?? event.output)
          : stringifyToolPayload(event.output);
      bridge.spool(event.threadId, {
        toolName: pending.toolName,
        toolCallId: event.toolCallId,
        command: pending.command,
        output,
        status: event.status,
        // Station only OBSERVED this tool call — the runtime dispatched it,
        // and `ToolCompletedEvent` carries no exit code, so none is claimed
        // (station#4237); `status` above is the observed execution fact the
        // pass/fail claim derives from.
        exitCode: null,
        // `timedOut` here means Station's OWN budget, which it never armed
        // over a call it did not dispatch. A runtime-side kill is not
        // representable in this field and arrives as `status: 'error'`, so
        // it still fails the claim — see #4237's review (L3) for why this
        // stays false rather than becoming tri-state.
        timedOut: false,
        // NOT plumbed rather than unknowable: the monitoring bridge already
        // derives an observed tool duration from the started/completed pair
        // (station#3077). Recording null until this path carries it beats
        // the 0 that read as a measured instant (#4237 review L2).
        durationMs: null,
        // Derived, not assumed: the adapters that truncate say so on the
        // event. Claude head-slices tool output at 2000 chars and ACP caps
        // by bytes; both now emit `outputReceipt`, whose presence IS the
        // truncation. Asserting `false` here recorded a head slice as a
        // complete output whose "tail" was its beginning (#4237 review M1).
        outputTruncated: event.outputReceipt !== undefined,
      });
    } catch (error) {
      this.deps.logger.warn('Command-evidence spool failed (fail-open)', {
        threadId: event.threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** True when the thread has an attached Flow run (cached per thread). */
  private isFlowBoundThread(threadId: string): boolean {
    const cached = this.flowBoundThreads.get(threadId);
    if (cached !== undefined) return cached;
    const binding = this.deps.latestEventPayloadByMethod(
      threadId,
      'flow.run-attached',
    );
    const bound = binding
      ? resolveSessionFlowBinding([binding]) !== null
      : false;
    this.flowBoundThreads.set(threadId, bound);
    return bound;
  }

  private resolvePolicyCwd(threadId: string): string | null {
    const cached = this.policyThreads.get(threadId);
    if (cached !== undefined) return cached;
    const bindingEvent = this.deps.latestEventPayloadByMethod(
      threadId,
      'policy.hooks-attached',
    );
    const binding = bindingEvent
      ? resolveSessionPolicyBinding([bindingEvent])
      : undefined;
    const cwd = binding?.cwd ?? null;
    this.policyThreads.set(threadId, cwd);
    return cwd;
  }
}
