import type {
  CoordinatorDesignation,
  CoordinatorDesignationRead,
  CoordinatorRefusalCode,
} from '@kontourai/station-contracts/coordinator';
import { getJson, mutateJson } from '@kontourai/station-sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useHostRequestAuthorityScope } from '../contexts/ApiBaseContext';

/**
 * #3628: the person's coordinator designation. An older host answers the
 * route 404 and a hosted one 503 (`coordinator_unavailable`); both read as
 * `unavailable`, never as an error the person can retry away.
 */
export type CoordinatorState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'error'; readonly message: string }
  | {
      readonly kind: 'ready';
      readonly designation: CoordinatorDesignation | null;
    };

const UNAVAILABLE = Symbol('coordinator-unavailable');

export class CoordinatorRefusal extends Error {
  constructor(readonly code: CoordinatorRefusalCode | string) {
    super(code);
  }
}

const coordinatorKey = (
  apiBase: string | undefined,
  authorityKey: string | undefined,
) => ['coordinator', apiBase ?? null, authorityKey ?? null];

async function readBody<T>(
  response: Response,
): Promise<{ ok: true; data: T } | { ok: false; code?: string }> {
  let body: { success?: boolean; data?: T; code?: string } | undefined;
  try {
    body = (await response.json()) as typeof body;
  } catch {
    body = undefined;
  }
  if (response.ok && body?.success === true && body.data !== undefined)
    return { ok: true, data: body.data };
  return { ok: false, ...(body?.code ? { code: body.code } : {}) };
}

export function useCoordinator() {
  const scope = useHostRequestAuthorityScope();
  const client = useQueryClient();
  const enabled = Boolean(scope?.isCurrent());
  const key = coordinatorKey(scope?.apiBase, scope?.authorityKey);
  const url = `${scope?.apiBase ?? ''}/api/orchestration/coordinator`;
  const options = () => ({
    ...(scope ? { requestScope: scope } : {}),
    maxResponseBytes: 16 * 1024,
  });
  const query = useQuery({
    queryKey: key,
    enabled,
    retry: false,
    staleTime: 30_000,
    queryFn: async ({ signal }) => {
      const response = await getJson(url, { signal, ...options() });
      if (response.status === 404 || response.status === 503)
        return UNAVAILABLE;
      const body = await readBody<CoordinatorDesignationRead>(response);
      if (!body.ok)
        throw new Error(`Could not read the coordinator (${response.status})`);
      return body.data.designation;
    },
  });
  // No current host authority: nothing to read, so nothing to show.
  const state: CoordinatorState = !enabled
    ? { kind: 'unavailable' }
    : query.isPending
      ? { kind: 'loading' }
      : query.isError
        ? { kind: 'error', message: query.error.message }
        : query.data === UNAVAILABLE
          ? { kind: 'unavailable' }
          : { kind: 'ready', designation: query.data ?? null };
  const settle = () => client.invalidateQueries({ queryKey: key });
  const designate = useMutation({
    mutationFn: async (input: {
      conversationId: string;
      replace?: boolean;
    }) => {
      const body = await readBody<{ designation: CoordinatorDesignation }>(
        await mutateJson(url, 'PUT', options(), input),
      );
      if (!body.ok) throw new CoordinatorRefusal(body.code ?? 'failed');
      return body.data.designation;
    },
    onSettled: settle,
  });
  const undesignate = useMutation({
    mutationFn: async () => {
      const body = await readBody<{ undesignated: boolean }>(
        await mutateJson(url, 'DELETE', options()),
      );
      if (!body.ok) throw new CoordinatorRefusal(body.code ?? 'failed');
      return body.data.undesignated;
    },
    onSettled: settle,
  });
  return { state, retry: () => void query.refetch(), designate, undesignate };
}
