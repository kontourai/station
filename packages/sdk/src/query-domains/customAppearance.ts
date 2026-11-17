import type {
  CustomAppearance,
  CustomAppearanceDocument,
  CustomAppearanceLibraryDocument,
  CustomAppearanceLibrarySaveInput,
  CustomAppearanceLibraryUpdateInput,
  CustomAppearanceRenderReport,
} from '@kontourai/station-contracts/custom-appearance';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  dismissCustomAppearanceProposal,
  getCustomAppearance,
  getCustomAppearanceLibrary,
  keepCustomAppearanceProposal,
  removeCustomAppearanceLibraryTheme,
  reportCustomAppearanceRender,
  saveCustomAppearance,
  saveCustomAppearanceLibraryTheme,
  updateCustomAppearanceLibraryTheme,
} from '../client/custom-appearance';
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

export type CustomAppearanceAction =
  | { kind: 'save'; revision: string; appearance: CustomAppearance | null }
  | { kind: 'keep'; revision: string; proposalId: string }
  | { kind: 'dismiss'; revision: string }
  | {
      kind: 'report';
      report: Omit<CustomAppearanceRenderReport, 'reportedAt'>;
    };

/** The person's own steps. The server refuses every one of them to an agent. */
export function useCustomAppearanceMutation(scope?: ApiRequestScope) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (
      action: CustomAppearanceAction,
    ): Promise<CustomAppearanceDocument> => {
      if (!scope) throw new StationRequestAuthorityError();
      const opts = { requestScope: scope };
      switch (action.kind) {
        case 'save':
          return saveCustomAppearance(
            scope.apiBase,
            { revision: action.revision, appearance: action.appearance },
            opts,
          );
        case 'keep':
          return keepCustomAppearanceProposal(
            scope.apiBase,
            { revision: action.revision, proposalId: action.proposalId },
            opts,
          );
        case 'dismiss':
          return dismissCustomAppearanceProposal(
            scope.apiBase,
            action.revision,
            opts,
          );
        case 'report':
          return reportCustomAppearanceRender(
            scope.apiBase,
            action.report,
            opts,
          );
      }
    },
    onSuccess: (data) => client.setQueryData(customAppearanceKey(scope), data),
    retry: false,
  });
}

export const customAppearanceLibraryKey = (scope?: ApiRequestScope) => [
  ...customAppearanceKey(scope),
  'library',
];

export function useCustomAppearanceLibraryQuery(
  scope?: ApiRequestScope,
  options: { enabled?: boolean } = {},
) {
  return useApiQuery(
    customAppearanceLibraryKey(scope),
    async () => {
      if (!scope) throw new StationRequestAuthorityError();
      return getCustomAppearanceLibrary(scope.apiBase, { requestScope: scope });
    },
    { enabled: !!scope && options.enabled !== false, retry: false },
  );
}
export type CustomAppearanceLibraryAction =
  | ({ kind: 'save' } & CustomAppearanceLibrarySaveInput)
  | ({ kind: 'update' } & CustomAppearanceLibraryUpdateInput)
  | { kind: 'remove'; revision: string; id: string };

export function useCustomAppearanceLibraryMutation(scope?: ApiRequestScope) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (
      action: CustomAppearanceLibraryAction,
    ): Promise<CustomAppearanceLibraryDocument> => {
      if (!scope) throw new StationRequestAuthorityError();
      const opts = { requestScope: scope };
      switch (action.kind) {
        case 'save':
          return saveCustomAppearanceLibraryTheme(
            scope.apiBase,
            {
              revision: action.revision,
              appearance: action.appearance,
              ...(action.id === undefined ? {} : { id: action.id }),
              ...(action.name === undefined ? {} : { name: action.name }),
              ...(action.favorite === undefined
                ? {}
                : { favorite: action.favorite }),
            },
            opts,
          );
        case 'update':
          return updateCustomAppearanceLibraryTheme(
            scope.apiBase,
            {
              revision: action.revision,
              id: action.id,
              ...(action.name === undefined ? {} : { name: action.name }),
              ...(action.favorite === undefined
                ? {}
                : { favorite: action.favorite }),
            },
            opts,
          );
        case 'remove':
          return removeCustomAppearanceLibraryTheme(
            scope.apiBase,
            { revision: action.revision, id: action.id },
            opts,
          );
      }
    },
    onSuccess: (data) =>
      client.setQueryData(customAppearanceLibraryKey(scope), data),
    retry: false,
  });
}
