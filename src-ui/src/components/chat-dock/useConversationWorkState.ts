import {
  getConversationWorkState,
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
  return {
    query,
    change,
    supported: enabled && !!scope?.isCurrent() && query.data != null,
    settled: query.data?.settled ?? EMPTY_SETTLED,
  };
}

const EMPTY_SETTLED: Readonly<Record<string, string>> = Object.freeze({});
interface WorkState {
  supported: boolean;
  settled: Readonly<Record<string, string>>;
  query: { isError: boolean; refetch(): unknown };
  change: {
    isPending: boolean;
    mutate(input: { conversationId: string; settled: boolean }): void;
  };
}
const WorkStateContext = createContext<WorkState>({
  supported: false,
  settled: EMPTY_SETTLED,
  query: { isError: false, refetch: () => undefined },
  change: { isPending: false, mutate: () => undefined },
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
