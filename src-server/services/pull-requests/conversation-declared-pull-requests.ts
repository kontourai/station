import type { ConversationPullRequestLink } from '@kontourai/station-contracts/conversation-pull-request-links';

interface KeptDeclaredPullRequest {
  provider: string;
  host: string;
  repository: { owner: string; name: string };
  ref: string;
  keptAt: string;
}

/**
 * The pull requests a conversation's Tasks declared and kept, from ANY of its
 * Sessions: the root whose id the conversation carries, and every successor
 * in its lineage (after a context reset or a handoff). Asking only the root
 * missed everything a successor declared. One link per pull request.
 */
export function declaredPullRequestsForConversation(
  deps: {
    taskIds: () => readonly string[];
    lineageSessionIds: (conversationId: string) => readonly string[];
    keptForSession: (
      taskId: string,
      sessionId: string,
    ) => readonly KeptDeclaredPullRequest[];
  },
  conversationId: string,
): ConversationPullRequestLink[] {
  const sessionIds = [
    ...new Set([conversationId, ...deps.lineageSessionIds(conversationId)]),
  ];
  const seen = new Set<string>();
  const links: ConversationPullRequestLink[] = [];
  for (const taskId of deps.taskIds())
    for (const sessionId of sessionIds)
      for (const reference of deps.keptForSession(taskId, sessionId)) {
        const key = JSON.stringify([
          reference.provider,
          reference.host.toLowerCase(),
          reference.repository.owner.toLowerCase(),
          reference.repository.name.toLowerCase(),
          reference.ref,
        ]);
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({
          provider: reference.provider,
          host: reference.host,
          repository: reference.repository,
          ref: reference.ref,
          source: 'task-declared',
          linkedAt: reference.keptAt,
          linkedBy: 'station.task-graph',
        });
      }
  return links;
}
