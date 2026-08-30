/** @vitest-environment jsdom */

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
import { resetLocalUiBootstrapForTests } from '../lib/local-ui-bootstrap';
import { PlatformBootstrap } from '../platform/PlatformProfileContext';

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

afterEach(() => {
  resetLocalUiBootstrapForTests();
  window.history.replaceState(null, '', '/');
  vi.restoreAllMocks();
});

describe('LocalUiSessionGate (station#2093)', () => {
  test('keeps protected providers unmounted after one missing-session probe and exposes only pairing/access actions', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('{}', { status: 401 }));
    const protectedMount = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    renderGate(<ProtectedDataProbe onMount={protectedMount} />);

    await screen.findByRole('heading', {
      name: 'Connect to your Station host',
    });
    expect(
      screen.getByRole('button', { name: 'Pair with a code' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Request access' })).toBeTruthy();
    expect(protectedMount).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:42693/api/system/identity',
      {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      },
    );
  });

  test('mounts protected providers after the launcher capability creates the session', async () => {
    const token = 'a'.repeat(43);
    window.location.hash = `#station-ui-bootstrap=${token}`;
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const protectedMount = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    renderGate(<ProtectedDataProbe onMount={protectedMount} />);

    await waitFor(() => expect(protectedMount).toHaveBeenCalled());
    expect(window.location.hash).toBe('');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'http://127.0.0.1:42693/.well-known/station/v1/pairing/ui-bootstrap',
    );
  });

  test('preserves the browser access context while the Station UI proxy reports its host unavailable', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json({ ready: false, status: 'unavailable' }, { status: 503 }),
      );
    const protectedMount = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    renderGate(<ProtectedDataProbe onMount={protectedMount} />);

    await screen.findByRole('heading', {
      name: 'Reconnecting to this Station',
    });
    expect(screen.getByRole('alert').textContent).toMatch(
      /host process is down or recovering/i,
    );
    expect(screen.queryByText('Connect to your Station host')).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Pair with a code' }),
    ).toBeNull();
    expect(protectedMount).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['Pair with a code', /pair.*code/i],
    ['Request access', /request.*access/i],
    ['Enter a host address', /add station/i],
  ])(
    'opens the usable %s recovery flow without mounting protected data',
    async (label, dialogCopy) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response('{}', { status: 401 }));
      const protectedMount = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      renderGate(<ProtectedDataProbe onMount={protectedMount} />);
      await screen.findByRole('button', { name: label });
      fireEvent.click(screen.getByRole('button', { name: label }));

      expect((await screen.findByRole('dialog')).textContent).toMatch(
        dialogCopy,
      );
      expect(protectedMount).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );
});

/**
 * The review's direct check on the pre-auth gate found the source correct and
 * the TIMEOUT PATH untested — which is the only path with no server answer to
 * pin it. A bootstrap request that never settles used to leave "Checking this
 * browser's Station access…" on screen forever with nothing to press; past the
 * shared 8 s degraded window it must say so and offer a reload.
 */
describe('LocalUiSessionGate degraded access check', () => {
  test('replaces the forever-wait with an honest degraded message and a reload', async () => {
    vi.useFakeTimers();
    try {
      // A request that never settles: the exact shape the bound exists for.
      vi.stubGlobal(
        'fetch',
        vi.fn().mockReturnValue(new Promise<Response>(() => {})),
      );
      const reload = vi.fn();
      vi.stubGlobal('location', { ...window.location, reload });

      renderGate(<div>Protected application mounted</div>);

      expect(
        screen.getByText("Checking this browser's Station access…"),
      ).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();

      // Just short of the window: still an honest wait, not yet a claim.
      await act(async () => {
        vi.advanceTimersByTime(DEGRADED_QUERY_TIMEOUT_MS - 1);
      });
      expect(
        screen.getByText("Checking this browser's Station access…"),
      ).toBeTruthy();

      await act(async () => {
        vi.advanceTimersByTime(1);
      });

      expect(
        screen.queryByText("Checking this browser's Station access…"),
      ).toBeNull();
      const alert = screen.getByRole('alert');
      expect(alert.textContent).toContain('taking longer than expected');
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
