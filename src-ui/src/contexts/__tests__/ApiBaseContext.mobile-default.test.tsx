// @vitest-environment jsdom

import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({
  props: null as Record<string, unknown> | null,
  profile: {
    isTauri: true,
    target: 'android',
    isMobile: true,
    isDesktop: false,
    supervisesBundledServer: false,
    isDevBuild: false,
    channel: 'beta',
    mobileDefaultEndpoint: 'https://station.example.test:8442',
  } as {
    isTauri: boolean;
    target: string;
    isMobile: boolean;
    isDesktop: boolean;
    supervisesBundledServer: boolean;
    isDevBuild: boolean;
    channel: string;
    mobileDefaultEndpoint?: string;
  },
}));

vi.mock('@kontourai/station-connect', () => ({
  ConnectionsProvider: (
    props: Record<string, unknown> & { children: ReactNode },
  ) => {
    captured.props = props;
    return null;
  },
  DEFAULT_CONNECTION_CREDENTIAL_KEY: 'station-connection-credential',
  defaultCredentialStorage: { remove: vi.fn() },
  RejectingCredentialStorage: class {},
  setNativePairingExchangeTransport: vi.fn(),
  useConnections: vi.fn(),
}));

vi.mock('../../platform/PlatformProfileContext', () => ({
  useNativeProfileStoreEpoch: () => 0,
  useNativeProfileSelection: () => async () => {},
  usePlatformProfile: () => captured.profile,
  nativeProfileRepository: () => ({ get: () => null }),
}));

vi.mock('../../platform/useBundledServerStatus', () => ({
  useBundledServerStatus: () => null,
}));

import { ApiBaseProvider } from '../ApiBaseContext';

describe('ApiBaseContext native-mobile connection setup', () => {
  beforeEach(() => {
    captured.props = null;
    delete (window as Window & { __API_BASE__?: string }).__API_BASE__;
  });

  it.each([undefined, 'https://station.example.test:8442'])(
    'starts without an injected backend even with legacy build metadata: %s',
    (legacyEndpoint) => {
      captured.profile.mobileDefaultEndpoint = legacyEndpoint;
      render(<ApiBaseProvider>unused</ApiBaseProvider>);

      expect(captured.props?.seedDefault).toBe(false);
      expect(captured.props?.injectedConnection).toBeNull();
      expect(captured.props?.defaultUrl).toBe('');
    },
  );
});
