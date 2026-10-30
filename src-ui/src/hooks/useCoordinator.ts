import type {
  CoordinatorDelivery,
  CoordinatorDesignation,
  CoordinatorDesignationRead,
  CoordinatorPictureItem,
  CoordinatorRefusalCode,
} from '@kontourai/station-contracts/coordinator';
import { ENGINE_CAPABILITY_MATRICES } from '@kontourai/station-contracts/engine-capability-matrix';
import { engineDisplayLabel } from '@kontourai/station-contracts/engine-display';
import { getJson, mutateJson } from '@kontourai/station-sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useHostRequestAuthorityScope } from '../contexts/ApiBaseContext';
import { COORDINATOR_PRODUCT_NAME } from '../lib/productNames';

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
      /** How Station can reach the coordinator now (with a designation). */
      readonly delivery?: CoordinatorDelivery;
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
      return body.data;
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
          : {
              kind: 'ready',
              designation: query.data?.designation ?? null,
              ...(query.data?.delivery
                ? { delivery: query.data.delivery }
                : {}),
            };
  const settle = () => client.invalidateQueries({ queryKey: key });
  const designate = useMutation({
    mutationFn: async (input: {
      conversationId: string;
      replace?: boolean;
    }) => {
      const body = await readBody<{
        designation: CoordinatorDesignation;
        delivery?: CoordinatorDelivery;
      }>(await mutateJson(url, 'PUT', options(), input));
      if (!body.ok) throw new CoordinatorRefusal(body.code ?? 'failed');
      return body.data;
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

/** Read only the current person's admitted picture; an old host refuses the leaf. */
export function useCoordinatorPicture(enabled: boolean) {
  const scope = useHostRequestAuthorityScope();
  return useQuery({
    queryKey: [
      'coordinator-picture',
      scope?.apiBase ?? null,
      scope?.authorityKey ?? null,
    ],
    enabled: enabled && Boolean(scope?.isCurrent()),
    retry: false,
    queryFn: async ({ signal }) => {
      const response = await getJson(
        `${scope?.apiBase ?? ''}/api/orchestration/coordinator/picture`,
        {
          signal,
          ...(scope ? { requestScope: scope } : {}),
          maxResponseBytes: 128 * 1024,
        },
      );
      const body = await readBody<{ items: CoordinatorPictureItem[] }>(
        response,
      );
      if (
        !body.ok ||
        !Array.isArray(body.data.items) ||
        body.data.items.some(
          (item) =>
            !item ||
            typeof item.conversationId !== 'string' ||
            !['in-flight', 'waiting', 'finished'].includes(item.status) ||
            typeof item.summary !== 'string' ||
            !Number.isSafeInteger(item.updatedAt),
        )
      )
        throw new Error('Could not read the working picture');
      return body.data.items;
    },
  });
}

/**
 * The coordinator's one status line (Home card, menu notices), from what the server derived about the
 * coordinator's current Session. Blocked delivery outranks pending tools: the
 * person would otherwise expect updates that cannot arrive.
 */
export function coordinatorStatusLine(
  delivery: CoordinatorDelivery | undefined,
): string {
  if (delivery?.toolsUnavailable) {
    const alternative = Object.values(ENGINE_CAPABILITY_MATRICES).find(
      (entry) =>
        entry.toolServers.state === 'session' &&
        entry.toolServers.builtinStationControlDelivery?.basis === 'declared',
    );
    const name = alternative ? engineDisplayLabel(alternative.engineId) : null;
    return `This engine can’t use Station tools, so ${COORDINATOR_PRODUCT_NAME} can’t delegate or check work. ${name ? `Choose ${name} for Station tools.` : 'Choose an engine that supports Station tools.'} ${delivery.wakes === 'ready' ? 'It can still receive updates.' : 'Updates are also blocked.'}`;
  }
  if (delivery?.wakes === 'blocked')
    return "Updates can't reach this chat yet: its engine doesn't report when a turn ends.";
  if (delivery?.toolsPending)
    return 'It hears when your work needs you. Station will add its tools on the next turn.';
  return 'Your personal agent. It hears when your work needs you.';
}
