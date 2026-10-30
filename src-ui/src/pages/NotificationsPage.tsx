import type { Notification } from '@kontourai/station-contracts/notification';
import {
  type AttentionItem,
  acknowledgeAttentionItem,
  useQueryClient,
} from '@kontourai/station-sdk';
import { useMutation } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AttentionSection } from '../components/attention/AttentionSection';
import { ACKNOWLEDGE_ATTENTION_ACTION } from '../components/attention/notificationRowActions';
import { ConfirmModal } from '../components/modals/ConfirmModal';
import { NotificationSection } from '../components/notifications/NotificationSection';
import { PageFrameActions } from '../components/page-frame';
import {
  describeReadFailure,
  Empty,
  ErrorState,
  SkeletonList,
} from '../components/state';
import { useApiBase } from '../contexts/ApiBaseContext';
import { useNavigation } from '../contexts/NavigationContext';
import { toastStore, useNotificationHistory } from '../contexts/ToastContext';
import { useAttentionInbox } from '../hooks/useAttentionInbox';
import {
  attentionKindLabel,
  countPendingAttention,
  isAcknowledgeableAttentionItem,
  pendingAttentionItems,
} from '../utils/attention';
import { errorText } from '../utils/errorText';
import { notificationCategoryLabel } from '../utils/notificationLabels';
import '../views/page-layout.css';
import './NotificationsPage.css';
import { Button } from '../components/Button';
import { SearchGlyph } from '../components/icons/Glyph';
import {
  attentionKindMark,
  InboxMarkTile,
  notificationMark,
} from '../components/notifications/inboxPresentation';
import {
  formatSnoozeUntil,
  isDeferredNotification,
  useInboxSnooze,
} from '../components/notifications/snooze';
import {
  EMPTY_NOTIFICATION_HISTORY_FILTERS,
  filterNotificationHistory,
  hasNotificationHistoryFilters,
  isNotificationHistoryDateRangeValid,
  type NotificationHistoryFilters,
  notificationHistoryCategories,
  readNotificationHistoryFilters,
  writeNotificationHistoryFilters,
} from './notificationHistoryFilters';

