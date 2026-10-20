import type {
  PeerEnrollment,
  PeerEnrollmentInput,
} from '@kontourai/station-contracts/environment-security';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApiRequestScope } from '../client/http';
import {
  cancelPeerEnrollment,
  completePeerEnrollment,
  getPeerEnrollment,
  startPeerEnrollment,
} from '../client/peer-enrollments';
import type { QueryConfig } from '../query-core';

export const peerEnrollmentQueries = {
  detail: (apiBase: string, id: string, requestScope?: ApiRequestScope) => ({
    queryKey: [
      'peer-enrollments',
      apiBase,
      requestScope?.authorityKey ?? 'unscoped',
      id,
    ] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      getPeerEnrollment(apiBase, id, { signal, requestScope }),
    retry: false,
    staleTime: 0,
  }),
};

export function usePeerEnrollmentQuery(
  apiBase: string,
  id: string | undefined,
  requestScope?: ApiRequestScope,
  config?: QueryConfig<PeerEnrollment>,
) {
  return useQuery({
    ...peerEnrollmentQueries.detail(apiBase, id ?? '', requestScope),
    ...config,
    enabled: Boolean(id) && (config?.enabled ?? true),
  });
}

function useEnrollmentMutation<TInput>(
  apiBase: string,
  requestScope: ApiRequestScope | undefined,
  mutate: (input: TInput) => Promise<PeerEnrollment>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: mutate,
    retry: false,
    onSuccess: async (enrollment) => {
      queryClient.setQueryData(
        peerEnrollmentQueries.detail(apiBase, enrollment.id, requestScope)
          .queryKey,
        enrollment,
      );
      if (enrollment.status === 'connected')
        await queryClient.invalidateQueries({ queryKey: ['peer-credentials'] });
    },
  });
}

export function useStartPeerEnrollmentMutation(
  apiBase: string,
  requestScope?: ApiRequestScope,
) {
  return useEnrollmentMutation(
    apiBase,
    requestScope,
    (input: PeerEnrollmentInput) =>
      startPeerEnrollment(apiBase, input, { requestScope }),
  );
}

export function useCompletePeerEnrollmentMutation(
  apiBase: string,
  requestScope?: ApiRequestScope,
) {
  return useEnrollmentMutation(apiBase, requestScope, (id: string) =>
    completePeerEnrollment(apiBase, id, { requestScope }),
  );
}

export function useCancelPeerEnrollmentMutation(
  apiBase: string,
  requestScope?: ApiRequestScope,
) {
  return useEnrollmentMutation(apiBase, requestScope, (id: string) =>
    cancelPeerEnrollment(apiBase, id, { requestScope }),
  );
}
