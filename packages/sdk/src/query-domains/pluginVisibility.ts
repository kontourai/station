import type {
  PluginVisibilityDirectory,
  PluginVisibilityGrantInput,
} from '@kontourai/station-contracts/plugin-visibility';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { _getApiBase } from '../api';
import { authenticatedFetch } from '../client/http';
import type { QueryConfig } from '../query-core';

/**
 * Per-principal plugin visibility (#2067) — the OPERATOR's side only.
 *
 * `/api/plugins/visibility` re-resolves the request's own principal and
 * answers 403 to anybody who is not the instance operator, so a collaborator's
 * browser gets a refusal here. Callers treat that as "hide the section", never
 * as an error to render — the same posture `useAnswerSharesQuery` and
 * `usePeerCredentialsQuery` document, and the reason
 * {@link isPluginVisibilityForbidden} exists as a distinguishable signal
 * rather than a message string to match on.
 *
 * There is deliberately no hook here for "what may I see". A principal's own
 * projection is not a thing they fetch and compare against: it is the plugin
 * list they already get from `GET /api/plugins`, which is filtered before it
 * leaves the server.
 */

/** A 403 from the visibility family: a credential was presented and refused. */
export class PluginVisibilityForbiddenError extends Error {
  readonly status = 403;
  constructor() {
    super('Only the Station operator can change plugin visibility.');
    this.name = 'PluginVisibilityForbiddenError';
  }
}

export function isPluginVisibilityForbidden(error: unknown): boolean {
  return error instanceof PluginVisibilityForbiddenError;
}

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
}

async function unwrap<T>(response: Response, defaultError: string): Promise<T> {
  if (response.status === 403) throw new PluginVisibilityForbiddenError();
  let result: ApiEnvelope<T>;
  try {
    result = (await response.json()) as ApiEnvelope<T>;
  } catch {
    throw new Error(defaultError);
  }
  if (!response.ok || !result.success || result.data === undefined) {
    throw new Error(
      typeof result.error === 'string' && result.error
        ? result.error
        : defaultError,
    );
  }
  return result.data;
}

export const PLUGIN_VISIBILITY_QUERY_KEY = ['plugin-visibility'] as const;

export async function fetchPluginVisibility(): Promise<PluginVisibilityDirectory> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(
    `${apiBase}/api/plugins/visibility`,
  );
  return unwrap<PluginVisibilityDirectory>(
    response,
    'Plugin visibility could not be listed',
  );
}

export function usePluginVisibilityQuery(
  config?: QueryConfig<PluginVisibilityDirectory>,
) {
  return useQuery({
    queryKey: PLUGIN_VISIBILITY_QUERY_KEY,
    queryFn: fetchPluginVisibility,
    staleTime: 30_000,
    // A refusal is deterministic: this caller is not the operator, and asking
    // again cannot change that.
    retry: false,
    ...config,
  });
}

function grantRequest(method: 'POST' | 'DELETE') {
  return async (input: PluginVisibilityGrantInput): Promise<string[]> => {
    const apiBase = await _getApiBase();
    const response = await authenticatedFetch(
      `${apiBase}/api/plugins/visibility/grants`,
      {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
    );
    const data = await unwrap<{ principalId: string; plugins: string[] }>(
      response,
      method === 'POST'
        ? 'Plugin visibility could not be granted'
        : 'Plugin visibility could not be revoked',
    );
    return data.plugins;
  };
}

/**
 * Grant or revoke, sharing one mutation so a row cannot have one of the two
 * in flight while the other reports idle. `grant: false` revokes.
 *
 * Both invalidate the plugin list as well as the directory: a principal whose
 * grants just changed is looking at a `GET /api/plugins` response the server
 * filtered under the OLD record.
 */
export function useSetPluginVisibilityMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (
      input: PluginVisibilityGrantInput & { grant: boolean },
    ): Promise<string[]> =>
      grantRequest(input.grant ? 'POST' : 'DELETE')({
        principalId: input.principalId,
        plugin: input.plugin,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PLUGIN_VISIBILITY_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: ['plugins'] });
    },
  });
}
