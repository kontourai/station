const FALLBACK_TOOL_SERVER_REASON =
  'protocol_error: Tool server returned an unexpected protocol response';

const STATION_OWNED_TOOL_SERVER_REASONS = new Set([
  'invalid_client: OAuth client credentials were rejected',
  'invalid_grant: OAuth authorization grant was rejected or expired',
  'access_denied: OAuth authorization was denied',
  'server_error: OAuth authorization server failed to complete the request',
  'network_error: OAuth authorization server could not be reached',
  'unexpected_response: OAuth authorization server returned an unexpected response',
  'transport_error: Tool server transport failed',
  'network_error: Tool server could not be reached',
  'authentication_error: Tool server authentication failed',
  FALLBACK_TOOL_SERVER_REASON,
  'Tool server endpoint changed',
  'OAuth credentials were cleared when the integration was disabled',
  'Stored refresh token was rejected; operator consent is required',
]);

/**
 * Legacy integration files can contain pre-classification free text. Preserve
 * only exact Station-owned reasons; collapse every other value to a fixed
 * protocol reason before it reaches a projection.
 */
export function normalizePersistedToolServerReason(input: unknown): string {
  return typeof input === 'string' &&
    STATION_OWNED_TOOL_SERVER_REASONS.has(input)
    ? input
    : FALLBACK_TOOL_SERVER_REASON;
}
