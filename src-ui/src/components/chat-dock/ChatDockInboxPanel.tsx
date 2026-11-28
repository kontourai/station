import { Input } from '@kontourai/ui/react';
import { memo, useEffect, useRef } from 'react';
import {
  useDeviceSettings,
  useDeviceSettingsActions,
} from '../../contexts/DeviceSettingsContext';
import { useCoarsePointer } from '../../hooks/useCoarsePointer';
import { useRowFocusPreservation } from '../../hooks/useRowFocusPreservation';
import type { HomeWorkItem } from '../../views/home/home-view-model';
import { Button } from '../Button';
import { MessageGlyph } from '../icons/Glyph';
import { ReadStatusNote } from '../inbox-row/ReadStatusNote';
import { NewChatAction } from '../NewChatAction';
import { type ListRefresh, ListRefreshStatus } from '../refresh/ListRefresh';
import { Empty, ErrorState, FilteredEmpty, SkeletonList } from '../state';
import { useSheetGesturesPreview } from '../useResponsiveSheetGesture';
import {
  type CollapsibleInboxSectionId,
  InboxGroupList,
  type InboxGroupListProps,
} from './ChatDockInboxRows';
import { InboxPullRequestFilter, InboxScopeFilter } from './InboxScopeFilter';
import {
  type InboxPanelControllerOptions,
  useInboxPanelController,
} from './useInboxPanelController';

export interface ChatDockInboxPanelProps {
  items: HomeWorkItem[];
  activeChatSessionId: string | null;
  openChatSessionIds: string[];
  onFocusChat: (id: string) => void;
  /** station#1297: rehydrates a session with no live tab into the chat
   *  overlay — mirrors `useChatDockActions`' `openConversation`. */
  authority?: InboxPanelControllerOptions['authority'];
  taskQuestionsEnabled?: boolean;
  onOpenConversation: InboxPanelControllerOptions['onOpenConversation'];
  onOpenSession: (threadId: string) => void;
  /** See WorkItemOpenHandlers.agentsLoaded (station#3687). */
  agentsLoaded?: boolean;
  /**
   * station#3687 seams 3/5: a click that opened nothing must say so. Called
   * with a user-presentable reason; the host owns the toast.
   */
  onOpenFailed?: (message: string) => void;
  onCloseChat: (id: string) => void;
  /** Marks the rendered conversation version as seen before opening it. */
  onAcknowledgeConversation?: (item: HomeWorkItem) => void;
  onOpenHistory: () => void;
  onNewChat?: () => void;
  sync?: {
    failed: boolean;
    pending: boolean;
    updating: boolean;
    refresh?: ListRefresh;
  };
  /**
   * station#3309: mounted only to play its exit. The panel is still on screen,
   * but the user's decision to collapse it is already complete, so it is inert
   * for the whole exit — out of the tab order and out of the accessibility
   * tree rather than a landmark that answers to a name it is in the middle of
   * abandoning.
   */
  exiting?: boolean;
  now?: number;
  /**
   * Live agent catalog for the rows' leading agent icons
   * (`inboxRowIconAgent`). Omitted renders no icons — see the `memo()` note
   * below for why it has to be the caller's stable reference.
   */
  agents?: InboxGroupListProps['agents'];
  /**
   * Local session git locations by thread id, for the rows' hover cards'
   * git section (see `InboxGroupListProps.gitLocationByThreadId`). Absent
   * renders cards without a git section. Referentially stable, like the
   * other shared props — the `memo()` wrap compares shallowly.
   */
  gitLocationByThreadId?: InboxGroupListProps['gitLocationByThreadId'];
  /** Project accents by slug; see `InboxGroupListProps.projectAccentBySlug`. */
  projectAccentBySlug?: InboxGroupListProps['projectAccentBySlug'];
  /** Project icons by slug; see `InboxGroupListProps.projectIconBySlug`. */
  projectIconBySlug?: InboxGroupListProps['projectIconBySlug'];
  /** Status facts by item id; see `InboxGroupListProps.workFacts`. */
  workFacts?: InboxGroupListProps['workFacts'];
}

/**
 * Desktop chrome for the shared inbox rows (kontourai/station#3312): the
 * dock's side panel — scroll container, persisted collapsible sections, and
 * the inbox toolbar. Row/group anatomy lives in `ChatDockInboxRows.tsx`,
 * shared with the embedded `MobileInboxPanel`.
 */
