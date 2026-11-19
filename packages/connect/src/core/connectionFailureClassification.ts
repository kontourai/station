import { CLIENT_PROTOCOL_UNSUPPORTED_ERROR_CODE } from '@kontourai/station-contracts/environment-security';
import { AUTH_RATE_LIMITED_ERROR_CODE } from '@kontourai/station-contracts/http';
import type { ConnectionHealthCheckResult } from './ConnectionHealthCoordinator';
import type { FailureClassification } from './ConnectionSupervisor';
import type { ConnectionFailureReason } from './types';

/**
 * Maps a connect-domain failure reason onto the connection supervisor's
 * generic transient/terminal vocabulary (station#1094 R2). Shared by
 * `ConnectionHealthCoordinator` (the first adopter, station#1094 R4) and by
 * any future caller building a `ConnectionSupervisor`'s `attempt()` result
 * for this domain, so the two mechanisms can never classify the same
 * failure reason differently.
 *
 * Only `authentication-failed` stops the automatic retry ladder. Connect
 * normalizes detailed probes through `connectionProbeFailureReason` before
 * this check so temporary rate limits do not stop recovery.
 */
export function classifyConnectionFailure(
  reason: ConnectionFailureReason,
): FailureClassification {
  return reason === 'authentication-failed' ? 'terminal' : 'transient';
}

/**
 * Reasons that will not resolve themselves and that a person has to decide
 * something about — station#3297 part 3.
 *
 * The banner slot is for exactly these. Everything else is either a transient
 * reachability blip the retry ladder is already handling ('timeout',
 * 'unreachable', 'server-restarted', 'host-unavailable', 'busy'), a device-local
 * condition that heals when the network returns ('offline'), a bounded wait
 * ('awaiting-approval'), or a failure this client could not attribute at all
 * ('undetermined') — and a paragraph of prose with an address in it is the
 * wrong instrument for all of them. The connection indicator carries those
 * instead.
 *
 * `undetermined` is deliberately on the silent side: a reason nothing derived
 * cannot justify interrupting the reader, and asserting one would reintroduce
 * exactly the defect this vocabulary was added to remove.
 */
const REASONS_NEEDING_A_DECISION: ReadonlySet<ConnectionFailureReason> =
  new Set([
    'mixed-content',
    'invalid-endpoint',
    'identity-mismatch',
    'access-method-mismatch',
    'authentication-failed',
    'access-scope-refused',
    'relay-authority-unavailable',
    'access-check-unavailable',
    'unsupported-capability-version',
    'client-protocol-unsupported',
    'origin-not-allowed',
    'unexpected-response',
  ]);

export function connectionFailureNeedsDecision(
  reason: ConnectionFailureReason,
): boolean {
  return REASONS_NEEDING_A_DECISION.has(reason);
}

/**
 * Classify a failed HTTP response for existing probe callers. The
 * authentication family historically includes 401, insufficient-scope 403,
 * and the authentication limiter's 429. The limiter can be shared across
 * callers and its answer alone cannot establish an invalid credential.
 * Detailed probes retain the observed response so client remedies can
 * distinguish the cases. An uncoded 403 keeps the unexpected-response reason.
 */
export function classifyHttpFailureResponse(
  status: number,
  errorCode: string | undefined,
): ConnectionFailureReason {
  if (status === 401) return 'authentication-failed';
  if (status === 403) {
    if (errorCode === 'insufficient_scope') return 'authentication-failed';
    if (errorCode === 'origin_forbidden' || errorCode === 'origin_required') {
      return 'origin-not-allowed';
    }
    return 'unexpected-response';
  }
  if (status === 429 && errorCode === AUTH_RATE_LIMITED_ERROR_CODE) {
    return 'authentication-failed';
  }
  if (status === 426 && errorCode === CLIENT_PROTOCOL_UNSUPPORTED_ERROR_CODE) {
    return 'client-protocol-unsupported';
  }
  return 'unexpected-response';
}

/** Use observed probe facts to choose the status and remedy shown to the client. */
export function connectionProbeFailureReason(
  result: Extract<ConnectionHealthCheckResult, { ok: false }>,
): ConnectionFailureReason {
  const evidence = result.evidence;
  if (evidence?.kind === 'local-authority')
    return 'relay-authority-unavailable';
  if (evidence?.kind !== 'http') return result.reason;
  if (
    evidence.status === 429 &&
    evidence.code === AUTH_RATE_LIMITED_ERROR_CODE
  ) {
    return 'authentication-rate-limited';
  }
  if (evidence.status === 403 && evidence.code === 'insufficient_scope') {
    return 'access-scope-refused';
  }
  if (evidence.status === 401 && evidence.phase === 'handshake') {
    return 'access-check-unavailable';
  }
  return result.reason;
}

/**
 * The one property this module reads off a caught native-transport error:
 * an optional stable `code` string. Both `station_native_http_request`
 * (`src-desktop/src/lib.rs`, `NativeCommandError`) and the wrapping helpers
 * on the TypeScript side (`src-ui/src/platform/native/authenticatedTransport.ts`)
 * attach this to every `Error` they construct or rethrow on this path.
 */
