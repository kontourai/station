/**
 * Flow gating for orchestration sessions (roadmap S1a slice 2).
 *
 * Binds an orchestration session started in a Flow workspace to a Flow run
 * (deterministic run id derived from the session thread id) and turns
 * "mark session complete" into a gate verdict. The binding is event-sourced:
 * the last `flow.run-attached` event in a session's history is authoritative,
 * so it survives restarts without extra in-memory state.
 */

import crypto from 'node:crypto';
import type { FlowDefinition, FlowRunState } from '@kontourai/flow';
import type { ProviderSessionStartInput } from '@kontourai/station-contracts/provider';
import type {
  CanonicalRuntimeEvent,
  FlowGateVerdict,
  FlowGateVerdictEvent,
  FlowRunAttachedEvent,
} from '@kontourai/station-contracts/runtime-events';
import type { CommandEvidenceRoutingPolicy } from '../evidence/command-evidence-routing-policy.js';
import { flowRunArtifactReference } from '../evidence/local-artifact-paths.js';
import type { FlowCommandEvidenceBridge } from './flow-command-evidence-bridge.js';
import {
  type FlowReadinessBridge,
  READINESS_CLAIM_TYPE,
} from './flow-readiness-bridge.js';
import {
  deriveFlowRunFreshness,
  type FlowRunFreshness,
} from './flow-run-freshness.js';
import {
  FLOW_RUN_LOCATION_ALLOCATION_COLLISION,
  type FlowEvaluationResult,
  FlowRunInvalidError,
  type FlowRunService,
} from './flow-run-service.js';
import {
  describeUnreachableGateClaims,
  detectUnreachableGateClaims,
  UNREACHABLE_GATE_CLAIMS_CODE,
} from './unreachable-gate-diagnostic.js';

export interface SessionFlowBinding {
  runId: string;
  definitionId: string;
  cwd: string;
}

/** Deterministic Flow run id for a session thread (idempotent re-attach). */
export function flowSessionRunId(threadId: string): string {
  return `session-${threadId.replace(/[\\/]+/g, '-')}`;
}

/** Resolve the session -> Flow run binding from canonical event history. */
export function resolveSessionFlowBinding(
  events: CanonicalRuntimeEvent[],
): SessionFlowBinding | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.method === 'flow.run-attached') {
      return {
        runId: event.runId,
        definitionId: event.definitionId,
        cwd: event.cwd,
      };
    }
  }
  return null;
}

