import { authenticatedFetch } from '../client/http';
import { resolveApiBase, useApiMutation } from '../query-core';

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
  } catch {
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
): Promise<void> {
  const resolvedApiBase = await resolveApiBase(apiBase);
  const response = await authenticatedFetch(
    `${resolvedApiBase}/api/pairing/requests/${encodeURIComponent(requestId)}/confirm`,
    { method: 'POST' },
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
    (requestId: string) => confirmDevicePairingRequest(requestId, apiBase),
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
