/**
 * #2377 slice A: the ONE station-control authority table.
 *
 * Every tool the station-control MCP server registers has exactly one entry
 * here: the Station routes it reaches, the caller assurance and role it
 * needs, its approval class, and whether only a person may take the action.
 * Three consumers read it and none keeps its own copy:
 *
 * - `runtime/tools/runtime-control-tools.ts` derives the auto-approve and
 *   platform-mutation classification lists from `toolClass`;
 * - the central server guard (`security/station-control-authority-guard.ts`)
 *   enforces it for every request the auth boundary stamped `kind:'internal'`
 *   (the per-boot internal token), and fails closed for any route this table
 *   does not name;
 * - `StationControlToolRegistry` (`station-control-mcp-server.ts`) refuses
 *   early, with the same typed code, before a tool makes its call.
 *
 * The server guard is the enforcement point. The tool-side check exists so an
 * agent learns what to do without a round trip; it can never widen anything.
 *
 * Dependency-free on purpose: the stdio station-control child bundles this
 * file, so it imports no service — only the reserved operator-id constants
 * from the contracts package, which import nothing themselves.
 *
 * What the guard enforces centrally:
 *  - caller presence (decision 4: a caller-less internal request may reach
 *    only read-only routes that are not principal-scoped), assurance, the
 *    operator role (decisions 1 and 2), and person-only actions;
 *  - for `role: 'self'` and `role: 'project'` (slice B): a verified caller
 *    whose session has a recorded owner. The SCOPE itself is enforced where
 *    the data is: the guard records who the request acts for
 *    (`security/station-control-request-authority.ts`), the orchestration
 *    principal resolver answers with the session's recorded owner instead of
 *    the operator, and every session, conversation, Project and plugin read
 *    already keys on that principal (decision 2).
 *
 * An entry whose owner-decided policy a later slice still owes names it
 * (`tightenedBy`); the classification test refuses a `self`/`project` role
 * the guard cannot evaluate, so the table cannot carry a label nothing
 * computes.
 */

import {
  LOCAL_OPERATOR_PROVIDER,
  LOCAL_OPERATOR_SUBJECT,
} from '@kontourai/station-contracts/principal';

/**
 * The Station operator's principal id on a personal host — the same
 * derivation as `LOCAL_OPERATOR_PRINCIPAL_ID` (`principal-resolver.ts`), from
 * the same reserved contract constants, so the tool side can tell the
 * operator from another person without importing a service. A test pins the
 * two equal.
 */
export const STATION_CONTROL_OPERATOR_PRINCIPAL_ID = `human:${LOCAL_OPERATOR_PROVIDER}:${LOCAL_OPERATOR_SUBJECT}`;

/** Decision 1 / 3 vocabulary: the weakest caller credential a tool accepts. */
export type StationControlAssuranceRequirement =
  /** Any verified caller: bound, delegated-custody or bearer-exposed. */
  | 'any'
  /** Bound or delegated-custody. */
  | 'delegated-custody'
  /** Bound only (the credential never left Station's process). */
  | 'bound';

/**
 * Whose authority the action needs.
 *
 * - `operator`: the caller's principal is the Station operator AND
 *   `elevationEligible` (a recorded session owner, never an inferred one).
 *   Enforced centrally in slice A.
 * - `project`: a Project action (`projectAction`) held by the principal the
 *   caller's session acts for. The guard requires that principal; the Project
 *   routes decide the action for it (slice B: `view`; slice C: `execute`).
 * - `self`: scoped to the caller's own session or principal. The guard
 *   requires that principal; the route reads as it (slice B).
 * - `none`: no principal requirement beyond the assurance, and nothing the
 *   route returns is principal-scoped, so a caller-less request may read it.
 */
export type StationControlRoleRequirement =
  | 'operator'
  | 'project'
  | 'self'
  | 'none';

/** The approval class the auto-approve and platform-mutation gates read. */
export type StationControlToolClass =
  | 'read-only'
  | 'bounded-write'
  | 'mutating';

/**
 * Whether only a person may take this action (decision 1: anything that runs
 * code on the host or stores credentials becomes a person-approved step).
 * `when-trust-all-tools`: only when the request asks to run the job with
 * every tool trusted.
 */
export type StationControlPersonOnly =
  | 'never'
  | 'always'
  | 'when-trust-all-tools';

export type StationControlHttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/**
 * A rule a ROUTE carries whatever tool reaches it, because the body decides
 * what the request does:
 *
 * - `approval-commands-need-bound-operator`: `POST
 *   /api/orchestration/commands` also carries the approval commands. It
 *   answers pending permission requests (`type: 'respondToRequest'`,
 *   including `acceptForSession`) and sets a session's approval posture
 *   (`type: 'setApprovalMode'`, any value — `auto` or a reset to the
 *   connection default loosen it as surely as `never`). An agent must not
 *   approve its own requests or loosen its own approvals, so both need a
 *   bound operator caller (decision 3 names bound + Project approve for
 *   respond, which slice C adds; until then only the operator). `steerTurn`
 *   is dispatch and stays with slice C.
 * - `retarget-of-granted-job-is-person-only`: an unattended grant a person
 *   gave a scheduled job is keyed by the job, not by what it runs. Changing a
 *   granted job's prompt, agent, provider or monitor (a monitor dispatch runs
 *   under the job's principal) would hand the person's grants to
 *   work they never saw, so it is a person's step (the guard reads the grant
 *   store).
 */
