/**
 * The title a conversation derives from what its user first wrote, until
 * something renames it. Every place that derives one (the session query
 * module's conversation read, the lineage's session conversation, and the
 * event store's persisted history row) goes through here, so a conversation
 * reads the same in its header, the chat list and a failure screen.
 *
 * A title is a name, shown as text and never rendered as markdown. The user's
 * first words often are markdown ("Run `ls -la`"), so inline markers, link
 * syntax and a leading block marker are dropped and whitespace is collapsed.
 * It is then bounded to 80 code points; a cut ends at the last word boundary
 * in the second half of the budget and is marked with "…", instead of slicing
 * a word ("`git statu").
 */
const TITLE_MAX_CODE_POINTS = 80;

function plainTitleText(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~]+/g, '')
    .replace(/^\s*(?:#{1,6}|>|[-+]|\d+\.)\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function boundedTitle(text: string): string {
  const points = Array.from(text);
  if (points.length <= TITLE_MAX_CODE_POINTS) return text;
  const head = points.slice(0, TITLE_MAX_CODE_POINTS - 1).join('');
  const boundary = head.search(/\s\S*$/);
  const cut =
    boundary >= TITLE_MAX_CODE_POINTS / 2 ? head.slice(0, boundary) : head;
  return `${cut.trimEnd()}\u2026`;
}

/** The derived title for `text`, or undefined when it carries no words. */
export function derivedConversationTitle(
  text: string | undefined,
): string | undefined {
  const plain = text ? plainTitleText(text) : '';
  return plain ? boundedTitle(plain) : undefined;
}
