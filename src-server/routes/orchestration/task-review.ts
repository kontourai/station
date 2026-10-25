import {
  TASK_REVIEW_LIMITS as LIMITS,
  parseTaskReviewAnchor,
  type TaskReviewAnchor,
} from '@kontourai/station-contracts/task-review';
import { type Context, Hono } from 'hono';
import { z } from 'zod/v3';
import type { ProjectTaskRoomRuntime } from '../../services/orchestration/project-task-room-runtime.js';
import {
  TaskReviewError,
  type TaskReviewModule,
} from '../../services/projects/task-review-module.js';
import { getBody, param, validate } from '../schemas/schemas.js';

const operation = { operationId: z.string().min(1).max(256) };
const create = z
  .object({
    ...operation,
    artifact: z
      .object({
        kind: z.enum(['plan', 'summary', 'output', 'answer', 'capture']),
        id: z.string().min(1).max(LIMITS.artifactIdChars),
        revision: z.string().min(1).max(LIMITS.artifactRevisionChars),
        digest: z
          .string()
          .regex(/^sha256:[a-f0-9]{64}$/)
          .transform((value) => value as `sha256:${string}`),
      })
      .strict(),
    anchor: z.custom<TaskReviewAnchor>(
      (value) => parseTaskReviewAnchor(value) !== null,
    ),
    body: z.string().min(1).max(LIMITS.bodyChars),
  })
  .strict();
const reply = z
  .object({ ...operation, body: z.string().min(1).max(LIMITS.bodyChars) })
  .strict();
const transition = z
  .object({
    ...operation,
    reason: z.string().min(1).max(LIMITS.reasonChars).optional(),
  })
  .strict();

export function createTaskReviewRoutes(deps: {
  runtime: ProjectTaskRoomRuntime;
  module: TaskReviewModule;
  logger: { warn(message: string, meta?: Record<string, unknown>): void };
}) {
  const app = new Hono();
  const run = async (
    c: Context,
    action: (
      access: Extract<
        Awaited<ReturnType<ProjectTaskRoomRuntime['personTaskReviewAccess']>>,
        { kind: 'granted' }
      >,
    ) => Promise<unknown>,
  ) => {
    c.header('Cache-Control', 'no-store');
    try {
      const access = await deps.runtime.personTaskReviewAccess({
        taskId: param(c, 'taskId'),
        request: c.req.raw,
      });
      if (access.kind !== 'granted')
        throw new TaskReviewError(
          access.kind,
          access.kind === 'not-found'
            ? 'Task not found.'
            : 'Task review is unavailable.',
        );
      return c.json({ success: true, data: await action(access) });
    } catch (error) {
      if (error instanceof TaskReviewError) {
        const status =
          error.code === 'not-found'
            ? 404
            : error.code === 'unavailable' ||
                error.code === 'artifact-unavailable'
              ? 503
              : error.code === 'invalid-request'
                ? 400
                : 409;
        return c.json(
          { success: false, code: error.code, error: error.message },
          status,
        );
      }
      deps.logger.warn('task review request failed', {
        taskId: param(c, 'taskId'),
        errorName: error instanceof Error ? error.name : typeof error,
      });
      return c.json(
        {
          success: false,
          code: 'unavailable',
          error: 'Task review is unavailable.',
        },
        503,
      );
    }
  };
  app.get('/:taskId/review', (c) =>
    run(c, async (access) => {
      const state = c.req.query('state');
      if (
        state !== undefined &&
        state !== 'open' &&
        state !== 'outdated' &&
        state !== 'resolved'
      )
        throw new TaskReviewError(
          'invalid-request',
          'State must be open, outdated or resolved.',
        );
      return deps.module.read(access, c.req.raw, state);
    }),
  );
  app.post(
    '/:taskId/review/threads',
    validate(create, {
      maxBodyBytes: 64 * 1024,
      refusal: () => ({
        code: 'invalid-request',
        error: 'Invalid review thread.',
      }),
    }),
    (c) =>
      run(c, async (access) => ({
        thread: await deps.module.create(
          access,
          c.req.raw,
          getBody(c) as z.infer<typeof create>,
        ),
      })),
  );
  app.post(
    '/:taskId/review/threads/:threadId/replies',
    validate(reply, {
      maxBodyBytes: 32 * 1024,
      refusal: () => ({
        code: 'invalid-request',
        error: 'Invalid review reply.',
      }),
    }),
    (c) =>
      run(c, async (access) => ({
        thread: await deps.module.append(
          access,
          c.req.raw,
          param(c, 'threadId'),
          { kind: 'reply', ...(getBody(c) as z.infer<typeof reply>) },
        ),
      })),
  );
  for (const action of ['resolve', 'reopen'] as const) {
    app.post(
      `/:taskId/review/threads/:threadId/${action}`,
      validate(transition, {
        maxBodyBytes: 8 * 1024,
        refusal: () => ({
          code: 'invalid-request',
          error: 'Invalid review transition.',
        }),
      }),
      (c) =>
        run(c, async (access) => {
          const body = getBody(c) as z.infer<typeof transition>;
          const event =
            action === 'resolve'
              ? {
                  ...body,
                  kind: 'resolved' as const,
                  reason: body.reason ?? 'Resolved by person.',
                }
              : { ...body, kind: 'reopened' as const };
          return {
            thread: await deps.module.append(
              access,
              c.req.raw,
              param(c, 'threadId'),
              event,
            ),
          };
        }),
    );
  }
  return app;
}
