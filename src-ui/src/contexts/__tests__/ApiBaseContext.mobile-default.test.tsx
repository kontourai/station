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

describe('ApiBaseContext native-mobile build default', () => {
  beforeEach(() => {
    captured.props = null;
    captured.profile.mobileDefaultEndpoint =
      'https://station.example.test:8442';
    delete (window as Window & { __API_BASE__?: string }).__API_BASE__;
  });

  it('injects the trusted channel endpoint instead of the Tauri shell origin', () => {
    render(<ApiBaseProvider>unused</ApiBaseProvider>);

    expect(captured.props?.seedDefault).toBe(false);
    expect(captured.props?.injectedConnection).toEqual({
      id: 'mobile-default-beta',
      name: 'Station beta',
      url: 'https://station.example.test:8442',
      source: 'mobile-default',
    });
    expect(captured.props?.defaultUrl).not.toBe('tauri://localhost');
  });

  it('publishes no API base on a clean native install with no trusted host', () => {
    delete captured.profile.mobileDefaultEndpoint;
    render(<ApiBaseProvider>unused</ApiBaseProvider>);

    expect(captured.props?.seedDefault).toBe(false);
    expect(captured.props?.injectedConnection).toBeNull();
    expect(captured.props?.defaultUrl).toBe('');
  });
});
