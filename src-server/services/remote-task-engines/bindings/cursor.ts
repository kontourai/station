/**
 * Cursor Cloud Agents API v1 (public beta), base `https://api.cursor.com`.
 *
 * Source (read 2026-11-14): https://cursor.com/docs/cloud-agent/api/endpoints
 * (create, get, list, runs, follow-up and `delivery: "steer"`, cancel run,
 * usage, the error envelope, Basic or Bearer auth), with
 * https://cursor.com/docs-static/cloud-agents-openapi.yaml for the 429 headers.
 *
 * A task is a Cursor agent; its status is the latest run's. v1 has no
 * conversation endpoint. Its SSE stream's `assistant` events are text deltas
 * for an ordinary agent (a whole message only for a project coordinator), and
 * opening a stream is rate-limited apart from requests (60 a minute, 600 an
 * hour), so Station does not read the stream. Each finished run's `result`
 * (its final text) is the agent's message for that run, keyed by run id, read
 * from the runs list: no stream opens, and replay cannot duplicate. The request
 * never carries `mcpServers`, `envVars` or `customSubagents`: forwarding a
 * Station tool server (Station Control above all) to a remote agent would
 * expose this host to it.
 */
import type {
  RemoteTask,
  RemoteTaskEvent,
  RemoteTaskOutput,
  RemoteTaskStatus,
} from '@kontourai/station-contracts/remote-task-engine';
import {
  asRecord,
  invalidTaskId,
  malformed,
  type RemoteTaskBinding,
  type RemoteTaskCallContext,
  stringField,
} from '../binding.js';
import { RemoteTaskError } from '../remote-task-error.js';

const VENDOR = 'Cursor';
const PAGE_SIZE = 100;
const AGENT_ID = /^bc-[A-Za-z0-9-]{1,128}$/;
const RUN_ID = /^run-[A-Za-z0-9-]{1,128}$/;
/** Finished runs without an inline `result` read one by one, per poll. */
const RESULT_READS_PER_PAGE = 5;
const TERMINAL_RUN_STATES = new Set([
  'FINISHED',
  'ERROR',
  'CANCELLED',
  'EXPIRED',
]);

const RUN_STATES: Readonly<Record<string, RemoteTaskStatus>> = {
  CREATING: 'queued',
  RUNNING: 'running',
  WAITING_FOR_BACKGROUND_WORK: 'running',
  FINISHED: 'completed',
  ERROR: 'failed',
  CANCELLED: 'cancelled',
  EXPIRED: 'timed-out',
};

const AGENT_STATES: Readonly<Record<string, RemoteTaskStatus>> = {
  ACTIVE: 'running',
  IDLE: 'idle',
  ARCHIVED: 'completed',
};

function agentPath(taskId: string): string {
  if (!AGENT_ID.test(taskId)) throw invalidTaskId(VENDOR);
  return `/v1/agents/${encodeURIComponent(taskId)}`;
}

