import { Hono } from 'hono';
import {
  FeaturePreviewDisabledError,
  requireFeaturePreview,
} from '../../services/feature-previews/feature-preview-refusal.js';
import {
  FeaturePreviewNotOfferedError,
  type FeaturePreviewRegistry,
} from '../../services/feature-previews/feature-preview-registry.js';
import type { Logger } from '../../utils/logger.js';
import {
  errorMessage,
  featurePreviewUpdateSchema,
  getBody,
  param,
  validate,
} from '../schemas/schemas.js';

/** The catalog is derived from runtime consumers; no raw-state list route exists. */
export function createFeaturePreviewRoutes(
  previews: FeaturePreviewRegistry,
  logger: Logger,
) {
  const app = new Hono();
  const desktopNearby = previews.bind({
    id: 'desktop-nearby',
    label: 'Desktop Nearby discovery',
    description:
      'Allow a connected Windows desktop to browse local-network Station advertisements for a bounded foreground request. Results still require explicit pairing.',
  });

  app.get('/desktop-nearby/admission', (c) => {
    try {
      requireFeaturePreview(
        desktopNearby,
        'desktop-nearby',
        'Desktop Nearby discovery',
      );
      return c.json({ success: true, data: { enabled: true } });
    } catch (error) {
      if (error instanceof FeaturePreviewDisabledError)
        return c.json(error.refusal, 404);
      throw error;
    }
  });

  app.get('/', (c) => {
    try {
      return c.json({ success: true, data: previews.list() });
    } catch (error) {
      logger.error('Failed to load feature previews', { error });
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  app.put('/:id', validate(featurePreviewUpdateSchema), async (c) => {
    try {
      const body = getBody(c);
      const preview = await previews.setEnabled(param(c, 'id'), body.enabled);
      return c.json({ success: true, data: preview });
    } catch (error) {
      if (error instanceof FeaturePreviewNotOfferedError) {
        // Through the shared sanitized boundary rather than raw `.message`:
        // same text for this typed error, and the route-error-egress gate's
        // reviewed list stays reserved for cases that genuinely need it.
        return c.json({ success: false, error: errorMessage(error) }, 404);
      }
      logger.error('Failed to update feature preview', { error });
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  return app;
}
