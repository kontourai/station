const NON_TEXT_INPUTS = [
  'button',
  'checkbox',
  'color',
  'file',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]
  .map((type) => `:not([type="${type}"])`)
  .join('');

const NATIVE_MENU_TARGETS = [
  `input${NON_TEXT_INPUTS}`,
  'textarea',
  '[contenteditable]:not([contenteditable="false"])',
].join(', ');

/**
 * Whether a `contextmenu` belongs to the platform rather than to Station.
 *
 * One rule, read by the app-wide guard (`NativeContextMenuGuard`) and by every
 * control that opens its own menu (`useContextMenuGesture`), so a right-click
 * on selected text never opens a row's menu in one place and the system Copy
 * menu in another.
 *
 * - Shift held on a right-click: the deliberate escape hatch. It is how a
 *   nightly or dev build, which ships the WebView inspector, still reaches
 *   Inspect Element once the guard swallows the ordinary right-click. Only the
 *   mouse's right button (`button === 2`): Shift+F10 is the keyboard's own
 *   context-menu key on Windows and Linux, and must open Station's menu.
 * - A text-entry target: Cut, Copy, Paste, spelling and the input method live
 *   in the native menu, and Station has no replacement for them. A checkbox,
 *   radio, range or button input has none of those, so it is not one.
 * - A press ON the selected text: the user selected it and asked for the menu
 *   that acts on it (Copy, Look Up, Share).
 */
export function wantsNativeContextMenu(event: {
  shiftKey: boolean;
  button: number;
  target: EventTarget | null;
  clientX: number;
  clientY: number;
}): boolean {
  if (event.shiftKey && event.button === 2) return true;
  const target = event.target;
  if (!(target instanceof Element)) return false;
  if (target.closest(NATIVE_MENU_TARGETS)) return true;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return false;
  // The keyboard's menu key has no pointer (engines report 0, 0): it acts on
  // the focus, so a selection anywhere in the target is the selection meant.
  const pointless = event.clientX === 0 && event.clientY === 0;
  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index);
    if (pointless) {
      if (range.intersectsNode(target)) return true;
      continue;
    }
    // Geometry, not the DOM: a right-click on empty space in a container that
    // also holds a selection is not a request to copy it, and the native menu
    // there would bring Reload with it.
    for (const rect of Array.from(range.getClientRects())) {
      if (
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom
      )
        return true;
    }
  }
  return false;
}
