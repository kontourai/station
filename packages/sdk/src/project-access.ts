import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ApiRequestScope, isApiRequestScope } from './client/http';
import {
  changeProjectAccess,
  getProjectAccess,
  type ProjectAccessCommand,
} from './client/project-access';

export {
  changeProjectAccess,
  getProjectAccess,
  type ProjectAccessCommand,
  type ProjectAccessCommandResult,
} from './client/project-access';

const key = (slug: string, scope: ApiRequestScope) =>
  ['project-access', scope.apiBase, scope.authorityKey, slug] as const;

/** Administrative projections are not persisted or carried across Station authority changes. */
export function useProjectAccess(slug: string, requestScope?: ApiRequestScope) {
  const client = useQueryClient();
  const valid = isApiRequestScope(requestScope);
  const query = useQuery({
    queryKey: valid ? key(slug, requestScope) : ['project-access-unbound'],
    queryFn: ({ signal }) => {
      if (!isApiRequestScope(requestScope))
        throw new Error(
          'Project access requires a current Station connection.',
        );
      return getProjectAccess(requestScope.apiBase, slug, {
        requestScope,
        signal,
      });
    },
    enabled: valid,
    gcTime: 0,
    staleTime: 0,
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    refetchInterval: 5000,
  });
  const mutation = useMutation({
    gcTime: 0,
    mutationFn: (input: {
      slug: string;
      requestScope: ApiRequestScope;
      command: ProjectAccessCommand;
    }) =>
      changeProjectAccess(
        input.requestScope.apiBase,
        input.slug,
        input.command,
        { requestScope: input.requestScope },
      ),
    onSuccess: (_data, input) =>
      client.invalidateQueries({
        queryKey: key(input.slug, input.requestScope),
      }),
  });
  return {
    query,
    mutation,
    async change(command: ProjectAccessCommand) {
      if (!isApiRequestScope(requestScope))
        throw new Error(
          'Project access requires a current Station connection.',
        );
      return mutation.mutateAsync({
        slug,
        requestScope: { ...requestScope },
        command: structuredClone(command),
      });
    },
  };
}
