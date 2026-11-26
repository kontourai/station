import {
  type Notification,
  type NotificationEnvelopeV1,
  type NotificationSource,
  notificationSessionHref,
} from '@kontourai/station-contracts/notification';
import { markNotificationRead } from '@kontourai/station-sdk/notification-read';
import { readNotificationEnvelope } from '@kontourai/station-shared/notification-envelope';
import { navigationStore } from '../contexts/NavigationContext';
import { CLIENT_DOCUMENT_SESSION_ID } from '../hooks/clientDocumentSession';
import { notificationOpenTarget as linkTarget } from './notificationOpen';
import { openNotificationTargetHere } from './notificationStationOpen';

export function agentAttributionLabel(
  source: Extract<NotificationSource, { kind: 'agent' }>,
  chatTitle?: string,
): string {
  const agent = `from ${source.agent ?? 'an agent'}`;
  return chatTitle ? `${agent} · ${chatTitle}` : agent;
}

/**
 * Where opening an enveloped notification goes (#2587).
 *
 * A `path` target is split by the same in-app link parser the OS channels and
 * attention links use, so a `chat` it names is marked like a tap and a
 * missing or refused conversation is reported. A `session` target — or an
 * agent notification with no
 * target at all, whose default is the calling session (design §2) — opens
 * that chat in the dock: the notification href every channel opens
 * (`notificationSessionHref`, which the server's OS links use too). A toast
 * lists the active Station's records, so it names no Station.
 */
export function notificationOpenTarget(
  envelope: NotificationEnvelopeV1,
): { path: string; params?: Record<string, string> } | undefined {
  const target = envelope.target;
  if (target?.kind === 'path') {
    const link = linkTarget(target.path);
    return link ? { path: link.pathname, params: link.params } : undefined;
  }
  const sessionId =
    target?.kind === 'session'
      ? target.sessionId
      : envelope.source.kind === 'agent'
        ? envelope.source.sessionId
        : undefined;
  if (!sessionId) return undefined;
  const href = new URL(
    notificationSessionHref({ sessionId }),
    'https://station.invalid',
  );
  return { path: href.pathname, params: Object.fromEntries(href.searchParams) };
}

export interface NotificationActivationDeps {
  navigate(path: string, params?: Record<string, string>): void;
  markRead(id: string): Promise<unknown>;
}

const defaultDeps: NotificationActivationDeps = {
  // Marked like an OS tap, so a deleted or refused conversation is reported
  // rather than cleared silently.
  navigate: (path, params) =>
    openNotificationTargetHere(path, params ?? {}, (pathname, query) =>
      navigationStore.navigate(pathname, query),
    ),
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
