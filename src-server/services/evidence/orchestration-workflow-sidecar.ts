/**
 * Orchestration mapping for durable workflow sidecars (roadmap S3 item 2).
 *
 * Binds an orchestration session to a Flow Agents task slug (explicit
 * `metadata.taskSlug` on startSession, mirroring `metadata.flowDefinition`)
 * and turns the orchestration seams S1/S3-A already own into sidecar
 * transitions:
 *
 *   session start            -> sidecar created or resumed; status/phase
 *                               recorded as a `workflow.state-changed` event
 *   completion gate verdict  -> non-pass Flow verdicts write the verdict's
 *                               guidance into state.json (`next_action`), so
 *                               the next session — ANY runtime kind — picks
 *                               up exactly where the gate bounced this one
 *   completion (gates passed)-> status `delivered`, phase `done`
 *
 * The binding is event-sourced like the Flow-run and policy bindings: the
 * last `workflow.state-changed` event in session history is authoritative
 * and survives restarts. The sidecar itself is the durable CROSS-RUNTIME
 * memory — it lives in the workspace, not in any runtime's session state,
 * which is what lets a workflow started under one runtime continue under
 * another (the L3 capability).
 */

import crypto from 'node:crypto';
import type { ProviderSessionStartInput } from '@kontourai/station-contracts/provider';
import type {
  CanonicalRuntimeEvent,
  FlowGateVerdictEvent,
  WorkflowSidecarOwnership,
  WorkflowStateChangedEvent,
  WorkflowStateTrigger,
} from '@kontourai/station-contracts/runtime-events';
import type { WorkflowState } from '@kontourai/station-contracts/workflow';
import type {
  WorkflowSidecarService,
  WorkflowTransitionPatch,
} from './workflow-sidecar-service.js';

export interface SessionWorkflowBinding {
  taskSlug: string;
  cwd: string;
  /** `ambiguous` covers pre-ownership or malformed persisted events. */
  ownership: WorkflowSidecarOwnership | 'ambiguous';
}

/** Stable, privacy-safe actor identity shared by every runtime serving a Station thread. */
export function stationWorkflowActorKey(threadId: string): string {
  return `station.thread-${crypto
    .createHash('sha256')
    .update('station:flow-agents-actor:v1:')
    .update(threadId)
    .digest('hex')
    .slice(0, 32)}`;
}

/** Resolve the session -> task-slug binding from canonical event history. */
export function resolveSessionWorkflowBinding(
  events: CanonicalRuntimeEvent[],
): SessionWorkflowBinding | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.method === 'workflow.state-changed') {
      const ownership = event.ownership;
      return {
        taskSlug: event.taskSlug,
        cwd: event.cwd,
        ownership:
          ownership === 'station-owned' || ownership === 'read-only-join'
            ? ownership
            : 'ambiguous',
      };
    }
  }
  return null;
}

