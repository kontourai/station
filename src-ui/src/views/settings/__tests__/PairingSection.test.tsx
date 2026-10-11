/** @vitest-environment jsdom */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { consumePendingConnectionsModal } from '../../../lib/connectionModalEvents';

let nativePhone = false;
vi.mock('../../../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => ({ isMobile: nativePhone, isTauri: nativePhone }),
}));

// #3557: the person's own token panel has its own tests (PeopleSection.test);
// here it is a marker, so these stay about pairing and still prove it mounts.
vi.mock('../OwnAccessTokensPanel', () => ({
  OwnAccessTokensPanel: () => <div data-testid="own-access-tokens" />,
}));

import { PairingSection } from '../PairingSection';

describe('Settings device pairing', () => {
  beforeEach(() => {
    consumePendingConnectionsModal();
    nativePhone = false;
  });

  test('opens the canonical invitation flow instead of advertising a bare address QR', () => {
    render(<PairingSection />);
    fireEvent.click(
      screen.getByRole('button', { name: 'Pair another device' }),
    );
    expect(consumePendingConnectionsModal()).toEqual({ mode: 'pair-host' });
    expect(
      screen.queryByRole('switch', { name: /mobile pairing/i }),
    ).toBeNull();
  });

  test('a person’s own access tokens sit in the Pairing section', () => {
    render(<PairingSection />);
    expect(screen.getByTestId('own-access-tokens')).toBeTruthy();
  });

  test('a native phone opens the joining-device scan flow rather than promising a host invitation', () => {
    nativePhone = true;
    render(<PairingSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect this phone' }));
    expect(consumePendingConnectionsModal()).toEqual({ mode: 'pair-device' });
    expect(
      screen.queryByRole('button', { name: 'Pair another device' }),
    ).toBeNull();
  });
});
