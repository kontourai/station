/**
 * @vitest-environment jsdom
 */

import { render, screen, waitFor } from '@testing-library/react';
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
