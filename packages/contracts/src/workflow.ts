/**
 * Flow Agents workflow sidecar contracts (roadmap S3 item 2).
 *
 * These types mirror @kontourai/flow-agents' published sidecar schemas
 * (`schemas/workflow-state.schema.json`, `schemas/workflow-handoff.schema.json`,
 * both schema_version 1.0). The package schemas remain the source of truth —
 * Station validates sidecar files against the schema JSON shipped in the
 * installed package (see workflow-sidecar-service); these constants exist for
 * TypeScript typing and as the in-repo definition when the package is absent.
 */

/** The 14-value task status enum from workflow-state.schema.json. */
export const WORKFLOW_TASK_STATUSES = [
  'new',
  'planning',
  'planned',
  'in_progress',
  'blocked',
  'verifying',
  'verified',
  'needs_decision',
  'not_verified',
  'failed',
  'delivered',
  'canceled',
  'accepted',
  'archived',
] as const;

export type WorkflowTaskStatus = (typeof WORKFLOW_TASK_STATUSES)[number];

/** The 11-value phase enum from workflow-state.schema.json. */
export const WORKFLOW_PHASES = [
  'idea',
  'backlog',
  'pickup',
  'planning',
  'execution',
  'verification',
  'goal_fit',
  'evidence',
  'release',
  'learning',
  'done',
] as const;

export type WorkflowPhase = (typeof WORKFLOW_PHASES)[number];

export const WORKFLOW_NEXT_ACTION_STATUSES = [
  'continue',
  'needs_user',
  'blocked',
  'done',
] as const;

export type WorkflowNextActionStatus =
  (typeof WORKFLOW_NEXT_ACTION_STATUSES)[number];

export interface WorkflowNextAction {
  status: WorkflowNextActionStatus;
  summary: string;
  target_phase?: WorkflowPhase;
  target_artifact?: string;
  skills?: string[];
  operations?: string[];
  command?: string;
}

/** Canonical Flow run projection added by @kontourai/flow-agents 3.4. */
export interface WorkflowFlowRun {
  run_id: string;
  definition_id: string;
  definition_version: string;
  status: string;
  current_step: string;
  run_ref: string;
  open_gate_ids: string[];
  route_back_attempt?: number;
  route_back_max_attempts?: number;
}

/**
 * One identity slot of `run-correlation-envelope.schema.json` (shipped by
 * @kontourai/flow-agents). Deliberately a discriminated union: an identity is
 * EITHER present with a value, OR absent with a stated reason. There is no
 * third "empty string" reading, which is what makes it usable as a join key
 * without guessing.
 */
export type WorkflowRunIdentity =
  | { status: 'present'; value: string }
  | {
      status: 'unavailable' | 'unsupported' | 'not_applicable';
      reason: string;
    };

/**
 * `state.json.run_correlation` — the immutable run-correlation envelope a
 * Builder run stamps at start, or `{status:'incomplete'}` when the producer
 * could not assemble one. This is Station's local projection, not an
 * independent envelope validator: WorkflowSidecarService validates the full
 * value through Flow Agents' public run-correlation validator before exposing
 * it. Only the identities Station actually reads are named here; the package
 * remains authoritative for the full envelope and its identity keys.
 */
export type WorkflowRunCorrelation =
  | {
      schema_version: '1.0';
      correlation_id: string;
      identities: {
        runtime_session: WorkflowRunIdentity;
        [identity: string]: WorkflowRunIdentity;
      };
    }
  | { status: 'incomplete'; reason: string };

/**
 * `.flow-agents/<task-slug>/state.json` — the durable workflow state that
 * survives session handoff, compaction, and runtime switches.
 */
export interface WorkflowState {
  schema_version: '1.0';
  task_slug: string;
  repo?: string;
  status: WorkflowTaskStatus;
  phase: WorkflowPhase;
  owner?: string;
  created_at?: string;
  updated_at: string;
  source_request?: string;
  artifact_paths?: string[];
  work_item_refs?: string[];
  run_correlation?: WorkflowRunCorrelation;
  flow_run?: WorkflowFlowRun;
  next_action: WorkflowNextAction;
}

/** `.flow-agents/<task-slug>/handoff.json`. */
export interface WorkflowHandoff {
  schema_version: '1.0';
  task_slug: string;
  repo?: string;
  summary: string;
  current_state_ref?: string;
  next_steps: string[];
  blockers?: string[];
  warnings?: string[];
}

