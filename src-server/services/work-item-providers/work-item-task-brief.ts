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

const quote = (text: string) =>
  text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');

/** Link text is the ref; strip the characters that would end it early. */
const linkText = (text: string) => text.replace(/[[\]\\]/g, '');

export function workItemTaskBrief(observation: WorkItemObservation): string {
  const link = `[${linkText(observation.workItemRef)}](<${observation.url}>)`;
  const parts = [
    `Started from ${link}.`,
    observation.body
      ? quote(observation.body)
      : '_The item has no description._',
  ];
  const comments = (observation.comments ?? []).slice(
    -WORK_ITEM_BRIEF_COMMENTS,
  );
  if (comments.length > 0) {
    parts.push(
      `Latest ${comments.length === 1 ? 'comment' : `${comments.length} comments`} on the item:`,
      ...comments.map(
        (comment) =>
          `**@${linkText(comment.author)}**, ${comment.createdAt}:\n${quote(comment.excerpt || '(empty)')}`,
      ),
    );
  }
  parts.push(`Read the whole item, with every comment, at ${link}.`);
  return parts.join('\n\n');
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
