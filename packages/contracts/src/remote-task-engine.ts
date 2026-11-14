/**
 * Remote task engines (docs/decisions/remote-task-engines.md): cloud-hosted
 * coding agents whose work runs on the vendor's machines. Station creates a
 * task, sends follow-ups, reads the task's messages from a cursor and shows
 * the results the vendor reports (pull requests, usage). Nothing the task does
 * runs on the host, so Station's confinement and approval policy never apply.
 *
 * These are the vendor-neutral shapes and pure helpers. The service, the
 * vendor bindings and the HTTP routes belong to the server.
 */
import { isRecord, ownMember } from './record-guard.js';

/** A vendor Station has a reviewed binding for. */
export const REMOTE_TASK_VENDOR_IDS = [
  'devin',
  'github-copilot',
  'cursor',
] as const;
export type RemoteTaskVendorId = (typeof REMOTE_TASK_VENDOR_IDS)[number];

export const REMOTE_TASK_VENDOR_LABELS: Readonly<
  Record<RemoteTaskVendorId, string>
> = Object.freeze({
  devin: 'Devin',
  'github-copilot': 'GitHub Copilot cloud agent',
  cursor: 'Cursor Cloud Agents',
});

export function isRemoteTaskVendorId(
  value: unknown,
): value is RemoteTaskVendorId {
  return (
    typeof value === 'string' &&
    (REMOTE_TASK_VENDOR_IDS as readonly string[]).includes(value)
  );
}

/**
 * The unit a vendor reports usage in. Station never converts one to another,
 * and reports `usd` only where the vendor itself reports USD.
 */
export type RemoteTaskUsageUnit =
  | 'acu'
  | 'usd'
  | 'ai-credits'
  | 'premium-requests'
  | 'tokens';

/**
 * What one binding can do. Every flag is a declaration of a documented vendor
 * endpoint; a caller never offers an operation whose flag is off, and the
 * service refuses it with `remote-task-capability-unsupported` before any
 * request leaves the host.
 */
export interface RemoteTaskCapabilities {
  /** Create a task from a prompt. Every binding has it. */
  readonly createTask: true;
  /** Read one task. */
  readonly getTask: boolean;
  /** List the connection's tasks. */
  readonly listTasks: boolean;
  /**
   * Send a follow-up to an existing task. `steer` also reaches a task while
   * it is running; `queued` is delivered by the vendor when the task is next
   * idle.
   */
  readonly followUp: 'none' | 'queued' | 'steer';
  /** Read the task's messages from a cursor the vendor issues. */
  readonly events: boolean;
  /** Stop a running task. */
  readonly cancel: boolean;
  /** Fields of {@link RemoteTaskCreateInput} the vendor accepts. */
  readonly createOptions: {
    readonly model: boolean;
    readonly baseRef: boolean;
    readonly createPullRequest: boolean;
  };
  /** Units the vendor reports usage in; empty when it reports none. */
  readonly usageUnits: readonly RemoteTaskUsageUnit[];
}

/** A vendor status, normalized. `vendorStatus` keeps the vendor's own word. */
export type RemoteTaskStatus =
  | 'queued'
  | 'running'
  | 'waiting-for-user'
  | 'idle'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed-out'
  | 'unknown';

/** A task in one of these does no more work; the tracker stops polling it. */
export const REMOTE_TASK_TERMINAL_STATUSES: readonly RemoteTaskStatus[] =
  Object.freeze(['completed', 'failed', 'cancelled', 'timed-out']);

export function isRemoteTaskTerminal(status: RemoteTaskStatus): boolean {
  return REMOTE_TASK_TERMINAL_STATUSES.includes(status);
}

export interface RemoteTaskRepository {
  readonly owner: string;
  readonly name: string;
}

export interface RemoteTaskCreateInput {
  readonly prompt: string;
  readonly repository?: RemoteTaskRepository;
  readonly baseRef?: string;
  readonly model?: string;
  readonly createPullRequest?: boolean;
}

