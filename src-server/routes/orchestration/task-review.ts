import {
  parseTaskReviewCreateThreadRequest,
  parseTaskReviewListRequest,
  parseTaskReviewReopenRequest,
  parseTaskReviewReplyRequest,
  parseTaskReviewResolveRequest,
  parseTaskReviewSendRequest,
} from '@kontourai/station-contracts/task-review';
import { type Context, Hono } from 'hono';
import { z } from 'zod/v3';
import type { ProjectTaskRoomRuntime } from '../../services/orchestration/project-task-room-runtime.js';
import type { TaskReviewSend } from '../../services/orchestration/task-review-send.js';
import {
  TaskReviewError,
  type TaskReviewModule,
} from '../../services/projects/task-review-module.js';
import { getBody, param, validate } from '../schemas/schemas.js';

function requestSchema<T>(parse: (value: unknown) => T | null) {
  return z.unknown().transform((value, context) => {
    const parsed = parse(value);
    if (parsed !== null) return parsed;
    context.addIssue({
      code: 'custom',
      message: 'Invalid Task review request.',
    });
    return z.NEVER;
  });
}
const create = requestSchema(parseTaskReviewCreateThreadRequest);
const reply = requestSchema(parseTaskReviewReplyRequest);
const resolve = requestSchema(parseTaskReviewResolveRequest);
const reopen = requestSchema(parseTaskReviewReopenRequest);
const send = requestSchema(parseTaskReviewSendRequest);

export function createTaskReviewRoutes(deps: {
  runtime: ProjectTaskRoomRuntime;
  module: TaskReviewModule;
  send: TaskReviewSend;
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
              : error.code === 'invalid-request' ||
                  error.code === 'invalid-event'
                ? 400
                : 409;
        return c.json(error.response, status);
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
      const parsed = parseTaskReviewListRequest(c.req.query());
      if (!parsed)
        throw new TaskReviewError(
          'invalid-request',
          'State must be open, outdated or resolved.',
        );
      const { state } = parsed;
      return deps.module.read(access, c.req.raw, state);
    }),
  );
  app.get('/:taskId/review/items/:kind/:id', (c) =>
    run(c, (access) => {
      const kind = param(c, 'kind');
      if (!['plan', 'summary', 'output', 'answer', 'capture'].includes(kind))
        throw new TaskReviewError(
          'invalid-request',
          'Invalid review item kind.',
        );
      return deps.module.readItem(access, c.req.raw, kind, param(c, 'id'));
    }),
  );
  app.get('/:taskId/review/threads/:threadId', (c) =>
    run(c, async (access) => ({
      thread: await deps.module.readThread(
        access,
        c.req.raw,
        param(c, 'threadId'),
      ),
    })),
  );
  app.post(
    '/:taskId/review/send',
    validate(send, {
      maxBodyBytes: 512 * 1024,
      refusal: () => ({
        code: 'invalid-request',
        error: 'Invalid review send.',
      }),
    }),
    (c) =>
      run(c, async (access) => {
        const input = getBody(c) as z.infer<typeof send>;
        const result = await deps.send.send(access.write, input);
        if (!result.success)
          throw new TaskReviewError(result.code, result.error);
        return result.data;
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
      validate(action === 'resolve' ? resolve : reopen, {
        maxBodyBytes: 8 * 1024,
        refusal: () => ({
          code: 'invalid-request',
          error: 'Invalid review transition.',
        }),
      }),
      (c) =>
        run(c, async (access) => {
          const body = getBody(c) as z.infer<typeof resolve>;
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