export function NotificationsPage() {
  const { navigate } = useNavigation();
  const { apiBase } = useApiBase();
  const inbox = useAttentionInbox();
  const [showDismissConfirm, setShowDismissConfirm] = useState(false);
  const [filters, setFilters] = useState(() =>
    readNotificationHistoryFilters(new URLSearchParams(window.location.search)),
  );
  const [approvalTarget, setApprovalTarget] = useState(
    () => new URLSearchParams(window.location.search).get('approval') ?? '',
  );
  const [pairingTarget, setPairingTarget] = useState(
    () => new URLSearchParams(window.location.search).get('pairing') ?? '',
  );
  const loadError =
    inbox.attentionQuery.error ?? inbox.notificationsQuery.error;
  const filtered = useMemo(
    () => filterNotificationHistory(inbox.items, inbox.notifications, filters),
    [filters, inbox.items, inbox.notifications],
  );
  const categories = useMemo(
    () =>
      notificationHistoryCategories(
        inbox.items,
        inbox.notifications,
        filters.categories,
      ),
    [filters.categories, inbox.items, inbox.notifications],
  );
  const filtersActive = hasNotificationHistoryFilters(filters);
  const exactApproval = useMemo(
    () =>
      approvalTarget
        ? (inbox.items.find(
            (item) =>
              item.kind === 'approval' &&
              item.source.notificationId === approvalTarget,
          ) ?? null)
        : null,
    [approvalTarget, inbox.items],
  );
  const exactApprovalNotification = useMemo(
    () =>
      approvalTarget
        ? (inbox.notifications.find(
            (notification) =>
              notification.id === approvalTarget &&
              notification.source === 'approval-inbox' &&
              notification.category === 'approval-request',
          ) ?? null)
        : null,
    [approvalTarget, inbox.notifications],
  );
  const exactPairing = useMemo(
    () =>
      pairingTarget
        ? (inbox.items.find(
            (item) =>
              item.kind === 'device-pairing' &&
              item.source.requestId === pairingTarget,
          ) ?? null)
        : null,
    [pairingTarget, inbox.items],
  );
  const attentionItems = useMemo(() => {
    const pending = pendingAttentionItems(filtered.items);
    const targets = [exactApproval, exactPairing].flatMap((item) =>
      item && !pending.some((pendingItem) => pendingItem.id === item.id)
        ? [item]
        : [],
    );
    return [...targets, ...pending];
  }, [exactApproval, exactPairing, filtered.items]);
  const dismissibleItems = attentionItems.filter(
    isAcknowledgeableAttentionItem,
  );
  const snooze = useInboxSnooze();
  // Snoozed rows leave their lists until they come back, and are listed
  // together below with the time each returns. Off while the preview is.
  const snoozedItems = useMemo(
    () =>
      snooze.enabled ? filtered.items.filter((item) => item.snoozedUntil) : [],
    [filtered.items, snooze.enabled],
  );
  const deferredNotifications = useMemo(
    () =>
      snooze.enabled
        ? filtered.notifications.filter((notification) =>
            isDeferredNotification(notification),
          )
        : [],
    [filtered.notifications, snooze.enabled],
  );
  const activityTotal = snooze.enabled
    ? inbox.notifications.filter(
        (notification) => !isDeferredNotification(notification),
      ).length
    : inbox.notifications.length;
  const activityNotifications = useMemo(() => {
    const current = filtered.notifications.filter(
      (notification) => !deferredNotifications.includes(notification),
    );
    return exactApprovalNotification &&
      !current.some(
        (notification) => notification.id === exactApprovalNotification.id,
      )
      ? [exactApprovalNotification, ...current]
      : current;
  }, [
    deferredNotifications,
    exactApprovalNotification,
    filtered.notifications,
  ]);
  const queryClient = useQueryClient();
  const dismissAllAttention = useMutation({
    // `allSettled`, not `all`: these acknowledgements are independent and
    // already persisted server-side one by one, so there is nothing to roll
    // back. Rejecting the batch on the first failure (#890 review) discarded
    // the outcome of every other item — a single failure reported the whole
    // dismissal as failed while most of it had in fact happened. Settle them
    // all, then report only what actually failed, with a count so the user
    // knows the batch was partial rather than lost.
    mutationFn: async () => {
      // #1536 D8 review M1: a standing notice is not one of these. It is
      // still true after the dismissal, the server refuses its
      // acknowledgement, and posting one anyway would report a failure for
      // every batch that contained it.
      const outcomes = await Promise.allSettled(
        dismissibleItems.map((item) =>
          acknowledgeAttentionItem(item.id, apiBase),
        ),
      );
      const failures = outcomes.filter(
        (outcome) => outcome.status === 'rejected',
      );
      if (failures.length === 0) return;
      throw new Error(
        `${failures.length} of ${outcomes.length} could not be dismissed: ${errorText(failures[0].reason)}`,
      );
    },
    // Settled, not success: a partial batch still dismissed some items, and
    // the rows that did clear must leave the inbox even though the mutation
    // reports failure. The refetch is the source of truth for what remains.
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: ['attention'] });
    },
    onSuccess: () => {
      // The confirm is answered; leaving it open re-rendered it against the
      // now-empty queue as "Dismiss 0 items needing attention?" over a page
      // that had already dismissed them — a live confirmation for an action
      // with nothing left to act on. On failure it stays open, carrying the
      // error.
      setShowDismissConfirm(false);
    },
  });

  const updateFilters = useCallback((next: NotificationHistoryFilters) => {
    const url = new URL(window.location.href);
    url.search = writeNotificationHistoryFilters(
      url.searchParams,
      next,
    ).toString();
    window.history.replaceState(window.history.state, '', url);
    setFilters(next);
  }, []);

  useEffect(() => {
    const syncFromLocation = () => {
      const params = new URLSearchParams(window.location.search);
      setFilters(readNotificationHistoryFilters(params));
      setApprovalTarget(params.get('approval') ?? '');
      setPairingTarget(params.get('pairing') ?? '');
    };
    window.addEventListener('popstate', syncFromLocation);
    return () => window.removeEventListener('popstate', syncFromLocation);
  }, []);

  // 6-OPS-23 shape: the frame a page owns is known before its data is. This
  // used to replace the WHOLE page — header, title, settings link and all —
  // with one grey sentence, so for the length of the read the route rendered
  // nothing that identified it. Header first, skeleton only the list the page
  // is actually waiting on.
  if (inbox.attentionQuery.isLoading || inbox.notificationsQuery.isLoading) {
    return (
      <div className="notifications-page">
        <NotificationsHeader
          dismissibleCount={0}
          filtered={false}
          onDismissAll={() => setShowDismissConfirm(true)}
          onOpenSettings={() =>
            navigate('/settings', { view: 'notifications' })
          }
        />
        <SkeletonList count={4} label="Loading notifications" />
        <RecentAppMessages />
      </div>
    );
  }
  // the failure branch dropped the header the wait branch above
  // deliberately preserves, so a read that failed took the route's own title,
  // Clear and Settings controls down with it. The frame a page owns does not
  // depend on the read (6-OPS-23) — in a wait OR in a failure.
  if (loadError) {
    return (
      <div className="notifications-page">
        <NotificationsHeader
          dismissibleCount={0}
          filtered={false}
          onDismissAll={() => setShowDismissConfirm(true)}
          onOpenSettings={() =>
            navigate('/settings', { view: 'notifications' })
          }
        />
        <ErrorState
          title="Unable to load notifications"
          description={describeReadFailure(loadError)}
          action={
            <Button size="sm" onClick={() => void inbox.retry()}>
              Retry
            </Button>
          }
        />
        <RecentAppMessages />
      </div>
    );
  }

  return (
    <>
      <div className="notifications-page">
        <NotificationsHeader
          dismissibleCount={dismissibleItems.length}
          filtered={filtersActive}
          onDismissAll={() => setShowDismissConfirm(true)}
          isDismissing={dismissAllAttention.isPending}
          onOpenSettings={() =>
            navigate('/settings', { view: 'notifications' })
          }
        />
        {inbox.pendingCount === 0 &&
        inbox.notifications.length === 0 &&
        // A snoozed item still has a row to lift its snooze from.
        !(snooze.enabled && inbox.items.some((item) => item.snoozedUntil)) &&
        inbox.unavailableSources.length === 0 &&
        !approvalTarget &&
        !pairingTarget ? (
          /* when BOTH regions are empty they collapse into one PROMINENT
             empty, not a paragraph floating at the top of an empty page.
             #2064 review (c): NOT when a source could not be read. This
             branch does not mount AttentionSection at all, so a partial read
             skipped the gap notice entirely and answered with the most
             confident sentence on the page — "Nothing needs your attention
             right now" on evidence that does not support it. An unreadable
             source keeps the sectioned layout, which says what it could not
             read. */
          <Empty
            variant="prominent"
            label="All caught up"
            description="Nothing needs your attention right now."
          />
        ) : (
          <>
            <NotificationHistoryFilterBar
              categories={categories}
              filters={filters}
              onChange={updateFilters}
            />
            <AttentionSection
              items={attentionItems}
              pendingTotal={inbox.pendingCount}
              pendingVisible={countPendingAttention(attentionItems)}
              filtered={filtersActive}
              focusedApprovalId={approvalTarget || undefined}
              focusedPairingRequestId={pairingTarget || undefined}
              unavailableSources={inbox.unavailableSources}
            />
            {approvalTarget && !exactApproval && !exactApprovalNotification && (
              <p role="status">
                That approval request isn’t available, and Station won’t open a
                different one in its place.
              </p>
            )}
            {pairingTarget && !exactPairing && (
              <p role="status">That pairing request is no longer available.</p>
            )}
            <NotificationSection
              notifications={activityNotifications}
              onDismiss={inbox.dismiss}
              filtered={filtersActive}
              focusedNotificationId={
                exactApproval ? undefined : approvalTarget || undefined
              }
              summary={
                <span
                  className="notifications-page__result-summary"
                  aria-live="polite"
                >
                  Showing {activityNotifications.length} of {activityTotal}{' '}
                  activity items
                </span>
              }
            />
            {snoozedItems.length + deferredNotifications.length > 0 && (
              <SnoozedSection
                items={snoozedItems}
                notifications={deferredNotifications}
                onUnsnooze={snooze.unsnooze}
              />
            )}
          </>
        )}
        <RecentAppMessages />
      </div>
      {/*
       * archive#3779: the bulk action ACKNOWLEDGES, so it keeps the word
       * "Dismiss" — read from the shared action model, which is now the only
       * place either verb is chosen. This confirm exists because the action
       * is bulk (N rows at once), not because the word was ambiguous; the
       * destructive row action has its own confirm and its own word.
       */}
      <ConfirmModal
        isOpen={showDismissConfirm}
        title={`${ACKNOWLEDGE_ATTENTION_ACTION.label} eligible attention items`}
        message={`${ACKNOWLEDGE_ATTENTION_ACTION.label} ${
          dismissibleItems.length
        } eligible item${
          dismissibleItems.length === 1 ? '' : 's'
        }${filtersActive ? ' in this view' : ''}? Activity stays.`}
        confirmLabel={`${ACKNOWLEDGE_ATTENTION_ACTION.label} eligible items`}
        variant="warning"
        onConfirm={() => {
          dismissAllAttention.mutate();
        }}
        onCancel={() => setShowDismissConfirm(false)}
        pending={dismissAllAttention.isPending}
        error={
          dismissAllAttention.error
            ? errorText(dismissAllAttention.error)
            : null
        }
      />
    </>
  );
}

