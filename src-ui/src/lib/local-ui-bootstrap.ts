import { PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_PATH } from '@kontourai/station-contracts/environment-security';
import { LOCAL_UI_SESSION_HOST_RETRY_DELAYS_MS } from './local-ui-session-retry';
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

/** Exchange an explicit launcher capability exactly once before protected UI work begins. */
export async function bootstrapLocalUiSession(
  apiBase: string,
): Promise<boolean> {
  const token = captureLocalUiBootstrapToken();
  if (!token) return false;
  const response = await fetch(
    `${apiBase}${PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_PATH}`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Local UI bootstrap was refused (${response.status}). Open a fresh Station start link.`,
    );
  }
  return true;
}

async function readLocalUiIdentity(
  apiBase: string,
): Promise<LocalUiSessionResolution> {
  const response = await fetch(`${apiBase}/api/system/identity`, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  if (await isStationUiProxyUnavailableResponse(response)) {
    // The Station-owned UI proxy answered, but its sibling host could not.
    // That says nothing about whether this browser's existing HttpOnly
    // session is valid, so preserve the access context rather than
    // demoting the browser to first-run pairing.
    return { kind: 'host-unavailable' };
  }
  return response.ok ? { kind: 'authenticated' } : { kind: 'access-required' };
}

/**
 * Resolve the local browser's session once per page lifetime. React StrictMode
 * may mount a gate twice during Vite development, but a missing session must
 * not turn that into repeated protected requests or auth-rate-limit traffic.
 *
 * `host-unavailable` is the ONE outcome retried here (#1639), because it is the
 * one that can answer differently with nothing about this browser changed: the
 * UI proxy answered its documented readiness envelope, which says its sibling
 * host was away or starved — measured live at 503 after a 6.6 s wait on a loaded
 * host, where the only way forward was a user-initiated reload. Every other
 * outcome is a decision ABOUT this browser or this request:
 *
 *  - `access-required` from a non-OK answer is a refusal (401/403). Repeating it
 *    cannot change the answer and spends this browser's auth rate limit, which
 *    is the traffic this function's memoization exists to prevent.
 *  - `access-required` from a thrown fetch keeps the same single attempt. The
 *    throw is not one class: `bootstrapLocalUiSession` refusing a launcher token
 *    arrives here too, and that IS a refusal. It also lands on the pairing
 *    screen rather than the reload-only recovery screen, so the user is not
 *    stranded the way #1639 describes. Splitting a retryable transport failure
 *    out of that class is #1654.
 *
 * Only the identity read is inside the ladder. There are TWO separate properties
 * about the launcher-token exchange here, they are held by different mechanisms,
 * and only one of them is observable — an earlier revision of this comment
 * conflated them and named the wrong guard, so both are spelled out:
 *
 * WITHIN one resolution, the exchange cannot run twice, and that holds because
 * `bootstrapLocalUiSession` is TERMINAL whenever a token exists: it returns true
 * or it throws, never false. So the identity read below is reachable only when
 * the capture found no valid token — which also means the latch was never set
 * and the fragment was never stripped. Moving the exchange INSIDE the ladder
 * therefore changes nothing: a second iteration is reachable only on a page that
 * had no token to spend, and the re-entered capture reads the same empty
 * fragment. Neither the latch nor the strip is engaged on that path, and this
 * invariant has no observable mutation through the gate — the capture reads only
 * the URL fragment, is called from exactly one production place (the exchange),
 * and nothing writes the `station-ui-bootstrap` key after boot (`ChatDock.tsx`
 * and `views/share/share-token.ts` write a fragment, but their own keys, and the
 * capture reads its key by name). The readiness wait
 * (`tests/helpers/local-ui-access-readiness.ts`) reasons from this same terminal
 * property to conclude its reload is unreachable on a token-bearing entry, so it
 * is the second consumer of it; keep the two in step.
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
    // call time, not whatever is memoized now — so the early return below is a
    // contract, not a discard: answer the last real observation rather than climb
    // rungs whose result nobody can act on. What it protects is the attempt
    // counter, which is module-level and shared: the abandoned ladder's
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
        const resolution = await readLocalUiIdentity(apiBase);
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
