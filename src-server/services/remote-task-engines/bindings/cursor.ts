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
/** Run list pages read per call; the first page is usually enough. */
const RUN_LIST_PAGES = 10;
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

/**
 * A finished run that ended without a result, as a Station-authored note.
 * Storing it (under the run's own id) marks the run consumed, so it is never
 * read again; a cancelled, failed or expired run may carry no result at all.
 */
function emptyRunNote(
  run: Record<string, unknown>,
): RemoteTaskEvent | undefined {
  const id = stringField(run, 'id');
  const status = stringField(run, 'status');
  if (!id || !status || !TERMINAL_RUN_STATES.has(status)) return undefined;
  const createdAt =
    stringField(run, 'updatedAt') ?? stringField(run, 'createdAt');
  return {
    id: `run:${id}`,
    author: 'system',
    text: `${VENDOR} run ended ${status.toLowerCase()} with no result.`,
    ...(createdAt ? { createdAt } : {}),
  };
}

/**
 * A pending run the vendor answers 404 for: it is gone for good, so it is
 * stored as a note (consumed) instead of blocking every later read.
 */
function goneRunNote(runId: string): RemoteTaskEvent {
  return {
    id: `run:${runId}`,
    author: 'system',
    text: `${VENDOR} no longer has this run; its result could not be read.`,
  };
}

/** What a run-list call left for the next one (see `pageEvents`). */
interface RunPaging {
  readonly pending: readonly string[];
  readonly resume?: string;
  /**
   * The oldest run's `createdAt` in the window `resume` continues. A resumed
   * listing stops only at a stored run older than this, so a run inserted at
   * the top (which shifts an offset cursor) cannot end the backlog early.
   */
  readonly resumeBefore?: string;
  readonly top?: true;
}

/**
 * The stored cursor as paging state. A bare string is a vendor cursor from
 * before the state existed; it resumes from there.
 */
function readRunPaging(cursor: string | null): RunPaging {
  if (cursor === null) return { pending: [] };
  let value: unknown;
  try {
    value = JSON.parse(cursor);
  } catch {
    return { pending: [], resume: cursor };
  }
  const record = asRecord(value);
  if (record.kind !== 'cursor-runs') return { pending: [], resume: cursor };
  const pending = Array.isArray(record.pending)
    ? record.pending.filter(
        (id): id is string => typeof id === 'string' && RUN_ID.test(id),
      )
    : [];
  const resume = stringField(record, 'resume');
  const resumeBefore = stringField(record, 'resumeBefore');
  return {
    pending,
    ...(resume ? { resume } : {}),
    ...(resume && resumeBefore ? { resumeBefore } : {}),
    ...(record.top === true ? { top: true as const } : {}),
  };
}

