import type { EnsembleInspectionInput } from '@kontourai/station-contracts/ensemble';
import { useMutation } from '@tanstack/react-query';
import { inspectEnsemble } from '../client/ensembles';
import type { ApiRequestScope } from '../client/http';

/** Explicit read: no automatic retry, catalog lookup or persistent query key. */
export function useInspectEnsemble(
  scope: ApiRequestScope & { isCurrent: () => boolean },
) {
  return useMutation({
    mutationKey: ['ensemble-inspection', scope.apiBase, scope.authorityKey],
    mutationFn: async (input: EnsembleInspectionInput) => {
      if (!scope.isCurrent()) throw new Error('Station authority changed.');
      const result = await inspectEnsemble(scope.apiBase, input, {
        requestScope: scope,
      });
      if (!scope.isCurrent()) throw new Error('Station authority changed.');
      return result;
    },
    retry: false,
    networkMode: 'always',
    gcTime: 0,
  });
}
