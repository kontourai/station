/**
 * GitHub Copilot cloud agent, through the agent tasks REST API (public
 * preview, `X-GitHub-Api-Version: 2026-03-10`).
 *
 * Sources (read 2026-11-14):
 * - https://docs.github.com/en/rest/agent-tasks/agent-tasks (every endpoint,
 *   the task and session schemas, token types and permissions)
 * - https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
 *   (429, and 403 with `x-ratelimit-remaining: 0` or `retry-after`)
 *
 * The API has no follow-up, message, log or cancel endpoint, so those
 * capabilities are off. Station does not call the undocumented endpoints the
 * `gh agent-task` command uses. Plan eligibility is not checked here: the
 * reference says Business/Enterprise while a 2026-06-04 changelog adds
 * Pro/Pro+/Max, so Station sends the request and passes on GitHub's answer.
 */
import type {
  RemoteTask,
  RemoteTaskOutput,
  RemoteTaskStatus,
  RemoteTaskUsage,
  RemoteTaskUsageUnit,
} from '@kontourai/station-contracts/remote-task-engine';
import {
  asRecord,
  invalidTaskId,
  malformed,
  type RemoteTaskBinding,
  stringField,
} from '../binding.js';
import { RemoteTaskError } from '../remote-task-error.js';

const VENDOR = 'GitHub Copilot';
const PAGE_SIZE = 100;
const TASK_ID = /^[A-Za-z0-9_-]{1,128}$/;

const STATES: Readonly<Record<string, RemoteTaskStatus>> = {
  queued: 'queued',
  in_progress: 'running',
  completed: 'completed',
  failed: 'failed',
  idle: 'idle',
  waiting_for_user: 'waiting-for-user',
  timed_out: 'timed-out',
  cancelled: 'cancelled',
};

const USAGE_UNITS: Readonly<Record<string, RemoteTaskUsageUnit>> = {
  ai_credits: 'ai-credits',
  premium_requests: 'premium-requests',
};

function taskPath(taskId: string): string {
  if (!TASK_ID.test(taskId)) throw invalidTaskId(VENDOR);
  return `/agents/tasks/${encodeURIComponent(taskId)}`;
}

/**
 * A task object. Usage is per session (`sessions[].usage`), which only the
 * get endpoints return; amounts of one type are summed.
 */
function copilotTask(connectionId: string, body: unknown): RemoteTask {
  const record = asRecord(body);
  const id =
    typeof record.id === 'number'
      ? String(record.id)
      : stringField(record, 'id');
  const state = stringField(record, 'state');
  if (!id || !state) throw malformed(VENDOR, 'a task');
  const outputs: RemoteTaskOutput[] = [];
  if (Array.isArray(record.artifacts))
    for (const entry of record.artifacts) {
      const artifact = asRecord(entry);
      if (artifact.type !== 'pull') continue;
      const data = asRecord(artifact.data);
      // A pull request is reported only by its id, never its URL or number.
      if (typeof data.id === 'number' || typeof data.id === 'string')
        outputs.push({ kind: 'pull-request', reference: `pull:${data.id}` });
    }
  const totals = new Map<RemoteTaskUsageUnit, number>();
  if (Array.isArray(record.sessions))
    for (const entry of record.sessions) {
      const usage = asRecord(asRecord(entry).usage);
      const unit = USAGE_UNITS[stringField(usage, 'type') ?? ''];
      if (unit && typeof usage.amount === 'number')
        totals.set(unit, (totals.get(unit) ?? 0) + usage.amount);
    }
  const usage: RemoteTaskUsage[] = [...totals].map(([unit, quantity]) => ({
    unit,
    quantity,
  }));
  const title = stringField(record, 'name');
  const url = stringField(record, 'html_url');
  const createdAt = stringField(record, 'created_at');
  const updatedAt = stringField(record, 'updated_at');
  return {
    connectionId,
    vendor: 'github-copilot',
    taskId: id,
    status: STATES[state] ?? 'unknown',
    vendorStatus: state,
    ...(title ? { title } : {}),
    ...(url ? { url } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    outputs,
    usage,
  };
}

export const githubCopilotBinding: RemoteTaskBinding = {
  vendor: 'github-copilot',
  baseUrl: 'https://api.github.com',
  capabilities: {
    createTask: true,
    getTask: true,
    listTasks: true,
    followUp: 'none',
    events: false,
    cancel: false,
    createOptions: { model: true, baseRef: true, createPullRequest: true },
    usageUnits: ['ai-credits', 'premium-requests'],
  },
  defaultPolling: { intervalMs: 30_000, maxBackoffMs: 10 * 60_000 },
  evidence: ['https://docs.github.com/en/rest/agent-tasks/agent-tasks'],
  settingKeys: [],
  settingsProblems: () => [],
  authorize(credential) {
    return {
      authorization: `Bearer ${credential}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2026-03-10',
    };
  },
  readError(body) {
    const record = asRecord(body);
    const message = stringField(record, 'message');
    return message ? { message } : {};
  },
  isRateLimited(status, headers) {
    return (
      status === 403 &&
      (headers.get('x-ratelimit-remaining')?.trim() === '0' ||
        headers.get('retry-after') !== null)
    );
  },

  async createTask(context, input) {
    if (!input.repository)
      throw new RemoteTaskError(
        'remote-task-invalid',
        'GitHub Copilot needs a repository for a task.',
        400,
      );
    const { owner, name } = input.repository;
    const { body } = await context.http.json({
      method: 'POST',
      path: `/agents/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/tasks`,
      body: {
        prompt: input.prompt,
        ...(input.model ? { model: input.model } : {}),
        ...(input.baseRef ? { base_ref: input.baseRef } : {}),
        ...(input.createPullRequest !== undefined
          ? { create_pull_request: input.createPullRequest }
          : {}),
      },
    });
    return copilotTask(context.connectionId, body);
  },

  async getTask(context, taskId) {
    const { body } = await context.http.json({
      method: 'GET',
      path: taskPath(taskId),
    });
    return copilotTask(context.connectionId, body);
  },

  async listTasks(context, cursor) {
    const page = cursor && /^\d{1,6}$/.test(cursor) ? Number(cursor) : 1;
    const { body } = await context.http.json({
      method: 'GET',
      path: '/agents/tasks',
      query: { per_page: PAGE_SIZE, page },
    });
    const record = asRecord(body);
    if (!Array.isArray(record.tasks)) throw malformed(VENDOR, 'a task list');
    return {
      tasks: record.tasks.map((task) =>
        copilotTask(context.connectionId, task),
      ),
      cursor: record.tasks.length === PAGE_SIZE ? String(page + 1) : null,
    };
  },
};
