import {
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
import { useNavigation } from '../contexts/NavigationContext';
import { useAttentionInbox } from '../hooks/useAttentionInbox';
import {
  countPendingAttention,
  pendingAttentionItems,
} from '../utils/attention';
import '../views/page-layout.css';
import './NotificationsPage.css';
import { Button } from '../components/Button';
import {
  EMPTY_NOTIFICATION_HISTORY_FILTERS,
  filterNotificationHistory,
  hasNotificationHistoryFilters,
  isNotificationHistoryDateRangeValid,
  type NotificationHistoryFilters,
  notificationHistoryCategories,
  notificationHistoryCategoryLabel,
  readNotificationHistoryFilters,
  writeNotificationHistoryFilters,
} from './notificationHistoryFilters';

export function NotificationsPage() {
  const { navigate } = useNavigation();
  const inbox = useAttentionInbox();
  const [showDismissConfirm, setShowDismissConfirm] = useState(false);
  const [filters, setFilters] = useState(() =>
    readNotificationHistoryFilters(new URLSearchParams(window.location.search)),
  );
  const [approvalTarget, setApprovalTarget] = useState(
    () => new URLSearchParams(window.location.search).get('approval') ?? '',
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
  const attentionItems = useMemo(() => {
    const pending = pendingAttentionItems(filtered.items);
    return exactApproval &&
      !pending.some((item) => item.id === exactApproval.id)
      ? [exactApproval, ...pending]
      : pending;
  }, [exactApproval, filtered.items]);
  const activityNotifications = useMemo(
    () =>
      exactApprovalNotification &&
      !filtered.notifications.some(
        (notification) => notification.id === exactApprovalNotification.id,
      )
        ? [exactApprovalNotification, ...filtered.notifications]
        : filtered.notifications,
    [exactApprovalNotification, filtered.notifications],
  );
  const queryClient = useQueryClient();
  const dismissAllAttention = useMutation({
    mutationFn: () =>
      Promise.all(
        attentionItems.map((item) => acknowledgeAttentionItem(item.id)),
      ),
    onSuccess: async () => {
      // The confirm is answered; leaving it open re-rendered it against the
      // now-empty queue as "Dismiss 0 items needing attention?" over a page
      // that had already dismissed them — a live confirmation for an action
      // with nothing left to act on.
      setShowDismissConfirm(false);
      await queryClient.invalidateQueries({ queryKey: ['attention'] });
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
          attentionCount={0}
          onDismissAll={() => setShowDismissConfirm(true)}
          onOpenSettings={() =>
            navigate('/settings', {
              view: 'notifications',
              highlight: 'push-notifications',
            })
          }
        />
        <SkeletonList count={4} label="Loading notifications" />
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
          attentionCount={0}
          onDismissAll={() => setShowDismissConfirm(true)}
          onOpenSettings={() =>
            navigate('/settings', {
              view: 'notifications',
              highlight: 'push-notifications',
            })
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
      </div>
    );
  }

  return (
    <>
      <div className="notifications-page">
        <NotificationsHeader
          attentionCount={attentionItems.length}
          onDismissAll={() => setShowDismissConfirm(true)}
          isDismissing={dismissAllAttention.isPending}
          onOpenSettings={() =>
            navigate('/settings', {
              view: 'notifications',
              highlight: 'push-notifications',
            })
          }
        />
        {inbox.pendingCount === 0 &&
        inbox.notifications.length === 0 &&
        !approvalTarget ? (
          /* when BOTH regions are empty they collapse into one PROMINENT
             empty, not a paragraph floating at the top of an empty page. */
          <Empty
            variant="prominent"
            label="All caught up"
            description="Nothing needs you right now, and there is no activity yet."
          />
        ) : (
          <>
            <AttentionSection
              items={attentionItems}
              pendingTotal={inbox.pendingCount}
              pendingVisible={countPendingAttention(attentionItems)}
              filtered={filtersActive}
              focusedApprovalId={approvalTarget || undefined}
            />
            {approvalTarget && !exactApproval && !exactApprovalNotification && (
              <p role="status">
                That approval request isn’t available, and Station won’t open a
                different one in its place.
              </p>
            )}
            <NotificationHistoryFilterBar
              categories={categories}
              filters={filters}
              onChange={updateFilters}
            />
            <div
              className="notifications-page__result-summary"
              aria-live="polite"
            >
              Showing {activityNotifications.length} of{' '}
              {inbox.notifications.length} activity items
            </div>
            <NotificationSection
              notifications={activityNotifications}
              onDismiss={inbox.dismiss}
              filtered={filtersActive}
              focusedNotificationId={
                exactApproval ? undefined : approvalTarget || undefined
              }
            />
          </>
        )}
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
        title={`${ACKNOWLEDGE_ATTENTION_ACTION.label} attention items`}
        message={`${ACKNOWLEDGE_ATTENTION_ACTION.label} ${
          attentionItems.length
        } item${
          attentionItems.length === 1 ? '' : 's'
        } needing attention? Activity stays.`}
        confirmLabel={`${ACKNOWLEDGE_ATTENTION_ACTION.label} all attention items`}
        variant="warning"
        onConfirm={() => {
          dismissAllAttention.mutate();
        }}
        onCancel={() => setShowDismissConfirm(false)}
        pending={dismissAllAttention.isPending}
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
      aria-labelledby="notification-filters-heading"
    >
      <div className="notifications-page__filters-heading">
        <div>
          <h2 id="notification-filters-heading">Filter history</h2>
          <p>Search attention and activity without changing what is stored.</p>
        </div>
        {active && (
          <button
            type="button"
            className="button button--link notifications-page__reset-filters"
            onClick={() => onChange(EMPTY_NOTIFICATION_HISTORY_FILTERS)}
          >
            Clear filters
          </button>
        )}
      </div>
      <label className="notifications-page__filter-field">
        <span>Search</span>
        <input
          type="search"
          className="page__search-input"
          placeholder="Search titles, details, sources…"
          value={filters.query}
          onChange={(event) =>
            onChange({ ...filters, query: event.currentTarget.value })
          }
        />
      </label>
      {categories.length > 0 && (
        <fieldset className="notifications-page__category-filter">
          <legend>Categories</legend>
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
                  {notificationHistoryCategoryLabel(category)}
                </button>
              );
            })}
          </div>
        </fieldset>
      )}
      <div className="notifications-page__date-filter">
        <label className="notifications-page__filter-field">
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
        <label className="notifications-page__filter-field">
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
      {!validRange && (
        <p className="notifications-page__filter-error" role="alert">
          From date must be on or before To date.
        </p>
      )}
    </section>
  );
}

function NotificationsHeader({
  attentionCount,
  onDismissAll,
  onOpenSettings,
  isDismissing = false,
}: {
  attentionCount: number;
  onDismissAll: () => void;
  onOpenSettings: () => void;
  isDismissing?: boolean;
}) {
  return (
    <PageFrameActions>
      <Button
        variant="secondary"
        size="sm"
        onClick={onDismissAll}
        disabled={attentionCount === 0}
        pending={isDismissing}
        pendingLabel="Dismissing…"
      >
        {ACKNOWLEDGE_ATTENTION_ACTION.label} all attention items
      </Button>
      <details className="notifications-page__overflow">
        <summary>More</summary>
        <button type="button" onClick={onOpenSettings}>
          Notification settings
        </button>
      </details>
    </PageFrameActions>
  );
}
