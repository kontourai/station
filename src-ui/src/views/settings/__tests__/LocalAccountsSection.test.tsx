/** @vitest-environment jsdom */
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { LocalAccountsSection } from '../LocalAccountsSection';

const host = vi.hoisted(() => ({
  apiBase: 'https://station.example.test',
  authorityKey: 'operator-one',
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({ ...host }),
}));
vi.mock('../../../components/modals/ConfirmModal', () => ({
  ConfirmModal: ({
    isOpen,
    onConfirm,
    pending,
  }: {
    isOpen: boolean;
    onConfirm: () => void;
    pending: boolean;
  }) =>
    isOpen ? (
      <div role="dialog">
        <button type="button" disabled={pending} onClick={onConfirm}>
          Confirm change
        </button>
      </div>
    ) : null,
}));
const clients: QueryClient[] = [];
beforeEach(() => {
  host.authorityKey = 'operator-one';
  setClientCredentialResolver(() => ({
    origin: host.apiBase,
    requestAuthority: { ...host, isCurrent: () => true },
  }));
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <LocalAccountsSection />
    </QueryClientProvider>,
  );
}
const reply = (data: unknown) => Response.json({ success: true, data });
const view = {
  kind: 'local',
  accounts: [
    {
      accountId: 'account-one',
      name: 'Collaborator',
      username: 'collaborator',
      emailVerified: false,
      disabled: false,
    },
  ],
};
test('recovery requires confirmation and its link is cleared on a Station authority change', async () => {
  const writes: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        writes.push(JSON.parse(String(init.body)));
        return reply({
          recoveryUrl: `${host.apiBase}/account/reset#token=operator-issued-test-recovery`,
        });
      }
      return reply(view);
    }),
  );
  const rendered = mount();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Create recovery link' }),
  );
  expect(writes).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm change' }));
  const link = await screen.findByLabelText('Single-use recovery link');
  expect((link as HTMLInputElement).value).toContain(
    '#token=operator-issued-test-recovery',
  );
  expect(writes).toEqual([{ action: 'create-recovery' }]);
  host.authorityKey = 'operator-two';
  rendered.rerender(
    <QueryClientProvider client={clients[0]!}>
      <LocalAccountsSection />
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(screen.queryByLabelText('Single-use recovery link')).toBeNull(),
  );
});
test('external account management exposes provider guidance instead of local mutations', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      reply({ kind: 'external', provider: 'Example identity provider' }),
    ),
  );
  mount();
  await screen.findByText(/Accounts are managed by Example identity provider/);
  expect(
    screen.queryByRole('button', { name: 'Create recovery link' }),
  ).toBeNull();
  expect(screen.queryByRole('button', { name: 'Disable sign-in' })).toBeNull();
});
