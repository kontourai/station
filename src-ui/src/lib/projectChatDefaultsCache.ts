import type {
  ProjectChatApprovalDefault,
  ProjectChatDefaultsView,
} from '@kontourai/station-contracts/project-chat-defaults';
import {
  getProjectChatDefaults,
  projectChatDefaultsQueryKey,
} from '@kontourai/station-sdk';
import type { QueryClient } from '@tanstack/react-query';

/** How long a first send waits for a Project answer it does not have yet. */
const SEND_LOOKUP_TIMEOUT_MS = 3_000;

/** No Project layer applies (`getProjectChatDefaults` answered `null`). */
const NO_PROJECT_LAYER: ProjectChatApprovalDefault = { source: 'none' };

/**
 * The approval layer a new chat in `projectSlug` starts in, for a first send.
 *
 * Reads the exact entry `useScopedProjectChatDefaultsQuery` caches for this
 * Station and authority (`projectChatDefaultsQueryKey`). Without one (the
 * composer's read is still loading) it fetches once, bounded, and caches the
 * answer.
 *
 * - `{ known: true }`: the server's answer; `source: 'none'` when no Project
 *   layer applies, including a Station without the route.
 * - `{ known: false }`: no answer could be had. The server applies the
 *   Project layer regardless, so the caller must not queue a mode of its own
 *   that could contradict it.
 * - `undefined`: the chat is in no Project.
 */
export async function projectChatApprovalForSend(
  queryClient: QueryClient,
  input: {
    projectSlug: string | undefined;
    requestScope:
      | { apiBase: string; authorityKey: string; isCurrent: () => boolean }
      | undefined;
    durableAuthorityId: string | undefined;
  },
): Promise<
  | { known: true; resolved: ProjectChatApprovalDefault }
  | { known: false }
  | undefined
> {
  if (!input.projectSlug) return undefined;
  if (!input.requestScope) return { known: false };
  const key = projectChatDefaultsQueryKey(
    input.requestScope,
    input.durableAuthorityId,
    input.projectSlug,
  );
  const answer = (view: ProjectChatDefaultsView | null) => ({
    known: true as const,
    resolved: view?.approvalMode.resolved ?? NO_PROJECT_LAYER,
  });
  const cached = queryClient.getQueryData<ProjectChatDefaultsView | null>(key);
  if (cached !== undefined) return answer(cached);
  // Bounded by the timer itself, not only by the abort it sends: a transport
  // may take time before it hands the signal on (credential resolution), or
  // ignore it. Past the bound the send goes on as if unanswered.
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<{ known: false }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ known: false });
    }, SEND_LOOKUP_TIMEOUT_MS);
  });
  const read = (async () => {
    const fetched = await getProjectChatDefaults(
      input.requestScope!.apiBase,
      input.projectSlug!,
      { requestScope: input.requestScope, signal: controller.signal },
    );
    queryClient.setQueryData(key, fetched);
    return answer(fetched);
  })().catch(() => ({ known: false }) as const);
  try {
    return await Promise.race([read, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
