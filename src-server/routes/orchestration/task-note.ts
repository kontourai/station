/**
 * `task_note`'s REST side (#4003), mounted under `/api/orchestration`.
 *
 * Only Station's own station-control tool code calls it: a request the
 * runtime boundary did not accept as Station's internal principal gets a 404.
 * The Session is the VERIFIED caller's own, as the central authority guard
 * bound it to the request. The body names only the section and the text,
 * never a Task: the room runtime derives the Task from that Session's
 * immutable room execution binding.
 *
 * Text over `TASK_NOTE_MAX_TEXT_LENGTH` is refused, never cut. Nothing here
 * reaches Task status.
 */
import { Hono } from 'hono';
import { z } from 'zod/v3';
import {
  TASK_NOTE_MAX_TEXT_LENGTH,
  TASK_NOTE_SECTIONS,
  type TaskNoteSection,
  type TaskNoteTextRefusal,
} from '../../domain/task-memory.js';
import type { StationControlDispatchScope } from '../../runtime/mcp/station-control-dispatch-scope.js';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import { stationControlRequestAuthority } from '../../security/station-control-request-authority.js';
import type { TaskNoteOutcome } from '../../services/orchestration/project-task-room-runtime.js';
import {
  stationControlRefusal,
  stationControlRefusalBody,
} from '../../tools/station-control-policy.js';
import { refuseOutOfScopeDispatch } from './dispatch-scope.js';

/** Room for the longest text with every character JSON-escaped. */
const MAX_BODY_BYTES = 32 * 1024;
const NO_STORE = { 'Cache-Control': 'no-store' };

const taskNoteSchema = z
  .object({
    section: z.enum(
      TASK_NOTE_SECTIONS as [TaskNoteSection, ...TaskNoteSection[]],
    ),
    text: z.string(),
  })
  .strict();

function refusalCopy(refusal: TaskNoteTextRefusal): string {
  if (refusal.kind === 'empty') return 'The note text is empty.';
  if (refusal.kind === 'multiline')
    return 'A note is one line. Record each point as its own note.';
  return `The note text is ${refusal.length} characters; the limit is ${refusal.limit}. Nothing was recorded: shorten it or split it into several notes.`;
}

interface TaskNoteRoutesDeps {
  /** True only for Station's own internal principal. */
  isInternalRequest(request: Request): boolean;
  /** The scope rule's records; absent refuses every caller it constrains. */
  scope: StationControlDispatchScope | undefined;
  /** Absent when the personal Task room is not composed (hosted). */
  appendTaskNote:
    | ((input: {
        sessionId: string;
        section: TaskNoteSection;
        text: string;
      }) => Promise<TaskNoteOutcome>)
    | undefined;
}

export function createTaskNoteRoutes(deps: TaskNoteRoutesDeps) {
  const app = new Hono();

  app.post('/station-control/task-note', async (c) => {
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
    // The note changes only the caller's own Task, but it still answers the
    // one scope rule every session-aimed call answers.
    const refused = refuseOutOfScopeDispatch(c, deps.scope, () => ({
      kind: 'thread',
      threadId: sessionId,
      remote: false,
    }));
    if (refused) return refused;

    const read = await readBoundedRequestBody(c.req.raw, MAX_BODY_BYTES);
    if (read.status === 'too-large')
      return c.json(
        {
          success: false,
          error: `The note is over the ${TASK_NOTE_MAX_TEXT_LENGTH}-character limit. Nothing was recorded.`,
        },
        413,
        NO_STORE,
      );
    let body: unknown;
    try {
      body = read.status === 'ok' ? JSON.parse(read.body) : undefined;
    } catch {
      body = undefined;
    }
    const parsed = taskNoteSchema.safeParse(body);
    if (!parsed.success)
      return c.json(
        {
          success: false,
          error: `task_note needs section ("${TASK_NOTE_SECTIONS.join('", "')}") and text.`,
        },
        400,
        NO_STORE,
      );
    if (!deps.appendTaskNote)
      return c.json(
        {
          success: false,
          error: 'Task notes are unavailable on this Station.',
        },
        503,
        NO_STORE,
      );
    const outcome = await deps.appendTaskNote({
      sessionId,
      section: parsed.data.section,
      text: parsed.data.text,
    });
    switch (outcome.kind) {
      case 'recorded':
        return c.json(
          {
            status: 'recorded',
            taskId: outcome.taskId,
            section: outcome.section,
            replaced: outcome.replaced,
            entry: outcome.entry,
            revision: outcome.revision,
          },
          200,
          NO_STORE,
        );
      case 'document-full':
        return c.json(
          {
            success: false,
            error:
              'The Task document is at its size limit, so nothing was recorded. Ask a person to trim the document; retrying will not help.',
          },
          409,
          NO_STORE,
        );
      case 'no-task':
      case 'not-found':
        return c.json(
          {
            success: false,
            error:
              'This session is not working on a Task, so there is no Task to note on.',
          },
          409,
          NO_STORE,
        );
      case 'refused':
        return 'refusal' in outcome
          ? c.json(
              { success: false, error: refusalCopy(outcome.refusal) },
              400,
              NO_STORE,
            )
          : c.json(
              {
                success: false,
                error:
                  'The Task document refused the note. Nothing was recorded.',
              },
              409,
              NO_STORE,
            );
      default:
        return c.json(
          {
            success: false,
            error:
              'The Task document is unavailable right now. Nothing was recorded; try again.',
          },
          503,
          NO_STORE,
        );
    }
  });

  return app;
}
