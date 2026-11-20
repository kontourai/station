import {
  type IndependentReviewRequest,
  parseIndependentReviewRequest,
} from '@kontourai/station-contracts/review-evidence';
import type { TenantExecutionContext } from '@kontourai/station-contracts/tenancy';
import { type Context, Hono } from 'hono';
import {
  type ReviewEvidenceModule,
  ReviewRequestConflictError,
  type ReviewTaskBinding,
} from '../../services/evidence/review-evidence-module.js';
import type { SessionOwnerStamp } from '../../services/orchestration/session-owner-attribution.js';

interface ReviewEvidenceRouteDeps {
  /**
   * Who the reviewer session belongs to and whether it acts for them
   * (`sessionOwnerStampFor`). The owner authorizes the session's turn; a
   * request whose principal cannot be resolved throws and runs no review.
   */
  getOwner(context: Context): SessionOwnerStamp;
  getTenantExecutionContext(): TenantExecutionContext | undefined;
  readAccess?(context: Context): ReviewReadAccess;
  taskContext?(
    context: Context,
    request: IndependentReviewRequest,
  ): Promise<
    { taskBinding: ReviewTaskBinding; assertCurrent(): void } | undefined
  >;
  reportError(operation: string, error: unknown): void;
}

interface ReviewReadAccess {
  includeTaskReviews: boolean;
  assertCurrent(): void;
}

export function createReviewEvidenceAggregateRoutes(
  reviews: Pick<ReviewEvidenceModule, 'listAll'>,
  listProjectSlugs: () => string[],
  reportError: (operation: string, error: unknown) => void = () => {},
  readAccess?: (context: Context) => ReviewReadAccess,
) {
  const app = new Hono();
  app.get('/', async (context) => {
    try {
      const access = readAccess?.(context);
      access?.assertCurrent();
      const data = access
        ? await reviews.listAll(listProjectSlugs(), access.includeTaskReviews)
        : await reviews.listAll(listProjectSlugs());
      access?.assertCurrent();
      return context.json({
        success: true,
        data,
      });
    } catch (error) {
      reportError('route.listAll', error);
      return unavailable(context);
    }
  });
  return app;
}

export function createReviewEvidenceRoutes(
  reviews: ReviewEvidenceModule,
  deps: ReviewEvidenceRouteDeps,
) {
  const app = new Hono();

  app.get('/', async (context) => {
    const projectSlug = context.req.param('slug') ?? '';
    try {
      const access = deps.readAccess?.(context);
      access?.assertCurrent();
      const data = access
        ? await reviews.list(projectSlug, access.includeTaskReviews)
        : await reviews.list(projectSlug);
      access?.assertCurrent();
      return context.json({
        success: true,
        data,
      });
    } catch (error) {
      deps.reportError('route.list', error);
      return unavailable(context);
    }
  });

  app.get('/requests/:requestId', async (context) => {
    const projectSlug = context.req.param('slug') ?? '';
    try {
      const access = deps.readAccess?.(context);
      access?.assertCurrent();
      const requestId = context.req.param('requestId') ?? '';
      const status = access
        ? await reviews.status(
            requestId,
            projectSlug,
            access.includeTaskReviews,
          )
        : await reviews.status(requestId, projectSlug);
      access?.assertCurrent();
      if (!status) {
        return context.json(
          {
            success: false,
            error: {
              code: 'review_request_not_found',
              message: 'Independent review request was not found.',
            },
          },
          404,
        );
      }
      return context.json({ success: true, data: status });
    } catch (error) {
      deps.reportError('route.status', error);
      return unavailable(context);
    }
  });

  app.get('/:receiptId', async (context) => {
    const projectSlug = context.req.param('slug') ?? '';
    try {
      const access = deps.readAccess?.(context);
      access?.assertCurrent();
      const receiptId = context.req.param('receiptId') ?? '';
      const receipt = access
        ? await reviews.read(receiptId, projectSlug, access.includeTaskReviews)
        : await reviews.read(receiptId, projectSlug);
      access?.assertCurrent();
      if (!receipt) {
        return context.json(
          {
            success: false,
            error: {
              code: 'review_evidence_not_found',
              message: 'Review evidence was not found.',
            },
          },
          404,
        );
      }
      return context.json({ success: true, data: receipt });
    } catch (error) {
      deps.reportError('route.read', error);
      return unavailable(context);
    }
  });

  app.post('/', async (context) => {
    const projectSlug = context.req.param('slug') ?? '';
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return rejected(context);
    }
    let request: IndependentReviewRequest;
    try {
      request = parseIndependentReviewRequest(body);
    } catch {
      return rejected(context);
    }
    if (request.target.projectSlug !== projectSlug) return rejected(context);
    try {
      const owner = deps.getOwner(context);
      const userId = owner.ownerUserId;
      const access = deps.readAccess?.(context);
      access?.assertCurrent();
      const taskContext = await deps.taskContext?.(context, request);
      const status = await reviews.run(request, {
        requestedBy: { actorId: userId },
        userId,
        ...(owner.ownerAttribution
          ? { ownerAttribution: owner.ownerAttribution }
          : {}),
        tenantExecutionContext: deps.getTenantExecutionContext(),
        ...(access ? { includeTaskReviews: access.includeTaskReviews } : {}),
        ...taskContext,
      });
      taskContext?.assertCurrent();
      access?.assertCurrent();
      const code =
        status.state === 'completed'
          ? 201
          : status.state === 'running'
            ? 202
            : status.state === 'rejected'
              ? 400
              : 409;
      return context.json({ success: true, data: status }, code);
    } catch (error) {
      deps.reportError('route.run', error);
      if (error instanceof ReviewRequestConflictError)
        return context.json(
          {
            success: false,
            error: {
              code: 'review_request_conflict',
              message:
                'This review request is already bound to different work.',
            },
          },
          409,
        );
      return unavailable(context);
    }
  });

  return app;
}

function rejected(context: Context) {
  return context.json(
    {
      success: false,
      error: {
        code: 'review_evidence_rejected',
        message: 'The independent review request was rejected.',
      },
    },
    400,
  );
}

function unavailable(context: Context) {
  return context.json(
    {
      success: false,
      error: {
        code: 'review_evidence_unavailable',
        message: 'Review evidence is unavailable.',
      },
    },
    500,
  );
}
