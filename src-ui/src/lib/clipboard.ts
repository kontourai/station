// Plain HTTP and some WebViews cannot use the async clipboard API. The
// browser can still allow a copy command from the user's click.
function copySelection(text: string): boolean {
  if (typeof document.execCommand !== 'function') return false;
  const active = document.activeElement;
  const selection = document.getSelection();
  const anchor = selection?.anchorNode;
  const focus = selection?.focusNode;
  const anchorOffset = selection?.anchorOffset ?? 0;
  const focusOffset = selection?.focusOffset ?? 0;

  const field = document.createElement('textarea');
  field.value = text;
  field.readOnly = true;
  field.tabIndex = -1;
  field.className = 'sr-only';
  field.setAttribute('aria-hidden', 'true');
  (active?.parentElement ?? document.body).appendChild(field);
  try {
    field.focus({ preventScroll: true });
    field.select();
    return document.execCommand('copy');
  } finally {
    if (active instanceof HTMLElement) active.focus({ preventScroll: true });
    field.remove();
    if (anchor?.isConnected && focus?.isConnected)
      selection?.setBaseAndExtent(anchor, anchorOffset, focus, focusOffset);
  }
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    const clipboard = globalThis.navigator?.clipboard;
    if (typeof clipboard?.writeText === 'function') {
      await clipboard.writeText(text);
      return true;
    }
  } catch {
    // A browser may refuse the async API but allow a selection-based copy.
  }

  try {
    return typeof document !== 'undefined' && copySelection(text);
  } catch {
    return false;
  }
}
