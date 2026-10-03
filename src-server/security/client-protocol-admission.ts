import {
  CLIENT_PROTOCOL_HEADER,
  CLIENT_PROTOCOL_INVALID_ERROR_CODE,
  CLIENT_PROTOCOL_UNSUPPORTED_ERROR_CODE,
  LEGACY_CLIENT_PROTOCOL,
  MAX_CLIENT_PROTOCOL,
  readClientProtocolHeader,
  type StationCompatibility,
} from '@kontourai/station-contracts/environment-security';
import type { ExternalSurfaceCapabilityRule } from './pairing-route-scopes.js';

/** The part of the advertised compatibility block the host enforces. */
export type ClientProtocolPolicy = Pick<
  StationCompatibility,
  'serverVersion' | 'protocolVersion' | 'minClientProtocol'
>;

/**
 * The public pairing ceremony a client performs to obtain its credential.
 * These are the only `public` routes inside the client API contract: a host
 * that no longer serves a client must say so before it pairs one, not after.
 */
const PAIRING_CEREMONY_RULE_IDS: ReadonlySet<string> = new Set([
  'public:pairing-request',
  'public:pairing-access-request',
  'public:pairing-exchange',
]);

export interface ClientProtocolRefusal {
  status: 400 | 426;
  body: {
    error: {
      code: string;
      message: string;
      clientProtocol?: number;
      minClientProtocol?: number;
      protocolVersion?: number;
      serverVersion?: string;
    };
  };
}

/**
 * Whether a request falls under the client API protocol at all.
 *
 * In scope: every Device- or operator-credentialed route (`pairing-scope` in
 * the central capability table) and the pairing ceremony that mints those
 * credentials.
 *
 * Out of scope, each with its own contract or caller:
 * - the public handshake and proof, which an outdated client must still
 *   reach to learn why it is refused;
 * - liveness and the direct-loopback owner-secret routes, whose callers are
 *   launchers and supervisors governed by the launcher protocol;
 * - MCP-token, webhook-token, stage-grant, relay-enrollment, share-token and
 *   account-authentication routes, which have separately declared callers
 *   and versioning;
 * - a caller attested as Station's own loopback consumer (per-boot internal
 *   token), which is the running host build itself.
 */
export function clientProtocolApplies(
  rule: Pick<ExternalSurfaceCapabilityRule, 'id' | 'capability'>,
  attestedInternalCaller: boolean,
): boolean {
  if (attestedInternalCaller) return false;
  return (
    rule.capability === 'pairing-scope' ||
    PAIRING_CEREMONY_RULE_IDS.has(rule.id)
  );
}

/**
 * Decide one request's client protocol against the host's policy. Returns the
 * refusal to send, or `undefined` to admit.
 *
 * Absence reads as {@link LEGACY_CLIENT_PROTOCOL}; a present but unparseable
 * header is refused rather than guessed at. A client newer than the host is
 * admitted: whether it can use this host is the client's own check against
 * the advertised `protocolVersion`.
 */
export function evaluateClientProtocol(
  headerValue: string | null | undefined,
  policy: ClientProtocolPolicy,
): ClientProtocolRefusal | undefined {
  const reading = readClientProtocolHeader(headerValue);
  if (reading.kind === 'malformed') {
    return {
      status: 400,
      body: {
        error: {
          code: CLIENT_PROTOCOL_INVALID_ERROR_CODE,
          message: `${CLIENT_PROTOCOL_HEADER} must be one whole number from 1 to ${MAX_CLIENT_PROTOCOL}. Send it once, or not at all.`,
        },
      },
    };
  }
  const clientProtocol =
    reading.kind === 'declared' ? reading.protocol : LEGACY_CLIENT_PROTOCOL;
  if (clientProtocol >= policy.minClientProtocol) return undefined;
  const spoken =
    reading.kind === 'declared'
      ? `this client speaks ${clientProtocol}`
      : `this client did not say which protocol it speaks, so it is treated as ${clientProtocol}`;
  return {
    status: 426,
    body: {
      error: {
        code: CLIENT_PROTOCOL_UNSUPPORTED_ERROR_CODE,
        message: `Update this app. Station ${policy.serverVersion} no longer supports clients this old (it needs client protocol ${policy.minClientProtocol}; ${spoken}). Install the latest Station app or CLI on this device, then connect again.`,
        clientProtocol,
        minClientProtocol: policy.minClientProtocol,
        protocolVersion: policy.protocolVersion,
        serverVersion: policy.serverVersion,
      },
    },
  };
}
