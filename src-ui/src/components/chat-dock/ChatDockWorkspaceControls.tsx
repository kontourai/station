import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { withShortcutHint } from '../../contexts/KeyboardShortcutsContext';
import { useShortcutDisplay } from '../../hooks/useKeyboardShortcut';
import {
  ArrowLeftGlyph,
  ArrowRightGlyph,
  MessageGlyph,
  TerminalGlyph,
} from '../icons/Glyph';
import { LazyBoundary } from '../LazyBoundary';
import type { ChatDockWorkspaceControls as Controls } from './ChatDockHeader';
import {
  closeSessionInventoryOccurrence,
  focusSessionInventoryFullHost,
  openSessionInventoryOccurrence,
  registerSessionInventoryHost,
  useSessionInventoryOccurrence,
} from './sessionInventoryOccurrence';

const loadSessionInventoryEntryPoint = () =>
  import('./SessionInventoryEntryPoint').then((module) => ({
    default: module.SessionInventoryEntryPoint,
  }));

function NewChatGlyph() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 16 16">
      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

export function ChatDockWorkspaceControls(props: Controls) {
  const authority = useHostRequestAuthorityScope();
  const hostId = useRef(`session-inventory:${crypto.randomUUID()}`).current;
  const inventory = props.sessionInventory;
  const authorityKey = authority?.authorityKey;
  const chatStoreId = inventory?.chatStoreId;
  const executionId = inventory?.executionId;
  const occurrence = useSessionInventoryOccurrence(hostId);
  useEffect(
    () =>
      registerSessionInventoryHost(
        hostId,
        authorityKey && chatStoreId && executionId
          ? {
              authorityKey,
              chatStoreId,
              executionId,
            }
          : null,
      ),
    [authorityKey, chatStoreId, executionId, hostId],
  );
  const toggleInventory = (trigger: HTMLElement) => {
    if (!inventory || !authority) return;
    if (occurrence) {
      if (focusSessionInventoryFullHost(hostId)) return;
      return closeSessionInventoryOccurrence(hostId);
    }
    openSessionInventoryOccurrence({
      hostId,
      authorityKey: authority.authorityKey,
      activeSessionId: inventory.chatStoreId,
      executionSessionId: inventory.executionId,
      projectId: inventory.projectId,
      executionRead: inventory.executionRead,
      trigger,
    });
  };
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
      {inventory ? (
        <button
          type="button"
          className="chat-dock__inbox-toggle"
          onClick={(event) => toggleInventory(event.currentTarget)}
          title="Session inventory"
          aria-label="Session inventory"
          aria-pressed={Boolean(occurrence)}
          aria-expanded={Boolean(occurrence)}
          aria-controls={`session-inventory-${hostId}`}
        >
          <span aria-hidden="true">◫</span>
        </button>
      ) : null}
      {occurrence && inventory?.mountRef.current
        ? createPortal(
            <LazyBoundary
              load={loadSessionInventoryEntryPoint}
              pending={null}
              componentProps={{
                launch: occurrence,
                isMobile: false,
                dockMode: inventory.dockMode,
                fullscreen: inventory.fullscreen,
                controlsId: `session-inventory-${hostId}`,
                onClose: () => closeSessionInventoryOccurrence(hostId),
              }}
            />,
            inventory.mountRef.current,
          )
        : null}
    </div>
  );
}

export function ChatDockWorkspaceActions({
  onOpenConversation,
  onNewChat,
}: Pick<Controls, 'onOpenConversation' | 'onNewChat'>) {
  const openShortcut = useShortcutDisplay('dock.openConversation');
  const newShortcut = useShortcutDisplay('dock.newChat');
  return (
    <div className="chat-dock__tab-actions">
      <button
        type="button"
        className="chat-dock__new chat-dock__open"
        onClick={onOpenConversation}
        title={withShortcutHint(
          'Open Conversation',
          'dock.openConversation',
          () => openShortcut,
        )}
      >
        <MessageGlyph />
        <span className="chat-dock__new-label">Open</span>
      </button>
      <button
        type="button"
        className="chat-dock__new"
        onClick={onNewChat}
        title={withShortcutHint('New Chat', 'dock.newChat', () => newShortcut)}
      >
        <NewChatGlyph />
        <span className="chat-dock__new-label">New</span>
      </button>
    </div>
  );
}
