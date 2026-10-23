/**
 * The inbox toggle's name, the one control that shows and hides the inbox
 * for a keyboard or a screen reader. It carries what the inbox is holding —
 * chats working, chats that need you, unread replies — so the badge it wears
 * and a fold never hide that something is waiting. The Coding layout's folded
 * edge is a pointer-only shortcut with the same words as its tooltip.
 *
 * "Need you" is named only while the inbox is hidden: open, the rows say it.
 * Working and unread are named in both states, because the toggle's badge
 * shows the working count in both.
 */
export function inboxToggleLabel(
  isInboxOpen: boolean,
  needsYou = 0,
  working = 0,
  unread = 0,
): string {
  const facts = [
    working > 0 ? `${working} working` : null,
    !isInboxOpen && needsYou > 0
      ? `${needsYou} need${needsYou === 1 ? 's' : ''} you`
      : null,
    unread > 0 ? `${unread} unread` : null,
  ].filter(Boolean);
  const verb = isInboxOpen ? 'Hide inbox' : 'Show inbox';
  return facts.length > 0 ? `${verb}, ${facts.join(', ')}` : verb;
}

/**
 * The same facts for a trigger with no inbox behind it (the dock's More
 * trigger on a side dock or a collapsed bar), in the words the phone's Chat
 * actions trigger uses. `undefined` when there is nothing to say.
 */
export function workingChatsLabel(
  working: number,
  unread: number,
): string | undefined {
  const facts = [
    working > 0 ? `${working} ${working === 1 ? 'chat' : 'chats'} working` : '',
    unread > 0 ? `${unread} unread` : '',
  ].filter(Boolean);
  return facts.length > 0 ? facts.join(', ') : undefined;
}
