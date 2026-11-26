/**
 * Devin API v3 (organization scope). Every path below is stable v3; none of
 * the session endpoints is `v3beta1`.
 *
 * Sources (read 2026-11-14):
 * - https://docs.devin.ai/api-reference/overview (base URL, 429)
 * - https://docs.devin.ai/api-reference/authentication (`Bearer cog_…`)
 * - https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions.md
 * - https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session.md
 * - https://docs.devin.ai/api-reference/v3/sessions/organizations-sessions.md
 * - https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions-messages.md
 * - https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session-messages
 * - https://docs.devin.ai/api-reference/v3/sessions/delete-organizations-sessions.md
 *
 * Not used: `create_as_user_id` (impersonation needs `ImpersonateOrgSessions`;
 * Station acts only as the token's own principal), `session_secrets` and
 * `secret_ids` (Station never forwards secrets), archive/sleep/tags.
 */
import type {
  RemoteTask,
  RemoteTaskEvent,
  RemoteTaskOutput,
  RemoteTaskStatus,
  RemoteTaskUsage,
} from '@kontourai/station-contracts/remote-task-engine';
import {
  asRecord,
  invalidTaskId,
  malformed,
  type RemoteTaskBinding,
  type RemoteTaskCallContext,
  stringField,
} from '../binding.js';

const VENDOR = 'Devin';
/** Devin's documented page size cap for `first`. */
const PAGE_SIZE = 100;
/** `org-…`, as the API reference's examples show. */
const ORG_ID = /^org-[A-Za-z0-9_-]{1,128}$/;
const SESSION_ID = /^devin-[A-Za-z0-9_-]{1,128}$/;

function orgPath(context: RemoteTaskCallContext): string {
  return `/v3/organizations/${encodeURIComponent(context.settings.orgId ?? '')}`;
}

function sessionPath(context: RemoteTaskCallContext, taskId: string): string {
  if (!SESSION_ID.test(taskId)) throw invalidTaskId(VENDOR);
  return `${orgPath(context)}/sessions/${encodeURIComponent(taskId)}`;
}

/**
 * `status` × `status_detail` → Station's status. `running` + `finished` is a
 * session whose work is done but which still accepts messages: idle.
 * `suspended` keeps its reason in `vendorStatus`.
 */
export function devinStatus(
  status: string,
  detail: string | undefined,
): RemoteTaskStatus {
  switch (status) {
    case 'new':
    case 'claimed':
      return 'queued';
    case 'resuming':
      return 'running';
    case 'running':
      if (detail === 'waiting_for_user' || detail === 'waiting_for_approval')
        return 'waiting-for-user';
      if (detail === 'finished') return 'idle';
      return 'running';
    case 'suspended':
      return 'idle';
    case 'exit':
      return 'completed';
    case 'error':
      return 'failed';
    default:
      return 'unknown';
  }
}

/**
 * Devin documents `created_at` as an integer without a unit. Seconds are
 * assumed (other v3 fields say "Unix seconds"); a value already in
 * milliseconds is recognized by size.
 */
function epochToIso(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const ms = value > 1e12 ? value : value * 1000;
  return new Date(ms).toISOString();
}

