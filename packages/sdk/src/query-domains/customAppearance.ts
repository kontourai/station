import { getCustomAppearance } from '../client/custom-appearance';
import {
  type ApiRequestScope,
  StationRequestAuthorityError,
} from '../client/http';
import { useApiQuery } from '../query-core';

export const customAppearanceKey = (scope?: ApiRequestScope) => [
  'me',
  'appearance',
  scope?.authorityKey ?? 'unavailable',
];

/** The person's custom appearance; polls so an agent's proposal shows up. */
export function useCustomAppearanceQuery(
  scope?: ApiRequestScope,
  options: { refetchInterval?: number } = {},
) {
  return useApiQuery(
    customAppearanceKey(scope),
    async () => {
      if (!scope) throw new StationRequestAuthorityError();
      return getCustomAppearance(scope.apiBase, { requestScope: scope });
    },
    {
      enabled: !!scope,
      refetchOnMount: 'always',
      refetchInterval: options.refetchInterval ?? 15000,
      retry: false,
    },
  );
}
