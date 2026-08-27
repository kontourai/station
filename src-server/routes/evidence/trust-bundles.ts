/**
 * Trust Bundle Routes - project-scoped Surface trust bundles
 * Mounted at /api/projects/:slug/trust-bundles
 */

import { Hono } from 'hono';
import {
  type TrustBundleLocations,
  TrustBundleNotFoundError,
  type TrustBundleService,
} from '../../services/evidence/trust-bundle-service.js';
import { errorMessage, param } from '../schemas/schemas.js';

export interface TrustBundleRouteDeps {
  /** Hosted tenants have no tenant-owned Project/bundle authority yet. */
  available?: () => boolean;
  /**
   * Resolve a project slug to its bundle locations. `undefined` means the
   * project itself does not exist (404); a project without a working
   * directory still resolves (station-home bundles remain reachable).
   */
  resolveLocations: (slug: string) => TrustBundleLocations | undefined;
}

export function createTrustBundleRoutes(
  trustBundleService: TrustBundleService,
  deps: TrustBundleRouteDeps,
) {
  const app = new Hono<{ Variables: { locations: TrustBundleLocations } }>();

  // Resolve the project's bundle locations once per request.
  app.use('*', async (c, next) => {
    if (deps.available && !deps.available()) {
      return c.json({ success: false, error: 'Project not found' }, 404);
    }
    const slug = c.req.param('slug') ?? '';
    const locations = deps.resolveLocations(slug);
    if (!locations) {
      return c.json(
        { success: false, error: `Project not found: ${slug}` },
        404,
      );
    }
    c.set('locations', locations);
    await next();
  });

  // List bundles with summaries (GET /)
  app.get('/', async (c) => {
    try {
      const data = await trustBundleService.listBundles(c.get('locations'));
      return c.json({ success: true, data });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  // Full trust report for one bundle (GET /:id)
  app.get('/:id', async (c) => {
    try {
      const data = await trustBundleService.getTrustReport(
        c.get('locations'),
        param(c, 'id'),
      );
      return c.json({ success: true, data });
    } catch (error: unknown) {
      if (error instanceof TrustBundleNotFoundError) {
        return c.json({ success: false, error: errorMessage(error) }, 404);
      }
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  return app;
}
