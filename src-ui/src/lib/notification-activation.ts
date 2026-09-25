import type {
  Notification,
  NotificationEnvelopeV1,
  NotificationSource,
} from '@kontourai/station-contracts/notification';
import { markNotificationRead } from '@kontourai/station-sdk/notification-read';
import { readNotificationEnvelope } from '@kontourai/station-shared/notification-envelope';
import { navigationStore } from '../contexts/NavigationContext';
import { CLIENT_DOCUMENT_SESSION_ID } from '../hooks/clientDocumentSession';

/** `from <agent> · session <id>` — derived from the envelope, never the title. */
export function agentAttributionLabel(
  source: Extract<NotificationSource, { kind: 'agent' }>,
): string {
  const session =
    source.sessionId.length > 12
      ? source.sessionId.slice(0, 8)
      : source.sessionId;
  return `from ${source.agent ?? 'an agent'} · session ${session}`;
}

/**
 * Where opening an enveloped notification goes (#2587).
 *
 * `path` targets were validated as same-origin relative Station paths by the
 * envelope reader. A `session` target — or an agent notification with no
 * target at all, whose default is the calling session (design §2) — opens
 * that chat in the dock, the same `/?chat=…&dock=open` shape the server's
 * `resolveNotificationOpenHref` produces for a managed session.
 */
export function notificationOpenTarget(
  envelope: NotificationEnvelopeV1,
): { path: string; params?: Record<string, string> } | undefined {
  const target = envelope.target;
  if (target?.kind === 'path') return { path: target.path };
  const sessionId =
    target?.kind === 'session'
      ? target.sessionId
      : envelope.source.kind === 'agent'
        ? envelope.source.sessionId
        : undefined;
  return sessionId
    ? { path: '/', params: { chat: sessionId, dock: 'open' } }
    : undefined;
}

export interface NotificationActivationDeps {
  navigate(path: string, params?: Record<string, string>): void;
  markRead(id: string): Promise<unknown>;
}

const defaultDeps: NotificationActivationDeps = {
  navigate: (path, params) => navigationStore.navigate(path, params),
  markRead: (id) =>
    markNotificationRead({ id, clientSessionId: CLIENT_DOCUMENT_SESSION_ID }),
};

/**
 * Open an enveloped notification's target and record this client as its
 * reader. Returns false for a record with no envelope (nothing is marked:
 * a legacy record carries no read state). A failed read marker does not undo
 * the navigation the user asked for.
 */
export async function activateNotification(
  notification: Pick<Notification, 'id' | 'metadata'>,
  deps: NotificationActivationDeps = defaultDeps,
): Promise<boolean> {
  const envelope = readNotificationEnvelope(notification);
  if (!envelope) return false;
  const target = notificationOpenTarget(envelope);
  if (target) deps.navigate(target.path, target.params);
  try {
    await deps.markRead(notification.id);
  } catch {
    /* The record stays unread; the next surface to open it marks it. */
  }
  return true;
}