/** A result the vendor reported, typed. */
export interface RemoteTaskOutput {
  readonly kind: 'pull-request';
  /** Absent when the vendor reports the pull request only by id. */
  readonly url?: string;
  /** The vendor's own id for it, when it reports no URL (GitHub: `pull:<id>`). */
  readonly reference?: string;
  /** The vendor's own state word, when it reports one. */
  readonly state?: string;
}

export interface RemoteTaskUsage {
  readonly unit: RemoteTaskUsageUnit;
  readonly quantity: number;
}

export interface RemoteTask {
  readonly connectionId: string;
  readonly vendor: RemoteTaskVendorId;
  readonly taskId: string;
  readonly status: RemoteTaskStatus;
  readonly vendorStatus: string;
  readonly title?: string;
  /** The vendor's page for the task. */
  readonly url?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly outputs: readonly RemoteTaskOutput[];
  readonly usage: readonly RemoteTaskUsage[];
}

/** One message of a task, as the vendor reported it. */
export interface RemoteTaskEvent {
  /** The vendor's id for the message; duplicates are dropped by it. */
  readonly id: string;
  readonly author: 'user' | 'agent' | 'system';
  readonly text: string;
  readonly createdAt?: string;
}

/** One page of a task's messages from the vendor. */
export interface RemoteTaskEventPage {
  readonly events: readonly RemoteTaskEvent[];
  /** Pass back to read what follows; null: the vendor issued no cursor. */
  readonly cursor: string | null;
  readonly hasMore: boolean;
}

/**
 * A message as Station stored it: `sequence` is Station's own, monotonic per
 * task, and is the resume cursor clients send back (`after`, the same role
 * `Last-Event-ID` plays on the orchestration stream).
 */
export interface RemoteTaskStoredEvent extends RemoteTaskEvent {
  readonly sequence: number;
}

// --- polling -------------------------------------------------------------------

export interface RemoteTaskPolling {
  /** Delay between polls of a task that is not finished. */
  readonly intervalMs: number;
  /** The longest delay the backoff after failures may reach. */
  readonly maxBackoffMs: number;
}

export const REMOTE_TASK_POLLING_BOUNDS = Object.freeze({
  intervalMs: Object.freeze({ min: 5_000, max: 10 * 60_000 }),
  maxBackoffMs: Object.freeze({ min: 5_000, max: 30 * 60_000 }),
});

export const REMOTE_TASK_POLLING_DEFAULT: RemoteTaskPolling = Object.freeze({
  intervalMs: 15_000,
  maxBackoffMs: 5 * 60_000,
});

/**
 * No vendor wait, `Retry-After` included, holds a task's polling longer than
 * this; a longer answer is clamped to it.
 */
export const REMOTE_TASK_RETRY_AFTER_CEILING_MS = 60 * 60_000;

/**
 * Problems with a polling configuration; empty when it is acceptable. Out of
 * range values are refused, never clamped: a configuration that asks for a
 * one-second poll would spend the owner's vendor rate limit.
 */
export function remoteTaskPollingProblems(value: unknown): string[] {
  if (!isRecord(value)) return ['polling must be an object'];
  const problems: string[] = [];
  for (const key of Reflect.ownKeys(value))
    if (key !== 'intervalMs' && key !== 'maxBackoffMs')
      problems.push(`polling.${String(key)} is not a polling setting`);
  const check = (key: 'intervalMs' | 'maxBackoffMs') => {
    const entry = ownMember(value, key);
    const { min, max } = REMOTE_TASK_POLLING_BOUNDS[key];
    if (
      typeof entry !== 'number' ||
      !Number.isInteger(entry) ||
      entry < min ||
      entry > max
    )
      problems.push(
        `polling.${key} must be a whole number of milliseconds from ${min} to ${max}`,
      );
  };
  check('intervalMs');
  check('maxBackoffMs');
  const interval = ownMember(value, 'intervalMs');
  const ceiling = ownMember(value, 'maxBackoffMs');
  if (
    problems.length === 0 &&
    typeof interval === 'number' &&
    typeof ceiling === 'number' &&
    ceiling < interval
  )
    problems.push('polling.maxBackoffMs must not be less than intervalMs');
  return problems;
}