function ChatDockInboxPanelImpl({
  items,
  activeChatSessionId,
  openChatSessionIds,
  onFocusChat,
  onOpenConversation,
  onOpenSession,
  agentsLoaded,
  authority,
  taskQuestionsEnabled,
  onOpenFailed,
  onCloseChat,
  onAcknowledgeConversation,
  onOpenHistory,
  onNewChat,
  sync,
  exiting = false,
  now: suppliedNow,
  agents,
  gitLocationByThreadId,
  projectAccentBySlug,
  projectIconBySlug,
  workFacts,
}: ChatDockInboxPanelProps) {
  // One coarse tick for the whole list's relative times, rather than a new
  // `now` on every render of the dock around it.

  // A pointer that cannot hover gets the always-visible 44px chrome, the
  // same one the mobile sheet uses, rather than hover-revealed controls.
  const coarsePointer = useCoarsePointer();
  const swipeActions = useSheetGesturesPreview();
  const panelRef = useRef<HTMLElement>(null);
  // A row that changes lane remounts in another section; keep focus on it.
  useRowFocusPreservation(panelRef, '.chat-dock-inbox__item');
  // Set on the element rather than passed as a JSX prop so the behaviour does
  // not depend on the renderer's attribute support, matching
  // WorkspacePaneFrame's own `element.inert` seam.
  useEffect(() => {
    const panel = panelRef.current;
    if (panel) panel.inert = exiting;
  }, [exiting]);
  const { inboxSections: sections } = useDeviceSettings();
  const { setDeviceSetting } = useDeviceSettingsActions();
  const controller = useInboxPanelController({
    items,
    open: !exiting,
    authority,
    taskQuestionsEnabled,
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
  });
  const { now, scope, groups, query, setQuery } = controller;

  const toggleSection = (id: CollapsibleInboxSectionId) => {
    setDeviceSetting('inboxSections', {
      ...sections,
      [id]: sections[id] === false,
    });
  };

  const hasAnyItems = controller.hasVisibleItems;

  return (
    <aside
      ref={panelRef}
      data-coarse-pointer={coarsePointer || undefined}
      className={`chat-dock-inbox${exiting ? ' chat-dock-inbox--exiting' : ''}`}
      aria-label="Chats"
      tabIndex={-1}
    >
      <div className="filter-toolbar chat-dock-inbox__toolbar">
        <Input
          type="search"
          aria-label="Search chats"
          placeholder="Search chats"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <InboxScopeFilter scope={scope} inline />
        {onNewChat && <NewChatAction iconOnly onClick={onNewChat} />}
        {scope.showPullRequestFilter && (
          <InboxPullRequestFilter
            className="chat-dock-inbox__pr-filter"
            value={scope.pullRequestFilter}
            onChange={scope.setPullRequestFilter}
          />
        )}
      </div>
      <div className="chat-dock-inbox__scroll">
        {sync && (sync.failed || sync.refresh?.recovering) && (
          <ErrorState
            variant="compact"
            title="Couldn’t refresh the chats."
            description={
              hasAnyItems ? 'Showing the last known list.' : undefined
            }
            action={
              sync.refresh && (
                <Button
                  variant="secondary"
                  disabled={sync.refresh.phase === 'refreshing'}
                  onClick={() => sync.refresh?.run(true)}
                >
                  {sync.refresh.recovering ? 'Retrying…' : 'Retry'}
                </Button>
              )
            }
          />
        )}
        <ReadStatusNote items={items} />
        {!hasAnyItems && sync?.pending && !sync.failed ? (
          <SkeletonList count={3} label="Loading chats and tasks" />
        ) : !hasAnyItems && sync?.failed ? null : !hasAnyItems &&
          query.trim() ? (
          <FilteredEmpty
            query={query}
            noun="work"
            onClear={() => setQuery('')}
          />
        ) : (
          !hasAnyItems && (
            <Empty
              variant="compact"
              label={
                scope.value === 'all'
                  ? 'Nothing here yet.'
                  : 'No work in this filter.'
              }
            />
          )
        )}
        {hasAnyItems && (
          <InboxGroupList
            key={controller.stateKey}
            swipeActions={swipeActions}
            groups={groups}
            idPrefix="chat-dock-inbox"
            activeChatSessionId={activeChatSessionId}
            now={now}
            agents={agents}
            gitLocationByThreadId={gitLocationByThreadId}
            projectAccentBySlug={projectAccentBySlug}
            projectNames={scope.projectNames}
            projectIconBySlug={projectIconBySlug}
            workFacts={workFacts}
            chrome={coarsePointer ? 'touch' : 'hover'}
            actionsInDetails={coarsePointer}
            collapsible={{
              sections,
              onToggle: toggleSection,
              order: sections.order,
              onReorder: (order) =>
                setDeviceSetting('inboxSections', { ...sections, order }),
            }}
            {...controller.rowActions}
          />
        )}
        {/* Every conversation, past the loaded and scoped list: a way out at
            the end of the list rather than a menu of one at the top. A
            failed read keeps its own Retry above. */}
        <Button
          variant="ghost"
          className="chat-dock-inbox__browse"
          onClick={onOpenHistory}
        >
          <MessageGlyph />
          Browse all conversations
        </Button>
      </div>
      {sync && (
        <ListRefreshStatus
          activity="Refreshing chats…"
          phase={sync.refresh?.phase}
          updating={sync.updating && (hasAnyItems || !sync.pending)}
        />
      )}
      {controller.notice}
    </aside>
  );
}

/**
 * Memoized (review r1 correction — state precisely what this achieves,
 * nothing more): the surrounding dock re-renders every animation frame
 * while the bottom/side resize handle is dragged (`liveDragHeight`/width
 * state). station#1797: the parent (`ChatDock.tsx`) now mounts this
 * component only while the inbox is expanded — collapsed means unmounted,
 * with the header's own toggle as the single expand/collapse
 * control — so every render this component sees is the full group/row work,
 * and the `memo()` wrap is what keeps that work from re-running on a drag
 * frame it has no reason to care about. It only helps to the extent the
 * parent passes referentially stable props — which it does for the
 * function/array props here (`openChatSessionIds`, `onOpenSession`,
 * `onOpenHistory` are `useMemo`/`useCallback`-stabilized at the call site).
 * A future prop added here without the same stabilization silently defeats
 * this. `agents` (station#2802) satisfies it once the catalog has answered:
 * `useAgents()` returns react-query's own cached array, whose identity
 * changes only when the catalog does. Before a successful catalog response
 * (including a persistent error), `useAgents()` supplies a shared empty
 * array, so it does not defeat the wrap.
 */
export const ChatDockInboxPanel = memo(ChatDockInboxPanelImpl);
