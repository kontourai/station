/** @vitest-environment jsdom */

import { PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_PATH } from '@kontourai/station-contracts/environment-security';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { type ReactNode, StrictMode, useEffect } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { LocalUiSessionGate } from '../components/LocalUiSessionGate';
import { ApiBaseProvider } from '../contexts/ApiBaseContext';
import { DEGRADED_QUERY_TIMEOUT_MS } from '../hooks/useDegradedQueryState';
import {
  recheckLocalUiSessionAfterPairing,
  resetLocalUiBootstrapForTests,
} from '../lib/local-ui-bootstrap';
import {
  LOCAL_UI_SESSION_ATTEMPT_LIMIT,
  LOCAL_UI_SESSION_HOST_RETRY_DELAYS_MS,
  LOCAL_UI_SESSION_HOST_RETRY_TOTAL_DELAY_MS,
} from '../lib/local-ui-session-retry';
import { PlatformBootstrap } from '../platform/PlatformProfileContext';

vi.mock('../components/GuidedConnect', () => ({
  GuidedConnect: ({
    onSessionEstablished,
  }: {
    onSessionEstablished?: () => void;
  }) => (
    <button type="button" onClick={onSessionEstablished}>
      Complete pairing
    </button>
  ),
}));

/**
 * #1639: one failed identity read used to strand the page. The gate rendered
 * "Reconnecting to this Station" — whose only way forward is a user-initiated
 * reload — off a single 503 `{"ready":false,"status":"unavailable"}` from the
 * Station-owned UI proxy, measured live after a 6.6 s wait on a loaded host.
 *
 * These tests drive the REAL gate against the REAL resolution, so each one
 * exercises the ladder inside `resolveLocalUiSession` through the screens a user
 * sees. They deliberately do not import the resolver's loop directly: the defect
 * was a user stranded on a screen, and a helper asserting a return value could
 * be green while the gate still rendered the recovery screen first.
 *
 * The backoff runs on real timers. `LOCAL_UI_SESSION_HOST_RETRY_TOTAL_DELAY_MS`
 * is the whole ladder's deliberate waiting and is small by design; the waits
 * below budget past it rather than mock time, so the delays these tests observe
 * are the ones a browser observes.
 */

const UNAVAILABLE_BODY = { ready: false, status: 'unavailable' } as const;

/** A fresh Response per call, as a real fetch gives. */
function unavailable(): Response {
  return Response.json(UNAVAILABLE_BODY, { status: 503 });
}

function ProtectedDataProbe({ onMount }: { onMount: () => void }) {
  useEffect(onMount, [onMount]);
  return <div>Protected application mounted</div>;
}

const API_BASE = 'http://127.0.0.1:42693';
const UI_BOOTSTRAP_URL = `${API_BASE}${PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_PATH}`;
const IDENTITY_URL = `${API_BASE}/api/system/identity`;

function renderGate(children: ReactNode) {
  return render(
    <StrictMode>
      <PlatformBootstrap>
        <ApiBaseProvider>
          <LocalUiSessionGate apiBase={API_BASE}>{children}</LocalUiSessionGate>
        </ApiBaseProvider>
      </PlatformBootstrap>
    </StrictMode>,
  );
}

function requestedUrls(fetchMock: { mock: { calls: unknown[][] } }): string[] {
  return fetchMock.mock.calls.map(([url]) => String(url));
}

/** Long enough for the whole ladder plus scheduling, and no longer. */
const PAST_THE_LADDER_MS = LOCAL_UI_SESSION_HOST_RETRY_TOTAL_DELAY_MS + 750;

function settleForLongerThanTheLadder(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, PAST_THE_LADDER_MS);
  });
}

afterEach(() => {
  resetLocalUiBootstrapForTests();
  window.history.replaceState(null, '', '/');
  vi.restoreAllMocks();
  // `restoreAllMocks` does not undo `stubGlobal`, so without this the `location`
  // snapshot one test installs stays frozen for every later test in the file —
  // which would silently make the `replaceState` above invisible, and a test that
  // sets a `#station-ui-bootstrap` fragment read no token at all.
  vi.unstubAllGlobals();
});