function NotificationHistoryFilterBar({
  categories,
  filters,
  onChange,
}: {
  categories: string[];
  filters: NotificationHistoryFilters;
  onChange: (filters: NotificationHistoryFilters) => void;
}) {
  const active = hasNotificationHistoryFilters(filters);
  const validRange = isNotificationHistoryDateRangeValid(filters);

  return (
    <section
      className="notifications-page__filters"
      aria-label="Filter notifications"
    >
      <div className="notifications-page__filter-row">
        <label className="notifications-page__search">
          <span className="sr-only">Search</span>
          <SearchGlyph className="notifications-page__search-glyph" />
          <input
            type="search"
            className="notifications-page__search-input"
            placeholder="Search titles, details, sources…"
            value={filters.query}
            onChange={(event) =>
              onChange({ ...filters, query: event.currentTarget.value })
            }
          />
        </label>
        <div className="notifications-page__date-filter">
          <label className="notifications-page__date-field">
            <span>From</span>
            <input
              type="date"
              className="notifications-page__date-input"
              value={filters.from}
              max={filters.to || undefined}
              aria-invalid={!validRange}
              onChange={(event) =>
                onChange({ ...filters, from: event.currentTarget.value })
              }
            />
          </label>
          <label className="notifications-page__date-field">
            <span>To</span>
            <input
              type="date"
              className="notifications-page__date-input"
              value={filters.to}
              min={filters.from || undefined}
              aria-invalid={!validRange}
              onChange={(event) =>
                onChange({ ...filters, to: event.currentTarget.value })
              }
            />
          </label>
        </div>
      </div>
      {(categories.length > 0 || active) && (
        <div className="notifications-page__chip-row">
          {categories.length > 0 && (
            <fieldset className="notifications-page__category-filter">
              <legend className="sr-only">Categories</legend>
              <div className="notifications-page__category-chips">
                {categories.map((category) => {
                  const selected = filters.categories.includes(category);
                  return (
                    <button
                      key={category}
                      type="button"
                      className="notifications-page__category-chip"
                      aria-pressed={selected}
                      onClick={() =>
                        onChange({
                          ...filters,
                          categories: selected
                            ? filters.categories.filter(
                                (value) => value !== category,
                              )
                            : [...filters.categories, category],
                        })
                      }
                    >
                      {notificationCategoryLabel(category)}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          )}
          {active && (
            <button
              type="button"
              className="notifications-page__reset-filters"
              onClick={() => onChange(EMPTY_NOTIFICATION_HISTORY_FILTERS)}
            >
              Clear filters
            </button>
          )}
        </div>
      )}
      {!validRange && (
        <p className="notifications-page__filter-error" role="alert">
          From date must be on or before To date.
        </p>
      )}
    </section>
  );
}

/**
 * Everything snoozed, with when it comes back. An attention snooze can be
 * lifted here; a stored notification's snooze is a new delivery time, which
 * has no "lift" on the server, so it says when it returns and nothing more.
 */
function SnoozedSection({
  items,
  notifications,
  onUnsnooze,
}: {
  items: AttentionItem[];
  notifications: Notification[];
  onUnsnooze: (item: AttentionItem) => void;
}) {
  return (
    <section
      className="notifications-page__section"
      aria-labelledby="notifications-snoozed-heading"
    >
      <div className="notifications-page__section-heading">
        <h2
          id="notifications-snoozed-heading"
          className="notifications-page__section-title"
        >
          Snoozed ({items.length + notifications.length})
        </h2>
      </div>
      <ul className="notifications-page__snoozed">
        {items.map((item) => (
          <li key={item.id} className="notifications-page__snoozed-row">
            <InboxMarkTile mark={attentionKindMark(item.kind)} />
            <div className="notifications-page__snoozed-text">
              <span className="notifications-page__snoozed-title">
                {item.title}
              </span>
              <span className="notifications-page__snoozed-when">
                {attentionKindLabel(item.kind)} · back{' '}
                {formatSnoozeUntil(item.snoozedUntil ?? '')}
              </span>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onUnsnooze(item)}
            >
              Unsnooze
            </Button>
          </li>
        ))}
        {notifications.map((notification) => (
          <li key={notification.id} className="notifications-page__snoozed-row">
            <InboxMarkTile mark={notificationMark(notification)} />
            <div className="notifications-page__snoozed-text">
              <span className="notifications-page__snoozed-title">
                {notification.title}
              </span>
              <span className="notifications-page__snoozed-when">
                {notificationCategoryLabel(notification.category)} · back{' '}
                {formatSnoozeUntil(notification.scheduledAt ?? '')}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function RecentAppMessages() {
  const history = useNotificationHistory();
  const messages = history.filter((item) =>
    ['info', 'success', 'warning', 'error'].includes(item.type ?? 'info'),
  );
  if (!messages.length) return null;
  return (
    <section
      className="notifications-page__app-messages"
      aria-label="Recent app messages"
    >
      <div className="notifications-page__section-heading">
        <h2 className="notifications-page__section-title">
          Recent app messages
        </h2>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => toastStore.clearRecentMessages()}
        >
          Clear recent messages
        </Button>
      </div>
      <p className="notifications-page__section-note">
        Recent messages for this Station, including dismissed messages. Safe
        summaries are kept for up to seven days; actions are never saved.
      </p>
      <ol>
        {messages.map((item) => (
          <li key={item.id}>
            <div className="notifications-page__app-message-meta">
              <span
                className={`notifications-page__app-message-tone is-${item.type ?? 'info'}`}
              >
                {item.type === 'error'
                  ? 'Error'
                  : item.type === 'warning'
                    ? 'Warning'
                    : item.type === 'success'
                      ? 'Success'
                      : 'Message'}
              </span>
              <time dateTime={new Date(item.timestamp).toISOString()}>
                {new Date(item.timestamp).toLocaleTimeString([], {
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </time>
            </div>
            <p>{item.message}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function NotificationsHeader({
  dismissibleCount,
  filtered,
  onDismissAll,
  onOpenSettings,
  isDismissing = false,
}: {
  dismissibleCount: number;
  filtered: boolean;
  onDismissAll: () => void;
  onOpenSettings: () => void;
  isDismissing?: boolean;
}) {
  /**
   * The bulk action acknowledges the eligible subset of the rows this view
   * shows — never "everything outstanding". Two narrowings are invisible in
   * the row list: an active filter, and the kinds the server refuses to
   * acknowledge (standing notices, undecided reviews and gates). Naming the
   * eligible scope keeps the control from promising rows it will not touch;
   * the count stays on the confirmation, where the rows it names are visible.
   */
  const bulkLabel = `${ACKNOWLEDGE_ATTENTION_ACTION.label} eligible items${
    filtered ? ' in this view' : ''
  }`;
  return (
    <PageFrameActions>
      <Button
        variant="secondary"
        size="sm"
        onClick={onDismissAll}
        disabled={dismissibleCount === 0}
        pending={isDismissing}
        pendingLabel="Dismissing…"
      >
        {bulkLabel}
      </Button>
      <button
        type="button"
        className="notifications-page__settings"
        onClick={onOpenSettings}
      >
        Notification settings
      </button>
    </PageFrameActions>
  );
}
