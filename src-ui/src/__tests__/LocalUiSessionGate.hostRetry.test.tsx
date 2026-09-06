/** @vitest-environment jsdom */

import { render, screen, waitFor } from '@testing-library/react';
import { type ReactNode, StrictMode, useEffect } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { LocalUiSessionGate } from '../components/LocalUiSessionGate';
import { ApiBaseProvider } from '../contexts/ApiBaseContext';
import { resetLocalUiBootstrapForTests } from '../lib/local-ui-bootstrap';
import {
  LOCAL_UI_SESSION_ATTEMPT_LIMIT,
  LOCAL_UI_SESSION_HOST_RETRY_TOTAL_DELAY_MS,
} from '../lib/local-ui-session-retry';
import { PlatformBootstrap } from '../platform/PlatformProfileContext';

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

function renderGate(children: ReactNode) {
  return render(
    <StrictMode>
      <PlatformBootstrap>
        <ApiBaseProvider>
          <LocalUiSessionGate apiBase="http://127.0.0.1:42693">
            {children}
          </LocalUiSessionGate>
        </ApiBaseProvider>
      </PlatformBootstrap>
    </StrictMode>,
  );
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

    await screen.findByRole('heading', {
      name: 'Connect to your Station host',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The discriminating wait: a ladder that retried every failure would have
    // spent its delays and its remaining attempts by now. A 401 is a decision
    // about this browser, and repeating it only spends its auth rate limit.
    await settleForLongerThanTheLadder();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/attempt/i)).toBeNull();
  });
});
