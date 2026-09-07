import { PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_PATH } from '@kontourai/station-contracts/environment-security';
import {
  LOCAL_UI_SESSION_HOST_RETRY_DELAYS_MS,
  localUiSessionIdentityDeadlineMs,
} from './local-ui-session-retry';
import { isStationUiProxyUnavailableResponse } from './station-ui-proxy';

const FRAGMENT_KEY = 'station-ui-bootstrap';
let captured = false;
let sessionResolution: Promise<LocalUiSessionResolution> | undefined;

export type LocalUiSessionResolution =
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
  if (captured) return undefined;
  const token = new URLSearchParams(window.location.hash.slice(1)).get(
    FRAGMENT_KEY,
  );
  if (!token || !/^[A-Za-z0-9_-]{32,}$/.test(token)) return undefined;
  captured = true;
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${window.location.search}`,
  );
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
export class LocalUiBootstrapRefusedError extends Error {}

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
export class LocalUiHostUnreachableError extends Error {}

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
  if (!response.ok) {
    throw new LocalUiBootstrapRefusedError(
      `Local UI bootstrap was refused (${response.status}). Open a fresh Station start link.`,
    );
  }
  return true;
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
 * Resolve the local browser's session once per page lifetime. React StrictMode
 * may mount a gate twice during Vite development, but a missing session must
 * not turn that into repeated protected requests or auth-rate-limit traffic.
 *
 * `host-unavailable` is the ONE outcome retried here (#1639), because it is the
 * one that can answer differently with nothing about this browser changed. Three
 * observations now reach it, and #1654 is what added the second and third:
 *
 *  - the UI proxy answered its documented readiness envelope, which says its
 *    sibling host was away or starved — measured live at 503 after a 6.6 s wait
 *    on a loaded host, where the only way forward was a user-initiated reload —
 *    and, since #1654, on the 504 its upstream TIMEOUT answers with, which used
 *    to fall through to the pairing screen;
 *  - the identity read threw: offline, no route, a refused connection. Nothing
 *    answered, so nothing was decided about this browser;
 *  - this attempt's deadline expired (#1661), which is the same statement with a
 *    clock behind it — including a deadline that expired DURING the body, which
 *    the envelope check rethrows rather than reporting as a body that is not the
 *    envelope;
 *  - the launcher-token exchange itself could not reach a responder
 *    (`LocalUiHostUnreachableError`). This is the one route that reaches
 *    `host-unavailable` WITHOUT an identity read, and it is the case the readiness
 *    wait's enumeration has to know about — see below.
 *
 * Every other outcome is a decision ABOUT this browser, and none is retried:
 *
 *  - `access-required` from a non-OK answer is a refusal (401/403). Repeating it
 *    cannot change the answer and spends this browser's auth rate limit, which
 *    is the traffic this function's memoization exists to prevent.
 *  - `access-required` from a REFUSED launcher token, thrown as
 *    `LocalUiBootstrapRefusedError` and carrying its sentence to the pairing
 *    screen. A named class, not a message match: before #1654 this shared one
 *    `Error` — and one outcome — with a host that could not be reached, which is
 *    how being offline came to read as a browser without access.
 *  - `access-required` with the raw message for anything ELSE thrown here. That
 *    is a programming error, and it stays visible on screen rather than being
 *    absorbed into "the host is away", which would make it silent.
 *
 * Only the identity read is inside the ladder. There are TWO separate properties
 * about the launcher-token exchange here, they are held by different mechanisms,
 * and only one of them is observable — an earlier revision of this comment
 * conflated them and named the wrong guard, so both are spelled out:
 *
 * WITHIN one resolution, the exchange cannot run twice, and that holds because
 * `bootstrapLocalUiSession` is TERMINAL whenever a token exists: it returns true
 * or it throws, never false. So the identity read below is reachable only when
 * the capture DECLINED, which it does for exactly two reasons — and they are
 * different mechanisms, so enumerate rather than derive:
 *
 *   a. the page never carried a valid token, so the latch is off and nothing was
 *      stripped; or
 *   b. an earlier resolution already spent one, so the latch is precisely what
 *      declined and the fragment is already gone. This is the live case — it is
 *      what a pairing recheck does, and what the test named below drives.
 *
 *   c. NEW with #1654, and the reason this enumeration moved: the exchange itself
 *      could not reach a responder, so `host-unavailable` is reached with a token
 *      that WAS present and IS now consumed — no identity read involved. The
 *      recovery screen's reload is still safe, and the property that holds it is
 *      not the one (a) and (b) rely on: the fragment is stripped inside
 *      `captureLocalUiBootstrapToken`, BEFORE the exchange is attempted, so a
 *      failed exchange leaves the address bar already clean. The reload carries no
 *      token because capture stripped it, not because the exchange succeeded.
 *
 * Moving the exchange INSIDE the ladder therefore changes nothing in any of the
 * three: there is no token to re-POST, because there never was one (a), because it
 * is already spent (b), or because it was consumed on the attempt that failed (c).
 * This invariant has no observable mutation through the
 * gate — the capture reads only the URL fragment, is called from exactly one
 * production place (the exchange), and nothing writes the `station-ui-bootstrap`
 * key after boot (`src-ui/src/components/chat-dock/ChatDock.tsx` and
 * `src-ui/src/views/share/share-token.ts` do write a fragment, but their own
 * keys, and the capture reads its key by name). The readiness wait
 * (`tests/helpers/local-ui-access-readiness.ts`) reasons from this same terminal
 * property to conclude its reload is unreachable on a token-bearing entry, so it
 * is the second consumer of it; keep the two in step, enumeration included.
 *
 * ACROSS resolutions, a SPENT token must never be re-POSTed — a pairing recheck
 * resolves again on a page whose token is already gone. THAT is what the latch
 * and the fragment strip hold, and it is observable:
 * `LocalUiSessionGate.hostRetry.test.tsx` drives a spent token into an
 * unavailable host and pins one POST against a full ladder of identity reads,
 * red under a repeatable capture.
 */
export function resolveLocalUiSession(
  apiBase: string,
): Promise<LocalUiSessionResolution> {
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
    // The product cannot reach this today — the gate renders no pairing control
    // while a resolution is pending, so nothing can supersede one mid-ladder. It
    // is defence in depth plus test isolation, and that is its present value.
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
 * A completed pairing may have set the HttpOnly session cookie after the gate
 * cached an access-required result. Only that explicit success signal may
 * discard the cached result; ordinary failures remain deduplicated.
 */
export function recheckLocalUiSessionAfterPairing(
  apiBase: string,
): Promise<LocalUiSessionResolution> {
  sessionResolution = undefined;
  resolutionGeneration += 1;
  return resolveLocalUiSession(apiBase);
}

export function resetLocalUiBootstrapForTests(): void {
  captured = false;
  sessionResolution = undefined;
  resolutionGeneration += 1;
  setIdentityAttempt(1);
}
