import type { ProjectResourceBindOutcome } from '@kontourai/station-contracts/project-identity';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { _getApiBase } from '../api';
import {
  type ApiRequestScope,
  StationRequestAuthorityError,
} from '../client/http';
import {
  applyProjectLayout,
  bindProjectResource,
  createProjectLayout,
  createProject as createProjectRaw,
  deleteProjectLayout,
  deleteProject as deleteProjectRaw,
  setProjectLifecycle,
  updateProject as updateProjectRaw,
} from '../client/projects';
import { captureProjectScope } from '../project-scope';
import { type MutationOptions, useApiMutation } from '../query-core';
import {
  PROJECT_CHAT_DEFAULTS_QUERY_KEY_PREFIX,
  projectChatDefaultsQueryKey,
} from './workspaceProjects';

/**
 * station#1502 slice 4 — §3.6's repair action.
 *
 * Invalidates the resolution query on success so the surface re-reads what the
 * Station can now say, rather than assuming the bind produced `bound`. A
 * REFUSAL rejects with the server's reason and invalidates nothing: nothing
 * was recorded, so nothing changed.
 *
 * The success value is a {@link ProjectResourceBindOutcome}, not a view: the
 * write and the re-read are two facts, and a failed re-read leaves a RECORDED
 * binding whose gap the surface must name rather than report as a failed bind.
 * The invalidation runs either way — it is what recovers from the gap.
 *
 * station#1503 slice 5: the variable is `{ path, resourceId? }`, because a
 * multi-repo project has one repair form PER RESOURCE and each must write the
 * record it is captioned with. `resourceId` is optional so a single-repo
 * project's form is unchanged, and the server refuses an unknown id rather
 * than falling back to the primary.
 */
export interface BindProjectResourceVariables {
  path: string;
  resourceId?: string;
}

export function useBindProjectResourceMutation(
  projectSlug: string,
  options?: MutationOptions<
    ProjectResourceBindOutcome,
    BindProjectResourceVariables
  >,
  requestScope?: ApiRequestScope,
) {
  const scope = captureProjectScope(requestScope);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (variables: BindProjectResourceVariables) => {
      if (requestScope !== undefined && !scope)
        throw new StationRequestAuthorityError();
      const apiBase = scope?.apiBase ?? (await _getApiBase());
      return bindProjectResource(
        apiBase,
        projectSlug,
        variables,
        scope ? { requestScope: scope } : undefined,
      );
    },
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({
        queryKey: ['projects', projectSlug, 'resolution'],
      });
      options?.onSuccess?.(data, variables);
    },
    onError: (error, variables) =>
      options?.onError?.(error as Error, variables),
  });
}

export function useApplyProjectLayoutMutation(
  projectSlug: string,
  options?: MutationOptions<any, string>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (layoutId: string) => {
      const apiBase = await _getApiBase();
      return applyProjectLayout(apiBase, projectSlug, layoutId);
    },
    onSuccess: (data, layoutId) => {
      queryClient.invalidateQueries({
        queryKey: ['projects', projectSlug, 'layouts'],
      });
      options?.onSuccess?.(data, layoutId);
    },
    onError: (error, layoutId) => options?.onError?.(error as Error, layoutId),
  });
}

export function useDeleteProjectLayoutMutation(
  projectSlug: string,
  options?: MutationOptions<void, string>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (layoutSlug: string) => {
      const apiBase = await _getApiBase();
      await deleteProjectLayout(apiBase, projectSlug, layoutSlug);
    },
    onSuccess: (_, layoutSlug) => {
      queryClient.invalidateQueries({
        queryKey: ['projects', projectSlug, 'layouts'],
      });
      options?.onSuccess?.(undefined, layoutSlug);
    },
    onError: (error, layoutSlug) => {
      options?.onError?.(error as Error, layoutSlug);
    },
  });
}

