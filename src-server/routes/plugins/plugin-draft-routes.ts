import { readFile } from 'node:fs/promises';
import { Hono } from 'hono';
import type { PluginDraftService } from '../../services/plugins/plugin-draft-service.js';

/**
 * Plugin draft preview routes (epic #2323 S3), mounted under `/api/projects`
 * so every request first passes the Project read guard that the rest of
 * `/api/projects/:slug/*` does: a deployment account that is not a member of
 * the Project gets the guard's 404 before any handler here runs.
 *
 * - `POST /:slug/plugin-draft/lease` starts (or refreshes) the watcher and
 *   build for the Project folder. It never writes into that folder.
 * - `GET /:slug/plugin-draft` reads status and diagnostics without starting
 *   anything.
 * - `GET /:slug/plugin-draft/generations/:generation/bundle.(js|css)` serves
 *   one retained revision's bytes. Serving is not running: the bytes execute
 *   only when a viewer's tab chooses to load them, after the pane's
 *   disclosure.
 */
export interface PluginDraftRouteDeps {
  readonly service: PluginDraftService;
  /** The Project's working directory, or undefined when it has none. */
  readonly resolveProjectDirectory: (slug: string) => string | undefined;
}

const GENERATION_PATTERN = /^[1-9][0-9]{0,8}$/;

export function createPluginDraftRoutes({
  service,
  resolveProjectDirectory,
}: PluginDraftRouteDeps) {
  const app = new Hono();

  const projectDirectory = (slug: string) => {
    const dir = resolveProjectDirectory(slug);
    return dir && dir.trim() ? dir : undefined;
  };

  app.post('/:slug/plugin-draft/lease', (c) => {
    const slug = c.req.param('slug');
    const dir = projectDirectory(slug);
    if (!dir) {
      return c.json(
        { success: false, error: 'This Project has no folder to preview.' },
        404,
      );
    }
    return c.json(service.lease(slug, dir));
  });

  app.get('/:slug/plugin-draft', (c) => {
    const slug = c.req.param('slug');
    const dir = projectDirectory(slug);
    if (!dir) {
      return c.json(
        { success: false, error: 'This Project has no folder to preview.' },
        404,
      );
    }
    return c.json(service.status(slug, dir));
  });

  const serve = (kind: 'js' | 'css') => async (c: any) => {
    const slug = c.req.param('slug');
    const generation = c.req.param('generation');
    if (!GENERATION_PATTERN.test(generation)) {
      return c.text('Invalid revision', 400);
    }
    const dir = projectDirectory(slug);
    const file = dir
      ? service.bundleFile(slug, dir, Number(generation), kind)
      : undefined;
    if (!file) return c.text('Draft revision not found', 404);
    let body: string;
    try {
      body = await readFile(file, 'utf8');
    } catch {
      // Pruned between lookup and read: a newer revision replaced it.
      return c.text('Draft revision not found', 404);
    }
    c.header(
      'Content-Type',
      kind === 'js' ? 'application/javascript' : 'text/css',
    );
    // A revision's bytes are immutable, but a draft is private to the
    // Project's readers; never let a shared cache hold them.
    c.header('Cache-Control', 'private, no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    return c.body(body);
  };

  app.get('/:slug/plugin-draft/generations/:generation/bundle.js', serve('js'));
  app.get(
    '/:slug/plugin-draft/generations/:generation/bundle.css',
    serve('css'),
  );

  return app;
}
