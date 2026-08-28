import { ArrowLeftGlyph, ArrowRightGlyph, TerminalGlyph } from '../icons/Glyph';
import type { ChatDockWorkspaceControls as Controls } from './ChatDockHeader';

export function ChatDockWorkspaceControls(props: Controls) {
  return (
    <div className="chat-dock__header-workspace">
      {props.showInboxToggle && (
        <button
          type="button"
          className={`chat-dock__inbox-toggle${props.isInboxOpen ? ' is-active' : ''}`}
          onClick={props.onToggleInbox}
          title={props.isInboxOpen ? 'Collapse chat list' : 'Expand chat list'}
          aria-label={
            props.isInboxOpen ? 'Collapse chat list' : 'Expand chat list'
          }
          aria-pressed={props.isInboxOpen}
        >
          {props.isInboxOpen ? <ArrowLeftGlyph /> : <ArrowRightGlyph />}
        </button>
      )}
      <button
        ref={props.backgroundTasksTriggerRef}
        type="button"
        className={`chat-dock__inbox-toggle${props.isBackgroundTasksOpen ? ' is-active' : ''}`}
        onClick={props.onToggleBackgroundTasks}
        title="Background tasks"
        aria-label={
          props.backgroundTasksRunningCount > 0
            ? `Background tasks — ${props.backgroundTasksRunningCount} running`
            : 'Background tasks'
        }
        aria-haspopup="dialog"
        aria-expanded={props.isBackgroundTasksOpen}
      >
        <TerminalGlyph />
        {props.backgroundTasksRunningCount > 0 && (
          <span
            className="chat-dock__background-tasks-badge"
            aria-hidden="true"
          >
            {props.backgroundTasksRunningCount}
          </span>
        )}
      </button>
      <button
        type="button"
        className="chat-dock__inbox-toggle"
        onClick={(event) => props.onToggleSessionInventory(event.currentTarget)}
        title="Session inventory"
        aria-label="Session inventory"
        aria-pressed={props.isSessionInventoryOpen}
        aria-expanded={props.isSessionInventoryOpen}
        aria-controls={props.sessionInventoryControlsId}
      >
        <span aria-hidden="true">◫</span>
      </button>
    </div>
  );
}

export function ChatDockWorkspaceActions({
  onOpenConversation,
  onNewChat,
}: Pick<Controls, 'onOpenConversation' | 'onNewChat'>) {
  return (
    <div className="chat-dock__tab-actions">
      <button
        type="button"
        className="chat-dock__new chat-dock__open"
        onClick={onOpenConversation}
        title="Open Conversation"
      >
        <span aria-hidden="true">▱</span>
        <span className="chat-dock__new-label">Open</span>
      </button>
      <button
        type="button"
        className="chat-dock__new"
        onClick={onNewChat}
        title="New Chat"
      >
        <span aria-hidden="true">+</span>
        <span className="chat-dock__new-label">New</span>
      </button>
    </div>
  );
}

export function ChatDockWorkspaceChrome(props: Controls) {
  return (
    <>
      <ChatDockWorkspaceControls {...props} />
      <ChatDockWorkspaceActions {...props} />
    </>
  );
}