/** List-view projection of one task sidecar in a workspace. */
export interface WorkflowTaskSummary {
  taskSlug: string;
  status: WorkflowTaskStatus;
  phase: WorkflowPhase;
  updatedAt: string;
  nextAction: WorkflowNextAction;
  workItemRefs?: string[];
  runCorrelation?: WorkflowRunCorrelation;
  flowRun?: WorkflowFlowRun;
  hasHandoff: boolean;
  /** Workspace-relative sidecar directory (`.flow-agents/<task-slug>`). */
  path: string;
}

/** Detail-view projection: full state plus handoff when present. */
export interface WorkflowTaskDetail {
  taskSlug: string;
  state: WorkflowState;
  handoff: WorkflowHandoff | null;
  /** Workspace-relative sidecar directory (`.flow-agents/<task-slug>`). */
  path: string;
}

// ── Station-side join: Station task → Flow Agents task_slug ───────────────
//
// #582 (epic #580), fixed forward per BLOCKING review: a title-slug join is
// collision-unsafe (two differently-worded tasks can normalize to the same
// slug) and was never distinguishable from a verified identity. #594 landed
// `TaskRecord.workItemRef` — when it carries a bare flow-agents slug, that IS
// a durable identity join (`kind: 'workItemRef'`). Otherwise this falls back
// to the slugified-title heuristic, but ONLY when the candidate slug is
// unique across every task in the project (no collision) — a shared slug
// suppresses the join entirely for every task that shares it, and the
// surviving heuristic match is tagged `kind: 'title-heuristic'` so callers
// never present it as verified identity.

/**
 * Mirrors `WorkflowSidecarService`'s `TASK_SLUG_PATTERN` — a bare,
 * filesystem-safe path segment. `workItemRef` values that don't look like
 * this (URLs, `owner/repo#123`, opaque external ids) are NOT treated as a
 * flow-agents slug reference.
 */
const WORKFLOW_TASK_SLUG_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function looksLikeWorkflowTaskSlugRef(value: string): boolean {
  return WORKFLOW_TASK_SLUG_SHAPE.test(value.trim());
}

/**
 * Slugify a Station task title the same way flow-agents' `ensure-session
 * --task-slug` expects: lowercase, non-alphanumeric runs collapsed to a
 * single hyphen, leading/trailing hyphens trimmed. Returns '' for a title
 * with no alphanumeric characters (never matches any real task_slug, which
 * requires `minLength: 1` of filesystem-safe characters).
 */
