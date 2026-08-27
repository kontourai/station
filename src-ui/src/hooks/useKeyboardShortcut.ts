import { useLayoutEffect, useRef } from 'react';
import {
  type KeyboardShortcut,
  useKeyboardShortcuts,
  useShortcutRegistry,
} from '../contexts/KeyboardShortcutsContext';

export function useKeyboardShortcut(
  id: string,
  key: string,
  modifiers: ('cmd' | 'ctrl' | 'shift' | 'alt')[],
  description: string,
  handler: () => void,
  enabled = true,
  priority = 0,
  when?: KeyboardShortcut['when'],
  // `enabled` decides whether the shortcut EXISTS; `disabled` whether the one
  // that exists currently fires. A shortcut with no chord yet must still be
  // registered — that is what the settings list offers to bind and what
  // `getDisplay` answers "Not set" for — but it must not dispatch, and an
  // empty chord must not be counted as a conflict with every other unbound
  // shortcut.
  disabled = false,
) {
  const { register } = useKeyboardShortcuts();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const modifiersKey = modifiers.join('|');

  // Shortcuts are part of the rendered view's interaction contract. Register
  // before paint so a keyboard event cannot land in the gap between a route
  // becoming visible and its semantic Escape/close action becoming active.
  useLayoutEffect(() => {
    if (!enabled) return;

    const shortcut: KeyboardShortcut = {
      id,
      key,
      modifiers: modifiersKey
        ? (modifiersKey.split('|') as KeyboardShortcut['modifiers'])
        : [],
      description,
      handler: () => handlerRef.current(),
      priority,
      when,
      disabled,
    };
    return register(shortcut);
  }, [
    id,
    key,
    description,
    enabled,
    priority,
    register,
    modifiersKey,
    when,
    disabled,
  ]);
}

export function useShortcutDisplay(id: string): string {
  const { getDisplay } = useShortcutRegistry();
  return getDisplay(id);
}

// Re-export for convenience
