import type { AttentionItem } from '@kontourai/station-sdk';
import { useAcknowledgeAttentionItemMutation } from '@kontourai/station-sdk';
import type { MouseEvent, ReactNode } from 'react';
import { useDeveloperFeatures } from '../../hooks/useDeveloperFeatures';
import {
  attentionKindLabel,
  explainSessionFailure,
  isFlowGateKind,
  isPeerHostedAttentionItem,
  peerAttentionElsewhereText,
} from '../../utils/attention';
import {
  isPlainLeftClick,
  navigateToAttentionTarget,
} from '../../utils/attentionOpen';
import {
  InboxContextLine,
  type InboxContextPart,
} from '../notifications/inboxContext';
import { attentionKindMark } from '../notifications/inboxPresentation';
import { NoticeAction } from '../notifications/NoticeAction';
import { NotificationHistoryRow } from '../notifications/NotificationHistoryRow';
import type { RowMenuItem } from '../notifications/RowMenu';
import { ExactRequestInline } from './ExactRequestInline';
import {
  ACKNOWLEDGE_ATTENTION_ACTION,
  DISMISS_NOTIFICATION_ACTION,
} from './notificationRowActions';

export function AttentionHistoryItem({
  item,
  isPending,
  isDismissPending,
  onAction,
  onClose,
  beforeAcknowledge,
  onDismiss,
  context = [],
  feedback,
  menuItems = [],
  onManagementStart,
}: {
  item: AttentionItem;
  isPending: boolean;
  isDismissPending: boolean;
  onAction: (notificationId: string, actionId: string) => void;
  onClose: () => void;
  beforeAcknowledge?: () => void;
  onDismiss: (notificationId: string) => void;
  /** Station · Project · Chat · Agent · Engine, from `useInboxContext`. */
  context?: readonly InboxContextPart[];
  /** This row's own action outcome (an error with its recovery), if any. */
  feedback?: ReactNode;
  /** Extra items for the row's ⋯ menu (snooze), before its dismiss. */
  menuItems?: readonly RowMenuItem[];
  onManagementStart?: () => void;
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
  const markDone: RowMenuItem = {
    id: 'done',
    label: ACKNOWLEDGE_ATTENTION_ACTION.label,
    disabled: acknowledge.isPending,
    onSelect: () => {
      beforeAcknowledge?.();
      acknowledge.mutate(item.id);
    },
  };
  const rowItems: RowMenuItem[] =
    item.kind === 'approval'
      ? [
          {
            id: 'dismiss',
            label: DISMISS_NOTIFICATION_ACTION.label,
            disabled: isDismissPending,
            onSelect: () => onDismiss(item.source.notificationId),
          },
          ...menuItems,
        ]
      : [...menuItems];
  // Same rule as the live card's `OpenFlowConsoleLink`.
  const { flow } = useDeveloperFeatures();
  const opensFlowConsole = isFlowGateKind(item.kind);
  const failure =
    item.kind === 'session-failed' ? explainSessionFailure(item) : null;
  const href = flow || !opensFlowConsole ? item.openHref : undefined;
  const follow = (event: MouseEvent<HTMLAnchorElement>, target: string) => {
    if (!isPlainLeftClick(event)) return;
    event.preventDefault();
    navigateToAttentionTarget(target);
    onClose();
  };
  const title = href ? (
    <a
      className="notification-row-title-link"
      href={href}
      onClick={(event) => follow(event, href)}
    >
      {item.title}
    </a>
  ) : (
    item.title
  );
  const recovery = failure?.action && (
    <a
      className="notification-history__action"
      href={failure.action.href}
      onClick={(event) => {
        if (!isPlainLeftClick(event)) return;
        event.preventDefault();
        navigateToAttentionTarget(failure.action.href);
        onClose();
      }}
    >
      {failure.action.label}
    </a>
  );
  return (
    <NotificationHistoryRow
      items={rowItems}
      onManagementStart={onManagementStart}
      title={title}
      label={attentionKindLabel(item.kind)}
      mark={attentionKindMark(item.kind)}
      updatedAt={item.updatedAt}
      primaryAction={item.kind === 'session-failed' ? markDone : undefined}
    >
      {item.kind === 'session-failed' ? (
        <>
          <div
            className="notification-history__detail notification-history__detail--cause"
            data-testid="attention-cause"
          >
            {failure?.cause}
          </div>
          {failure?.details && (
            <details
              className="notification-history__raw"
              data-testid="attention-raw"
            >
              <summary>Details</summary>
              <p>{failure.details}</p>
            </details>
          )}
        </>
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
        />
      ) : (
        <div className="notification-history__footer-row">
          <div className="notification-history__actions">
            {recovery}
            {item.kind === 'needs_input' &&
              item.inputReference &&
              !isPeerHostedAttentionItem(item) &&
              href && (
                <a
                  className="notification-history__action"
                  href={href}
                  onClick={(event) => follow(event, href)}
                >
                  Reply
                </a>
              )}
            {/* Only reached without an exact request: that one answers
                  through its inline decision, never this generic action. */}
            {item.kind === 'approval' &&
              item.actions.map((action) => (
                <NoticeAction
                  key={action.id}
                  type="button"
                  className={`notification-history__action notice-action--${action.variant ?? 'secondary'}`}
                  data-variant={action.variant ?? 'secondary'}
                  onClick={() =>
                    onAction(item.source.notificationId, action.id)
                  }
                  disabled={isPending}
                >
                  {action.label}
                </NoticeAction>
              ))}
          </div>
        </div>
      )}
    </NotificationHistoryRow>
  );
}
