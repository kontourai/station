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
const previews = vi.hoisted(() => ({
  data: [{ id: 'project-sharing-setting', enabled: true }] as
    | Array<{ id: string; enabled: boolean }>
    | undefined,
}));
vi.mock('@kontourai/station-sdk', () => ({
  useFeaturePreviewsQuery: () => ({ data: previews.data }),
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({ ...host }),
}));
const clients: QueryClient[] = [];
beforeEach(() => {
  previews.data = [{ id: 'project-sharing-setting', enabled: true }];
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

test('shows an unresolved pending change from the server', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      reply({
        ...off,
        pending: {
          choice: { enabled: true, publicOrigin: OFFERED },
          ready: false,
        },
      }),
    ),
  );
  mount();
  expect(
    await screen.findByText(/previous change remains pending/),
  ).toBeTruthy();
});

test('reports an uncertain publication while Station restarts', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'PUT'
        ? reply({ changed: true, restarting: true, durabilityUncertain: true })
        : reply(off),
    ),
  );
  mount();
  fireEvent.click(
    await screen.findByRole('switch', {
      name: 'Project sharing with local accounts',
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Review change' }));
  expect(
    await screen.findByText(/durability could not be confirmed/),
  ).toBeTruthy();
});

test('opens a separate review before any restart is reported', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'PUT'
        ? reply({
            changed: true,
            confirmation: {
              id: '12345678-1234-4123-8123-123456789abc',
              reviewUrl:
                'http://localhost:3144/consent/12345678-1234-4123-8123-123456789abc',
              expiresAt: 2000000000000,
            },
          })
        : reply(off),
    ),
  );
  mount();
  fireEvent.click(
    await screen.findByRole('switch', {
      name: 'Project sharing with local accounts',
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Review change' }));
  const link = await screen.findByRole('link', {
    name: 'Open the separate confirmation page',
  });
  expect(link.getAttribute('href')).toBe(
    'http://localhost:3144/consent/12345678-1234-4123-8123-123456789abc',
  );
  expect(screen.queryByText(/Station is restarting to apply this/)).toBeNull();
});

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
  fireEvent.click(screen.getByRole('button', { name: 'Review change' }));
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
  expect(screen.queryByRole('button', { name: 'Review change' })).toBeNull();
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
  const apply = screen.getByRole('button', { name: 'Review change' });
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
  fireEvent.click(screen.getByRole('button', { name: 'Review change' }));
  expect(await screen.findByText(/supervisor did not answer/)).toBeTruthy();
});

test('the section is absent until its Feature Preview is on, and asks for nothing', async () => {
  const fetch = vi.fn(async () => reply(off));
  vi.stubGlobal('fetch', fetch);
  for (const data of [
    undefined,
    [],
    [{ id: 'project-sharing-setting', enabled: false }],
  ]) {
    previews.data = data;
    const rendered = mount();
    expect(
      screen.queryByText('Project sharing with local accounts'),
    ).toBeNull();
    rendered.unmount();
  }
  expect(fetch).not.toHaveBeenCalled();
});

test('a server that refuses the preview says where to turn it on', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json(
        {
          success: false,
          error:
            'Enable Project sharing setting in Settings → Advanced → Feature previews.',
          code: 'feature_preview_disabled',
          previewId: 'project-sharing-setting',
          settingsPath:
            '/settings?view=feature-previews&highlight=feature-previews',
        },
        { status: 404 },
      ),
    ),
  );
  mount();
  expect(await screen.findByText(/Advanced → Feature previews/)).toBeTruthy();
  expect(screen.queryByText(/Update Station/)).toBeNull();
});
