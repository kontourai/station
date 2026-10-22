import { type Context, Hono } from 'hono';
import { z } from 'zod/v3';
import { isOperatorInPersonNotAgent } from '../../security/coding-authority.js';
import {
  RepositoryAcquisitionConflict,
  RepositoryAcquisitionInputError,
  RepositoryAcquisitionService,
  repositoryAcquisitionRequestSchema,
} from '../../services/projects/repository-acquisition-service.js';
import { getBody, param, validate } from '../schemas/schemas.js';

/** Acquisition uses this host's Git credentials; only its operator may invoke it. */
export function createRepositoryAcquisitionRoutes(homeDir: string) {
  const app = new Hono();
  const service = new RepositoryAcquisitionService(homeDir);
  app.use('/repository-acquisitions', async (c, next) => {
    if (!isOperatorInPersonNotAgent(c.req.raw)) return denied(c);
    return next();
  });
  app.use('/repository-acquisitions/*', async (c, next) => {
    if (!isOperatorInPersonNotAgent(c.req.raw)) return denied(c);
    return next();
  });
  app.post(
    '/repository-acquisitions',
    validate(repositoryAcquisitionRequestSchema),
    async (c) => {
      try {
        const data = await service.acquire(getBody(c));
        return c.json({ success: true, data });
      } catch (error) {
        return failure(c, error);
      }
    },
  );
  app.get('/repository-acquisitions/:id', async (c) => {
    try {
      const data = service.get(param(c, 'id'));
      return data
        ? c.json({ success: true, data })
        : c.json(
            { success: false, error: 'Repository acquisition was not found.' },
            404,
          );
    } catch (error) {
      return failure(c, error);
    }
  });
  app.post('/repository-acquisitions/:id/retry', async (c) => {
    try {
      const current = service.get(param(c, 'id'));
      if (!current)
        return c.json(
          { success: false, error: 'Repository acquisition was not found.' },
          404,
        );
      const data = await service.acquire(current.request, true);
      return c.json({ success: true, data });
    } catch (error) {
      return failure(c, error);
    }
  });
  return app;
}

function denied(c: Context) {
  return c.json(
    {
      success: false,
      error:
        "Repository acquisition uses this Station's Git credentials and requires its operator.",
    },
    403,
  );
}

function failure(c: Context, error: unknown) {
  if (error instanceof RepositoryAcquisitionConflict) {
    return c.json(
      {
        success: false,
        error:
          'This operation already names a different repository or ref. Inspect it before starting a new operation.',
      },
      409,
    );
  }
  if (
    error instanceof z.ZodError ||
    error instanceof RepositoryAcquisitionInputError
  ) {
    return c.json(
      {
        success: false,
        error:
          'Repository source or request ID is invalid. Use an HTTPS or SSH URL without embedded credentials, or an absolute local mirror path.',
      },
      400,
    );
  }
  return c.json(
    {
      success: false,
      error:
        'Repository acquisition could not be completed. Inspect the operation before retrying.',
    },
    503,
  );
}
