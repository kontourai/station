import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from 'react';
import { useContext, useId, useRef, useState } from 'react';
import { Button } from '../Button';
import {
  ArrowDownGlyph,
  ExpandGlyph,
  InboxGlyph,
  MenuGlyph,
  NewChatGlyph,
  RestoreGlyph,
} from '../icons/Glyph';
import { LazyBoundary } from '../LazyBoundary';
import '../NewChatAction.css';
import './ChatDockHeader.css';
import type { ContextPercentageSource } from '../conversation-stats/ContextPercentage';
import type { DockMoreAction } from './ChatDockHeaderMoreMenu';
import { MobileDockHeaderLeadingContext } from './MobileDockHeaderLeading';
import { MobileSheetPending } from './MobileSheetPending';

const loadChatDockMobileOverflowSheet = () =>
  import('./ChatDockMobileOverflowSheet').then((module) => ({
    default: module.ChatDockMobileOverflowSheet,
  }));

export interface ChatDockMobileOverflowActions {
  onTurnIntoTask?: () => void;
  turnIntoTaskLabel?: string;
  onOpenConversation: () => void;
  onToggleHistory: () => void;
  onOpenChatSettings: () => void;
  onOpenConversationHistory?: () => void;
  /**
   * Desktop More-menu parity: the dock header's clipboard rows (Copy thread
   * ID, Copy session ID once diverged, Copy project path) from
   * `useDockCopyActions`. A coarse device has no hover tooltip to carry these
   * identities, so the sheet is their only home. Absent: no rows.
   */
  copyActions?: DockMoreAction[];
  onOpenProject: (() => void) | null;
  openProjectName: string | null;
  inputOriginLabel?: string;
  onOpenProfile: () => void;
  onOpenAppSettings: () => void;
  /**
   * Chat inventory, a row of the sheet like the session context below: a
   * third trailing control in the bar wrapped it onto a second line (#4192).
   * The trigger passed is ⋯, where focus returns when the reader closes.
   */
  onOpenInventory?: (trigger: HTMLElement) => void;
  sessionInventory?: {
    sessionId: string;
    chatStoreId: string;
  };
  onCollapseDock: () => void;
  onExpandDock: () => void;
  onRestoreDock: () => void;
  isDockMaximized: boolean;
  dockControls?: boolean;
  /**
   * The panes of the region this dock renders, in tab order, the selected
   * one marked (#2046 2b, `DockShellChrome.regionPanes`). The sheet lists
   * every OTHER pane as a switch row — the coarse device's stand-in for the
   * tab strip. Absent or one pane: no rows.
   */
  regionPanes?: readonly { id: string; title: string; selected: boolean }[];
  onSelectRegionPane?: (surfaceId: string) => void;
  /**
   * #2510: the sheet's entry to the dock's Background tasks surface, routed
   * by ChatDock's `showBackgroundTasks` (the sheet on a bottom-only device,
   * the Agents pane where a side region exists). It OPENS rather than
   * toggles: the overflow sheet dismisses itself on the tap, so there is no
   * open state for it to toggle against.
   * Absent: no row (ChatDock omits it when there is no chat for the sheet to
   * read).
   */
  onOpenBackgroundTasks?: () => void;
  backgroundTasksRunningCount?: number;
  backgroundTasksLimited?: boolean;
  /**
   * The session context sheet (the desktop card's rows). A row of this sheet
   * rather than a third control in the bar: the bar's edge reserve holds two
   * 44px controls beside the chat title, and a third wrapped the header onto
   * a second line. `returnFocus` is the ⋯ trigger, so closing the context
   * sheet lands where the reader started. Absent: no row.
   */
  onOpenSessionContext?: (returnFocus: HTMLElement | null) => void;
  /** The chat's ladder line, named on the row ("This chat — Running"). */
  sessionContextStatus?: string;
  /**
   * The composer's context meter, again as a row of this sheet. On a phone
   * the meter is the last chip of a row that scrolls sideways with its
   * scrollbar hidden, and that row is hidden altogether while typing on a
   * short screen, so it is easy never to see. The row names the share used
   * and opens the same Conversation stats panel the meter does. Absent: no
   * row (ChatDock offers it exactly where it shows the meter).
   */
  conversationStats?: ContextPercentageSource & { onOpen: () => void };
}

