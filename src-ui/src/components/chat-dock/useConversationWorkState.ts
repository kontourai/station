import {
  getConversationWorkState,
  setConversationInboxHidden,
  setConversationWorkState,
} from '@kontourai/station-sdk/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
} from 'react';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { toastStore } from '../../contexts/ToastContext';
import { useSurfaceVisibilityFlags } from '../../hooks/useSurfaceVisibilityFlags';
import type { HomeWorkItem } from '../../views/home/home-view-model';
import type { WorkFacts } from '../../views/home/work-facts';

/** One person/authority-scoped snapshot shared by inbox hosts; no per-row polling. */
function useLiveConversationWorkState() {
  const scope = useHostRequestAuthorityScope();
  const enabled = useSurfaceVisibilityFlags().has('conversation-resolution');
  const cache = useQueryClient();
  const key = ['conversation-work-state', scope?.apiBase, scope?.authorityKey];
  const query = useQuery({
    queryKey: key,
    enabled: enabled && !!scope?.isCurrent(),
    queryFn: ({ signal }) =>
      getConversationWorkState(scope!.apiBase, {
        signal,
        requestScope: scope!,
      }),
    staleTime: 10_000,
    retry: false,
    refetchOnWindowFocus: true,
  });
  const change = useMutation({
    mutationFn: async (input: { conversationId: string; settled: boolean }) => {
      if (!scope?.isCurrent() || !enabled)
        throw new Error('Conversation resolution unavailable');
      await setConversationWorkState(
        scope.apiBase,
        input.conversationId,
        input.settled,
        { requestScope: scope },
      );
    },
    onSuccess: () => {
      if (scope?.isCurrent()) void cache.invalidateQueries({ queryKey: key });
    },
    onError: () => {
      if (scope?.isCurrent())
        toastStore.show(
          'Could not update this conversation. Try again.',
          undefined,
          8000,
        );
    },
  });
  const supported = enabled && !!scope?.isCurrent() && query.data != null;
  const hiding = useMutation({
    mutationFn: async (input: { sessionId: string; hidden: boolean }) => {
      if (!scope?.isCurrent() || !enabled)
        throw new Error('Conversation resolution unavailable');
      await setConversationInboxHidden(
        scope.apiBase,
        input.sessionId,
        input.hidden,
        { requestScope: scope },
      );
    },
    // The row leaves (or returns) at once; the read settles it either way.
    onMutate: (input) => {
      cache.setQueryData<typeof query.data>(key, (data) =>
        data?.hidden
          ? {
              ...data,
              hidden: input.hidden
                ? {
                    ...data.hidden,
                    [input.sessionId]: new Date().toISOString(),
                  }
                : Object.fromEntries(
                    Object.entries(data.hidden).filter(
                      ([id]) => id !== input.sessionId,
                    ),
                  ),
            }
          : data,
      );
    },
    onSettled: () => {
      if (scope?.isCurrent()) void cache.invalidateQueries({ queryKey: key });
    },
    onError: () => {
      if (scope?.isCurrent())
        toastStore.show(
          'Could not update this session. Try again.',
          undefined,
          8000,
        );
    },
  });
  const hideSupported = supported && query.data?.hidden != null;
  /**
   * Moves locally dismissed third-party Sessions to the host, quietly, one at
   * a time. Answers the ids the caller may drop locally: those now hidden on
   * the host, and those the host refuses as not a Session the person can
   * read (a 404 other than a disabled preview), which no retry will change.
   */
  const migrateHidden = async (sessionIds: readonly string[]) => {
    const settled: string[] = [];
    for (const sessionId of sessionIds) {
      if (!scope?.isCurrent() || !hideSupported) break;
      try {
        await setConversationInboxHidden(scope.apiBase, sessionId, true, {
          requestScope: scope,
        });
        settled.push(sessionId);
      } catch (error) {
        const refusal = error as { status?: number; code?: string };
        if (
          refusal.status === 404 &&
          refusal.code !== 'feature_preview_disabled'
        )
          settled.push(sessionId);
      }
    }
    if (settled.length && scope?.isCurrent())
      void cache.invalidateQueries({ queryKey: key });
    return settled;
  };
  return {
    query,
    change,
    supported,
    settled: query.data?.settled ?? EMPTY_SETTLED,
    hideSupported,
    hidden: (hideSupported && query.data?.hidden) || EMPTY_SETTLED,
    hide: hiding,
    migrateHidden,
    scopeKey: scope
      ? JSON.stringify([scope.apiBase, scope.authorityKey])
      : null,
  };
}

const EMPTY_SETTLED: Readonly<Record<string, string>> = Object.freeze({});
interface WorkState {
  supported: boolean;
  settled: Readonly<Record<string, string>>;
  /** The host keeps hidden third-party Sessions per person (`hidden` present). */
  hideSupported: boolean;
  /** Hidden third-party Session thread id to when it was hidden. */
  hidden: Readonly<Record<string, string>>;
  query: { isError: boolean; refetch(): unknown };
  change: {
    isPending: boolean;
    mutate(input: { conversationId: string; settled: boolean }): void;
  };
  hide: {
    mutate(input: { sessionId: string; hidden: boolean }): void;
  };
  migrateHidden(sessionIds: readonly string[]): Promise<string[]>;
  /** The host authority this state belongs to. */
  scopeKey: string | null;
}
const WorkStateContext = createContext<WorkState>({
  supported: false,
  settled: EMPTY_SETTLED,
  hideSupported: false,
  hidden: EMPTY_SETTLED,
  query: { isError: false, refetch: () => undefined },
  change: { isPending: false, mutate: () => undefined },
  hide: { mutate: () => undefined },
  migrateHidden: () => Promise.resolve([]),
  scopeKey: null,
});
export function ConversationWorkStateProvider({
  children,
}: {
  children: ReactNode;
}) {
  const state = useLiveConversationWorkState();
  return createElement(WorkStateContext.Provider, { value: state }, children);
}
export function useConversationWorkState(): WorkState {
  return useContext(WorkStateContext);
}

/**
 * The Session a person hides when this row is a third-party Session of this
 * host: its thread id. `null` for owned work and for rows from another
 * Station, which keep their existing put-away actions.
 */
export function inboxHideTarget(
  item: Pick<
    HomeWorkItem,
    'kind' | 'id' | 'controlMode' | 'environmentId' | 'orchestrationThreadId'
  >,
  facts?: Pick<WorkFacts, 'hostDetails'>,
): string | null {
  if (
    item.controlMode !== 'read-only-attached' ||
    item.kind === 'remote-session' ||
    item.kind === 'task' ||
    item.environmentId ||
    facts?.hostDetails === false
  )
    return null;
  return (
    item.orchestrationThreadId ??
    (item.kind === 'orchestration' ? item.id : null)
  );
}

/** Whether this row's Session is hidden on the host and still third-party. */
export function isHostHidden(
  item: Parameters<typeof inboxHideTarget>[0],
  hidden: Readonly<Record<string, string>>,
  facts?: Pick<WorkFacts, 'hostDetails'>,
) {
  const target = inboxHideTarget(item, facts);
  return target !== null && Object.hasOwn(hidden, target);
}
