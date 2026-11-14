import type {
  EnsembleCliSessionGroupInput,
  EnsembleInspectionInput,
} from '@kontourai/station-contracts/ensemble';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import {
  cancelCliSessionGroup,
  createEnsembleCliSessionGroup,
  runCliSessionGroup,
} from '../client/cli-session-groups';
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

export function useCreateEnsembleCliSessionGroup(
  scope: ApiRequestScope & { isCurrent: () => boolean },
) {
  return useMutation({
    mutationKey: [
      'ensemble-cli-group-create',
      scope.apiBase,
      scope.authorityKey,
    ],
    mutationFn: async (input: EnsembleCliSessionGroupInput) => {
      if (!scope.isCurrent()) throw new Error('Station authority changed.');
      const result = await createEnsembleCliSessionGroup(scope.apiBase, input, {
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

export function useRunCliSessionGroup(
  scope: ApiRequestScope & { isCurrent(): boolean },
) {
  const active = useRef<AbortController | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Changing the authority tuple must interrupt existing supervision.
  useEffect(
    () => () => active.current?.abort(),
    [scope.apiBase, scope.authorityKey],
  );
  return useMutation({
    mutationKey: ['cli-group-run', scope.apiBase, scope.authorityKey],
    mutationFn: async (groupId: string) => {
      if (!scope.isCurrent()) throw new Error('Station authority changed.');
      if (active.current)
        throw new Error('Group supervision is already active.');
      const stop = new AbortController();
      active.current = stop;
      try {
        const result = await runCliSessionGroup(scope.apiBase, groupId, {
          requestScope: scope,
          signal: stop.signal,
        });
        if (!scope.isCurrent()) throw new Error('Station authority changed.');
        return result;
      } finally {
        if (active.current === stop) active.current = undefined;
      }
    },
    retry: false,
    networkMode: 'always',
    gcTime: 0,
  });
}

export function useCancelCliSessionGroup(
  scope: ApiRequestScope & { isCurrent(): boolean },
) {
  return useMutation({
    mutationKey: ['cli-group-cancel', scope.apiBase, scope.authorityKey],
    mutationFn: async (groupId: string) => {
      if (!scope.isCurrent()) throw new Error('Station authority changed.');
      const result = await cancelCliSessionGroup(scope.apiBase, groupId, {
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
