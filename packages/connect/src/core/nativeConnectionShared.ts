import type { ApprovedStationConnectionTrust } from '@kontourai/station-contracts/connection-proof';
import { encodeBase64Url } from '@kontourai/station-shared/base64url';

export const SDP_LIMIT = 64 * 1024;
export const FINGERPRINT = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/u;

export function fingerprint(sdp: string) {
  if (typeof sdp !== 'string' || sdp.length === 0 || sdp.length > SDP_LIMIT)
    throw new Error('native_connection_sdp_invalid');
  const values = [...sdp.matchAll(/^a=fingerprint:sha-256 (.+)$/gm)].map(
    (match) => match[1]!.trim(),
  );
  const distinct = [...new Set(values)];
  if (distinct.length !== 1 || !FINGERPRINT.test(distinct[0]!))
    throw new Error('native_connection_fingerprint_invalid');
  return distinct[0]!;
}

export function randomNonce(bytes: number) {
  if (!globalThis.crypto?.getRandomValues)
    throw new Error('native_connection_secure_context_required');
  return encodeBase64Url(
    globalThis.crypto.getRandomValues(new Uint8Array(bytes)),
  );
}

export function sameTrust(
  left: ApprovedStationConnectionTrust,
  right: ApprovedStationConnectionTrust,
) {
  return (
    left.stationId === right.stationId &&
    left.enrollmentId === right.enrollmentId &&
    left.generation === right.generation &&
    JSON.stringify(left.signingKey) === JSON.stringify(right.signingKey)
  );
}
