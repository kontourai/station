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

/**
 * Where a link destination that opens at `start` (just past its `(`) ends: the
 * `)` that balances it, because a URL may contain balanced parentheses
 * (`https://en.wikipedia.org/wiki/A_(b)`). A destination whose parentheses
 * never balance ends at its first `)`, as a destination always did.
 */
function linkDestinationEnd(text: string, start: number): number {
  let depth = 1;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return text.indexOf(')', start);
}

/** `[label](destination)` and `![alt](destination)` become their label. */
function withoutLinks(text: string): string {
  let plain = '';
  let index = 0;
  while (index < text.length) {
    const open = text[index] === '!' ? index + 1 : index;
    if (text[open] === '[') {
      const labelEnd = text.indexOf(']', open + 1);
      if (labelEnd !== -1 && text[labelEnd + 1] === '(') {
        const end = linkDestinationEnd(text, labelEnd + 2);
        if (end !== -1) {
          plain += text.slice(open + 1, labelEnd);
          index = end + 1;
          continue;
        }
      }
    }
    plain += text[index];
    index += 1;
  }
  return plain;
}

function plainTitleText(text: string): string {
  let plain = withoutLinks(text).replace(/`([^`]+)`/g, '$1');
  for (const pattern of EMPHASIS) plain = plain.replace(pattern, '$1$2');
  return plain
    .replace(/^\s*(?:#{1,6}|>|[-+*]|\d+\.)\s+/, '')
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