export interface ChatDockMobileDockToggle {
  state: 'collapsed' | 'open';
  onExpand: () => void;
  onCollapse: () => void;
}

/**
 * #4391: the visible full-screen/peek switch of an open dock. Full screen is
 * where a phone chat lives; the peek (Half) is the deliberate smaller state,
 * so both directions are one tap in the bar rather than a sheet row.
 */
export interface ChatDockMobileExtentToggle {
  maximized: boolean;
  onToggle: () => void;
}

interface ChatDockMobileHeaderProps {
  inboxActive?: boolean;
  /**
   * #4404 (A44): whether there is a chat to go back to. Without one the bar
   * offers New chat, not a pressed "Back to chat" or chat actions.
   */
  hasConversation?: boolean;
  showDrawerToggle: boolean;
  showConnection: boolean;
  sessionTitle: string;
  routeLabel?: string;
  stationName?: string;
  sessionProjectMismatchLabel?: string | null;
  agentIdentity: { name: string; slug: string; icon?: string } | null;
  projectScope?: { name: string; onClear: () => void };
  activeCount: number;
  unreadCount: number;
  inboxTriggerRef: RefObject<HTMLButtonElement | null>;
  onToggleInbox: () => void;
  onToggleSidebar: (trigger: HTMLElement) => void;
  onDragPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onDragClickCapture: (event: ReactMouseEvent<HTMLElement>) => void;
  dockToggle: ChatDockMobileDockToggle | null;
  extentToggle?: ChatDockMobileExtentToggle | null;
  onNewChat: () => void;
  overflow: ChatDockMobileOverflowActions;
}

