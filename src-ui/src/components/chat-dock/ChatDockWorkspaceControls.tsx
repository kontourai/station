import { createPortal } from 'react-dom';
import { withShortcutHint } from '../../contexts/KeyboardShortcutsContext';
import { useShortcutDisplay } from '../../hooks/useKeyboardShortcut';
import { LazyBoundary } from '../LazyBoundary';
import { NewChatAction } from '../NewChatAction';
import type { ChatDockWorkspaceControls as Controls } from './ChatDockHeader';
import {
  closeSessionInventoryOccurrence,
  useSessionInventoryOccurrence,
} from './sessionInventoryOccurrence';

const loadSessionInventoryEntryPoint = () =>
  import('./SessionInventoryEntryPoint').then((module) => ({
    default: module.SessionInventoryEntryPoint,
  }));

/** Lazy panel portal; its registration belongs to the chat pane. */
export function ChatDockSessionInventoryHost({
  sessionInventory: inventory,
}: {
  sessionInventory: NonNullable<Controls['sessionInventory']>;
}) {
  const hostId = inventory.hostId;
  const occurrence = useSessionInventoryOccurrence(hostId);
  if (!occurrence || !inventory.mountRef.current) return null;
  return createPortal(
    <LazyBoundary
      load={loadSessionInventoryEntryPoint}
      pending={null}
      componentProps={{
        launch: occurrence,
        isMobile: inventory.isMobile ?? false,
        dockMode: inventory.dockMode,
        fullscreen: inventory.fullscreen,
        onClose: () => closeSessionInventoryOccurrence(hostId),
        restoreFocusFallback: inventory.restoreFocusFallback,
      }}
    />,
    inventory.mountRef.current,
  );
}

/**
 * The bar's ONE labelled action (#3239): New. "Open"
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
