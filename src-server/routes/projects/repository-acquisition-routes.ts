import { type Context, Hono } from 'hono';
import { z } from 'zod/v3';
import { isOperatorInPersonNotAgent } from '../../security/coding-authority.js';
import { guardProjectResponse } from '../../services/projects/project-response-guard.js';
import {
  RepositoryAcquisitionConflict,
  RepositoryAcquisitionInputError,
  RepositoryAcquisitionService,
  repositoryAcquisitionRequestSchema,
} from '../../services/projects/repository-acquisition-service.js';
import { RepositoryProviderCatalog } from '../../services/projects/repository-provider-catalog.js';
import { getBody, param, validate } from '../schemas/schemas.js';

/** Acquisition uses this host's Git credentials; only its operator may invoke it. */
export function createRepositoryAcquisitionRoutes(
  homeDir: string,
  mayDiscover: (request: Request) => boolean = isOperatorInPersonNotAgent,
  catalog = new RepositoryProviderCatalog(),
) {
  const app = new Hono();
  const service = new RepositoryAcquisitionService(homeDir);
  app.get('/repository-providers/:provider', async (c) => {
    if (!mayDiscover(c.req.raw)) return denied(c);
    const provider = z
      .enum(['github', 'gitlab'])
      .safeParse(c.req.param('provider'));
    const page = z.coerce
      .number()
      .int()
      .min(1)
      .max(1000)
      .safeParse(c.req.query('page') ?? '1');
    if (!provider.success || !page.success)
      return c.json(
        { success: false, error: 'Choose GitHub or GitLab and a valid page.' },
        400,
      );
    try {
      const current = () => mayDiscover(c.req.raw) && !c.req.raw.signal.aborted;
      const data = await catalog.list(provider.data, page.data, () => {
        if (!current())
          throw new Error('Repository discovery authority ended.');
      });
      if (!current()) return denied(c);
      return guardProjectResponse(c.json({ success: true, data }), async () =>
        current(),
      );
    } catch {
      if (!mayDiscover(c.req.raw)) return denied(c);
      return c.json(
        {
          success: false,
          error:
            provider.data === 'github'
              ? 'GitHub discovery needs an available gh CLI signed in on the Station host. Sign in there with gh auth login, then retry, or paste a Git URL.'
              : 'GitLab discovery needs an available glab CLI signed in on the Station host. Sign in there with glab auth login, then retry, or paste a Git URL.',
        },
        503,
      );
    }
  });
  app.use('/repository-acquisitions', async (c, next) => {
    if (!mayDiscover(c.req.raw) || c.req.raw.signal.aborted) return denied(c);
    return next();
  });
  app.use('/repository-acquisitions/*', async (c, next) => {
    if (!mayDiscover(c.req.raw) || c.req.raw.signal.aborted) return denied(c);
    return next();
  });
  app.get('/repository-acquisitions', async (c) => {
    const current = () => mayDiscover(c.req.raw) && !c.req.raw.signal.aborted;
    try {
      const data = await service.findReusable(
        {
          sourceUrl: c.req.query('sourceUrl'),
          ...(c.req.query('sourceRef')
            ? { sourceRef: c.req.query('sourceRef') }
            : {}),
          ...(c.req.query('subdirectory')
            ? { subdirectory: c.req.query('subdirectory') }
            : {}),
        },
        () => {
          if (!current())
            throw new Error('Repository discovery authority ended.');
        },
      );
      if (!current()) return denied(c);
      return guardProjectResponse(c.json({ success: true, data }), async () =>
        current(),
      );
    } catch (error) {
      if (!current()) return denied(c);
      return failure(c, error);
    }
  });
  app.post('/repository-acquisitions/:id/reuse', async (c) => {
    const current = () => mayDiscover(c.req.raw) && !c.req.raw.signal.aborted;
    try {
      const data = await service.reuse(param(c, 'id'), () => {
        if (!current()) throw new Error('Repository reuse authority ended.');
      });
      if (!current()) return denied(c);
      return guardProjectResponse(c.json({ success: true, data }), async () =>
        current(),
      );
    } catch (error) {
      if (!current()) return denied(c);
      return failure(c, error);
    }
  });
  app.post(
    '/repository-acquisitions',
    validate(repositoryAcquisitionRequestSchema),
    async (c) => {
      const current = () => mayDiscover(c.req.raw) && !c.req.raw.signal.aborted;
      try {
        const data = await service.acquire(getBody(c), false, () => {
          if (!current())
            throw new Error('Repository acquisition authority ended.');
        });
        if (!current()) return denied(c);
        return guardProjectResponse(c.json({ success: true, data }), async () =>
          current(),
        );
      } catch (error) {
        if (!current()) return denied(c);
        return failure(c, error);
      }
    },
  );
  app.get('/repository-acquisitions/:id', async (c) => {
    const current = () => mayDiscover(c.req.raw) && !c.req.raw.signal.aborted;
    if (!current()) return denied(c);
    try {
      const data = service.get(param(c, 'id'));
      return data
        ? guardProjectResponse(
            c.json({ success: true, data }),
            async () => mayDiscover(c.req.raw) && !c.req.raw.signal.aborted,
          )
        : c.json(
            { success: false, error: 'Repository acquisition was not found.' },
            404,
          );
    } catch (error) {
      if (!mayDiscover(c.req.raw) || c.req.raw.signal.aborted) return denied(c);
      return failure(c, error);
    }
  });
  app.post('/repository-acquisitions/:id/cancel', async (c) => {
    try {
      const current = () => mayDiscover(c.req.raw) && !c.req.raw.signal.aborted;
      const data = await service.cancel(param(c, 'id'), () => {
        if (!current())
          throw new Error('Repository cancellation authority ended.');
      });
      if (!current()) return denied(c);
      return data
        ? guardProjectResponse(
            c.json({ success: true, data }),
            async () => mayDiscover(c.req.raw) && !c.req.raw.signal.aborted,
          )
        : c.json(
            { success: false, error: 'Repository acquisition was not found.' },
            404,
          );
    } catch (error) {
      if (!mayDiscover(c.req.raw) || c.req.raw.signal.aborted) return denied(c);
      return failure(c, error);
    }
  });
  app.post('/repository-acquisitions/:id/retry', async (c) => {
    const current = () => mayDiscover(c.req.raw) && !c.req.raw.signal.aborted;
    if (!current()) return denied(c);
    try {
      const saved = service.get(param(c, 'id'));
      if (!saved)
        return c.json(
          { success: false, error: 'Repository acquisition was not found.' },
          404,
        );
      const data = await service.acquire(saved.request, true, () => {
        if (!current())
          throw new Error('Repository acquisition authority ended.');
      });
      if (!current()) return denied(c);
      return guardProjectResponse(c.json({ success: true, data }), async () =>
        current(),
      );
    } catch (error) {
      if (!mayDiscover(c.req.raw) || c.req.raw.signal.aborted) return denied(c);
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
