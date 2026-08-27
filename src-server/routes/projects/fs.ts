import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import { fileTreeOps } from '../../telemetry/metrics.js';
import { createLogger } from '../../utils/logger.js';
import { pathAccessFailure } from '../../utils/path-access-failure.js';
import { expandTilde } from '../../utils/paths.js';

const logger = createLogger({ name: 'fs-routes' });

export function createFsRoutes() {
  const app = new Hono();

  app.get('/browse', async (c) => {
    try {
      const pathParam = c.req.query('path') || '~';
      fileTreeOps.add(1, { op: 'browse' });
      const resolvedPath = resolve(expandTilde(pathParam));

      const entries = await readdir(resolvedPath, { withFileTypes: true });
      const directories = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({
          name: entry.name,
          isDirectory: true,
        }))
        .sort((a, b) => {
          const aStartsWithDot = a.name.startsWith('.');
          const bStartsWithDot = b.name.startsWith('.');
          if (aStartsWithDot !== bStartsWithDot) {
            return aStartsWithDot ? 1 : -1;
          }
          return a.name.localeCompare(b.name);
        });

      return c.json({
        success: true,
        data: { path: resolvedPath, entries: directories },
      });
    } catch (error: unknown) {
      // This is the project-creation folder picker, so it is on the first-run
      // path: the message here is the whole diagnosis a new user gets.
      const failure = pathAccessFailure(error, 'Folder');
      if (failure.status === 500) {
        logger.error('Directory browse failed', {
          error: error instanceof Error ? error.message : 'non-Error thrown',
        });
      }
      return c.json({ success: false, error: failure.error }, failure.status);
    }
  });

  return app;
}
