import type {
  ProjectChatApprovalDefault,
  ProjectChatDefaultsView,
} from '@kontourai/station-contracts/project-chat-defaults';
import { PROJECT_CHAT_DEFAULTS_QUERY_KEY_PREFIX } from '@kontourai/station-sdk';
import type { QueryClient } from '@tanstack/react-query';

/**
 * The approval layer a new chat in `projectSlug` starts in, from the answer
 * this tab already read for that Station (`useScopedProjectChatDefaultsQuery`,
 * mounted by the start composers and by a not-yet-started chat). `undefined`
 * when nothing was read: the caller then behaves as before the Project layer
 * existed.
 */
export function cachedProjectChatApprovalDefault(
  queryClient: QueryClient,
  apiBase: string,
  projectSlug: string | undefined,
): ProjectChatApprovalDefault | undefined {
  if (!projectSlug) return undefined;
  for (const [key, data] of queryClient.getQueriesData<ProjectChatDefaultsView>(
    { queryKey: [PROJECT_CHAT_DEFAULTS_QUERY_KEY_PREFIX] },
  )) {
    if (key[1] === apiBase && data?.projectSlug === projectSlug)
      return data.approvalMode.resolved;
  }
  return undefined;
}
