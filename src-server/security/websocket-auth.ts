import { REMOTE_AUTH_PROTOCOL_VERSION } from '@kontourai/station-contracts';
import type { RawData } from 'ws';

export const WEBSOCKET_AUTH_CLOSE = {
  required: [4401, 'authentication_failed'],
  timeout: [4401, 'authentication_timeout'],
  queryCredential: [4401, 'query_credential_rejected'],
  unsupportedPath: [4404, 'unsupported_path'],
  frameTooLarge: [4409, 'authentication_frame_too_large'],
  rateLimited: [4429, 'authentication_rate_limited'],
  capacityExceeded: [4429, 'authentication_capacity_exceeded'],
} as const;

const CREDENTIAL_QUERY_KEYS = ['credential', 'token', 'access_token', 'auth'];

export function hasWebSocketCredentialQuery(url: URL): boolean {
  return CREDENTIAL_QUERY_KEYS.some((key) => url.searchParams.has(key));
}

export type WebSocketAuthFrameResult =
  | { ok: true; credential: string }
  | { ok: false; reason: 'invalid_frame' | 'frame_too_large' };

/** Strictly decodes the only frame accepted before a remote WebSocket is authorized. */
export function decodeWebSocketAuthFrame(
  raw: RawData,
  maxBytes: number,
): WebSocketAuthFrameResult {
  const bytes = Buffer.isBuffer(raw)
    ? raw.byteLength
    : Buffer.byteLength(raw.toString());
  if (bytes > maxBytes) return { ok: false, reason: 'frame_too_large' };

  let value: unknown;
  try {
    value = JSON.parse(raw.toString());
  } catch {
    return { ok: false, reason: 'invalid_frame' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'invalid_frame' };
  }
  const frame = value as Record<string, unknown>;
  if (
    Object.keys(frame).length !== 3 ||
    frame.type !== 'auth' ||
    frame.protocolVersion !== REMOTE_AUTH_PROTOCOL_VERSION ||
    typeof frame.credential !== 'string'
  ) {
    return { ok: false, reason: 'invalid_frame' };
  }
  return { ok: true, credential: frame.credential };
}

export function authenticatedWebSocketAck(): string {
  return JSON.stringify({
    type: 'authenticated',
    protocolVersion: REMOTE_AUTH_PROTOCOL_VERSION,
  });
}
