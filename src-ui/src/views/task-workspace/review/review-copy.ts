import type { TaskReviewThreadView } from '@kontourai/station-contracts/task-review';
import { COPY_TOAST_FAILURE } from '../../../hooks/useCopyToClipboardToast';
import { copyToClipboard } from '../../../lib/clipboard';
import { StationUiError } from '../../../utils/StationUiError';

/**
 * Review's clipboard write, through the UI's single one. A refused or missing
 * clipboard (plain http) is raised as the shared failure sentence, so the
 * caller's own error line reports it instead of a TypeError.
 */
async function copyReviewText(text: string): Promise<void> {
  if (!(await copyToClipboard(text))) {
    throw new StationUiError(COPY_TOAST_FAILURE);
  }
}

/** The address that opens this page at one Review thread. */
function reviewThreadLink(threadId: string): string {
  const url = new URL(window.location.href);
  url.hash = `review-thread-${threadId}`;
  return url.href;
}

export async function copyReviewThreadLink(threadId: string) {
  await copyReviewText(reviewThreadLink(threadId));
}

export async function copyReviewThreadsForAgent(
  threads: readonly TaskReviewThreadView[],
) {
  await copyReviewText(
    threads
      .map((thread) => {
        const artifact = thread.artifact;
        const id =
          artifact.kind === 'answer'
            ? `${artifact.sessionId}/${artifact.turnId}`
            : artifact.id;
        return `Task ${thread.taskId} · ${artifact.kind}:${id} @ ${artifact.revision}\nThread ${thread.ordinal} (${thread.threadId})\n${thread.quote ?? ''}\n${thread.events.flatMap((event) => ('body' in event ? [event.body] : [])).join('\n')}`;
      })
      .join('\n\n'),
  );
}
