import { type Context, Hono } from 'hono';
import { z } from 'zod/v3';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import { ReviewRequestConflictError } from '../../services/evidence/review-evidence-module.js';
import {
  TaskCodeReviewError,
  type TaskCodeReviewModule,
  type TaskCodeReviewScope,
} from '../../services/evidence/task-code-review-module.js';

const submission = z
  .object({
    requestId: z.string().min(1).max(160),
    projectId: z.string().min(1).max(160),
    projectCreatedAt: z.string().min(1).max(64),
    taskCreatedAt: z.string().min(1).max(64),
    baseSha: z.string().regex(/^[0-9a-f]{40}$/),
    headSha: z.string().regex(/^[0-9a-f]{40}$/),
    reviewerAgentSlug: z.string().min(1).max(160),
  })
  .strict();

export function createTaskCodeReviewRoutes(deps: {
  module: TaskCodeReviewModule;
  authorize(
    c: Context,
    taskId: string,
    execute: boolean,
  ): Promise<TaskCodeReviewScope | undefined>;
  reportError(error: unknown): void;
}) {
  const app = new Hono();
  const run = async (c: Context, execute: boolean) => {
    c.header('Cache-Control', 'no-store');
    try {
      const scope = await deps.authorize(
        c,
        c.req.param('taskId') ?? '',
        execute,
      );
      if (!scope)
        return c.json(
          {
            success: false,
            error: 'Task review is unavailable.',
            code: 'forbidden',
          },
          403,
        );
      if (execute) {
        const body = await readBoundedRequestBody(c.req.raw, 16 * 1024);
        if (body.status !== 'ok')
          return c.json(
            {
              success: false,
              error: 'Invalid review request body.',
              code: 'invalid-request',
            },
            body.status === 'too-large' ? 413 : 400,
          );
        let input: unknown;
        try {
          input = JSON.parse(body.body);
        } catch {
          return c.json(
            {
              success: false,
              error: 'Invalid review request JSON.',
              code: 'invalid-request',
            },
            400,
          );
        }
        const parsed = submission.safeParse(input);
        if (!parsed.success)
          return c.json(
            {
              success: false,
              error: 'Invalid review request.',
              code: 'invalid-request',
            },
            400,
          );
        return c.json({
          success: true,
          data: await deps.module.run(scope, parsed.data),
        });
      }
      const projectId = c.req.query('projectId');
      if (projectId !== undefined && projectId !== scope.project.id)
        throw new TaskCodeReviewError(
          'project-changed',
          'The Project changed. Reopen this Task before requesting review.',
        );
      if (c.req.query('taskCreatedAt') !== scope.task.createdAt)
        return c.json(
          {
            success: false,
            error: 'This Task changed. Reopen it.',
            code: 'task-changed',
          },
          409,
        );
      return c.json({ success: true, data: await deps.module.read(scope) });
    } catch (error) {
      if (error instanceof ReviewRequestConflictError)
        return c.json(
          {
            success: false,
            error: 'This review request is already bound to different work.',
            code: 'review_request_conflict',
          },
          409,
        );
      if (error instanceof TaskCodeReviewError) {
        switch (error.code) {
          case 'project-changed':
            return c.json(
              {
                success: false,
                error:
                  'The Project changed. Reopen this Task before requesting review.',
                code: 'project-changed',
              },
              409,
            );
          case 'feature_preview_disabled':
            return c.json(
              {
                success: false,
                error:
                  'Enable Task review in Settings → Advanced → Feature previews.',
                code: 'feature_preview_disabled',
                previewId: 'task-review',
                settingsPath:
                  '/settings?view=feature-previews&highlight=feature-previews',
              },
              404,
            );
          case 'forbidden':
            return c.json(
              {
                success: false,
                error:
                  'Task review is not authorized. Reopen this Task and check your access.',
                code: 'forbidden',
              },
              403,
            );
          case 'invalid-request':
            return c.json(
              {
                success: false,
                error:
                  'Refresh this Task and check its status, lead agent, checkout and independent reviewer before requesting review.',
                code: 'invalid-request',
              },
              400,
            );
          case 'unavailable':
            return c.json(
              {
                success: false,
                error:
                  'Code review is unavailable. Refresh to check its status.',
                code: 'unavailable',
              },
              503,
            );
        }
      }
      deps.reportError(error);
      return c.json(
        {
          success: false,
          error: 'Code review is unavailable. Refresh to check its status.',
          code: 'unavailable',
        },
        503,
      );
    }
  };
  app.get('/:taskId/review/code', (c) => run(c, false));
  app.post('/:taskId/review/code', (c) => run(c, true));
  return app;
}
