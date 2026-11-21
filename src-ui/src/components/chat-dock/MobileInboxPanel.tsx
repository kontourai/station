import {
  applyReturnFocus,
  captureReturnFocus,
} from '@kontourai/station-shared/return-focus';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  useDeviceSettings,
  useDeviceSettingsActions,
} from '../../contexts/DeviceSettingsContext';
import { useRowFocusPreservation } from '../../hooks/useRowFocusPreservation';
import type { HomeWorkItem } from '../../views/home/home-view-model';
import { workStatus } from '../../views/home/work-status';
import { Button } from '../Button';
import { CloseGlyph } from '../icons/Glyph';
import { ReadStatusNote } from '../inbox-row/ReadStatusNote';
import { NewChatAction } from '../NewChatAction';
import {
  type ListRefresh,
  ListRefreshPull,
  ListRefreshStatus,
} from '../refresh/ListRefresh';
import { Empty, ErrorState, FilteredEmpty, SkeletonList } from '../state';
import { useSheetGesturesPreview } from '../useResponsiveSheetGesture';
import { InboxGroupList, type InboxGroupListProps } from './ChatDockInboxRows';
import { MobileInboxSelection } from './MobileInboxSelection';
import { type InboxStatusFilter, MobileInboxTools } from './MobileInboxTools';

import {
  type InboxPanelControllerOptions,
  useInboxPanelController,
} from './useInboxPanelController';

import './MobileInboxPanel.css';

