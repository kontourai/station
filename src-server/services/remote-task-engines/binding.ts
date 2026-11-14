/**
 * A vendor binding: one cloud coding agent's documented REST surface mapped
 * onto the generic remote task capability set
 * (docs/decisions/remote-task-engines.md).
 *
 * A binding never holds a credential. It says how to build the auth headers
 * from one (`authorize`), and every call receives a {@link VendorHttp} that
 * already carries them for exactly one connection. An optional method is
 * present only when its capability flag is on; the service refuses a call to
 * an absent one before any request is made.
 */
import type {
  RemoteTask,
  RemoteTaskCapabilities,
  RemoteTaskCreateInput,
  RemoteTaskEventPage,
  RemoteTaskPolling,
  RemoteTaskUsage,
  RemoteTaskVendorId,
} from '@kontourai/station-contracts/remote-task-engine';
import { RemoteTaskError } from './remote-task-error.js';
import type { VendorErrorSummary, VendorHttp } from './vendor-http.js';

/** What one call can read of its connection: never the credential. */
export interface RemoteTaskCallContext {
  readonly http: VendorHttp;
  readonly connectionId: string;
  readonly settings: Readonly<Record<string, string>>;
}

export interface RemoteTaskListPage {
  readonly tasks: readonly RemoteTask[];
  readonly cursor: string | null;
}

export interface RemoteTaskBinding {
  readonly vendor: RemoteTaskVendorId;
  readonly capabilities: RemoteTaskCapabilities;
  readonly baseUrl: string;
  /** This vendor's default polling, inside the contract's bounds. */
  readonly defaultPolling: RemoteTaskPolling;
  /** Where each mapped fact comes from. */
  readonly evidence: readonly string[];
  /** The non-secret connection settings the vendor needs, by name. */
  readonly settingKeys: readonly string[];
  settingsProblems(settings: Readonly<Record<string, string>>): string[];
  /** Headers for every request; the only place a binding sees the credential. */
  authorize(credential: string): Record<string, string>;
  readError(body: unknown): VendorErrorSummary;
  isRateLimited?(status: number, headers: Headers): boolean;

  createTask(
    context: RemoteTaskCallContext,
    input: RemoteTaskCreateInput,
  ): Promise<RemoteTask>;
  getTask?(context: RemoteTaskCallContext, taskId: string): Promise<RemoteTask>;
  listTasks?(
    context: RemoteTaskCallContext,
    cursor: string | null,
  ): Promise<RemoteTaskListPage>;
  sendMessage?(
    context: RemoteTaskCallContext,
    taskId: string,
    text: string,
  ): Promise<{ delivery: 'sent' | 'steered' | 'queued' }>;
  /**
   * Messages after `cursor` (null: from the start). `known` says whether an
   * event id is already stored, for a vendor whose list has no resume
   * position: the binding stops paging at what Station has.
   */
  pageEvents?(
    context: RemoteTaskCallContext,
    taskId: string,
    cursor: string | null,
    known?: (eventId: string) => boolean,
  ): Promise<RemoteTaskEventPage>;
  cancelTask?(context: RemoteTaskCallContext, taskId: string): Promise<void>;
  /**
   * Whether a refusal while paging a finished task means the vendor has no
   * more messages to give (Cursor's `409 agent_archived`, Devin's `410`), so
   * paging ends instead of failing the sync.
   */
  isEndOfMessages?(error: RemoteTaskError): boolean;
  /**
   * Usage for a vendor that reports it apart from the task. The tracker calls
   * it once a task stops working, not on every poll.
   */
  getUsage?(
    context: RemoteTaskCallContext,
    taskId: string,
  ): Promise<readonly RemoteTaskUsage[]>;
}

export function stringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A vendor answer that lacks a field Station needs. */
export function malformed(vendor: string, what: string): RemoteTaskError {
  return new RemoteTaskError(
    'remote-task-vendor-malformed',
    `${vendor} sent ${what} Station could not read.`,
    502,
  );
}

/** A task id that is not this vendor's shape: refused before any request. */
export function invalidTaskId(vendor: string): RemoteTaskError {
  return new RemoteTaskError(
    'remote-task-invalid',
    `That is not a ${vendor} task id.`,
    400,
  );
}
