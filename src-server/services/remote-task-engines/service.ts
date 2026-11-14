/**
 * The remote task engine service (docs/decisions/remote-task-engines.md):
 * connections, their acknowledgement and credential, and every call that
 * reaches a vendor. Every public operation passes {@link RemoteTaskEngineService.gate}
 * first, in this order, and is refused before any request leaves the host:
 *
 * 1. the `remote-task-engines` Feature Preview (read at each call);
 * 2. the managed policy (`limits.engines.remoteTasks`): on a managed machine
 *    a vendor the policy does not name is off;
 * 3. the connection's acknowledgement, which must name its vendor and match
 *    the current statement exactly;
 * 4. the connection's own credential, from the engine vault;
 * 5. the binding's capability flag for the operation.
 *
 * Removing a connection, clearing its credential and reading what is already
 * stored stay available with the preview or policy off (retained
 * maintenance: they send nothing anywhere).
 */
import { randomBytes } from 'node:crypto';
import {
  managedPolicyDenial,
  type ManagedPolicySummary,
} from '@kontourai/station-contracts/managed-policy';
import {
  type ManagedPolicyEngineLimits,
  managedRemoteTaskVendorAllowed,
} from '@kontourai/station-contracts/managed-policy-engines';
import {
  isRemoteTaskTerminal,
  isRemoteTaskVendorId,
  REMOTE_TASK_ACKNOWLEDGEMENT_VERSION,
  REMOTE_TASK_PREVIEW_ID,
  REMOTE_TASK_VENDOR_LABELS,
  type RemoteTask,
  type RemoteTaskCapabilities,
  type RemoteTaskConnectionView,
  type RemoteTaskCreateInput,
  type RemoteTaskEvent,
  type RemoteTaskPolling,
  type RemoteTaskStatus,
  type RemoteTaskStoredEvent,
  type RemoteTaskVendorId,
  remoteTaskAcknowledgementCovers,
  remoteTaskAcknowledgementStatement,
  remoteTaskPollingProblems,
} from '@kontourai/station-contracts/remote-task-engine';
import type { Logger } from '../../utils/logger.js';
import type { FeaturePreviewSelector } from '../feature-previews/feature-preview-registry.js';
import type { RemoteTaskBinding, RemoteTaskCallContext } from './binding.js';
import { REMOTE_TASK_BINDINGS } from './bindings/index.js';
import {
  REMOTE_TASK_CONNECTION_ID,
  RemoteTaskCredentials,
  remoteTaskCredentialProblem,
} from './credentials.js';
import { RemoteTaskError } from './remote-task-error.js';
import {
  appendRemoteTaskEvents,
  type RemoteTaskConnectionRecord,
  RemoteTaskConnectionStore,
  type RemoteTaskRecord,
  RemoteTaskStore,
} from './stores.js';
import { VendorHttp } from './vendor-http.js';

export const REMOTE_TASK_SETTINGS_PATH =
  '/settings?view=feature-previews&highlight=feature-previews' as const;

/** The managed policy as the gate reads it; null: no policy installed. */
export interface RemoteTaskManagedPolicy {
  readonly document: { readonly limits?: { engines?: ManagedPolicyEngineLimits } };
  readonly summary: ManagedPolicySummary;
}

export interface RemoteTaskEngineServiceOptions {
  readonly homeDir: string;
  readonly credentials: RemoteTaskCredentials;
  readonly preview: FeaturePreviewSelector;
  readonly managedPolicy: () => RemoteTaskManagedPolicy | null;
  readonly fetch: typeof fetch;
  readonly now?: () => number;
  readonly logger: Logger;
  /** Tests replace the vendor table; production uses the reviewed one. */
  readonly bindings?: Readonly<Record<RemoteTaskVendorId, RemoteTaskBinding>>;
}

export interface RemoteTaskSyncResult {
  readonly task: RemoteTask;
  readonly appended: readonly RemoteTaskStoredEvent[];
  /** No work is running; the tracker stops polling until the next sync. */
  readonly quiescent: boolean;
}

const LABEL_MAX_CHARS = 120;
const PROMPT_MAX_CHARS = 100_000;
const SETTING_MAX_CHARS = 256;
/** Pages read per sync, so a long backlog cannot hold one poll forever. */
const EVENT_PAGES_PER_SYNC = 10;
const REPOSITORY_PART = /^[A-Za-z0-9_.-]{1,100}$/;
const REF = /^[A-Za-z0-9_./-]{1,255}$/;
const MODEL = /^[A-Za-z0-9_.:-]{1,128}$/;