function readStringMetadata(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Create (or idempotently re-attach) the Flow run for a starting session.
 * Returns null when the workspace has no valid Flow definitions — sessions in
 * non-Flow workspaces are untouched.
 *
 * Definition choice: explicit `metadata.flowDefinition` wins; otherwise the
 * single valid definition; otherwise the first by stable id order. The choice
 * is recorded in the run params (`definition_selection`).
 */
/** A warning raised while attaching, for the caller to publish and log. */
export interface FlowAttachWarning {
  code: string;
  message: string;
  details: Record<string, unknown>;
}

/** The only Flow service operations needed to attach and enrich a session. */
type FlowAttachRunService = Pick<
  FlowRunService,
  'detectWorkspace' | 'startRun' | 'getRun'
>;

export async function attachFlowRunForSessionStart(options: {
  flowRunService: FlowAttachRunService;
  input: ProviderSessionStartInput;
  /**
   * The command-evidence routing policy the session will use. Supplied so the
   * unreachable-gate diagnostic (S2) can compare the definition's expected
   * claim types against what the policy can produce. Omitted → no check.
   */
  routingPolicy?: CommandEvidenceRoutingPolicy;
  /**
   * Sink for attach-time warnings. The caller publishes them AFTER the
   * `flow.run-attached` event so session history reads in order.
   */
  emitWarning?: (warning: FlowAttachWarning) => void;
  /** Used only to report a fail-soft enrichment failure; never to block. */
  logger?: { warn(message: string, meta?: Record<string, unknown>): void };
}): Promise<FlowRunAttachedEvent | null> {
  const { flowRunService, input } = options;
  if (!input.cwd) return null;
  const workspace = await flowRunService.detectWorkspace(input.cwd);
  const validDefinitions = workspace.definitions
    .filter((definition) => definition.valid)
    .sort((a, b) => a.id.localeCompare(b.id));
  if (validDefinitions.length === 0) return null;

  const explicit = readStringMetadata(input.metadata, 'flowDefinition');
  const selected = explicit
    ? validDefinitions.find((definition) => definition.id === explicit)
    : validDefinitions[0];
  if (!selected) {
    throw new FlowRunInvalidError(
      `Flow definition not found in workspace: ${explicit}`,
    );
  }
  const selection = explicit
    ? 'explicit'
    : validDefinitions.length === 1
      ? 'only-valid-definition'
      : 'first-by-id';

  const runId = flowSessionRunId(input.threadId);
  let definitionId: string;
  let resumed: boolean;
  try {
    const result = await flowRunService.startRun(input.cwd, {
      definition: selected.path,
      runId,
      params: {
        subject: `session:${input.threadId}`,
        session_thread_id: input.threadId,
        definition_selection: selection,
      },
    });
    definitionId = result.state.definition_id;
    resumed = false;
  } catch (error: unknown) {
    // Resume ONLY on the run-already-exists case. This is matched on Flow's
    // stable error CODE, not its message: the message changed under Flow 3
    // ("run already exists" → "flow.run_location.allocation_collision: ..."),
    // and a message match would have silently turned every other invalid-start
    // error into a resume of a run that does not exist.
    if (
      !(error instanceof FlowRunInvalidError) ||
      error.code !== FLOW_RUN_LOCATION_ALLOCATION_COLLISION
    ) {
      throw error;
    }
    const existing = await flowRunService.getRun(input.cwd, runId);
    definitionId = existing.state.definition_id;
    resumed = true;
  }

  const event = buildFlowRunAttachedEvent({
    input,
    runId,
    definitionId,
    resumed,
  });

  // Enrichment is fail-soft: the binding itself is already durable, and a
  // read problem here must not cost the session its attach event. The event
  // then simply carries no freshness, which surfaces render as "unknown"
  // rather than as progress.
  try {
    const run = await flowRunService.getRun(input.cwd, runId);
    event.currentStep = run.state.current_step;
    event.freshness = deriveFlowRunFreshness({
      state: run.state,
      openGates: run.openGates,
      manifestEvidence: run.manifest.evidence,
    });
    // Once per run, not once per attach: the diagnostic describes the
    // definition, which cannot change under a deterministic run id, so a
    // resumed attach would only repeat a warning already in history.
    if (!resumed && options.routingPolicy && options.emitWarning) {
      const diagnostic = detectUnreachableGateClaims(
        run.definition,
        options.routingPolicy,
      );
      if (diagnostic) {
        options.emitWarning({
          code: UNREACHABLE_GATE_CLAIMS_CODE,
          message: describeUnreachableGateClaims(diagnostic),
          details: { runId, ...diagnostic },
        });
      }
    }
  } catch (error: unknown) {
    // Fail-soft by design (see above) — but not silent: an operator seeing a
    // binding with no freshness needs to know the read failed rather than
    // assume the server does not report it.
    options.logger?.warn('Could not enrich Flow run attach with freshness', {
      threadId: input.threadId,
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return event;
}

function buildFlowRunAttachedEvent(options: {
  input: ProviderSessionStartInput;
  runId: string;
  definitionId: string;
  resumed: boolean;
}): FlowRunAttachedEvent {
  return {
    eventId: crypto.randomUUID(),
    provider: options.input.provider,
    threadId: options.input.threadId,
    createdAt: new Date().toISOString(),
    method: 'flow.run-attached',
    runId: options.runId,
    definitionId: options.definitionId,
    cwd: options.input.cwd as string,
    resumed: options.resumed,
  };
}

interface CompletionEvaluation {
  state: FlowRunState;
  lastOutcome?: FlowEvaluationResult['outcomes'][number];
  /** Set when the current step has no gate — completion must wait. */
  noGateMessage?: string;
}

/**
 * Drive evaluation until the run completes or a gate stops passing. A single
 * evaluate call only covers the current step's gates; keep evaluating while
 * gates pass so a multi-step run can reach completion in one completion
 * request. Bounded by the definition's step count.
 */
async function evaluateUntilSettled(
  flowRunService: FlowRunService,
  binding: SessionFlowBinding,
  definition: FlowDefinition,
  initialState: FlowRunState,
): Promise<CompletionEvaluation> {
  let state = initialState;
  let lastOutcome: FlowEvaluationResult['outcomes'][number] | undefined;
  if (state.status === 'completed') {
    return { state };
  }

  const maxEvaluations = Math.max(definition.steps?.length ?? 1, 1);
  for (let round = 0; round < maxEvaluations; round += 1) {
    let result: FlowEvaluationResult;
    try {
      result = await flowRunService.evaluate(binding.cwd, binding.runId);
    } catch (error: unknown) {
      if (
        error instanceof FlowRunInvalidError &&
        /no gate for current step/i.test(error.message)
      ) {
        return {
          state,
          lastOutcome,
          noGateMessage: error.message,
        };
      }
      throw error;
    }
    state = result.state;
    lastOutcome = result.outcomes.at(-1);
    if (state.status === 'completed' || lastOutcome?.status !== 'pass') {
      break;
    }
  }
  return { state, lastOutcome };
}

/**
 * True when the evaluation stopped on missing expectations that a Veritas
 * readiness attach could satisfy (a trust.bundle claim of the readiness claim type).
 */
function missingReadinessExpectations(
  definition: FlowDefinition,
  evaluation: CompletionEvaluation,
): boolean {
  const outcome = evaluation.lastOutcome;
  if (!outcome) return false;
  if (outcome.status !== 'route-back' && outcome.status !== 'wait') {
    return false;
  }
  const missing = Array.isArray(outcome.missing) ? outcome.missing : [];
  if (missing.length === 0) return false;
  const gate = definition.gates?.[outcome.gate_id];
  return (gate?.expects ?? []).some(
    (expectation) =>
      missing.includes(expectation.id) &&
      expectation.kind === 'trust.bundle' &&
      expectation.bundle_claim?.claimType === READINESS_CLAIM_TYPE,
  );
}

/**
 * Auto-attach Veritas readiness evidence once when the verdict would bounce
 * the session for evidence Station can fetch itself. Fail-soft by design:
 * any failure (not configured, not ready, CLI error) leaves the original
 * evaluation in place and reports why in the verdict payload.
 */
async function attemptReadinessAutoAttach(options: {
  flowRunService: FlowRunService;
  readinessBridge: FlowReadinessBridge;
  binding: SessionFlowBinding;
  definition: FlowDefinition;
  evaluation: CompletionEvaluation;
}): Promise<{
  evaluation: CompletionEvaluation;
  autoReadiness: NonNullable<FlowGateVerdictEvent['autoReadiness']>;
}> {
  const { flowRunService, readinessBridge, binding, definition, evaluation } =
    options;
  const workspace = readinessBridge.detectWorkspace(binding.cwd);
  if (!workspace.configured) {
    return {
      evaluation,
      autoReadiness: {
        outcome: 'not-configured',
        reason: `workspace is not Veritas-configured (${workspace.reason})`,
      },
    };
  }
  try {
    const result = await readinessBridge.attachReadinessEvidence(
      binding.cwd,
      binding.runId,
      {
        gate: evaluation.lastOutcome?.gate_id,
        onlyWhenReady: true,
      },
    );
    if (!result.attached) {
      return {
        evaluation,
        autoReadiness: {
          outcome: 'not-ready',
          reason: `veritas readiness reported not-ready (run ${result.snapshot.cli.runId})`,
        },
      };
    }
    const reEvaluated = await evaluateUntilSettled(
      flowRunService,
      binding,
      definition,
      evaluation.state,
    );
    return { evaluation: reEvaluated, autoReadiness: { outcome: 'attached' } };
  } catch (error: unknown) {
    return {
      evaluation,
      autoReadiness: {
        outcome: 'error',
        reason: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Evaluate the session's Flow run at completion time and produce the verdict
 * event. Only a 'pass' verdict (run state 'completed') permits completion;
 * 'pass' also writes/refreshes the run report and links its paths. When the
 * evaluation stalls on missing readiness-type expectations and a readiness
 * bridge is available, readiness is auto-run and attached ONCE before the
 * verdict is emitted (S1c) — fail-soft, with the attempt recorded on the
 * event payload.
 */
export async function evaluateFlowCompletionGate(options: {
  flowRunService: FlowRunService;
  binding: SessionFlowBinding;
  provider: string;
  threadId: string;
  readinessBridge?: FlowReadinessBridge;
  commandEvidenceBridge?: FlowCommandEvidenceBridge;
  /** Used only to report a fail-soft freshness read; never to block. */
  logger?: { warn(message: string, meta?: Record<string, unknown>): void };
}): Promise<FlowGateVerdictEvent> {
  const { flowRunService, binding, readinessBridge, commandEvidenceBridge } =
    options;

  // Drain spooled tool-call command evidence onto the run BEFORE evaluating, so
  // a gate that expects a quality/build claim sees the evidence the agent
  // already produced (S1a slice 3). Fail-soft: spool problems never block the
  // verdict.
  if (commandEvidenceBridge?.hasSpooled(options.threadId)) {
    try {
      await commandEvidenceBridge.attachSpooledEvidence(
        binding,
        options.threadId,
      );
    } catch {
      // Bridge is internally fail-soft; this guards an unexpected throw.
    }
  }

  const run = await flowRunService.getRun(binding.cwd, binding.runId);

  let evaluation = await evaluateUntilSettled(
    flowRunService,
    binding,
    run.definition,
    run.state,
  );
  let autoReadiness: FlowGateVerdictEvent['autoReadiness'];
  if (
    readinessBridge &&
    missingReadinessExpectations(run.definition, evaluation)
  ) {
    const attempt = await attemptReadinessAutoAttach({
      flowRunService,
      readinessBridge,
      binding,
      definition: run.definition,
      evaluation,
    });
    evaluation = attempt.evaluation;
    autoReadiness = attempt.autoReadiness;
  }

  const { state, lastOutcome } = evaluation;
  // Derived here, once, from the run as it stands AFTER this evaluation, and
  // carried on every verdict. The client cannot compute this: a single
  // completion request can settle several gates but emits one verdict naming
  // only the last, and Flow records no timestamp for a `wait` at all. One
  // authority, so both surfaces state the same thing about the same run.
  const freshness = await readRunFreshness(flowRunService, binding, options);

  if (evaluation.noGateMessage) {
    // The current step has no gate to satisfy: the run cannot advance
    // through evaluation, so completion must wait.
    return buildVerdictEvent(options, {
      verdict: 'wait',
      summary: evaluation.noGateMessage,
      nextAction: state.next_action,
      currentStep: state.current_step,
      ...(freshness ? { freshness } : {}),
      ...(autoReadiness ? { autoReadiness } : {}),
    });
  }

  if (state.status === 'completed') {
    // Render the completion report only when the completion actually stands.
    // Linking a "run complete" report on a verdict that refuses completion
    // would assert and retract in the same payload.
    await flowRunService.getReport(binding.cwd, binding.runId, 'json');
    return buildVerdictEvent(options, {
      verdict: 'pass',
      gateId: lastOutcome?.gate_id,
      summary: lastOutcome?.summary ?? 'all gates passed',
      currentStep: state.current_step,
      ...(freshness ? { freshness } : {}),
      reportPaths: {
        json: flowRunArtifactReference(binding.runId, 'report.json'),
        markdown: flowRunArtifactReference(binding.runId, 'report.md'),
      },
      ...(autoReadiness ? { autoReadiness } : {}),
    });
  }

  const verdict: FlowGateVerdict =
    lastOutcome?.status === 'route-back'
      ? 'route-back'
      : lastOutcome?.status === 'wait'
        ? 'wait'
        : lastOutcome?.status === 'block'
          ? 'block'
          : 'wait';

  return buildVerdictEvent(options, {
    verdict,
    gateId: lastOutcome?.gate_id,
    summary: lastOutcome?.summary,
    nextAction: state.next_action,
    currentStep: state.current_step,
    ...(freshness ? { freshness } : {}),
    ...(verdict === 'route-back'
      ? {
          routeBackTo:
            typeof lastOutcome?.route_back_to === 'string'
              ? lastOutcome.route_back_to
              : undefined,
          attempt:
            typeof lastOutcome?.attempt === 'number'
              ? lastOutcome.attempt
              : undefined,
          maxAttempts:
            typeof lastOutcome?.max_attempts === 'number'
              ? lastOutcome.max_attempts
              : undefined,
        }
      : {}),
    ...(Array.isArray(lastOutcome?.missing) && lastOutcome.missing.length
      ? { missing: lastOutcome.missing }
      : {}),
    ...(verdict === 'block' ? { exceptionRequired: true } : {}),
    ...(autoReadiness ? { autoReadiness } : {}),
  });
}

/**
 * Re-read the run and derive its freshness after evaluation. Fail-soft: a read
 * problem costs the verdict its freshness field (clients then keep whatever
 * they had) but never the verdict itself.
 *
 * A re-read rather than a fold over the in-memory state, because evidence can
 * be attached between the first read and the verdict — the readiness
 * auto-attach does exactly that — so the manifest held from before evaluation
 * is not the manifest the verdict describes.
 */
async function readRunFreshness(
  flowRunService: FlowRunService,
  binding: SessionFlowBinding,
  context: {
    threadId: string;
    logger?: { warn(message: string, meta?: Record<string, unknown>): void };
  },
): Promise<FlowRunFreshness | undefined> {
  try {
    const run = await flowRunService.getRun(binding.cwd, binding.runId);
    return deriveFlowRunFreshness({
      state: run.state,
      openGates: run.openGates,
      manifestEvidence: run.manifest.evidence,
    });
  } catch (error: unknown) {
    context.logger?.warn('Could not derive Flow run freshness for verdict', {
      threadId: context.threadId,
      runId: binding.runId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function buildVerdictEvent(
  context: {
    binding: SessionFlowBinding;
    provider: string;
    threadId: string;
  },
  fields: Omit<
    FlowGateVerdictEvent,
    'eventId' | 'provider' | 'threadId' | 'createdAt' | 'method' | 'runId'
  >,
): FlowGateVerdictEvent {
  return {
    eventId: crypto.randomUUID(),
    provider: context.provider,
    threadId: context.threadId,
    createdAt: new Date().toISOString(),
    method: 'flow.gate-verdict',
    runId: context.binding.runId,
    ...fields,
  };
}
