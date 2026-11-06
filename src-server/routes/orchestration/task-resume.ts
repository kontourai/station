/**
 * #4554: resume an ended Task (owner-approved option B, 2026-11-06).
 *
 * `POST /api/tasks/:taskId/resume` moves a tracker-backed `done` Task back to
 * `ready` for the Station operator in person; `GET` answers what the
 * confirmation shows. Both answer `task_resume_unavailable` (404) unless the
 * `task-resume` Feature Preview is on, and neither is mounted in hosted mode.
 *
 * Authority is the composition's, read per request:
 * - `inPersonPrincipal` is the operator in person and not a request that may
 *   be an agent's (`isOperatorInPersonNotAgent`), whatever tier the
 *   credential holds. No Station Control tool names this route, so the
 *   central authority guard refuses an agent's request before it gets here;
 *   this check holds for a direct HTTP request too.
 * - `authorizeTask` is the current Task read and execution authority,
 *   evaluated by the service under its store lock immediately before the
 *   write or any replay disclosure.
 *
 * Retained GitHub follow-ups are returned as quoted data with their recorded
 * author class; nothing from GitHub fills the reason or any instruction, and
 * an observation may be stale or absent (polling off, failing or backing
 * off): the list does not establish freshness.
 */

import type { ClientOrigin } from '@kontourai/station-contracts/client-origin';
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import {
  isTaskResumeSupported,
  TASK_RESUME_REFUSAL_CODES,
  type TaskResumeRefusalCode,
  type TaskResumeRequest,
  taskResumeDeadline,
  taskResumeRefusal,
  taskResumeRefusalText,
  validateTaskResumeRequest,
} from '@kontourai/station-contracts/task-resume';
import { type Context, Hono } from 'hono';
import {
  type TaskGraphService,
  TaskResumeRefusedError,
} from '../../services/projects/task-graph-service.js';
import type { TaskFollowUpObservation } from '../../services/work-item-providers/task-follow-up-store.js';

/** Follow-ups the confirmation lists; the rest are counted. */
const FOLLOW_UPS_SHOWN = 20;
const PASSING_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

export interface TaskResumeRouteDeps {
  service: TaskGraphService;
  /** The `task-resume` preview's live choice. */
  enabled(): boolean;
  /**
   * The authenticated principal id when the request is the operator in
   * person, not an agent, with a current principal; otherwise undefined.
   */
  inPersonPrincipal(request: Request): string | undefined;
  /** Current Task read + execution + dispatch-route authority. Synchronous. */
  authorizeTask(
    request: Request,
    principalId: string,
    task: TaskRecord,
  ): boolean;
  isTaskSessionTurnActive(sessionIds: readonly string[]): boolean;
  leadOwnerOf(sessionId: string): string | undefined;
  /** The Task's retained observations, newest first; undefined: none kept. */
  followUps(task: TaskRecord): readonly TaskFollowUpObservation[] | undefined;
  clientOrigin(request: Request): ClientOrigin | undefined;
  logger?: { warn(message: string, meta?: Record<string, unknown>): void };
}

const STATUS: Record<TaskResumeRefusalCode, 403 | 404 | 409 | 503> = {
  task_resume_unavailable: 404,
  task_resume_not_permitted: 403,
  task_resume_not_supported: 409,
  task_resume_not_ended: 409,
  task_resume_canceled: 409,
  task_resume_end_unknown: 409,
  task_resume_expired: 409,
  task_resume_conflict: 409,
  task_resume_work_item_taken: 409,
  task_resume_dispatch_reserved: 409,
  task_resume_turn_running: 409,
  task_resume_limit: 409,
};

function refuse(
  c: Context,
  code: TaskResumeRefusalCode,
  extra: Record<string, unknown> = {},
  status: 403 | 404 | 409 | 503 = STATUS[code],
) {
  c.header('Cache-Control', 'private, no-store');
  return c.json(
    { success: false, code, error: taskResumeRefusalText(code), ...extra },
    status,
  );
}

/** One follow-up as the confirmation shows it: checked values, then data. */
function followUpView(item: TaskFollowUpObservation) {
  return {
    kind: item.kind,
    itemRef: item.itemRef,
    author: item.author,
    actorClass: item.actorClass,
    ...(item.association ? { association: item.association } : {}),
    occurredAt: item.occurredAt,
    recordedAt: item.recordedAt,
    ...(item.url ? { url: item.url } : {}),
    ...(item.conclusion ? { conclusion: item.conclusion } : {}),
    ...(item.reviewState ? { reviewState: item.reviewState } : {}),
    ...(item.checkName ? { checkName: item.checkName } : {}),
    excerpt: item.excerpt,
    truncated: item.truncated,
  };
}

