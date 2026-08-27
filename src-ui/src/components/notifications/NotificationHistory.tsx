import {
  LIVE_NOTIFICATION_STATUSES,
  useAttentionQuery,
  useDismissNotificationMutation,
  useNotificationActionMutation,
  useNotificationsQuery,
} from '@kontourai/station-sdk';
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react';

/** How long a dismissed row stays undoable before it commits. */
const UNDO_WINDOW_MS = 4000;

/**
 * How many rows each section of the popover has room for. This is a display
 * budget, not a fact about the data — station#3222: the moment it bites, the
 * heading has to say so, because the number the reader arrived from is the
 * bell badge and the badge counts the whole pending set.
 */
const SECTION_ROW_LIMIT = 5;

import { useApiBase } from '../../contexts/ApiBaseContext';
import { useNotificationAnswerability } from '../../hooks/useNotificationAnswerability';
import {
  attentionCountLabel,
  pendingAttentionItems,
} from '../../utils/attention';
import { sortNotifications } from '../../utils/notifications';
import { AttentionHistoryItem } from '../attention/AttentionHistoryItem';
import { Button } from '../Button';
import { describeReadFailure, Empty, ErrorState, SkeletonList } from '../state';
import { NotificationHistoryItem } from './NotificationHistoryItem';
import './NotificationHistory.css';
import { createPortal } from 'react-dom';
import { useMenuFocus } from '../../hooks/useMenuFocus';

interface NotificationHistoryProps {
  isOpen: boolean;
  onClose: () => void;
  onViewAll: () => void;
}