function devinSession(connectionId: string, body: unknown): RemoteTask {
  const record = asRecord(body);
  const sessionId = stringField(record, 'session_id');
  const status = stringField(record, 'status');
  if (!sessionId || !status) throw malformed(VENDOR, 'a session');
  const detail = stringField(record, 'status_detail');
  const outputs: RemoteTaskOutput[] = [];
  if (Array.isArray(record.pull_requests))
    for (const entry of record.pull_requests) {
      const pr = asRecord(entry);
      const url = stringField(pr, 'pr_url');
      if (!url) continue;
      const state = stringField(pr, 'pr_state');
      outputs.push({ kind: 'pull-request', url, ...(state ? { state } : {}) });
    }
  const usage: RemoteTaskUsage[] = [];
  if (typeof record.acus_consumed === 'number')
    usage.push({ unit: 'acu', quantity: record.acus_consumed });
  // Overage spend in USD, Teams plans only; reported only by get and list.
  if (typeof record.on_demand_usage === 'number')
    usage.push({ unit: 'usd', quantity: record.on_demand_usage });
  const title = stringField(record, 'title');
  const url = stringField(record, 'url');
  const createdAt = epochToIso(record.created_at);
  const updatedAt = epochToIso(record.updated_at);
  return {
    connectionId,
    vendor: 'devin',
    taskId: sessionId,
    status: devinStatus(status, detail),
    vendorStatus: detail ? `${status}:${detail}` : status,
    ...(title ? { title } : {}),
    ...(url ? { url } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    outputs,
    usage,
  };
}

function devinMessage(body: unknown): RemoteTaskEvent | undefined {
  const record = asRecord(body);
  const id = stringField(record, 'event_id');
  const text = stringField(record, 'message');
  const source = stringField(record, 'source');
  if (!id || text === undefined) return undefined;
  const createdAt = epochToIso(record.created_at);
  return {
    id,
    author: source === 'user' ? 'user' : 'agent',
    text,
    ...(createdAt ? { createdAt } : {}),
  };
}

export const devinBinding: RemoteTaskBinding = {
  vendor: 'devin',
  baseUrl: 'https://api.devin.ai',
  capabilities: {
    createTask: true,
    getTask: true,
    listTasks: true,
    // "The session will be automatically resumed if suspended", and a
    // running session reads the message while it works.
    followUp: 'steer',
    events: true,
    // DELETE …/sessions/{devin_id} is "Terminate Session".
    cancel: true,
    // No `model` or branch field on create; `repos` only.
    createOptions: { model: false, baseRef: false, createPullRequest: false },
    usageUnits: ['acu', 'usd'],
  },
  defaultPolling: { intervalMs: 15_000, maxBackoffMs: 5 * 60_000 },
  evidence: [
    'https://docs.devin.ai/api-reference/overview',
    'https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session-messages',
  ],
  settingKeys: ['orgId'],
  settingsProblems(settings) {
    const orgId = settings.orgId;
    return orgId && ORG_ID.test(orgId)
      ? []
      : ['settings.orgId must be a Devin organization id ("org-…")'];
  },
  authorize(credential) {
    return { authorization: `Bearer ${credential}` };
  },
  readError(body) {
    // RFC 9457 ProblemDetail: `title`, `status`, `detail`, `error_code`.
    const record = asRecord(body);
    const title = stringField(record, 'title');
    const detail = stringField(record, 'detail');
    const code = stringField(record, 'error_code');
    const message = title && detail ? `${title}: ${detail}` : (detail ?? title);
    return { ...(message ? { message } : {}), ...(code ? { code } : {}) };
  },

  async createTask(context, input) {
    const repos = input.repository
      ? [`${input.repository.owner}/${input.repository.name}`]
      : undefined;
    const { body } = await context.http.json({
      method: 'POST',
      path: `${orgPath(context)}/sessions`,
      body: { prompt: input.prompt, ...(repos ? { repos } : {}) },
    });
    return devinSession(context.connectionId, body);
  },

  async getTask(context, taskId) {
    const { body } = await context.http.json({
      method: 'GET',
      path: sessionPath(context, taskId),
    });
    return devinSession(context.connectionId, body);
  },

  async listTasks(context, cursor) {
    const { body } = await context.http.json({
      method: 'GET',
      path: `${orgPath(context)}/sessions`,
      query: { first: PAGE_SIZE, after: cursor ?? undefined },
    });
    const record = asRecord(body);
    if (!Array.isArray(record.items)) throw malformed(VENDOR, 'a session list');
    const next = stringField(record, 'end_cursor');
    return {
      tasks: record.items.map((item) =>
        devinSession(context.connectionId, item),
      ),
      cursor: record.has_next_page === true && next ? next : null,
    };
  },

  async sendMessage(context, taskId, text) {
    await context.http.json({
      method: 'POST',
      path: `${sessionPath(context, taskId)}/messages`,
      body: { message: text },
    });
    return { delivery: 'sent' };
  },

  async pageEvents(context, taskId, cursor) {
    const { body } = await context.http.json({
      method: 'GET',
      path: `${sessionPath(context, taskId)}/messages`,
      query: { first: PAGE_SIZE, after: cursor ?? undefined },
    });
    const record = asRecord(body);
    if (!Array.isArray(record.items)) throw malformed(VENDOR, 'a message list');
    const events = record.items.flatMap((item) => {
      const event = devinMessage(item);
      return event ? [event] : [];
    });
    const endCursor = stringField(record, 'end_cursor');
    // `end_cursor` may be null on the last page. Devin documents no other
    // position to resume from (whether an `event_id` is a valid `after` is
    // not stated), so the last cursor it did issue is kept: the next poll
    // re-reads at most that one page, and the store drops what it holds.
    return {
      events,
      cursor: endCursor ?? cursor,
      hasMore: record.has_next_page === true && endCursor !== undefined,
    };
  },

  async cancelTask(context, taskId) {
    await context.http.json({
      method: 'DELETE',
      path: sessionPath(context, taskId),
    });
  },

  // The messages endpoint lists 410 without a stated meaning; for a session
  // already finished it can only mean there is nothing more to read.
  isEndOfMessages: (error) => error.details.vendorStatus === 410,
};