export function MobileInboxPanel({
  open,
  toolsHost,
  onNewChat,
  tasks,
  openChatSessionIds,
  activeChatSessionId,
  triggerRef,
  onClose,
  onFocusChat,
  onOpenConversation,
  onOpenSession,
  agentsLoaded,
  authority,
  onOpenFailed,
  onCloseChat,
  onAcknowledgeConversation,
  now: suppliedNow,
  agents,
  workFacts,
  gitLocationByThreadId,
  projectAccentBySlug,
  projectIconBySlug,
  pending = false,
  loadError = false,
  updating,
  refresh,
}: {
  open: boolean;
  toolsHost?: HTMLDivElement | null;
  onNewChat?: () => void;
  tasks: HomeWorkItem[];
  openChatSessionIds?: string[];
  activeChatSessionId: string | null;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onFocusChat: (id: string) => void;
  /** station#1297: rehydrates a session with no live tab into the chat
   *  overlay — mirrors `useChatDockActions`' `openConversation`. */
  authority?: InboxPanelControllerOptions['authority'];
  onOpenConversation: InboxPanelControllerOptions['onOpenConversation'];
  onOpenSession: (threadId: string) => void;
  /** See WorkItemOpenHandlers.agentsLoaded (station#3687). */
  agentsLoaded?: boolean;
  /** A click that opened nothing reports why; the host owns the toast. */
  onOpenFailed?: (message: string) => void;
  /** kontourai/station#3312: closes an open chat's tab from its shared-row
   *  close action. Optional — a host with no tab teardown hides the action. */
  onCloseChat?: (id: string) => void;
  /** Marks the rendered conversation version as seen before opening it. */
  onAcknowledgeConversation?: (item: HomeWorkItem) => void;
  /** Injectable clock for the recency boundary; defaults to wall time. */
  now?: number;
  /**
   * Live agent catalog for shared row icons. Omitted renders no icons.
   */
  agents?: InboxGroupListProps['agents'];
  /** Status facts by item id; see `InboxGroupListProps.workFacts`. */
  workFacts?: InboxGroupListProps['workFacts'];
  gitLocationByThreadId?: InboxGroupListProps['gitLocationByThreadId'];
  projectAccentBySlug?: InboxGroupListProps['projectAccentBySlug'];
  projectIconBySlug?: InboxGroupListProps['projectIconBySlug'];
  /** True until every read contributing rows has settled. */
  pending?: boolean;
  loadError?: boolean;
  updating?: boolean;
  refresh?: ListRefresh;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const showLoadError = loadError || refresh?.recovering;
  const [statusFilter, setStatusFilter] =
    useState<InboxStatusFilter>('All statuses');
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [requestedDetails, setRequestedDetails] = useState<string | null>(null);
  const selecting = selected !== null;
  const choose = (item: HomeWorkItem) =>
    setSelected((prior) => {
      const next = new Set(prior);
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      return next;
    });
  const [arranging, setArranging] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const { inboxSections } = useDeviceSettings();
  const { setDeviceSetting } = useDeviceSettingsActions();
  const swipeActions = useSheetGesturesPreview();
  useRowFocusPreservation(panelRef, '.chat-dock-inbox__item');
  const returnFocusRef = useRef<HTMLElement[]>([]);

  const controller = useInboxPanelController({
    items: tasks,
    open,
    authority,
    panelRef,
    openChatSessionIds,
    workFacts,
    now: suppliedNow,
    onFocusChat,
    onOpenConversation,
    onOpenSession,
    agentsLoaded,
    onOpenFailed,
    onCloseChat,
    onAcknowledgeConversation,
    onActivated: onClose,
  });
  const {
    now,
    scope,
    query,
    setQuery,
    groups: scopeGroups,
    openChatIds: openMembership,
  } = controller;

  const selectionKey = JSON.stringify([
    controller.stateKey,
    open,
    scope.effectiveValue,
    statusFilter,
    query,
  ]);
  const [previousKey, setPreviousKey] = useState(selectionKey);
  if (previousKey !== selectionKey) {
    setPreviousKey(selectionKey);
    setSelected(null);
    setRequestedDetails(null);
    setArranging(false);
  }
  const matchesStatus = (item: HomeWorkItem) => {
    const status = workStatus(item, now, workFacts?.get(item.id));
    switch (statusFilter) {
      case 'Needs attention':
        return status.lane === 'needsYou';
      case 'Running':
        return status.lane === 'running' && status.rung !== 'scheduled';
      case 'Waiting':
        return status.rung === 'waiting' || status.rung === 'scheduled';
      case 'Open':
        return status.lane === 'idle';
      case 'Finished':
        return status.lane === 'finished';
      default:
        return true;
    }
  };
  const groups =
    statusFilter === 'All statuses'
      ? scopeGroups
      : scopeGroups
          .map((group) => {
            const matches = (item: HomeWorkItem) =>
              matchesStatus(item) ||
              !!group.childrenById?.get(item.id)?.some(matchesStatus);
            return {
              ...group,
              childrenById:
                group.childrenById &&
                new Map(
                  [...group.childrenById].map(([id, children]) => [
                    id,
                    children.filter(matchesStatus),
                  ]),
                ),
              items: group.items.filter(matches),
              older: group.older?.filter(matches),
            };
          })
          .filter((group) => group.items.length || group.older?.length);
  const hiddenAttention =
    scope.hiddenAttention +
    (statusFilter === 'All statuses' || statusFilter === 'Needs attention'
      ? 0
      : scope.visibleAttention);
  const hasVisibleItems = groups.some(
    (group) => group.items.length || group.older?.length,
  );
  const toggleSearch = () => {
    setSearchOpen(!searchOpen);
    if (searchOpen) setQuery('');
  };
  const tools = selecting ? (
    <div className="mobile-inbox__selection-heading">
      <Button
        variant="ghost"
        className="app-toolbar__icon-btn"
        aria-label="Exit selection"
        onClick={() => setSelected(null)}
      >
        <CloseGlyph />
      </Button>
      <strong>{selected.size} selected</strong>
    </div>
  ) : (
    <MobileInboxTools
      scope={scope}
      status={statusFilter}
      onStatus={setStatusFilter}
      searchOpen={searchOpen}
      onSearch={toggleSearch}
      onSelect={() => {
        setArranging(false);
        setSelected(new Set());
      }}
      onArrange={() => {
        setSelected(null);
        setArranging(!arranging);
      }}
      onRefresh={refresh ? () => void refresh.run(true) : undefined}
      onBack={activeChatSessionId ? onClose : undefined}
    />
  );
  useLayoutEffect(() => {
    // Opening a reader can close Inbox before its activation lease settles.
    // Restore from the committed close, including a replacement header trigger.
    if (!open) {
      if (returnFocusRef.current.length === 0) return;
      const previous = returnFocusRef.current;
      returnFocusRef.current = [];
      const panel = panelRef.current;
      const frame = requestAnimationFrame(() => {
        const trigger = triggerRef.current;
        // Closing Inbox also removes its portalled menu trigger. Its own focus
        // fallback may already have landed on the dock's surviving header.
        const header = trigger?.closest<HTMLElement>(
          '.chat-dock__mobile-header',
        );
        const active = document.activeElement;
        const menuFallback =
          header &&
          (active === header ||
            active === header.querySelector('.chat-dock__mobile-actions'));
        applyReturnFocus(
          trigger ? [...captureReturnFocus(trigger), ...previous] : previous,
          menuFallback ? header : panel,
        );
      });
      return () => cancelAnimationFrame(frame);
    }
    // Capture before moving focus into the panel, while the trigger and every
    // ancestor are still attached.
    returnFocusRef.current = captureReturnFocus(
      triggerRef.current ?? panelRef.current,
    );
    if (
      document.activeElement === triggerRef.current ||
      document.activeElement === document.body
    )
      panelRef.current?.focus({ preventScroll: true });
  }, [open, triggerRef]);

  useLayoutEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.target instanceof Node &&
        !panelRef.current?.contains(event.target) &&
        !toolsHost?.contains(event.target)
      )
        return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (selecting) setSelected(null);
        else onClose();
        return;
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose, open, selecting, toolsHost]);

  return (
    <section
      ref={panelRef}
      className="mobile-inbox"
      aria-label="Inbox"
      hidden={!open}
      tabIndex={-1}
      data-no-dock-drag=""
    >
      {open &&
        (toolsHost ? (
          createPortal(tools, toolsHost)
        ) : (
          <div className="mobile-inbox__toolbar">{tools}</div>
        ))}
      {(scope.effectiveValue !== 'all' || statusFilter !== 'All statuses') && (
        <div className="mobile-inbox__filter-summary">
          <span>
            {[
              scope.effectiveValue === 'all'
                ? null
                : scope.options.get(scope.effectiveValue),
              statusFilter === 'All statuses' ? null : statusFilter,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
          <Button
            variant="ghost"
            onClick={() => {
              scope.onChange('all');
              setStatusFilter('All statuses');
            }}
          >
            Clear filters
          </Button>
        </div>
      )}
      {hiddenAttention > 0 && (
        <Button
          variant="ghost"
          onClick={() => {
            scope.onChange('all');
            setStatusFilter('All statuses');
          }}
        >
          {hiddenAttention} need you outside this filter · Show all
        </Button>
      )}
      {arranging && (
        <div className="mobile-inbox__filter-summary">
          Arrange sections
          <Button variant="ghost" onClick={() => setArranging(false)}>
            Done
          </Button>
        </div>
      )}
      {searchOpen && (
        <input
          ref={searchRef}
          className="control control--input mobile-inbox__search"
          type="search"
          aria-label="Search chats and tasks"
          placeholder="Search…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      )}
      <div className="mobile-inbox__list" ref={listRef}>
        <ListRefreshPull surfaceRef={listRef} refresh={refresh} enabled={open}>
          {showLoadError && !hasVisibleItems ? (
            <ErrorState
              variant="compact"
              title="Unable to load chats and tasks"
              action={
                refresh && (
                  <Button
                    disabled={refresh.phase === 'refreshing'}
                    onClick={() => void refresh.run(true)}
                  >
                    {refresh.recovering ? 'Retrying…' : 'Retry'}
                  </Button>
                )
              }
            />
          ) : pending && !hasVisibleItems ? (
            <div
              role="status"
              aria-busy="true"
              aria-label="Loading chats and tasks"
            >
              <SkeletonList count={3} />
            </div>
          ) : !hasVisibleItems && query.trim() ? (
            <FilteredEmpty
              query={query}
              noun="work"
              onClear={() => setQuery('')}
            />
          ) : !hasVisibleItems ? (
            <Empty
              variant="compact"
              label={
                scope.effectiveValue === 'all' &&
                statusFilter === 'All statuses'
                  ? 'No chats yet.'
                  : 'No work in this filter.'
              }
              description={
                scope.effectiveValue === 'all' &&
                statusFilter === 'All statuses'
                  ? 'Start a chat with an agent.'
                  : 'Choose All work to see other projects and Stations.'
              }
            />
          ) : null}
          {showLoadError && hasVisibleItems && (
            <ErrorState
              variant="compact"
              title="Showing last known results"
              action={
                refresh && (
                  <Button
                    disabled={refresh.phase === 'refreshing'}
                    onClick={() => void refresh.run(true)}
                  >
                    {refresh.recovering ? 'Retrying…' : 'Retry'}
                  </Button>
                )
              }
            />
          )}
          <ReadStatusNote items={tasks} />
          <InboxGroupList
            key={controller.stateKey}
            swipeActions={swipeActions}
            groups={groups}
            actionsOnHold
            onSelectRow={choose}
            onHoldRow={(item) =>
              setSelected((previous) => new Set(previous).add(item.id))
            }
            selectedIds={selected}
            requestedDetails={requestedDetails}
            onConsumeDetails={() => setRequestedDetails(null)}
            idPrefix="mobile-task-switcher"
            activeChatSessionId={activeChatSessionId}
            openChatIds={openMembership}
            now={now}
            agents={agents}
            workFacts={workFacts}
            gitLocationByThreadId={gitLocationByThreadId}
            projectAccentBySlug={projectAccentBySlug}
            projectNames={scope.projectNames}
            projectIconBySlug={projectIconBySlug}
            showGroupCounts
            collapsible={{
              sections: inboxSections,
              order: inboxSections.order,
              onReorder: !arranging
                ? undefined
                : (order) =>
                    setDeviceSetting('inboxSections', {
                      ...inboxSections,
                      order,
                    }),
              onToggle: (id) =>
                setDeviceSetting('inboxSections', {
                  ...inboxSections,
                  [id]: inboxSections[id] === false,
                }),
            }}
            chrome="touch"
            actionsInDetails
            {...controller.rowActions}
          />
        </ListRefreshPull>
      </div>
      {open && refresh && (
        <ListRefreshStatus
          activity="Refreshing inbox…"
          phase={refresh.phase}
          updating={updating && (hasVisibleItems || !pending)}
        />
      )}
      {open && selected && (
        <MobileInboxSelection
          key={controller.stateKey}
          selected={selected}
          groups={groups}
          facts={workFacts}
          onChange={setSelected}
          isCurrent={() =>
            open && authority !== null && authority?.isCurrent() !== false
          }
          snooze={controller.rowActions.onSnoozeWake}
          dismiss={controller.dismissSelected}
          details={(item) => {
            setRequestedDetails(item.id);
            setSelected(null);
          }}
        />
      )}
      {open && onNewChat && !selecting && !arranging && (
        <NewChatAction className="mobile-inbox__new-chat" onClick={onNewChat} />
      )}
      {controller.notice}
    </section>
  );
}
