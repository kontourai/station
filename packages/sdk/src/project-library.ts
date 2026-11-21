import type {
  ProjectLibraryPage,
  ProjectLibraryUpload,
} from '@kontourai/station-contracts/project-library';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  deleteProjectLibraryFile,
  getProjectLibrary,
  uploadProjectLibraryFile,
} from './client/project-library';
import {
  type ApiRequestScope,
  type QueryConfig,
  resolveApiBase,
  useApiQuery,
} from './query-core';

export {
  deleteProjectLibraryFile,
  downloadProjectLibraryContent,
  getProjectLibrary,
  type ProjectLibraryContent,
  readProjectLibraryCapability,
  uploadProjectLibraryFile,
} from './client/project-library';

/** A Station request scope; `isCurrent`, when given, drops answers from a changed connection. */
export type ProjectLibraryRequestScope = ApiRequestScope & {
  isCurrent?: () => boolean;
};
const stale = (scope?: ProjectLibraryRequestScope) =>
  scope?.isCurrent !== undefined && !scope.isCurrent();

/** Keys carry the Station and authority, so two Stations never share a Library. */
export const projectLibraryQueries = {
  library: (slug: string, scope?: ApiRequestScope) => ({
    queryKey: [
      'project-library',
      slug,
      scope?.apiBase ?? null,
      scope?.authorityKey ?? null,
    ],
    staleTime: 10_000,
  }),
};

export function useProjectLibraryQuery(
  slug: string,
  config?: QueryConfig<ProjectLibraryPage> & {
    requestScope?: ProjectLibraryRequestScope;
  },
) {
  const scope = config?.requestScope;
  const query = projectLibraryQueries.library(slug, scope);
  return useApiQuery(
    query.queryKey,
    async (signal) => {
      if (stale(scope)) throw new Error('Project Library connection changed.');
      const page = await getProjectLibrary(
        scope?.apiBase ?? (await resolveApiBase()),
        slug,
        {
          signal,
          ...(scope
            ? {
                requestScope: {
                  apiBase: scope.apiBase,
                  authorityKey: scope.authorityKey,
                },
              }
            : {}),
        },
      );
      if (stale(scope)) throw new Error('Project Library connection changed.');
      return page;
    },
    {
      staleTime: config?.staleTime ?? query.staleTime,
      enabled: (config?.enabled ?? slug.length > 0) && !stale(scope),
      refetchOnMount: config?.refetchOnMount ?? 'always',
    },
  );
}

type LibraryMutationScope = {
  slug: string;
  requestScope?: ProjectLibraryRequestScope;
};

export function useUploadProjectLibraryFileMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: LibraryMutationScope & { relativePath: string; file: Blob },
    ): Promise<ProjectLibraryUpload> =>
      uploadProjectLibraryFile(
        input.requestScope?.apiBase ?? (await resolveApiBase()),
        input.slug,
        input.relativePath,
        input.file,
        input.requestScope
          ? {
              requestScope: {
                apiBase: input.requestScope.apiBase,
                authorityKey: input.requestScope.authorityKey,
              },
            }
          : undefined,
      ),
    onSettled: (_data, _error, input) =>
      client.invalidateQueries({
        queryKey: projectLibraryQueries.library(input.slug, input.requestScope)
          .queryKey,
      }),
  });
}

export function useDeleteProjectLibraryFileMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: LibraryMutationScope & { relativePath: string },
    ): Promise<void> =>
      deleteProjectLibraryFile(
        input.requestScope?.apiBase ?? (await resolveApiBase()),
        input.slug,
        input.relativePath,
        input.requestScope
          ? {
              requestScope: {
                apiBase: input.requestScope.apiBase,
                authorityKey: input.requestScope.authorityKey,
              },
            }
          : undefined,
      ),
    onSettled: (_data, _error, input) =>
      client.invalidateQueries({
        queryKey: projectLibraryQueries.library(input.slug, input.requestScope)
          .queryKey,
      }),
  });
}
