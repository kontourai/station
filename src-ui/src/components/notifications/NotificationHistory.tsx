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
 * budget, not a fact about the data — archive#3222: the moment it bites, the
 * heading has to say so, because the number the reader arrived from is the
 * bell badge and the badge counts the whole pending set.
 */
const SECTION_ROW_LIMIT = 5;

import { useApiBase } from '../../contexts/ApiBaseContext';
import { useNotificationAnswerability } from '../../hooks/useNotificationAnswerability';
import {
  attentionCountLabel,
  pendingAttentionItems,
  suppressMirroredNotifications,
} from '../../utils/attention';
import { sortNotifications } from '../../utils/notifications';
import { AttentionHistoryItem } from '../attention/AttentionHistoryItem';
import { Button } from '../Button';
import { describeReadFailure, Empty, ErrorState, SkeletonList } from '../state';
import { DecisionError } from './DecisionError';
import { useInboxContext } from './inboxContext';
import { NotificationHistoryItem } from './NotificationHistoryItem';
import {
  isDeferredNotification,
  snoozeMenuItems,
  useInboxSnooze,
} from './snooze';
import './NotificationHistory.css';
import { createPortal } from 'react-dom';
import { useMenuFocus } from '../../hooks/useMenuFocus';
import { openApprovalConversation } from '../../lib/openApprovalConversation';

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
  // "All caught up" is the most definitive empty state in the app —
  // a reassurance — and BOTH reads settle with no data when they fail, so a
  // failed read told the user there was nothing waiting on them. The failure
  // outranks the reassurance.
  const listsError = notificationsError ?? attentionError;
  /**
   * "All caught up" is a claim about the data, so it may only render once the
   * data it describes has actually arrived. This panel used to be mounted for
   * the app's whole lifetime, which kept both queries warm and hid the gap;
   * now that it mounts on first open (archive#2751) the first paint genuinely
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
  // archive#1780: the row the attention projection correctly dropped lands
  // in "Recent activity" below. It is annotated here, never filtered again.
  const answerabilityFor = useNotificationAnswerability();
  const contextFor = useInboxContext();
  const [rowErrors, setRowErrors] = useState<
    Record<string, { actionId: string; error: unknown; href?: string }>
  >({});
  const snooze = useInboxSnooze();
  const recentNotifications = useMemo(
    () =>
      suppressMirroredNotifications(
        sortNotifications(
          // A snoozed notification has not come back yet, so it is not
          // recent activity; the page's Snoozed section lists it.
          snooze.enabled
            ? notifications.filter(
                (notification) => !isDeferredNotification(notification),
              )
            : notifications,
        ),
        attention?.items ?? [],
      ).slice(0, SECTION_ROW_LIMIT),
    [attention?.items, notifications, snooze.enabled],
  );
  /**
   * archive#3222 / archive#3227 A5. `AttentionProjection.items` keeps
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

  /**
   * One list at a time. The two used to stack in a 400px popover, so
   * "Recent activity" sat below the fold of a single failure row and was
   * effectively never seen. Until the reader picks a tab, it follows the
   * data: the attention list when anything needs them, activity otherwise.
   */
  const [chosenTab, setChosenTab] = useState<InboxTab | null>(null);
  const tab: InboxTab =
    chosenTab ?? (attentionItems.length > 0 ? 'attention' : 'activity');

  useClickOutside(isOpen, dropdownRef, onClose);
  // Portalled to the document, so the popover is no longer next to its trigger
  // in tab order; move focus in on open and hand it back on close.
  useMenuFocus(isOpen, onClose, dropdownRef);
  if (!isOpen) return null;

  const itemCount = attentionItems.length + recentNotifications.length;
  const viewAll = () => {
    onViewAll();
    onClose();
  };
  const act = (notificationId: string, actionId: string) => {
    const item = attentionItems.find(
      (candidate) =>
        candidate.kind === 'approval' &&
        candidate.source.notificationId === notificationId,
    );
    const notification = notifications.find(
      (candidate) => candidate.id === notificationId,
    );
    const metadata = notification?.metadata;
    const ownApproval =
      notification?.source === 'approval-inbox' &&
      notification.category === 'approval-request';
    const ownLink =
      ownApproval && typeof metadata?.link === 'string'
        ? metadata.link
        : undefined;
    const ownThread =
      ownApproval && typeof metadata?.threadId === 'string'
        ? metadata.threadId
        : undefined;
    const href =
      item?.openHref ??
      ownLink ??
      (ownThread
        ? `/?chat=${encodeURIComponent(ownThread)}&dock=open`
        : undefined);
    setRowErrors(({ [notificationId]: _cleared, ...rest }) => rest);
    actionMutation.mutate(
      { actionId, id: notificationId },
      {
        // The failure belongs to the row that was acted on, not to a banner
        // over the whole tray that cannot say which decision it means.
        onError: (error) =>
          setRowErrors((current) => ({
            ...current,
            [notificationId]: { actionId, error, href },
          })),
        onSuccess: () => {
          if (href) {
            openApprovalConversation(href);
            onClose();
          }
        },
      },
    );
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

  const feedbackFor = (notificationId: string) => {
    const failure = rowErrors[notificationId];
    if (!failure) return undefined;
    return (
      <DecisionError
        error={failure.error}
        onRetry={() => act(notificationId, failure.actionId)}
        openHref={failure.href}
        onOpen={onClose}
      />
    );
  };

  const attentionPanel = (
    <>
      {attentionItems.length === 0 ? (
        /* empty-state action: notifications require no user setup */
        <Empty variant="compact" label="Nothing needs you right now" />
      ) : (
        attentionItems.map((item) =>
          pendingDismiss.includes(item.id) ? (
            <DismissedRow key={item.id} onUndo={() => undoDismiss(item.id)} />
          ) : (
            <AttentionHistoryItem
              key={item.id}
              item={item}
              isPending={actionMutation.isPending}
              isDismissPending={dismissMutation.isPending}
              onAction={act}
              onClose={onClose}
              onDismiss={dismiss}
              context={contextFor.forAttention(item)}
              menuItems={
                snooze.enabled
                  ? snoozeMenuItems(
                      (until) => snooze.attention(item, until),
                      snooze.pending,
                    )
                  : undefined
              }
              feedback={
                item.kind === 'approval'
                  ? feedbackFor(item.source.notificationId)
                  : undefined
              }
            />
          ),
        )
      )}
      {/* archive#3222: the moment the row budget bites, say so — the reader
          arrived from the bell badge, which counts the whole pending set. */}
      {attentionItems.length !== pendingTotal && attentionCount && (
        <p className="notification-history__more" role="status">
          Showing {attentionCount}.{' '}
          <button
            type="button"
            className="notification-history__link"
            onClick={viewAll}
          >
            See all
          </button>
        </p>
      )}
    </>
  );
  const activityPanel =
    recentNotifications.length === 0 ? (
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
            context={contextFor.forNotification(notification)}
            menuItems={
              snooze.enabled
                ? snoozeMenuItems(
                    (until) => snooze.notification(notification, until),
                    snooze.pending,
                  )
                : undefined
            }
            feedback={feedbackFor(notification.id)}
          />
        ),
      )
    );

  // Portalled out of the header: the mobile toolbar is a stacking context at
  // z-index 200, so this popover's z-index could never lift it above the fixed
  // coding tabs and dock while it rendered inside.
  return createPortal(
    <div ref={dropdownRef} className="notification-history" tabIndex={-1}>
      <div className="notification-history__header">
        <h2
          id="notification-history-title"
          className="notification-history__title"
        >
          Notifications
        </h2>
        <div className="notification-history__header-actions">
          <button
            type="button"
            className="notification-history__link"
            onClick={viewAll}
          >
            View all notifications
          </button>
        </div>
      </div>
      {itemCount === 0 ? (
        <div className="notification-history__content">
          {listsLoading ? (
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
            <Empty
              variant="compact"
              label="All caught up"
              description="Approvals, failures, and finished work show up here."
            />
          )}
        </div>
      ) : (
        <>
          <InboxTabs
            tab={tab}
            onChange={setChosenTab}
            attentionBadge={attentionCount}
          />
          <div
            className="notification-history__content"
            role="tabpanel"
            id={`notification-history-panel-${tab}`}
            aria-labelledby={`notification-history-tab-${tab}`}
          >
            {tab === 'attention' ? attentionPanel : activityPanel}
          </div>
        </>
      )}
    </div>,
    document.body,
  );
}

