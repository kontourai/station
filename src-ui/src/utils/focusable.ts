/**
 * What a focus trap or a roving menu may reach: the one selector, so a
 * `<select>` or `<textarea>` added to a dialog cannot fall outside its trap
 * because that dialog happened to carry a shorter copy of this list.
 * `:disabled` (not `[disabled]`) also excludes controls disabled by an
 * enclosing `<fieldset disabled>`, which cannot take focus either.
 */
export const FOCUSABLE_SELECTOR =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * The wrap half of a Tab trap, for a `Tab` keydown: Shift+Tab on the first
 * control goes to the last, Tab on the last goes to the first, and anything
 * in between is left to the browser. `controls` is the trap's reachable set
 * in DOM order — the caller owns which container and which extra filter
 * (hidden rows, a portal). Returns whether it moved focus.
 */
export function wrapTabFocus(
  event: { shiftKey: boolean; preventDefault: () => void },
  controls: readonly HTMLElement[],
): boolean {
  const first = controls[0];
  const last = controls.at(-1);
  if (!first || !last) return false;
  const active = document.activeElement;
  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
    return true;
  }
  if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
    return true;
  }
  return false;
}
