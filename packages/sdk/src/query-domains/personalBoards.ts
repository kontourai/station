import type {
  PersonalBoardDocument,
  PersonalBoardSaveInput,
} from '@kontourai/station-contracts/personal-board';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  type ApiRequestScope,
  StationRequestAuthorityError,
} from '../client/http';
import {
  dismissPersonalBoardProposal,
  getPersonalBoard,
  savePersonalBoard,
} from '../client/personal-boards';
import { useApiQuery, useApiQueryWithSharing } from '../query-core';
import { fetchAttention } from './attention';
import { fetchOrchestrationSessions } from './chatRuntimeOrchestration';
import { personalLayoutsKey } from './personalLayouts';
import { shareSessionReadModel } from './sessionStructuralSharing';

const key = (slug: string, scope?: ApiRequestScope) => [
  'me',
  'boards',
  scope?.authorityKey ?? 'unavailable',
  slug,
];
export function usePersonalBoardQuery(slug: string, scope?: ApiRequestScope) {
  return useApiQuery(
    key(slug, scope),
    async () => {
      if (!scope) throw new StationRequestAuthorityError();
      return getPersonalBoard(scope.apiBase, slug, { requestScope: scope });
    },
    {
      enabled: !!scope,
      refetchOnMount: 'always',
      refetchInterval: 5000,
      retry: false,
    },
  );
}
export function useSavePersonalBoardMutation(
  slug: string,
  scope?: ApiRequestScope,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: PersonalBoardSaveInput | { revision: string; dismiss: true },
    ) => {
      if (!scope) throw new StationRequestAuthorityError();
      return 'dismiss' in input
        ? dismissPersonalBoardProposal(scope.apiBase, slug, input.revision, {
            requestScope: scope,
          })
        : savePersonalBoard(scope.apiBase, slug, input, {
            requestScope: scope,
          });
    },
    onSuccess: (data: PersonalBoardDocument) => {
      client.setQueryData(key(slug, scope), data);
      client.invalidateQueries({ queryKey: personalLayoutsKey() });
    },
    retry: false,
  });
}

export function useBoardAttentionQuery(scope?: ApiRequestScope) {
  return useApiQuery(
    ['me', 'board-attention', scope?.authorityKey ?? 'unavailable'],
    () => {
      if (!scope) throw new StationRequestAuthorityError();
      return fetchAttention(scope.apiBase, { requestScope: scope });
    },
    {
      enabled: !!scope,
      refetchInterval: 10000,
      refetchOnMount: 'always',
      retry: false,
    },
  );
}
export function useBoardRecentWorkQuery(scope?: ApiRequestScope) {
  return useApiQueryWithSharing(
    ['me', 'board-recent-work', scope?.authorityKey ?? 'unavailable'],
    () => {
      if (!scope) throw new StationRequestAuthorityError();
      return fetchOrchestrationSessions(scope.apiBase, { requestScope: scope });
    },
    shareSessionReadModel,
    {
      enabled: !!scope,
      refetchInterval: 10000,
      refetchOnMount: 'always',
      retry: false,
    },
  );
}
