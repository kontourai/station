import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { withShortcutHint } from '../../contexts/KeyboardShortcutsContext';
import { useShortcutDisplay } from '../../hooks/useKeyboardShortcut';
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

/**
 * The bar's ONE labelled action (design round 2026-10, B1/B2): New. "Open"
 * sat beside it as a second labelled button for the same noun; it is a row
 * of the ⋯ menu now ("Open chat…", with its chord), where the rest of the
 * dock's commands already live.
 */
export function ChatDockWorkspaceActions({
  onNewChat,
  iconOnly = false,
}: Pick<Controls, 'onNewChat'> & {
  /**
   * Icon-only, named and tipped (#3046): in a bar that names the pane (the
   * Coding workbench), New keeps its glyph and gives up its word, so the
   * title keeps the width. There is no Open here either: the inbox sits
   * beside Chat and lists the chats to open.
   */
  iconOnly?: boolean;
}) {
  const newShortcut = useShortcutDisplay('dock.newChat');
  return (
    <div
      className={`chat-dock__tab-actions${iconOnly ? ' chat-dock__tab-actions--icons' : ''}`}
    >
      <NewChatAction
        className={`chat-dock__new${iconOnly ? ' chat-dock__new--icon' : ''}`}
        iconOnly={iconOnly}
        onClick={onNewChat}
        title={withShortcutHint('New chat', 'dock.newChat', () => newShortcut)}
      >
        New
      </NewChatAction>
    </div>
  );
}
