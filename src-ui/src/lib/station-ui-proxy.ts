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
 */
export async function isStationUiProxyUnavailableResponse(
  response: Response,
): Promise<boolean> {
  if (!isStationUiProxyUnavailableStatus(response.status)) return false;
  let body: { ready?: unknown; status?: unknown };
  try {
    body = (await response.clone().json()) as {
      ready?: unknown;
      status?: unknown;
    };
  } catch (error) {
    // ONLY a body that parsed and is not the envelope means "not this proxy's
    // answer". A `SyntaxError` is exactly that: something answered with bytes
    // that are not JSON.
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
  return body.ready === false && body.status === 'unavailable';
}
