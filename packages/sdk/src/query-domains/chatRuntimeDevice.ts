import {
  NATIVE_PUSH_REGISTER_PATH,
  NATIVE_PUSH_REGISTRATION_PATH,
  type NativePushRegistrationRequest,
  type NativePushRegistrationResponse,
  type NativePushRegistrationStatus,
} from '@kontourai/station-contracts/native-push';
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
  const body = (await response.json().catch(unlessDeadline(() => undefined))) as
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

type WebPushRequestOptions = Pick<
  ClientRequestOptions,
  'requestScope' | 'signal'
>;

type WebPushRegistration =
  | { status: 'paired'; fingerprint: string | null }
  | { status: 'pairing-required' };

export async function fetchWebPushRegistration(
  apiBase?: string,
  options?: WebPushRequestOptions,
): Promise<{ publicKey: string; registration?: WebPushRegistration }> {
  const resolvedApiBase = await resolveApiBase(apiBase);
  const response = await authenticatedFetch(
    `${resolvedApiBase}/api/system/vapid-public-key`,
    options,
  );
  if (!response.ok) {
    if (response.status === 403) await throwIfDevicePairingRequired(response);
    throw new StationHttpError(
      response.status,
      'Could not read Web Push registration',
    );
  }
  const result = (await response.json()) as {
    publicKey?: string;
    registration?: WebPushRegistration;
  };
  if (typeof result.publicKey !== 'string' || !result.publicKey)
    throw new Error('Missing VAPID public key');
  const registration = result.registration;
  if (
    registration !== undefined &&
    (!registration ||
      (registration.status !== 'pairing-required' &&
        (registration.status !== 'paired' ||
          (registration.fingerprint !== null &&
            (typeof registration.fingerprint !== 'string' ||
              !/^[0-9a-f]{64}$/.test(registration.fingerprint))))))
  )
    throw new Error('Malformed Web Push registration response');
  return result as { publicKey: string; registration?: WebPushRegistration };
}

export async function fetchVapidPublicKey(
  apiBase?: string,
  options?: WebPushRequestOptions,
): Promise<string> {
  return (await fetchWebPushRegistration(apiBase, options)).publicKey;
}

export async function subscribePushNotifications(
  subscription: PushSubscriptionJSON,
  apiBase?: string,
  options?: WebPushRequestOptions,
): Promise<void> {
  const resolvedApiBase = await resolveApiBase(apiBase);
  const response = await authenticatedFetch(
    `${resolvedApiBase}/api/system/push-subscribe`,
    {
      ...options,
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
  options?: WebPushRequestOptions,
): Promise<void> {
  const resolvedApiBase = await resolveApiBase(apiBase);
  const response = await authenticatedFetch(
    `${resolvedApiBase}/api/system/push-unsubscribe`,
    {
      ...options,
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

/**
 * Registers this paired device for native (FCM) agent-activity push, or
 * refreshes its token after FCM rotated it. The answer carries the values the
 * phone must check on every push and the key it opens sealed cards with;
 * `registrationId` and `payloadKey` are stable across token rotation.
 */
export async function registerNativePush(
  request: NativePushRegistrationRequest,
  apiBase?: string,
): Promise<NativePushRegistrationResponse> {
  const resolvedApiBase = await resolveApiBase(apiBase);
  const response = await authenticatedFetch(
    `${resolvedApiBase}${NATIVE_PUSH_REGISTER_PATH}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    },
  );
  await throwIfDevicePairingRequired(response);
  if (!response.ok) {
    throw new Error(`Failed to register for native push: ${response.status}`);
  }
  const result =
    (await response.json()) as Partial<NativePushRegistrationResponse>;
  if (
    typeof result.registrationId !== 'string' ||
    typeof result.stationId !== 'string' ||
    typeof result.stationKey !== 'string' ||
    typeof result.payloadKey !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(result.payloadKey)
  ) {
    throw new Error('Malformed native push registration response');
  }
  return {
    registrationId: result.registrationId,
    stationId: result.stationId,
    stationKey: result.stationKey,
    payloadKey: result.payloadKey,
  };
}

/** Clears this paired device's own native push registration. */
export async function unregisterNativePush(apiBase?: string): Promise<void> {
  const resolvedApiBase = await resolveApiBase(apiBase);
  const response = await authenticatedFetch(
    `${resolvedApiBase}${NATIVE_PUSH_REGISTRATION_PATH}`,
    { method: 'DELETE' },
  );
  await throwIfDevicePairingRequired(response);
  if (!response.ok) {
    throw new Error(
      `Failed to unregister from native push: ${response.status}`,
    );
  }
}

/**
 * Whether the Station still holds this paired device's native push
 * registration, and under which id. `null` when the Station predates the
 * route (404 or 405), so the caller keeps its own refresh rule there.
 */
export async function nativePushRegistrationStatus(
  apiBase?: string,
): Promise<NativePushRegistrationStatus | null> {
  const resolvedApiBase = await resolveApiBase(apiBase);
  const response = await authenticatedFetch(
    `${resolvedApiBase}${NATIVE_PUSH_REGISTRATION_PATH}`,
    { method: 'GET' },
  );
  await throwIfDevicePairingRequired(response);
  if (response.status === 404 || response.status === 405) return null;
  if (!response.ok) {
    throw new Error(
      `Failed to read native push registration: ${response.status}`,
    );
  }
  const result =
    (await response.json()) as Partial<NativePushRegistrationStatus>;
  if (
    result.registered === true &&
    typeof result.registrationId === 'string' &&
    result.registrationId.length > 0
  )
    return { registered: true, registrationId: result.registrationId };
  if (result.registered === false && result.registrationId === null)
    return { registered: false, registrationId: null };
  throw new Error('Malformed native push registration status');
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

import {
  authenticatedFetch,
  type ClientRequestOptions,
  StationHttpError,
} from '../client/http';
import { unlessDeadline } from '../client/request-deadline';
