import type {
  CustomAppearanceLibraryDocument,
  CustomAppearanceLibrarySaveInput,
  CustomAppearanceLibraryUpdateInput,
} from '@kontourai/station-contracts/custom-appearance';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getCustomAppearanceLibrary,
  removeCustomAppearanceLibraryTheme,
  saveCustomAppearanceLibraryTheme,
  updateCustomAppearanceLibraryTheme,
} from '../client/custom-appearance-library';
import {
  type ApiRequestScope,
  StationRequestAuthorityError,
} from '../client/http';
import { useApiQuery } from '../query-core';
import { customAppearanceKey } from './customAppearance';

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
