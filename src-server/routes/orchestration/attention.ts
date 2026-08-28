import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import type { AttentionProjectionService } from '../../services/projects/attention-projection.js';
import { param } from '../schemas/schemas.js';

/**
 * Mostly read-only; source-specific mutations deliberately remain at their
 * sources (approve/deny goes through notifications, gate outcomes through
 * Flow's own run routes). The one exception is `POST /:id/ack`
 * (archive#1914): a `session-failed` item is DERIVED, never stored, so
 * there is no source route to dismiss it at — the acknowledgement belongs
 * to the item itself, not to the session it was derived from.
 */
export function createAttentionRoutes(
  attention: AttentionProjectionService,
  options: {
    /** Runtime composition supplies branded request authority in hosted mode. */
    readAuthorityForRequest?: (request: Request) => SessionReadAuthority;
  } = {},
) {
  const app = new Hono();
  app.get('/', async (c) =>
    c.json({
      success: true,
      data: await attention.list(options.readAuthorityForRequest?.(c.req.raw)),
    }),
  );
  app.post('/:id/ack', async (c) => {
    const id = param(c, 'id');
    const authority = options.readAuthorityForRequest?.(c.req.raw);
    const acknowledged = authority
      ? await attention.acknowledge(id, authority)
      : await attention.acknowledge(id);
    if (!acknowledged) {
      return c.json(
        { success: false, error: 'Attention item is not acknowledgeable' },
        404,
      );
    }
    return c.json({ success: true });
  });
  return app;
}
