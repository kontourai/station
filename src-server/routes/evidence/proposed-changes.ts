import { isProposedChangeStatus } from '@kontourai/station-contracts/proposed-change';
import type { Context } from 'hono';
import { Hono } from 'hono';
import {
  ProposedChangeConflictError,
  ProposedChangeNotFoundError,
  ProposedChangeService,
  ProposedChangeTransitionError,
  ProposedChangeValidationError,
} from '../../services/projects/proposed-change-service.js';
import {
  errorMessage,
  getBody,
  param,
  proposedChangeBulkDecisionSchema,
  proposedChangeCreateSchema,
  proposedChangeDecisionSchema,
  validate,
} from '../schemas/schemas.js';

export function createProposedChangeRoutes(service: ProposedChangeService) {
  const app = new Hono();

  app.get('/', (c) => {
    const rawStatuses = c.req.queries('status') ?? [];
    const status = rawStatuses.filter(isProposedChangeStatus);
    const data = service.list({
      status: status.length ? status : undefined,
      sessionId: c.req.query('sessionId') ?? undefined,
      projectId: c.req.query('projectId') ?? undefined,
    });
    return c.json({ success: true, data });
  });

  app.post('/', validate(proposedChangeCreateSchema), async (c) => {
    try {
      const change = await service.create(getBody(c));
      return c.json({ success: true, data: change }, 201);
    } catch (error) {
      return mapProposedChangeError(c, error);
    }
  });

  app.post(
    '/bulk/approve',
    validate(proposedChangeBulkDecisionSchema),
    async (c) => {
      try {
        const changes = await service.bulkApprove(getBody(c));
        return c.json({ success: true, data: changes });
      } catch (error) {
        return mapProposedChangeError(c, error);
      }
    },
  );

  app.post(
    '/bulk/reject',
    validate(proposedChangeBulkDecisionSchema),
    async (c) => {
      try {
        const changes = await service.bulkReject(getBody(c));
        return c.json({ success: true, data: changes });
      } catch (error) {
        return mapProposedChangeError(c, error);
      }
    },
  );

  app.get('/:id', (c) => {
    const change = service.get(param(c, 'id'));
    if (!change) {
      return c.json(
        { success: false, error: 'Proposed change not found' },
        404,
      );
    }
    return c.json({ success: true, data: change });
  });

  app.post(
    '/:id/approve',
    validate(proposedChangeDecisionSchema),
    async (c) => {
      try {
        const change = await service.approve(param(c, 'id'), getBody(c));
        return c.json({ success: true, data: change });
      } catch (error) {
        return mapProposedChangeError(c, error);
      }
    },
  );

  app.post('/:id/reject', validate(proposedChangeDecisionSchema), async (c) => {
    try {
      const change = await service.reject(param(c, 'id'), getBody(c));
      return c.json({ success: true, data: change });
    } catch (error) {
      return mapProposedChangeError(c, error);
    }
  });

  return app;
}

function mapProposedChangeError(c: Context, error: unknown) {
  if (error instanceof ProposedChangeConflictError) {
    return c.json({ success: false, error: 'Proposed change conflict' }, 409);
  }
  if (error instanceof ProposedChangeNotFoundError) {
    return c.json({ success: false, error: 'Proposed change not found' }, 404);
  }
  if (error instanceof ProposedChangeTransitionError) {
    return c.json(
      { success: false, error: 'Proposed change cannot be transitioned' },
      409,
    );
  }
  if (error instanceof ProposedChangeValidationError) {
    return c.json({ success: false, error: 'Invalid proposed change' }, 400);
  }
  return c.json({ success: false, error: errorMessage(error) }, 500);
}
