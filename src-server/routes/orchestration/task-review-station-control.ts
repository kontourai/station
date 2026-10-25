import {
  deriveThreadView,
  parseTaskThreadListRequest,
  parseTaskThreadReplyRequest,
  parseTaskThreadResolveRequest,
  type TaskReviewCounts,
  type TaskReviewEvidence,
  type TaskReviewEvidenceInput,
  type TaskReviewFilter,
  type TaskReviewResponse,
  type TaskReviewThread,
  type TaskReviewThreadView,
} from '@kontourai/station-contracts/task-review';
import { type Context, Hono } from 'hono';
import type { StationControlDispatchScope } from '../../runtime/mcp/station-control-dispatch-scope.js';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import { stationControlRequestAuthority } from '../../security/station-control-request-authority.js';
import type {
  ProjectTaskRoomRuntime,
  TaskReviewAccess,
} from '../../services/orchestration/project-task-room-runtime.js';
import type { TaskReviewStore } from '../../services/orchestration/task-review-store.js';
import {
  stationControlRefusal,
  stationControlRefusalBody,
} from '../../tools/station-control-policy.js';
import { refuseOutOfScopeDispatch } from './dispatch-scope.js';

const NO_STORE = { 'Cache-Control': 'no-store' };
type Granted = TaskReviewAccess;

export function createTaskReviewStationControlRoutes(deps: {
  isInternalRequest(request: Request): boolean;
  scope: StationControlDispatchScope | undefined;
  readonly runtime: ProjectTaskRoomRuntime | undefined;
  readonly store: TaskReviewStore | undefined;
  readThreads(
    access: Granted,
    request: Request,
    state?: TaskReviewFilter,
  ): Promise<{
    threads: readonly TaskReviewThreadView[];
    counts: TaskReviewCounts;
  }>;
  verifyEvidence(
    access: Granted,
    evidence: TaskReviewEvidenceInput,
  ): Promise<TaskReviewEvidence>;
  logger: { warn(message: string, meta?: Record<string, unknown>): void };
}) {
  const app = new Hono();
  const respond = (c: Context, result: TaskReviewResponse<unknown>) =>
    c.json(
      result,
      result.success
        ? 200
        : result.code === 'not-found'
          ? 404
          : result.code === 'no_task_binding' || result.code === 'forbidden'
            ? 403
            : result.code === 'unavailable'
              ? 503
              : result.code === 'invalid-request'
                ? 400
                : 409,
      NO_STORE,
    );
  const access = async (c: Context): Promise<Granted | Response> => {
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
    const scope = refuseOutOfScopeDispatch(c, deps.scope, () => ({
      kind: 'thread',
      threadId: sessionId,
      remote: false,
    }));
    if (scope) return scope;
    const result = await deps.runtime?.sessionTaskReviewAccess(sessionId);
    if (!result || result.kind === 'unavailable' || !deps.store)
      return respond(c, {
        success: false,
        code: 'unavailable',
        error: 'Task review is unavailable.',
      });
    if (result.kind !== 'granted')
      return respond(c, {
        success: false,
        code: 'no_task_binding',
        error: 'This session is not the lead of a bound Task.',
      });
    return result;
  };
  const view = (thread: TaskReviewThread) =>
    deriveThreadView(thread, { status: 'unavailable' });
  app.get('/station-control/task-threads', async (c) => {
    const granted = await access(c);
    if (granted instanceof Response) return granted;
    const parsed = parseTaskThreadListRequest(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );
    if (!parsed)
      return respond(c, {
        success: false,
        code: 'invalid-request',
        error: 'Invalid thread filter.',
      });
    let projection: Awaited<ReturnType<typeof deps.readThreads>>;
    try {
      projection = await deps.readThreads(granted, c.req.raw, parsed.state);
    } catch (error) {
      deps.logger.warn('Task review agent list unavailable', {
        errorName: error instanceof Error ? error.name : typeof error,
      });
      return respond(c, {
        success: false,
        code: 'unavailable',
        error: 'Task review is unavailable.',
      });
    }
    if (!granted.write.beforeCommit())
      return respond(c, {
        success: false,
        code: 'no_task_binding',
        error: 'The Task binding changed.',
      });
    return respond(c, {
      success: true,
      data: {
        taskId: granted.write.taskId,
        taskCreatedAt: granted.write.taskCreatedAt,
        threads: projection.threads,
        counts: projection.counts,
      },
    });
  });
  for (const action of ['reply', 'resolve'] as const) {
    app.post(`/station-control/task-thread-${action}`, async (c) => {
      const granted = await access(c);
      if (granted instanceof Response) return granted;
      const read = await readBoundedRequestBody(c.req.raw, 64 * 1024);
      let json: unknown;
      try {
        json = read.status === 'ok' ? JSON.parse(read.body) : undefined;
      } catch {
        json = undefined;
      }
      const parsed =
        action === 'reply'
          ? parseTaskThreadReplyRequest(json)
          : parseTaskThreadResolveRequest(json);
      if (!parsed)
        return respond(c, {
          success: false,
          code: 'invalid-request',
          error: 'Invalid Task thread write.',
        });
      const thread = deps.store!.readThreadById(parsed.threadId);
      if (!thread)
        return respond(c, {
          success: false,
          code: 'not-found',
          error: 'Review thread not found.',
        });
      try {
        const evidence =
          'evidence' in parsed && parsed.evidence
            ? await deps.verifyEvidence(granted, parsed.evidence)
            : undefined;
        const result = deps.store!.appendEvent({
          ...granted.write,
          taskId: thread.taskId,
          taskCreatedAt: thread.taskCreatedAt,
          projectId: thread.projectId,
          // This custody check runs inside BEGIN IMMEDIATE, including after evidence I/O.
          beforeCommit: () =>
            granted.write.beforeCommit() &&
            thread.taskId === granted.write.taskId &&
            thread.taskCreatedAt === granted.write.taskCreatedAt &&
            thread.projectId === granted.write.projectId,
          threadId: thread.threadId,
          event:
            'body' in parsed
              ? {
                  kind: 'agent-reply',
                  deliveryKey: parsed.deliveryKey,
                  body: parsed.body,
                  operationId: parsed.operationId,
                  ...(evidence ? { evidence } : {}),
                }
              : {
                  kind: 'resolved',
                  reason: parsed.reason,
                  operationId: parsed.operationId,
                },
        });
        return respond(
          c,
          result.success
            ? { success: true, data: { thread: view(result.data) } }
            : result,
        );
      } catch (error) {
        deps.logger.warn('task review agent write unavailable', {
          errorName: error instanceof Error ? error.name : typeof error,
        });
        return respond(c, {
          success: false,
          code: 'unavailable',
          error: 'Task review is unavailable.',
        });
      }
    });
  }
  return app;
}