type InboxTab = 'attention' | 'activity';

const INBOX_TABS: { id: InboxTab; label: string }[] = [
  { id: 'attention', label: 'Needs attention' },
  { id: 'activity', label: 'Activity' },
];

/**
 * A two-tab strip with roving arrow-key focus (WAI-ARIA tabs pattern). The
 * attention tab's chip is `attentionCountLabel`'s output — the badge's own
 * number, or "shown of total" when the row budget bites (archive#3222) — so
 * the tab carries what the old section heading did.
 */
function InboxTabs({
  tab,
  onChange,
  attentionBadge,
}: {
  tab: InboxTab;
  onChange: (tab: InboxTab) => void;
  attentionBadge: string | null;
}) {
  return (
    <div
      className="notification-history__tabs"
      role="tablist"
      aria-label="Notification lists"
    >
      {INBOX_TABS.map(({ id, label }) => {
        const selected = id === tab;
        return (
          <button
            key={id}
            id={`notification-history-tab-${id}`}
            type="button"
            role="tab"
            className="notification-history__tab"
            aria-selected={selected}
            aria-controls={`notification-history-panel-${id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(id)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
                return;
              }
              event.preventDefault();
              const next = INBOX_TABS.find((candidate) => candidate.id !== id);
              if (!next) return;
              onChange(next.id);
              document
                .getElementById(`notification-history-tab-${next.id}`)
                ?.focus();
            }}
          >
            {label}
            {id === 'attention' && attentionBadge && (
              <>
                {' '}
                <span className="notification-history__tab-count">
                  {attentionBadge}
                </span>
              </>
            )}
          </button>
        );
      })}
    </div>
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