function readTaskSlug(
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  const value = metadata?.taskSlug;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Who owns the task sidecar this attach binds to.
 *
 * - `station-owned`: Station is the workflow's writer. It may create the task
 *   and, on resume, touch `updated_at` so activity ordering stays honest.
 * - `read-only-join`: the sidecar belongs to a Builder run another process is
 *   driving (station#189 S4). Station is joining it to READ it, so this attach
 *   never creates and never writes `state.json`.
 *
 * The distinction is not stylistic. `transition()` is a read-modify-
 * whole-file-write, and Flow's run store has no compare-and-set (filed
 * upstream as flow#201), so a concurrent `flow-agents` CLI write landing
 * inside that window is silently clobbered by Station's stale snapshot. A
 * read-side join has no business risking a live run's state to record that
 * someone looked at it. `bindActor` stays in both modes: it writes only
 * `current/<actor>.json`, an actor-scoped file with its own contract.
 */
export type WorkflowSidecarAttachMode = WorkflowSidecarOwnership;

/**
 * Bind a starting session to its task sidecar. Fresh tasks are created
 * (status `new` / phase `pickup`); existing sidecars are resumed verbatim —
 * the previous session's status, phase, and next_action are preserved (they
 * ARE the durable memory) and only `updated_at` is touched. Returns null for
 * inputs without a task slug or cwd: non-task sessions are untouched.
 *
 * Under `read-only-join` the sidecar is read and bound but never written, and
 * a task that cannot be read yields no binding at all rather than a created
 * one — Station joins Builder runs; it does not invent them.
 */
export function attachWorkflowSidecarForSessionStart(options: {
  sidecarService: WorkflowSidecarService;
  input: ProviderSessionStartInput;
  mode?: WorkflowSidecarAttachMode;
}): WorkflowStateChangedEvent | null {
  const { sidecarService, input, mode = 'station-owned' } = options;
  const taskSlug = readTaskSlug(input.metadata);
  if (!taskSlug || !input.cwd) return null;

  if (mode === 'read-only-join') {
    const state = sidecarService.readState(input.cwd, taskSlug);
    // Vanished between the caller's existence check and here: bind nothing.
    // The read-side join then falls through to its correlation path, which is
    // the honest answer, rather than this call creating the task it was only
    // supposed to look at.
    if (!state) return null;
    sidecarService.bindActor(
      input.cwd,
      taskSlug,
      stationWorkflowActorKey(input.threadId),
      'session-join',
    );
    return buildWorkflowStateChangedEvent({
      provider: input.provider,
      threadId: input.threadId,
      cwd: input.cwd,
      state,
      ownership: mode,
      trigger: 'session-start',
      resumed: true,
    });
  }

  const { state, created } = sidecarService.ensureTask(input.cwd, taskSlug, {
    summary: `Picked up by session ${input.threadId} (${input.provider})`,
  });
  // Resume: preserve the prior session's state verbatim, touch updated_at so
  // activity ordering (and the steering hook's recency sort) stays honest.
  const effective = created
    ? state
    : sidecarService.transition(
        input.cwd,
        taskSlug,
        {},
        {
          trigger: 'session-start',
        },
      );
  sidecarService.bindActor(
    input.cwd,
    taskSlug,
    stationWorkflowActorKey(input.threadId),
    created ? 'session-start' : 'session-resume',
  );

  return buildWorkflowStateChangedEvent({
    provider: input.provider,
    threadId: input.threadId,
    cwd: input.cwd,
    state: effective,
    ownership: mode,
    trigger: 'session-start',
    resumed: !created,
  });
}

/**
 * Map a non-pass Flow completion-gate verdict onto the sidecar so the gate's
 * guidance survives the session: route-back/wait keep the task in_progress
 * with the verdict's next action; block marks it blocked.
 */
export function workflowPatchForGateVerdict(
  verdict: FlowGateVerdictEvent,
): WorkflowTransitionPatch {
  const guidance =
    verdict.nextAction ??
    verdict.summary ??
    `Flow gate verdict: ${verdict.verdict}`;
  if (verdict.verdict === 'block') {
    return {
      status: 'blocked',
      nextAction: { status: 'blocked', summary: guidance },
    };
  }
  // route-back and wait: the work continues.
  return {
    status: 'in_progress',
    nextAction: { status: 'continue', summary: guidance },
  };
}

/** Completion (all gates passed, or no gates bound): delivered and done. */
export function workflowPatchForCompletion(
  flowVerdict?: FlowGateVerdictEvent,
): WorkflowTransitionPatch {
  return {
    status: 'delivered',
    phase: 'done',
    nextAction: {
      status: 'done',
      summary: flowVerdict
        ? `Session completed; Flow run ${flowVerdict.runId} passed its gates`
        : 'Session completed',
    },
  };
}

export function buildWorkflowStateChangedEvent(options: {
  provider: string;
  threadId: string;
  cwd: string;
  state: WorkflowState;
  ownership: WorkflowSidecarOwnership;
  trigger: WorkflowStateTrigger;
  resumed: boolean;
}): WorkflowStateChangedEvent {
  return {
    eventId: crypto.randomUUID(),
    provider: options.provider,
    threadId: options.threadId,
    createdAt: new Date().toISOString(),
    method: 'workflow.state-changed',
    taskSlug: options.state.task_slug,
    cwd: options.cwd,
    ownership: options.ownership,
    status: options.state.status,
    phase: options.state.phase,
    nextActionStatus: options.state.next_action.status,
    nextActionSummary: options.state.next_action.summary,
    trigger: options.trigger,
    resumed: options.resumed,
  };
}
