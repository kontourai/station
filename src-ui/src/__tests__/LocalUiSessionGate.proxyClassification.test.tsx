/** @vitest-environment jsdom */

import { PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_PATH } from '@kontourai/station-contracts/environment-security';
import { act, render, screen, waitFor } from '@testing-library/react';
import { type ReactNode, StrictMode, useEffect } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { LocalUiSessionGate } from '../components/LocalUiSessionGate';
import { ApiBaseProvider } from '../contexts/ApiBaseContext';
import { resetLocalUiBootstrapForTests } from '../lib/local-ui-bootstrap';
import {
  LOCAL_UI_SESSION_ATTEMPT_LIMIT,
  LOCAL_UI_SESSION_HOST_RETRY_DELAYS_MS,
  LOCAL_UI_SESSION_HOST_RETRY_TOTAL_DELAY_MS,
  LOCAL_UI_SESSION_IDENTITY_DEADLINES_MS,
} from '../lib/local-ui-session-retry';
import { PlatformBootstrap } from '../platform/PlatformProfileContext';

vi.mock('../components/GuidedConnect', () => ({
  GuidedConnect: () => (
    <button type="button" onClick={() => {}}>
      Complete pairing
    </button>
  ),
}));

/**
 * #1654 and #1661, through the gate.
 *
 * Two inputs to `resolveLocalUiSession` used to land on the pairing screen — the
 * screen that says this browser has no access and offers to pair it — when
 * neither was an answer about this browser at all: the UI proxy's own upstream
 * TIMEOUT answer (a 504 the envelope test declined), and a thrown fetch, which
 * shared one outcome with a REFUSED launcher token. A third input did not exist
 * yet: the gate had no deadline of its own, so one read could hold it for the
 * proxy's 30 s.
 *
 * Every test here drives the REAL gate against the REAL resolution and asserts on
 * the screen a user would be looking at, because that is where the defect lived.
 * A test on the derivation alone would have been green while the gate still asked
 * a slow host's browser to pair. The fetch fakes honour `signal` the way a real
 * `fetch` does, so the deadline under test is the production one.
 */

/** The exact bytes `proxyToBackend` writes, pinned in `lifecycle.test.ts`. */
const PROXY_UNAVAILABLE_BODY = { ready: false, status: 'unavailable' } as const;

/** The proxy's upstream-ERROR answer. */
function proxyUnavailable(): Response {
  return Response.json(PROXY_UNAVAILABLE_BODY, { status: 503 });
}

/** The proxy's upstream-TIMEOUT answer, which used to reach the pairing screen. */
function proxyUpstreamTimeout(): Response {
  return Response.json(PROXY_UNAVAILABLE_BODY, { status: 504 });
}

/** Some intermediary's 504: the same status, none of the evidence. */
function strangerGatewayTimeout(): Response {
  return new Response('Gateway Timeout', {
    status: 504,
    headers: { 'Content-Type': 'text/plain' },
  });
}

/**
 * JSON on one of the two statuses, carrying ONE of the envelope's two fields.
 *
 * Not hypothetical: a Station route answers `ready:false` with a DIFFERENT
 * `status` value, and this proxy relays an upstream response verbatim — so a body
 * agreeing on one field is a real shape this can meet. Both halves of the envelope
 * are load-bearing, and without a fixture like this, reducing the check to either
 * field alone leaves the whole suite green.
 */
function halfEnvelope(field: 'ready' | 'status'): Response {
  return Response.json(
    field === 'ready'
      ? { ready: false, status: 'starting' }
      : { ready: true, status: 'unavailable' },
    { status: 503 },
  );
}

/**
 * Headers that ARE the envelope, over a body that never completes.
 *
 * The body stream errors when the request signal aborts, which is what a real
 * `fetch` does: the deadline tears the body down, and `json()` rejects rather than
 * hanging. That is the property this fixture exists to model, and the reason it
 * carries the signal at all — a fabricated `Response` whose stream ignored the
 * signal would hang under a correct implementation too, and prove nothing.
 */
function envelopeWithBodyThatNeverCompletes(
  signal: AbortSignal | undefined,
): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener('abort', () => {
        controller.error(
          new DOMException('The operation was aborted.', 'AbortError'),
        );
      });
    },
  });
  return new Response(body, {
    status: 504,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Headers that ARE the envelope, over a body torn down mid-stream by the
 * responder — no client abort involved.
 *
 * This is the production tail of an unbounded body read: the UI proxy's own
 * inactivity timeout destroys the response it has already begun, and the browser
 * sees a body it cannot read to the end. It must not be reported as a body which
 * is not the envelope.
 */
function envelopeWithBodyTornDown(): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new TypeError('network error'));
    },
  });
  return new Response(body, {
    status: 503,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A fetch that never answers and rejects on abort, as a real fetch does. */
function neverAnswers(signal: AbortSignal | undefined): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener('abort', () => {
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    });
  });
}

