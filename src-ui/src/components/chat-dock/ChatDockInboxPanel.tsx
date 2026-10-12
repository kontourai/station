import { memo, useEffect, useMemo, useRef } from 'react';
import {
  useDeviceSettings,
  useDeviceSettingsActions,
} from '../../contexts/DeviceSettingsContext';
import { useCoarseNow } from '../../hooks/useCoarseNow';
import { useCoarsePointer } from '../../hooks/useCoarsePointer';
import { useRowFocusPreservation } from '../../hooks/useRowFocusPreservation';
import type { HomeWorkItem } from '../../views/home/home-view-model';
import {
  openWorkItem,
  workItemOpenFailureMessage,
} from '../../views/home/work-item-open-policy';
import { MessageGlyph } from '../icons/Glyph';
import { NewChatAction } from '../NewChatAction';
import { Empty } from '../state';
import {
  type CollapsibleInboxSectionId,
  InboxGroupList,
  type InboxGroupListProps,
  moveFocusBeforeRemovingInboxRow,
} from './ChatDockInboxRows';
import {
  clearSnooze,
  snoozeKeyFor,
  writeSnooze,
} from './mobile-activity-groups';
import { useInboxGroups } from './useInboxGroups';

export interface ChatDockInboxPanelProps {
  items: HomeWorkItem[];
  activeChatSessionId: string | null;
  openChatSessionIds: string[];
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
  ) => Promise<boolean> | boolean | undefined;
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
 * the history footer. Row/group anatomy lives in `ChatDockInboxRows.tsx`,
 * shared with `MobileTaskSwitcher`'s sheet chrome.
 */
function ChatDockInboxPanelImpl({
  items,
  activeChatSessionId,
  openChatSessionIds,
  onFocusChat,
  onOpenConversation,
  onOpenSession,
  agentsLoaded,
  onOpenFailed,
  onCloseChat,
  onAcknowledgeConversation,
  onOpenHistory,
  onNewChat,
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
  const now = useCoarseNow(suppliedNow);
  // A pointer that cannot hover gets the always-visible 44px chrome, the
  // same one the mobile sheet uses, rather than hover-revealed controls.
  const coarsePointer = useCoarsePointer();
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
  const openChatIds = useMemo(
    () => new Set(openChatSessionIds),
    [openChatSessionIds],
  );
  // The live groups (held lifecycles, live snoozes): the same hook the
  // inbox toggle's Needs-you count reads, so the two cannot disagree.
  const groups = useInboxGroups(items, now);

  const toggleSection = (id: CollapsibleInboxSectionId) => {
    setDeviceSetting('inboxSections', { ...sections, [id]: !sections[id] });
  };

  const hasAnyItems = groups.some((group) => group.items.length > 0);

  return (
    <aside
      ref={panelRef}
      className={`chat-dock-inbox${exiting ? ' chat-dock-inbox--exiting' : ''}`}
      aria-label="Inbox chats"
      tabIndex={-1}
    >
      <div className="chat-dock-inbox__scroll">
        {!hasAnyItems && <Empty variant="compact" label="Nothing here yet." />}
        {hasAnyItems && (
          <InboxGroupList
            groups={groups}
            idPrefix="chat-dock-inbox"
            activeChatSessionId={activeChatSessionId}
            openChatIds={openChatIds}
            now={now}
            agents={agents}
            gitLocationByThreadId={gitLocationByThreadId}
            projectAccentBySlug={projectAccentBySlug}
            projectIconBySlug={projectIconBySlug}
            workFacts={workFacts}
            chrome={coarsePointer ? 'touch' : 'hover'}
            collapsible={{ sections, onToggle: toggleSection }}
            onActivate={(item) => {
              // station#3687 seam 4: acknowledge only after the click did
              // something. Acknowledging first moved a row the user could
              // not open out of "Just finished" — a failed open quietly
              // buried its own evidence.
              void openWorkItem(item, {
                onFocusChat,
                onOpenConversation,
                onOpenSession,
                agentsLoaded,
              })
                .then((outcome) => {
                  if (outcome === 'opened' || outcome === 'fallback') {
                    onAcknowledgeConversation?.(item);
                    return;
                  }
                  onOpenFailed?.(workItemOpenFailureMessage(item, outcome));
                })
                // Seam 5: a throw inside a handler was an unhandled
                // rejection with no user-visible signal.
                .catch(() => {
                  onOpenFailed?.(
                    'Could not open this item. Try again, or open it from Activity.',
                  );
                });
            }}
            onSnoozeWake={(item, wakeAt, action) => {
              moveFocusBeforeRemovingInboxRow(panelRef.current, action);
              const key = snoozeKeyFor(item);
              // The write notifies every reader of the snooze map.
              if (wakeAt === null) clearSnooze(key, now);
              else writeSnooze(key, wakeAt, now);
            }}
            onCloseChat={(sessionId, action) => {
              moveFocusBeforeRemovingInboxRow(panelRef.current, action);
              onCloseChat(sessionId);
            }}
            onDraftDiscarded={(item, action) => {
              // #2312: the server deleted the Draft; its open tab, if any,
              // now names nothing.
              moveFocusBeforeRemovingInboxRow(panelRef.current, action);
              if (item.chatSessionId && openChatIds.has(item.chatSessionId))
                onCloseChat(item.chatSessionId);
            }}
          />
        )}
      </div>
      <footer className="chat-dock-inbox__footer">
        <button type="button" onClick={onOpenHistory}>
          <MessageGlyph />
          History
        </button>
        {onNewChat && <NewChatAction onClick={onNewChat} />}
      </footer>
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
