import { resolveApiBase } from '../query-core';

/**
 * Thrown by the push-subscribe/push-unsubscribe fetchers when the caller must
 * pair this device before it can subscribe to or clear Web Push. Verifying the
 * operator credential — or being on loopback — is deliberately not enough.
 * Callers (namely `usePushNotifications`) catch this distinctly to surface a
 * "Pair this device first" state instead of a generic error.
 *
 * The server expresses this two different ways, because the request can be
 * refused at two different layers:
 *
 * - `403 {error: 'device_pairing_required'}` — the request reached
 *   `push-routes.ts` and no paired device could be identified from it.
 * - `401 {error: {code: 'authentication_required'}}` — the runtime auth gate
 *   refused it first. Since station#1123 slice 3 (#1189) a *presented,
 *   well-formed* credential always runs the verify path regardless of peer
 *   class, so a device whose credential was revoked elsewhere now fails here
 *   and never reaches the route.
 *
 * Be precise about what that 401 does and does not tell you: it is NOT
 * revoked-specific. `runtime-http.ts` returns an identical body whether the
 * credential was presented-and-rejected (revoked) or never presented at all.
 * Only the audit record distinguishes those (`reason: 'invalid_credential'`
 * vs `'authentication_required'`); nothing on the wire does. So this maps
 * "the auth gate refused us" to the pairing state, not "we were revoked."
 *
 * That fold is sound *for this surface specifically*, because every reachable
 * cause requires the same recovery: a revoked credential cannot be
 * re-authenticated, and a browser holding no credential was never paired. Do
 * not copy this mapping to a surface where an unauthenticated caller has some
 * other way back — there, 401 would be an instruction to re-pair someone who
 * merely needs to sign in. Whether the server should distinguish the two at
 * the wire level is open in station#1212.
 */
export class DevicePairingRequiredError extends Error {
  constructor() {
    super('device_pairing_required');
    this.name = 'DevicePairingRequiredError';
  }
}

async function throwIfDevicePairingRequired(response: Response): Promise<void> {
  if (response.status !== 403 && response.status !== 401) return;
  const body = (await response.json().catch(() => undefined)) as
    | { error?: string | { code?: string } }
    | undefined;
  // Match on the error shape rather than the bare status so an unrelated 401
  // from some other layer still surfaces as a generic failure.
  const refusedAtRoute =
    response.status === 403 && body?.error === 'device_pairing_required';
  const refusedAtAuthGate =
    response.status === 401 &&
    typeof body?.error === 'object' &&
    body.error?.code === 'authentication_required';
  if (refusedAtRoute || refusedAtAuthGate) {
    throw new DevicePairingRequiredError();
  }
}

export async function fetchVapidPublicKey(apiBase?: string): Promise<string> {
  const resolvedApiBase = await resolveApiBase(apiBase);
  const response = await authenticatedFetch(
    `${resolvedApiBase}/api/system/vapid-public-key`,
  );
  if (!response.ok) {
    throw new Error('Server does not support push notifications');
  }
  const result = (await response.json()) as { publicKey?: string };
  if (!result.publicKey) {
    throw new Error('Missing VAPID public key');
  }
  return result.publicKey;
}

export async function subscribePushNotifications(
  subscription: PushSubscriptionJSON,
  apiBase?: string,
): Promise<void> {
  const resolvedApiBase = await resolveApiBase(apiBase);
  const response = await authenticatedFetch(
    `${resolvedApiBase}/api/system/push-subscribe`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(subscription),
    },
  );
  await throwIfDevicePairingRequired(response);
  if (!response.ok) {
    throw new Error(
      `Failed to subscribe to push notifications: ${response.status}`,
    );
  }
}

export async function unsubscribePushNotifications(
  endpoint: string,
  apiBase?: string,
): Promise<void> {
  const resolvedApiBase = await resolveApiBase(apiBase);
  const response = await authenticatedFetch(
    `${resolvedApiBase}/api/system/push-unsubscribe`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    },
  );
  await throwIfDevicePairingRequired(response);
  if (!response.ok) {
    throw new Error(
      `Failed to unsubscribe from push notifications: ${response.status}`,
    );
  }
}

export async function createVoiceSession(apiBase?: string): Promise<{
  sessionId?: string;
}> {
  const resolvedApiBase = await resolveApiBase(apiBase);
  const response = await authenticatedFetch(
    `${resolvedApiBase}/api/voice/sessions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    },
  );
  if (!response.ok) {
    throw new Error(`Session creation failed: ${response.status}`);
  }
  return (await response.json()) as { sessionId?: string };
}

import { authenticatedFetch } from '../client/http';