function pagingResult(
  events: RemoteTaskEvent[],
  state: RunPaging,
): { events: RemoteTaskEvent[]; cursor: string | null; hasMore: boolean } {
  const more =
    state.pending.length > 0 ||
    state.resume !== undefined ||
    state.top === true;
  return {
    events,
    cursor: more ? JSON.stringify({ kind: 'cursor-runs', ...state }) : null,
    hasMore: more,
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
   * The finished runs' results, oldest first. The runs list is newest first
   * and paged (`limit`, `nextCursor`); it is followed until a page reaches a
   * run Station already stored, at most ten pages a call. Stopping there is
   * safe only while every run older than a stored one is accounted for, so
   * the cursor carries the work a call could not finish (`RunPaging`):
   *
   * - `pending`: finished runs the list left without a `result`, oldest
   *   first. They are read on their own, five a call, before anything is
   *   listed again; a run that ended with no result is stored as a note.
   * - `resume`: the vendor's `nextCursor` where ten pages ran out, so the
   *   next call continues that backlog instead of dropping it. A resumed
   *   listing stops only at a stored run older than the backlog's boundary
   *   (`resumeBefore`): with an offset cursor, a run added at the top shifts
   *   an already stored run onto the first resumed page.
   * - `top`: work was deferred (runs to read, or a backlog), so once it is
   *   done the next call lists again from the newest run, which runs may have
   *   joined meanwhile. A pass from the newest run that defers nothing ends
   *   the paging.
   *
   * `hasMore` holds while any of them remains, so the task cannot settle
   * with work left. The service stores the cursor, so the work survives a
   * failed page and a restart.
   */
  async pageEvents(context, taskId, cursor, known = () => false) {
    const state = readRunPaging(cursor);
    const events: RemoteTaskEvent[] = [];
    if (state.pending.length > 0) {
      const pending = state.pending.filter((id) => !known(`run:${id}`));
      for (const runId of pending.slice(0, RESULT_READS_PER_PAGE)) {
        let body: unknown;
        try {
          ({ body } = await context.http.json({
            method: 'GET',
            path: `${agentPath(taskId)}/runs/${encodeURIComponent(runId)}`,
          }));
        } catch (error) {
          if (!isVendorCode(error, 404)) throw error;
          events.push(goneRunNote(runId));
          continue;
        }
        const run = asRecord(body);
        const message = runMessage(run) ?? emptyRunNote(run);
        // Listed as finished, so its own read must say how it ended.
        if (!message) throw malformed(VENDOR, 'a run');
        events.push(message);
      }
      return pagingResult(events, {
        ...state,
        pending: pending.slice(RESULT_READS_PER_PAGE),
      });
    }
    const resuming = state.resume !== undefined;
    const boundary = state.resumeBefore;
    const runs: Array<Record<string, unknown>> = [];
    let next: string | undefined = state.resume;
    let resume: string | undefined;
    for (let page = 0; page < RUN_LIST_PAGES; page += 1) {
      const { body } = await context.http.json({
        method: 'GET',
        path: `${agentPath(taskId)}/runs`,
        query: { limit: PAGE_SIZE, cursor: next },
      });
      const record = asRecord(body);
      if (!Array.isArray(record.items)) throw malformed(VENDOR, 'a run list');
      const items = record.items.map((item) => asRecord(item));
      runs.push(...items);
      next = stringField(record, 'nextCursor');
      const reachedStored = items.some((run) => {
        const id = stringField(run, 'id');
        if (id === undefined || !known(`run:${id}`)) return false;
        if (!resuming) return true;
        // Resumed: only a stored run past the backlog's boundary ends it.
        const createdAt = stringField(run, 'createdAt');
        return (
          boundary !== undefined &&
          createdAt !== undefined &&
          createdAt < boundary
        );
      });
      if (!next || reachedStored) break;
      if (page === RUN_LIST_PAGES - 1) resume = next;
    }
    const finished = runs
      .filter((run) =>
        TERMINAL_RUN_STATES.has(stringField(run, 'status') ?? ''),
      )
      .filter((run) => !known(`run:${stringField(run, 'id') ?? ''}`))
      .sort((a, b) =>
        (stringField(a, 'createdAt') ?? '').localeCompare(
          stringField(b, 'createdAt') ?? '',
        ),
      );
    const pending: string[] = [];
    for (const run of finished) {
      const runId = stringField(run, 'id');
      // A list entry may leave `result` out; the run itself carries it.
      if (
        !runMessage(run) &&
        run.result === undefined &&
        runId &&
        RUN_ID.test(runId)
      ) {
        pending.push(runId);
        continue;
      }
      const message = runMessage(run) ?? emptyRunNote(run);
      if (message) events.push(message);
    }
    const oldest = runs.at(-1);
    const resumeBefore = oldest ? stringField(oldest, 'createdAt') : undefined;
    // Any deferred work (runs to read, or a backlog), and a backlog that ran
    // out, ends with one more pass from the newest run.
    const deferred = pending.length > 0 || resume !== undefined || resuming;
    return pagingResult(events, {
      pending,
      ...(resume !== undefined ? { resume } : {}),
      ...(resume !== undefined && resumeBefore ? { resumeBefore } : {}),
      ...(deferred ? { top: true } : {}),
    });
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
};