export type StationControlRouteRule =
  | 'approval-commands-need-bound-operator'
  | 'retarget-of-granted-job-is-person-only';

export interface StationControlRoute {
  readonly method: StationControlHttpMethod;
  readonly rule?: StationControlRouteRule;
  /**
   * A path pattern: literal segments and `:name` segments, each `:name`
   * matching exactly one non-empty segment. No wildcards: every leaf a tool
   * reaches is named.
   */
  readonly path: string;
}

export interface StationControlToolPolicy {
  readonly routes: readonly StationControlRoute[];
  readonly assurance: StationControlAssuranceRequirement;
  readonly role: StationControlRoleRequirement;
  /** For `role: 'project'`: the Project action the later slice enforces. */
  readonly projectAction?: 'view' | 'execute' | 'edit' | 'approve';
  readonly toolClass: StationControlToolClass;
  readonly personOnly: StationControlPersonOnly;
  /**
   * The later #2377 slice that tightens this entry. Present on every entry
   * that carries today's effective policy rather than the owner's decided
   * one: C = dispatch scoping and server-side cross-Station forwarding,
   * D = built-in engine identity. (Slice B, read scoping and log redaction,
   * is enforced and names no entry.)
   */
  readonly tightenedBy?: readonly ('C' | 'D')[];
  /**
   * `route`: the route handler already authorizes the verified caller itself
   * (`notify_user`'s `/api/notifications/agent`), so the central guard lets
   * the request reach it rather than answering first with a different body.
   */
  readonly enforcedBy?: 'route';
}

const get = (path: string): StationControlRoute => ({ method: 'GET', path });
const post = (
  path: string,
  rule?: StationControlRouteRule,
): StationControlRoute => ({ method: 'POST', path, ...(rule ? { rule } : {}) });
const put = (
  path: string,
  rule?: StationControlRouteRule,
): StationControlRoute => ({ method: 'PUT', path, ...(rule ? { rule } : {}) });
const del = (path: string): StationControlRoute => ({ method: 'DELETE', path });

/**
 * Any verified caller may read; a caller-less request may too (decision 4),
 * because nothing it returns is principal-scoped.
 */
const READ: Pick<
  StationControlToolPolicy,
  'assurance' | 'role' | 'toolClass' | 'personOnly'
> = {
  assurance: 'any',
  role: 'none',
  toolClass: 'read-only',
  personOnly: 'never',
};

/** Decision 1: a Station-wide mutation needs a bound operator caller. */
const OPERATOR_MUTATION: Pick<
  StationControlToolPolicy,
  'assurance' | 'role' | 'toolClass' | 'personOnly'
> = {
  assurance: 'bound',
  role: 'operator',
  toolClass: 'mutating',
  personOnly: 'never',
};

/**
 * Decision 2: an operator-wide read (Station-wide data no single person's
 * view contains) needs a bound caller acting for the operator.
 */
const OPERATOR_READ: Pick<
  StationControlToolPolicy,
  'assurance' | 'role' | 'toolClass' | 'personOnly'
> = {
  assurance: 'bound',
  role: 'operator',
  toolClass: 'read-only',
  personOnly: 'never',
};

/**
 * Decision 2: a read scoped to the principal the caller's session acts for.
 * The route answers with that principal's view.
 */
const SELF_READ: Pick<
  StationControlToolPolicy,
  'assurance' | 'role' | 'toolClass' | 'personOnly'
> = {
  assurance: 'any',
  role: 'self',
  toolClass: 'read-only',
  personOnly: 'never',
};

/** Decision 1: host code or stored credentials — a person does it. */
const PERSON_ONLY: Pick<
  StationControlToolPolicy,
  'assurance' | 'role' | 'toolClass' | 'personOnly'
> = {
  assurance: 'bound',
  role: 'operator',
  toolClass: 'mutating',
  personOnly: 'always',
};

/**
 * The routes the cross-Station dispatch code (`station-control-delegation.ts`)
 * reaches on THIS Station when its target is the current Station, or while
 * resolving a saved SSH / peer target. Every dispatch-family tool can reach
 * any of them, because the path it takes depends on the target and on the
 * task's persisted binding, not on the tool name.
 */
export const DISPATCH_ROUTES: readonly StationControlRoute[] = [
  get('/api/environments/ssh'),
  post('/api/environments/ssh/:id/connect'),
  get('/api/environments/peers/:environmentId/credential'),
  get('/api/connections/agents'),
  get('/api/connections/:id'),
  get('/api/agents'),
  get('/api/agents/:id'),
  get('/api/projects/:slug'),
  post('/api/orchestration/chat'),
  post('/api/orchestration/chat/delegated'),
  post('/api/orchestration/chat/background'),
  post('/api/orchestration/chat/:conversationId/continue'),
  post('/api/orchestration/delegations'),
  get('/api/orchestration/delegations/:taskId'),
  get('/api/orchestration/delegations/:taskId/events'),
  post('/api/orchestration/delegations/:taskId/continue'),
  post('/api/orchestration/delegations/:taskId/interrupt'),
  post('/api/orchestration/commands', 'approval-commands-need-bound-operator'),
  get('/api/orchestration/sessions/read-model'),
  get('/api/orchestration/sessions/:threadId'),
  get('/api/orchestration/sessions/:threadId/event-page'),
];

