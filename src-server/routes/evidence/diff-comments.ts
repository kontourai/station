/**
 * Diff Comment Routes — project-scoped inline diff review comments.
 * Mounted at /api/projects/:slug/diff-comments
 *
 *   GET    /            list (optional ?path= filter to one file)
 *   POST   /            create { filePath, side, lineNumber, body }
 *   DELETE /:id         delete one comment
 */

import { Hono } from 'hono';
import { z } from 'zod/v3';
import {
  type DiffCommentService,
  DiffCommentValidationError,
} from '../../services/projects/diff-comment-service.js';
import { errorMessage, getBody, param, validate } from '../schemas/schemas.js';

const diffCommentCreateSchema = z.object({
  filePath: z.string().min(1),
  side: z.enum(['deletions', 'additions']),
  lineNumber: z.number().int().positive(),
  body: z.string().trim().min(1),
  authorId: z.string().optional(),
});

type DiffCommentCreateBody = z.infer<typeof diffCommentCreateSchema>;

export interface DiffCommentRouteDeps {
  /**
   * Resolve a project slug to its comment store file path. `undefined` means
   * the project does not exist or has no working directory (→ 404).
   */
  resolveStorePath: (slug: string) => string | undefined;
}

export function createDiffCommentRoutes(
  diffCommentService: DiffCommentService,
  deps: DiffCommentRouteDeps,
) {
  const app = new Hono<{
    Variables: { storePath: string; slug: string };
  }>();

  app.use('*', async (c, next) => {
    const slug = c.req.param('slug') ?? '';
    const storePath = deps.resolveStorePath(slug);
    if (!storePath) {
      return c.json(
        { success: false, error: `Project not found: ${slug}` },
        404,
      );
    }
    c.set('storePath', storePath);
    c.set('slug', slug);
    await next();
  });

  // List (GET /, optional ?path= filter)
  app.get('/', (c) => {
    try {
      const filePath = c.req.query('path') || undefined;
      const data = diffCommentService.list(c.get('storePath'), filePath);
      return c.json({ success: true, data });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  // Create (POST /)
  app.post('/', validate(diffCommentCreateSchema), async (c) => {
    try {
      const body = getBody(c) as DiffCommentCreateBody;
      const data = await diffCommentService.create(c.get('storePath'), {
        projectId: c.get('slug'),
        filePath: body.filePath,
        side: body.side,
        lineNumber: body.lineNumber,
        body: body.body,
        ...(body.authorId === undefined ? {} : { authorId: body.authorId }),
      });
      return c.json({ success: true, data }, 201);
    } catch (error: unknown) {
      if (error instanceof DiffCommentValidationError) {
        return c.json({ success: false, error: 'Invalid diff comment' }, 400);
      }
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  // Delete (DELETE /:id)
  app.delete('/:id', async (c) => {
    try {
      const removed = await diffCommentService.delete(
        c.get('storePath'),
        param(c, 'id'),
      );
      if (!removed) {
        return c.json({ success: false, error: 'Comment not found' }, 404);
      }
      return c.json({ success: true });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  return app;
}

export interface DiffCommentsAggregateDeps {
  /** Resolve every project's comment store path (skip projects without one). */
  listStorePaths: () => string[];
}

/**
 * Cross-project diff comment listing — the review queue's unified feed.
 * Mounted at /api/diff-comments (GET /). Each comment carries its own
 * projectId, so the UI can group and route without extra lookups.
 */
export function createDiffCommentsAggregateRoutes(
  diffCommentService: DiffCommentService,
  deps: DiffCommentsAggregateDeps,
) {
  const app = new Hono();

  app.get('/', (c) => {
    try {
      const data = diffCommentService.listAcross(deps.listStorePaths());
      return c.json({ success: true, data });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  return app;
}
