/**
 * Session → Builder run read-side join (archive#189 S4).
 *
 * The auto-attached `station-delivery` run is not the Builder run. Builder
 * runs are started by `flow-agents` (from Station or from a bare CLI) and
 * publish their state through the sidecar contract — `state.json.flow_run`
 * for the run projection, `state.json.run_correlation` for the identities the
 * producer was able to stamp. This module reads those published artifacts and
 * answers one question: which Builder run, if any, belongs to this session?
 *
 * Two admissible answers, and no third:
 *
 *  - `started-by-station`: Station started the session bound to a task slug,
 *    so the sidecar for that slug IS this session's run. Station's own record,
 *    not an inference.
 *  - `correlation-matched`: Station did not start it, so the only key is
 *    `run_correlation.identities.runtime_session`, compared by EXACT equality
 *    against the session's Station-issued thread id, and only when exactly one
 *    sidecar in the workspace claims it.
 *
 * Everything else is `unavailable` with a stated reason. That is not
 * defensiveness — `runtime_session.value` is an opaque producer string that is
 * routinely NOT a Station thread id (bare Codex CLI thread ids are the live
 * case), and one thread id legitimately appears in several sidecars when a
 * runtime session drives several Builder runs in sequence. A near-match is
 * therefore evidence of nothing, and archive#582 already paid for the lesson that a
 * plausible join is indistinguishable from a verified one once rendered.
 *
 * This module is pure: it takes the session's thread id, its Station binding
 * (if any), and the workspace's sidecar summaries, and returns a view. It
 * reads no files and no clock.
 */

import type {
  BuilderRunIdentityStatus,
  SessionBuilderRunView,
  WorkflowRunCorrelation,
  WorkflowRunIdentity,
  WorkflowState,
  WorkflowTaskSummary,
} from '@kontourai/station-contracts/workflow';
import type { SessionWorkflowBinding } from './orchestration-workflow-sidecar.js';

/**
 * The envelope's `runtime_session` slot, or undefined when the producer wrote
 * no envelope at all (`run_correlation` absent) or an `{status:'incomplete'}`
 * one. Those two are different states upstream but identical here: no
 * identity to read.
 */
function runtimeSessionIdentity(
  correlation: WorkflowRunCorrelation | undefined,
): WorkflowRunIdentity | undefined {
  if (!correlation || !('identities' in correlation)) return undefined;
  const identity = correlation.identities?.runtime_session;
  if (!identity || typeof identity !== 'object') return undefined;
  return identity;
}

/** The identity's value, but ONLY when it is genuinely present and non-empty. */
function presentRuntimeSessionValue(
  task: WorkflowTaskSummary,
): string | undefined {
  const identity = runtimeSessionIdentity(task.runCorrelation);
  if (identity?.status !== 'present') return undefined;
  return identity.value.length > 0 ? identity.value : undefined;
}

/**
 * Collapse the envelope's four identity statuses onto the three Station
 * renders. `not_applicable` folds into `unavailable`: both mean "no identity
 * here", and the producer's own `reason` string carries the distinction
 * forward verbatim, so nothing is lost by not minting a fourth chip.
 */
function mapIdentityStatus(identity: WorkflowRunIdentity | undefined): {
  identityStatus: BuilderRunIdentityStatus;
  reason?: string;
} {
  if (!identity) {
    return {
      identityStatus: 'unavailable',
      reason: 'the builder run published no run-correlation envelope',
    };
  }
  if (identity.status === 'present') return { identityStatus: 'present' };
  if (identity.status === 'unsupported') {
    return { identityStatus: 'unsupported', reason: identity.reason };
  }
  return { identityStatus: 'unavailable', reason: identity.reason };
}

/**
 * The fields a joined sidecar contributes, whether it arrived as a list
 * summary (the correlation scan) or as one exact `state.json` read (the
 * Station-bound path).
 */
interface JoinedTask {
  taskSlug: string;
  runCorrelation?: WorkflowRunCorrelation;
  flowRun?: WorkflowTaskSummary['flowRun'];
  updatedAt?: string;
}

/**
 * The task Station's own binding names, read by EXACT path.
 *
 * `taskSlug` is the BINDING's slug, not `state.task_slug`: the binding is what
 * Station recorded, and a sidecar written by another tool can carry an
 * internal `task_slug` that disagrees with the directory it lives in. Naming
 * the directory keeps the row describing the thing Station actually bound.
 */
function boundTask(
  taskSlug: string,
  state: WorkflowState | null,
): JoinedTask | null {
  if (!state) return null;
  return {
    taskSlug,
    ...(state.run_correlation ? { runCorrelation: state.run_correlation } : {}),
    ...(state.flow_run ? { flowRun: state.flow_run } : {}),
    ...(state.updated_at ? { updatedAt: state.updated_at } : {}),
  };
}

