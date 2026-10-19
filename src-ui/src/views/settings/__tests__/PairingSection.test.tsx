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
    fireEvent.click(screen.getByRole('button', { name: '+ Pair device' }));
    expect(consumePendingConnectionsModal()).toEqual({ mode: 'pair-host' });
    expect(
      screen.queryByRole('switch', { name: /mobile pairing/i }),
    ).toBeNull();
  });

  test('the pairing action is the section header’s compact action and opens the pairing flow', () => {
    render(<PairingSection />);
    const action = screen.getByRole('button', { name: '+ Pair device' });
    // On the header line, not a row of its own in the body.
    expect(action.closest('.page-section__header')).toBeTruthy();
    expect(action.closest('.page-section__body')).toBeNull();
    // It carries the catalog row, so a Settings deep link lands on it.
    expect(action.getAttribute('data-catalog-id')).toBe('mobile-pairing');
    expect(action.id).toBe('mobile-pairing');
    // Its name is its label; the catalog title is not attached to it.
    expect(action.getAttribute('title')).toBeNull();
    fireEvent.click(action);
    expect(consumePendingConnectionsModal()).toEqual({ mode: 'pair-host' });
  });

  test('a person’s own access tokens sit in the Pairing section', () => {
    render(<PairingSection />);
    expect(screen.getByTestId('own-access-tokens')).toBeTruthy();
  });

  test('a native phone opens the joining-device scan flow rather than promising a host invitation', () => {
    nativePhone = true;
    render(<PairingSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect phone' }));
    expect(consumePendingConnectionsModal()).toEqual({ mode: 'pair-device' });
    expect(screen.queryByRole('button', { name: '+ Pair device' })).toBeNull();
  });
});
