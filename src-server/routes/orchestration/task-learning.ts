/**
 * #4003 layer 4 (Learning), the person's routes, mounted under `/api/tasks`:
 *
 * - `GET  /:taskId/room/memory/learning`: a done Task's promotion
 *   candidates, each `open`, `promoted` or `dismissed`, and the Project's
 *   knowledge stores (none, plainly, when the Project has no store).
 * - `POST /:taskId/room/memory/learning/promote`: write one candidate
 *   version, as the person edited it, into one Project store.
 * - `POST /:taskId/room/memory/learning/dismiss`: stop offering it.
 *
 * Person-only. Access is the Task room's request authority, the same as the
 * person's Task memory edits. No station-control tool names these routes, so
 * the central authority guard refuses an agent's request to them
 * (`station_control_route_unmapped`) before they run.
 */

import type { KnowledgeStoreProvider } from '@kontourai/station-contracts/knowledge-store';
import {
  TASK_LEARNING_KINDS,
  TASK_LEARNING_LIMITS,
  TASK_RECORD_KEY_PATTERN,
} from '@kontourai/station-contracts/task-memory';
import { type Context, Hono } from 'hono';
import { z } from 'zod/v3';
import {
  dismissTaskLearning,
  promoteTaskLearning,
  readTaskLearning,
  type TaskLearningAccess,
  type TaskLearningRefusal,
} from '../../services/projects/task-learning.js';
import { getBody, param, validate } from '../schemas/schemas.js';

const candidateFields = {
  kind: z.enum(TASK_LEARNING_KINDS),
  key: z.string().regex(TASK_RECORD_KEY_PATTERN).max(64),
  version: z.number().int().min(1),
};

export const taskLearningDismissSchema = z.object(candidateFields).strict();

export const taskLearningPromoteSchema = z
  .object({
    ...candidateFields,
    rootId: z.string().min(1).max(300),
    title: z.string().max(1000),
    text: z.string().max(16_000),
  })
  .strict();

interface TaskLearningRouteDeps {
  readonly store: KnowledgeStoreProvider;
  /** A person's Task-room access; refused for anyone the room refuses. */
  readonly access: (
    taskId: string,
    request: Request,
  ) => Promise<
    | ({ readonly kind: 'granted' } & TaskLearningAccess)
    | { readonly kind: 'not-found' | 'unavailable' }
  >;
}

function refusal(c: Context, refused: TaskLearningRefusal) {
  switch (refused.kind) {
    case 'not-done':
      return c.json(
        {
          success: false,
          code: 'task_learning_not_done',
          error:
            'Only a done Task offers its decisions and dead ends for promotion. Nothing was written.',
        },
        409,
      );
    case 'not-a-candidate':
      return c.json(
        {
          success: false,
          code: 'task_learning_not_a_candidate',
          error:
            'That record version is not an active, standing decision or dead end of this Task any more. Reload the candidates. Nothing was written.',
        },
        409,
      );
    case 'was-dismissed':
      return c.json(
        {
          success: false,
          code: 'task_learning_dismissed',
          error: 'That candidate was dismissed. Nothing was written.',
        },
        409,
      );
    case 'was-promoted':
      return c.json(
        {
          success: false,
          code: 'task_learning_promoted',
          error:
            'That version was already promoted, so it cannot be dismissed. Nothing was written.',
        },
        409,
      );
    case 'no-store':
      return c.json(
        {
          success: false,
          code: 'task_learning_no_store',
          error:
            "That is not one of this Project's knowledge stores. Create one in the Project's Knowledge stores. Nothing was written.",
        },
        409,
      );
    case 'invalid': {
      const limit =
        refused.field === 'title'
          ? TASK_LEARNING_LIMITS.titleChars
          : TASK_LEARNING_LIMITS.bodyChars;
      return c.json(
        {
          success: false,
          code: 'task_learning_invalid',
          error: `The ${refused.field} must be 1 to ${limit} characters. Nothing was written.`,
        },
        400,
      );
    }
    case 'stale':
      return c.json({ success: false, error: 'Task not found' }, 404);
    case 'store-failed':
      return c.json(
        {
          success: false,
          code: 'task_learning_store_failed',
          error:
            'The knowledge store did not accept the record. Nothing was promoted; try again.',
        },
        502,
      );
  }
}

function accessRefused(c: Context, kind: 'not-found' | 'unavailable') {
  return kind === 'unavailable'
    ? c.json(
        {
          success: false,
          code: 'task_memory_unavailable',
          error: 'Task memory is unavailable right now. Try again.',
        },
        503,
      )
    : c.json({ success: false, error: 'Task not found' }, 404);
}

export function createTaskLearningRoutes(deps: TaskLearningRouteDeps) {
  const app = new Hono();

  app.get('/:taskId/room/memory/learning', async (c) => {
    const access = await deps.access(param(c, 'taskId'), c.req.raw);
    if (access.kind !== 'granted') return accessRefused(c, access.kind);
    try {
      return c.json({
        success: true,
        data: await readTaskLearning(deps.store, access),
      });
    } catch {
      return accessRefused(c, 'unavailable');
    }
  });

  app.post(
    '/:taskId/room/memory/learning/promote',
    validate(taskLearningPromoteSchema),
    async (c) => {
      const access = await deps.access(param(c, 'taskId'), c.req.raw);
      if (access.kind !== 'granted') return accessRefused(c, access.kind);
      const result = await promoteTaskLearning(
        deps.store,
        access,
        getBody(c) as z.infer<typeof taskLearningPromoteSchema>,
      );
      if ('record' in result)
        return c.json(
          {
            success: true,
            data: {
              status: result.kind,
              rootId: result.rootId,
              record: result.record,
            },
          },
          result.kind === 'promoted' ? 201 : 200,
        );
      return refusal(c, result);
    },
  );

  app.post(
    '/:taskId/room/memory/learning/dismiss',
    validate(taskLearningDismissSchema),
    async (c) => {
      const access = await deps.access(param(c, 'taskId'), c.req.raw);
      if (access.kind !== 'granted') return accessRefused(c, access.kind);
      let result: ReturnType<typeof dismissTaskLearning>;
      try {
        result = dismissTaskLearning(
          access,
          getBody(c) as z.infer<typeof taskLearningDismissSchema>,
        );
      } catch {
        return accessRefused(c, 'unavailable');
      }
      if ('dismissal' in result)
        return c.json({
          success: true,
          data: { status: result.kind, dismissal: result.dismissal },
        });
      return refusal(c, result);
    },
  );

  return app;
}
