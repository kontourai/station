/**
 * @vitest-environment jsdom
 *
 * CRM's account quick actions send their prompt through the function
 * `useSendToChat` returns (packages/sdk/src/hooks/operations.ts), not an
 * object holding it (#2321). The SDK mock mirrors the real return shape, so a
 * component that destructures `{ sendToChat }` gets `undefined` here too.
 * Child panels are stubbed: this test is about the chat wiring in CRM.tsx.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

const sendToChat = vi.hoisted(() => vi.fn());

vi.mock('@kontourai/station-sdk', () => ({
  useNavigation: () => ({ setLayoutTab: vi.fn() }),
  useSendToChat: () => sendToChat,
}));

const account = { id: 'a-1', name: 'Acme', territory: 'West', segment: 'Mid' };

vi.mock('../data', () => ({
  sortByAccessFrequency: <T,>(items: T[]) => items,
  useMyAccounts: () => ({ data: [account], isLoading: false }),
  useMyTerritories: () => ({ data: [], isLoading: false }),
  useSearchAccounts: () => ({ data: [], isLoading: false }),
  useTerritoryAccounts: () => ({ data: [], isLoading: false }),
}));

vi.mock('../hooks/useCRMDetailPanel', () => ({
  useCRMDetailPanel: (id: string | null) => ({
    account: id ? account : null,
    opportunities: [],
    tasks: [],
    isLoading: false,
  }),
}));

vi.mock('../AccountList', () => ({
  AccountList: ({
    accounts,
    onSelect,
  }: {
    accounts: (typeof account)[];
    onSelect: (a: typeof account) => void;
  }) => (
    <div>
      {accounts.map((a) => (
        <button key={a.id} type="button" onClick={() => onSelect(a)}>
          Select {a.name}
        </button>
      ))}
    </div>
  ),
}));
vi.mock('../AccountDetail', () => ({ AccountDetail: () => null }));
vi.mock('../FilterBar', () => ({ FilterBar: () => null }));
vi.mock('../OpportunityModal', () => ({
  CreateOpportunityModal: () => null,
  CreateTaskModal: () => null,
  LogActivityModal: () => null,
}));
vi.mock('../utils', () => ({ recordAccountAccess: vi.fn() }));

import { CRM } from '../CRM';

test('CRM account quick actions send their prompt through useSendToChat', () => {
  render(<CRM />);
  fireEvent.click(screen.getByRole('button', { name: 'Select Acme' }));
  fireEvent.click(screen.getByRole('button', { name: /Summarize account/ }));
  expect(sendToChat).toHaveBeenCalledWith(
    'Summarize the account "Acme" including recent opportunities and tasks.',
  );
});
