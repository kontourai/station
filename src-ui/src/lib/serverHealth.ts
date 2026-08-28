import {
  type ConnectionFailureReason,
  type ConnectionHealthCheckResult,
  classifyHttpFailureResponse,
  classifyNativeTransportRefusal,
  HEALTH_PROBE_TIMEOUT_MS,
} from '@kontourai/station-connect';
import { PUBLIC_STATION_HANDSHAKE_PATH } from '@kontourai/station-contracts/environment-security';
import { authenticatedFetch } from '@kontourai/station-sdk';
import { isBlockingCompatibility } from './compatibilityLoader';

/**
 * Browser callers retain their explicit per-connection credential behavior.
 * Desktop deliberately supplies no credential string, which selects the
 * origin-scoped native broker configured by ApiBaseContext instead.
 */
function stationAuthenticatedFetch(
  url: string | URL,
  credential: string | undefined,
  init?: RequestInit,
): Promise<Response> {
  if (!credential) return authenticatedFetch(url, init);
  return fetch(url, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${credential}`,
    },
  });
}

/**
 * The `error.code` a Station attaches to its own refusals (`runtime-http.ts`
 * answers `{ error: { code } }` for every 401/403 it emits).
 *
 * Returns `undefined` whenever the body cannot be read or carries no code —
 * an intermediary's own error page, an empty body, a Station older than the
 * coded vocabulary. That is a genuine "could not look", and
 * `classifyHttpFailureResponse` treats it as one rather than falling through
 * to a neighbouring meaning.
 */
async function readStationErrorCode(
  response: Response,
): Promise<string | undefined> {
  try {
    const body = (await response.json()) as {
      error?: { code?: unknown } | null;
    };
    const code = body?.error?.code;
    return typeof code === 'string' && code.length > 0 ? code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * archive#3297 — the single derivation both probes below use for a non-OK
 * HTTP response, so they can never disagree again about what a status means.
 */
async function reasonForFailedResponse(
  response: Response,
): Promise<ConnectionFailureReason> {
  return classifyHttpFailureResponse(
    response.status,
    await readStationErrorCode(response),
  );
}

export function checkServerHealth(
  url: string,
  credential?: string,
  signal?: AbortSignal,
): Promise<boolean> {
  return stationAuthenticatedFetch(
    `${url}/api/system/status`,
    credential,
    signal ? { signal } : undefined,
  )
    .then((response) => response.ok)
    .catch(() => false);
}

/**
 * Same probe as `checkServerHealth`, but says why it failed.
 *
 * A reachable Station that rejects the saved credential answers 401. Collapsing
 * that to `false` made the Connections UI report "Station cannot be reached at
 * this address", which sends the user to check the host — when the host is fine
 * and the credential is what needs replacing.
 *
 * `checkServerHealth` keeps its boolean shape because several callers branch on
 * it directly; this is the variant for surfaces that render a failure reason.
 */
export async function checkServerHealthDetailed(
  url: string,
  credential?: string,
): Promise<ConnectionHealthCheckResult> {
  try {
    const response = await stationAuthenticatedFetch(
      `${url}/api/system/status`,
      credential,
    );
    if (response.ok) return { ok: true };
    // archive#3297: both probes now share one derivation
    // (`classifyHttpFailureResponse`), and it reads the coded body rather
    // than guessing from the status. The comment that used to sit here said
    // this server "returns 403 for origin policy, never for a rejected
    // credential" — that was incomplete: `runtime-http.ts` also answers 403
    // `insufficient_scope` for a credential it recognizes but will not
    // accept, which IS a device-credential outcome. Keying on the number
    // alone could not tell the two apart in either direction.
    return { ok: false, reason: await reasonForFailedResponse(response) };
  } catch (error) {
    // archive#1713: a desktop native-transport invoke-layer refusal (e.g.
    // "no host-authorized active Station") is not a transport failure at
    // all — recognize it before falling back to the generic reading. Only a
    // genuinely unrecognized thrown fetch (DNS, refused, offline) reaches
    // the 'unreachable' default.
    return {
      ok: false,
      reason: classifyNativeTransportRefusal(error) ?? 'unreachable',
    };
  }
}

export async function probeServerConnection(
  url: string,
  credential: string | undefined,
  expectedEnvironmentId: string | null,
  parentSignal: AbortSignal,
): Promise<ConnectionHealthCheckResult> {
  const controller = new AbortController();
  if (parentSignal.aborted) controller.abort(parentSignal.reason);
  const timeout = setTimeout(
    () => controller.abort('timeout'),
    HEALTH_PROBE_TIMEOUT_MS,
  );
  const abort = () => controller.abort(parentSignal.reason);
  parentSignal.addEventListener('abort', abort, { once: true });
  try {
    const handshakeResponse = await fetch(
      new URL(PUBLIC_STATION_HANDSHAKE_PATH, url),
      {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      },
    );
    // archive#3297: this line was the defect the issue was filed about. The
    // public handshake answering 401 — or 403, or 404 — proves the address
    // answered, and collapsing all three into 'unreachable' told a phone
    // whose credential had gone stale that its Station "may be off, asleep,
    // or on another network". Forty lines above, `checkServerHealthDetailed`
    // had the mapping right; the two probes now share one derivation.
    if (!handshakeResponse.ok) {
      return {
        ok: false,
        reason: await reasonForFailedResponse(handshakeResponse),
      };
    }
    let handshake: {
      schemaVersion?: unknown;
      environmentId?: unknown;
      authentication?: { scheme?: unknown; protocolVersion?: unknown };
      transports?: { http?: unknown; sse?: unknown; websocket?: unknown };
      compatibility?: unknown;
    };
    try {
      handshake = await handshakeResponse.json();
    } catch {
      // A 200 whose body is not JSON is a captive portal, a proxy, or some
      // other thing answering at this address — reachable, and not a
      // Station. It used to fall into the catch below and be reported as a
      // transport failure, which is the same lie in a different place.
      return { ok: false, reason: 'unexpected-response' };
    }
    // A host upgraded or downgraded under a live client shows up here. The
    // verdict is deliberately evaluated before the schema checks below can
    // collapse it into the same undifferentiated failure: a `compatibility`
    // block that is absent or malformed is unverifiable and blocks before any
    // credentialed request is sent.
    if (await isBlockingCompatibility(handshake.compatibility)) {
      return { ok: false, reason: 'unsupported-capability-version' };
    }
    if (
      handshake.schemaVersion !== 1 ||
      handshake.authentication?.scheme !== 'bearer' ||
      handshake.authentication.protocolVersion !== 1 ||
      handshake.transports?.http !== 1 ||
      handshake.transports.sse !== 1 ||
      handshake.transports.websocket !== 1
    ) {
      return { ok: false, reason: 'unsupported-capability-version' };
    }
    if (
      typeof handshake.environmentId !== 'string' ||
      (expectedEnvironmentId &&
        handshake.environmentId !== expectedEnvironmentId)
    ) {
      return { ok: false, reason: 'identity-mismatch' };
    }
    const identityResponse = await stationAuthenticatedFetch(
      new URL('/api/system/identity', url),
      credential,
      { signal: controller.signal },
    );
    if (!identityResponse.ok) {
      return {
        ok: false,
        reason: await reasonForFailedResponse(identityResponse),
      };
    }
    const identity = (await identityResponse.json()) as { bootId?: unknown };
    return typeof identity.bootId === 'string' && identity.bootId
      ? { ok: true, bootId: identity.bootId }
      : { ok: false, reason: 'unsupported-capability-version' };
  } catch (error) {
    // archive#1713: same invoke-layer recognition as `checkServerHealthDetailed`
    // above — a native-transport refusal must never collapse into
    // 'unreachable' just because it arrived as a thrown error like every
    // other transport failure here.
    const nativeRefusal = classifyNativeTransportRefusal(error);
    if (nativeRefusal) return { ok: false, reason: nativeRefusal };
    return {
      ok: false,
      reason:
        controller.signal.reason === 'timeout' ? 'timeout' : 'unreachable',
    };
  } finally {
    clearTimeout(timeout);
    parentSignal.removeEventListener('abort', abort);
  }
}
