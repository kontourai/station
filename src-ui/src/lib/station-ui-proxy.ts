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
 * nothing. Its only outcomes are a bounded number of retries of an
 * unauthenticated GET and the gate's "Reconnecting to this Station" screen,
 * which creates no session, skips no pairing, and PRESERVES the access context
 * this browser already had rather than widening it — the worst it can do is
 * delay a pairing prompt. A derivation on the same evidence would NOT be
 * sufficient anywhere that granted access, and must not be reused as if it were.
 */
export async function isStationUiProxyUnavailableResponse(
  response: Response,
): Promise<boolean> {
  if (!isStationUiProxyUnavailableStatus(response.status)) return false;
  try {
    const body = (await response.clone().json()) as {
      ready?: unknown;
      status?: unknown;
    };
    return body.ready === false && body.status === 'unavailable';
  } catch {
    return false;
  }
}
