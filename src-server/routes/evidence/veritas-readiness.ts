/**
 * Veritas Readiness Routes - project-scoped merge readiness
 * Mounted at /api/projects/:slug/readiness
 */

import { Hono } from 'hono';
import {
  type GetReadinessOptions,
  VeritasCliError,
  VeritasNotConfiguredError,
  type VeritasReadinessService,
} from '../../services/evidence/veritas-readiness-service.js';
import { errorMessage } from '../schemas/schemas.js';

export interface VeritasReadinessRouteDeps {
  /** Resolve a project slug to its workspace path (workingDirectory). */
  getWorkspacePath: (slug: string) => string | undefined;
}

const READINESS_CHECKS = new Set(['evidence', 'boundaries', 'coverage']);

export function createVeritasReadinessRoutes(
  readinessService: VeritasReadinessService,
  deps: VeritasReadinessRouteDeps,
) {
  const app = new Hono<{ Variables: { cwd: string } }>();

  // Resolve the project workspace once per request. A project with no working
  // directory is a valid, expected state — report it as not-configured data
  // (200) so the readiness panel renders its empty state instead of erroring.
  app.use('*', async (c, next) => {
    const slug = c.req.param('slug') ?? '';
    const cwd = deps.getWorkspacePath(slug);
    if (!cwd) {
      return c.json({
        success: true,
        data: { configured: false, reason: 'no-workspace' },
      });
    }
    c.set('cwd', cwd);
    await next();
  });

  // Readiness snapshot (GET /?refresh=true&check=evidence)
  app.get('/', async (c) => {
    const cwd = c.get('cwd');
    const refresh = c.req.query('refresh') === 'true';
    const checkParam = c.req.query('check');
    if (checkParam !== undefined && !READINESS_CHECKS.has(checkParam)) {
      return c.json(
        {
          success: false,
          error: 'check must be evidence, boundaries or coverage',
        },
        400,
      );
    }
    const options: GetReadinessOptions = { refresh };
    if (checkParam) {
      options.check = checkParam as GetReadinessOptions['check'];
    }

    // Detection is cheap and never throws — report "not configured" as data.
    const workspace = readinessService.detectWorkspace(cwd);
    if (!workspace.configured) {
      return c.json({
        success: true,
        data: { configured: false, reason: workspace.reason },
      });
    }

    try {
      const snapshot = await readinessService.getReadiness(cwd, options);
      return c.json({
        success: true,
        data: { configured: true, ...snapshot },
      });
    } catch (error: unknown) {
      if (error instanceof VeritasNotConfiguredError) {
        return c.json({
          success: true,
          data: { configured: false, reason: error.reason },
        });
      }
      if (error instanceof VeritasCliError) {
        return c.json(
          {
            success: false,
            error: errorMessage(error),
            exitCode: error.exitCode,
            stderrTail: error.stderrTail,
          },
          502,
        );
      }
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  // Scaffold a Veritas workspace via `veritas init` (POST /init). The setup CTA
  // in the coding side panel calls this behind a confirm — it writes `.veritas/`
  // into the user's project. Idempotent: an already-initialized workspace and a
  // missing CLI both return success data (outcome) rather than erroring, so the
  // panel can refetch readiness or degrade to a copyable command.
  app.post('/init', async (c) => {
    const cwd = c.get('cwd');
    try {
      const data = await readinessService.initWorkspace(cwd);
      return c.json({ success: true, data });
    } catch (error: unknown) {
      if (error instanceof VeritasCliError) {
        return c.json(
          {
            success: false,
            error: errorMessage(error),
            exitCode: error.exitCode,
            stderrTail: error.stderrTail,
          },
          502,
        );
      }
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  return app;
}