/**
 * Slice C owns dispatch. Until then every dispatch tool keeps today's
 * effective policy: any VERIFIED caller (a delegated-custody or
 * bearer-exposed caller dispatches unattributed and its child starts
 * confined, `createAgentDispatchActorResolver`). A caller-less request is
 * refused (decision 4): dispatch is not a read.
 */
const DISPATCH: Omit<StationControlToolPolicy, 'routes'> = {
  assurance: 'any',
  role: 'none',
  toolClass: 'mutating',
  personOnly: 'never',
  tightenedBy: ['C'],
};

const NAVIGATE_ROUTE = post('/api/ui');

export const STATION_CONTROL_TOOL_POLICY = {
  // ── agents + conversations ─────────────────────────────────────────────
  list_agents: { ...READ, routes: [get('/agents')] },
  // Reaches `GET /agents/:slug`, which has no handler (404) — recorded as it
  // is; routing it to `GET /api/agents/:slug` is a separate fix.
  get_agent: { ...READ, routes: [get('/agents/:slug')] },
  create_agent: { ...OPERATOR_MUTATION, routes: [post('/agents')] },
  update_agent: { ...OPERATOR_MUTATION, routes: [put('/agents/:slug')] },
  delete_agent: { ...OPERATOR_MUTATION, routes: [del('/agents/:slug')] },
  // The conversation routes read as the session's owner.
  list_conversations: {
    ...SELF_READ,
    routes: [get('/agents/:slug/conversations')],
  },
  get_conversation_messages: {
    ...SELF_READ,
    routes: [get('/agents/:slug/conversations/:conversationId/messages')],
  },
  // Only the owner's own conversation, unless the caller is a bound
  // operator (`routes/chat/conversations.ts`).
  delete_conversation: {
    assurance: 'any',
    role: 'self',
    toolClass: 'mutating',
    personOnly: 'never',
    routes: [del('/agents/:slug/conversations/:conversationId')],
  },

  // ── board ──────────────────────────────────────────────────────────────
  // A session face is the owner's when the owner may read the session; a
  // Task face follows the owner's Project access (`board-route-authorization.ts`).
  board_pin: {
    assurance: 'any',
    role: 'self',
    toolClass: 'mutating',
    personOnly: 'never',
    routes: [post('/api/board/pin')],
  },
  board_unpin: {
    assurance: 'any',
    role: 'self',
    toolClass: 'mutating',
    personOnly: 'never',
    routes: [post('/api/board/unpin')],
  },
  board_move: {
    assurance: 'any',
    role: 'self',
    toolClass: 'mutating',
    personOnly: 'never',
    routes: [post('/api/board/move')],
  },
  board_read: {
    ...SELF_READ,
    routes: [get('/api/board')],
  },

  // ── catalog (skills) ───────────────────────────────────────────────────
  list_skills: { ...READ, routes: [get('/api/system/skills')] },
  list_registry_skills: { ...READ, routes: [get('/api/registry/skills')] },
  install_skill: {
    ...OPERATOR_MUTATION,
    routes: [post('/api/registry/skills/install')],
  },
  uninstall_skill: {
    ...OPERATOR_MUTATION,
    routes: [del('/api/registry/skills/:id')],
  },
  update_skill: { ...OPERATOR_MUTATION, routes: [put('/api/skills/:name')] },
  // Slice B: a skill's run and outcome counters are one Station-wide tally
  // with no per-person state to scope, and they reveal nothing back but the
  // counts. Any verified caller may bump them (a caller-less one may not:
  // they are writes).
  track_skill_run: {
    assurance: 'any',
    role: 'none',
    toolClass: 'mutating',
    personOnly: 'never',
    routes: [post('/api/skills/:name/run')],
  },
  record_skill_outcome: {
    assurance: 'any',
    role: 'none',
    toolClass: 'mutating',
    personOnly: 'never',
    routes: [post('/api/skills/:name/outcome')],
  },

  // ── operations: independent review ─────────────────────────────────────
  // The review reads sit behind the Project read guard, which admits an
  // account principal only to Projects it may view (`runtime-routes.ts`).
  run_independent_review: {
    assurance: 'any',
    role: 'project',
    projectAction: 'execute',
    toolClass: 'mutating',
    personOnly: 'never',
    tightenedBy: ['C'],
    routes: [
      post('/api/projects/:projectSlug/reviews'),
      get('/api/projects/:projectSlug/reviews/requests/:requestId'),
    ],
  },
  get_review_request: {
    ...SELF_READ,
    role: 'project',
    projectAction: 'view',
    routes: [get('/api/projects/:projectSlug/reviews/requests/:requestId')],
  },
  list_review_receipts: {
    ...SELF_READ,
    role: 'project',
    projectAction: 'view',
    routes: [get('/api/projects/:projectSlug/reviews')],
  },
  get_review_receipt: {
    ...SELF_READ,
    role: 'project',
    projectAction: 'view',
    routes: [get('/api/projects/:projectSlug/reviews/:receiptId')],
  },

  // ── operations: scheduler ──────────────────────────────────────────────
  list_jobs: { ...READ, routes: [get('/scheduler/jobs')] },
  add_job: {
    ...OPERATOR_MUTATION,
    // Decision 1: a job that runs with every tool trusted runs host code
    // unattended, so asking for it is a person's step.
    personOnly: 'when-trust-all-tools',
    routes: [post('/scheduler/jobs')],
  },
  list_scheduler_providers: { ...READ, routes: [get('/scheduler/providers')] },
  get_scheduler_stats: { ...READ, routes: [get('/scheduler/stats')] },
  get_scheduler_status: { ...READ, routes: [get('/scheduler/status')] },
  preview_schedule: {
    ...READ,
    routes: [get('/scheduler/jobs/preview-schedule')],
  },
  // Decision 2: scheduled jobs are the operator's Station-wide work (no job
  // records a person), so their run output is an operator-wide read.
  get_job_logs: {
    ...OPERATOR_READ,
    routes: [get('/scheduler/jobs/:target/logs')],
  },
  update_job: {
    ...OPERATOR_MUTATION,
    // The same decision as `add_job`: without it, an agent could add an
    // ordinary job and then update it to trust every tool.
    personOnly: 'when-trust-all-tools',
    routes: [
      put('/scheduler/jobs/:target', 'retarget-of-granted-job-is-person-only'),
    ],
  },
  run_job: {
    ...OPERATOR_MUTATION,
    routes: [post('/scheduler/jobs/:target/run')],
  },
  enable_job: {
    ...OPERATOR_MUTATION,
    routes: [put('/scheduler/jobs/:target/enable')],
  },
  disable_job: {
    ...OPERATOR_MUTATION,
    routes: [put('/scheduler/jobs/:target/disable')],
  },
  delete_job: {
    ...OPERATOR_MUTATION,
    routes: [del('/scheduler/jobs/:target')],
  },

  // ── operations: system, models, logs, monitoring ───────────────────────
  system_status: { ...READ, routes: [get('/api/system/status')] },
  list_models: { ...READ, routes: [get('/api/models')] },
  // Decision 2: every caller reads the redacted rendering; only a bound
  // operator caller keeps the internal token's home-possession and so the
  // unredacted one (`withdrawInternalHomePossession`).
  read_logs: {
    ...READ,
    routes: [get('/api/diagnostics/logs')],
  },
  // The owner's own rows; another person's rows need a bound operator
  // (`routes/operations/monitoring.ts`).
  read_monitoring_events: {
    ...SELF_READ,
    routes: [get('/monitoring/events')],
  },
  // Delivered only to the owner's own Station clients (`/events`).
  navigate_to: {
    ...SELF_READ,
    routes: [NAVIGATE_ROUTE],
  },

  // ── operations: projects ───────────────────────────────────────────────
  // The Projects the owner may view: an account principal sees its member
  // Projects, exactly as its own requests do (`runtime-routes.ts`).
  list_projects: {
    ...SELF_READ,
    routes: [get('/api/projects')],
  },
  get_project: {
    ...SELF_READ,
    role: 'project',
    projectAction: 'view',
    // Its leaf is also shared with dispatch (slice C), which reaches it with
    // any verified caller and so is only as strict as dispatch until then.
    tightenedBy: ['C'],
    routes: [get('/api/projects/:slug')],
  },
  list_project_layouts: {
    ...SELF_READ,
    role: 'project',
    projectAction: 'view',
    routes: [get('/api/projects/:slug/layouts')],
  },

  // ── operations: dispatch (slice C) ─────────────────────────────────────
  send_message: {
    ...DISPATCH,
    routes: [...DISPATCH_ROUTES, NAVIGATE_ROUTE],
  },
  // Decision 2: the saved SSH environments are the operator's Station-wide
  // configuration (the same view `get_ssh_environment` gives), so listing
  // them is an operator-wide read. The LEAF stays open wider than this entry
  // until slice C: every dispatch tool reaches `GET /api/environments/ssh`
  // while resolving an SSH target, with any verified caller, so the guard
  // admits any verified caller there. A caller-less request is refused.
  list_delegation_environments: {
    ...OPERATOR_READ,
    tightenedBy: ['C'],
    routes: [get('/api/environments/ssh')],
  },
  list_delegation_targets: {
    // Decision 1: discovery may reconnect a saved SSH environment. Every leaf
    // it reaches is shared with dispatch, so the server enforces it only as
    // loosely as dispatch until slice C.
    ...OPERATOR_MUTATION,
    tightenedBy: ['C'],
    routes: DISPATCH_ROUTES,
  },
  list_delegated_tasks: { ...DISPATCH, routes: DISPATCH_ROUTES },
  delegate_task: {
    ...DISPATCH,
    routes: [...DISPATCH_ROUTES, NAVIGATE_ROUTE],
  },
  get_task: { ...DISPATCH, routes: DISPATCH_ROUTES },
  get_task_events: { ...DISPATCH, routes: DISPATCH_ROUTES },
  continue_task: { ...DISPATCH, routes: DISPATCH_ROUTES },
  respond_to_task_request: {
    // Decision 3: bound + Project approve. Slice C adds the Project-approve
    // path; until then only a bound operator answers a worker's request (an
    // agent must not approve its own pending requests).
    ...OPERATOR_MUTATION,
    tightenedBy: ['C'],
    routes: [
      ...DISPATCH_ROUTES,
      post('/api/orchestration/delegations/:taskId/respond'),
    ],
  },
  interrupt_task: { ...DISPATCH, routes: DISPATCH_ROUTES },

  // ── operations: SSH environments ───────────────────────────────────────
  create_ssh_environment: {
    ...OPERATOR_MUTATION,
    routes: [post('/api/environments/ssh')],
  },
  // Decision 2: a saved SSH environment is the operator's Station-wide
  // configuration. Its leaf is shared with `connect_ssh_environment` (slice
  // C), so the leaf stays as strict as that entry.
  get_ssh_environment: {
    ...OPERATOR_READ,
    routes: [get('/api/environments/ssh/:id')],
  },
  connect_ssh_environment: {
    ...OPERATOR_MUTATION,
    // Its connect leaf is shared with dispatch (slice C).
    tightenedBy: ['C'],
    routes: [
      post('/api/environments/ssh/:id/connect'),
      get('/api/environments/ssh/:id'),
    ],
  },
  disconnect_ssh_environment: {
    ...OPERATOR_MUTATION,
    routes: [post('/api/environments/ssh/:id/disconnect')],
  },
  remove_ssh_environment: {
    ...OPERATOR_MUTATION,
    routes: [del('/api/environments/ssh/:id')],
  },

  // ── operations: config, analytics, knowledge ───────────────────────────
  get_config: { ...READ, routes: [get('/config/app')] },
  update_config: { ...OPERATOR_MUTATION, routes: [put('/config/app')] },
  // Decision 2: `GET /api/analytics/usage` answers from the Station-wide
  // usage aggregate (every person's totals and per-agent rows); it reads no
  // principal, so it is an operator-wide read. The owner-scoped leaf
  // (`/api/analytics/usage-rollup`) has a different shape; pointing the tool
  // at it is a follow-up.
  get_usage: {
    ...OPERATOR_READ,
    routes: [get('/api/analytics/usage')],
  },
  // Decision 2: achievements are computed from every person's lifetime
  // usage on this Station, an operator-wide aggregate.
  get_achievements: {
    ...OPERATOR_READ,
    routes: [get('/api/analytics/achievements')],
  },
  reindex_knowledge: {
    ...OPERATOR_MUTATION,
    routes: [post('/api/knowledge/index/rebuild')],
  },
  // Hits are filtered by their root before any record is read
  // (`runtime-routes.ts`, `mayReadHitRoot`): a conversation-backed root is
  // re-read record by record as the owner; a Project root needs the owner's
  // Project `view` (the same rule as the Project routes); the personal store
  // is the operator's, so only an operator-owned session reads it.
  search_knowledge: {
    ...SELF_READ,
    routes: [post('/api/knowledge/index/search')],
  },
  migrate_knowledge: {
    ...OPERATOR_MUTATION,
    routes: [post('/api/knowledge/migrate')],
  },

  // ── platform: integrations, providers, plugins ─────────────────────────
  list_integrations: { ...READ, routes: [get('/integrations')] },
  get_integration: { ...READ, routes: [get('/integrations/:id')] },
  create_integration: { ...PERSON_ONLY, routes: [post('/integrations')] },
  delete_integration: {
    ...OPERATOR_MUTATION,
    routes: [del('/integrations/:id')],
  },
  list_registry_integrations: {
    ...READ,
    routes: [get('/api/registry/integrations')],
  },
  install_registry_integration: {
    ...PERSON_ONLY,
    routes: [post('/api/registry/integrations/install')],
  },
  list_providers: { ...READ, routes: [get('/api/providers')] },
  create_provider: { ...PERSON_ONLY, routes: [post('/api/providers')] },
  // The plugins visible to the owner (`PluginVisibilityService`).
  list_plugins: {
    ...SELF_READ,
    routes: [get('/api/plugins')],
  },
  // Guidance only: it answers from the tool and calls nothing.
  install_plugin: {
    assurance: 'any',
    role: 'none',
    toolClass: 'mutating',
    personOnly: 'never',
    routes: [],
  },
  // A proposal is an ask a person completes; the route answers an agent
  // with only its id and status, and an update/remove proposal names only a
  // plugin visible to the owner (`plugin-proposal-routes.ts`).
  propose_plugin_install: {
    assurance: 'any',
    role: 'self',
    toolClass: 'mutating',
    personOnly: 'never',
    routes: [post('/api/plugin-proposals')],
  },
  validate_plugin: { ...READ, routes: [post('/api/plugins/validate')] },
  // Decision 2: the route is operator-only (`operatorOnly`): it lists every
  // installed plugin and runs `git fetch` in each. It keys on the operator's
  // principal id, which an operator-owned session at any assurance now
  // resolves to, so the table must hold it to a bound operator.
  check_plugin_updates: {
    ...OPERATOR_READ,
    routes: [get('/api/plugins/check-updates')],
  },
  update_plugin: {
    assurance: 'any',
    role: 'self',
    toolClass: 'mutating',
    personOnly: 'never',
    routes: [post('/api/plugin-proposals')],
  },
  remove_plugin: {
    assurance: 'any',
    role: 'self',
    toolClass: 'mutating',
    personOnly: 'never',
    routes: [post('/api/plugin-proposals')],
  },

  // ── basis + session inventory (MCP App tools) ──────────────────────────
  // Each reads its sessions and Tasks with the owner's session authority.
  get_basis: {
    ...SELF_READ,
    routes: [
      get('/api/orchestration/sessions/:sessionId/turns/:turnId/basis'),
      get('/api/tasks/:taskId/basis'),
    ],
  },
  get_task_basis: {
    ...SELF_READ,
    routes: [
      post('/api/tasks/:taskId/basis/app-read'),
      del('/api/tasks/:taskId/basis/app-read'),
    ],
  },
  get_session_inventory: {
    ...SELF_READ,
    routes: [
      post('/api/orchestration/sessions/:sessionId/inventory/app-read'),
      del('/api/orchestration/sessions/:sessionId/inventory/app-read'),
      post('/api/tasks/:taskId/sessions/:sessionId/inventory/app-read'),
      del('/api/tasks/:taskId/sessions/:sessionId/inventory/app-read'),
    ],
  },

  // ── notify ─────────────────────────────────────────────────────────────
  notify_user: {
    assurance: 'any',
    role: 'self',
    toolClass: 'bounded-write',
    personOnly: 'never',
    enforcedBy: 'route',
    routes: [post('/api/notifications/agent')],
  },
} as const satisfies Record<string, StationControlToolPolicy>;

