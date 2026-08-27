export type SchedulerCapability =
  | 'artifacts'
  | 'notifications'
  | 'daemon'
  | 'working-dir'
  | 'command';

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

export interface SchedulerJob {
  name: string;
  provider: string;
  cron?: string;
  schedule?: SchedulerSchedule;
  prompt: string;
  agent?: string;
  enabled: boolean;
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
}

export interface AddJobOpts {
  name: string;
  provider?: string;
  cron?: string;
  schedule?: SchedulerSchedule;
  prompt: string;
  agent?: string;
  notifyStart?: boolean;
  trustAllTools?: boolean;
  retryCount?: number;
  retryDelaySecs?: number;
  monitor?: import('./external-monitor').ExternalMonitorConfig;
  [key: string]: unknown;
}

export interface UpdateJobOpts {
  cron?: string;
  schedule?: SchedulerSchedule;
  prompt?: string;
  agent?: string;
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
 * `indeterminate` means a provider effect may have started and callers must
 * observe the associated run rather than issue an automatic retry.
 */
export type SchedulerManualRunReceipt = Readonly<{
  outcome: 'completed' | 'failed' | 'indeterminate' | 'refused';
  message: string;
  /** Canonical `RunSummary.runId` for observation; never a claim capability. */
  runId: string;
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
  /** Bounded monitor outcome; no source body or secret material. */
  monitorOutcome?: import('./external-monitor').ExternalMonitorOutcome;
  monitorState?: import('./external-monitor').ExternalMonitorState;
}
