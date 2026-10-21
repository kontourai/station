/**
 * `get_task_brief`'s REST side (epic #4003), mounted under
 * `/api/orchestration`. Its own leaf, like `declare_pull_request`'s.
 *
 * Only Station's own station-control tool code calls it: a request the
 * runtime boundary did not accept as Station's internal principal gets a 404.
 * The session is the VERIFIED caller's own, as the central authority guard
 * bound it to the request, and the Task is the one that session's immutable
 * room execution binding names. Nothing in the request names either, so a
 * caller can read only its own Task's brief, and a session with no Task
 * binding is refused.
 */
import { Hono } from 'hono';
import type { StationControlDispatchScope } from '../../runtime/mcp/station-control-dispatch-scope.js';
import { stationControlRequestAuthority } from '../../security/station-control-request-authority.js';
import type { TaskBriefForSession } from '../../services/projects/task-brief-source.js';
import {
  stationControlRefusal,
  stationControlRefusalBody,
} from '../../tools/station-control-policy.js';
import { refuseOutOfScopeDispatch } from './dispatch-scope.js';

const NO_STORE = { 'Cache-Control': 'no-store' };

interface TaskBriefRoutesDeps {
  /** True only for Station's own internal principal. */
  isInternalRequest(request: Request): boolean;
  /** The scope rule's records; absent refuses every caller it constrains. */
  scope: StationControlDispatchScope | undefined;
  /** Absent: this Station composes no Task brief source. */
  readBrief?(sessionId: string): Promise<TaskBriefForSession>;
}

export function createTaskBriefRoutes(deps: TaskBriefRoutesDeps) {
  const app = new Hono();

  app.get('/station-control/task-brief', async (c) => {
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
    // Reading the caller's own Task still answers the one scope rule every
    // session-aimed call answers.
    const refused = refuseOutOfScopeDispatch(c, deps.scope, () => ({
      kind: 'thread',
      threadId: sessionId,
      remote: false,
    }));
    if (refused) return refused;
    if (!deps.readBrief)
      return c.json(
        {
          success: false,
          code: 'task_brief_unavailable',
          error: 'Task briefs are unavailable on this Station.',
        },
        409,
        NO_STORE,
      );
    const outcome = await deps.readBrief(sessionId);
    if (outcome.kind === 'unbound')
      return c.json(
        {
          success: false,
          code: 'no_task_binding',
          error:
            'This session was not dispatched for a Task, so it has no Task brief.',
        },
        409,
        NO_STORE,
      );
    if (outcome.kind === 'unavailable')
      return c.json(
        {
          success: false,
          code: 'task_brief_unavailable',
          error: outcome.reason,
        },
        409,
        NO_STORE,
      );
    return c.json({ success: true, data: outcome.brief }, 200, NO_STORE);
  });

  return app;
}