export type StationControlToolName = keyof typeof STATION_CONTROL_TOOL_POLICY;

/**
 * Routes a station-control tool process reaches that belong to no single
 * tool. Each is authorized by its own handler (`enforcedBy: 'route'`):
 *
 * - the caller projection a stdio child reads to learn its own caller; it
 *   answers only from the forwarded credential, never widening anything;
 * - the browser-agent operations the station-browser tools use; that route
 *   already requires a bound, elevation-eligible caller (#122/#123) and is
 *   deliberately unchanged here.
 */
export const STATION_CONTROL_INFRASTRUCTURE_POLICY = {
  'station-control-caller': {
    ...READ,
    enforcedBy: 'route',
    routes: [get('/api/orchestration/station-control/caller')],
  },
  'station-browser': {
    assurance: 'bound',
    role: 'project',
    projectAction: 'edit',
    toolClass: 'mutating',
    personOnly: 'never',
    enforcedBy: 'route',
    routes: [post('/api/browser-agent/:operation')],
  },
} as const satisfies Record<string, StationControlToolPolicy>;

// ── typed refusals ─────────────────────────────────────────────────────────

export const STATION_CONTROL_REFUSAL_CODES = [
  'station_control_caller_required',
  'station_control_assurance_insufficient',
  'station_control_role_required',
  'station_control_person_only',
  /** An internal request to a route no tool reaches: fail closed. */
  'station_control_route_unmapped',
] as const;
export type StationControlRefusalCode =
  (typeof STATION_CONTROL_REFUSAL_CODES)[number];