interface CodedError {
  code?: unknown;
}

function nativeRefusalCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as CodedError).code;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
}

/**
 * station#2327 — native transport codes that, AFTER the address has been seen
 * to answer, mean "this request did not get a turn in time" rather than
 * "nothing is there". Only meaningful with that prior observation; on its own
 * `transport_timeout` cannot tell a stalled Station from a sleeping host.
 */
export function isNativeTransportSaturation(error: unknown): boolean {
  const code = nativeRefusalCode(error);
  return code === 'transport_capacity' || code === 'transport_timeout';
}

/**
 * station#1713 (original) / station#1818 R2 (this rewrite) — the
 * classification half of the connection-truth fix.
 *
 * Desktop's native HTTP bridge (`station_native_http_request`,
 * `src-desktop/src/lib.rs`) can refuse a request before it ever attempts the
 * network, when the host-side native Station authority itself has nothing
 * authorized for the request's origin, or when the OS credential store
 * cannot produce the bearer it already has a reference for. That refusal
 * surfaces to `packages/connect` and its callers as an ordinary thrown
 * `Error` — by construction indistinguishable *by shape* from a genuine
 * transport failure
 * (`src-ui/src/platform/native/authenticatedTransport.ts` wraps both the
 * same way) — so every prior caller defaulted it to `unreachable`. That
 * reads as "the address is wrong", when the true state is "this device
 * isn't authorized here yet" (a pairing/authentication problem, not a
 * reachability one), "a profile is mid-authorization and nothing is wrong
 * at all" (station#1713's own root cause), or "the credential this device
 * already has cannot be read back" (station#1818's: a nightly bundle swap
 * re-signs the app, the macOS keychain ACL bound to the previous signature
 * refuses the rebuilt process, and the app was reading that refusal as
 * generic unreachability forever, with no path back).
 *
 * station#1818 R2 replaced the original version of this function, which
 * matched literal English-prose substrings of the thrown `Error`'s
 * `message` across the FFI boundary. That required a companion test
 * (`connectionFailureClassification.test.ts`) to read `src-desktop/src/lib.rs`
 * itself and pin the exact wording, because a reworded `Err(...)` on the
 * Rust side would otherwise silently degrade every one of these cases back
 * to `unreachable` — precisely the failure mode this function exists to
 * close. `code` is now the contract on both sides
 * (`NativeCommandError { code, message }` in Rust); `message` stays free
 * text for logs and UI fallback copy. This function now switches on `code`
 * alone, and the pin test below checks the CODE vocabulary, not prose.
 *
 * Returns `null` for anything without a recognized `code` — a genuine
 * transport failure, or (narrow, disclosed compatibility path) an error
 * from a native command not yet converted to carry one. Never guesses a
 * reason it cannot support: the caller's own `unreachable`/`timeout`
 * fallback still applies, exactly as it did before any of these codes
 * existed.
 */
export function classifyNativeTransportRefusal(
  error: unknown,
): ConnectionFailureReason | null {
  const code = nativeRefusalCode(error);
  if (code === undefined) return null;
  switch (code) {
    // A profile that IS selected and mid-authorization (a pairing exchange
    // still in flight, or a credential rebind the host has not observed
    // yet) is not a reachability problem at all — the host authority
    // answered, out of band, that nothing is wrong with the address; it
    // just has not finished yet.
    case 'mid_authorization':
      return 'awaiting-approval';
    // No active Station at all, a Station that was never configured here,
    // a binding invalidated since one was selected, or a credential this
    // device already has a reference for that the OS store cannot produce
    // — every one of these means THIS device is not authenticated at this
    // address yet. The remedy is pairing (or, for the two credential-store
    // codes, an automatic re-provision — see station#1818 part 1), never
    // checking the network. Nothing is pending in any of these cases, so
    // none of them may read as `awaiting-approval`.
    case 'no_active_profile':
    case 'not_configured':
    case 'credential_binding_changed':
    case 'binding_changed':
    case 'origin_changed':
    case 'credential_not_observed':
    case 'credential_missing':
    case 'credential_store_unreadable':
      return 'authentication-failed';
    // station#2327 — the desktop broker's own per-Station request queue is
    // full. The request was refused locally, immediately, and never reached
    // the network, so it is neither a failed address nor a failed
    // credential. `transport_timeout` is deliberately NOT here: it also
    // covers a CONNECT timeout to a host that is off or asleep, which is
    // real unreachability. `probeServerConnection` reads it as busy only
    // after the same probe's handshake proved the address answers.
    case 'transport_capacity':
      return 'busy';
    default:
      // An unrecognized code — a future refusal this classifier has not
      // been taught, or (narrow compatibility path) an error surfaced by a
      // native command this fix's scope did not convert to carry one.
      // Deliberately conservative: fall through to the caller's own
      // transport-failure default rather than assert a specific reason
      // this function cannot actually support.
      return null;
  }
}
