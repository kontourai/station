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
export const CONVERSATION_TITLE_MAX_CODE_POINTS = 80;

/**
 * Characters a title an agent supplies may not contain: control characters
 * (`Cc`), line and paragraph separators (`Zl`, `Zp`), the bidi embedding,
 * override and isolate controls that reorder what a reader sees, and the
 * zero-width space and byte-order mark. Not all of `Cf`: the zero-width
 * joiner and non-joiner build emoji sequences and some scripts' words.
 */
const UNSAFE_TITLE_CHARACTERS =
  /[\p{Cc}\p{Zl}\p{Zp}\u200B\uFEFF\u202A-\u202E\u2066-\u2069]/u;

export function hasUnsafeTitleCharacters(title: string): boolean {
  return UNSAFE_TITLE_CHARACTERS.test(title);
}

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
 * How much of the text a title is derived from, after leading whitespace. A
 * title is 80 code points, so the first thousand are far more than it needs in
 * practice; deriving from a whole prompt (callers pass user prompts of any
 * size) made the scans below quadratic. This is a deliberate approximation, not
 * an equivalence: markdown that opens inside the bound and closes beyond it is
 * read as unpaired, and a title whose words all start after 1000 code points
 * of non-leading content (or heavy markup) can derive differently from the
 * unbounded text.
 */
export const TITLE_SOURCE_MAX_CODE_POINTS = 1000;
/** A link label or destination longer than this is plain text, not a link. */
const LINK_LABEL_MAX = 200;
const LINK_DESTINATION_MAX = 500;

function leadingCodePoints(text: string, max: number): string {
  let end = 0;
  let count = 0;
  for (const point of text) {
    if (count === max) break;
    end += point.length;
    count += 1;
  }
  return end === text.length ? text : text.slice(0, end);
}

/**
 * Where the link destination that opens at `start` (just past its `(`) ends,
 * or -1. A URL holds no spaces and may hold balanced parentheses
 * (`https://en.wikipedia.org/wiki/A_(b)`), so the first run up to whitespace is
 * scanned with a depth counter. Failing that (a title after the URL, or
 * parentheses that never balance) the destination ends at its first `)`, as it
 * always did, so `[x](u(b) and (later) text)` keeps its text. Every scan stops
 * LINK_DESTINATION_MAX characters in: past that it is not a link.
 */
function linkDestinationEnd(text: string, start: number): number {
  const limit = Math.min(text.length, start + LINK_DESTINATION_MAX);
  let depth = 1;
  let firstClose = -1;
  let inRun = true;
  for (let index = start; index < limit; index += 1) {
    const char = text[index];
    if (char === ')') {
      if (firstClose === -1) firstClose = index;
      if (inRun) {
        depth -= 1;
        if (depth === 0) return index;
      }
    } else if (inRun && char === '(') {
      depth += 1;
    } else if (inRun && /\s/.test(char)) {
      inRun = false;
    }
    // Once the run is over only the first `)` matters, and it may already be
    // behind us.
    if (!inRun && firstClose !== -1) return firstClose;
  }
  return firstClose;
}

/** `[label](destination)` and `![alt](destination)` become their label. */
function withoutLinks(text: string): string {
  let plain = '';
  let index = 0;
  while (index < text.length) {
    const open = text[index] === '!' ? index + 1 : index;
    if (text[open] === '[') {
      const labelEnd = text.indexOf(']', open + 1);
      if (
        labelEnd !== -1 &&
        labelEnd - open <= LINK_LABEL_MAX &&
        text[labelEnd + 1] === '('
      ) {
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
  if (points.length <= CONVERSATION_TITLE_MAX_CODE_POINTS) return text;
  const head = points.slice(0, CONVERSATION_TITLE_MAX_CODE_POINTS - 1).join('');
  const boundary = head.search(/\s\S*$/);
  const cut =
    boundary >= CONVERSATION_TITLE_MAX_CODE_POINTS / 2
      ? head.slice(0, boundary)
      : head;
  return `${cut.trimEnd()}\u2026`;
}

/** The derived title for `text`, or undefined when it carries no words. */
export function derivedConversationTitle(
  text: string | undefined,
): string | undefined {
  // Leading whitespace is skipped (linear) before the cut so it does not spend
  // the budget.
  const plain = text
    ? plainTitleText(
        leadingCodePoints(text.trimStart(), TITLE_SOURCE_MAX_CODE_POINTS),
      )
    : '';
  return plain ? boundedTitle(plain) : undefined;
}
