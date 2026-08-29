/**
 * @vitest-environment jsdom
 */

import { encodeDevicePairingPayload } from '@kontourai/station-connect';
import {
  encodePairingDeepLink,
  PAIRING_LINK_REMEDY,
} from '@kontourai/station-connect/pairing-deep-link';
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { usePairingDeepLink } from '../usePairingDeepLink';

const nativePairingDeepLinkMock = vi.hoisted(() => ({
  deliver: undefined as undefined | ((event: { url: string }) => void),
  subscribe: vi.fn(),
}));

vi.mock('../../platform/native', () => ({
  nativePlatformPromise: Promise.resolve({
    capability: () => ({ state: 'enabled' }),
    subscribeToPairingDeepLinks: (
      listener: (event: { url: string }) => void,
    ) => {
      nativePairingDeepLinkMock.subscribe(listener);
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
    nativePairingDeepLinkMock.subscribe.mockReset();
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
