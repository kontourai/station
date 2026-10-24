import type { PairedDevice } from '@kontourai/station-contracts/environment-security';
import { useCallback, useMemo, useRef } from 'react';
import {
  authenticatedFetch,
  type ClientRequestOptions,
  getJson,
  StationHttpError,
} from '../client/http';
import { rethrowDeadline } from '../client/request-deadline';
import {
  type QueryConfig,
  resolveApiBase,
  useApiMutation,
  useApiQuery,
} from '../query-core';

interface PairedDevicesResponse {
  devices?: PairedDevice[];
}

/** Read the current inbound paired-device registry from its canonical route. */
export async function fetchPairedDevices(
  apiBase?: string,
  options?: ClientRequestOptions,
): Promise<PairedDevice[]> {
  const resolvedApiBase = await resolveApiBase(apiBase);
  const response = await getJson(
    `${resolvedApiBase}/api/pairing/devices`,
    options,
  );
  if (!response.ok) {
    throw new StationHttpError(
      response.status,
      `Paired devices request failed (HTTP ${response.status})`,
    );
  }
  const body = (await response.json()) as PairedDevicesResponse;
  if (!Array.isArray(body.devices)) {
    throw new Error('Paired devices response is missing its device list');
  }
  return body.devices;
}

export const pairedDeviceQueries = {
  list: (apiBase?: string) => ({
    queryKey: ['paired-devices', apiBase ?? 'default'],
    queryFn: () => fetchPairedDevices(apiBase),
  }),
};

/**
 * Current paired-device identity inventory. Polling matches the existing
 * management surface so a name changed outside this observer does not remain
 * a durable display claim.
 */
export function usePairedDevicesQuery(
  apiBase?: string,
  config?: QueryConfig<PairedDevice[]> & {
    requestScope?: ClientRequestOptions['requestScope'];
    requireRequestScope?: boolean;
  },
) {
  const query = pairedDeviceQueries.list(apiBase);
  const scope = config?.requestScope;
  const key = scope
    ? ['paired-devices', scope.apiBase, scope.authorityKey]
    : config?.requireRequestScope
      ? ['paired-devices', 'scope-unavailable']
      : query.queryKey;
  const activityKey = JSON.stringify(key);
  const lastActivityKey = useRef<string | undefined>(undefined);
  const result = useApiQuery(
    key,
    (signal) => {
      const userInitiated = lastActivityKey.current !== activityKey;
      lastActivityKey.current = activityKey;
      return fetchPairedDevices(scope?.apiBase ?? apiBase, {
        requestScope: scope,
        signal,
        headers: userInitiated
          ? undefined
          : { 'X-Station-Background-Refresh': '1' },
      });
    },
    {
      staleTime: 15_000,
      refetchInterval: 15_000,
      refetchIntervalForError: (error) =>
        error instanceof StationHttpError && [401, 403].includes(error.status)
          ? false
          : undefined,
      retry: false,
      ...config,
      enabled:
        (config?.enabled ?? true) && (!config?.requireRequestScope || !!scope),
    },
  );
  const queryRefetch = result.refetch;
  const refetch = useCallback(
    (...args: Parameters<typeof queryRefetch>) => {
      lastActivityKey.current = undefined;
      return queryRefetch(...args);
    },
    [queryRefetch],
  );
  // Forward reads lazily so React Query tracks only the caller's properties.
  return useMemo(
    () =>
      new Proxy(result, {
        get(target, property, receiver) {
          return property === 'refetch'
            ? refetch
            : Reflect.get(target, property, receiver);
        },
      }),
    [result, refetch],
  );
}

/**
 * A refused/failed pairing-request decision (#765 D5). Carries the HTTP
 * status (and the server's error code when one was returned) so callers can
 * render the honest remedy — notably 403, where the pairing service refused
 * because the caller's session cannot prove approval authority for this
 * request (`DevicePairingService.confirmRequest`), and the remedy is a
 * credentialed session rather than a retry.
 */
export class DevicePairingRequestActionError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
  ) {
    super(
      code
        ? `Pairing request action failed: ${code} (HTTP ${status})`
        : `Pairing request action failed (HTTP ${status})`,
    );
    this.name = 'DevicePairingRequestActionError';
  }
}

async function pairingActionError(
  response: Response,
): Promise<DevicePairingRequestActionError> {
  let code: string | undefined;
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string') code = body.error;
  } catch (error) {
    rethrowDeadline(error);
    // Non-JSON failure body; the status alone is the signal.
  }
  return new DevicePairingRequestActionError(response.status, code);
}

/**
 * Approve a pending inbound device-pairing request — the SAME
 * `POST /api/pairing/requests/:requestId/confirm` route the Connections
 * pairing panel and `station environment access approve` use, so the
 * pairing family's authorization (operator credential, `access:approve`
 * promotion, or the documented attested-local floor for off-box requests)
 * decides at the HTTP boundary. This client function grants nothing.
 */
export async function confirmDevicePairingRequest(
  requestId: string,
  apiBase?: string,
  /** What the approver keeps of the requested scope; omitted keeps all. */
  scope?: string,
): Promise<void> {
  const resolvedApiBase = await resolveApiBase(apiBase);
  const response = await authenticatedFetch(
    `${resolvedApiBase}/api/pairing/requests/${encodeURIComponent(requestId)}/confirm`,
    scope === undefined
      ? { method: 'POST' }
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scope }),
        },
  );
  if (!response.ok) throw await pairingActionError(response);
}

/** Deny a pending inbound device-pairing request — `DELETE /api/pairing/requests/:requestId`, same route as the panel and CLI deny. */
export async function denyDevicePairingRequest(
  requestId: string,
  apiBase?: string,
): Promise<void> {
  const resolvedApiBase = await resolveApiBase(apiBase);
  const response = await authenticatedFetch(
    `${resolvedApiBase}/api/pairing/requests/${encodeURIComponent(requestId)}`,
    { method: 'DELETE' },
  );
  if (!response.ok) throw await pairingActionError(response);
}

/**
 * Invalidates both projections a decision changes: the attention projection
 * (the item resolves out of Needs attention) and the notifications list
 * (the mirror activity row's status converges via the provider's sync).
 */
export function useConfirmDevicePairingRequestMutation(apiBase?: string) {
  return useApiMutation(
    (input: string | { requestId: string; scope?: string }) =>
      typeof input === 'string'
        ? confirmDevicePairingRequest(input, apiBase)
        : confirmDevicePairingRequest(input.requestId, apiBase, input.scope),
    { invalidateKeys: [['attention'], ['notifications']] },
  );
}

/** See {@link useConfirmDevicePairingRequestMutation} — same invalidation. */
export function useDenyDevicePairingRequestMutation(apiBase?: string) {
  return useApiMutation(
    (requestId: string) => denyDevicePairingRequest(requestId, apiBase),
    { invalidateKeys: [['attention'], ['notifications']] },
  );
}
