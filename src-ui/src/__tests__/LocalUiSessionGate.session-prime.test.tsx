/** @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { LocalUiSessionGate } from '../components/LocalUiSessionGate';
import { ApiBaseProvider } from '../contexts/ApiBaseContext';
import { resetLocalUiBootstrapForTests } from '../lib/local-ui-bootstrap';
import { PlatformBootstrap } from '../platform/PlatformProfileContext';

const primeNativeNotificationsMock = vi.hoisted(() => vi.fn());
vi.mock('../platform/native/notify', () => ({
  primeNativeNotifications: (...args: unknown[]) =>
    primeNativeNotificationsMock(...args),
}));

// Drive the gate's session-established callback without running the real
// pairing ceremony: what this test owns is what the gate does AFTER the
// session exists, not the modal that creates it. Kept in its own file so the
// mock cannot disturb the suites that assert on the real GuidedConnect copy.
vi.mock('../components/GuidedConnect', () => ({
  GuidedConnect: ({
    onSessionEstablished,
  }: {
    onSessionEstablished?: () => void;
  }) => (
    <button type="button" onClick={() => onSessionEstablished?.()}>
      establish session
    </button>
  ),
}));

afterEach(() => {
  resetLocalUiBootstrapForTests();
  window.history.replaceState(null, '', '/');
  primeNativeNotificationsMock.mockReset();
  vi.restoreAllMocks();
});

describe('LocalUiSessionGate notification priming', () => {
  test('primes native notifications when the browser session is established', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{}', { status: 401 })),
    );

    render(
      <PlatformBootstrap>
        <ApiBaseProvider>
          <LocalUiSessionGate apiBase="http://127.0.0.1:42693">
            <div>Protected application</div>
          </LocalUiSessionGate>
        </ApiBaseProvider>
      </PlatformBootstrap>,
    );

    // 401 with no session: the gate renders the access screen.
    fireEvent.click(
      await screen.findByRole('button', { name: 'establish session' }),
    );

    // The boot-time prime skips fresh devices, so this callback is the
    // moment the permission dialog is primed behind a completed connection.
    await waitFor(() =>
      expect(primeNativeNotificationsMock).toHaveBeenCalledOnce(),
    );
  });
});