export function createTaskResumeRoutes(deps: TaskResumeRouteDeps) {
  const app = new Hono();

  app.get('/:taskId/resume', (c) => {
    if (!deps.enabled()) return refuse(c, 'task_resume_unavailable');
    const principalId = deps.inPersonPrincipal(c.req.raw);
    let task: TaskRecord | null;
    try {
      task = deps.service.readTaskView(c.req.param('taskId'));
    } catch {
      return refuse(c, 'task_resume_unavailable', {}, 503);
    }
    if (
      !principalId ||
      !task ||
      !deps.authorizeTask(c.req.raw, principalId, task)
    )
      return refuse(c, 'task_resume_not_permitted');
    let followUps: readonly TaskFollowUpObservation[] = [];
    let followUpsReadable = true;
    try {
      followUps = (deps.followUps(task) ?? []).filter(
        (item) =>
          task.endedAt !== undefined &&
          item.occurredAt >= task.endedAt &&
          !(
            item.kind === 'check_run' &&
            PASSING_CONCLUSIONS.has(item.conclusion ?? '')
          ),
      );
    } catch (error) {
      followUpsReadable = false;
      deps.logger?.warn('Task resume follow-ups could not be read', {
        taskId: task.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const shown = followUps.slice(0, FOLLOW_UPS_SHOWN);
    const seenThrough = shown.reduce<string | undefined>(
      (latest, item) =>
        !latest || item.recordedAt > latest ? item.recordedAt : latest,
      undefined,
    );
    const refusal = taskResumeRefusal(task);
    c.header('Cache-Control', 'private, no-store');
    return c.json({
      success: true,
      data: {
        taskId: task.id,
        taskCreatedAt: task.createdAt,
        status: task.status,
        ...(task.endedAt ? { endedAt: task.endedAt } : {}),
        ...(taskResumeDeadline(task)
          ? { deadline: taskResumeDeadline(task) }
          : {}),
        supported: isTaskResumeSupported(task),
        ...(refusal ? { refusal } : {}),
        resumes: task.resumes?.length ?? 0,
        ...(task.sessionId
          ? {
              previousLead: {
                sessionId: task.sessionId,
                ...(deps.leadOwnerOf(task.sessionId)
                  ? { owner: deps.leadOwnerOf(task.sessionId) }
                  : {}),
              },
            }
          : {}),
        followUps: {
          state: followUpsReadable ? 'read' : 'unavailable',
          items: shown.map(followUpView),
          total: followUps.length,
          ...(seenThrough ? { seenThrough } : {}),
        },
      },
    });
  });

  app.post('/:taskId/resume', async (c) => {
    if (!deps.enabled()) return refuse(c, 'task_resume_unavailable');
    const principalId = deps.inPersonPrincipal(c.req.raw);
    if (!principalId) return refuse(c, 'task_resume_not_permitted');
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = undefined;
    }
    const problems = validateTaskResumeRequest(body);
    if (problems.length)
      return c.json(
        {
          success: false,
          error: `Invalid resume request: ${problems.join('; ')}`,
        },
        400,
      );
    const request = body as TaskResumeRequest;
    try {
      const clientOrigin = deps.clientOrigin(c.req.raw);
      const data = await deps.service.resumeTask({
        taskId: c.req.param('taskId'),
        request,
        principalId,
        ...(clientOrigin ? { clientOrigin } : {}),
        authorize: (task) => deps.authorizeTask(c.req.raw, principalId, task),
        isTaskSessionTurnActive: (ids) => deps.isTaskSessionTurnActive(ids),
        leadOwnerOf: (sessionId) => deps.leadOwnerOf(sessionId),
      });
      c.header('Cache-Control', 'private, no-store');
      return c.json({ success: true, data });
    } catch (error) {
      if (
        error instanceof TaskResumeRefusedError &&
        (TASK_RESUME_REFUSAL_CODES as readonly string[]).includes(error.code)
      )
        return refuse(
          c,
          error.code,
          error.existing ? { details: { existingTask: error.existing } } : {},
        );
      deps.logger?.warn('Task resume could not be completed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return refuse(c, 'task_resume_unavailable', {}, 503);
    }
  });

  return app;
}