function cursorTask(
  connectionId: string,
  agentBody: unknown,
  runBody?: unknown,
): RemoteTask {
  const agent = asRecord(agentBody);
  const id = stringField(agent, 'id');
  const agentStatus = stringField(agent, 'status');
  if (!id || !agentStatus) throw malformed(VENDOR, 'an agent');
  const run = runBody === undefined ? undefined : asRecord(runBody);
  const runStatus = run ? stringField(run, 'status') : undefined;
  const outputs: RemoteTaskOutput[] = [];
  const branches = asRecord(run?.git).branches;
  if (Array.isArray(branches))
    for (const entry of branches) {
      const url = stringField(asRecord(entry), 'prUrl');
      if (url) outputs.push({ kind: 'pull-request', url });
    }
  const status =
    agentStatus === 'ARCHIVED'
      ? 'completed'
      : runStatus
        ? (RUN_STATES[runStatus] ?? 'unknown')
        : (AGENT_STATES[agentStatus] ?? 'unknown');
  const title = stringField(agent, 'name');
  const url = stringField(agent, 'url');
  const createdAt = stringField(agent, 'createdAt');
  const updatedAt = stringField(run ?? agent, 'updatedAt');
  return {
    connectionId,
    vendor: 'cursor',
    taskId: id,
    status,
    vendorStatus: runStatus ? `${agentStatus}:${runStatus}` : agentStatus,
    ...(title ? { title } : {}),
    ...(url ? { url } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    outputs,
    // Usage is read once the task stops working (`getUsage`).
    usage: [],
  };
}

async function readAgent(
  context: RemoteTaskCallContext,
  taskId: string,
): Promise<{ agent: unknown; run?: unknown; runId?: string }> {
  const { body: agent } = await context.http.json({
    method: 'GET',
    path: agentPath(taskId),
  });
  const runId = stringField(asRecord(agent), 'latestRunId');
  if (!runId || !RUN_ID.test(runId)) return { agent };
  const { body: run } = await context.http.json({
    method: 'GET',
    path: `${agentPath(taskId)}/runs/${encodeURIComponent(runId)}`,
  });
  return { agent, run, runId };
}

function isVendorCode(error: unknown, status: number, code?: string): boolean {
  return (
    error instanceof RemoteTaskError &&
    error.details.vendorStatus === status &&
    (code === undefined || error.details.vendorCode === code)
  );
}

/** A finished run's final text as one agent message, or undefined. */
function runMessage(run: Record<string, unknown>): RemoteTaskEvent | undefined {
  const id = stringField(run, 'id');
  const result = stringField(run, 'result');
  if (!id || result === undefined || result === '') return undefined;
  const createdAt =
    stringField(run, 'updatedAt') ?? stringField(run, 'createdAt');
  return {
    id: `run:${id}`,
    author: 'agent',
    text: result,
    ...(createdAt ? { createdAt } : {}),
  };
}

export const cursorBinding: RemoteTaskBinding = {
  vendor: 'cursor',
  baseUrl: 'https://api.cursor.com',
  capabilities: {
    createTask: true,
    getTask: true,
    listTasks: true,
    followUp: 'steer',
    events: true,
    cancel: true,
    createOptions: { model: true, baseRef: true, createPullRequest: true },
    usageUnits: ['tokens'],
  },
  // The documented default limit is 20 requests a minute per key; a poll
  // costs three requests (agent, latest run, runs list) and opens no stream.
  defaultPolling: { intervalMs: 30_000, maxBackoffMs: 10 * 60_000 },
  evidence: ['https://cursor.com/docs/cloud-agent/api/endpoints'],
  settingKeys: [],
  settingsProblems: () => [],
  authorize(credential) {
    return { authorization: `Bearer ${credential}` };
  },
  readError(body) {
    const record = asRecord(body);
    const envelope = asRecord(record.error);
    // `{ error: { code, message } }`, or a 401's top-level `{ code, message }`.
    const message =
      stringField(envelope, 'message') ?? stringField(record, 'message');
    const code = stringField(envelope, 'code') ?? stringField(record, 'code');
    return { ...(message ? { message } : {}), ...(code ? { code } : {}) };
  },

  async createTask(context, input) {
    const repos = input.repository
      ? [
          {
            url: `https://github.com/${input.repository.owner}/${input.repository.name}`,
            ...(input.baseRef ? { startingRef: input.baseRef } : {}),
          },
        ]
      : undefined;
    const { body } = await context.http.json({
      method: 'POST',
      path: '/v1/agents',
      body: {
        prompt: { text: input.prompt },
        ...(input.model ? { model: { id: input.model } } : {}),
        ...(repos ? { repos } : {}),
        ...(input.createPullRequest !== undefined
          ? { autoCreatePR: input.createPullRequest }
          : {}),
      },
    });
    const record = asRecord(body);
    return cursorTask(context.connectionId, record.agent, record.run);
  },

  async getTask(context, taskId) {
    const { agent, run } = await readAgent(context, taskId);
    return cursorTask(context.connectionId, agent, run);
  },

  async listTasks(context, cursor) {
    const { body } = await context.http.json({
      method: 'GET',
      path: '/v1/agents',
      query: { limit: PAGE_SIZE, cursor: cursor ?? undefined },
    });
    const record = asRecord(body);
    if (!Array.isArray(record.items)) throw malformed(VENDOR, 'an agent list');
    return {
      tasks: record.items.map((item) => cursorTask(context.connectionId, item)),
      // `nextCursor` is omitted on the last page.
      cursor: stringField(record, 'nextCursor') ?? null,
    };
  },

  async sendMessage(context, taskId, text) {
    const path = `${agentPath(taskId)}/runs`;
    try {
      await context.http.json({
        method: 'POST',
        path,
        body: { prompt: { text } },
      });
      return { delivery: 'sent' };
    } catch (error) {
      // A run is active: steer it instead of failing the follow-up.
      if (!isVendorCode(error, 409, 'agent_busy')) throw error;
    }
    const { body } = await context.http.json({
      method: 'POST',
      path,
      body: { prompt: { text }, delivery: 'steer' },
    });
    return {
      delivery: asRecord(body).delivery === 'queued' ? 'queued' : 'steered',
    };
  },

  /**
   * The finished runs' results, oldest first. The runs list has no resume
   * position Station could keep, so every poll reads its first page and the
   * store drops the run ids it already holds; the cursor stays null.
   */
  async pageEvents(context, taskId) {
    const { body } = await context.http.json({
      method: 'GET',
      path: `${agentPath(taskId)}/runs`,
    });
    const record = asRecord(body);
    if (!Array.isArray(record.items)) throw malformed(VENDOR, 'a run list');
    const runs = record.items
      .map((item) => asRecord(item))
      .filter((run) =>
        TERMINAL_RUN_STATES.has(stringField(run, 'status') ?? ''),
      )
      .sort((a, b) =>
        (stringField(a, 'createdAt') ?? '').localeCompare(
          stringField(b, 'createdAt') ?? '',
        ),
      );
    const events: RemoteTaskEvent[] = [];
    let reads = 0;
    for (const run of runs) {
      let message = runMessage(run);
      const runId = stringField(run, 'id');
      // A list entry may leave `result` out; the run itself carries it.
      if (
        !message &&
        run.result === undefined &&
        runId &&
        RUN_ID.test(runId) &&
        reads < RESULT_READS_PER_PAGE
      ) {
        reads += 1;
        const { body: full } = await context.http.json({
          method: 'GET',
          path: `${agentPath(taskId)}/runs/${encodeURIComponent(runId)}`,
        });
        message = runMessage(asRecord(full));
      }
      if (message) events.push(message);
    }
    return { events, cursor: null, hasMore: false };
  },

  async cancelTask(context, taskId) {
    const { runId } = await readAgent(context, taskId);
    if (!runId)
      throw new RemoteTaskError(
        'remote-task-invalid',
        'This Cursor agent has no run to stop.',
        409,
      );
    await context.http.json({
      method: 'POST',
      path: `${agentPath(taskId)}/runs/${encodeURIComponent(runId)}/cancel`,
    });
  },

  async getUsage(context, taskId) {
    const { body } = await context.http.json({
      method: 'GET',
      path: `${agentPath(taskId)}/usage`,
    });
    const total = asRecord(asRecord(body).totalUsage).totalTokens;
    return typeof total === 'number'
      ? [{ unit: 'tokens', quantity: total }]
      : [];
  },

  // Reading an archived agent answers `409 agent_archived`: it has nothing
  // more to give.
  isEndOfMessages: (error) =>
    error.details.vendorStatus === 409 &&
    error.details.vendorCode === 'agent_archived',
};
