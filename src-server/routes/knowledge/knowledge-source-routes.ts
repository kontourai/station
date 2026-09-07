import { Hono } from 'hono';
import { isSafePathSegment } from '../../knowledge-index/path-safety.js';
import type { KnowledgeStoreProvider } from '../../knowledge-store/knowledge-store-provider.js';

/** Exact construction-free source read. Permission is owned by the provider's captured host policy. */
export function createKnowledgeSourceRoutes(
  store: Pick<KnowledgeStoreProvider, 'observeExactRecord'>,
  isRequestCurrent: (request: Request) => boolean,
) {
  const app = new Hono();
  app.get('/roots/:rootId/records/:id/source-observation', (c) => {
    c.header('Cache-Control', 'private, no-store');
    const rootId = c.req.param('rootId');
    const recordId = c.req.param('id');
    if (
      !rootId ||
      rootId.length > 200 ||
      !recordId ||
      recordId.length > 200 ||
      !isSafePathSegment(recordId)
    )
      return c.json(
        { success: false, error: 'Invalid source reference.' },
        400,
      );
    if (!isRequestCurrent(c.req.raw))
      return c.json({ success: true, data: { state: 'restricted' } });
    const result = store.observeExactRecord(rootId, recordId, c.req.raw);
    return c.json({
      success: true,
      data: isRequestCurrent(c.req.raw) ? result : { state: 'restricted' },
    });
  });
  return app;
}
