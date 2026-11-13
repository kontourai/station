import type { QueryClient } from '@tanstack/react-query';
import type { ApiRequestScope } from './client/http';

/** The fetch destination is distinct from the credential authority for a relay. */
export interface ConnectionReadTarget {
  targetApiBase: string;
  runtimeKey?: string;
  requestScope: ApiRequestScope;
}

export function connectionQueryKey(
  root: string,
  target?: ConnectionReadTarget,
  ...parameters: (string | number | object)[]
) {
  return target
    ? [
        root,
        target.targetApiBase,
        target.requestScope.authorityKey,
        ...(target.runtimeKey ? [target.runtimeKey] : []),
        ...parameters,
      ]
    : [root, ...parameters];
}

export function captureConnectionReadTarget(
  target?: ConnectionReadTarget,
): ConnectionReadTarget | undefined {
  return target
    ? Object.freeze({
        targetApiBase: target.targetApiBase,
        ...(target.runtimeKey ? { runtimeKey: target.runtimeKey } : {}),
        requestScope: Object.freeze({ ...target.requestScope }),
      })
    : undefined;
}

/**
 * Refetches what names each connection (`useConnectionUsedByQuery`) on every
 * read target. Saving or removing an Agent or a Project changes it.
 */
export function invalidateConnectionUsedBy(queryClient: QueryClient) {
  return queryClient.invalidateQueries({
    predicate: ({ queryKey }) =>
      queryKey[0] === 'connections' &&
      queryKey[queryKey.length - 1] === 'used-by',
  });
}
