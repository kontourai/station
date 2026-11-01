import {
  captureReturnFocus,
  restoreReturnFocus,
} from '@kontourai/station-shared/return-focus';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  useDeviceSettings,
  useDeviceSettingsActions,
} from '../../contexts/DeviceSettingsContext';
import { navigationStore } from '../../contexts/navigation-store';
import { useCoarseNow } from '../../hooks/useCoarseNow';
import { useRowFocusPreservation } from '../../hooks/useRowFocusPreservation';
import {
  chatTaskSessionId,
  type HomeWorkItem,
} from '../../views/home/home-view-model';
import {
  type ConversationOpenResult,
  openWorkItem,
  workItemOpenFailureMessage,
} from '../../views/home/work-item-open-policy';
import { Button } from '../Button';
import { SearchGlyph } from '../icons/Glyph';
import { Empty, ErrorState, FilteredEmpty, SkeletonList } from '../state';
import { useSheetGesturesPreview } from '../useResponsiveSheetGesture';
import {
  InboxGroupList,
  type InboxGroupListProps,
  moveFocusBeforeRemovingInboxRow,
} from './ChatDockInboxRows';
import { InboxScopeFilter, useInboxScope } from './InboxScopeFilter';
import { useInboxDismissActions } from './inbox-dismissals';
import {
  clearSnooze,
  snoozeKeyFor,
  writeSnooze,
} from './mobile-activity-groups';
import { useInboxGroups } from './useInboxGroups';
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
  onOpenConversation: (
    conversationId: string,
    agentSlug: string,
    projectSlug?: string,
    projectName?: string,
    model?: string,
    conversationUpdatedAt?: string,
  ) => Promise<ConversationOpenResult> | ConversationOpenResult;
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
  const activation = useRef(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const { inboxSections } = useDeviceSettings();
  const { setDeviceSetting } = useDeviceSettingsActions();
  const swipeActions = useSheetGesturesPreview();
  const now = useCoarseNow(suppliedNow, { enabled: open });
  useRowFocusPreservation(panelRef, '.chat-dock-inbox__item');
  const openMembership = useMemo(
    () =>
      new Set(
        openChatSessionIds ??
          tasks.filter((task) => task.kind === 'chat').map(chatTaskSessionId),
      ),
    [openChatSessionIds, tasks],
  );
  const dismissals = useInboxDismissActions(tasks, workFacts);
  const returnFocusRef = useRef<HTMLElement[]>([]);
  // Selecting a chat may replace the trigger; restore through surviving ancestors.
  const closeAndRestoreFocus = useCallback(() => {
    const chain = returnFocusRef.current;
    const panel = panelRef.current;
    returnFocusRef.current = [];
    onClose();
    restoreReturnFocus(chain, panel);
  }, [onClose]);

  const scope = useInboxScope(tasks, now, workFacts);
  const matchingItems = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return term
      ? scope.items.filter((item) =>
          [
            item.title,
            item.projectLabel,
            item.agentLabel,
            item.environmentLabel,
          ].some((value) => value?.toLocaleLowerCase().includes(term)),
        )
      : scope.items;
  }, [query, scope.items]);
  const groups = useInboxGroups(matchingItems, now, workFacts);
  const visibleGroups = groups;
  const hasVisibleItems = groups.some((group) => group.items.length > 0);

  useLayoutEffect(() => {
    if (!open) return;
    // Capture before moving focus into the panel, while the trigger and every
    // ancestor are still attached.
    returnFocusRef.current = captureReturnFocus(triggerRef.current);
    if (document.activeElement === triggerRef.current)
      panelRef.current?.querySelector('select')?.focus();
  }, [open, triggerRef]);

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
        closeAndRestoreFocus();
        return;
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [closeAndRestoreFocus, open]);

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
            if (!searchOpen)
              requestAnimationFrame(() => searchRef.current?.focus());
            else setQuery('');
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
                <button type="button" onClick={onRetryLoad}>
                  Retry
                </button>
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
              scope.value === 'all'
                ? 'No chats yet.'
                : 'No work in this filter.'
            }
            description={
              scope.value === 'all'
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
        <InboxGroupList
          swipeActions={swipeActions}
          groups={visibleGroups}
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
            onToggle: (id) =>
              setDeviceSetting('inboxSections', {
                ...inboxSections,
                [id]: inboxSections[id] === false,
              }),
          }}
          chrome="touch"
          actionsInDetails
          onActivate={(task) => {
            const request = ++activation.current;
            // station#3687: acknowledge only after the click did something,
            // and say so when it could not (same contract as the desktop
            // panel — see ChatDockInboxPanel's onActivate).
            if (task.kind === 'task') {
              navigationStore.navigate(`/tasks/${encodeURIComponent(task.id)}`);
              closeAndRestoreFocus();
              return;
            }
            void openWorkItem(task, {
              onFocusChat,
              onOpenConversation,
              onOpenSession,
              agentsLoaded,
            })
              .then((outcome) => {
                if (request !== activation.current || outcome === 'cancelled')
                  return;
                if (outcome === 'opened' || outcome === 'fallback') {
                  onAcknowledgeConversation?.(task);
                  closeAndRestoreFocus();
                  return;
                }
                onOpenFailed?.(workItemOpenFailureMessage(task, outcome));
              })
              .catch(() => {
                if (request !== activation.current) return;
                onOpenFailed?.(
                  'Could not open this item. Try again, or open it from Activity.',
                );
              });
          }}
          onSnoozeWake={(task, wakeAt, action) => {
            // The row leaves its group on snooze/unsnooze; keep focus in
            // the Inbox rather than stranding it on a removed node (#1054).
            moveFocusBeforeRemovingInboxRow(panelRef.current, action);
            const clock = now;
            const snoozeKey = snoozeKeyFor(task);
            if (wakeAt === null) clearSnooze(snoozeKey, clock);
            else writeSnooze(snoozeKey, wakeAt, clock);
          }}
          onDismiss={(item, action) => {
            moveFocusBeforeRemovingInboxRow(panelRef.current, action);
            dismissals.dismiss(item);
          }}
          onRestore={(item, action) => {
            moveFocusBeforeRemovingInboxRow(panelRef.current, action);
            dismissals.restore(item);
          }}
          onCloseChat={
            onCloseChat
              ? (sessionId, action) => {
                  moveFocusBeforeRemovingInboxRow(panelRef.current, action);
                  onCloseChat(sessionId);
                }
              : undefined
          }
          onDraftDiscarded={(task, action) => {
            // #2312: the server deleted the Draft; its open tab, if any,
            // now names nothing.
            moveFocusBeforeRemovingInboxRow(panelRef.current, action);
            if (task.chatSessionId && openMembership.has(task.chatSessionId))
              onCloseChat?.(task.chatSessionId);
          }}
        />
      </div>
      {dismissals.notice}
    </section>
  );
}
