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
 * - `GET /deliveries?surface=…&after=<cursor>&epoch=<epoch>` → the caller's
 *   own decided-alert feed (`DesktopHostChannel`): a paired device's
 *   `device:<id>`, or this computer's `local:desktop-<id>`.
 *
 * Operate tier (pairing-route-scopes.ts). Station's own agent tools and
 * delegated Stations are refused everywhere here: an agent that could write
 * the preferences could unmute itself.
 */
import { type Context, Hono } from 'hono';
import {
  getRuntimeAuthenticatedRequestPrincipal,
  isBoundRuntimeLocalOperator,
} from '../../security/runtime-request-security.js';
import {
  deviceSurfaceId,
  type SurfaceId,
} from '../../services/notifications/delivery/channel.js';
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
  options: {
    desktopHost?: Pick<DesktopHostChannel, 'read'>;
    /**
     * Whether a paired device may hold a delivery feed: a personal-family
     * device (the ones any audience can include). Anything else — a
     * delegated Station, a no-read-scope or account-bound device — is
     * refused before it can occupy one of the bounded feed slots. Absent
     * means no device may.
     */
    isFeedDevice?: (deviceId: string) => boolean;
  } = {},
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

  /**
   * The CALLER'S OWN feed. A paired device (remote desktop app) reads
   * `device:<its id>`, derived from its credential; a `surface` naming
   * anything else is refused. The local operator reads the
   * `local:desktop-<installationId>` surface it names. No caller can read
   * another surface's feed.
   */
  app.get('/deliveries', (c) => {
    if (!options.desktopHost)
      return c.json({ success: false, error: 'unavailable' }, 404);
    const requested = c.req.query('surface');
    const afterText = c.req.query('after') ?? '0';
    const epoch = c.req.query('epoch');
    if (
      !/^\d{1,15}$/.test(afterText) ||
      (epoch !== undefined && !/^[A-Za-z0-9-]{1,64}$/.test(epoch))
    )
      return c.json({ success: false, error: 'invalid_request' }, 400);
    const deviceId = getRuntimeAuthenticatedRequestPrincipal(
      c.req.raw,
    )?.deviceId;
    let surface: SurfaceId;
    if (deviceId !== undefined) {
      if (options.isFeedDevice?.(deviceId) !== true)
        return c.json(
          {
            success: false,
            error: 'device_not_eligible',
            message:
              "This device cannot receive Station's notifications, so it has no delivery feed.",
          },
          403,
        );
      surface = deviceSurfaceId(deviceId);
      if (requested !== undefined && requested !== surface)
        return c.json(
          {
            success: false,
            error: 'surface_not_yours',
            message: 'A device reads only its own delivery feed.',
          },
          403,
        );
    } else if (isBoundRuntimeLocalOperator(c.req.raw)) {
      if (!isDesktopHostSurface(requested))
        return c.json({ success: false, error: 'invalid_request' }, 400);
      surface = requested;
    } else {
      return c.json(
        {
          success: false,
          error: 'surface_required',
          message:
            "Only a paired device or this computer's Station host reads a delivery feed.",
        },
        403,
      );
    }
    return c.json({
      success: true,
      data: options.desktopHost.read(surface, Number(afterText), epoch),
    });
  });

  return app;
}