/** Project and conversation context stay directly operable; secondary actions use the sheet. */
export function ChatDockMobileHeader({
  inboxActive = false,
  hasConversation = true,
  showDrawerToggle,
  showConnection,
  sessionTitle,
  routeLabel,
  stationName,
  sessionProjectMismatchLabel,
  agentIdentity,
  projectScope,
  activeCount,
  unreadCount,
  inboxTriggerRef,
  onToggleInbox,
  onToggleSidebar,
  onDragPointerDown,
  onDragClickCapture,
  dockToggle,
  extentToggle = null,
  onNewChat,
  overflow,
}: ChatDockMobileHeaderProps) {
  const hostLeading = useContext(MobileDockHeaderLeadingContext);
  const [isOverflowOpen, setIsOverflowOpen] = useState(false);
  const chatActionsTriggerRef = useRef<HTMLButtonElement>(null);
  const activityDescriptionId = useId();
  const collapsedExtent =
    dockToggle?.state === 'collapsed' ? extentToggle : null;
  // The dot on ⋯ used to be decoration only: an unexplained orange mark on
  // the chat-actions button. It means chats (this one included) are working
  // or have unread replies — the sheet's Chats row is where they are — so it
  // says so, as the button's description rather than its name.
  const activitySummary = [
    activeCount > 0
      ? `${activeCount} ${activeCount === 1 ? 'chat' : 'chats'} working`
      : null,
    unreadCount > 0 ? `${unreadCount} unread` : null,
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <div
      className="chat-dock__header chat-dock__mobile-header"
      onPointerDown={onDragPointerDown}
      onClickCapture={onDragClickCapture}
      data-dock-drag-surface=""
      data-testid="chat-dock-mobile-header"
    >
      <div className="chat-dock__mobile-leading">
        {hostLeading}
        {showDrawerToggle ? (
          <button
            type="button"
            className="app-toolbar__icon-btn chat-dock__mobile-header-icon"
            aria-label="Toggle menu"
            aria-controls="mobile-navigation"
            data-no-dock-drag=""
            onClick={(event) => onToggleSidebar(event.currentTarget)}
          >
            <MenuGlyph />
          </button>
        ) : dockToggle && !collapsedExtent ? (
          <button
            type="button"
            className="app-toolbar__icon-btn chat-dock__mobile-header-icon"
            aria-label={
              dockToggle.state === 'collapsed' ? 'Expand chat' : 'Collapse chat'
            }
            data-no-dock-drag=""
            onClick={
              dockToggle.state === 'collapsed'
                ? dockToggle.onExpand
                : dockToggle.onCollapse
            }
          >
            <ArrowDownGlyph />
          </button>
        ) : null}
        {hasConversation || showConnection ? (
          <button
            ref={chatActionsTriggerRef}
            type="button"
            className="app-toolbar__icon-btn chat-dock__mobile-header-icon chat-dock__mobile-overflow-trigger"
            aria-haspopup="dialog"
            aria-expanded={isOverflowOpen}
            aria-label="Chat actions"
            aria-describedby={
              activitySummary ? activityDescriptionId : undefined
            }
            title={
              activitySummary ? `Chat actions — ${activitySummary}` : undefined
            }
            data-no-dock-drag=""
            onClick={() => setIsOverflowOpen((open) => !open)}
          >
            <span aria-hidden="true">⋯</span>
            {activitySummary && (
              <>
                <span
                  className="chat-dock__mobile-activity-dot"
                  aria-hidden="true"
                />
                <span id={activityDescriptionId} className="sr-only">
                  {activitySummary}
                </span>
              </>
            )}
          </button>
        ) : null}
      </div>

      <div className="chat-dock__mobile-identity" data-dock-drag-passthrough="">
        {hasConversation || !inboxActive ? (
          <Button
            ref={inboxTriggerRef}
            variant="ghost"
            className="app-toolbar__icon-btn chat-dock__mobile-header-icon"
            aria-label={inboxActive ? 'Back to chat' : 'Inbox'}
            title={inboxActive ? 'Back to chat' : 'Inbox'}
            aria-pressed={inboxActive}
            data-no-dock-drag=""
            onClick={onToggleInbox}
          >
            <InboxGlyph />
          </Button>
        ) : null}
        <span className="chat-dock__mobile-identity-lines">
          <span
            className="chat-dock__mobile-title chat-dock__mobile-title-text"
            title={inboxActive ? undefined : sessionTitle}
          >
            {inboxActive ? 'Inbox' : sessionTitle}
          </span>
          {!inboxActive && agentIdentity && ' '}
          {!inboxActive && (agentIdentity || stationName) && (
            <span className="chat-dock__mobile-eyebrow">
              {stationName && `Via ${stationName}`}
              {stationName && agentIdentity && ' · '}
              {agentIdentity?.name}
              {!stationName && routeLabel && ` · via ${routeLabel}`}
              {sessionProjectMismatchLabel &&
                ` · ${sessionProjectMismatchLabel}`}
            </span>
          )}
        </span>
      </div>
      <div className="chat-dock__mobile-actions">
        {extentToggle && (
          <button
            type="button"
            className="app-toolbar__icon-btn chat-dock__mobile-header-icon chat-dock__mobile-extent"
            aria-label={
              extentToggle.maximized ? 'Restore chat size' : 'Full screen chat'
            }
            title={
              extentToggle.maximized ? 'Restore chat size' : 'Full screen chat'
            }
            data-no-dock-drag=""
            onClick={extentToggle.onToggle}
          >
            {extentToggle.maximized ? <RestoreGlyph /> : <ExpandGlyph />}
          </button>
        )}
        <button
          type="button"
          className="app-toolbar__icon-btn new-chat-action new-chat-action--icon chat-dock__mobile-header-icon chat-dock__mobile-new"
          aria-label="New chat"
          title="New chat"
          data-no-dock-drag=""
          onClick={onNewChat}
        >
          <NewChatGlyph />
        </button>
      </div>
      {isOverflowOpen && (
        <LazyBoundary
          load={loadChatDockMobileOverflowSheet}
          pending={
            <MobileSheetPending
              label="Chat actions"
              onClose={() => setIsOverflowOpen(false)}
              returnFocusTarget={chatActionsTriggerRef.current}
            />
          }
          componentProps={{
            overflow,
            projectScope,
            showConnection,
            onNewChat,
            returnFocusTarget: chatActionsTriggerRef.current,
            onClose: () => setIsOverflowOpen(false),
          }}
        />
      )}
    </div>
  );
}