export function NotificationHistory({
  isOpen,
  onClose,
  onViewAll,
}: NotificationHistoryProps) {
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { apiBase } = useApiBase();
  // The same live set the OS-alert hook watches, from the shared constant:
  // an equal set spelled in a different order is a DIFFERENT React Query key,
  // which means two cache entries and two authenticated fetches for one fact.
  const {
    data: notifications = [],
    error: notificationsError,
    isLoading: notificationsLoading,
    refetch: refetchNotifications,
  } = useNotificationsQuery({
    status: LIVE_NOTIFICATION_STATUSES,
  });
  const {
    data: attention,
    error: attentionError,
    isLoading: attentionLoading,
    refetch: refetchAttention,
  } = useAttentionQuery(apiBase);
  // Review H1. "All caught up" is the most definitive empty state in the app —
  // a reassurance — and BOTH reads settle with no data when they fail, so a
  // failed read told the user there was nothing waiting on them. The failure
  // outranks the reassurance.
  const listsError = notificationsError ?? attentionError;
  /**
   * "All caught up" is a claim about the data, so it may only render once the
   * data it describes has actually arrived. This panel used to be mounted for
   * the app's whole lifetime, which kept both queries warm and hid the gap;
   * now that it mounts on first open (station#2751) the first paint genuinely
   * has nothing yet, and an unguarded empty state would assert an inbox is
   * clear while it is still being fetched — and again after a cache eviction.
   */
  const listsLoading = notificationsLoading || attentionLoading;
  const dismissMutation = useDismissNotificationMutation();
  const [pendingDismiss, setPendingDismiss] = useState<string[]>([]);
  const dismissTimers = useRef(new Map<string, number>());

  // A pending dismiss must still land if the popover closes or unmounts —
  // otherwise closing the panel would silently cancel what the user asked for.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-scoped flush
  useEffect(() => {
    const timers = dismissTimers.current;
    return () => {
      for (const [id, timer] of timers) {
        window.clearTimeout(timer);
        dismissMutation.mutate(id);
      }
      timers.clear();
    };
    // Intentionally mount-scoped: this is an unmount flush, not a subscription.
  }, []);
  const actionMutation = useNotificationActionMutation();
  // station#1780: the row the attention projection correctly dropped lands
  // in "Recent activity" below. It is annotated here, never filtered again.
  const answerabilityFor = useNotificationAnswerability();
  const recentNotifications = useMemo(() => {
    const projected = new Set(
      (attention?.items ?? []).flatMap((item) =>
        item.kind === 'approval' ? [item.source.notificationId] : [],
      ),
    );
    return sortNotifications(notifications)
      .filter((notification) => !projected.has(notification.id))
      .slice(0, SECTION_ROW_LIMIT);
  }, [attention?.items, notifications]);
  /**
   * station#3222 / station#3227 A5. `AttentionProjection.items` keeps
   * acknowledged items on purpose — acknowledgement is history, not deletion
   * (`attention-projection.ts:225-228`) — while `pendingCount`, the number the
   * bell badge above this popover renders, counts only the unacknowledged ones
   * (`:229`). This section used to slice the raw `items`, so it listed rows the
   * badge had already stopped counting under a heading asserting they need
   * attention, and with every item acknowledged it rendered a populated
   * "Needs attention" beneath a badge that had disappeared.
   *
   * So it renders the badge's own population, through the same
   * `pendingAttentionItems` predicate the page's count uses, and labels the
   * heading through the same `attentionCountLabel` the page's heading uses.
   * `pendingTotal` is read off `pendingCount` rather than recomputed, so the
   * badge and this heading agree by construction; `narrowed` is true whenever
   * the rows on screen are not that whole set — which is the truncation
   * announcing itself, and also the only way a server/client disagreement
   * about "pending" could ever become visible instead of being clamped away.
   */
  const pendingItems = pendingAttentionItems(attention?.items ?? []);
  const attentionItems = pendingItems.slice(0, SECTION_ROW_LIMIT);
  const pendingTotal = attention?.pendingCount ?? 0;
  const attentionCount = attentionCountLabel({
    narrowed: attentionItems.length !== pendingTotal,
    pendingTotal,
    pendingVisible: attentionItems.length,
  });

  useClickOutside(isOpen, dropdownRef, onClose);
  // Portalled to the document, so the popover is no longer next to its trigger
  // in tab order; move focus in on open and hand it back on close.
  useMenuFocus(isOpen, onClose, dropdownRef);
  if (!isOpen) return null;

  const itemCount = attentionItems.length + recentNotifications.length;
  const act = (notificationId: string, actionId: string) => {
    actionMutation.mutate({ actionId, id: notificationId });
  };
  /**
   * Dismiss collapses the row in place and holds it for an undo window instead
   * of committing immediately and closing the whole popover. Acting on one
   * notification is not a reason to lose the list you were triaging, and a
   * destructive action with no way back is worse on a phone, where it is easy
   * to hit the wrong row.
   */
  const dismiss = (notificationId: string) => {
    setPendingDismiss((current) =>
      current.includes(notificationId) ? current : [...current, notificationId],
    );
    const timer = window.setTimeout(() => {
      dismissTimers.current.delete(notificationId);
      setPendingDismiss((current) =>
        current.filter((id) => id !== notificationId),
      );
      dismissMutation.mutate(notificationId);
    }, UNDO_WINDOW_MS);
    dismissTimers.current.set(notificationId, timer);
  };

  const undoDismiss = (notificationId: string) => {
    const timer = dismissTimers.current.get(notificationId);
    if (timer !== undefined) window.clearTimeout(timer);
    dismissTimers.current.delete(notificationId);
    setPendingDismiss((current) =>
      current.filter((id) => id !== notificationId),
    );
  };

  // Portalled out of the header: the mobile toolbar is a stacking context at
  // z-index 200, so this popover's z-index could never lift it above the fixed
  // coding tabs and dock while it rendered inside.
  return createPortal(
    <div ref={dropdownRef} className="notification-history" tabIndex={-1}>
      <div className="notification-history__title">Notifications</div>
      <div className="notification-history__content">
        {itemCount === 0 ? (
          listsLoading ? (
            <SkeletonList count={3} label="Loading notifications" />
          ) : listsError ? (
            <ErrorState
              variant="compact"
              title="Unable to load notifications"
              description={describeReadFailure(listsError)}
              action={
                <Button
                  size="sm"
                  onClick={() => {
                    void refetchNotifications();
                    void refetchAttention();
                  }}
                >
                  Retry
                </Button>
              }
            />
          ) : (
            /* empty-state action: notifications require no user setup */
            <Empty variant="compact" label="All caught up" />
          )
        ) : (
          <>
            {attentionItems.length > 0 && (
              <section aria-labelledby="notification-attention-heading">
                <h2
                  id="notification-attention-heading"
                  className="notification-history__section-title"
                >
                  Needs attention {attentionCount ? `(${attentionCount})` : ''}
                </h2>
                {attentionItems.map((item) =>
                  pendingDismiss.includes(item.id) ? (
                    <DismissedRow
                      key={item.id}
                      onUndo={() => undoDismiss(item.id)}
                    />
                  ) : (
                    <AttentionHistoryItem
                      key={item.id}
                      item={item}
                      isPending={actionMutation.isPending}
                      isDismissPending={dismissMutation.isPending}
                      onAction={act}
                      onClose={onClose}
                      onDismiss={dismiss}
                    />
                  ),
                )}
              </section>
            )}
            <section aria-labelledby="notification-activity-heading">
              <h2
                id="notification-activity-heading"
                className="notification-history__section-title"
              >
                Recent activity
              </h2>
              {recentNotifications.length === 0 ? (
                /* empty-state action: notifications require no user setup */
                <Empty variant="compact" label="No recent activity" />
              ) : (
                recentNotifications.map((notification) =>
                  pendingDismiss.includes(notification.id) ? (
                    <DismissedRow
                      key={notification.id}
                      onUndo={() => undoDismiss(notification.id)}
                    />
                  ) : (
                    <NotificationHistoryItem
                      key={notification.id}
                      notification={notification}
                      answerability={answerabilityFor(notification)}
                      isActionPending={actionMutation.isPending}
                      isDismissPending={dismissMutation.isPending}
                      onAction={act}
                      onDismiss={dismiss}
                    />
                  ),
                )
              )}
            </section>
          </>
        )}
      </div>
      {itemCount > 0 && (
        <div className="notification-history__footer">
          <button
            type="button"
            className="notification-history__action"
            onClick={() => {
              onViewAll();
              onClose();
            }}
          >
            View all notifications
          </button>
        </div>
      )}
    </div>,
    document.body,
  );
}

function useClickOutside(
  isOpen: boolean,
  dropdownRef: RefObject<HTMLDivElement | null>,
  onClose: () => void,
) {
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, onClose, dropdownRef]);
}

/**
 * A dismissed row, collapsed in place with an undo affordance for
 * `UNDO_WINDOW_MS` before the dismissal commits. Deliberately occupies a row
 * rather than vanishing: the list must not jump under the user's finger while
 * they are still triaging it.
 */
function DismissedRow({ onUndo }: { onUndo: () => void }) {
  return (
    <div className="notification-history__dismissed" role="status">
      <span className="notification-history__dismissed-label">Dismissed</span>
      <button
        type="button"
        className="notification-history__undo"
        onClick={onUndo}
      >
        Undo
      </button>
    </div>
  );
}