function ProtectedDataProbe({ onMount }: { onMount: () => void }) {
  useEffect(onMount, [onMount]);
  return <div>Protected application mounted</div>;
}

const API_BASE = 'http://127.0.0.1:42694';
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

/** The pairing screen, by the control the access-required branch mounts. */
function pairingOffered(): boolean {
  return screen.queryByRole('button', { name: 'Complete pairing' }) !== null;
}

afterEach(() => {
  resetLocalUiBootstrapForTests();
  window.history.replaceState(null, '', '/');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the UI proxy’s timeout answer is the host being away (#1654)', () => {
  test('a proxy upstream timeout is retried, and never asks this browser to pair', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(proxyUpstreamTimeout()));
    const protectedMount = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    renderGate(<ProtectedDataProbe onMount={protectedMount} />);

    // The screen this issue is about: before the fix, a 504 fell through to
    // `access-required` and this browser was offered pairing on attempt one.
    await screen.findByRole(
      'heading',
      { name: 'Reconnecting to this Station' },
      { timeout: PAST_THE_LADDER_MS },
    );
    expect(pairingOffered()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(LOCAL_UI_SESSION_ATTEMPT_LIMIT);
    expect(protectedMount).not.toHaveBeenCalled();
  });

  test('a host that recovers after a proxy timeout mounts the protected tree with no reload', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => Promise.resolve(proxyUpstreamTimeout()))
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
    expect(pairingOffered()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('a 504 WITHOUT the proxy’s envelope is still an unknown responder, and still asks this browser to pair', async () => {
    // The other direction of the same strictness, and the reason widening the
    // status test alone would have been the wrong fix: an intermediary's bare 504
    // carries no evidence about this Station's host, so it must keep reading as a
    // response this browser cannot interpret — one attempt, and the pairing
    // screen. This is what fails if the derivation ever keys on the status alone.
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(strangerGatewayTimeout()));
    vi.stubGlobal('fetch', fetchMock);

    renderGate(<div>Protected application mounted</div>);

    await screen.findByRole('button', { name: 'Complete pairing' });
    expect(
      screen.queryByRole('heading', { name: 'Reconnecting to this Station' }),
    ).toBeNull();

    await settleForLongerThanTheLadder();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['only the ready field', 'ready' as const],
    ['only the status field', 'status' as const],
  ])(
    'a body carrying %s is not this proxy’s envelope, and still asks this browser to pair',
    async (_label, field) => {
      // Both halves are load-bearing, and each needs its own case: with only a
      // full-envelope fixture and a non-JSON one, reducing the check to either
      // field alone leaves every screen assertion in this file green.
      const fetchMock = vi
        .fn()
        .mockImplementation(() => Promise.resolve(halfEnvelope(field)));
      vi.stubGlobal('fetch', fetchMock);

      renderGate(<div>Protected application mounted</div>);

      await screen.findByRole('button', { name: 'Complete pairing' });
      expect(
        screen.queryByRole('heading', { name: 'Reconnecting to this Station' }),
      ).toBeNull();
      await settleForLongerThanTheLadder();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  test('a response torn down mid-body is the host being away, not a browser without access', async () => {
    // The production tail of an unbounded body read, and the door station#1654's
    // fix has to close from the inside as well: the responder destroys a body it
    // had begun, so the envelope cannot be read. Reporting that as "not the
    // envelope" put a non-OK status on the pairing screen — the same
    // misclassification, reached through the body instead of the status.
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(envelopeWithBodyTornDown()));
    vi.stubGlobal('fetch', fetchMock);

    renderGate(<div>Protected application mounted</div>);

    await screen.findByRole(
      'heading',
      { name: 'Reconnecting to this Station' },
      { timeout: PAST_THE_LADDER_MS },
    );
    expect(pairingOffered()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(LOCAL_UI_SESSION_ATTEMPT_LIMIT);
  });
});

describe('the gate’s own per-attempt deadline (#1661)', () => {
  test('the deadline covers the BODY, not only the headers', async () => {
    // The defect this pins: with the timer cleared the moment `fetch` resolved,
    // headers that arrive as the envelope over a body that never completes left
    // the read unbounded — the gate never settled and never climbed a rung, for
    // as long as the body stayed open. The deadline has to cover the
    // classification, not the handshake.
    vi.useFakeTimers();
    try {
      const fetchMock = vi
        .fn()
        .mockImplementationOnce((_url: string, init?: RequestInit) =>
          Promise.resolve(
            envelopeWithBodyThatNeverCompletes(init?.signal ?? undefined),
          ),
        )
        .mockImplementation(() =>
          Promise.resolve(new Response('{}', { status: 200 })),
        );
      const protectedMount = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      renderGate(<ProtectedDataProbe onMount={protectedMount} />);

      // Headers have landed and the body is still open: nothing decided, and the
      // rung has not been given up on.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(
          LOCAL_UI_SESSION_IDENTITY_DEADLINES_MS[0] - 1,
        );
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(pairingOffered()).toBe(false);

      // Crossing the deadline abandons the body read and climbs the rung, which
      // is what an unbounded body read could never do.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(
          1 + LOCAL_UI_SESSION_HOST_RETRY_DELAYS_MS[0],
        );
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(protectedMount).toHaveBeenCalled();
      expect(pairingOffered()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a read that outlives its deadline is retried, and a later attempt gets this browser in', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi
        .fn()
        .mockImplementationOnce((_url: string, init?: RequestInit) =>
          neverAnswers(init?.signal ?? undefined),
        )
        .mockImplementation(() =>
          Promise.resolve(new Response('{}', { status: 200 })),
        );
      const protectedMount = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      renderGate(<ProtectedDataProbe onMount={protectedMount} />);

      // One millisecond short of the deadline the first attempt was given: the
      // read is still out, and nothing has been decided.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(
          LOCAL_UI_SESSION_IDENTITY_DEADLINES_MS[0] - 1,
        );
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(protectedMount).not.toHaveBeenCalled();
      expect(pairingOffered()).toBe(false);

      // Past it: the gate stops waiting, treats the silence as the host being
      // away, and climbs a rung — it does NOT report a browser without access.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(
          1 + LOCAL_UI_SESSION_HOST_RETRY_DELAYS_MS[0],
        );
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(protectedMount).toHaveBeenCalled();
      expect(pairingOffered()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a host that never answers spends the whole schedule and then reports itself away', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi
        .fn()
        .mockImplementation((_url: string, init?: RequestInit) =>
          neverAnswers(init?.signal ?? undefined),
        );
      vi.stubGlobal('fetch', fetchMock);

      renderGate(<div>Protected application mounted</div>);
      // The gate's effect and the resolution's first await, before any clock moves.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      // Each rung is crossed at ITS OWN deadline, one millisecond at a time, and
      // that is what pins the ESCALATION through the gate. Advancing by the whole
      // rung and only counting requests does NOT: a schedule collapsed to one
      // value, or a call site that asks for the wrong attempt's deadline, still
      // reaches the same count by the end (proven — that injection passed a
      // version of this test that only counted). What discriminates is that
      // NOTHING has been abandoned one tick before the deadline the schedule
      // declares for this rung: the last rung's 16 s is observable only as the
      // absence of a settled screen at 10 s.
      for (
        let attempt = 0;
        attempt < LOCAL_UI_SESSION_ATTEMPT_LIMIT;
        attempt += 1
      ) {
        const deadline = LOCAL_UI_SESSION_IDENTITY_DEADLINES_MS[attempt];
        const lastRung = attempt === LOCAL_UI_SESSION_ATTEMPT_LIMIT - 1;
        expect(fetchMock).toHaveBeenCalledTimes(attempt + 1);

        await act(async () => {
          await vi.advanceTimersByTimeAsync(deadline - 1);
        });
        expect(fetchMock).toHaveBeenCalledTimes(attempt + 1);
        expect(
          screen.queryByRole('heading', {
            name: 'Reconnecting to this Station',
          }),
        ).toBeNull();

        // Crossing it abandons the read.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1);
        });
        if (lastRung) break;
        // The next attempt is not spent until its backoff elapses.
        expect(fetchMock).toHaveBeenCalledTimes(attempt + 1);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(
            LOCAL_UI_SESSION_HOST_RETRY_DELAYS_MS[attempt],
          );
        });
      }
      expect(fetchMock).toHaveBeenCalledTimes(LOCAL_UI_SESSION_ATTEMPT_LIMIT);
      expect(
        screen.getByRole('heading', { name: 'Reconnecting to this Station' }),
      ).toBeTruthy();
      expect(pairingOffered()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a refusal and an unreachable host are different answers (#1654)', () => {
  test('a refused identity read reaches pairing and is requested exactly once', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response('{}', { status: 401 })),
      );
    vi.stubGlobal('fetch', fetchMock);

    renderGate(<div>Protected application mounted</div>);

    await screen.findByRole('button', { name: 'Complete pairing' });
    // The COUNT is the property, not the screen: a refusal that were retried
    // would still land here, having spent this browser's auth rate limit on
    // answers that cannot change. Waited past the whole ladder first, so a
    // second request has had its chance to be made.
    await settleForLongerThanTheLadder();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestedUrls(fetchMock)).toEqual([IDENTITY_URL]);
  });

  test('a refused launcher token reaches pairing with its own sentence, and is exchanged exactly once', async () => {
    window.location.hash = `#station-ui-bootstrap=${'b'.repeat(43)}`;
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response('{}', { status: 403 })),
      );
    vi.stubGlobal('fetch', fetchMock);

    renderGate(<div>Protected application mounted</div>);

    await screen.findByRole('button', { name: 'Complete pairing' });
    expect(screen.getByRole('alert').textContent).toContain(
      'Local UI bootstrap was refused (403)',
    );
    // Never retried, and never followed by an identity read on this resolution:
    // the refusal is terminal. The count is the assertion.
    await settleForLongerThanTheLadder();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestedUrls(fetchMock)).toEqual([UI_BOOTSTRAP_URL]);
  });

  test('a transport failure on the identity read is the host being away, not a browser without access', async () => {
    // Offline, no route, connection refused. Before the fix this shared one
    // outcome AND one message with the refusal above, so being offline rendered
    // "Failed to fetch" over an offer to pair.
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.reject(new TypeError('Failed to fetch')),
      );
    vi.stubGlobal('fetch', fetchMock);

    renderGate(<div>Protected application mounted</div>);

    await screen.findByRole(
      'heading',
      { name: 'Reconnecting to this Station' },
      { timeout: PAST_THE_LADDER_MS },
    );
    expect(pairingOffered()).toBe(false);
    // Retried, unlike the refusal: the same request can answer differently once
    // the network is back.
    expect(fetchMock).toHaveBeenCalledTimes(LOCAL_UI_SESSION_ATTEMPT_LIMIT);
  });

  test('a transport failure on the launcher-token exchange is the host being away, and is not retried', async () => {
    window.location.hash = `#station-ui-bootstrap=${'c'.repeat(43)}`;
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.reject(new TypeError('Failed to fetch')),
      );
    vi.stubGlobal('fetch', fetchMock);

    renderGate(<div>Protected application mounted</div>);

    await screen.findByRole(
      'heading',
      { name: 'Reconnecting to this Station' },
      { timeout: PAST_THE_LADDER_MS },
    );
    expect(pairingOffered()).toBe(false);
    // One POST and no identity read: the token was captured and stripped on the
    // way out, so nothing here can re-present it and the ladder cannot help. The
    // reload the recovery screen offers is what tries again.
    await settleForLongerThanTheLadder();
    expect(requestedUrls(fetchMock)).toEqual([UI_BOOTSTRAP_URL]);
  });

  test('a genuine refusal still reaches pairing when the host answered slowly first', async () => {
    // The composition the two fixes create together, and the one a reader is most
    // likely to fear: a host that times out and THEN refuses must still end at the
    // pairing screen. A ladder that had absorbed the refusal into the timeout
    // class would strand this browser on the recovery screen instead.
    vi.useFakeTimers();
    try {
      const fetchMock = vi
        .fn()
        .mockImplementationOnce((_url: string, init?: RequestInit) =>
          neverAnswers(init?.signal ?? undefined),
        )
        .mockImplementation(() =>
          Promise.resolve(new Response('{}', { status: 401 })),
        );
      vi.stubGlobal('fetch', fetchMock);

      renderGate(<div>Protected application mounted</div>);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(
          LOCAL_UI_SESSION_IDENTITY_DEADLINES_MS[0] +
            LOCAL_UI_SESSION_HOST_RETRY_DELAYS_MS[0],
        );
      });
      expect(pairingOffered()).toBe(true);
      expect(
        screen.queryByRole('heading', { name: 'Reconnecting to this Station' }),
      ).toBeNull();

      // And the refusal ends it: the remaining rung is not spent.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(
          LOCAL_UI_SESSION_IDENTITY_DEADLINES_MS[1] +
            LOCAL_UI_SESSION_HOST_RETRY_DELAYS_MS[1],
        );
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the proxy’s unavailable envelope still reads as before', () => {
  test('a 503 envelope is retried exactly as it was, so the #1654 change did not move it', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(proxyUnavailable()));
    vi.stubGlobal('fetch', fetchMock);

    renderGate(<div>Protected application mounted</div>);

    await screen.findByRole(
      'heading',
      { name: 'Reconnecting to this Station' },
      { timeout: PAST_THE_LADDER_MS },
    );
    expect(fetchMock).toHaveBeenCalledTimes(LOCAL_UI_SESSION_ATTEMPT_LIMIT);
    expect(pairingOffered()).toBe(false);
  });
});
