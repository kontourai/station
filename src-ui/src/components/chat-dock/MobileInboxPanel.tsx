import {
  captureReturnFocus,
  restoreReturnFocus,
} from '@kontourai/station-shared/return-focus';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  useDeviceSettings,
  useDeviceSettingsActions,
} from '../../contexts/DeviceSettingsContext';
import { useRowFocusPreservation } from '../../hooks/useRowFocusPreservation';
import type { HomeWorkItem } from '../../views/home/home-view-model';
import { Button } from '../Button';
import { SearchGlyph } from '../icons/Glyph';
import { ReadStatusNote } from '../inbox-row/ReadStatusNote';
import { Empty, ErrorState, FilteredEmpty, SkeletonList } from '../state';
import { useSheetGesturesPreview } from '../useResponsiveSheetGesture';
import { InboxGroupList, type InboxGroupListProps } from './ChatDockInboxRows';
import { InboxScopeFilter } from './InboxScopeFilter';
import {
  type InboxPanelControllerOptions,
  useInboxPanelController,
} from './useInboxPanelController';

import './MobileInboxPanel.css';

export function MobileInboxPanel({
  open,
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
  onRetryLoad,
}: {
  open: boolean;
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
  onRetryLoad?: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
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
    groups,
    hasVisibleItems,
    openChatIds: openMembership,
  } = controller;

  useLayoutEffect(() => {
    // Opening a reader can close Inbox before its activation lease settles.
    // Restore from the committed close, including a replacement header trigger.
    if (!open) {
      if (returnFocusRef.current.length === 0) return;
      const chain = triggerRef.current
        ? [...captureReturnFocus(triggerRef.current), ...returnFocusRef.current]
        : returnFocusRef.current;
      returnFocusRef.current = [];
      const frame = restoreReturnFocus(chain, panelRef.current);
      return () => cancelAnimationFrame(frame);
    }
    // Capture before moving focus into the panel, while the trigger and every
    // ancestor are still attached.
    returnFocusRef.current = captureReturnFocus(triggerRef.current);
    if (document.activeElement === triggerRef.current)
      panelRef.current?.querySelector('select')?.focus();
  }, [open, triggerRef]);

  useLayoutEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.target instanceof Node &&
        !panelRef.current?.contains(event.target)
      )
        return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose, open]);

  return (
    <section
      ref={panelRef}
      className="mobile-inbox"
      aria-label="Inbox"
      hidden={!open}
      tabIndex={-1}
      data-no-dock-drag=""
    >
      <div className="mobile-inbox__toolbar">
        <InboxScopeFilter scope={scope} />
        <Button
          variant="ghost"
          className="mobile-inbox__search-toggle"
          aria-label="Search inbox"
          title="Search inbox"
          aria-expanded={searchOpen}
          onClick={() => {
            setSearchOpen((shown) => !shown);
            if (searchOpen) setQuery('');
          }}
        >
          <SearchGlyph />
        </Button>
      </div>
      {searchOpen && (
        <input
          ref={searchRef}
          className="mobile-inbox__search"
          type="search"
          aria-label="Search chats and tasks"
          placeholder="Search…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      )}
      <div className="mobile-inbox__list">
        {loadError && !hasVisibleItems ? (
          <ErrorState
            variant="compact"
            title="Unable to load chats and tasks"
            action={
              onRetryLoad ? (
                <Button onClick={onRetryLoad}>Retry</Button>
              ) : undefined
            }
          />
        ) : pending ? (
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
              scope.effectiveValue === 'all'
                ? 'No chats yet.'
                : 'No work in this filter.'
            }
            description={
              scope.effectiveValue === 'all'
                ? 'Start a chat with an agent.'
                : 'Choose All work to see other projects and Stations.'
            }
          />
        ) : null}
        {loadError && hasVisibleItems && (
          <p role="status">
            Some chats may be out of date.{' '}
            {onRetryLoad && (
              <button type="button" onClick={onRetryLoad}>
                Retry
              </button>
            )}
          </p>
        )}
        <ReadStatusNote items={tasks} />
        <InboxGroupList
          key={controller.stateKey}
          swipeActions={swipeActions}
          groups={groups}
          idPrefix="mobile-task-switcher"
          activeChatSessionId={activeChatSessionId}
          openChatIds={openMembership}
          now={now}
          agents={agents}
          workFacts={workFacts}
          gitLocationByThreadId={gitLocationByThreadId}
          projectAccentBySlug={projectAccentBySlug}
          projectIconBySlug={projectIconBySlug}
          showGroupCounts
          collapsible={{
            sections: inboxSections,
            order: inboxSections.order,
            onReorder: (order) =>
              setDeviceSetting('inboxSections', { ...inboxSections, order }),
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
      </div>
      {controller.notice}
    </section>
  );
}
