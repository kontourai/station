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
vi.mock('../LanDiscoveryControl', () => ({
  LanDiscoveryControl: () => <div data-testid="lan-discovery" />,
}));

// #4519: the connected Station's managed policy status, as the SDK query
// returns it; the real hook derives the refusal from it.
let managedClients: Array<'desktop' | 'local-browser' | 'remote'> | undefined;
let supportUrl: string | null = null;
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://127.0.0.1:43141' }),
}));
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  useManagedPolicyStatusQuery: () => ({
    data: managedClients
      ? {
          state: 'loaded',
          summary: {
            organization: 'Acme',
            supportUrl,
            lockedSettings: [],
            limits: { clients: managedClients },
          },
        }
      : { state: 'none' },
  }),
}));

vi.mock('../OwnAccessTokensPanel', () => ({
  OwnAccessTokensPanel: () => <div data-testid="own-access-tokens" />,
}));

import { PairingSection } from '../PairingSection';

describe('Settings device pairing', () => {
  beforeEach(() => {
    consumePendingConnectionsModal();
    nativePhone = false;
    managedClients = undefined;
    supportUrl = null;
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

  test('#4519: a managed policy without remote clients disables pairing, hides nearby discovery and says why', () => {
    managedClients = ['desktop', 'local-browser'];
    render(<PairingSection />);
    const action = screen.getByRole('button', { name: '+ Pair device' });
    expect((action as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(action);
    expect(consumePendingConnectionsModal()).toBeNull();
    expect(screen.queryByTestId('lan-discovery')).toBeNull();
    const note = screen.getByText(
      "Acme's policy manages remote access: only this computer can connect to Station. Contact your administrator for help.",
    );
    expect(action.getAttribute('aria-describedby')).toBe(note.id);
    expect(screen.queryByRole('link', { name: 'Get help' })).toBeNull();
  });

  test('#4519: the policy support URL is a "Get help" link, not text', () => {
    managedClients = ['desktop', 'local-browser'];
    supportUrl = 'https://help.acme.example/station';
    render(<PairingSection />);
    const link = screen.getByRole('link', { name: 'Get help' });
    expect(link.getAttribute('href')).toBe(supportUrl);
    expect(document.body.textContent).not.toContain(`visit ${supportUrl}`);
  });

  test('#4519: a policy that lists remote clients leaves pairing alone', () => {
    managedClients = ['desktop', 'local-browser', 'remote'];
    render(<PairingSection />);
    expect(
      (
        screen.getByRole('button', {
          name: '+ Pair device',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    expect(screen.getByTestId('lan-discovery')).toBeTruthy();
  });

  test('#4519: a phone joining another Station is not affected by that Station’s own policy read', () => {
    nativePhone = true;
    managedClients = ['desktop', 'local-browser'];
    render(<PairingSection />);
    expect(
      (
        screen.getByRole('button', {
          name: 'Connect phone',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    expect(screen.queryByText(/policy manages remote access/)).toBeNull();
  });
});
