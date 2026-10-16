import { PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_PATH } from '@kontourai/station-contracts/environment-security';
import {
  LOCAL_UI_SESSION_HOST_RETRY_DELAYS_MS,
  localUiSessionIdentityDeadlineMs,
} from './local-ui-session-retry';
import { isStationUiProxyUnavailableResponse } from './station-ui-proxy';

const FRAGMENT_KEY = 'station-ui-bootstrap';
const capturedTokens = new Set<string>();
let sessionResolution: Promise<LocalUiSessionResolution> | undefined;

type LocalUiSessionResolution =
  | { kind: 'authenticated' }
  | { kind: 'host-unavailable' }
  | { kind: 'access-required'; message?: string };

/**
 * Which attempt of `LOCAL_UI_SESSION_ATTEMPT_LIMIT` is in flight, as a
 * subscribable snapshot.
 *
 * A retry that is invisible is a page that looks stuck for longer than it used
 * to, so the gate renders this in the pending output it already owns. It lives
 * here rather than in the gate because the resolution is memoized for the page:
 * whichever caller triggers it first drives the ladder (`main.tsx` seeds boot
 * data through the same promise), so the gate cannot be the one counting.
 */
let identityAttempt = 1;
const attemptListeners = new Set<() => void>();

/**
 * Bumped whenever the memoized resolution is discarded, so a ladder that is
 * mid-backoff at that moment can tell it has been superseded and stop. Read
 * after every `await` inside `resolveLocalUiSession`.
 */
let resolutionGeneration = 0;

export function getLocalUiSessionAttempt(): number {
  return identityAttempt;
}

export function subscribeLocalUiSessionAttempt(
  listener: () => void,
): () => void {
  attemptListeners.add(listener);
  return () => {
    attemptListeners.delete(listener);
  };
}

