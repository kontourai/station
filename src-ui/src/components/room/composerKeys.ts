import { useEffect, useState } from 'react';

export type ComposerEnterAction = 'send' | 'newline' | 'ignore';

/**
 * What Enter does in a room composer. On a hardware keyboard Enter sends and
 * Shift+Enter adds a line; on a touch keyboard Return always adds a line and
 * the send button sends. Enter that confirms an IME composition never sends.
 */
export function composerEnterAction(
  event: {
    key: string;
    shiftKey: boolean;
    isComposing?: boolean;
    keyCode?: number;
  },
  touchKeyboard: boolean,
): ComposerEnterAction {
  if (event.key !== 'Enter') return 'ignore';
  if (event.isComposing || event.keyCode === 229) return 'ignore';
  if (event.shiftKey || touchKeyboard) return 'newline';
  return 'send';
}

/** A device whose primary input is touch types on an on-screen keyboard. */
export const TOUCH_KEYBOARD_QUERY = '(hover: none) and (pointer: coarse)';

export function useTouchKeyboard(): boolean {
  const [touch, setTouch] = useState(
    () =>
      typeof window !== 'undefined' &&
      !!window.matchMedia?.(TOUCH_KEYBOARD_QUERY).matches,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const query = window.matchMedia(TOUCH_KEYBOARD_QUERY);
    const update = () => setTouch(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return touch;
}
