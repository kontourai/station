import { Hono } from 'hono';
import { readBoundedRequestBody } from '../security/bounded-request-body.js';
import {
  FeaturePreviewDisabledError,
  requireFeaturePreview,
} from '../services/feature-previews/feature-preview-refusal.js';
import type { FeaturePreviewSelector } from '../services/feature-previews/feature-preview-registry.js';
import type { MediaToolsAcquisition } from '../services/media-tools/media-tools-acquisition.js';
import type { MediaToolComponent } from '../services/media-tools/media-tools-pins.js';

export function createMediaToolsRoutes(deps: {
  tools: Pick<MediaToolsAcquisition, 'status' | 'startDownload'>;
  preview: FeaturePreviewSelector;
  authorizeOperator(request: Request): Promise<boolean>;
  isRequestPrincipalCurrent(request: Request): boolean;
}) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (
      !deps.isRequestPrincipalCurrent(c.req.raw) ||
      !(await deps.authorizeOperator(c.req.raw))
    )
      return c.json({ success: false, code: 'operator-required' }, 403);
    await next();
  });
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    try {
      requireFeaturePreview(
        deps.preview,
        'walkthroughs',
        'Walkthroughs or Local speech',
      );
    } catch (error) {
      if (error instanceof FeaturePreviewDisabledError)
        return c.json(error.refusal, 404);
      throw error;
    }
    await next();
  });
  app.get('/status', async (c) =>
    c.json({ success: true, data: await deps.tools.status() }),
  );
  app.post('/download', async (c) => {
    const body = await readBoundedRequestBody(c.req.raw, 4096);
    if (body.status !== 'ok')
      return c.json({ success: false, code: body.status }, 400);
    let input: unknown;
    try {
      input = JSON.parse(body.body);
    } catch {
      return c.json({ success: false, code: 'invalid-input' }, 400);
    }
    if (!input || typeof input !== 'object' || Array.isArray(input))
      return c.json({ success: false, code: 'invalid-input' }, 400);
    const value = input as Record<string, unknown>;
    if (value.consent !== true)
      return c.json({ success: false, code: 'consent-required' }, 400);
    if (
      Object.keys(value).some(
        (key) => !['consent', 'components'].includes(key),
      ) ||
      (value.components !== undefined &&
        (!Array.isArray(value.components) ||
          value.components.length === 0 ||
          value.components.some(
            (v: unknown) =>
              typeof v !== 'string' ||
              !['ffmpeg', 'speech-runtime', 'speech-model'].includes(v),
          )))
    )
      return c.json({ success: false, code: 'invalid-components' }, 400);
    if (!deps.isRequestPrincipalCurrent(c.req.raw))
      return c.json({ success: false, code: 'operator-required' }, 403);
    try {
      requireFeaturePreview(
        deps.preview,
        'walkthroughs',
        'Walkthroughs or Local speech',
      );
    } catch (error) {
      if (error instanceof FeaturePreviewDisabledError)
        return c.json(error.refusal, 404);
      throw error;
    }
    const { status } = await deps.tools.startDownload({
      consent: true,
      components: value.components as MediaToolComponent[] | undefined,
    });
    return c.json({ success: true, data: status }, 202);
  });
  return app;
}
