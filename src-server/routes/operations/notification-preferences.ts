/**
 * Notification delivery routes (#2586), mounted at `/api/notifications`:
 *
 * - `GET /preferences` → `{ success, data: NotificationPreferencesV1, stored }`
 *   with an `ETag` of the stored revision.
 * - `PUT /preferences` → replaces the whole document. Send `If-Match: <etag>`
 *   to make it a compare-and-swap (412 `preferences_changed` when someone
 *   else wrote in between).
 * - `PATCH /preferences` → a `NotificationPreferencesPatch` applied
 *   server-side in one step (a mute is `{ perAgent: { builder: 'off' } }`);
 *   the way to change one field without a read-modify-write race.
 * - `GET /deliveries?surface=local:desktop-<id>&after=<cursor>` → the
 *   desktop host's decided-alert feed (`DesktopHostChannel`).
 *
 * Operate tier (pairing-route-scopes.ts). Station's own agent tools and
 * delegated Stations are refused everywhere here: an agent that could write
 * the preferences could unmute itself. The deliveries feed additionally
 * requires the local operator — it is the desktop host on this machine.
 */
import { type Context, Hono } from 'hono';
import { isBoundRuntimeLocalOperator } from '../../security/runtime-request-security.js';
import {
  type DesktopHostChannel,
  isDesktopHostSurface,
} from '../../services/notifications/delivery/desktop-host-channel.js';
import {
  NotificationPreferencesConflictError,
  NotificationPreferencesInvalidError,
  type NotificationPreferencesStore,
  preferencesRevision,
} from '../../services/notifications/notification-preferences.js';
import { isNonPersonCaller } from '../plugins/plugin-person-approval.js';

const MAX_BODY_BYTES = 256 * 1024;

export function createNotificationPreferencesRoutes(
  store: Pick<
    NotificationPreferencesStore,
    'read' | 'write' | 'patch' | 'revision'
  >,
  options: { desktopHost?: Pick<DesktopHostChannel, 'read'> } = {},
) {
  const app = new Hono();

  app.use('*', async (c, next) => {
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
      // A reset may send this back as If-Match: it then succeeds only if the
      // file is still unreadable.
      c.header('ETag', store.revision());
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
    c.header('ETag', preferencesRevision(result.preferences));
    return c.json({
      success: true,
      data: result.preferences,
      stored: result.stored,
    });
  });

  const readBody = async (
    request: Request,
    header: (name: string) => string | undefined,
  ): Promise<
    { ok: true; body: unknown } | { ok: false; status: 400 | 413 }
  > => {
    const length = Number(header('content-length') ?? '0');
    if (Number.isFinite(length) && length > MAX_BODY_BYTES)
      return { ok: false, status: 413 };
    try {
      return { ok: true, body: await request.json() };
    } catch {
      return { ok: false, status: 400 };
    }
  };

  const writeResult = (
    c: Context,
    write: () => ReturnType<NotificationPreferencesStore['write']>,
  ) => {
    try {
      const preferences = write();
      c.header('ETag', preferencesRevision(preferences));
      return c.json({ success: true, data: preferences });
    } catch (error) {
      if (error instanceof NotificationPreferencesInvalidError)
        return c.json({ success: false, error: 'invalid_preferences' }, 400);
      if (error instanceof NotificationPreferencesConflictError)
        return c.json(
          {
            success: false,
            error: 'preferences_changed',
            message:
              'The notification preferences changed since they were read. Read them again and retry.',
          },
          412,
        );
      return c.json({ success: false, error: 'preferences_write_failed' }, 500);
    }
  };

  app.put('/preferences', async (c) => {
    const body = await readBody(c.req.raw, (name) => c.req.header(name));
    if (!body.ok)
      return c.json(
        { success: false, error: 'invalid_preferences' },
        body.status,
      );
    const ifMatch = c.req.header('if-match');
    return writeResult(c, () =>
      store.write(body.body, ifMatch === undefined ? {} : { ifMatch }),
    );
  });

  app.patch('/preferences', async (c) => {
    const body = await readBody(c.req.raw, (name) => c.req.header(name));
    if (!body.ok)
      return c.json(
        { success: false, error: 'invalid_preferences' },
        body.status,
      );
    const ifMatch = c.req.header('if-match');
    return writeResult(c, () =>
      store.patch(body.body, ifMatch === undefined ? {} : { ifMatch }),
    );
  });

  app.get('/deliveries', (c) => {
    if (!options.desktopHost)
      return c.json({ success: false, error: 'unavailable' }, 404);
    if (!isBoundRuntimeLocalOperator(c.req.raw))
      return c.json(
        {
          success: false,
          error: 'local_operator_required',
          message: "Only this computer's Station host reads its delivery feed.",
        },
        403,
      );
    const surface = c.req.query('surface');
    const afterText = c.req.query('after') ?? '0';
    const epoch = c.req.query('epoch');
    const after = Number(afterText);
    if (
      !isDesktopHostSurface(surface) ||
      !/^\d{1,15}$/.test(afterText) ||
      (epoch !== undefined && !/^[A-Za-z0-9-]{1,64}$/.test(epoch))
    )
      return c.json({ success: false, error: 'invalid_request' }, 400);
    return c.json({
      success: true,
      data: options.desktopHost.read(surface, after, epoch),
    });
  });

  return app;
}
