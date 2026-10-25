import type {
  ProjectChatApprovalDefault,
  ProjectChatDefaultsView,
} from '@kontourai/station-contracts/project-chat-defaults';
import { PROJECT_CHAT_DEFAULTS_QUERY_KEY_PREFIX } from '@kontourai/station-sdk';
import type { QueryClient } from '@tanstack/react-query';

/**
 * The approval layer a new chat in `projectSlug` starts in, from the answer
 * this tab already read for that Station (`useScopedProjectChatDefaultsQuery`,
 * mounted by the start composers and by a not-yet-started chat).
 *
 * - `{ known: false }`: no answer was read (still loading, or the read
 *   failed). The server applies the Project layer regardless, so a caller
 *   must not queue a mode of its own that could contradict it.
 * - `undefined`: the chat is in no Project.
 */
export function cachedProjectChatApprovalDefault(
  queryClient: QueryClient,
  apiBase: string,
  projectSlug: string | undefined,
):
  | { known: true; resolved: ProjectChatApprovalDefault }
  | { known: false }
  | undefined {
  if (!projectSlug) return undefined;
  for (const [key, data] of queryClient.getQueriesData<ProjectChatDefaultsView>(
    { queryKey: [PROJECT_CHAT_DEFAULTS_QUERY_KEY_PREFIX] },
  )) {
    if (key[1] === apiBase && data?.projectSlug === projectSlug)
      return { known: true, resolved: data.approvalMode.resolved };
  }
  return { known: false };
}
