import {
  LIVE_NOTIFICATION_STATUSES,
  useAttentionQuery,
  useDismissNotificationMutation,
  useNotificationActionMutation,
  useNotificationsQuery,
} from '@kontourai/station-sdk';
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { nextTabIndex } from '../../utils/tab-navigation';

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
import { toastStore } from '../../contexts/ToastContext';
import { useNotificationAnswerability } from '../../hooks/useNotificationAnswerability';
import {
  attentionCountLabel,
  pendingAttentionItems,
  suppressMirroredNotifications,
} from '../../utils/attention';
import { sortNotifications } from '../../utils/notifications';
import { AttentionHistoryItem } from '../attention/AttentionHistoryItem';
import { Button } from '../Button';
import { ResponsiveDialogSurface } from '../ResponsiveDialogSurface';
import { describeReadFailure, Empty, ErrorState, SkeletonList } from '../state';
import { useSheetGesturesPreview } from '../useResponsiveSheetGesture';
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
import { useIsMobile } from '../../hooks/useIsMobile';
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
  const { apiBase, connectionId } = useApiBase();
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
  const holdFocus = () => dropdownRef.current?.focus({ preventScroll: true });
  const [dismissals, setDismissals] = useState<
    Record<string, 'undoable' | 'saving' | 'saved'>
  >({});
  const dismissTimers = useRef(
    new Map<string, { timer: number; commit: () => void }>(),
  );
  const scope = JSON.stringify([connectionId, apiBase]);
  const currentScope = useRef(scope);
  currentScope.current = scope;

  useEffect(() => {
    void scope;
    setDismissals({});
    const timers = dismissTimers.current;
    return () => {
      for (const { timer, commit } of timers.values()) {
        window.clearTimeout(timer);
        commit();
      }
      timers.clear();
    };
  }, [scope]);

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
      )
        .filter((item) => dismissals[item.id] !== 'saved')
        .slice(0, SECTION_ROW_LIMIT),
    [attention?.items, dismissals, notifications, snooze.enabled],
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
  const observedPending = pendingAttentionItems(attention?.items ?? []);
  const pendingItems = observedPending.filter(
    (item) =>
      item.kind !== 'approval' ||
      dismissals[item.source.notificationId] !== 'saved',
  );
  const attentionItems = pendingItems.slice(0, SECTION_ROW_LIMIT);
  const pendingTotal =
    (attention?.pendingCount ?? 0) -
    (observedPending.length - pendingItems.length);
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

  // #4404 (A43): a phone gets a bottom sheet over a dimmed page, exposed as
  // a dialog, instead of a cramped popover over the page's own controls.
  const isSheet = useIsMobile();
  const sheetGestures = useSheetGesturesPreview();
  useClickOutside(isOpen && !isSheet, dropdownRef, onClose);
  // Portalled to the document, so the popover is no longer next to its trigger
  // in tab order; move focus in on open and hand it back on close.
  useMenuFocus(isOpen && !isSheet, onClose, dropdownRef);
  useEffect(() => {
    void dismissals;
    setDismissals((current) => {
      const tracked = Object.entries(current);
      const remaining = tracked.filter(
        ([id, phase]) =>
          phase !== 'saved' ||
          notifications.some((item) => item.id === id) ||
          pendingAttentionItems(attention?.items ?? []).some(
            (item) =>
              item.kind === 'approval' && item.source.notificationId === id,
          ),
      );
      return remaining.length === tracked.length
        ? current
        : Object.fromEntries(remaining);
    });
  }, [attention?.items, dismissals, notifications]);
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
    const schedulerAction =
      notification?.source === 'scheduler' &&
      actionId === 'view-scheduler' &&
      (notification.category === 'job-failure' ||
        notification.category === 'external-monitor');
    const ownLink =
      (ownApproval || schedulerAction) && typeof metadata?.link === 'string'
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
  const clearDismissal = (id: string) =>
    setDismissals(({ [id]: _removed, ...current }) => current);

  const dismiss = (id: string) => {
    if (dismissTimers.current.has(id)) return;
    // The row menu restored focus to its trigger. Move it into the popover
    // before replacing that trigger with Undo, so focusout keeps it open.
    holdFocus();
    setDismissals((current) => ({ ...current, [id]: 'undoable' }));
    const commit = () => {
      if (currentScope.current !== scope) return;
      if (
        document.activeElement
          ?.closest('[data-dismissal-id]')
          ?.getAttribute('data-dismissal-id') === id
      )
        holdFocus();
      setDismissals((current) => ({ ...current, [id]: 'saving' }));
      void dismissMutation.mutateAsync(id).then(
        () => {
          if (currentScope.current === scope)
            setDismissals((current) => ({ ...current, [id]: 'saved' }));
        },
        () => {
          if (currentScope.current !== scope) return;
          clearDismissal(id);
          toastStore.show('Could not dismiss the notification. Try again.');
        },
      );
    };
    const timer = window.setTimeout(() => {
      dismissTimers.current.delete(id);
      commit();
    }, UNDO_WINDOW_MS);
    dismissTimers.current.set(id, { timer, commit });
  };

  const undoDismiss = (id: string) => {
    const pending = dismissTimers.current.get(id);
    if (!pending) return;
    window.clearTimeout(pending.timer);
    dismissTimers.current.delete(id);
    holdFocus();
    clearDismissal(id);
  };

  const dismissalFor = (id: string) => {
    const phase = dismissals[id];
    return (
      phase && (
        <DismissedRow
          key={id}
          id={id}
          activity={recentNotifications.some((row) => row.id === id)}
          onUndo={phase === 'undoable' ? () => undoDismiss(id) : undefined}
        />
      )
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
        attentionItems.map(
          (item) =>
            (item.kind === 'approval' &&
              dismissalFor(item.source.notificationId)) || (
              <AttentionHistoryItem
                key={item.id}
                item={item}
                isPending={actionMutation.isPending}
                isDismissPending={false}
                onAction={act}
                onClose={onClose}
                onDismiss={dismiss}
                onManagementStart={holdFocus}
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
      recentNotifications.map(
        (notification) =>
          dismissalFor(notification.id) || (
            <NotificationHistoryItem
              key={notification.id}
              onOpen={onClose}
              onManagementStart={holdFocus}
              notification={notification}
              answerability={answerabilityFor(notification)}
              isActionPending={actionMutation.isPending}
              isDismissPending={false}
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

  const content = (
    <>
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
    </>
  );
  if (isSheet) {
    return (
      <ResponsiveDialogSurface
        onClose={onClose}
        ariaLabelledBy="notification-history-title"
        layer="dialog"
        overlayClassName="notification-history-overlay"
        panelClassName={`notification-history notification-history--sheet${sheetGestures ? ' notification-history--with-handle' : ''}`}
      >
        <div
          className="notification-history__sheet-content"
          ref={dropdownRef}
          tabIndex={-1}
        >
          {content}
        </div>
      </ResponsiveDialogSurface>
    );
  }
  return createPortal(
    <div ref={dropdownRef} className="notification-history" tabIndex={-1}>
      {content}
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
      {INBOX_TABS.map(({ id, label }, index) => {
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
              const nextIndex = nextTabIndex(
                index,
                INBOX_TABS.length,
                event.key,
              );
              if (nextIndex === null) return;
              event.preventDefault();
              const next = INBOX_TABS[nextIndex];
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
function DismissedRow({
  id,
  activity,
  onUndo,
}: {
  id: string;
  activity: boolean;
  onUndo?: () => void;
}) {
  const message = activity
    ? onUndo
      ? 'Notification dismissed'
      : 'Dismissing notification…'
    : onUndo
      ? 'Marked done'
      : 'Marking done…';
  return (
    <div
      className="notification-history__dismissed"
      role="status"
      data-dismissal-id={id}
    >
      <span className="notification-history__dismissed-label">{message}</span>
      {onUndo && (
        <button
          type="button"
          className="notification-history__undo"
          onClick={onUndo}
        >
          Undo
        </button>
      )}
    </div>
  );
}
