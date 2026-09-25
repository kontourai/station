/**
 * Notification Routes — notification management REST API.
 */

import type { Notification } from '@kontourai/station-contracts/notification';
import {
  isHostedSessionReadAuthority,
  type SessionReadAuthority,
} from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import { resolveClientOriginForRequest } from '../../security/runtime-request-security.js';
import {
  NotificationDedupeSourceConflictError,
  NotificationReservedFieldError,
  type NotificationService,
  REST_NOTIFICATION_SOURCE,
} from '../../services/notifications/notification-service.js';
import { notificationOps } from '../../telemetry/metrics.js';
import {
  getBody,
  notificationCreateSchema,
  notificationSnoozeSchema,
  param,
  validate,
} from '../schemas/schemas.js';

export function createNotificationRoutes(
  notificationService: NotificationService,
  options: {
    /** Runtime composition mints this from immutable request ingress. */
    readAuthorityForRequest?: (request: Request) => SessionReadAuthority;
    /** Shared orchestration predicate for session-derived notification rows. */
    canReadSession?: (
      sessionId: string,
      authority: SessionReadAuthority,
    ) => boolean;
  } = {},
) {
  const app = new Hono();

  const canReadNotification = (
    notification: Notification,
    request: Request,
  ): boolean => {
    const sessionId = notificationSessionId(notification);
    // Existing personal-only constructors omit both hooks.  A partial hosted
    // composition, on the other hand, cannot make a session row public.
    if (!options.readAuthorityForRequest && !options.canReadSession)
      return true;
    const authority = options.readAuthorityForRequest?.(request);
    if (!authority) return false;
    // Notifications are persisted outside the session store. An unbound row
    // (notably scheduler/API notification sources) is not generic in hosted
    // mode: it is unreadable and mutation-proof until it has durable tenant
    // authority.
    if (!sessionId) return !isHostedSessionReadAuthority(authority);
    if (
      isHostedSessionReadAuthority(authority) &&
      !authority.tenantExecutionContext
    )
      return false;
    return options.canReadSession?.(sessionId, authority) === true;
  };

  const readableNotification = async (id: string, request: Request) => {
    const notification = (await notificationService.list()).find(
      (candidate) => candidate.id === id,
    );
    return notification && canReadNotification(notification, request)
      ? notification
      : undefined;
  };

  // List notifications (with optional status/category filters)
  app.get('/', async (c) => {
    const status = c.req.queries('status');
    const category = c.req.queries('category');
    const data = (
      await notificationService.list({
        status: status?.length ? status : undefined,
        category: category?.length ? category : undefined,
      })
    ).filter((notification) => canReadNotification(notification, c.req.raw));
    return c.json({ success: true, data });
  });

  // Schedule a new notification
  app.post('/', validate(notificationCreateSchema), async (c) => {
    const body = getBody(c);
    const provisional = {
      ...body,
      id: '',
      source: REST_NOTIFICATION_SOURCE,
    } as Notification;
    if (!canReadNotification(provisional, c.req.raw)) {
      return c.json({ success: false, error: 'Notification not found' }, 404);
    }
    // #2597: a request cannot choose its source — a caller-chosen source
    // relabels (and via a shared tag rewrites) another producer's record.
    // Every REST record is `api`. The shipped SDK labels its requests
    // `sdk`; that label is accepted and recorded as `api`. Anything else is
    // refused rather than silently relabelled.
    if (
      body.source !== undefined &&
      body.source !== REST_NOTIFICATION_SOURCE &&
      body.source !== 'sdk'
    ) {
      return c.json(
        {
          success: false,
          error: 'Notification source is set by the server for API requests',
        },
        400,
      );
    }
    let notification: Notification;
    try {
      // Hosted: namespace REST dedupe tags by the caller's tenant, so one
      // tenant's request can never update another tenant's record.
      const authority = options.readAuthorityForRequest?.(c.req.raw);
      const tenantId =
        authority && isHostedSessionReadAuthority(authority)
          ? authority.tenantExecutionContext?.tenantId
          : undefined;
      notification = await notificationService.scheduleFromRequest(
        body,
        tenantId === undefined ? {} : { tenantId },
      );
    } catch (error) {
      // Envelopes, `agent:` dedupe tags and `agent-*` categories belong to
      // the trusted enveloped path (#2583); a request body cannot claim them.
      if (error instanceof NotificationDedupeSourceConflictError) {
        return c.json(
          {
            success: false,
            error: 'Notification dedupe tag belongs to another source',
          },
          409,
        );
      }
      if (error instanceof NotificationReservedFieldError) {
        return c.json(
          {
            success: false,
            error:
              'Envelopes, metadata.dedupeTag, agent: dedupe tags and agent-* categories are reserved',
          },
          400,
        );
      }
      throw error;
    }
    notificationOps.add(1, { op: 'schedule' });
    return c.json({ success: true, data: notification }, 201);
  });

  // Clear ordinary/resolved activity while preserving active approvals.
  app.delete('/activity', async (c) => {
    const result = await notificationService.clearActivityWithOutcome(
      (notification) => canReadNotification(notification, c.req.raw),
    );
    if (result.outcome === 'action-dispatching') {
      return c.json(
        { success: false, error: 'Notification action is in progress' },
        409,
      );
    }
    return c.json({
      success: true,
      data: { clearedCount: result.clearedCount },
    });
  });

  // Dismiss a notification
  app.delete('/:id', async (c) => {
    if (!(await readableNotification(param(c, 'id'), c.req.raw))) {
      return c.json({ success: false, error: 'Notification not found' }, 404);
    }
    const result = await notificationService.dismiss(
      param(c, 'id'),
      resolveClientOriginForRequest(c.req.raw),
    );
    if (result === 'not-found') {
      return c.json({ success: false, error: 'Notification not found' }, 404);
    }
    if (result === 'action-dispatching') {
      return c.json(
        { success: false, error: 'Notification action is in progress' },
        409,
      );
    }
    return c.json({ success: true });
  });

  // Execute a notification action
  app.post('/:id/action/:actionId', async (c) => {
    if (!(await readableNotification(param(c, 'id'), c.req.raw))) {
      return c.json({ success: false, error: 'Notification not found' }, 404);
    }
    const result = await notificationService.action(
      param(c, 'id'),
      param(c, 'actionId'),
      resolveClientOriginForRequest(c.req.raw),
    );
    if (result === 'not-found') {
      return c.json({ success: false, error: 'Notification not found' }, 404);
    }
    if (result !== 'actioned') {
      return c.json(
        { success: false, error: 'Notification action is unavailable' },
        409,
      );
    }
    notificationOps.add(1, { op: 'action' });
    return c.json({ success: true });
  });

  // Snooze a notification
  app.post('/:id/snooze', validate(notificationSnoozeSchema), async (c) => {
    if (!(await readableNotification(param(c, 'id'), c.req.raw))) {
      return c.json({ success: false, error: 'Notification not found' }, 404);
    }
    const { until } = getBody(c);
    await notificationService.snooze(param(c, 'id'), until);
    return c.json({ success: true });
  });

  // Clear all notifications (legacy/public clear-all contract).
  app.delete('/', async (c) => {
    const result = await notificationService.clearAll((notification) =>
      canReadNotification(notification, c.req.raw),
    );
    if (result.outcome === 'action-dispatching') {
      return c.json(
        { success: false, error: 'Notification action is in progress' },
        409,
      );
    }
    return c.json({ success: true });
  });

  // List registered notification providers
  app.get('/providers', (c) => {
    return c.json({ success: true, data: notificationService.listProviders() });
  });

  return app;
}

function notificationSessionId(
  notification: Pick<Notification, 'metadata'>,
): string | undefined {
  const metadata = notification.metadata;
  if (!metadata) return undefined;
  for (const key of [
    'sessionId',
    'conversationId',
    'threadId',
    'gen_ai.conversation.id',
    'station.agent_telemetry.session_id',
  ]) {
    const value = metadata[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}
