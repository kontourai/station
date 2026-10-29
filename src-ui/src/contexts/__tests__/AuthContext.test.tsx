/**
 * @vitest-environment jsdom
 */

import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

let activeConnection: {
  id: string;
  credentialState: 'required' | 'saved';
  lastSuccessAt?: number;
} | null;
const refreshAuthStatus = vi.fn();

vi.mock('@kontourai/station-connect', () => ({
  useConnections: () => ({ activeConnection }),
}));

vi.mock('@kontourai/station-sdk', () => ({
  useAuthStatusQuery: () => ({
    data: undefined,
    error: null,
    refetch: refreshAuthStatus,
  }),
  useRenewAuthMutation: () => ({ mutateAsync: vi.fn() }),
}));

import { AuthProvider, useAuth } from '../AuthContext';

function AuthStatusProbe() {
  const { status } = useAuth();
  return <div>{status}</div>;
}

describe('AuthProvider', () => {
  beforeEach(() => {
    activeConnection = {
      id: 'remote-station',
      credentialState: 'required',
    };
    refreshAuthStatus.mockReset();
    refreshAuthStatus.mockResolvedValue({
      data: {
        status: 'valid',
        provider: 'fixture',
        expiresAt: null,
        user: null,
      },
    });
  });

  test('refreshes auth status immediately when pairing records credential evidence', async () => {
    const { rerender } = render(
      <AuthProvider>
        <AuthStatusProbe />
      </AuthProvider>,
    );

    await waitFor(() => expect(refreshAuthStatus).toHaveBeenCalledTimes(1));
    expect(screen.getByText('valid')).toBeTruthy();
    refreshAuthStatus.mockClear();

    activeConnection = {
      ...activeConnection!,
      credentialState: 'saved',
      lastSuccessAt: Date.now(),
    };
    rerender(
      <AuthProvider>
        <AuthStatusProbe />
      </AuthProvider>,
    );

    await waitFor(() => expect(refreshAuthStatus).toHaveBeenCalledTimes(1));
  });

  test('skips the minute status check while hidden and checks once when shown', async () => {
    vi.useFakeTimers();
    let hidden = false;
    const hiddenProperty = vi
      .spyOn(document, 'hidden', 'get')
      .mockImplementation(() => hidden);
    try {
      render(
        <AuthProvider>
          <AuthStatusProbe />
        </AuthProvider>,
      );
      await act(async () => {});
      const initial = refreshAuthStatus.mock.calls.length;
      expect(initial).toBeGreaterThan(0);

      hidden = true;
      act(() => document.dispatchEvent(new Event('visibilitychange')));
      await act(async () => {
        vi.advanceTimersByTime(3 * 60_000);
      });
      expect(refreshAuthStatus).toHaveBeenCalledTimes(initial);

      hidden = false;
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      expect(refreshAuthStatus).toHaveBeenCalledTimes(initial + 1);
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      expect(refreshAuthStatus).toHaveBeenCalledTimes(initial + 2);
    } finally {
      hiddenProperty.mockRestore();
      vi.useRealTimers();
    }
  });

  test('propagates the not-configured status from the public auth contract', async () => {
    refreshAuthStatus.mockResolvedValue({
      data: {
        status: 'not-configured',
        provider: 'none',
        expiresAt: null,
        user: null,
      },
    });

    render(
      <AuthProvider>
        <AuthStatusProbe />
      </AuthProvider>,
    );

    expect(await screen.findByText('not-configured')).toBeTruthy();
  });
});
