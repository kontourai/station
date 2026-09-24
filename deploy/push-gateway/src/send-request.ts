// The only message shape the gateway forwards. Anything else is refused, so the
// gateway cannot be used as a general-purpose FCM sender for other apps or for
// notification (display) messages that bypass the app's own checks.

const MAX_DATA_BYTES = 3800; // FCM's limit is 4096 for the whole data payload.
const MAX_DATA_KEYS = 40;
const DATA_KEY = /^[a-z][a-z0-9_]{0,63}$/;
// FCM reserves these prefixes and keys. `station_key` is stamped by the
// gateway itself after verifying the signature, so a caller may not supply it.
const RESERVED_KEY =
  /^(google|gcm|from|message_type|collapse_key|notification$|station_key$)/;

export interface SendRequest {
  token: string;
  packageName: string;
  data: Record<string, string>;
  collapseKey?: string;
}

export type ParsedSendRequest =
  | { ok: true; request: SendRequest }
  | { ok: false; reason: string };

export function parseSendRequest(
  body: Uint8Array<ArrayBuffer>,
  allowedPackages: readonly string[],
): ParsedSendRequest {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return { ok: false, reason: 'body is not JSON' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return { ok: false, reason: 'body must be an object' };
  const input = value as Record<string, unknown>;

  const { token, packageName, data, collapseKey } = input;
  if (
    typeof token !== 'string' ||
    token.length < 20 ||
    token.length > 4096 ||
    /\s/.test(token)
  ) {
    return { ok: false, reason: 'invalid token' };
  }
  if (
    typeof packageName !== 'string' ||
    !allowedPackages.includes(packageName)
  ) {
    return { ok: false, reason: 'package is not a Station app' };
  }
  if (
    collapseKey !== undefined &&
    (typeof collapseKey !== 'string' || !DATA_KEY.test(collapseKey))
  ) {
    return { ok: false, reason: 'invalid collapseKey' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data))
    return { ok: false, reason: 'data must be an object' };

  const entries = Object.entries(data as Record<string, unknown>);
  if (entries.length === 0 || entries.length > MAX_DATA_KEYS)
    return { ok: false, reason: 'data key count out of range' };
  for (const [key, field] of entries) {
    if (!DATA_KEY.test(key) || RESERVED_KEY.test(key))
      return { ok: false, reason: `invalid data key ${key.slice(0, 64)}` };
    if (typeof field !== 'string')
      return { ok: false, reason: 'data values must be strings' };
  }
  const fields = data as Record<string, string>;
  // The Android handler only renders this kind; refusing others keeps the gateway
  // scoped to agent activity rather than arbitrary app messages.
  if (fields.station_kind !== 'agent_activity')
    return { ok: false, reason: 'unsupported station_kind' };
  if (
    new TextEncoder().encode(JSON.stringify(fields)).length > MAX_DATA_BYTES
  ) {
    return { ok: false, reason: 'data too large' };
  }

  return {
    ok: true,
    request: {
      token,
      packageName,
      data: fields,
      ...(collapseKey ? { collapseKey } : {}),
    },
  };
}
