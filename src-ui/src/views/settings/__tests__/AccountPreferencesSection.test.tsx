/** @vitest-environment jsdom */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { mountedDecisionSurfaces } from '../../../lib/custom-appearance/decision-surfaces';

const engineConnections = vi.fn();
const accountValues = vi.fn();
const sendMode = vi.fn();
const save = vi.fn();

vi.mock('@kontourai/station-sdk', () => ({
  useEngineConnectionsQuery: () => ({ data: engineConnections() }),
}));

vi.mock('../../../contexts/AccountPreferencesContext', () => ({
  useAccountPreferences: () => ({
    status: 'account',
    saving: false,
    data: {
      values: {
        interactiveApprovalModes: accountValues(),
        chatDefaultSendMode: sendMode(),
      },
    },
    save,
    retry: vi.fn(),
  }),
}));

const { AccountPreferencesSection } = await import(
  '../AccountPreferencesSection'
);

beforeEach(() => {
  engineConnections.mockReturnValue([]);
  accountValues.mockReturnValue({});
  sendMode.mockReturnValue(undefined);
  save.mockClear();
});

test('shows the saved default send mode and saves Queue to the account', () => {
  sendMode.mockReturnValue('steer');
  render(<AccountPreferencesSection />);
  const select = screen.getByRole('combobox', { name: 'Default send mode' });
  expect(select).toHaveProperty('value', 'steer');
  fireEvent.change(select, { target: { value: 'queue' } });
  expect(save).toHaveBeenCalledWith({ chatDefaultSendMode: 'queue' });
});

const engine = (id: string) => ({ id, config: { engineId: id } });

test('without a Muse engine there is no "New Muse chats" row (#4402)', () => {
  engineConnections.mockReturnValue([engine('codex'), engine('claude')]);
  render(<AccountPreferencesSection />);
  // Custom CSS is held off while this grant UI is on screen.
  expect(mountedDecisionSurfaces()).toContain('account-approval-defaults');
  expect(screen.getByText('New Codex chats')).toBeTruthy();
  expect(screen.getByText('New Claude chats')).toBeTruthy();
  expect(screen.queryByText('New Muse chats')).toBeNull();
});

test('a Station with a Muse engine offers its row', () => {
  engineConnections.mockReturnValue([engine('codex'), engine('muse')]);
  render(<AccountPreferencesSection />);
  expect(screen.getByText('New Muse chats')).toBeTruthy();
});

test('a saved Muse default stays reachable so it can be cleared', () => {
  accountValues.mockReturnValue({ muse: 'auto' });
  render(<AccountPreferencesSection />);
  expect(screen.getByText('New Muse chats')).toBeTruthy();
});

test('#4518: under a managed ceiling of Auto, Full access is not offered unless already saved', async () => {
  const { ManagedPolicyContext } = await import(
    '../../../contexts/ManagedPolicyContext'
  );
  engineConnections.mockReturnValue([engine('codex'), engine('claude')]);
  accountValues.mockReturnValue({ claude: 'never' });
  render(
    <ManagedPolicyContext.Provider
      value={{
        organization: 'Acme',
        supportUrl: null,
        lockedSettings: [],
        limits: { maxApprovalMode: 'auto' },
      }}
    >
      <AccountPreferencesSection />
    </ManagedPolicyContext.Provider>,
  );
  const fullAccess = (label: string) =>
    Array.from(
      (screen.getByLabelText(label) as HTMLSelectElement).options,
    ).find((option) => option.value === 'never')!;
  expect(fullAccess('New Codex chats approval mode').disabled).toBe(true);
  expect(fullAccess('New Codex chats approval mode').textContent).toMatch(
    / \(Managed\)$/,
  );
  // Saved before the policy: still shown, so it can be seen and changed.
  expect(fullAccess('New Claude chats approval mode').disabled).toBe(false);
  expect(screen.getByText(/Acme's policy manages approval modes/)).toBeTruthy();
});
