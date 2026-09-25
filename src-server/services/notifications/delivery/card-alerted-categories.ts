/**
 * Which notifications the agent-activity card already announces, so a
 * per-notification alert channel on a phone that gets the card (Live
 * Activity on iOS, the card on Android) can skip exactly those and one event
 * is not alerted twice. Shared by both platforms: the Android FCM alert
 * channel (#2588) is to call the same predicate.
 *
 * The card is built from orchestration sessions only (the session read
 * model), and it alerts on an entry into approval or input and on a
 * finished, stopped or failed turn. So a notification is card-alerted only
 * when BOTH hold:
 *
 * - its category is one of those events: `approval-request`,
 *   `turn-completed`, `turn-stopped`, `turn-failed`;
 * - its record says it is about an orchestration session: `metadata.sessionKind`
 *   is `'runtime'` (what approval-inbox.ts and
 *   turn-completion-notifications.ts stamp for orchestration sessions) with
 *   a `metadata.sessionId`, and it is not a registry request
 *   (`metadata.requestKind`, when present, is `'orchestration'`).
 *
 * A registry approval (approval-registry.ts: a managed-agent tool call, an
 * MCP UI call, an ACP bridge request) is stamped `sessionKind: 'managed'`,
 * `requestKind: 'registry'`. It never writes an orchestration
 * `request.opened`, which is the only thing that puts a session on the card
 * as waiting for approval (session-lifecycle-service.ts), so it is never on
 * the card and must still alert. Anything the record does not identify as
 * orchestration-backed alerts too: a duplicate beats a silenced alert.
 *
 * The check does not look at whether this phone's card is actually on: on a
 * phone with the card turned off (or Live Activities disabled on iOS), the
 * card-alerted notifications raise no alert at all; the inbox keeps them.
 */
import type { Notification } from '@kontourai/station-contracts/notification';

const CARD_ALERTED_CATEGORIES: ReadonlySet<string> = new Set([
  'approval-request',
  'turn-completed',
  'turn-stopped',
  'turn-failed',
]);

/** The session kind orchestration-backed notifications carry. */
const ORCHESTRATION_SESSION_KIND = 'runtime';

export function isCardAlerted(
  notification: Pick<Notification, 'category' | 'metadata'>,
): boolean {
  if (!CARD_ALERTED_CATEGORIES.has(notification.category)) return false;
  const metadata = notification.metadata ?? {};
  const { sessionKind, sessionId, requestKind } = metadata as Record<
    string,
    unknown
  >;
  return (
    sessionKind === ORCHESTRATION_SESSION_KIND &&
    typeof sessionId === 'string' &&
    sessionId.length > 0 &&
    (requestKind === undefined || requestKind === 'orchestration')
  );
}
