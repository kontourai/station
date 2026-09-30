/**
 * The title a conversation derives from what its user first wrote, until
 * something renames it. Every place that derives one (the session query
 * module's conversation read, the lineage's session conversation, and the
 * event store's persisted history row) goes through here, so a conversation
 * reads the same in its header, the chat list and a failure screen.
 *
 * A title is a name, shown as text and never rendered as markdown. The user's
 * first words often are markdown ("Run `ls -la`"), so paired inline markers
 * (code, bold, emphasis, strikethrough), link syntax and a leading block
 * marker are dropped and whitespace is collapsed; underscores and asterisks
 * inside words are kept.
 * It is then bounded to 80 code points; a cut ends at the last word boundary
 * in the second half of the budget and is marked with "…", instead of slicing
 * a word ("`git statu").
 */
const TITLE_MAX_CODE_POINTS = 80;

// Emphasis only counts as markdown where it opens at a word start and closes
// at a word end, as CommonMark would read it. Characters INSIDE a word are
// never markup: `user_id`, `__init__.py`, `2*3*4` are identifiers and maths,
// and a title is written once, so stripping them would corrupt it for good.
const OPENS = String.raw`(^|[\s(\[{"'])`;
const CLOSES_STAR = String.raw`(?=$|[\s)\]}"'.,;:!?])`;
// A closing underscore must not be followed by `.`: `__init__.py`.
const CLOSES_UNDERSCORE = String.raw`(?=$|[\s)\]}"',;:!?])`;
const EMPHASIS = [
  new RegExp(`${OPENS}\\*\\*(?=\\S)(.+?)(?<=\\S)\\*\\*${CLOSES_STAR}`, 'g'),
  new RegExp(`${OPENS}__(?=\\S)(.+?)(?<=\\S)__${CLOSES_UNDERSCORE}`, 'g'),
  new RegExp(`${OPENS}~~(?=\\S)(.+?)(?<=\\S)~~${CLOSES_STAR}`, 'g'),
  new RegExp(`${OPENS}\\*(?=\\S)(.+?)(?<=\\S)\\*${CLOSES_STAR}`, 'g'),
  new RegExp(`${OPENS}_(?=\\S)(.+?)(?<=\\S)_${CLOSES_UNDERSCORE}`, 'g'),
];

function plainTitleText(text: string): string {
  let plain = text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
  for (const pattern of EMPHASIS) plain = plain.replace(pattern, '$1$2');
  return plain
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
