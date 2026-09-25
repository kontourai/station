/**
 * `GET/PUT /api/notifications/preferences` (#2586): how far notifications
 * may interrupt — agent notification level, quiet hours, per-surface
 * minimum urgency and hidden content, escalation delay.
 *
 * Operate tier for both verbs (pairing-route-scopes.ts). Station's own
 * agent tools and delegated Stations are refused: an agent that could
 * write this file could unmute itself.
 */
import { Hono } from 'hono';
import {
  NotificationPreferencesInvalidError,
  type NotificationPreferencesStore,
} from '../../services/notifications/notification-preferences.js';
import { isNonPersonCaller } from '../plugins/plugin-person-approval.js';

const MAX_BODY_BYTES = 256 * 1024;

export function createNotificationPreferencesRoutes(
  store: Pick<NotificationPreferencesStore, 'read' | 'write'>,
) {
  const app = new Hono();

  app.use('/preferences', async (c, next) => {
    if (isNonPersonCaller(c.req.raw)) {
      return c.json(
        {
          success: false,
          error: 'person_required',
          message:
            "Notification preferences belong to a person; Station's agent tools and delegated Stations cannot read or change them.",
        },
        403,
      );
    }
    await next();
  });

  app.get('/preferences', (c) => {
    const result = store.read();
    if (!result.ok) {
      return c.json(
        {
          success: false,
          error: 'preferences_unreadable',
          message:
            'The saved notification preferences could not be read. Saving new preferences replaces them.',
        },
        409,
      );
    }
    return c.json({
      success: true,
      data: result.preferences,
      stored: result.stored,
    });
  });

  app.put('/preferences', async (c) => {
    const length = Number(c.req.header('content-length') ?? '0');
    if (Number.isFinite(length) && length > MAX_BODY_BYTES)
      return c.json({ success: false, error: 'invalid_preferences' }, 413);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: 'invalid_preferences' }, 400);
    }
    try {
      return c.json({ success: true, data: store.write(body) });
    } catch (error) {
      if (error instanceof NotificationPreferencesInvalidError)
        return c.json({ success: false, error: 'invalid_preferences' }, 400);
      return c.json({ success: false, error: 'preferences_write_failed' }, 500);
    }
  });

  return app;
}
