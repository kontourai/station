import {
  type IndependentReviewRequest,
  parseIndependentReviewRequest,
} from '@kontourai/station-contracts/review-evidence';
import type { TenantExecutionContext } from '@kontourai/station-contracts/tenancy';
import { type Context, Hono } from 'hono';
import type { ReviewEvidenceModule } from '../../services/evidence/review-evidence-module.js';

export interface ReviewEvidenceRouteDeps {
  getUserId(): string;
  getTenantExecutionContext(): TenantExecutionContext | undefined;
  reportError(operation: string, error: unknown): void;
}

export function createReviewEvidenceAggregateRoutes(
  reviews: Pick<ReviewEvidenceModule, 'listAll'>,
  listProjectSlugs: () => string[],
  reportError: (operation: string, error: unknown) => void = () => {},
) {
  const app = new Hono();
  app.get('/', async (context) => {
    try {
      return context.json({
        success: true,
        data: await reviews.listAll(listProjectSlugs()),
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
      return context.json({
        success: true,
        data: await reviews.list(projectSlug),
      });
    } catch (error) {
      deps.reportError('route.list', error);
      return unavailable(context);
    }
  });

  app.get('/requests/:requestId', async (context) => {
    const projectSlug = context.req.param('slug') ?? '';
    try {
      const status = await reviews.status(
        context.req.param('requestId') ?? '',
        projectSlug,
      );
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
      const receipt = await reviews.read(
        context.req.param('receiptId') ?? '',
        projectSlug,
      );
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
    const userId = deps.getUserId();
    try {
      const status = await reviews.run(request, {
        requestedBy: { actorId: userId },
        userId,
        tenantExecutionContext: deps.getTenantExecutionContext(),
      });
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
