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
 * Only `authentication-failed` (401/403 — the case #303 and station#1094
 * single out as the hot-loop risk) is terminal today. Every other reason
 * ('offline', 'mixed-content', 'invalid-endpoint', 'identity-mismatch',
 * 'access-method-mismatch', 'unsupported-capability-version', 'timeout',
 * 'unreachable', 'server-restarted', 'host-unavailable',
 * 'awaiting-approval') stays transient:
 * they are either genuinely retriable (network/timeout/server-restarted), a
 * healthy host simply waiting on a human (`awaiting-approval` — station#1713;
 * never terminal, since nothing about it should stop the retry ladder that
 * eventually notices approval landed), or already have their own non-retry
 * UI treatment upstream (e.g. `unsupported-capability-version` renders a
 * version-mismatch BannerHost item via ConnectionBannerSource instead of
 * the generic retry banner) so they do not need a second no-retry mechanism
 * here. Broadening this list is a disclosed follow-up, not a blocker for
 * closing the auth hot-loop this issue exists to fix.
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
 * 'unreachable', 'server-restarted', 'host-unavailable'), a device-local
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
    'unsupported-capability-version',
    'origin-not-allowed',
    'unexpected-response',
  ]);

export function connectionFailureNeedsDecision(
  reason: ConnectionFailureReason,
): boolean {
  return REASONS_NEEDING_A_DECISION.has(reason);
}

/**
 * The code a Station's HTTP boundary attaches when it is throttling one peer's
 * repeated AUTH failures (`AUTH_RATE_LIMITED_ERROR_CODE` in
 * `src-server/runtime/bootstrap/runtime-http.ts`). Declared here as a literal
 * rather than imported: `packages/connect` is a published client package and
 * must not depend on the server tree. `station-http-error-codes.test.ts` reads
 * the server source and fails if the two ever drift apart.
 */
const AUTH_RATE_LIMITED_ERROR_CODE = 'authentication_rate_limited';

/**
 * station#3297 — the derivation behind an HTTP failure response.
 *
 * Every caller here has already observed a response, so `unreachable` is off
 * the table by construction: something at that address answered. What remains
 * is what the answer actually proves.
 *
 * - **401** (`authentication_required`) — the server rejected this device's
 *   credential, or was given none. Pairing again is the fix.
 * - **403 `insufficient_scope`** — a credential the server *recognized* but
 *   will not accept for this request. Also an authentication outcome about
 *   this device, and pairing again re-mints it at the current scope. The
 *   status alone does not say this: `runtime-http.ts` answers 403 for origin
 *   policy too, which is why this reads the coded body rather than the number.
 * - **403 `origin_forbidden` / `origin_required`** — origin policy. Nothing
 *   about a credential; a distinct remedy on the host.
 * - **403 with no readable code** — an intermediary, or a Station whose
 *   vocabulary this classifier has not been taught. Do not guess which of the
 *   two 403 meanings applies; report only that the answer was unusable.
 * - **429 `authentication_rate_limited`** — the auth-failure limiter, which is
 *   reachable only after this device's credential has been REFUSED ten times
 *   in a minute (`runtime-http.ts`). It is the same authentication outcome as
 *   the 401s that fed it, arriving throttled, and station#3903 is what
 *   happened while it was not: a revoked phone's row settled on this status
 *   within seconds and read "answered, but not as a Station. Something else
 *   may be answering at that address" — a wrong-server diagnosis, from the
 *   right server, refusing that exact device. The MUTATION budget's 429 keeps
 *   its own `rate_limited` code and stays out of this branch: an authorised
 *   principal writing too fast is not a fact about access, and inventing one
 *   would be the same defect pointed the other way.
 * - **anything else** (404, 5xx, a 200 whose body will not parse) — the
 *   address answered, and not as a Station.
 *
 * `errorCode` is `undefined` whenever the body could not be read or carried
 * no `error.code`. That is a real state, not a lookup miss, and it lands on
 * `unexpected-response` rather than borrowing a neighbouring reason's meaning.
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
  return 'unexpected-response';
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
