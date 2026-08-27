import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  useDeviceSettings,
  useDeviceSettingsActions,
} from '../../contexts/DeviceSettingsContext';
import type { HomeWorkItem } from '../../views/home/home-view-model';
import {
  openWorkItem,
  workItemOpenFailureMessage,
} from '../../views/home/work-item-open-policy';
import { MessageGlyph } from '../icons/Glyph';
import { Empty } from '../state';
import {
  type CollapsibleInboxSectionId,
  InboxGroupList,
  type InboxGroupListProps,
  moveFocusBeforeRemovingInboxRow,
} from './ChatDockInboxRows';
import {
  clearSnooze,
  groupMobileActivity,
  readSnoozes,
  type SnoozeMap,
  snoozeKeyFor,
  writeSnooze,
} from './mobile-activity-groups';

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
  exiting = false,
  now: suppliedNow,
  agents,
}: ChatDockInboxPanelProps) {
  const now = suppliedNow ?? Date.now();
  const panelRef = useRef<HTMLElement>(null);
  // Set on the element rather than passed as a JSX prop so the behaviour does
  // not depend on the renderer's attribute support, matching
  // WorkspacePaneFrame's own `element.inert` seam.
  useEffect(() => {
    const panel = panelRef.current;
    if (panel) panel.inert = exiting;
  }, [exiting]);
  const [snoozed, setSnoozed] = useState<SnoozeMap>(() => readSnoozes(now));
  const { inboxSections: sections } = useDeviceSettings();
  const { setDeviceSetting } = useDeviceSettingsActions();
  const openChatIds = useMemo(
    () => new Set(openChatSessionIds),
    [openChatSessionIds],
  );
  const groups = useMemo(
    () => groupMobileActivity(items, now, snoozed),
    [items, now, snoozed],
  );

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
              setSnoozed(
                wakeAt === null
                  ? clearSnooze(key, now)
                  : writeSnooze(key, wakeAt, now),
              );
            }}
            onCloseChat={(sessionId, action) => {
              moveFocusBeforeRemovingInboxRow(panelRef.current, action);
              onCloseChat(sessionId);
            }}
          />
        )}
      </div>
      <footer className="chat-dock-inbox__footer">
        <button type="button" onClick={onOpenHistory}>
          <MessageGlyph />
          Conversation history
        </button>
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