/**
 * The next delay after a poll. Success polls again after the interval. A
 * failure doubles the previous delay up to `maxBackoffMs`. A vendor that says
 * how long to wait (`retryAfterMs`) is never polled sooner, up to
 * {@link REMOTE_TASK_RETRY_AFTER_CEILING_MS}.
 */
export function nextRemoteTaskPollDelay(
  polling: RemoteTaskPolling,
  previousDelayMs: number,
  outcome:
    | { kind: 'ok' }
    | { kind: 'failed' }
    | { kind: 'rate-limited'; retryAfterMs?: number },
): number {
  if (outcome.kind === 'ok') return polling.intervalMs;
  const doubled = Math.min(
    Math.max(previousDelayMs, polling.intervalMs) * 2,
    polling.maxBackoffMs,
  );
  if (outcome.kind === 'failed') return doubled;
  const asked = outcome.retryAfterMs ?? 0;
  return Math.min(
    Math.max(doubled, asked),
    Math.max(REMOTE_TASK_RETRY_AFTER_CEILING_MS, polling.maxBackoffMs),
  );
}

// --- acknowledgement -----------------------------------------------------------

/** Bumped whenever the statement's meaning changes; older records stop counting. */
export const REMOTE_TASK_ACKNOWLEDGEMENT_VERSION = 1;

/**
 * The statement a person accepts before a connection may send anything. It
 * names the vendor and says that prompts and code leave this computer.
 */
export function remoteTaskAcknowledgementStatement(
  vendor: RemoteTaskVendorId,
): string {
  const name = REMOTE_TASK_VENDOR_LABELS[vendor];
  return `${name} runs this work on ${name}'s own machines, not on this computer. The prompts you send, and the repository code ${name} reads, leave this computer and are handled under your agreement with ${name}. Station's sandbox and approval settings do not apply there.`;
}

export interface RemoteTaskAcknowledgement {
  readonly vendor: RemoteTaskVendorId;
  readonly version: number;
  /** The exact statement accepted. */
  readonly statement: string;
  /** ISO 8601. */
  readonly acknowledgedAt: string;
}

/**
 * Whether `acknowledgement` covers `vendor` today: same vendor, current
 * version, and the exact current statement.
 */
export function remoteTaskAcknowledgementCovers(
  acknowledgement: RemoteTaskAcknowledgement | null | undefined,
  vendor: RemoteTaskVendorId,
): boolean {
  return (
    !!acknowledgement &&
    acknowledgement.vendor === vendor &&
    acknowledgement.version === REMOTE_TASK_ACKNOWLEDGEMENT_VERSION &&
    acknowledgement.statement === remoteTaskAcknowledgementStatement(vendor)
  );
}

// --- refusals --------------------------------------------------------------------

export const REMOTE_TASK_PREVIEW_ID = 'remote-task-engines';

export type RemoteTaskRefusalCode =
  | 'feature_preview_disabled'
  | 'remote-task-policy-refused'
  | 'remote-task-acknowledgement-required'
  | 'remote-task-credential-missing'
  | 'remote-task-capability-unsupported'
  | 'remote-task-not-granted'
  | 'remote-task-rate-limited'
  | 'remote-task-vendor-refused'
  | 'remote-task-vendor-unavailable'
  | 'remote-task-invalid'
  | 'remote-task-not-found';

/** A connection as a client may see it: never a credential value. */
export interface RemoteTaskConnectionView {
  readonly id: string;
  readonly vendor: RemoteTaskVendorId;
  readonly label: string;
  /** Non-secret vendor settings (for Devin, the organization id). */
  readonly settings: Readonly<Record<string, string>>;
  readonly polling: RemoteTaskPolling;
  readonly acknowledged: boolean;
  readonly acknowledgement: RemoteTaskAcknowledgement | null;
  /** The statement to accept, for a client that shows it. */
  readonly acknowledgementStatement: string;
  readonly credential: 'set' | 'missing';
  readonly capabilities: RemoteTaskCapabilities;
}