export interface StationControlRefusal {
  readonly code: StationControlRefusalCode;
  readonly message: string;
}

/** The body both the server guard and the tool-side check return. */
export function stationControlRefusalBody(refusal: StationControlRefusal): {
  success: false;
  code: StationControlRefusalCode;
  error: string;
} {
  return { success: false, code: refusal.code, error: refusal.message };
}

const REFUSAL_MESSAGES: Record<StationControlRefusalCode, string> = {
  station_control_caller_required:
    "This action needs a verified calling session, and this engine's station-control connection does not carry one. Without one, only read-only station-control tools whose answers belong to no particular person work.",
  station_control_assurance_insufficient:
    "This action needs a credential that stayed inside Station. This engine's station-control credential could have been copied by another process, so Station will not take this action on its word. Ask the person to do it in Station, or run it from an engine Station hosts in-process.",
  station_control_role_required:
    'Only an agent acting for the Station operator may do this. The person this session acts for is not the operator (or Station has no recorded owner for the session), so ask the operator to do it in Station.',
  station_control_person_only:
    "A person must do this in Station: it runs code on this host or stores credentials. Ask the person to do it in Station's UI; no agent tool can.",
  station_control_route_unmapped:
    'No station-control tool reaches this Station route, so Station refuses it for internal callers.',
};

