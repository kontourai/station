export type SchedulerCapability =
  | 'artifacts'
  | 'notifications'
  | 'daemon'
  | 'working-dir'
  | 'command';

/**
 * The built-in scheduler's self-imposed automatic-execution ceiling. Published
 * here instead of buried in the runtime so consumers can explain deterministic
 * deferral and retry waiting. Explicit manual runs are exempt so an operator
 * can always act, but they are counted while active: automatic retries do not
 * add more work until total active invocations fall below the ceiling. The
 * limit never changes in response to host measurements.
 */
export const SCHEDULER_EXECUTION_LIMITS = {
  /**
   * Automatic jobs one Station process admits concurrently when no exempt
   * manual work is active. Four permits a modest burst of independent jobs;
   * changing it is an explicit contract change.
   */
  maxConcurrentJobs: 4,
  /**
   * Automations that run in a conversation, handing their turn over at once.
   * A separate pool: such a run holds a permit only until its turn is queued
   * on the conversation (or its dedicated conversation has started), never
   * while it waits for the turn to finish, so turns waiting on a person
   * cannot starve other jobs.
   */
  maxConcurrentConversationHandoffs: 4,
  /** Stable reason recorded when an occurrence defers or waits for a slot. */
  concurrencyDeferralReason: 'scheduler_concurrency_limit',
} as const;

/** Every lifecycle outcome emitted by the scheduler concurrency-limit metric. */
export const SCHEDULER_CONCURRENCY_DISPOSITIONS = [
  'waiting',
  'admitted',
  'stopped',
  'released',
  'indeterminate',
] as const;

export type SchedulerConcurrencyDisposition =
  (typeof SCHEDULER_CONCURRENCY_DISPOSITIONS)[number];

/** Definite wire-level outcomes of a scheduler concurrency deferral event. */
export type SchedulerDeferralDisposition = Extract<
  SchedulerConcurrencyDisposition,
  'waiting' | 'released'
>;

/** Provider-neutral schedule accepted by every operator surface. */
export type SchedulerSchedule =
  | Readonly<{ kind: 'cron'; expr: string; timezone?: string }>
  | Readonly<{ kind: 'every'; everyMs: number }>
  | Readonly<{ kind: 'at'; timeMs: number; deleteAfterRun?: boolean }>;

/**
 * Operator-facing scheduler verbs. API, SDK, CLI, and station-control MCP
 * must expose this exact lifecycle; transport-only events/webhooks are not
 * operator verbs and are intentionally excluded.
 */
export const SCHEDULER_OPERATOR_OPERATIONS = [
  'list',
  'providers',
  'stats',
  'status',
  'preview',
  'logs',
  'create',
  'update',
  'run',
  'enable',
  'disable',
  'delete',
] as const;

export type SchedulerOperatorOperation =
  (typeof SCHEDULER_OPERATOR_OPERATIONS)[number];

/** Stable adapter names used by parity ratchets and extension authors. */
export const SCHEDULER_OPERATOR_SURFACE: Readonly<
  Record<
    SchedulerOperatorOperation,
    Readonly<{ cli: string; mcp: string; method: string; path: string }>
  >
> = {
  list: {
    cli: 'list',
    mcp: 'list_jobs',
    method: 'GET',
    path: '/scheduler/jobs',
  },
  providers: {
    cli: 'providers',
    mcp: 'list_scheduler_providers',
    method: 'GET',
    path: '/scheduler/providers',
  },
  stats: {
    cli: 'stats',
    mcp: 'get_scheduler_stats',
    method: 'GET',
    path: '/scheduler/stats',
  },
  status: {
    cli: 'status',
    mcp: 'get_scheduler_status',
    method: 'GET',
    path: '/scheduler/status',
  },
  preview: {
    cli: 'preview',
    mcp: 'preview_schedule',
    method: 'GET',
    path: '/scheduler/jobs/preview-schedule',
  },
  logs: {
    cli: 'logs',
    mcp: 'get_job_logs',
    method: 'GET',
    path: '/scheduler/jobs/:target/logs',
  },
  create: {
    cli: 'create',
    mcp: 'add_job',
    method: 'POST',
    path: '/scheduler/jobs',
  },
  update: {
    cli: 'update',
    mcp: 'update_job',
    method: 'PUT',
    path: '/scheduler/jobs/:target',
  },
  run: {
    cli: 'run',
    mcp: 'run_job',
    method: 'POST',
    path: '/scheduler/jobs/:target/run',
  },
  enable: {
    cli: 'enable',
    mcp: 'enable_job',
    method: 'PUT',
    path: '/scheduler/jobs/:target/enable',
  },
  disable: {
    cli: 'disable',
    mcp: 'disable_job',
    method: 'PUT',
    path: '/scheduler/jobs/:target/disable',
  },
  delete: {
    cli: 'delete',
    mcp: 'delete_job',
    method: 'DELETE',
    path: '/scheduler/jobs/:target',
  },
};

