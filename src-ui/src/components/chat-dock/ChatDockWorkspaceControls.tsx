import { Tooltip } from '@kontourai/ui/react';
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { withShortcutHint } from '../../contexts/KeyboardShortcutsContext';
import { useShortcutDisplay } from '../../hooks/useKeyboardShortcut';
import { EditGlyph, MessageGlyph } from '../icons/Glyph';
import { LazyBoundary } from '../LazyBoundary';
import { NewChatAction } from '../NewChatAction';
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
        onClose: () => closeSessionInventoryOccurrence(hostId),
      }}
    />,
    inventory.mountRef.current,
  );
}

export function ChatDockWorkspaceActions({
  onOpenConversation,
  onNewChat,
  iconOnly = false,
  sessionCount = 0,
}: Pick<Controls, 'onOpenConversation' | 'onNewChat'> & {
  /**
   * Icon-only, named and tipped (#3046): in a bar that names the pane, the
   * two verbs keep their glyphs and give up their words, so the bar stays
   * within the button cap and the title keeps the width.
   */
  iconOnly?: boolean;
  /**
   * How many conversations are open, when icon-only: more than one is a
   * count worth a badge on the Open icon and a line in its tooltip.
   */
  sessionCount?: number;
}) {
  const openShortcut = useShortcutDisplay('dock.openConversation');
  const newShortcut = useShortcutDisplay('dock.newChat');
  if (iconOnly) {
    const counted = sessionCount > 1 ? `${sessionCount} sessions` : null;
    const openHint = withShortcutHint(
      counted ? `Open conversation — ${counted}` : 'Open conversation',
      'dock.openConversation',
      () => openShortcut,
    );
    const newHint = withShortcutHint(
      'New chat',
      'dock.newChat',
      () => newShortcut,
    );
    return (
      <div className="chat-dock__tab-actions chat-dock__tab-actions--icons">
        <Tooltip label={openHint} placement="bottom">
          <button
            type="button"
            className="chat-dock__new chat-dock__open chat-dock__new--icon"
            aria-label={
              counted ? `Open conversation, ${counted}` : 'Open conversation'
            }
            onClick={onOpenConversation}
          >
            <MessageGlyph />
            {counted ? (
              <span className="chat-dock__new-count" aria-hidden="true">
                {sessionCount > 99 ? '99+' : sessionCount}
              </span>
            ) : null}
          </button>
        </Tooltip>
        <Tooltip label={newHint} placement="bottom">
          <button
            type="button"
            className="chat-dock__new chat-dock__new--icon"
            aria-label="New chat"
            onClick={onNewChat}
          >
            <EditGlyph />
          </button>
        </Tooltip>
      </div>
    );
  }
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
      <NewChatAction
        className="chat-dock__new"
        onClick={onNewChat}
        title={withShortcutHint('New chat', 'dock.newChat', () => newShortcut)}
      >
        New
      </NewChatAction>
    </div>
  );
}