export function slugifyWorkflowTaskTitle(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Which join path produced a `WorkflowTaskJoinResult`. */
export type WorkflowTaskJoinKind = 'workItemRef' | 'title-heuristic';

export interface WorkflowTaskJoinResult<T> {
  match: T;
  kind: WorkflowTaskJoinKind;
}

/**
 * Resolve a Station task's flow-agents sidecar summary, in priority order:
 *
 * 1. Durable: `task.workItemRef`, joined exactly against a sidecar's canonical
 *    `workItemRefs`, or against `taskSlug` when it is a bare slug (see
 *    {@link looksLikeWorkflowTaskSlugRef}). This is an identity-grade match
 *    (`kind: 'workItemRef'`). Ambiguous duplicate provider refs do not match.
 * 2. Title heuristic: the task's slugified title, joined EXACTLY, but
 *    ONLY when exactly one task among `allProjectTasks` slugifies to that
 *    same candidate — collision-unsafe otherwise, so a shared slug across
 *    two or more differently-worded titles suppresses the join for ALL of
 *    them (`kind: 'title-heuristic'`).
 *
 * Returns undefined when neither path yields a match, when the title
 * slugifies to '', or when the candidate slug collides across tasks —
 * callers should render nothing rather than guess.
 */
export function resolveWorkflowTaskMatch<
  T extends { taskSlug: string; workItemRefs?: readonly string[] },
>(
  task: { title: string; workItemRef?: string },
  allProjectTasks: ReadonlyArray<{ title: string }>,
  sidecarTasks: readonly T[],
): WorkflowTaskJoinResult<T> | undefined {
  const ref = task.workItemRef?.trim();
  if (ref) {
    const providerMatches = sidecarTasks.filter((sidecar) =>
      sidecar.workItemRefs?.includes(ref),
    );
    if (providerMatches.length === 1) {
      return { match: providerMatches[0], kind: 'workItemRef' };
    }
    if (providerMatches.length > 1) return undefined;

    if (looksLikeWorkflowTaskSlugRef(ref)) {
      const match = sidecarTasks.find((sidecar) => sidecar.taskSlug === ref);
      if (match) return { match, kind: 'workItemRef' };
    }
  }

  const candidate = slugifyWorkflowTaskTitle(task.title);
  if (!candidate) return undefined;

  const collisions = allProjectTasks.filter(
    (other) => slugifyWorkflowTaskTitle(other.title) === candidate,
  ).length;
  if (collisions > 1) return undefined;

  const match = sidecarTasks.find((sidecar) => sidecar.taskSlug === candidate);
  if (!match) return undefined;
  return { match, kind: 'title-heuristic' };
}

// ── Session → Builder run read-side join (station#189 S4) ─────────────────
//
// A Station session and a Builder run are produced by two independent
// lifecycles. S4 joins them for READING only, through the published sidecar
// contract, and it joins them exactly two ways — never by resemblance:
//
//  1. `started-by-station` — Station itself started the session bound to a
//     task slug (`metadata.taskSlug`), so the binding is Station's own
//     durable record, not an inference.
//  2. `correlation-matched` — Station did not start the session, so the only
//     admissible key is `run_correlation.identities.runtime_session`, matched
//     by EXACT equality against the session's Station-issued thread id.
//
// There is deliberately no third, looser path. `runtime_session.value` is an
// opaque producer-supplied string and is frequently NOT a Station thread id
// (a bare Codex CLI thread id is the live example), and one thread id can
// appear in several sidecars at once, so anything short of a unique exact
// match renders `unavailable` rather than a guess (#582 discipline).

/** Status of the joined run's `runtime_session` identity, never inferred. */
export type BuilderRunIdentityStatus =
  | 'present'
  | 'unavailable'
  | 'unsupported';

/**
 * HOW the join was made — reported alongside `identityStatus` because the two
 * answer different questions ("is there a runtime identity on the run?" vs
 * "what entitled us to attach this run to this session?"). `none` means no
 * join was made at all; the row then exists only to disclose that.
 */
export type BuilderRunMatchKind =
  | 'started-by-station'
  | 'correlation-matched'
  | 'none';

/**
 * The Builder run joined to one session. Carries the sidecar's `flow_run`
 * projection VERBATIM when there is one and nothing at all when there isn't:
 * a joined-but-unprojected run must not be rendered as progress.
 *
 * Deliberately carries no freshness/currency field. `flow_run` has no
 * `synced_at`/`projected_at` stamp upstream (filed on flow-agents), so any
 * "as of" claim Station rendered here would be manufactured. Surfaces say
 * where the projection came from, never how fresh it is.
 */
export interface SessionBuilderRunView {
  identityStatus: BuilderRunIdentityStatus;
  matchKind: BuilderRunMatchKind;
  /**
   * Why the identity is not `present`, verbatim from the producer's own
   * `reason` when it supplied one. Set exactly when `identityStatus !==
   * 'present'`; never set otherwise.
   */
  reason?: string;
  /** The joined sidecar's task slug; absent when no join was made. */
  taskSlug?: string;
  /**
   * Set only when Station bound this session to a task whose sidecar then
   * could not be read at all — a BROKEN BINDING, which is a different thing
   * from a sidecar that was read and has published no run yet.
   *
   * Surfaces must keep them apart. "No run has been published for this task
   * yet" is a statement about a run that has not started; printing it for a
   * sidecar nobody could open asserts a currency we do not have, and it lands
   * above the true reason, so the row contradicts itself. When this is set,
   * `reason` IS the row.
   *
   * Optional and absent in the ordinary case so that a client talking to a
   * server that predates it reads "not a broken binding" — which is what every
   * such server could ever have meant.
   */
  taskSidecarUnreadable?: true;
  /** `flow_run.run_ref` — the published pointer to the run's own artifacts. */
  runRef?: string;
  /** The sidecar's `flow_run` projection, unmodified; absent when it has none. */
  flowRun?: WorkflowFlowRun;
  /**
   * `state.json.updated_at` — when the sidecar FILE was last written, which is
   * exactly (and only) what the surfaces' "as of the last sidecar write" label
   * claims. It is not the projection's own age: `flow_run` has no currency
   * stamp upstream, and a sidecar can be rewritten for reasons that never
   * re-project the run. Quoting the file's own timestamp is the strongest
   * honest claim available, so surfaces state it and infer nothing from it.
   */
  sidecarUpdatedAt?: string;
}