export interface SchedulerFormField {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'boolean';
  placeholder?: string;
  hint?: string;
}

/**
 * Where an automation's run lands. Absent on a job: the legacy behaviour, a
 * Station-engine turn whose output is written to the run's file.
 *
 * - `conversation`: an existing conversation. Each run is a framed Station
 *   turn queued on its inbox, so it runs on whatever engine that
 *   conversation runs on, under its normal approval mode.
 * - `dedicated`: a conversation the automation owns. The first run starts it
 *   with `agent` (and `workspace`, when given) and Station records its id in
 *   `conversationId`; every later run continues it like `conversation`.
 */
export type SchedulerAutomationTarget =
  | Readonly<{ kind: 'conversation'; conversationId: string }>
  | Readonly<{
      kind: 'dedicated';
      agent: string;
      workspace?: Readonly<{ kind: 'project'; projectSlug: string }>;
      /** Server-written once the first run has started the conversation. */
      conversationId?: string;
    }>;

/**
 * The conversation an automation target runs in, when it has one yet. A
 * dedicated target has none until its first run starts it.
 */
export function automationTargetConversationId(
  target: SchedulerAutomationTarget | undefined,
): string | undefined {
  return target?.conversationId;
}

/**
 * Fixed policy for automations that target a conversation. Published so the
 * UI and docs can state the numbers instead of restating them.
 */
export const AUTOMATION_RUN_POLICY = {
  /**
   * Consecutive failed runs after which Station disables the automation and
   * sends one notification. A successful run resets the count.
   */
  fatigueFailureThreshold: 5,
  /**
   * A targeted run whose due occurrence is older than this when Station
   * claims it is recorded missed instead of run. Station only ever claims
   * the latest due occurrence, so an `every` schedule shorter than this is
   * never more than one interval late; this bounds the rest (cron, at, and
   * long intervals) after Station was off.
   */
  latenessCutoffMs: 6 * 60 * 60 * 1000,
  /** How long a targeted run waits for its turn to finish before settling. */
  turnDeadlineMs: 30 * 60 * 1000,
} as const;

/** The idempotency key a targeted run's turn is queued under. */
export function automationRunClientTurnId(runId: string): string {
  return `scheduler:${runId}`;
}

export interface SchedulerJob {
  name: string;
  provider: string;
  cron?: string;
  schedule?: SchedulerSchedule;
  prompt: string;
  agent?: string;
  /** Where each run lands; absent is a legacy Station-engine file run. */
  target?: SchedulerAutomationTarget;
  /** Server-recorded creator a targeted run acts as. Read-only. */
  createdBy?: Readonly<{ userId: string }>;
  /** Failed runs since the last success, newest first. Read-only. */
  consecutiveFailures?: number;
  /** When the last successful run completed. Read-only. */
  lastSuccessAt?: string;
  enabled: boolean;
  /** Accepted for compatibility and ignored: Station sends no start notice. */
  notifyStart?: boolean;
  retryCount?: number;
  retryDelaySecs?: number;
  lastRun?: string;
  nextRun?: string;
  /** Read-only server-issued identity for an exact unattended-tool grant. */
  unattendedPrincipal?: { kind: 'scheduled-job'; jobId: string };
  /** Optional deterministic external observation run before an agent turn. */
  monitor?: import('./external-monitor').ExternalMonitorConfig;
  monitorState?: import('./external-monitor').ExternalMonitorState;
  [key: string]: unknown;
}

export interface SchedulerLogEntry {
  id: string;
  job: string;
  jobId?: string;
  /** Target captured at claim; null means a Station-engine run. Absent is legacy. */
  runTarget?: SchedulerAutomationTarget | null;
  startedAt: string;
  /** Exact recurring occurrence selected before the scheduler invoked an Adapter. */
  scheduledFor?: string;
  /** Wall-clock time at which Station claimed the occurrence. */
  firedAt?: string;
  completedAt?: string;
  success: boolean;
  durationSecs?: number;
  missedCount?: number;
  manual?: boolean;
  output?: string;
  error?: string;
  attempt?: number;
  maxAttempts?: number;
  /** A claimed receipt is visible to RunService before its terminal entry. */
  state?: 'running' | 'completed' | 'failed' | 'indeterminate';
  /**
   * `late`: a targeted occurrence Station recorded missed instead of running
   * it, because it was older than `AUTOMATION_RUN_POLICY.latenessCutoffMs`.
   * Not a failure: it neither notifies nor counts toward fatigue.
   */
  skipped?: 'late';
}

