/**
 * Transport messages are implementation diagnostics, not user-facing copy.
 *
 * Anchored to the EXACT phrases the transports emit for their transport_*
 * codes (src-desktop/src/lib.rs) plus the browsers' own fetch network
 * failures. The generic 'Native Station request failed:' prefix must NEVER
 * match on its own: the native wrapper uses it for authorization/profile
 * refusals too, and claiming Station is unreachable for a refusal is the
 * misclassification the #2630 delta review prohibited (re-caught by the
 * #2645 sol round when an extraction reintroduced it).
 */
const TRANSPORT_FAILURE_PATTERNS = [
  /timed out before response headers arrived/i,
  /could not be resolved/i,
  /TLS connection to Station failed/i,
  /refused the connection/i,
  /reset before a response arrived/i,
  /unreachable on the current network/i,
  /Connection to Station timed out/i,
  /^(?:TypeError:\s*)?(?:Failed to fetch|fetch failed|NetworkError|Load failed)/i,
  /^(?:ECONNREFUSED|ECONNRESET|EHOSTUNREACH)\b/i,
] as const;

export function isStationTransportFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return TRANSPORT_FAILURE_PATTERNS.some((pattern) => pattern.test(message));
}
