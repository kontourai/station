import {
  serverVisualViewportSnapshot,
  subscribeVisualViewport,
  visualViewportSnapshot,
} from '@kontourai/station-shared/visual-viewport';
import { useEffect, useState, useSyncExternalStore } from 'react';

/**
 * How much of the layout viewport the visual viewport must lose before the
 * loss is a software keyboard rather than browser chrome. iOS Safari's
 * floating toolbar and Android's navigation bar cost well under this; the
 * smallest phone keyboard (a hardware-keyboard accessory bar aside) is over
 * 200px.
 */
export const SOFT_KEYBOARD_MIN_INSET_PX = 150;

const TEXT_INPUT_TYPES = new Set([
  '',
  'text',
  'search',
  'email',
  'url',
  'tel',
  'password',
  'number',
]);

/** An element that raises a software keyboard when focused. */
export function isTextEntryElement(element: Element | null): boolean {
  if (!element) return false;
  if (element instanceof HTMLTextAreaElement) return !element.readOnly;
  if (element instanceof HTMLInputElement)
    return (
      TEXT_INPUT_TYPES.has(element.type.toLowerCase()) && !element.readOnly
    );
  return element instanceof HTMLElement && element.isContentEditable;
}

function useFocusedTextEntry(): Element | null {
  const [focused, setFocused] = useState<Element | null>(() =>
    typeof document === 'undefined' ? null : document.activeElement,
  );
  useEffect(() => {
    const update = () => setFocused(document.activeElement);
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', update);
    update();
    return () => {
      document.removeEventListener('focusin', update);
      document.removeEventListener('focusout', update);
    };
  }, []);
  return isTextEntryElement(focused) ? focused : null;
}

/**
 * The element the open software keyboard is typing into, or null.
 *
 * Derived, not reported: the web has no keyboard-open event. A keyboard is
 * open when a text entry has focus AND the visual viewport (the shared
 * per-window store) ends at least `SOFT_KEYBOARD_MIN_INSET_PX` above the
 * layout viewport. Either alone is not enough: a focused field on a device
 * with a hardware keyboard shortens nothing, and a short visual viewport with
 * nothing focused is browser chrome.
 */
export function useSoftKeyboardTarget(): Element | null {
  const metrics = useSyncExternalStore(
    subscribeVisualViewport,
    visualViewportSnapshot,
    serverVisualViewportSnapshot,
  );
  const focused = useFocusedTextEntry();
  return focused && metrics.bottomInset >= SOFT_KEYBOARD_MIN_INSET_PX
    ? focused
    : null;
}