export interface AddJobOpts {
  name: string;
  provider?: string;
  cron?: string;
  schedule?: SchedulerSchedule;
  prompt: string;
  agent?: string;
  target?: SchedulerAutomationTarget;
  /** Server-only: the route records the admitted creator. */
  createdBy?: SchedulerAutomationCreator;
  notifyStart?: boolean;
  trustAllTools?: boolean;
  retryCount?: number;
  retryDelaySecs?: number;
  monitor?: import('./external-monitor').ExternalMonitorConfig;
  [key: string]: unknown;
}

/**
 * Who a targeted automation acts as when it runs: the admitted creator, as
 * the create route resolved them. Replayed exactly, never strengthened.
 */
export type SchedulerAutomationCreator = Readonly<{
  userId: string;
  principal?: import('./principal').PrincipalRef;
  ownerAttribution?: 'verified-bound' | 'unattributed-agent';
}>;

export interface UpdateJobOpts {
  cron?: string;
  schedule?: SchedulerSchedule;
  prompt?: string;
  agent?: string;
  /** `null` removes the target, returning the job to a legacy file run. */
  target?: SchedulerAutomationTarget | null;
  enabled?: boolean;
  notifyStart?: boolean;
  trustAllTools?: boolean;
  retryCount?: number;
  retryDelaySecs?: number;
  /** `null` explicitly removes an existing monitor; omission leaves it alone. */
  monitor?: import('./external-monitor').ExternalMonitorConfig | null;
  [key: string]: unknown;
}

export interface SchedulerProviderStats {
  jobs: {
    name: string;
    total: number;
    successes: number;
    failures: number;
    success_rate: number;
  }[];
}

export interface SchedulerProviderStatus {
  running: boolean;
  jobCount: number;
  lastTickAt?: string | null;
  healthy?: boolean;
}

export interface SchedulerProviderInfo {
  id: string;
  displayName: string;
  capabilities: string[];
  formFields?: SchedulerFormField[];
}

export interface SchedulerStats {
  providers: Record<string, SchedulerProviderStats>;
  summary: { totalJobs: number; totalRuns: number; successRate: number };
}

export interface SchedulerStatus {
  providers: Record<
    string,
    SchedulerProviderStatus & { id: string; displayName: string }
  >;
}

export type SchedulerMutationResponse = Readonly<{ output: string }>;

/**
 * The truthful terminal result of an authenticated manual scheduler request.
 * `deferred` is a provider-only result meaning no provider effect started; it
 * does not promise that the provider retained the occurrence. The built-in
 * scheduler never defers an explicit manual run. `refused` is likewise
 * provider-only. `indeterminate` means a provider effect may have started and
 * callers must observe the associated run rather than issue an automatic
 * retry.
 */
export type SchedulerManualRunReceipt = Readonly<{
  outcome: 'completed' | 'deferred' | 'failed' | 'indeterminate' | 'refused';
  message: string;
  /**
   * Canonical `RunSummary.runId` for observation; never a claim capability.
   * Absent when no run row was written, including a provider deferral.
   */
  runId?: string;
}>;

/**
 * Additive successful manual-run HTTP payload. `output` is retained for
 * older Station CLI and SDK clients; `receipt` lets newer clients observe the
 * exact run without inferring one from a job name.
 */
export type SchedulerManualRunResponse = Readonly<{
  output: string;
  receipt: SchedulerManualRunReceipt;
}>;

export interface SchedulerEvent {
  event:
    | 'job.started'
    | 'job.completed'
    | 'job.failed'
    | 'job.retrying'
    | 'job.deferred'
    | 'job.missed'
    | 'monitor.observed'
    | 'monitor.actionable'
    | 'monitor.blocked'
    | 'monitor.terminal'
    | 'monitor.restarted'
    | 'monitor.resolved';
  job: string;
  provider?: string;
  id?: string;
  success?: boolean;
  duration_secs?: number;
  artifact?: string | null;
  error?: string;
  attempt?: number;
  maxAttempts?: number;
  missedCount?: number;
  reason?: typeof SCHEDULER_EXECUTION_LIMITS.concurrencyDeferralReason;
  /** Waiting retries remain live; released occurrences are terminal. */
  disposition?: SchedulerDeferralDisposition;
  /** Bounded monitor outcome; no source body or secret material. */
  monitorOutcome?: import('./external-monitor').ExternalMonitorOutcome;
  monitorState?: import('./external-monitor').ExternalMonitorState;
}
