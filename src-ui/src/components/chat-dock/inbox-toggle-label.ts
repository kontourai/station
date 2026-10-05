/**
 * The inbox toggle's name, the one control that shows and hides the inbox
 * for a keyboard or a screen reader. While the inbox is hidden it carries
 * what the hidden inbox is holding for you ("Show inbox, 3 need you"), so a
 * fold never hides that something is waiting. The Coding layout's folded
 * edge is a pointer-only shortcut with the same words as its tooltip.
 */
export function inboxToggleLabel(isInboxOpen: boolean, needsYou = 0): string {
  if (isInboxOpen) return 'Hide inbox';
  if (needsYou <= 0) return 'Show inbox';
  return `Show inbox, ${needsYou} need${needsYou === 1 ? 's' : ''} you`;
}
