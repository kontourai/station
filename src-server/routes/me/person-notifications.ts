import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import { type Context, Hono } from 'hono';
import { connectedAccountOwnerId } from '../../services/identity/connected-account-owner.js';
import type { NotificationService } from '../../services/notifications/notification-service.js';
import { readerSurfaceId } from '../operations/notifications.js';
import { param } from '../schemas/schemas.js';
import type { PersonalLayoutPrincipalContext } from './personal-layouts.js';

export function createPersonNotificationRoutes(deps: {
  service: NotificationService;
  resolvePrincipal(c: PersonalLayoutPrincipalContext): PrincipalRef;
  isInternal(request: Request): boolean;
}) {
  const app = new Hono();
  const principalId = (c: Context): string | undefined => {
    try {
      return deps.isInternal(c.req.raw)
        ? undefined
        : connectedAccountOwnerId(deps.resolvePrincipal(c));
    } catch {
      return undefined;
    }
  };
  const handle = async (c: Context, operation: 'list' | 'read' | 'dismiss') => {
    c.header('Cache-Control', 'no-store');
    const person = principalId(c);
    if (!person)
      return c.json(
        { error: { code: 'person_notifications_identity_required' } },
        403,
      );
    if (operation === 'list')
      return c.json({
        success: true,
        data: await deps.service.listForPrincipal(person),
      });
    const surface = readerSurfaceId(c.req.raw);
    if (!surface)
      return c.json(
        { success: false, error: 'A client session is required' },
        400,
      );
    const id = param(c, 'id');
    const outcome =
      operation === 'read'
        ? await deps.service.markReadForPrincipal(person, id, surface)
        : await deps.service.dismissForPrincipal(person, id, surface);
    if (outcome === 'not-found')
      return c.json({ success: false, error: 'Notification not found' }, 404);
    if (operation === 'read')
      return c.json({ success: true, data: { outcome } });
    return c.json({ success: true });
  };
  app.get('/notifications', (c) => handle(c, 'list'));
  app.post('/notifications/:id/read', (c) => handle(c, 'read'));
  app.delete('/notifications/:id', (c) => handle(c, 'dismiss'));
  return app;
}
