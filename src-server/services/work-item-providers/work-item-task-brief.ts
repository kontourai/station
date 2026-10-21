/**
 * The Task document a tracker item seeds on Start Task (#4003,
 * docs/design/tracker-backed-tasks.md "Starting a Task from a tracker item"):
 * the item's body and its last few comments, with a link back.
 *
 * Tracker text is quoted (`> `), never pasted as document structure. The
 * Task document's memory is keyed by its fixed `##` headings, and an issue
 * body that contains `## Done` must not become one of them.
 */
import type { WorkItemObservation } from '@kontourai/station-contracts/work-item-provider';

/** How many of the item's newest comments the brief carries. */
export const WORK_ITEM_BRIEF_COMMENTS = 3;
/**
 * The whole seeded brief, in UTF-16 code units. The Task room commits a new
 * document in one batch, and on 2026-10-21 a batch of about 3,650 or more
 * characters failed with "Room unavailable" (probed through
 * `POST /api/tasks/:taskId/room/batches` on an isolated Station). The brief
 * stays well under that, leaving room for the memory headings.
 */
export const WORK_ITEM_BRIEF_MAX_CHARS = 3000;
/** Each comment's share of the brief. */
const BRIEF_COMMENT_CHARS = 400;
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
    `Read the whole item, with every comment, at ${link}.`,
  ];
  const compose = (body: string) => [head, body, ...tail].join('\n\n');
  if (!observation.body) return compose('_The item has no description._');
  // Quoting adds two characters a line, so cut the raw body until the quoted
  // brief fits the budget.
  let budget = WORK_ITEM_BRIEF_MAX_CHARS - compose('').length;
  let brief = compose(quote(cut(observation.body, budget, BODY_CUT_MARKER)));
  while (brief.length > WORK_ITEM_BRIEF_MAX_CHARS && budget > 0) {
    budget -= brief.length - WORK_ITEM_BRIEF_MAX_CHARS;
    brief = compose(quote(cut(observation.body, budget, BODY_CUT_MARKER)));
  }
  return brief;
}

/**
 * The single call site that turns the brief into the full Task document.
 *
 * TODO(lane `notes`, epic #4003): append the four Task memory headings
 * (`## Decisions`, `## Done`, `## In progress`, `## Open questions`) here
 * with the helper the notes lane exports. Until it lands the document is the
 * brief alone.
 */
export function workItemTaskDocument(observation: WorkItemObservation): string {
  return workItemTaskBrief(observation);
}
