import type { TaskReviewThreadView } from '@kontourai/station-contracts/task-review';

export async function copyReviewThreadsForAgent(
  threads: readonly TaskReviewThreadView[],
) {
  await navigator.clipboard.writeText(
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
