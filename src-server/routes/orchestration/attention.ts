import { AttentionSnoozeUntilError } from '@kontourai/station-contracts/attention';
import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import { type Context, Hono } from 'hono';
import { FeaturePreviewDisabledError } from '../../services/feature-previews/feature-preview-refusal.js';
import type { AttentionProjectionService } from '../../services/projects/attention-projection.js';
import { param } from '../schemas/schemas.js';

/**
 * Mostly read-only; source-specific mutations deliberately remain at their
 * sources (approve/deny goes through notifications, gate outcomes through
 * Flow's own run routes). Per-user ack and snooze state belong here.
 * `POST /:id/ack`
 * (archive#1914): a `session-failed` item is DERIVED, never stored, so
 * there is no source route to dismiss it at — the acknowledgement belongs
 * to the item itself, not to the session it was derived from.
 */
export function createAttentionRoutes(
  attention: AttentionProjectionService,
  options: {
    /** Runtime composition supplies branded request authority in hosted mode. */
    readAuthorityForRequest?: (request: Request) => SessionReadAuthority;
    /**
     * #765 D5: whether THIS request's authenticated principal could act on
     * the pairing approve/deny routes — the runtime wires the boundary's own
     * predicate (`credentialMayDecidePairingRequests`) over the request
     * principal here, so the projection's `viewerCanDecide` is a derivation
     * of the same decision the HTTP boundary would make, never a fresh
     * guess. Absent (non-runtime compositions) fails closed to `false`.
     */
    viewerMayDecidePairingRequests?: (request: Request) => boolean;
    /**
     * #2323 S5: whether THIS request's caller is the Station operator, the
     * one person plugin lifecycle proposals are addressed to. Absent fails
     * closed: no proposal items.
     */
    viewerIsOperator?: (c: Context) => boolean;
    /**
     * Whether THIS request's caller passes the HTTP boundary and the
     * station-control dispatch scope (`approve`) for
     * `POST /api/orchestration/delegations/:taskId/respond` on a
     * paired-Station task. A model of those two gates only: the handler can
     * still refuse. Absent fails closed: no item claims the caller can
     * respond.
     */
    viewerMayRespondToPeerTask?: (
      c: Context,
      taskId: string,
      requestType: string | undefined,
    ) => boolean;
  } = {},
) {
  const app = new Hono();
  const viewerFor = (c: Context) => ({
    mayDecidePairingRequests:
      options.viewerMayDecidePairingRequests?.(c.req.raw) ?? false,
    isOperator: options.viewerIsOperator?.(c) ?? false,
    ...(options.viewerMayRespondToPeerTask
      ? {
          mayRespondToPeerTask: (
            taskId: string,
            requestType: string | undefined,
          ) =>
            options.viewerMayRespondToPeerTask?.(c, taskId, requestType) ??
            false,
        }
      : {}),
  });
  app.get('/', async (c) =>
    c.json({
      success: true,
      data: await attention.list(
        options.readAuthorityForRequest?.(c.req.raw),
        viewerFor(c),
      ),
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
  app.post('/:id/snooze', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { success: false, error: 'Expected JSON body with until' },
        400,
      );
    }
    const until =
      body && typeof body === 'object' && 'until' in body
        ? body.until
        : undefined;
    try {
      const snoozedUntil = await attention.snooze(
        param(c, 'id'),
        until,
        options.readAuthorityForRequest?.(c.req.raw),
        viewerFor(c),
      );
      if (!snoozedUntil)
        return c.json(
          { success: false, error: 'Attention item not found' },
          404,
        );
      return c.json({ success: true, data: { snoozedUntil } });
    } catch (error) {
      if (error instanceof AttentionSnoozeUntilError)
        return c.json({ success: false, error: error.publicMessage }, 400);
      if (error instanceof FeaturePreviewDisabledError)
        return c.json(error.refusal, 404);
      throw error;
    }
  });
  app.delete('/:id/snooze', (c) => {
    try {
      attention.unsnooze(
        param(c, 'id'),
        options.readAuthorityForRequest?.(c.req.raw),
      );
      return c.json({ success: true });
    } catch (error) {
      if (error instanceof FeaturePreviewDisabledError)
        return c.json(error.refusal, 404);
      throw error;
    }
  });
  return app;
}
