/** @vitest-environment jsdom */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { mountedDecisionSurfaces } from '../../../lib/custom-appearance/decision-surfaces';

const engineConnections = vi.fn();
const accountValues = vi.fn();
const allEnginesDefault = vi.fn();
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
        interactiveApprovalDefault: allEnginesDefault(),
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
  allEnginesDefault.mockReturnValue(undefined);
  save.mockClear();
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
  expect(fullAccess('New chats (all engines) approval mode').disabled).toBe(
    true,
  );
  expect(fullAccess('New Codex chats approval mode').disabled).toBe(true);
  expect(fullAccess('New chats (all engines) approval mode').disabled).toBe(
    true,
  );
  expect(fullAccess('New Codex chats approval mode').textContent).toMatch(
    / \(Managed\)$/,
  );
  // Saved before the policy: still shown, so it can be seen and changed.
  expect(fullAccess('New Claude chats approval mode').disabled).toBe(false);
  expect(screen.getByText(/Acme's policy manages approval modes/)).toBeTruthy();
});

test('engine overrides show the account default and can reset to it', () => {
  allEnginesDefault.mockReturnValue('auto');
  accountValues.mockReturnValue({ codex: 'ask' });
  render(<AccountPreferencesSection />);
  expect(
    screen.getByRole('option', { name: 'Station or engine default' }),
  ).toBeTruthy();
  const codex = screen.getByLabelText('New Codex chats approval mode');
  fireEvent.change(codex, { target: { value: 'connection-default' } });
  expect(save).toHaveBeenCalledWith({
    interactiveApprovalModes: { codex: null },
  });
  const claude = screen.getByLabelText('New Claude chats approval mode');
  expect(claude).toHaveProperty('value', 'connection-default');
  expect(claude.querySelector('option:checked')?.textContent).toBe(
    'All engines (Auto)',
  );
});

test('Full access on all engines requires confirmation before saving', () => {
  render(<AccountPreferencesSection />);
  const selector = screen.getByLabelText(
    'New chats (all engines) approval mode',
  );
  fireEvent.change(selector, { target: { value: 'never' } });
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole('button', { name: 'Save full access default' }),
  );
  expect(save).toHaveBeenCalledWith({ interactiveApprovalDefault: 'never' });
});
