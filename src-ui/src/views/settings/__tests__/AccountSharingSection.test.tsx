/** @vitest-environment jsdom */
import type { AccountSharingSettingView } from '@kontourai/station-contracts/local-accounts';
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
import { AccountSharingSection } from '../AccountSharingSection';

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
    message,
  }: {
    isOpen: boolean;
    onConfirm: () => void;
    pending: boolean;
    title: string;
    message: string;
  }) =>
    isOpen ? (
      <div role="dialog">
        <h2>{title}</h2>
        <p>{message}</p>
        <button type="button" disabled={pending} onClick={onConfirm}>
          Confirm change
        </button>
      </div>
    ) : null,
}));
const clients: QueryClient[] = [];
beforeEach(() => {
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
      <AccountSharingSection />
    </QueryClientProvider>,
  );
}
const reply = (data: unknown) => Response.json({ success: true, data });
const OFFERED = 'https://station.tailnet.ts.net';
const off: AccountSharingSettingView = {
  source: 'setting',
  lockedBy: [],
  active: {
    projectSharing: false,
    localAccounts: false,
    externalProvider: false,
  },
  stored: { enabled: false },
  origins: [
    { origin: OFFERED, sources: ['tailscale-serve', 'allowed-origin'] },
    {
      origin: 'http://192.168.1.20:3000',
      sources: ['allowed-origin'],
      unavailable: 'requires-https',
    },
    { origin: 'http://localhost:3141', sources: ['station-loopback'] },
  ],
  restart: 'supervised',
};

test('the operator picks an offered address, confirms, and Station restarts into it', async () => {
  const writes: unknown[] = [];
  let current = off;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        writes.push(JSON.parse(String(init.body)));
        current = {
          ...off,
          active: {
            projectSharing: true,
            localAccounts: true,
            externalProvider: false,
            publicOrigin: OFFERED,
          },
          stored: { enabled: true, publicOrigin: OFFERED },
        };
        return reply({ changed: true, restarting: true });
      }
      return reply(current);
    }),
  );
  mount();
  fireEvent.click(
    await screen.findByRole('switch', {
      name: 'Project sharing with local accounts',
    }),
  );
  // An address that cannot work is listed but not selectable.
  const lan = screen.getByRole('radio', { name: /192\.168\.1\.20/ });
  expect((lan as HTMLInputElement).disabled).toBe(true);
  expect(screen.getByText(/Needs HTTPS/)).toBeTruthy();
  // The first selectable address is preselected; pick another, then back.
  const tailnet = screen.getByRole('radio', { name: new RegExp(OFFERED) });
  expect((tailnet as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole('radio', { name: /localhost:3141/ }));
  fireEvent.click(tailnet);
  fireEvent.click(screen.getByRole('button', { name: 'Apply and restart' }));
  expect(writes).toHaveLength(0);
  expect(screen.getByText(new RegExp(`sign in at ${OFFERED}`))).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm change' }));
  await waitFor(() =>
    expect(writes).toEqual([{ enabled: true, publicOrigin: OFFERED }]),
  );
  expect(await screen.findByText('On')).toBeTruthy();
});

test('a deployment-set Station shows the lock and offers no control', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      reply({
        ...off,
        source: 'deployment',
        lockedBy: ['STATION_PROJECT_SHARING', 'STATION_LOCAL_ACCOUNTS'],
        active: {
          projectSharing: true,
          localAccounts: true,
          externalProvider: false,
          publicOrigin: OFFERED,
        },
        stored: undefined,
        origins: [],
      }),
    ),
  );
  mount();
  expect(await screen.findByText('Set by the deployment')).toBeTruthy();
  expect(
    screen.getByText(/STATION_PROJECT_SHARING, STATION_LOCAL_ACCOUNTS/),
  ).toBeTruthy();
  expect(screen.queryByRole('switch')).toBeNull();
  expect(
    screen.queryByRole('button', { name: 'Apply and restart' }),
  ).toBeNull();
});

test('an unsupervised Station cannot apply, and a rolled-back change is reported', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      reply({
        ...off,
        restart: 'unavailable',
        lastApply: {
          outcome: 'rolled-back',
          choice: { enabled: true, publicOrigin: OFFERED },
          at: '2026-10-28T12:00:00.000Z',
          reason: 'Station did not start with this setting.',
        },
      }),
    ),
  );
  mount();
  fireEvent.click(
    await screen.findByRole('switch', {
      name: 'Project sharing with local accounts',
    }),
  );
  const apply = screen.getByRole('button', { name: 'Apply and restart' });
  expect((apply as HTMLButtonElement).disabled).toBe(true);
  expect(
    screen.getByText(/only when its process supervisor runs it/),
  ).toBeTruthy();
  expect(screen.getByText(/last change was rolled back/)).toBeTruthy();
});

test('a caller that is not the operator is told so, and a refused apply shows its reason', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json(
        {
          success: false,
          code: 'operator_required',
          error: 'Only the Station operator can change Project sharing.',
        },
        { status: 403 },
      ),
    ),
  );
  mount();
  expect(
    await screen.findByText(/Only the Station operator can change this/),
  ).toBeTruthy();
  cleanup();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'PUT'
        ? Response.json(
            {
              success: false,
              code: 'restart_failed',
              error: 'Nothing changed: the supervisor did not answer.',
            },
            { status: 504 },
          )
        : reply(off),
    ),
  );
  mount();
  fireEvent.click(
    await screen.findByRole('switch', {
      name: 'Project sharing with local accounts',
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Apply and restart' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm change' }));
  expect(await screen.findByText(/supervisor did not answer/)).toBeTruthy();
});