describe('LocalUiSessionGate bounded host retry (#1639)', () => {
  test('a host that answers on the second attempt mounts the protected tree with no reload', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => Promise.resolve(unavailable()))
      .mockImplementation(() =>
        Promise.resolve(new Response('{}', { status: 200 })),
      );
    const protectedMount = vi.fn();
    const reload = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('location', { ...window.location, reload });

    renderGate(<ProtectedDataProbe onMount={protectedMount} />);

    await waitFor(() => expect(protectedMount).toHaveBeenCalled(), {
      timeout: PAST_THE_LADDER_MS,
    });
    // The screen the issue is about was never rendered, and nothing reloaded:
    // the second attempt is what got this browser in.
    expect(
      screen.queryByRole('heading', { name: 'Reconnecting to this Station' }),
    ).toBeNull();
    expect(reload).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('the retry in flight is on screen, and leaves with the wait it belonged to', async () => {
    // Hold attempt 2 open, so the pending output has to keep naming it rather
    // than flash it, then release it from the test — which also keeps the ladder
    // from outliving this test and calling the next one's fetch.
    let releaseSecondAttempt: (response: Response) => void = () => {};
    const secondAttempt = new Promise<Response>((resolve) => {
      releaseSecondAttempt = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => Promise.resolve(unavailable()))
      .mockImplementationOnce(() => secondAttempt);
    vi.stubGlobal('fetch', fetchMock);

    renderGate(<div>Protected application mounted</div>);

    // Before the first answer the wait reads exactly as it always did.
    expect(
      screen.getByText("Checking this browser's Station access…"),
    ).toBeTruthy();
    expect(screen.queryByText(/attempt/i)).toBeNull();

    expect(
      await screen.findByText(
        new RegExp(`attempt 2 of ${LOCAL_UI_SESSION_ATTEMPT_LIMIT}`, 'i'),
        undefined,
        { timeout: PAST_THE_LADDER_MS },
      ),
    ).toBeTruthy();
    // Still the gate's own pending screen, not a settled one.
    expect(
      screen.getByText("Checking this browser's Station access…"),
    ).toBeTruthy();
    expect(
      screen.queryByRole('heading', { name: 'Reconnecting to this Station' }),
    ).toBeNull();

    releaseSecondAttempt(new Response('{}', { status: 200 }));

    // The attempt sentence belongs to the wait, not to the page: it goes when
    // the wait it was explaining does.
    await screen.findByText('Protected application mounted');
    expect(screen.queryByText(/attempt/i)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('a host that stays away spends exactly the bound, then renders recovery', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(unavailable()));
    const protectedMount = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    renderGate(<ProtectedDataProbe onMount={protectedMount} />);

    await screen.findByRole(
      'heading',
      { name: 'Reconnecting to this Station' },
      { timeout: PAST_THE_LADDER_MS },
    );
    expect(fetchMock).toHaveBeenCalledTimes(LOCAL_UI_SESSION_ATTEMPT_LIMIT);

    // The bound holds after the screen renders too: the ladder is spent, not
    // merely mid-backoff. Without this, a loop that kept retrying forever would
    // still pass the count above.
    await settleForLongerThanTheLadder();
    expect(fetchMock).toHaveBeenCalledTimes(LOCAL_UI_SESSION_ATTEMPT_LIMIT);
    expect(protectedMount).not.toHaveBeenCalled();
  });

  test('a refusal is not retried, and its screen says nothing about attempts', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response('{}', { status: 401 })),
      );
    vi.stubGlobal('fetch', fetchMock);

    renderGate(<div>Protected application mounted</div>);

    // The access-required screen. Its real pairing copy is pinned by
    // `LocalUiSessionGate.test.tsx`; `GuidedConnect` is stubbed here so a test
    // below can take the pairing-success path the real component cannot reach.
    await screen.findByRole('button', { name: 'Complete pairing' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The discriminating wait: a ladder that retried every failure would have
    // spent its delays and its remaining attempts by now. A 401 is a decision
    // about this browser, and repeating it only spends its auth rate limit.
    await settleForLongerThanTheLadder();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/attempt/i)).toBeNull();
  });

  test('the degraded window explains the wait and names the retry running under it', async () => {
    // The one pending treatment no other test in this file reaches: every other
    // resolution here settles inside ~1.75 s and the degraded window is 8 s, so
    // deleting the attempt sentence from THIS branch failed nothing.
    vi.useFakeTimers();
    try {
      const fetchMock = vi
        .fn()
        .mockImplementationOnce(() => Promise.resolve(unavailable()))
        // Attempt 2 never answers, so the ladder is still mid-flight when the
        // degraded window opens — the state a stranded user actually reads.
        .mockImplementation(() => new Promise<Response>(() => {}));
      const reload = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      vi.stubGlobal('location', { ...window.location, reload });

      renderGate(<div>Protected application mounted</div>);

      // Let attempt 1's answer land and the backoff be scheduled.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(
        screen.getByText(
          new RegExp(`attempt 2 of ${LOCAL_UI_SESSION_ATTEMPT_LIMIT}`, 'i'),
        ),
      ).toBeTruthy();
      // Still inside the loading window: no claim that anything is wrong yet.
      expect(screen.queryByRole('alert')).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(
          LOCAL_UI_SESSION_HOST_RETRY_DELAYS_MS[0],
        );
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(DEGRADED_QUERY_TIMEOUT_MS);
      });

      // Both sentences, together: the wait is over its window AND the page says
      // which attempt is still out. Neither replaces the other.
      expect(screen.getByRole('alert').textContent).toContain(
        'taking longer than expected',
      );
      expect(
        screen.getByText(
          new RegExp(`attempt 2 of ${LOCAL_UI_SESSION_ATTEMPT_LIMIT}`, 'i'),
        ),
      ).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(reload).toHaveBeenCalledTimes(1);
      // The bound is not spent by the degraded timer: attempt 2 is still the one
      // in flight, and no third request was made on its behalf.
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a resolution after a spent launcher token retries the host without re-posting the exchange', async () => {
    // The reachable end of the constraint the ladder is built around: the
    // launcher-token exchange is one-shot per page, so a resolution that runs
    // AFTER a token was spent must read identity and retry that — never re-POST
    // a token this page has already used.
    window.location.hash = `#station-ui-bootstrap=${'a'.repeat(43)}`;
    const fetchMock = vi.fn().mockImplementation((url: string) =>
      String(url) === UI_BOOTSTRAP_URL
        ? // The exchange is refused, which spends the token and strips the
          // fragment on the way to the access screen.
          Promise.resolve(new Response('{}', { status: 401 }))
        : Promise.resolve(unavailable()),
    );
    vi.stubGlobal('fetch', fetchMock);

    renderGate(<div>Protected application mounted</div>);

    const pair = await screen.findByRole('button', {
      name: 'Complete pairing',
    });
    expect(requestedUrls(fetchMock)).toEqual([UI_BOOTSTRAP_URL]);

    // Pairing succeeds, so the gate discards the cached refusal and resolves
    // again — this time reaching the identity read, with the token already gone.
    fireEvent.click(pair);

    // The load-bearing wait, and deliberately asserted before the fragment
    // below: a resolution that re-POSTed the spent token would be refused again
    // and land back on the access screen, so THIS is what reds when the exchange
    // stops being one-shot — naming the behaviour rather than a stale URL.
    await screen.findByRole(
      'heading',
      { name: 'Reconnecting to this Station' },
      { timeout: PAST_THE_LADDER_MS },
    );
    expect(requestedUrls(fetchMock)).toEqual([
      UI_BOOTSTRAP_URL,
      ...Array.from(
        { length: LOCAL_UI_SESSION_ATTEMPT_LIMIT },
        () => IDENTITY_URL,
      ),
    ]);
    // The other half of one-shot: the fragment left the address bar when the
    // token was spent. Last, so it cannot pre-empt the wait above.
    expect(window.location.hash).toBe('');
  });

  test('a resolution superseded mid-backoff abandons its remaining attempts', async () => {
    // Not reachable through the UI — the gate offers no pairing control while a
    // resolution is pending — so this drives `recheckLocalUiSessionAfterPairing`
    // directly, the same seam the gate calls on pairing success. Without the
    // generation guard the abandoned ladder keeps fetching and keeps writing the
    // module-level attempt counter the live ladder is being read from.
    //
    // The hold is a FLAG, not a call index: `mockImplementationOnce` would have
    // handed the superseding ladder's first request the held answer meant for the
    // superseded one, and hung the test rather than testing anything.
    let holdRequests = true;
    const heldAttempts: Array<(response: Response) => void> = [];
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => Promise.resolve(unavailable()))
      .mockImplementation(() =>
        holdRequests
          ? new Promise<Response>((resolve) => {
              heldAttempts.push(resolve);
            })
          : Promise.resolve(unavailable()),
      );
    vi.stubGlobal('fetch', fetchMock);

    renderGate(<div>Protected application mounted</div>);
    await screen.findByText(
      new RegExp(`attempt 2 of ${LOCAL_UI_SESSION_ATTEMPT_LIMIT}`, 'i'),
      undefined,
      { timeout: PAST_THE_LADDER_MS },
    );
    // Attempt 2 is in flight and held: this ladder is now mid-ladder, which is
    // the only state in which being superseded costs anything.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), {
      timeout: PAST_THE_LADDER_MS,
    });
    expect(heldAttempts).toHaveLength(1);
    holdRequests = false;

    await expect(recheckLocalUiSessionAfterPairing(API_BASE)).resolves.toEqual({
      kind: 'host-unavailable',
    });
    // Two from the superseded ladder, a full ladder from the superseding one.
    const spent = 2 + LOCAL_UI_SESSION_ATTEMPT_LIMIT;
    expect(spent).toBe(5);
    expect(fetchMock).toHaveBeenCalledTimes(spent);

    // The superseded ladder finally gets its answer. It must read it and stop,
    // not climb the two rungs it still has.
    heldAttempts[0]?.(unavailable());
    await settleForLongerThanTheLadder();
    expect(fetchMock).toHaveBeenCalledTimes(spent);
  });
});
