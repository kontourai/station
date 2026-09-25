/**
 * Which notifications the agent-activity card already announces, so a
 * per-notification alert channel on a phone that gets the card (Live
 * Activity on iOS, the card on Android) can skip exactly those and one event
 * is not alerted twice. Shared by both platforms: the Android FCM alert
 * channel (#2588) is to call the same predicate.
 *
 * The card is built from the session read model (`listSessionReadModel`),
 * and it alerts on an entry into approval or input and on a turn that
 * leaves its session Done or Failed. So a notification is card-alerted only
 * when its category is one of those events (`approval-request`,
 * `turn-completed`, `turn-stopped`, `turn-failed`), its writer marked it
 * `onActivityCard: true` ({@link ON_ACTIVITY_CARD_METADATA_KEY}), AND its
 * record says it is about an orchestration session in one of two ways:
 *
 * - it is the orchestration record itself: `metadata.sessionKind` is
 *   `'runtime'` (what approval-inbox.ts and turn-completion-notifications.ts
 *   stamp for orchestration sessions) with a `metadata.sessionId`, and it is
 *   not a registry request (`metadata.requestKind`, when present, is
 *   `'orchestration'`);
 * - it is the registry twin of a Station-agent approval: an
 *   `approval-request` with `metadata.requestKind` `'registry'` whose
 *   `metadata.orchestrationThreadId` equals its `metadata.sessionId`. The
 *   Station-agent adapter relays its turns through `/chat`, and each tool
 *   approval there is registered with the approval registry (the registry
 *   notification) and republished by the adapter as the thread's
 *   `request.opened` (the card's approval and the orchestration
 *   notification). The relay names its thread (chat.ts), and
 *   stream-orchestrator.ts stamps `orchestrationThreadId` on exactly those
 *   approvals.
 *
 * The writers set `onActivityCard` from what the card is built from, at the
 * moment they write:
 *
 * - The session must be in the read model. `listSessionReadModel` leaves
 *   out ephemeral sessions (the ones inbound webhooks start), read through
 *   `OrchestrationService.isEphemeralSession`; an approval or turn in one is
 *   never on the card, so it is not marked and alerts. Its other filter,
 *   read access, is the same principal check the delivery audience applies
 *   (audience-resolver.ts), so a phone that cannot read a session gets
 *   neither the card row nor the alert.
 * - A turn terminal must leave the session in a phase the card shows
 *   (`turnTerminalOnActivityCard`): an aborted or cancelled turn folds to
 *   `canceled`, which the card leaves off, so a stopped turn (and a turn
 *   failure reported by `turn.aborted`) is not marked and alerts.
 *
 * Every other registry approval (a managed chat outside orchestration, an
 * MCP-UI call, an ACP bridge request, a Kit action) is stamped
 * `sessionKind: 'managed'`, `requestKind: 'registry'` with no
 * `orchestrationThreadId` and no `onActivityCard`. Nothing writes an
 * orchestration `request.opened` for it, which is the only thing that puts a
 * session on the card as waiting for approval (session-lifecycle-service.ts),
 * so it is not on the card and must still alert. A record that fails any of
 * the checks above alerts too, including one written before the mark
 * existed: a duplicate beats a silenced alert.
 *
 * Known edge: the registry twin is marked when the approval is registered,
 * but the adapter republishes it as `request.opened` only when the injected
 * `tool-approval-request` chunk reaches it (stream-orchestrator.ts injects
 * it at the next chunk boundary). A stream that aborts, or trips the
 * silence watchdog, between the inject and the next chunk leaves the marked
 * twin with no card entry behind it, so that approval raises no phone alert.
 * It is still in the inbox.
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

/**
 * The metadata key a writer sets to `true` when the agent-activity card
 * carries the notification's event (see the module doc for when).
 */
export const ON_ACTIVITY_CARD_METADATA_KEY = 'onActivityCard';

export function isCardAlerted(
  notification: Pick<Notification, 'category' | 'metadata'>,
): boolean {
  if (!CARD_ALERTED_CATEGORIES.has(notification.category)) return false;
  const metadata = (notification.metadata ?? {}) as Record<string, unknown>;
  if (metadata[ON_ACTIVITY_CARD_METADATA_KEY] !== true) return false;
  const { sessionKind, sessionId, requestKind, orchestrationThreadId } =
    metadata;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return false;
  if (requestKind === 'registry')
    return (
      notification.category === 'approval-request' &&
      orchestrationThreadId === sessionId
    );
  return (
    sessionKind === ORCHESTRATION_SESSION_KIND &&
    (requestKind === undefined || requestKind === 'orchestration')
  );
}
