/**
 * The two statuses the Station-owned UI proxy sends its readiness envelope with
 * (`proxyToBackend`, `packages/cli/src/commands/lifecycle.ts`): 503 when its
 * upstream request ERRORED, 504 when that request TIMED OUT. Both mean the same
 * thing to every caller here — the proxy is up, its sibling host could not
 * answer — and the status is what separates the causes.
 *
 * The 504 half is station#1654. It used to answer `text/plain` "Gateway
 * Timeout", with no envelope, no header and no code: byte-identical to what any
 * intermediary between the browser and this proxy emits. So there was NOTHING to
 * recognise, and no honest client-side check could have been written — a check
 * narrow enough to be true would have matched nothing, and one that matched that
 * answer would have matched every stranger's 504. The proxy had to be changed to
 * send a signal; this reads the signal it now sends.
 */
function isStationUiProxyUnavailableStatus(status: number): boolean {
  return status === 503 || status === 504;
}

/**
 * The UI process stays alive while its sibling Station host is restarting or
 * starved, and answers API requests with this exact, documented readiness
 * envelope. The status alone is not enough: an arbitrary 503 — or an arbitrary
 * 504 from some intermediary, which is the same caution one status along —
 * remains an unknown responder, so the envelope is what this reads. Widening the
 * status set without it would be the wrong fix (station#1654).
 *
 * A CONVENTION, NOT AN AUTHENTICATION, and the distinction is load-bearing. An
 * intermediary that chose to emit this envelope on a 503 or 504 would be
 * indistinguishable from the proxy itself, as would the upstream host, whose
 * responses this proxy relays verbatim. That has always been true of the 503
 * case and nothing here makes it truer.
 *
 * What makes the convention SUFFICIENT here is that a false positive grants
 * nothing: it creates no session, skips no pairing, and PRESERVES the access
 * context this browser already had rather than widening it. It is NOT free, and
 * the cost differs per consumer, so both are named — an earlier revision of this
 * comment claimed the only outcomes were bounded retries of an unauthenticated
 * GET, which is untrue of the second one:
 *
 *  - `local-ui-bootstrap.ts` (the session gate): a bounded number of retries of
 *    an unauthenticated GET, then the "Reconnecting to this Station" screen. The
 *    worst it can do is delay a pairing prompt.
 *  - `serverHealth.ts` (saved-connection probes): this decides a
 *    `host-unavailable` reason for a connection the user has saved, and those
 *    probes are AUTHENTICATED and go to whatever remote address the connection
 *    names — not to this browser's own origin. For the real local proxy, reading
 *    its timeout answer here is an improvement: a gateway timeout carrying the
 *    envelope used to fall through to `unexpected-response` and render a banner
 *    saying something else may be answering at that address, when the Station's
 *    own proxy had answered. For a saved address that is NOT a Station but does
 *    answer these bytes, it is a regression in the other direction: the user is
 *    told their host is away instead of being told to check the address.
 *
 * A derivation on the same evidence would NOT be sufficient anywhere that granted
 * access, and must not be reused as if it were.
 *
 * DECLINED TIGHTENING: requiring `Content-Type: application/json`. The producer
 * does send it and `lifecycle.test.ts` pins it, so this looks like an obvious
 * strengthening, and it is deliberately not taken. It closes no misclassification
 * anyone has identified — the bytes are the signal, and a stranger willing to emit
 * this envelope is equally willing to emit the header — and it adds a condition
 * whose FAILURE MODE IS THE ORIGINAL DEFECT: anything that rewrote or stripped
 * that header would turn a real proxy answer into a non-OK response with no
 * envelope, which is the pairing screen. A condition that can only fail toward the
 * bug this check exists to prevent needs a real benefit to earn its place, and
 * there is none here. Do not re-propose it without one.
 *
 * KNOWN LIMIT, recorded rather than fixed: a close-delimited response truncated by
 * the close itself reads as a complete body, so a partial envelope would be
 * classified from what arrived. This proxy cannot produce it — its own framing
 * always sets a length or chunks — so there is no path from a Station to this
 * case, and adding machinery for it would be defending a shape the producer
 * cannot emit.
 *
 * THREE EXITS, because the shape of the failure decides which:
 *
 *  1. bytes that are not JSON (`SyntaxError`) — something ANSWERED, and it is not
 *     this envelope. `false`.
 *  2. valid JSON that is not an object — also an answer, also not this envelope.
 *     `false`, via the guard below rather than inside the parse handler: a field
 *     read that threw in there would be indistinguishable from a body that could
 *     not be read, which is the very collapse this function exists to undo.
 *  3. a body that could not be READ to the end — rethrown, because it is not an
 *     answer at all and only the caller can decide what "no answer" means.
 */
export async function isStationUiProxyUnavailableResponse(
  response: Response,
): Promise<boolean> {
  if (!isStationUiProxyUnavailableStatus(response.status)) return false;
  // `unknown`, not a cast to the envelope's shape: the cast is what let a `null`
  // body reach a field read and throw past this function entirely (exit 2 below).
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch (error) {
    // Exit 1 versus exit 3. A `SyntaxError` is bytes that are not JSON.
    //
    // Anything else here is a body that could not be READ — the caller's
    // deadline aborted it, or the responder tore the stream down mid-body, which
    // is what the UI proxy itself does to a client whose upstream went away. That
    // is not an answer at all, and swallowing it as `false` was a live defect:
    // headers arrive as this envelope, the body never completes, and the caller
    // reads the resulting `false` beside a non-OK status as a decision ABOUT the
    // browser — the exact misclassification station#1654 is about, reached
    // through the body instead of the status. Rethrow, so the caller's own
    // failure branch owns it.
    if (error instanceof SyntaxError) return false;
    throw error;
  }
  // Exit 2. `null` is the case that matters: it PARSES, so the handler above
  // completes, and reading a field off it throws — which escaped this function and
  // was classified as no answer at all. A body that parsed is an answer, and
  // reporting an answer as no answer is the mirror of the defect above.
  if (typeof body !== 'object' || body === null) return false;
  const envelope = body as { ready?: unknown; status?: unknown };
  return envelope.ready === false && envelope.status === 'unavailable';
}
