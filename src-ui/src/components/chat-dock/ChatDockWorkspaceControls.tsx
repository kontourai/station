import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { withShortcutHint } from '../../contexts/KeyboardShortcutsContext';
import { useShortcutDisplay } from '../../hooks/useKeyboardShortcut';
import { MessageGlyph } from '../icons/Glyph';
import { LazyBoundary } from '../LazyBoundary';
import type { ChatDockWorkspaceControls as Controls } from './ChatDockHeader';
import {
  closeSessionInventoryOccurrence,
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

/**
 * The session inventory's host: the authority-scoped registration the store
 * matches an occurrence against, and the portal the panel renders through. No
 * visible chrome of its own.
 *
 * #1536 F moved the inventory's BUTTON into the dock header's More menu, which
 * is not this component and holds no authority scope — so the two halves are
 * split by what each one needs. The row presses
 * `toggleSessionInventoryOccurrence`, which reads the identity out of the
 * registration written here; this stays mounted for as long as the pane is
 * open, so a menu closing behind an open panel cannot unmount its host.
 *
 * Still behind a `LazyBoundary`: this reads the authority scope and the
 * occurrence store, and pulls the panel's own chunk on demand.
 */
export function ChatDockSessionInventoryHost({
  sessionInventory: inventory,
}: {
  sessionInventory: NonNullable<Controls['sessionInventory']>;
}) {
  const authority = useHostRequestAuthorityScope();
  const hostId = inventory.hostId;
  const authorityKey = authority?.authorityKey;
  const chatStoreId = inventory.chatStoreId;
  const executionId = inventory.executionId;
  const occurrence = useSessionInventoryOccurrence(hostId);
  useEffect(
    () =>
      registerSessionInventoryHost(
        hostId,
        hostId && authorityKey && chatStoreId && executionId
          ? {
              authorityKey,
              chatStoreId,
              executionId,
            }
          : null,
      ),
    [authorityKey, chatStoreId, executionId, hostId],
  );
  if (!occurrence || !inventory.mountRef.current) return null;
  return createPortal(
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