/** A status in which the vendor does no work until someone writes. */
const QUIESCENT: readonly RemoteTaskStatus[] = ['idle', 'waiting-for-user'];

function invalid(message: string): RemoteTaskError {
  return new RemoteTaskError('remote-task-invalid', message, 400);
}

function unsupported(vendor: RemoteTaskVendorId, what: string): RemoteTaskError {
  return new RemoteTaskError(
    'remote-task-capability-unsupported',
    `${REMOTE_TASK_VENDOR_LABELS[vendor]} does not offer ${what}.`,
    405,
  );
}

function cleanSettings(
  binding: RemoteTaskBinding,
  value: unknown,
): Record<string, string> {
  const input =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const settings: Record<string, string> = {};
  for (const key of Object.keys(input)) {
    if (!binding.settingKeys.includes(key))
      throw invalid(`settings.${key} is not a ${binding.vendor} setting`);
    const entry = input[key];
    if (typeof entry !== 'string' || entry.length > SETTING_MAX_CHARS)
      throw invalid(`settings.${key} must be text`);
    settings[key] = entry.trim();
  }
  const problems = binding.settingsProblems(settings);
  if (problems.length > 0) throw invalid(problems.join('; '));
  return settings;
}

export function parseRemoteTaskCreateInput(
  value: unknown,
  capabilities: RemoteTaskCapabilities,
  vendor: RemoteTaskVendorId,
): RemoteTaskCreateInput {
  const input =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  for (const key of Object.keys(input))
    if (
      ![
        'prompt',
        'repository',
        'baseRef',
        'model',
        'createPullRequest',
      ].includes(key)
    )
      throw invalid(`${key} is not a task field`);
  const { prompt, repository, baseRef, model, createPullRequest } = input;
  if (typeof prompt !== 'string' || !prompt.trim())
    throw invalid('prompt is required');
  if (prompt.length > PROMPT_MAX_CHARS) throw invalid('prompt is too long');
  let repo: RemoteTaskCreateInput['repository'];
  if (repository !== undefined) {
    const record =
      typeof repository === 'object' && repository !== null
        ? (repository as Record<string, unknown>)
        : {};
    if (
      typeof record.owner !== 'string' ||
      typeof record.name !== 'string' ||
      !REPOSITORY_PART.test(record.owner) ||
      !REPOSITORY_PART.test(record.name)
    )
      throw invalid('repository must be { owner, name }');
    repo = { owner: record.owner, name: record.name };
  }
  if (baseRef !== undefined) {
    if (!capabilities.createOptions.baseRef)
      throw unsupported(vendor, 'choosing a base branch');
    if (typeof baseRef !== 'string' || !REF.test(baseRef))
      throw invalid('baseRef must be a branch name');
  }
  if (model !== undefined) {
    if (!capabilities.createOptions.model)
      throw unsupported(vendor, 'choosing a model');
    if (typeof model !== 'string' || !MODEL.test(model))
      throw invalid('model must be a model id');
  }
  if (createPullRequest !== undefined) {
    if (!capabilities.createOptions.createPullRequest)
      throw unsupported(vendor, 'asking for a pull request');
    if (typeof createPullRequest !== 'boolean')
      throw invalid('createPullRequest must be true or false');
  }
  return {
    prompt,
    ...(repo ? { repository: repo } : {}),
    ...(typeof baseRef === 'string' ? { baseRef } : {}),
    ...(typeof model === 'string' ? { model } : {}),
    ...(typeof createPullRequest === 'boolean' ? { createPullRequest } : {}),
  };
}

export class RemoteTaskEngineService {
  readonly #options: RemoteTaskEngineServiceOptions;
  readonly #connections: RemoteTaskConnectionStore;
  readonly #tasks: RemoteTaskStore;
  readonly #bindings: Readonly<Record<RemoteTaskVendorId, RemoteTaskBinding>>;
  readonly #now: () => number;

  constructor(options: RemoteTaskEngineServiceOptions) {
    this.#options = options;
    this.#connections = new RemoteTaskConnectionStore(options.homeDir);
    this.#tasks = new RemoteTaskStore(options.homeDir);
    this.#bindings = options.bindings ?? REMOTE_TASK_BINDINGS;
    this.#now = options.now ?? Date.now;
  }