export function useCreateProjectMutation(requestScope?: ApiRequestScope) {
  const scope = captureProjectScope(requestScope);
  return useApiMutation(
    async (data: {
      name: string;
      slug: string;
      description?: string;
      icon?: string;
      workingDirectory?: string;
      /** Retained acquisition reverified by Station before Project creation. */
      repositoryAcquisitionId?: string;
      /** Operator-only durable creation identity; reuse after uncertain responses. */
      creationRequestId?: string;
      starterLayoutId?: string | null;
      /** Per-Project override of the Station's workspace isolation. */
      defaultWorkspaceIsolation?: 'shared' | 'worktree';
    }) => {
      const apiBase = scope?.apiBase ?? (await _getApiBase());
      return createProjectRaw(
        apiBase,
        data,
        scope ? { requestScope: scope } : undefined,
      );
    },
    { invalidateKeys: [['projects']] },
  );
}

export function useCreateProjectLayoutMutation(
  options?: MutationOptions<
    any,
    {
      projectSlug: string;
      name: string;
      slug: string;
      type: string;
      icon?: string;
      description?: string;
      config?: Record<string, unknown>;
    }
  >,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      projectSlug,
      ...data
    }: {
      projectSlug: string;
      name: string;
      slug: string;
      type: string;
      icon?: string;
      description?: string;
      config?: Record<string, unknown>;
    }) => {
      const apiBase = await _getApiBase();
      return createProjectLayout(apiBase, projectSlug, data);
    },
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({
        queryKey: ['projects', variables.projectSlug, 'layouts'],
      });
      options?.onSuccess?.(data, variables);
    },
    onError: (error, variables) => {
      options?.onError?.(error as Error, variables);
    },
  });
}

export function useUpdateProjectMutation(
  options?: MutationOptions<any, { slug: string; [key: string]: any }>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      slug,
      requestScope,
      ...data
    }: {
      slug: string;
      requestScope?: ApiRequestScope;
      [key: string]: any;
    }) => {
      const apiBase = requestScope?.apiBase ?? (await _getApiBase());
      return updateProjectRaw(
        apiBase,
        slug,
        data,
        requestScope === undefined ? undefined : { requestScope },
      );
    },
    onSuccess: (data, variables) => {
      const scope = variables.requestScope;
      if (scope) {
        queryClient.invalidateQueries({
          queryKey: ['projects'],
          predicate: ({ queryKey }) =>
            (queryKey[queryKey.length - 2] === scope.apiBase &&
              queryKey[queryKey.length - 1] === scope.authorityKey) ||
            (queryKey[1] === scope.apiBase &&
              queryKey[2] === scope.authorityKey),
        });
        queryClient.invalidateQueries({
          queryKey: projectChatDefaultsQueryKey(
            scope,
            undefined,
            variables.slug,
          ),
          exact: true,
        });
      } else {
        queryClient.invalidateQueries({ queryKey: ['projects'] });
        // The selections it returns are the Project's own fields.
        queryClient.invalidateQueries({
          queryKey: [PROJECT_CHAT_DEFAULTS_QUERY_KEY_PREFIX],
        });
      }
      options?.onSuccess?.(data, variables);
    },
    onError: (error, variables) => {
      options?.onError?.(error as Error, variables);
    },
  });
}

export function useDeleteProjectMutation(
  options?: MutationOptions<any, string>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (slug: string) => {
      const apiBase = await _getApiBase();
      return deleteProjectRaw(apiBase, slug);
    },
    onSuccess: (data, slug) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.removeQueries({ queryKey: ['projects', slug] });
      options?.onSuccess?.(data, slug);
    },
    onError: (error, slug) => {
      options?.onError?.(error as Error, slug);
    },
  });
}

/**
 * #5069: Pause/Resume and Archive/Unarchive. Refreshes the Project list (the
 * sidebar hides an archived Project) and the Project itself.
 */
export function useProjectLifecycleMutation(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      action: import('@kontourai/station-contracts/project-lifecycle').ProjectLifecycleAction,
    ) => {
      const apiBase = await _getApiBase();
      return setProjectLifecycle(apiBase, slug, action);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['scheduler'] });
    },
  });
}

export function useCreateLayoutMutation(projectSlug: string) {
  return useApiMutation(
    async (data: {
      name: string;
      slug: string;
      type: string;
      icon?: string;
      description?: string;
      config?: Record<string, unknown>;
    }) => {
      const apiBase = await _getApiBase();
      return createProjectLayout(apiBase, projectSlug, data);
    },
    { invalidateKeys: [['projects', projectSlug, 'layouts']] },
  );
}
