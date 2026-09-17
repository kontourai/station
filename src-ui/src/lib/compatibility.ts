/**
 * Client/server compatibility verdicts.
 *
 * The incident this exists for: a phone ran an APK built from an intermediate
 * commit while the fixes it was missing had already landed on the host. The
 * app looked broken, nothing said "this client is behind", and it took manual
 * archaeology to find out. Version drift across N clients x M hosts has to be
 * legible at the moment of connection, not reconstructed afterwards.
 *
 * Everything here is pure: it takes what this client is and what a host
 * advertised, and returns a verdict plus copy that names which side to update.
 * The fetching lives in `serverHealth.ts` and the surfaces that render it.
 */

import {
  PUBLIC_STATION_HANDSHAKE_PATH,
  parseStationCompatibility,
  STATION_COMPAT_MIN_SERVER_PROTOCOL,
  STATION_COMPAT_PROTOCOL_VERSION,
  type StationClientCompatibilityPolicy,
  type StationCompatibilityResult,
} from '@kontourai/station-contracts/environment-security';

/** Deliberately short: this gates a button press, not a background poll. */
const COMPATIBILITY_PROBE_TIMEOUT_MS = 5_000;

/** What this build of the client speaks. */
export const CLIENT_COMPATIBILITY_POLICY: StationClientCompatibilityPolicy = {
  clientProtocol: STATION_COMPAT_PROTOCOL_VERSION,
  minServerProtocol: STATION_COMPAT_MIN_SERVER_PROTOCOL,
};

/**
 * Structural validation in the same fail-closed spirit as
 * `parseCapabilityReport`: a malformed block is not trusted, and is not
 * treated as a compatible host either. A compatibility claim is part of the
 * identity contract for a new connection, so an absent or malformed block is
 * actionable verification failure.
 */
/**
 * Decide whether this client can talk to the host that returned `advertised`.
 *
 * `advertised` is the raw `compatibility` value off the public handshake —
 * `undefined` for any host built before this contract existed.
 *
 * Precedence when both sides could complain: the host's refusal wins. If the
 * host says it no longer serves clients this old, telling the user to upgrade
 * the host instead would send them at a fix that cannot work.
 */
export function evaluateCompatibility(
  policy: StationClientCompatibilityPolicy,
  advertised: unknown,
): StationCompatibilityResult {
  const server = parseStationCompatibility(advertised);
  if (!server) {
    return {
      verdict: 'unknown',
      blocking: true,
      reason:
        'Station compatibility could not be verified because this host did not provide a valid compatibility declaration. Update Station on the host, then try connecting again.',
    };
  }
  const shared = {
    serverVersion: server.serverVersion,
    serverProtocol: server.protocolVersion,
  };
  if (policy.clientProtocol < server.minClientProtocol) {
    return {
      ...shared,
      verdict: 'client-too-old',
      blocking: true,
      reason: `Update this app. Station ${server.serverVersion} no longer supports clients this old (it needs client protocol ${server.minClientProtocol}; this app speaks ${policy.clientProtocol}). Install the latest Station app on this device, then connect again.`,
    };
  }
  if (server.protocolVersion < policy.minServerProtocol) {
    return {
      ...shared,
      verdict: 'server-too-old',
      blocking: true,
      reason: `Update the Station host. This app needs host protocol ${policy.minServerProtocol} or newer, and this host (Station ${server.serverVersion}) speaks ${server.protocolVersion}. Upgrade Station on the host machine, then connect again.`,
    };
  }
  return {
    ...shared,
    verdict: 'compatible',
    blocking: false,
    reason: `Station ${server.serverVersion} is compatible with this app.`,
  };
}

/**
 * Handshake a host and evaluate it, without saving anything.
 *
 * A host that cannot be reached or does not return the public compatibility
 * declaration is blocked with an actionable result. Saving an unverified host
 * would turn a connection-contract failure into a harder-to-diagnose profile.
 */
export async function checkHostCompatibility(
  url: string,
  signal?: AbortSignal,
  policy: StationClientCompatibilityPolicy = CLIENT_COMPATIBILITY_POLICY,
  transport: typeof fetch = fetch,
): Promise<StationCompatibilityResult> {
  // Bounded like the modal's existing candidate review: this check sits in
  // front of an Add button, and a black-hole host must not hang it.
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, COMPATIBILITY_PROBE_TIMEOUT_MS);
  try {
    const response = await transport(
      new URL(PUBLIC_STATION_HANDSHAKE_PATH, url),
      {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      return {
        verdict: 'unknown',
        blocking: true,
        reason: `Station compatibility could not be verified because the host returned HTTP ${response.status}. Check the Station address and service, then try again.`,
      };
    }
    const handshake = (await response.json()) as { compatibility?: unknown };
    return evaluateCompatibility(policy, handshake?.compatibility);
  } catch {
    const timedOut = controller.signal.aborted && !signal?.aborted;
    return {
      verdict: 'unknown',
      blocking: true,
      reason: timedOut
        ? 'Station compatibility check timed out. Check that the Station is running and reachable, then try again.'
        : 'Station compatibility could not be verified because the host could not be reached. Check the Station address and service, then try again.',
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}