export function stationControlRefusal(
  code: StationControlRefusalCode,
): StationControlRefusal {
  return { code, message: REFUSAL_MESSAGES[code] };
}

// ── evaluation ─────────────────────────────────────────────────────────────

/** The verified-caller facts evaluation reads; the rest is irrelevant here. */
export interface StationControlPolicyCaller {
  readonly assurance: 'bound' | 'delegated-custody' | 'bearer-exposed';
  readonly principal?: {
    readonly id: string;
    readonly elevationEligible: boolean;
  };
}

export interface StationControlPolicyContext {
  /** `null` when the request carried no verified caller. */
  readonly caller: StationControlPolicyCaller | null;
  /**
   * Whether this principal is the Station operator. Defaults to the personal
   * host's operator id ({@link STATION_CONTROL_OPERATOR_PRINCIPAL_ID}); the
   * server guard injects its own composition.
   */
  readonly isOperatorPrincipal?: (principalId: string) => boolean;
  /** The parsed JSON request body, for body-dependent person-only rules. */
  readonly body?: unknown;
  /**
   * For `retarget-of-granted-job-is-person-only`: whether this request changes
   * what a job that holds unattended grants runs. Only the server can know
   * (it reads the grant store); absent means it does not.
   */
  readonly retargetsGrantedJob?: boolean;
}

