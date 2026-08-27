/**
 * @vitest-environment jsdom
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * station#3796 — the app-level providers published a fresh `value` object
 * literal on every render, so any render of a provider republished its
 * context to every consumer regardless of what the render was about; and
 * AuthProvider manufactured a new `Date` on every status poll, guaranteeing
 * one app-wide invalidation per minute even when nothing had changed.
 *
 * These two tests pin the two halves at their own mechanisms: a consumer
 * must not re-render for provider state it does not read, and an unchanged
 * poll must not invalidate the context at all.
 */

const refreshAuthStatus = vi.hoisted(() => vi.fn());

vi.mock('@kontourai/station-connect', () => ({
  useConnections: () => ({ activeConnection: null }),
}));

vi.mock('@kontourai/station-sdk', () => ({
  useAuthStatusQuery: () => ({
    data: undefined,
    error: null,
    refetch: refreshAuthStatus,
  }),
  useRenewAuthMutation: () => ({ mutateAsync: renewAsync }),
  authenticatedFetch: vi.fn(),
}));

vi.mock('../ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://localhost:3141' }),
}));

vi.mock('../../platform/native/useNativeConsentBroker', () => ({
  useNativeConsentBroker: () => null,
}));

const renewAsync = vi.hoisted(() => vi.fn());

import {
  PermissionManager,
  usePermissions,
} from '../../core/PermissionManager';
import { AuthProvider, useAuth } from '../AuthContext';

describe('app-level provider values (station#3796)', () => {
  beforeEach(() => {
    refreshAuthStatus.mockReset();
    refreshAuthStatus.mockResolvedValue({
      data: {
        status: 'valid',
        provider: 'fixture',
        expiresAt: '2026-08-23T12:00:00.000Z',
        user: null,
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('a consumer does not re-render when the provider changes state the consumer never reads', async () => {
    // PermissionManager owns the consent modal's own `pending` state. Opening
    // a consent request re-renders the provider and mounts the modal, but
    // publishes nothing new: `requestConsent`/`grantPermissions` are the whole
    // context. A consumer of those two must not re-render for it.
    let renders = 0;
    let consentResolved = false;

    function Probe() {
      const { requestConsent } = usePermissions();
      renders += 1;
      return (
        <button
          type="button"
          onClick={() => {
            void requestConsent('demo-plugin', 'Demo Plugin', [
              { permission: 'plugin.server', tier: 'trusted' },
            ]).then(() => {
              consentResolved = true;
            });
          }}
        >
          Ask
        </button>
      );
    }

    render(
      <PermissionManager>
        <Probe />
      </PermissionManager>,
    );
    const rendersAfterMount = renders;

    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));

    // The provider really did change state — the modal is on screen — so this
    // is not a vacuous "nothing happened" assertion.
    expect(screen.getByText('Demo Plugin')).toBeTruthy();
    expect(renders).toBe(rendersAfterMount);
    expect(consentResolved).toBe(false);
  });

  test('a status poll that changes nothing does not invalidate the auth context', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const values: unknown[] = [];

    function Probe() {
      values.push(useAuth());
      return <div>probe</div>;
    }

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(refreshAuthStatus).toHaveBeenCalledTimes(1);
    const settled = values.length;
    const publishedValue = values[values.length - 1];

    // One minute later the provider polls again and the server says exactly
    // what it said before, `expiresAt` included.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(refreshAuthStatus).toHaveBeenCalledTimes(2);
    expect(values.length).toBe(settled);
    expect(values[values.length - 1]).toBe(publishedValue);
  });
});