/** Project one joined sidecar into the view. */
function viewForTask(
  task: JoinedTask,
  matchKind: 'started-by-station' | 'correlation-matched',
): SessionBuilderRunView {
  // A correlation match was made BY the present value, so its status is
  // present by construction; a Station-started join says whatever the
  // envelope says, including nothing.
  const identity =
    matchKind === 'correlation-matched'
      ? ({ identityStatus: 'present' } as const)
      : mapIdentityStatus(runtimeSessionIdentity(task.runCorrelation));
  return {
    identityStatus: identity.identityStatus,
    matchKind,
    ...('reason' in identity && identity.reason
      ? { reason: identity.reason }
      : {}),
    taskSlug: task.taskSlug,
    // `flow_run` is carried verbatim or not at all. A joined task whose run
    // has not been projected yet must render as a join with no progress, not
    // as a run sitting at step zero.
    ...(task.flowRun
      ? { runRef: task.flowRun.run_ref, flowRun: task.flowRun }
      : {}),
    ...(task.updatedAt ? { sidecarUpdatedAt: task.updatedAt } : {}),
  };
}

/** The one sidecar read the bound path performs. */
interface BoundTaskReader {
  readState(cwd: string, taskSlug: string): WorkflowState | null;
}

/**
 * Read the bound task's `state.json`, turning an unreadable sidecar into
 * `null` rather than an exception.
 *
 * This is not incidental defensiveness — it is the difference between two
 * user-visible outcomes. `readState` returns `null` for a MISSING file but
 * THROWS `WorkflowSidecarInvalidError` for a malformed or schema-invalid one
 * (unlike `listTasks`, which swallows both via `tryReadState`). Letting that
 * throw escape reaches the join's outer fail-open catch, which yields no row
 * at all — and "no row" is how Station says "there is no Builder run here".
 * A corrupt sidecar would then be indistinguishable from an absent one, which
 * is exactly the class of silence archive#189 exists to remove.
 *
 * Both failures deserve the same row: Station bound this session to a task it
 * can no longer read. `onUnreadable` carries the underlying error out to the
 * caller's log so the diagnostic is not swallowed with it.
 */
export function readBoundTaskState(
  reader: BoundTaskReader,
  binding: SessionWorkflowBinding,
  onUnreadable?: (error: unknown) => void,
): WorkflowState | null {
  try {
    return reader.readState(binding.cwd, binding.taskSlug);
  } catch (error) {
    onUnreadable?.(error);
    return null;
  }
}

export interface ResolveSessionBuilderRunInput {
  /**
   * The session's Station-issued thread id. This is the ONLY value ever
   * compared against `runtime_session.value`; Station never compares two
   * producer-supplied strings to each other.
   */
  threadId: string;
  /** The session's Station-recorded task binding, when Station started it. */
  binding: SessionWorkflowBinding | null;
  /**
   * The bound task's own `state.json`, read by EXACT path — never picked out
   * of a workspace scan. `listTasks` dedupes by DIRECTORY name but reports
   * `state.task_slug`, so two directories can both report one slug and the
   * scan's `updated_at` ordering decides which is seen; a decoy directory
   * could then shadow the very task Station bound. An exact read cannot be
   * shadowed (and is cheaper). `null` when the sidecar could not be read.
   *
   * Ignored entirely when `binding` is null.
   */
  boundTaskState: WorkflowState | null;
  /**
   * Every sidecar summary in the session's workspace. Used ONLY for the
   * correlation scan, which is inherently a search over all of them.
   */
  tasks: readonly WorkflowTaskSummary[];
}

/**
 * Resolve the Builder run for one session.
 *
 * Returns `null` — meaning "render no row at all" — only when there is nothing
 * to disclose: Station did not start this session against a task, and the
 * workspace contains no Builder run carrying a runtime-session identity to
 * join against. Anywhere a join was possible in principle but was not made,
 * this returns a row saying so, because silence there is indistinguishable
 * from "no Builder run exists" and that is the failure archive#189 is about.
 */
export function resolveSessionBuilderRun(
  input: ResolveSessionBuilderRunInput,
): SessionBuilderRunView | null {
  const { threadId, binding, boundTaskState, tasks } = input;

  if (binding) {
    const task = boundTask(binding.taskSlug, boundTaskState);
    if (task) return viewForTask(task, 'started-by-station');
    // A broken binding, and deliberately NOT a fall-through to the correlation
    // scan: letting an unrelated run that happens to name this thread stand in
    // for the task Station bound would be a silent substitution.
    return {
      identityStatus: 'unavailable',
      matchKind: 'started-by-station',
      reason: `Station started this session against task \`${binding.taskSlug}\`, whose sidecar is no longer readable in this workspace`,
      taskSlug: binding.taskSlug,
      taskSidecarUnreadable: true,
    };
  }

  const correlated = tasks.filter(
    (task) => presentRuntimeSessionValue(task) !== undefined,
  );
  if (correlated.length === 0) return null;

  const matches = correlated.filter(
    (task) => presentRuntimeSessionValue(task) === threadId,
  );
  if (matches.length === 1) {
    return viewForTask(matches[0], 'correlation-matched');
  }

  return {
    identityStatus: 'unavailable',
    matchKind: 'none',
    reason:
      matches.length > 1
        ? `${matches.length} builder runs claim this session's runtime identity (${matches
            .map((task) => task.taskSlug)
            .join(', ')}) — not guessing between them`
        : "no builder run in this workspace claims this session's runtime identity",
  };
}