  // --- the gate --------------------------------------------------------------

  #previewOn(): boolean {
    return this.#options.preview.select({
      enabled: () => true,
      disabled: () => false,
    });
  }

  #requirePreview(): void {
    if (!this.#previewOn())
      throw new RemoteTaskError(
        'feature_preview_disabled',
        'Enable Remote task engines in Settings → Advanced → Feature previews.',
        404,
      );
  }

  /** Whether the managed policy lets `vendor` be used. */
  policyAllows(vendor: RemoteTaskVendorId): boolean {
    const policy = this.#options.managedPolicy();
    return managedRemoteTaskVendorAllowed(
      policy ? { engines: policy.document.limits?.engines } : null,
      vendor,
    );
  }

  #requirePolicy(vendor: RemoteTaskVendorId): void {
    if (this.policyAllows(vendor)) return;
    const policy = this.#options.managedPolicy();
    const subject = `which remote task engines may be used on this computer: ${REMOTE_TASK_VENDOR_LABELS[vendor]} is not allowed`;
    throw new RemoteTaskError(
      'remote-task-policy-refused',
      policy
        ? managedPolicyDenial(policy.summary, subject)
        : `A managed policy manages ${subject}.`,
      403,
    );
  }

  #connection(connectionId: string): RemoteTaskConnectionRecord {
    const connection = REMOTE_TASK_CONNECTION_ID.test(connectionId)
      ? this.#connections.get(connectionId)
      : undefined;
    if (!connection)
      throw new RemoteTaskError(
        'remote-task-not-found',
        'No such remote task connection.',
        404,
      );
    return connection;
  }

  /**
   * Preview, policy and acknowledgement for a call that sends something to
   * the vendor. Returns the connection and its binding.
   */
  gate(connectionId: string): {
    connection: RemoteTaskConnectionRecord;
    binding: RemoteTaskBinding;
  } {
    this.#requirePreview();
    const connection = this.#connection(connectionId);
    this.#requirePolicy(connection.vendor);
    if (
      !remoteTaskAcknowledgementCovers(
        connection.acknowledgement,
        connection.vendor,
      )
    )
      throw new RemoteTaskError(
        'remote-task-acknowledgement-required',
        `Before Station sends anything to ${REMOTE_TASK_VENDOR_LABELS[connection.vendor]}, accept that the work runs on its machines and that prompts and code leave this computer.`,
        403,
      );
    return { connection, binding: this.#bindings[connection.vendor] };
  }

  /** Runs `work` against the vendor with this connection's own credential. */
  async #call<T>(
    connectionId: string,
    work: (
      context: RemoteTaskCallContext,
      binding: RemoteTaskBinding,
      connection: RemoteTaskConnectionRecord,
    ) => Promise<T>,
  ): Promise<T> {
    const { connection, binding } = this.gate(connectionId);
    const result = await this.#options.credentials.withCredential(
      connection.id,
      async (credential) => {
        const http = new VendorHttp({
          vendorName: REMOTE_TASK_VENDOR_LABELS[connection.vendor],
          baseUrl: binding.baseUrl,
          headers: binding.authorize(credential),
          secret: credential,
          fetch: this.#options.fetch,
          now: this.#now,
          readError: (body) => binding.readError(body),
          ...(binding.isRateLimited
            ? {
                isRateLimited: (status: number, headers: Headers) =>
                  binding.isRateLimited?.(status, headers) ?? false,
              }
            : {}),
        });
        return work(
          { http, connectionId: connection.id, settings: connection.settings },
          binding,
          connection,
        );
      },
    );
    if (!result)
      throw new RemoteTaskError(
        'remote-task-credential-missing',
        `Add a ${REMOTE_TASK_VENDOR_LABELS[connection.vendor]} token to this connection first.`,
        409,
      );
    return result.value;
  }

  // --- connections -------------------------------------------------------------

  #view(connection: RemoteTaskConnectionRecord): RemoteTaskConnectionView {
    const binding = this.#bindings[connection.vendor];
    const acknowledged = remoteTaskAcknowledgementCovers(
      connection.acknowledgement,
      connection.vendor,
    );
    return {
      id: connection.id,
      vendor: connection.vendor,
      label: connection.label,
      settings: { ...connection.settings },
      polling: connection.polling,
      acknowledged,
      acknowledgement: acknowledged ? connection.acknowledgement : null,
      acknowledgementStatement: remoteTaskAcknowledgementStatement(
        connection.vendor,
      ),
      credential: this.#options.credentials.has(connection.id)
        ? 'set'
        : 'missing',
      capabilities: binding.capabilities,
    };
  }

  listConnections(): RemoteTaskConnectionView[] {
    this.#requirePreview();
    return this.#connections.list().map((entry) => this.#view(entry));
  }

  getConnection(connectionId: string): RemoteTaskConnectionView {
    this.#requirePreview();
    return this.#view(this.#connection(connectionId));
  }

  async createConnection(input: unknown): Promise<RemoteTaskConnectionView> {
    this.#requirePreview();
    const record =
      typeof input === 'object' && input !== null
        ? (input as Record<string, unknown>)
        : {};
    if (!isRemoteTaskVendorId(record.vendor))
      throw invalid('vendor must be devin, github-copilot or cursor');
    const vendor = record.vendor;
    this.#requirePolicy(vendor);
    const binding = this.#bindings[vendor];
    const label =
      typeof record.label === 'string' && record.label.trim()
        ? record.label.trim()
        : REMOTE_TASK_VENDOR_LABELS[vendor];
    if (label.length > LABEL_MAX_CHARS) throw invalid('label is too long');
    const settings = cleanSettings(binding, record.settings);
    const polling = (record.polling ?? binding.defaultPolling) as RemoteTaskPolling;
    const problems = remoteTaskPollingProblems(polling);
    if (problems.length > 0) throw invalid(problems.join('; '));
    const id = `remote-task-${randomBytes(8).toString('hex')}`;
    const created = await this.#connections.mutate(id, () => ({
      id,
      vendor,
      label,
      settings,
      polling: { intervalMs: polling.intervalMs, maxBackoffMs: polling.maxBackoffMs },
      // Never carried over from the request: a person accepts it separately.
      acknowledgement: null,
      createdAt: new Date(this.#now()).toISOString(),
    }));
    if (!created) throw new Error('The connection was not saved.');
    return this.#view(created);
  }

  async updateConnection(
    connectionId: string,
    input: unknown,
  ): Promise<RemoteTaskConnectionView> {
    this.#requirePreview();
    const current = this.#connection(connectionId);
    this.#requirePolicy(current.vendor);
    const record =
      typeof input === 'object' && input !== null
        ? (input as Record<string, unknown>)
        : {};
    for (const key of Object.keys(record))
      if (!['label', 'settings', 'polling'].includes(key))
        throw invalid(`${key} cannot be changed; create a new connection`);
    const binding = this.#bindings[current.vendor];
    let label = current.label;
    if (record.label !== undefined) {
      if (typeof record.label !== 'string' || !record.label.trim())
        throw invalid('label must be text');
      label = record.label.trim();
      if (label.length > LABEL_MAX_CHARS) throw invalid('label is too long');
    }
    const settings =
      record.settings !== undefined
        ? cleanSettings(binding, record.settings)
        : current.settings;
    let polling = current.polling;
    if (record.polling !== undefined) {
      const problems = remoteTaskPollingProblems(record.polling);
      if (problems.length > 0) throw invalid(problems.join('; '));
      const next = record.polling as RemoteTaskPolling;
      polling = { intervalMs: next.intervalMs, maxBackoffMs: next.maxBackoffMs };
    }
    const updated = await this.#connections.mutate(connectionId, (entry) =>
      entry ? { ...entry, label, settings, polling } : undefined,
    );
    if (!updated) throw this.#connectionGone();
    return this.#view(updated);
  }

  #connectionGone(): RemoteTaskError {
    return new RemoteTaskError(
      'remote-task-not-found',
      'No such remote task connection.',
      404,
    );
  }

  /**
   * Record that a person accepted the statement for this connection's
   * vendor. `statement` must be the current statement, word for word: a
   * client showing an older or different text cannot acknowledge.
   */
  async acknowledge(
    connectionId: string,
    statement: unknown,
  ): Promise<RemoteTaskConnectionView> {
    this.#requirePreview();
    const current = this.#connection(connectionId);
    this.#requirePolicy(current.vendor);
    const expected = remoteTaskAcknowledgementStatement(current.vendor);
    if (statement !== expected)
      throw invalid(
        'statement must be the current acknowledgement statement for this vendor',
      );
    const updated = await this.#connections.mutate(connectionId, (entry) =>
      entry
        ? {
            ...entry,
            acknowledgement: {
              vendor: entry.vendor,
              version: REMOTE_TASK_ACKNOWLEDGEMENT_VERSION,
              statement: expected,
              acknowledgedAt: new Date(this.#now()).toISOString(),
            },
          }
        : undefined,
    );
    if (!updated) throw this.#connectionGone();
    return this.#view(updated);
  }

  /** Withdraw the acknowledgement; retained maintenance, never gated. */
  async revokeAcknowledgement(connectionId: string): Promise<void> {
    this.#connection(connectionId);
    await this.#connections.mutate(connectionId, (entry) =>
      entry ? { ...entry, acknowledgement: null } : undefined,
    );
  }

  async setCredential(connectionId: string, value: unknown): Promise<void> {
    this.#requirePreview();
    const connection = this.#connection(connectionId);
    this.#requirePolicy(connection.vendor);
    const problem = remoteTaskCredentialProblem(value);
    if (problem) throw invalid(problem);
    await this.#options.credentials.set(connection.id, value as string);
  }

  /** Retained maintenance: clearing a credential is never gated. */
  async clearCredential(connectionId: string): Promise<void> {
    const connection = this.#connection(connectionId);
    await this.#options.credentials.clear(connection.id);
  }

  /** Retained maintenance: removes the connection, its credential and its stored tasks. */
  async deleteConnection(connectionId: string): Promise<void> {
    const connection = this.#connection(connectionId);
    await this.#options.credentials.removeConnection(connection.id);
    this.#tasks.removeConnection(connection.id);
    await this.#connections.mutate(connection.id, () => undefined);
  }

  // --- tasks -------------------------------------------------------------------

  async createTask(connectionId: string, input: unknown): Promise<RemoteTask> {
    const { connection, binding } = this.gate(connectionId);
    const parsed = parseRemoteTaskCreateInput(
      input,
      binding.capabilities,
      connection.vendor,
    );
    const task = await this.#call(connectionId, (context) =>
      binding.createTask(context, parsed),
    );
    await this.#tasks.mutate(connection.id, task.taskId, (record) => ({
      ...record,
      snapshot: task,
      tracking: 'active',
    }));
    return task;
  }

  async getTask(connectionId: string, taskId: string): Promise<RemoteTask> {
    const { connection, binding } = this.gate(connectionId);
    if (!binding.getTask) throw unsupported(connection.vendor, 'reading a task');
    const getTask = binding.getTask;
    return this.#call(connectionId, (context) => getTask(context, taskId));
  }

  async listTasks(
    connectionId: string,
    cursor: string | null,
  ): Promise<{ tasks: readonly RemoteTask[]; cursor: string | null }> {
    const { connection, binding } = this.gate(connectionId);
    if (!binding.listTasks) throw unsupported(connection.vendor, 'listing tasks');
    const listTasks = binding.listTasks;
    return this.#call(connectionId, (context) => listTasks(context, cursor));
  }

  async sendMessage(
    connectionId: string,
    taskId: string,
    text: unknown,
  ): Promise<{ delivery: 'sent' | 'steered' | 'queued' }> {
    const { connection, binding } = this.gate(connectionId);
    if (!binding.sendMessage || binding.capabilities.followUp === 'none')
      throw unsupported(connection.vendor, 'follow-up messages');
    if (typeof text !== 'string' || !text.trim())
      throw invalid('text is required');
    if (text.length > PROMPT_MAX_CHARS) throw invalid('text is too long');
    const sendMessage = binding.sendMessage;
    const result = await this.#call(connectionId, (context) =>
      sendMessage(context, taskId, text),
    );
    // The task works again: the tracker resumes polling it.
    await this.#tasks.mutate(connection.id, taskId, (record) => ({
      ...record,
      tracking: 'active',
      usageSettled: false,
    }));
    return result;
  }

  async cancelTask(connectionId: string, taskId: string): Promise<void> {
    const { connection, binding } = this.gate(connectionId);
    if (!binding.cancelTask || !binding.capabilities.cancel)
      throw unsupported(connection.vendor, 'stopping a task');
    const cancelTask = binding.cancelTask;
    await this.#call(connectionId, (context) => cancelTask(context, taskId));
  }

  /**
   * Stored messages after Station sequence `after` (0: from the first one
   * kept). Reads only what Station stored; sends nothing. Gated by the
   * preview and the policy like every other read of the feature.
   */
  readEvents(
    connectionId: string,
    taskId: string,
    after: number,
  ): { events: RemoteTaskStoredEvent[]; task: RemoteTask | null; tracking: string } {
    this.#requirePreview();
    const connection = this.#connection(connectionId);
    this.#requirePolicy(connection.vendor);
    const record = this.#tasks.get(connection.id, taskId);
    if (!record)
      throw new RemoteTaskError(
        'remote-task-not-found',
        'Station has stored nothing for this task.',
        404,
      );
    return {
      events: record.events.filter((event) => event.sequence > after),
      task: record.snapshot,
      tracking: record.tracking,
    };
  }

  /** Tasks the tracker should poll: stored and not quiescent. */
  activeTasks(): Array<{ connectionId: string; taskId: string }> {
    return this.#tasks
      .listAll()
      .filter((record) => record.tracking === 'active')
      .map(({ connectionId, taskId }) => ({ connectionId, taskId }));
  }

  pollingFor(connectionId: string): RemoteTaskPolling | undefined {
    return REMOTE_TASK_CONNECTION_ID.test(connectionId)
      ? this.#connections.get(connectionId)?.polling
      : undefined;
  }

  /**
   * One catch-up of a task: read it, record a status change, page the
   * vendor's messages from the stored cursor (dropping ids already stored),
   * and, once no work is running, read usage a vendor reports apart. A
   * restart resumes from the stored cursor, so a task that ran while Station
   * was off is caught up on the next sync.
   */
  async syncTask(
    connectionId: string,
    taskId: string,
  ): Promise<RemoteTaskSyncResult> {
    return this.#call(connectionId, async (context, binding, connection) => {
      if (!binding.getTask)
        throw unsupported(connection.vendor, 'reading a task');
      const task = await binding.getTask(context, taskId);
      const before = this.#tasks.get(connection.id, taskId);
      const statusEvents: RemoteTaskEvent[] = [];
      if (before?.snapshot?.vendorStatus !== task.vendorStatus)
        statusEvents.push({
          // Station-authored: the vendor's status word, once per change.
          id: `station:status:${before?.nextSequence ?? 1}:${task.vendorStatus}`,
          author: 'system',
          text: `${REMOTE_TASK_VENDOR_LABELS[connection.vendor]} status: ${task.vendorStatus}`,
          ...(task.updatedAt ? { createdAt: task.updatedAt } : {}),
        });
      const appended: RemoteTaskStoredEvent[] = [];
      let record = await this.#tasks.mutate(connection.id, taskId, (current) => {
        const next = appendRemoteTaskEvents(current, statusEvents);
        appended.push(...next.appended);
        return { ...next.record, snapshot: task };
      });
      let more = false;
      if (binding.capabilities.events && binding.pageEvents) {
        let cursor = record.vendorCursor;
        for (let page = 0; page < EVENT_PAGES_PER_SYNC; page += 1) {
          const result = await binding.pageEvents(context, taskId, cursor);
          cursor = result.cursor;
          record = await this.#tasks.mutate(connection.id, taskId, (current) => {
            const next = appendRemoteTaskEvents(current, result.events);
            appended.push(...next.appended);
            return { ...next.record, vendorCursor: result.cursor };
          });
          more = result.hasMore;
          if (!result.hasMore) break;
        }
      }
      const quiescent =
        !more &&
        (isRemoteTaskTerminal(task.status) || QUIESCENT.includes(task.status));
      let finalTask = task;
      if (quiescent && binding.getUsage && !record.usageSettled) {
        const usage = await binding.getUsage(context, taskId);
        finalTask = { ...task, usage };
      }
      await this.#tasks.mutate(connection.id, taskId, (current) => ({
        ...current,
        snapshot: finalTask,
        tracking: quiescent ? 'quiescent' : 'active',
        usageSettled: quiescent ? true : current.usageSettled,
      }));
      return { task: finalTask, appended, quiescent };
    });
  }

  /** For the routes: the preview id the refusal names. */
  static readonly previewId = REMOTE_TASK_PREVIEW_ID;
}
