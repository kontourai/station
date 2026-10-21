/**
 * The Task document a tracker item seeds on Start Task (#4003,
 * docs/design/tracker-backed-tasks.md "Starting a Task from a tracker item"):
 * the person-authored brief only, an excerpt of the item's body and its last
 * comments, with a link back. Task memory lives in its own log, never here.
 *
 * Tracker text is quoted (`> `), never pasted as document structure.
 *
 * The excerpt is short on purpose. The Task room document stores every
 * character ever typed into it against a fixed bound (#4007), so the seed
 * leaves people most of that room for their own edits. A Session's brief
 * re-reads the item at dispatch, so nothing here needs to be complete.
 */
import type { WorkItemObservation } from '@kontourai/station-contracts/work-item-provider';

/** How many of the item's newest comments the seed carries. */
export const WORK_ITEM_BRIEF_COMMENTS = 2;
/**
 * The seeded brief, in UTF-16 code units, not counting the one link back to
 * the item.
 */
export const WORK_ITEM_BRIEF_MAX_CHARS = 1200;
/** Each comment's share of the brief. */
const BRIEF_COMMENT_CHARS = 200;
const BODY_CUT_MARKER = '…\n\n[Cut here: the full description is on the item.]';

const quote = (text: string) =>
  text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');

/** Link text is the ref; strip the characters that would end it early. */
const linkText = (text: string) => text.replace(/[[\]\\]/g, '');

/** Cut `text` to `limit` code units without splitting a surrogate pair. */
function cut(text: string, limit: number, marker: string): string {
  if (text.length <= limit) return text;
  let end = Math.max(0, limit);
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end).trimEnd()}${marker}`;
}

export function workItemTaskBrief(observation: WorkItemObservation): string {
  const link = `[${linkText(observation.workItemRef)}](<${observation.url}>)`;
  const comments = (observation.comments ?? []).slice(
    -WORK_ITEM_BRIEF_COMMENTS,
  );
  const head = `Started from ${link}.`;
  const tail = [
    ...(comments.length > 0
      ? [
          `Latest ${comments.length === 1 ? 'comment' : `${comments.length} comments`} on the item:`,
          ...comments.map(
            (comment) =>
              `**@${linkText(comment.author)}**, ${comment.createdAt}:\n${quote(cut(comment.excerpt, BRIEF_COMMENT_CHARS, '…') || '(empty)')}`,
          ),
        ]
      : []),
    'Read the whole item, with every comment, on the tracker.',
  ];
  const compose = (body: string) => [head, body, ...tail].join('\n\n');
  if (!observation.body) return compose('_The item has no description._');
  // Quoting adds two characters a line, so cut the raw body until the quoted
  // brief fits the budget. The link is not counted against it.
  const limit = WORK_ITEM_BRIEF_MAX_CHARS + link.length;
  let budget = limit - compose('').length;
  let brief = compose(quote(cut(observation.body, budget, BODY_CUT_MARKER)));
  while (brief.length > limit && budget > 0) {
    budget -= brief.length - limit;
    brief = compose(quote(cut(observation.body, budget, BODY_CUT_MARKER)));
  }
  return brief;
}
