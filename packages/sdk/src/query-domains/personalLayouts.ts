/**
 * The personal scope's query domain — the caller's own Boards (#2062).
 *
 * A **Board** is a Layout owned by a principal rather than a project
 * (`docs/design/shell-ownership-and-boards.md`, decision D1). The hooks wrap
 * the canonical `client/personal-layouts.ts` fetchers rather than
 * reimplementing the requests, the same split `query-domains/board.ts` uses,
 * so a non-React consumer and the panel never define "what creating a Board
 * does" twice.
 *
 * ## The cache key has no owner segment, deliberately
 *
 * Every key here is `['me', 'layouts', …]`. There is no principal in it
 * because there is no principal in the URL: the server resolves the owner
 * from the request's own authentication, so within one authenticated client
 * `['me', 'layouts']` names exactly one list. Putting an owner in the key
 * would invite a caller to compose one, which is the thing the route family
 * was built to make impossible.
 *
 * ## Promote invalidates BOTH scopes
 *
 * `usePromotePersonalLayoutMutation` is the only mutation here whose effect
 * crosses a scope boundary: the record leaves the personal list and appears
 * in a project's. Invalidating only `['me','layouts']` would leave the
 * project's sidebar row showing a layout list that does not yet contain the
 * Layout the user just moved into it — a cache telling two different stories
 * about one record.
 */
import type {
  LayoutConfig,
  LayoutMetadata,
} from '@kontourai/station-contracts/layout';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { _getApiBase } from '../api';
import {
  createPersonalLayout,
  deletePersonalLayout,
  getPersonalLayout,
  listPersonalLayouts,
  type PersonalLayoutCreateInput,
  type PersonalLayoutUpdateInput,
  promotePersonalLayout,
  updatePersonalLayout,
} from '../client/personal-layouts';
import {
  type MutationOptions,
  type QueryConfig,
  useApiQuery,
} from '../query-core';

/** `['me','layouts']` — the caller's own Board list. */
export function personalLayoutsKey(): string[] {
  return ['me', 'layouts'];
}

/** `['me','layouts',slug]` — one Board's full record. */
export function personalLayoutKey(layoutSlug: string): string[] {
  return ['me', 'layouts', layoutSlug];
}

export function usePersonalLayoutsQuery(
  config?: QueryConfig<LayoutMetadata[]>,
) {
  return useApiQuery(
    personalLayoutsKey(),
    async () => listPersonalLayouts(await _getApiBase()),
    config,
  );
}

export function usePersonalLayoutQuery(
  layoutSlug: string | undefined,
  config?: QueryConfig<LayoutConfig>,
) {
  return useApiQuery(
    personalLayoutKey(layoutSlug ?? ''),
    async () => getPersonalLayout(await _getApiBase(), layoutSlug as string),
    { ...config, enabled: !!layoutSlug && (config?.enabled ?? true) },
  );
}

export function useCreatePersonalLayoutMutation(
  options?: MutationOptions<LayoutConfig, PersonalLayoutCreateInput>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: PersonalLayoutCreateInput) =>
      createPersonalLayout(await _getApiBase(), input),
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: personalLayoutsKey() });
      options?.onSuccess?.(data, variables);
    },
    onError: (error, variables) => {
      options?.onError?.(error as Error, variables);
    },
  });
}

export function useUpdatePersonalLayoutMutation(
  options?: MutationOptions<
    LayoutConfig,
    { layoutSlug: string; update: PersonalLayoutUpdateInput }
  >,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      layoutSlug,
      update,
    }: {
      layoutSlug: string;
      update: PersonalLayoutUpdateInput;
    }) => updatePersonalLayout(await _getApiBase(), layoutSlug, update),
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: personalLayoutsKey() });
      queryClient.invalidateQueries({
        queryKey: personalLayoutKey(variables.layoutSlug),
      });
      options?.onSuccess?.(data, variables);
    },
    onError: (error, variables) => {
      options?.onError?.(error as Error, variables);
    },
  });
}

export function useDeletePersonalLayoutMutation(
  options?: MutationOptions<void, string>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (layoutSlug: string) => {
      await deletePersonalLayout(await _getApiBase(), layoutSlug);
    },
    onSuccess: (_data, layoutSlug) => {
      queryClient.invalidateQueries({ queryKey: personalLayoutsKey() });
      // The singular entry is REMOVED rather than invalidated: refetching the
      // record of a Board that no longer exists would answer 404 and park an
      // error in the cache for a key nothing should read again.
      queryClient.removeQueries({ queryKey: personalLayoutKey(layoutSlug) });
      options?.onSuccess?.(undefined, layoutSlug);
    },
    onError: (error, layoutSlug) => {
      options?.onError?.(error as Error, layoutSlug);
    },
  });
}

export function usePromotePersonalLayoutMutation(
  options?: MutationOptions<
    LayoutConfig,
    { layoutSlug: string; projectSlug: string }
  >,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      layoutSlug,
      projectSlug,
    }: {
      layoutSlug: string;
      projectSlug: string;
    }) => promotePersonalLayout(await _getApiBase(), layoutSlug, projectSlug),
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: personalLayoutsKey() });
      queryClient.removeQueries({
        queryKey: personalLayoutKey(variables.layoutSlug),
      });
      // The other half of the move. `['projects', slug, 'layouts']` is
      // `useProjectLayoutsQuery`'s key (`query-domains/workspaceProjects.ts`);
      // the promoted record is in that list now.
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

export type { PersonalLayoutCreateInput, PersonalLayoutUpdateInput };
