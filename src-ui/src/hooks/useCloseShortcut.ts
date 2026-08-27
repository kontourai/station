import { useKeyboardShortcut } from './useKeyboardShortcut';

const CLOSE_MODIFIERS: ('cmd' | 'ctrl' | 'shift' | 'alt')[] = ['cmd'];
const ESCAPE_MODIFIERS: ('cmd' | 'ctrl' | 'shift' | 'alt')[] = [];

/**
 * Registers a view-owned close action above the route-level Escape fallback.
 * Cmd/Ctrl+X remains as a compatibility shortcut.
 *
 * `enabled` lets an embedding host (e.g. the /developer Storage tab) suppress
 * the close/Escape binding when the view is rendered inside another view that
 * already owns the route-level Escape fallback — otherwise the embedded view
 * would hijack Escape and navigate away from its host.
 */
export function useCloseShortcut(onClose: () => void, enabled = true) {
  useKeyboardShortcut(
    'view.close',
    'x',
    CLOSE_MODIFIERS,
    'Close current view',
    onClose,
    enabled,
    100,
  );
  useKeyboardShortcut(
    'view.escape',
    'Escape',
    ESCAPE_MODIFIERS,
    'Go up one level',
    onClose,
    enabled,
    100,
  );
}
