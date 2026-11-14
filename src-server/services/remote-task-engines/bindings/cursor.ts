/**
 * Cursor Cloud Agents API v1 (public beta), base `https://api.cursor.com`.
 *
 * Source (read 2026-11-14): https://cursor.com/docs/cloud-agent/api/endpoints
 * (create, get, list, runs, follow-up and `delivery: "steer"`, cancel run,
 * usage, the agent SSE stream and its `Last-Event-ID` resume, the error
 * envelope, Basic or Bearer auth), with
 * https://cursor.com/docs-static/cloud-agents-openapi.yaml for the 429 headers.
 *
 * A task is a Cursor agent; its status is the latest run's. v1 has no
 * conversation endpoint, so messages come from the agent stream, read in a
 * bounded window per poll and resumed from the last event id. The request
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
  malformed,
  type RemoteTaskBinding,
  type RemoteTaskCallContext,
  stringField,
} from '../binding.js';
import { RemoteTaskError } from '../remote-task-error.js';
import { readSseWindow } from '../sse-window.js';

const VENDOR = 'Cursor';
const PAGE_SIZE = 100;
const AGENT_ID = /^bc-[A-Za-z0-9-]{1,128}$/;
const RUN_ID = /^run-[A-Za-z0-9-]{1,128}$/;
/** One poll's stream window. */
const STREAM_WINDOW = {
  maxEvents: 200,
  idleMs: 1_500,
  windowMs: 10_000,
  stopAt: ['heartbeat', 'done'],
} as const;

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
  if (!AGENT_ID.test(taskId)) throw new Error('A Cursor agent id starts with "bc-".');
  return `/v1/agents/${encodeURIComponent(taskId)}`;
}

export function cursorTask(
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

async function readStream(
  context: RemoteTaskCallContext,
  taskId: string,
  cursor: string | null,
) {
  const controller = new AbortController();
  const response = await context.http.stream(
    { method: 'GET', path: `${agentPath(taskId)}/stream` },
    cursor ? { 'last-event-id': cursor } : {},
    controller.signal,
  );
  if (!response.body) return { events: [], ended: true };
  return readSseWindow(response.body, STREAM_WINDOW, () => controller.abort());
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
  // costs up to three (agent, run, stream).
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

  async pageEvents(context, taskId, cursor) {
    let window: Awaited<ReturnType<typeof readStream>>;
    try {
      window = await readStream(context, taskId, cursor);
    } catch (error) {
      // The id outlived the stream's retention (410 stream_expired) or is
      // not this agent's (400 invalid_last_event_id): read what the stream
      // still retains; ids already stored are dropped by the store.
      if (
        cursor &&
        (isVendorCode(error, 410) ||
          isVendorCode(error, 400, 'invalid_last_event_id'))
      )
        window = await readStream(context, taskId, null);
      else throw error;
    }
    const events: RemoteTaskEvent[] = [];
    let next = cursor;
    for (const event of window.events) {
      // The leading status event carries no id and is resent on every
      // reconnect; it never moves the cursor.
      if (event.id === undefined) continue;
      next = event.id;
      if (event.event !== 'assistant') continue;
      let text: unknown;
      try {
        text = asRecord(JSON.parse(event.data)).text;
      } catch {
        continue;
      }
      if (typeof text === 'string') events.push({ id: event.id, author: 'agent', text });
    }
    return {
      events,
      cursor: next,
      hasMore: window.events.length >= STREAM_WINDOW.maxEvents,
    };
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
    return typeof total === 'number' ? [{ unit: 'tokens', quantity: total }] : [];
  },
};