const ASSURANCE_RANK = {
  'bearer-exposed': 0,
  'delegated-custody': 1,
  bound: 2,
} as const;
const REQUIREMENT_RANK: Record<StationControlAssuranceRequirement, number> = {
  any: 0,
  'delegated-custody': 1,
  bound: 2,
};

export function personOnlyApplies(
  policy: Pick<StationControlToolPolicy, 'personOnly'>,
  body: unknown,
): boolean {
  if (policy.personOnly === 'always') return true;
  if (policy.personOnly === 'when-trust-all-tools')
    return (
      !!body &&
      typeof body === 'object' &&
      (body as { trustAllTools?: unknown }).trustAllTools === true
    );
  return false;
}

/**
 * Decide one policy for one request. `undefined` means allowed.
 *
 * Order: a person-only action is refused whoever asks (no agent can take it,
 * so "ask the person" is the actionable answer even for a caller-less
 * request); then a caller-less request may only read what is not
 * principal-scoped (decision 4); then the assurance; then a recorded owner
 * for a principal-scoped action; then the operator role.
 */
export function evaluateStationControlPolicy(
  policy: StationControlToolPolicy,
  context: StationControlPolicyContext,
): StationControlRefusal | undefined {
  if (policy.enforcedBy === 'route') return undefined;
  if (personOnlyApplies(policy, context.body))
    return stationControlRefusal('station_control_person_only');
  const caller = context.caller;
  if (!caller) {
    // Decision 4, read with decision 2 (slice B): a caller-less request acts
    // for no one, so it may read only what is not principal-scoped.
    return policy.toolClass === 'read-only' && policy.role === 'none'
      ? undefined
      : stationControlRefusal('station_control_caller_required');
  }
  if (ASSURANCE_RANK[caller.assurance] < REQUIREMENT_RANK[policy.assurance])
    return stationControlRefusal('station_control_assurance_insufficient');
  // Decision 2: a principal-scoped action reads or writes as the principal
  // the session acts for; a session with no recorded owner acts for no one.
  if (
    (policy.role === 'self' || policy.role === 'project') &&
    !caller.principal
  )
    return stationControlRefusal('station_control_role_required');
  if (policy.role === 'operator') {
    const principal = caller.principal;
    const isOperator =
      context.isOperatorPrincipal ??
      ((id: string) => id === STATION_CONTROL_OPERATOR_PRINCIPAL_ID);
    if (!principal?.elevationEligible || !isOperator(principal.id))
      return stationControlRefusal('station_control_role_required');
  }
  return undefined;
}

const REFUSAL_STAGE: Record<StationControlRefusalCode, number> = {
  station_control_route_unmapped: 0,
  station_control_person_only: 1,
  station_control_caller_required: 2,
  station_control_assurance_insufficient: 3,
  station_control_role_required: 4,
};

// ── route matching ─────────────────────────────────────────────────────────

interface IndexedRoute {
  readonly method: StationControlHttpMethod;
  readonly segments: readonly string[];
  readonly literalCount: number;
  readonly owners: readonly string[];
  readonly policies: readonly StationControlToolPolicy[];
  readonly rules: readonly StationControlRouteRule[];
}

