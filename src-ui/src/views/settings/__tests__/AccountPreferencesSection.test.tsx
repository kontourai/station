/** @vitest-environment jsdom */

import { render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

const engineConnections = vi.fn();
const accountValues = vi.fn();

vi.mock('@kontourai/station-sdk', () => ({
  useEngineConnectionsQuery: () => ({ data: engineConnections() }),
}));

vi.mock('../../../contexts/AccountPreferencesContext', () => ({
  useAccountPreferences: () => ({
    status: 'account',
    saving: false,
    data: { values: { interactiveApprovalModes: accountValues() } },
    save: vi.fn(),
    retry: vi.fn(),
  }),
}));

const { AccountPreferencesSection } = await import(
  '../AccountPreferencesSection'
);

beforeEach(() => {
  engineConnections.mockReturnValue([]);
  accountValues.mockReturnValue({});
});

const engine = (id: string) => ({ id, config: { engineId: id } });

test('without a Muse engine there is no "New Muse chats" row (#4402)', () => {
  engineConnections.mockReturnValue([engine('codex'), engine('claude')]);
  render(<AccountPreferencesSection />);
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
