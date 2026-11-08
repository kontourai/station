import { getAuthorityObservation } from '@kontourai/station-sdk/authority-observation';
import { useQuery } from '@tanstack/react-query';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';

/**
 * What this device may do with an engine's accounts and usage, from the
 * host's own authority observation (never assumed). Allowance and usage reads
 * need `access:manage`; sign-in needs `engine:login`. Both the Accounts and
 * the Usage tab ask this one question.
 */
export function useEngineAccountAccess() {
  const scope = useHostRequestAuthorityScope();
  const authority = useQuery({
    queryKey: ['engine-account-authority', scope?.apiBase, scope?.authorityKey],
    queryFn: ({ signal }) => {
      if (!scope) throw new Error('Connect to this Station.');
      return getAuthorityObservation(scope.apiBase, {
        requestScope: scope,
        signal,
      });
    },
    enabled: !!scope,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const grant = authority.data?.grant;
  return {
    scope,
    authority,
    canManage:
      grant?.kind === 'operator' ||
      (grant?.kind === 'device' &&
        grant.grantedScopes.includes('access:manage')),
    canLogin:
      grant?.kind === 'operator' ||
      (grant?.kind === 'device' &&
        grant.grantedScopes.includes('engine:login')),
  };
}