function segmentsOf(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

function buildRouteIndex(): readonly IndexedRoute[] {
  const byKey = new Map<
    string,
    {
      method: StationControlHttpMethod;
      segments: string[];
      owners: string[];
      policies: StationControlToolPolicy[];
      rules: StationControlRouteRule[];
    }
  >();
  const add = (owner: string, policy: StationControlToolPolicy) => {
    for (const route of policy.routes) {
      const segments = segmentsOf(route.path);
      // Parameter names do not distinguish routes; `:slug` and `:id` at the
      // same position are the same leaf to the router.
      const key = `${route.method} /${segments
        .map((segment) => (segment.startsWith(':') ? ':' : segment))
        .join('/')}`;
      const entry = byKey.get(key) ?? {
        method: route.method,
        segments,
        owners: [],
        policies: [],
        rules: [],
      };
      entry.owners.push(owner);
      entry.policies.push(policy);
      if (route.rule && !entry.rules.includes(route.rule))
        entry.rules.push(route.rule);
      byKey.set(key, entry);
    }
  };
  for (const [name, policy] of Object.entries(STATION_CONTROL_TOOL_POLICY))
    add(name, policy);
  for (const [name, policy] of Object.entries(
    STATION_CONTROL_INFRASTRUCTURE_POLICY,
  ))
    add(name, policy);
  return [...byKey.values()].map((entry) => ({
    ...entry,
    literalCount: entry.segments.filter((segment) => !segment.startsWith(':'))
      .length,
  }));
}

let routeIndex: readonly IndexedRoute[] | undefined;

function matches(route: IndexedRoute, segments: readonly string[]): boolean {
  if (route.segments.length !== segments.length) return false;
  return route.segments.every(
    (pattern, index) => pattern.startsWith(':') || pattern === segments[index],
  );
}

export interface StationControlRouteMatch {
  /** Every tool (or infrastructure entry) that reaches this leaf. */
  readonly owners: readonly string[];
  readonly policies: readonly StationControlToolPolicy[];
  /** Body-dependent rules this leaf carries whichever tool reaches it. */
  readonly rules: readonly StationControlRouteRule[];
}

/**
 * The table leaf a request reaches, or `undefined` when no tool reaches it.
 * A literal segment outranks a parameter (`GET /api/connections/agents`
 * is not `GET /api/connections/:id`), the way the router resolves it.
 * `HEAD` is a `GET`.
 */
export function matchStationControlRoute(
  method: string,
  path: string,
): StationControlRouteMatch | undefined {
  routeIndex ??= buildRouteIndex();
  const normalized = method.toUpperCase() === 'HEAD' ? 'GET' : method;
  const segments = segmentsOf(path);
  let best: IndexedRoute | undefined;
  for (const route of routeIndex) {
    if (route.method !== normalized || !matches(route, segments)) continue;
    if (!best || route.literalCount > best.literalCount) best = route;
  }
  return best
    ? { owners: best.owners, policies: best.policies, rules: best.rules }
    : undefined;
}

/**
 * Authorize one internal request against the table. Allowed when ANY tool
 * that reaches this leaf would allow it: the route cannot tell which tool
 * is calling, so a leaf shared by a stricter and a looser tool is only as
 * strict as the looser one (the classification test pins every such
 * sharing). A refusal reports the check that came closest to passing.
 */
export function authorizeStationControlRequest(
  method: string,
  path: string,
  context: StationControlPolicyContext,
): StationControlRefusal | undefined {
  const match = matchStationControlRoute(method, path);
  if (!match) return stationControlRefusal('station_control_route_unmapped');
  let closest: StationControlRefusal | undefined;
  for (const policy of match.policies) {
    const refusal = evaluateStationControlPolicy(policy, context);
    if (!refusal) return routeRuleRefusal(match.rules, context);
    if (!closest || REFUSAL_STAGE[refusal.code] > REFUSAL_STAGE[closest.code])
      closest = refusal;
  }
  return closest;
}

/** Commands that approve or loosen approvals (`/api/orchestration/commands`). */
const APPROVAL_COMMANDS: ReadonlySet<string> = new Set([
  'respondToRequest',
  'setApprovalMode',
]);

/**
 * The leaf's own body-dependent rules, applied after some tool's policy
 * admitted the request (so no tool reaching the leaf can loosen them).
 */
function routeRuleRefusal(
  rules: readonly StationControlRouteRule[],
  context: StationControlPolicyContext,
): StationControlRefusal | undefined {
  for (const rule of rules) {
    if (rule === 'retarget-of-granted-job-is-person-only') {
      if (context.retargetsGrantedJob)
        return stationControlRefusal('station_control_person_only');
      continue;
    }
    const body = context.body;
    if (
      !body ||
      typeof body !== 'object' ||
      !APPROVAL_COMMANDS.has(String((body as { type?: unknown }).type))
    )
      continue;
    const caller = context.caller;
    if (!caller)
      return stationControlRefusal('station_control_caller_required');
    if (caller.assurance !== 'bound')
      return stationControlRefusal('station_control_assurance_insufficient');
    const isOperator =
      context.isOperatorPrincipal ??
      ((id: string) => id === STATION_CONTROL_OPERATOR_PRINCIPAL_ID);
    if (
      !caller.principal?.elevationEligible ||
      !isOperator(caller.principal.id)
    )
      return stationControlRefusal('station_control_role_required');
  }
  return undefined;
}

/** The policy for a registered tool name (bare or loader-prefixed). */
export function stationControlToolPolicy(
  toolName: string,
): StationControlToolPolicy | undefined {
  return Object.hasOwn(STATION_CONTROL_TOOL_POLICY, toolName)
    ? STATION_CONTROL_TOOL_POLICY[toolName as StationControlToolName]
    : undefined;
}
