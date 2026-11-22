/**
 * Which session a notification is about — the ONE derivation both the
 * in-app read gate (`routes/operations/notifications.ts`, which filters the
 * list/SSE by the per-session read check) and the delivery router's
 * audience use (#2586). A notification that names a session may only reach
 * a surface whose principal can read that session, whatever its audience.
 */
import { isNativePushSessionReference } from '@kontourai/station-contracts/native-push';
import type {
  Notification,
  NotificationEnvelopeV1,
} from '@kontourai/station-contracts/notification';

const METADATA_SESSION_KEYS = [
  'sessionId',
  'conversationId',
  'threadId',
  'gen_ai.conversation.id',
  'station.agent_telemetry.session_id',
] as const;

/** The session named in the record's metadata (legacy producers). */
export function notificationMetadataSessionId(
  notification: Pick<Notification, 'metadata'>,
): string | undefined {
  const metadata = notification.metadata;
  if (!metadata) return undefined;
  for (const key of METADATA_SESSION_KEYS) {
    const value = metadata[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * The metadata session first (what the in-app gate reads), else the
 * session an envelope names: its session-readers audience, its session
 * target, or its agent source.
 */
export function notificationSessionIdentity(
  notification: Pick<Notification, 'metadata'>,
  envelope?: NotificationEnvelopeV1,
): string | undefined {
  const fromMetadata = notificationMetadataSessionId(notification);
  if (fromMetadata) return fromMetadata;
  if (!envelope) return undefined;
  if (envelope.audience.kind === 'session-readers')
    return envelope.audience.sessionId;
  if (envelope.target?.kind === 'session') return envelope.target.sessionId;
  if (envelope.source.kind === 'agent') return envelope.source.sessionId;
  return undefined;
}

/**
 * The session opening a record goes to, on every channel:
 * none for a path target (it opens its path), else
 * {@link notificationSessionIdentity} — the session the read gate and the
 * audience were checked against — with the metadata's Project unless the
 * metadata names a different session. The OS links (`notificationOpenLink`)
 * and the phones' sealed session references (FCM, APNs) all read this.
 */
export function notificationOpenSession(
  notification: Pick<Notification, 'metadata'>,
  envelope?: NotificationEnvelopeV1,
): { sessionId: string; projectSlug?: string } | undefined {
  if (envelope?.target?.kind === 'path') return undefined;
  const sessionId = notificationSessionIdentity(notification, envelope);
  if (!sessionId) return undefined;
  const projectSlug = notification.metadata?.projectSlug;
  const metadataSession = notificationMetadataSessionId(notification);
  return (metadataSession === undefined || metadataSession === sessionId) &&
    typeof projectSlug === 'string' &&
    projectSlug.trim()
    ? { sessionId, projectSlug }
    : { sessionId };
}

/**
 * {@link notificationOpenSession} as the phones' sealed session reference
 * (FCM and APNs alerts): only ids in the contract grammar travel, and a
 * Project slug outside it is left off.
 */
export function nativeSessionReference(
  notification: Pick<Notification, 'metadata'>,
  envelope?: NotificationEnvelopeV1,
): { session_id?: string; project_slug?: string } {
  const session = notificationOpenSession(notification, envelope);
  if (!session || !isNativePushSessionReference(session.sessionId)) return {};
  return {
    session_id: session.sessionId,
    ...(isNativePushSessionReference(session.projectSlug)
      ? { project_slug: session.projectSlug }
      : {}),
  };
}
