import type { AttentionItem } from '@kontourai/station-sdk';
import { useAcknowledgeAttentionItemMutation } from '@kontourai/station-sdk';
import type { ReactNode } from 'react';
import {
  attentionKindLabel,
  isPeerHostedAttentionItem,
  peerAttentionElsewhereText,
  sessionFailureCause,
} from '../../utils/attention';
import {
  acknowledgeThenOpen,
  isPlainLeftClick,
  navigateToAttentionTarget,
} from '../../utils/attentionOpen';
import { formatNotificationTime } from '../../utils/notifications';
import {
  InboxContextLine,
  type InboxContextPart,
} from '../notifications/inboxContext';
import {
  attentionKindMark,
  InboxMarkTile,
} from '../notifications/inboxPresentation';
import { RowMenu, type RowMenuItem } from '../notifications/RowMenu';
import { ExactRequestInline } from './ExactRequestInline';
import {
  ACKNOWLEDGE_ATTENTION_ACTION,
  DISMISS_NOTIFICATION_ACTION,
} from './notificationRowActions';

type SessionFailedItem = Extract<AttentionItem, { kind: 'session-failed' }>;

export function AttentionHistoryItem({
  item,
  isPending,
  isDismissPending,
  onAction,
  onClose,
  onDismiss,
  context = [],
  feedback,
  menuItems = [],
}: {
  item: AttentionItem;
  isPending: boolean;
  isDismissPending: boolean;
  onAction: (notificationId: string, actionId: string) => void;
  onClose: () => void;
  onDismiss: (notificationId: string) => void;
  /** Station · Project · Chat · Agent · Engine, from `useInboxContext`. */
  context?: readonly InboxContextPart[];
  /** This row's own action outcome (an error with its recovery), if any. */
  feedback?: ReactNode;
  /** Extra items for the row's ⋯ menu (snooze), before its dismiss. */
  menuItems?: readonly RowMenuItem[];
}) {
  /*
   * archive#3203: this row used to be the kind eyebrow and the title, and
   * nothing else — so the projection's `body` (the failure's own cause) and
   * `updatedAt` were both carried to this surface and dropped. The body, the
   * time and now the context line are the same fields `AttentionCard` and
   * `NotificationHistoryItem` render, in the same layout, so the kinds of row
   * in one popover cannot drift apart.
   *
   * Layout: the meta line ends in the time and the row's ⋯ menu (snooze,
   * dismiss) on every row; the footer holds only the row's actions, right
   * aligned with the primary one last, and is absent when there are none.
   */
  const exactRequest =
    item.kind === 'approval' ? item.requestReference : undefined;
  // archive#1914: a failed session has no notification to delete; its
  // dismissal acknowledges this version of the failure, safe to send at once.
  const acknowledge = useAcknowledgeAttentionItemMutation();
  // archive#3779: both labels come from the shared action model.
  const dismissItem: RowMenuItem[] =
    item.kind === 'approval'
      ? [
          {
            id: 'dismiss',
            label: DISMISS_NOTIFICATION_ACTION.label,
            disabled: isDismissPending,
            onSelect: () => onDismiss(item.source.notificationId),
          },
        ]
      : item.kind === 'session-failed'
        ? [
            {
              id: 'dismiss',
              label: ACKNOWLEDGE_ATTENTION_ACTION.label,
              disabled: acknowledge.isPending,
              onSelect: () => acknowledge.mutate(item.id),
            },
          ]
        : [];
  const openLink = (
    <>
      {item.kind === 'session-failed' ? (
        <FailedSessionOpenLink item={item} onClose={onClose} />
      ) : (
        item.openHref && (
          <a
            className="notification-history__action"
            href={item.openHref}
            onClick={onClose}
          >
            {isPeerHostedAttentionItem(item)
              ? 'Open in Activity'
              : openLinkLabel(item.kind)}
          </a>
        )
      )}
    </>
  );
  return (
    <div className="notification-history__item">
      <InboxMarkTile mark={attentionKindMark(item.kind)} />
      <div className="notification-history__item-content">
        <div className="notification-history__meta">
          <span className="notification-history__eyebrow">
            {attentionKindLabel(item.kind)}
          </span>
          <span className="notification-history__corner">
            <time
              className="notification-history__time"
              dateTime={item.updatedAt}
            >
              {formatNotificationTime(item.updatedAt)}
            </time>
            <RowMenu items={[...menuItems, ...dismissItem]} />
          </span>
        </div>
        <div className="notification-history__item-title">{item.title}</div>
        {item.kind === 'session-failed' ? (
          <div
            className="notification-history__detail notification-history__detail--cause"
            data-testid="attention-cause"
          >
            {sessionFailureCause(item)}
          </div>
        ) : (
          item.body && (
            <div className="notification-history__detail">{item.body}</div>
          )
        )}
        {/* The popover offers no reply, but its row must not read as one
            to answer here: say where, as the inbox card and detail do. */}
        {isPeerHostedAttentionItem(item) && (
          <div
            className="notification-history__detail"
            data-testid="attention-peer-elsewhere"
          >
            {peerAttentionElsewhereText(item.environmentName)}
          </div>
        )}
        <InboxContextLine parts={context} compact />
        {feedback}
        {exactRequest ? (
          <ExactRequestInline
            reference={exactRequest}
            openHref={item.openHref}
            onOpen={onClose}
            open={openLink}
          />
        ) : (
          <div className="notification-history__footer-row">
            <div className="notification-history__actions">
              {openLink}
              {/* Only reached without an exact request: that one answers
                  through its inline decision, never this generic action. */}
              {item.kind === 'approval' &&
                item.actions.map((action) => (
                  <button
                    key={action.id}
                    type="button"
                    className="notification-history__action"
                    data-variant={action.variant ?? 'secondary'}
                    onClick={() =>
                      onAction(item.source.notificationId, action.id)
                    }
                    disabled={isPending}
                  >
                    {action.label}
                  </button>
                ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * archive#3203: opening a `session-failed` row records the same
 * acknowledgement its Dismiss does, so the badge decrements for the row the
 * user actually acted on — and only that row.
 *
 * Its own component so the acknowledge mutation is only constructed for the
 * one kind that can use it. Every other kind keeps the plain anchor above:
 * none of them has an acknowledgement to record, and the projection discards
 * one recorded against them (`decorateAcknowledgement` returns early), so
 * firing it there would be a write that claims the row was seen and changes
 * nothing.
 */
function FailedSessionOpenLink({
  item,
  onClose,
}: {
  item: SessionFailedItem;
  onClose: () => void;
}) {
  const mutation = useAcknowledgeAttentionItemMutation();
  const href = item.openHref;
  return (
    <a
      className="notification-history__action"
      href={href}
      onClick={(event) => {
        onClose();
        if (!isPlainLeftClick(event)) return;
        event.preventDefault();
        void acknowledgeThenOpen({
          acknowledge: () => mutation.mutateAsync(item.id),
          navigate: () => navigateToAttentionTarget(href),
        });
      }}
    >
      {openLinkLabel(item.kind)}
    </a>
  );
}

function openLinkLabel(kind: AttentionItem['kind']): string {
  switch (kind) {
    case 'gate-route-back':
    case 'gate-blocked':
    case 'gate-exception':
      return 'Open flow console';
    case 'device-pairing':
      return 'Review device request';
    // #1536 D8: the requirement's route out, not a session.
    case 'setup-incomplete':
      return 'Open model connections';
    // #2064 review LOW-5: neither kind has a session behind it — the change
    // and the review session both open in Review, which is where the link
    // goes. Same labels the live cards use.
    case 'proposed-change':
      return 'Open in Review';
    case 'gate-review':
      return 'Open review';
    // #2323 S5: the proposal opens on the Plugins page.
    case 'tool-request':
      return 'Review tool request';
    case 'plugin-lifecycle-proposal':
      return 'Open in Plugins';
    default:
      return 'Open session';
  }
}