function setIdentityAttempt(next: number): void {
  if (identityAttempt === next) return;
  identityAttempt = next;
  for (const listener of attemptListeners) listener();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function captureLocalUiBootstrapToken(): string | undefined {
  const token = new URLSearchParams(window.location.hash.slice(1)).get(
    FRAGMENT_KEY,
  );
  if (!token || !/^[A-Za-z0-9_-]{32,}$/.test(token)) return undefined;
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${window.location.search}`,
  );
  if (capturedTokens.has(token)) return undefined;
  capturedTokens.add(token);
  return token;
}

/**
 * A DECISION ABOUT THIS BROWSER: the host read the launcher token and would not
 * accept it. Retrying cannot change that answer, and the user needs the sentence.
 *
 * A distinct class rather than a message match (#1654), because the alternative
 * — one `Error` for every throw on this path — is exactly what conflated a
 * refusal with a host that could not be reached.
 */
class LocalUiBootstrapRefusedError extends Error {}

/**
 * NO ANSWER AT ALL: the launcher-token exchange never reached a responder. Says
 * nothing about whether this browser has access, so it must not be reported as a
 * browser that needs to pair.
 *
 * Thrown from ONE place, the exchange below, and deliberately says nothing about
 * deadlines: the exchange has none. An earlier revision of this comment claimed it
 * also covered an expired deadline, which nothing computed — the identity read
 * owns its deadline and answers `host-unavailable` directly without constructing
 * this.
 *
 * DECLINED TIGHTENING: a deadline on the exchange, matching the identity read's.
 * It is not merely unhelpful, it is DESTRUCTIVE in exactly the window a deadline
 * would fire, and the mechanism is server-side: the mint deletes the token only
 * after the exchange SUCCEEDS, deliberately, so that a refused exchange stays
 * retryable. So the token survives a refusal — but not a success the client never
 * saw. A deadline firing after the server committed destroys the token while this
 * browser never receives the cookie, and the page cannot re-mint: that endpoint
 * requires a direct-loopback caller proving a per-boot secret, which a browser is
 * not. The user would need a fresh start link for a host that was merely slow.
 *
 * The residual is a host that accepts the connection and never answers, where this
 * browser sits on the gate's pending screen until the degraded window offers a
 * reload. That reload does NOT recover the session — the fragment was stripped at
 * capture, so it lands on the identity ladder and then the pairing screen. What it
 * buys is getting off a spinner onto a screen with something to press; the wait
 * itself is the host's to end, not the gate's.
 */
class LocalUiHostUnreachableError extends Error {}

/** Exchange an explicit launcher capability exactly once before protected UI work begins. */
export async function bootstrapLocalUiSession(
  apiBase: string,
): Promise<boolean> {
  const token = captureLocalUiBootstrapToken();
  if (!token) return false;
  let response: Response;
  // Scoped to the `fetch` call and nothing else, so what it catches IS a
  // transport failure — no message sniffing, and no risk of swallowing a
  // programming error from the lines below.
  try {
    response = await fetch(
      `${apiBase}${PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_PATH}`,
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      },
    );
  } catch {
    throw new LocalUiHostUnreachableError(
      'Could not reach this Station to exchange its start link.',
    );
  }
  // A backend restarting behind the UI proxy is the host being away, exactly
  // as the identity read treats it, not a verdict on this link. A body that
  // cannot be read to the end (the check rethrows) is no answer either.
  let proxyUnavailable: boolean;
  try {
    proxyUnavailable = await isStationUiProxyUnavailableResponse(response);
  } catch {
    proxyUnavailable = true;
  }
  if (proxyUnavailable) {
    throw new LocalUiHostUnreachableError(
      'Could not reach this Station to exchange its start link.',
    );
  }
  if (!response.ok) {
    throw new LocalUiBootstrapRefusedError(refusalSentence(response.status));
  }
  return true;
}

/**
 * What a refused sign-in link means, by status (#2612). The server answers the
 * same 403 for a token that was spent or replaced (links are single use, and a
 * new mint replaces any unspent one) and for a page origin it does not trust,
 * so a 403 names both. A 429 keeps the token retryable on purpose: asking for a
 * new link would only hit the same limit.
 */
function refusalSentence(status: number): string {
  const freshLink =
    'Get a fresh one with `station open`, or from Station in the menu bar or tray.';
  if (status === 403)
    return `This sign-in link was already used or replaced, or this address isn't trusted. ${freshLink} (403)`;
  if (status === 429)
    return 'Too many new sign-ins right now. Try this link again in a moment. (429)';
  return `Station refused this sign-in link. ${freshLink} (${status})`;
}

/**
 * One identity read, bounded by this attempt's own deadline (#1661).
 *
 * The deadline is the gate's, not the proxy's: without it the only bound was the
 * UI proxy's 30 s upstream timeout, so a loaded host could hold the gate for
 * longer than the whole retry ladder was budgeted to take. An expired deadline is
 * reported as `host-unavailable`, which is what puts it INSIDE the ladder — the
 * retry is the recovery, and a host that answers late still gets in on a later,
 * longer rung.
 *
 * An owned `AbortController` rather than `AbortSignal.timeout`, matching
 * `probeServerConnection` in `serverHealth.ts`: the timer is cleared once this
 * read is CLASSIFIED, so nothing outlives the request it belonged to.
 *
 * The deadline covers the CLASSIFICATION, not just the headers, and the try
 * below is drawn around both for that reason. An earlier revision cleared the
 * timer the moment `fetch` resolved and then awaited the envelope check outside
 * any catch — so a response whose headers arrived and whose body never completed
 * was unbounded: the gate never settled and never climbed a rung. In production
 * its residual bound was the proxy's own inactivity timeout tearing the stream
 * down, which surfaced as an unreadable body beside a non-OK status and landed on
 * the PAIRING screen — the misclassification this change exists to remove,
 * reached through the body instead of the status.
 */
async function readLocalUiIdentity(
  apiBase: string,
  attemptIndex: number,
): Promise<LocalUiSessionResolution> {
  const controller = new AbortController();
  const deadline = setTimeout(
    () => controller.abort(),
    localUiSessionIdentityDeadlineMs(attemptIndex),
  );
  try {
    const response = await fetch(`${apiBase}/api/system/identity`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (await isStationUiProxyUnavailableResponse(response)) {
      // The Station-owned UI proxy answered, but its sibling host could not.
      // That says nothing about whether this browser's existing HttpOnly
      // session is valid, so preserve the access context rather than
      // demoting the browser to first-run pairing.
      return { kind: 'host-unavailable' };
    }
    return response.ok
      ? { kind: 'authenticated' }
      : { kind: 'access-required' };
  } catch {
    // #1654: a thrown fetch used to share one outcome — and one message — with a
    // REFUSED launcher token, so being offline, or having no route to the host,
    // rendered the pairing screen. Nothing was answered here, so nothing was
    // decided about this browser; this is the same statement the proxy's
    // readiness envelope makes, and it is retried on the same rungs.
    //
    // Three failures land here, and all three are "no answer": the request never
    // reached a responder, this attempt's deadline expired, or a body that had
    // begun could not be read to the end (the envelope check rethrows that case
    // rather than reporting it as a body which is not the envelope).
    return { kind: 'host-unavailable' };
  } finally {
    clearTimeout(deadline);
  }
}

/**
 * Share one session decision across boot and StrictMode callers. An explicit
 * fresh launcher link replaces that decision; each presented capability is
 * scrubbed before exchange and never replayed by the host-unavailable ladder.
 * Pairing success also permits a new identity read (#1639, #1654, #1661).
 * Authentication refusals remain cached instead of spending the auth budget.
 */
export function resolveLocalUiSession(
  apiBase: string,
): Promise<LocalUiSessionResolution> {
  const incomingToken = new URLSearchParams(window.location.hash.slice(1)).get(
    FRAGMENT_KEY,
  );
  if (
    incomingToken &&
    /^[A-Za-z0-9_-]{32,}$/.test(incomingToken) &&
    !capturedTokens.has(incomingToken)
  ) {
    sessionResolution = undefined;
    resolutionGeneration += 1;
  } else if (incomingToken && capturedTokens.has(incomingToken)) {
    captureLocalUiBootstrapToken();
  }
  sessionResolution ??= (async () => {
    // A pairing recheck or a test reset replaces the memoized promise while this
    // ladder may still be mid-backoff. A superseded resolution DOES still have an
    // awaiter — `main.tsx`'s boot-payload seed holds the promise object it got at
    // call time, not whatever is memoized now — and a continuing ladder WOULD
    // eventually resolve it. So the early return below is about when and at what
    // cost: answer that awaiter NOW with the last real observation, rather than
    // make it wait out a ladder whose gate has already been replaced. What the
    // guard protects is the requests those remaining rungs would spend, and the
    // attempt counter, which is module-level and shared: the abandoned ladder's
    // `setIdentityAttempt` writes would otherwise clobber the live one the gate
    // is rendering from.
    //
    // A fresh launcher link can supersede a pending identity ladder.
    const generation = resolutionGeneration;
    setIdentityAttempt(1);
    try {
      if (await bootstrapLocalUiSession(apiBase)) {
        return { kind: 'authenticated' };
      }
      for (let retry = 0; ; retry += 1) {
        // `retry` is also the attempt's index into the deadline schedule, which
        // escalates: the last rung waits longest because it is the last chance.
        const resolution = await readLocalUiIdentity(apiBase, retry);
        if (resolution.kind !== 'host-unavailable') return resolution;
        // Superseded: answer whatever the last real observation was and stop.
        if (generation !== resolutionGeneration) return resolution;
        const retryIn = LOCAL_UI_SESSION_HOST_RETRY_DELAYS_MS[retry];
        // The bound: the ladder is out of delays, so this answer is the one the
        // gate renders. Reaching it means the host answered `unavailable`
        // LOCAL_UI_SESSION_ATTEMPT_LIMIT times in a row.
        if (retryIn === undefined) return resolution;
        setIdentityAttempt(retry + 2);
        await delay(retryIn);
        if (generation !== resolutionGeneration) return resolution;
      }
    } catch (error) {
      // Only the launcher-token exchange can throw into here — the identity read
      // above catches its own transport failure and reports it as the host being
      // away — so this splits the one class #1654 was filed about (see the three
      // bullets in the doc block).
      //
      // That claim is TRUE as of the fix that drew the read's try around its
      // classification, and was false before it: with the classification outside
      // that try, a rethrown transport error escaped to here and was rendered as
      // an alert on the pairing screen — a raw transport string presented to the
      // user as a decision about their access. Anything that moves the
      // classification back out silently re-opens this door, which is why the
      // read's own tests assert on the SCREEN rather than on its return value.
      if (error instanceof LocalUiHostUnreachableError) {
        // The exchange never reached a responder. Its token is already spent
        // (captured and stripped), so nothing here can re-present it, and the
        // ladder cannot help: this returns the outcome that says the host was
        // away, and the reload the recovery screen offers is what tries again.
        // What it must NOT do is claim this browser has no access.
        return { kind: 'host-unavailable' };
      }
      return {
        kind: 'access-required',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  })();
  return sessionResolution;
}

/**
 * Re-read access after pairing or an explicit host-recovery action. Consumed
 * launcher fragments stay consumed; authentication refusals do not auto-retry.
 */
export function recheckLocalUiSession(
  apiBase: string,
): Promise<LocalUiSessionResolution> {
  sessionResolution = undefined;
  resolutionGeneration += 1;
  return resolveLocalUiSession(apiBase);
}

export function resetLocalUiBootstrapForTests(): void {
  capturedTokens.clear();
  sessionResolution = undefined;
  resolutionGeneration += 1;
  setIdentityAttempt(1);
}
