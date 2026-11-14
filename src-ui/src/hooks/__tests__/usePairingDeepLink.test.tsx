/**
 * @vitest-environment jsdom
 */

import { encodeDevicePairingPayload } from '@kontourai/station-connect';
import {
  encodeBrowserPairingLink,
  encodePairingDeepLink,
  PAIRING_LINK_REMEDY,
} from '@kontourai/station-connect/pairing-deep-link';
import { act, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { usePairingDeepLink } from '../usePairingDeepLink';

const nativePairingDeepLinkMock = vi.hoisted(() => ({
  deliver: undefined as undefined | ((event: { url: string }) => void),
  subscribe: vi.fn(),
  deliverError: undefined as undefined | ((error: { message: string }) => void),
}));

vi.mock('../../platform/native', () => ({
  nativePlatformPromise: Promise.resolve({
    capability: () => ({ state: 'enabled' }),
    subscribeToPairingDeepLinks: (
      listener: (event: { url: string }) => void,
      onError: (error: { message: string }) => void,
    ) => {
      nativePairingDeepLinkMock.subscribe(listener);
      nativePairingDeepLinkMock.deliverError = onError;
      nativePairingDeepLinkMock.deliver = listener;
      return { dispose: () => undefined };
    },
  }),
}));

function PairingDeepLinkHarness({
  clientChannel = 'stable',
  onPairingPayload,
  onError,
}: {
  clientChannel?: 'stable' | 'beta' | 'nightly';
  onPairingPayload: (payload: string) => void;
  onError: (message: string) => void;
}) {
  usePairingDeepLink({
    enabled: true,
    clientChannel,
    onPairingPayload,
    onError,
  });
  return null;
}

describe('usePairingDeepLink', () => {
  beforeEach(() => {
    nativePairingDeepLinkMock.deliver = undefined;
    nativePairingDeepLinkMock.deliverError = undefined;
    nativePairingDeepLinkMock.subscribe.mockReset();
  });

  test('callback changes do not replay a retained native invitation and later deliveries use current callbacks', async () => {
    const payload = encodeDevicePairingPayload({
      protocolVersion: 1,
      environmentId: 'environment-link',
      offerId: 'retained-launch',
      challenge: 'challenge-link',
      manualCode: 'ABCDE12345',
      endpoint: 'https://station.example.test',
      scope: 'orchestration:read',
      expiresAt: 4_102_444_800_000,
    });
    const url = encodePairingDeepLink({ payload, clientChannel: 'stable' });
    nativePairingDeepLinkMock.subscribe.mockImplementation((listener) =>
      listener({ url }),
    );
    const firstPayload = vi.fn();
    const firstError = vi.fn();
    const nextPayload = vi.fn();
    const nextError = vi.fn();
    const { rerender } = render(
      <PairingDeepLinkHarness
        onPairingPayload={firstPayload}
        onError={firstError}
      />,
    );
    await waitFor(() =>
      expect(firstPayload).toHaveBeenCalledExactlyOnceWith(payload),
    );

    rerender(
      <PairingDeepLinkHarness
        onPairingPayload={nextPayload}
        onError={nextError}
      />,
    );
    await act(async () => {});
    expect(firstPayload).toHaveBeenCalledOnce();
    expect(nextPayload).not.toHaveBeenCalled();

    act(() => nativePairingDeepLinkMock.deliver?.({ url }));
    expect(nextPayload).toHaveBeenCalledExactlyOnceWith(payload);
    act(() =>
      nativePairingDeepLinkMock.deliverError?.({
        message: 'Native listener failed',
      }),
    );
    expect(nextError).toHaveBeenCalledExactlyOnceWith('Native listener failed');
    expect(firstError).not.toHaveBeenCalled();
  });

  test('retains a valid review payload when the next native delivery is malformed', async () => {
    const onPairingPayload = vi.fn();
    const onError = vi.fn();
    const payload = encodeDevicePairingPayload({
      protocolVersion: 1,
      environmentId: 'environment-link',
      offerId: 'offer-link',
      challenge: 'challenge-link',
      manualCode: 'ABCDE12345',
      endpoint: 'https://station.example.test',
      scope: 'orchestration:read',
      expiresAt: Date.now() + 60_000,
    });

    render(
      <PairingDeepLinkHarness
        onPairingPayload={onPairingPayload}
        onError={onError}
      />,
    );

    await waitFor(() => expect(nativePairingDeepLinkMock.deliver).toBeTruthy());
    act(() =>
      nativePairingDeepLinkMock.deliver?.({
        url: encodePairingDeepLink({ payload, clientChannel: 'stable' }),
      }),
    );
    expect(onPairingPayload).toHaveBeenCalledExactlyOnceWith(payload);

    act(() =>
      nativePairingDeepLinkMock.deliver?.({
        url: 'station-stable://pair?linkVersion=1&clientChannel=stable&payload=malformed',
      }),
    );

    expect(onPairingPayload).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(PAIRING_LINK_REMEDY),
    );
  });

  test('does not let another release channel present its pairing review', async () => {
    const onPairingPayload = vi.fn();
    const onError = vi.fn();
    const payload = encodeDevicePairingPayload({
      protocolVersion: 1,
      environmentId: 'environment-link',
      offerId: 'offer-link',
      challenge: 'challenge-link',
      manualCode: 'ABCDE12345',
      endpoint: 'https://station.example.test',
      scope: 'orchestration:read',
      expiresAt: Date.now() + 60_000,
    });

    render(
      <PairingDeepLinkHarness
        clientChannel="beta"
        onPairingPayload={onPairingPayload}
        onError={onError}
      />,
    );

    await waitFor(() => expect(nativePairingDeepLinkMock.deliver).toBeTruthy());
    act(() =>
      nativePairingDeepLinkMock.deliver?.({
        url: encodePairingDeepLink({ payload, clientChannel: 'nightly' }),
      }),
    );

    expect(onPairingPayload).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(PAIRING_LINK_REMEDY),
    );
  });
});

afterEach(() => window.history.replaceState(null, '', '/'));

test.each([true, false])(
  'opens a browser invitation once and removes its proof from history (valid=%s)',
  (valid) => {
    const payload = valid
      ? encodeDevicePairingPayload({
          protocolVersion: 1,
          environmentId: 'invited-station',
          offerId: 'one-time-offer',
          manualCode: 'ABCDE12345',
          challenge: 'one-time-proof',
          endpoint: window.location.origin,
          scope: 'orchestration:read',
          expiresAt: Date.now() + 60_000,
        })
      : 'station-pairing:v1:invalid';
    const link = encodeBrowserPairingLink({
      payload,
      browserUrl: window.location.origin,
    });
    window.history.replaceState(null, '', link);
    const onPairingPayload = vi.fn();
    const onError = vi.fn();
    const { rerender } = renderHook(() =>
      usePairingDeepLink({
        enabled: false,
        onPairingPayload,
        onError,
      }),
    );
    expect(window.location.hash).toBe('');
    if (valid) {
      expect(onPairingPayload).toHaveBeenCalledExactlyOnceWith(payload);
      expect(onError).not.toHaveBeenCalled();
    } else {
      expect(onError).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining('invalid or expired'),
      );
      expect(onPairingPayload).not.toHaveBeenCalled();
    }
    rerender();
    expect(onPairingPayload.mock.calls.length + onError.mock.calls.length).toBe(
      1,
    );
  },
);
