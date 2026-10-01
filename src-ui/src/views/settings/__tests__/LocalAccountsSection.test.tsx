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
import {
  openOverflow,
  overflowItems,
} from '../../../__tests__/helpers/overflow-menu';
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
    title,
  }: {
    isOpen: boolean;
    onConfirm: () => void;
    pending: boolean;
    title: string;
  }) =>
    isOpen ? (
      <div role="dialog">
        <h2>{title}</h2>
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
  // #3045: the row shows one labelled action; recovery is a menu row.
  fireEvent.click(
    await screen.findByRole('button', {
      name: 'More actions for Collaborator',
    }),
  );
  fireEvent.click(
    screen.getByRole('menuitem', { name: 'Create recovery link' }),
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
// Review M3: both folded commands are present, signing everyone out is
// destructive and last, and its confirm names the action it is confirming.
test('the account menu holds recovery and a destructive sign-out, and the confirm names the action', async () => {
  const writes: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        writes.push(JSON.parse(String(init.body)));
        return reply({});
      }
      return reply(view);
    }),
  );
  mount();
  await screen.findByText('Collaborator');

  expect(overflowItems(openOverflow('More actions for Collaborator'))).toEqual([
    { name: 'Create recovery link', danger: false },
    { name: 'Sign out all sessions', danger: true },
  ]);
  fireEvent.click(
    screen.getByRole('menuitem', { name: 'Sign out all sessions' }),
  );
  expect(screen.getByRole('dialog').textContent).toContain(
    'Sign out all sessions for Collaborator?',
  );
  expect(writes).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm change' }));
  await waitFor(() => expect(writes).toEqual([{ action: 'revoke-sessions' }]));
});

test('a disabled account explains why recovery is refused, on a row a keyboard can reach', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      reply({
        ...view,
        accounts: [{ ...view.accounts[0], disabled: true }],
      }),
    ),
  );
  mount();
  await screen.findByText('Collaborator');
  const menu = openOverflow('More actions for Collaborator');

  const recovery = screen.getByRole('menuitem', {
    name: 'Create recovery link',
  });
  // Refused but reachable: `aria-disabled`, not `disabled`.
  expect(recovery.getAttribute('aria-disabled')).toBe('true');
  expect((recovery as HTMLButtonElement).disabled).toBe(false);
  const reasonId = recovery.getAttribute('aria-describedby');
  expect(reasonId).toBeTruthy();
  expect(document.getElementById(reasonId!)?.textContent).toBe(
    'Sign-in is disabled',
  );
  recovery.focus();
  expect(document.activeElement).toBe(recovery);

  fireEvent.click(recovery);
  expect(screen.queryByRole('dialog')).toBeNull();
  // The menu stays open on the row that says why.
  expect(menu.isConnected).toBe(true);
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
