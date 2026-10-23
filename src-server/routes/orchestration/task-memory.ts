/**
 * The REST side of `task_summary_update` and `task_record` (#4003), mounted
 * under `/api/orchestration`. The outcome wording is shared with the
 * person's Task workspace routes (`task-memory-http.ts`).
 *
 * Only Station's own station-control tool code calls these routes: a request
 * the runtime boundary did not accept as Station's internal principal gets a
 * 404. The Session is the VERIFIED caller's own, as the central authority
 * guard bound it to the request. The body never names a Task: the room
 * runtime derives it from that Session's immutable room execution binding.
 *
 * Every bound is a refusal with a sentence that says what to do next; nothing
 * is cut. Nothing here reaches Task status or the Task document.
 */
import {
  TASK_MEMORY_LIMITS,
  type TaskRecordWrite,
} from '@kontourai/station-contracts/task-memory';
import { type Context, Hono } from 'hono';
import type { StationControlDispatchScope } from '../../runtime/mcp/station-control-dispatch-scope.js';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import { stationControlRequestAuthority } from '../../security/station-control-request-authority.js';
import type {
  TaskRecordWriteOutcome,
  TaskSummaryUpdateOutcome,
} from '../../services/orchestration/task-memory-store.js';
import {
  stationControlRefusal,
  stationControlRefusalBody,
} from '../../tools/station-control-policy.js';
import { refuseOutOfScopeDispatch } from './dispatch-scope.js';
import {
  accessRefused,
  TASK_MEMORY_MAX_BODY_BYTES,
  type TaskMemoryResponse,
  taskRecordResponse,
  taskRecordWriteSchema,
  taskSummaryResponse,
  taskSummaryUpdateSchema,
} from './task-memory-http.js';

const NO_STORE = { 'Cache-Control': 'no-store' };

interface TaskMemoryRoutesDeps {
  /** True only for Station's own internal principal. */
  isInternalRequest(request: Request): boolean;
  /** The scope rule's records; absent refuses every caller it constrains. */
  scope: StationControlDispatchScope | undefined;
  /** Absent when the personal Task room is not composed (hosted). */
  updateSummary:
    | ((input: {
        sessionId: string;
        text: string;
        baseRevision: number;
      }) => Promise<TaskSummaryUpdateOutcome>)
    | undefined;
  writeRecord:
    | ((input: {
        sessionId: string;
        write: TaskRecordWrite;
      }) => Promise<TaskRecordWriteOutcome>)
    | undefined;
}

export function createTaskMemoryRoutes(deps: TaskMemoryRoutesDeps) {
  const app = new Hono();

  /** The verified caller's own Session, held to the one scope rule. */
  const callerSession = (c: Context): string | Response => {
    if (!deps.isInternalRequest(c.req.raw))
      return c.json({ error: { code: 'not_found' } }, 404, NO_STORE);
    const authority = stationControlRequestAuthority(c.req.raw);
    if (authority?.kind !== 'caller')
      return c.json(
        stationControlRefusalBody(
          stationControlRefusal('station_control_caller_required'),
        ),
        403,
        NO_STORE,
      );
    const sessionId = authority.caller.sessionId;
    // The write changes only the caller's own Task, but it still answers the
    // one scope rule every session-aimed call answers.
    const refusedScope = refuseOutOfScopeDispatch(c, deps.scope, () => ({
      kind: 'thread',
      threadId: sessionId,
      remote: false,
    }));
    return refusedScope ?? sessionId;
  };

  const readJson = async (c: Context): Promise<unknown | Response> => {
    const read = await readBoundedRequestBody(
      c.req.raw,
      TASK_MEMORY_MAX_BODY_BYTES,
    );
    if (read.status === 'too-large')
      return c.json(
        {
          success: false,
          code: 'task_memory_body_too_large',
          error: `The request is over ${TASK_MEMORY_MAX_BODY_BYTES} bytes, far past the ${TASK_MEMORY_LIMITS.summaryChars}-character summary limit. Nothing was written.`,
        },
        413,
        NO_STORE,
      );
    try {
      return read.status === 'ok' ? JSON.parse(read.body) : undefined;
    } catch {
      return undefined;
    }
  };

  const send = (c: Context, response: TaskMemoryResponse) =>
    c.json(response.body, response.status, NO_STORE);

  app.post('/station-control/task-summary', async (c) => {
    const sessionId = callerSession(c);
    if (sessionId instanceof Response) return sessionId;
    const body = await readJson(c);
    if (body instanceof Response) return body;
    const parsed = taskSummaryUpdateSchema.safeParse(body);
    if (!parsed.success)
      return c.json(
        {
          success: false,
          code: 'task_summary_invalid',
          error:
            'task_summary_update needs text (the whole summary) and baseRevision (the revision you read; 0 for none).',
        },
        400,
        NO_STORE,
      );
    if (!deps.updateSummary) return send(c, accessRefused('unavailable'));
    return send(
      c,
      taskSummaryResponse(
        await deps.updateSummary({ sessionId, ...parsed.data }),
      ),
    );
  });

  app.post('/station-control/task-record', async (c) => {
    const sessionId = callerSession(c);
    if (sessionId instanceof Response) return sessionId;
    const body = await readJson(c);
    if (body instanceof Response) return body;
    const parsed = taskRecordWriteSchema.safeParse(body);
    if (!parsed.success)
      return c.json(
        {
          success: false,
          code: 'task_record_invalid',
          error:
            'task_record needs kind ("decision", "question" or "dead_end") and key, with text for set and answer and reason for retire. importance is "standing" or "on_topic"; action is "set", "answer" or "retire".',
        },
        400,
        NO_STORE,
      );
    if (!deps.writeRecord) return send(c, accessRefused('unavailable'));
    return send(
      c,
      taskRecordResponse(
        await deps.writeRecord({ sessionId, write: parsed.data }),
      ),
    );
  });

  return app;
}
