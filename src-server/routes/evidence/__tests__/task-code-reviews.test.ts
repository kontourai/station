import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import {
  TaskCodeReviewError,
  TaskCodeReviewModule,
} from '../../../services/evidence/task-code-review-module.js';
import { createTaskCodeReviewRoutes } from '../task-code-reviews.js';

const privateDetail = 'provider token=private-example /private/host/repository';

function refusalApp(error: unknown) {
  const reportError = vi.fn();
  const unexpectedExecution = vi.fn(async () => {
    throw new Error(
      'Review execution must not start after authorization fails.',
    );
  });
  const app = new Hono();
  app.route(
    '/api/tasks',
    createTaskCodeReviewRoutes({
      module: new TaskCodeReviewModule({
        reviews: { run: unexpectedExecution, status: unexpectedExecution },
        submissions: {
          taskRequestIds: unexpectedExecution,
          hasTaskRequest: unexpectedExecution,
        },
        reviewers: unexpectedExecution,
        baseCommit: () => undefined,
        reportError,
      }),
      authorize: async () => {
        throw error;
      },
      reportError,
    }),
  );
  return { app, reportError, unexpectedExecution };
}

const publicRefusals = [
  {
    code: 'project-changed',
    status: 409,
    message: 'The Project changed. Reopen this Task before requesting review.',
  },
  {
    code: 'feature_preview_disabled',
    status: 404,
    message: 'Enable Task review in Settings → Advanced → Feature previews.',
  },
  {
    code: 'forbidden',
    status: 403,
    message:
      'Task review is not authorized. Reopen this Task and check your access.',
  },
  {
    code: 'invalid-request',
    status: 400,
    message:
      'Refresh this Task and check its status, lead agent, checkout and independent reviewer before requesting review.',
  },
  {
    code: 'unavailable',
    status: 503,
    message: 'Code review is unavailable. Refresh to check its status.',
  },
] as const;

describe('Task code-review public refusals', () => {
  it.each(publicRefusals)(
    'keeps $code actionable without exposing exception details on reads or submissions',
    async ({ code, status, message }) => {
      const { app, reportError, unexpectedExecution } = refusalApp(
        new TaskCodeReviewError(code, privateDetail),
      );
      for (const method of ['GET', 'POST']) {
        const response = await app.request('/api/tasks/task-1/review/code', {
          method,
          ...(method === 'POST' ? { body: '{invalid' } : {}),
        });
        expect(response.status).toBe(status);
        expect(response.headers.get('cache-control')).toBe('no-store');
        const body = await response.json();
        expect(body).toEqual({
          success: false,
          error: message,
          code,
          ...(code === 'feature_preview_disabled'
            ? {
                previewId: 'task-review',
                settingsPath:
                  '/settings?view=feature-previews&highlight=feature-previews',
              }
            : {}),
        });
        expect(JSON.stringify(body)).not.toContain(privateDetail);
      }
      expect(unexpectedExecution).not.toHaveBeenCalled();
      expect(reportError).not.toHaveBeenCalled();
    },
  );

  it.each(['lookalike', 'unsupported-code'] as const)(
    'reports a %s error internally and returns only the generic refusal',
    async (kind) => {
      const error =
        kind === 'lookalike'
          ? Object.assign(new Error(privateDetail), { code: 'forbidden' })
          : Object.defineProperty(
              new TaskCodeReviewError('unavailable', privateDetail),
              'code',
              { value: 'unexpected-private-code' },
            );
      const { app, reportError, unexpectedExecution } = refusalApp(error);
      const response = await app.request('/api/tasks/task-1/review/code');
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        success: false,
        error: 'Code review is unavailable. Refresh to check its status.',
        code: 'unavailable',
      });
      expect(reportError).toHaveBeenCalledExactlyOnceWith(error);
      expect(unexpectedExecution).not.toHaveBeenCalled();
    },
  );
});
