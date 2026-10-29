/** @vitest-environment jsdom */
import { _setApiBase } from '@kontourai/station-sdk';
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

const authority = vi.hoisted(() => ({
  scope: { apiBase: 'http://station.test', authorityKey: 'person-a' },
}));
const open = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => authority.scope,
}));
vi.mock('../../../platform/openExternalLink', () => ({
  openExternalLink: open,
}));

import { IntegrationAccountSection } from '../IntegrationAccountSection';
import { IntegrationEditorPanel } from '../IntegrationEditorPanel';

const clients: QueryClient[] = [];
beforeEach(() => {
  authority.scope = {
    apiBase: 'http://station.test',
    authorityKey: 'person-a',
  };
  _setApiBase(authority.scope.apiBase);
  setClientCredentialResolver(() => {
    const captured = authority.scope;
    return {
      origin: captured.apiBase,
      requestAuthority: {
        ...captured,
        isCurrent: () => authority.scope === captured,
      },
    };
  });
  open.mockClear();
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});

function mount(savedRemote = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const element = () => (
    <QueryClientProvider client={client}>
      {savedRemote ? (
        <IntegrationEditorPanel
          editForm={{
            id: 'reports',
            kind: 'mcp',
            transport: 'streamable-http',
            endpoint: 'https://oauth.example/mcp',
          }}
          isNew={false}
          locked={false}
          message={null}
          viewMode="form"
          rawJson=""
          rawError={null}
          savePending={false}
          reconnectPending={false}
          onReconnect={() => {}}
          onDelete={() => {}}
          onSave={() => {}}
          onSwitchToForm={() => {}}
          onSwitchToRaw={() => {}}
          onRawJsonChange={() => {}}
          onUpdate={() => {}}
          onUnlock={() => {}}
        />
      ) : (
        <IntegrationAccountSection
          integrationId="reports"
          projectSlug="research"
        />
      )}
    </QueryClientProvider>
  );
  return { ...render(element()), element, client };
}

test('connects and disconnects the selected account, clears callback data and reflects server state', async () => {
  let connected = false;
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ url, method, body });
      if (url.endsWith('/oauth/authorize'))
        return Response.json({
          success: true,
          data: { authorizationUrl: 'https://signin.example.test/consent' },
        });
      if (url.endsWith('/oauth/callback')) {
        connected = true;
        return Response.json({ success: true, data: {} });
      }
      if (method === 'DELETE') connected = false;
      return Response.json({
        success: true,
        data: {
          ownership: 'principal',
          connectedAs: connected ? 'you-in-project' : null,
          project: { slug: 'research', connected },
          shared: { usable: false, connected: false },
        },
      });
    }),
  );
  const view = mount();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Connect your account' }),
  );
  fireEvent.click(
    await screen.findByRole('button', { name: 'Open sign-in page' }),
  );
  expect(open).toHaveBeenCalledWith('https://signin.example.test/consent');
  fireEvent.change(screen.getByLabelText('Redirected URL'), {
    target: {
      value: 'http://localhost/callback?code=private-code&state=state-a',
    },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Finish sign-in' }));
  await screen.findByText('Using your account for this Project');
  expect(screen.queryByLabelText('Redirected URL')).toBeNull();
  expect(requests.find((r) => r.url.endsWith('/oauth/callback'))?.body).toEqual(
    {
      projectSlug: 'research',
      callbackUrl: 'http://localhost/callback?code=private-code&state=state-a',
    },
  );
  await waitFor(() =>
    expect(
      JSON.stringify(
        view.client
          .getMutationCache()
          .getAll()
          .map((m) => m.state.variables),
      ),
    ).not.toContain('private-code'),
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Disconnect your account' }),
  );
  await screen.findByText('Your account is not connected');
  expect(
    requests.some(
      (r) =>
        r.method === 'DELETE' &&
        r.url.endsWith('/reports/account?projectSlug=research'),
    ),
  ).toBe(true);
});

test('retains sign-in recovery after refusal while removing the submitted callback', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.endsWith('/oauth/callback'))
        return Response.json(
          {
            success: false,
            error: 'Consent has expired. Start sign-in again.',
          },
          { status: 400 },
        );
      return Response.json({
        success: true,
        data: url.endsWith('/oauth/authorize')
          ? { authorizationUrl: 'https://signin.example.test/consent' }
          : {
              ownership: 'principal',
              connectedAs: null,
              shared: { usable: false, connected: false },
            },
      });
    }),
  );
  mount();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Connect your account' }),
  );
  const callback = await screen.findByLabelText('Redirected URL');
  fireEvent.change(callback, {
    target: { value: 'http://localhost/?code=private-code' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Finish sign-in' }));
  await screen.findByText('Consent has expired. Start sign-in again.');
  expect(
    (screen.getByLabelText('Redirected URL') as HTMLInputElement).value,
  ).toBe('');
  expect(screen.queryByText('Using your account')).toBeNull();
  expect(
    (
      screen.getByRole('button', {
        name: 'Connect your account',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
});

test('changing authority removes old consent and does not display the previous account', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      Response.json({
        success: true,
        data: url.endsWith('/oauth/authorize')
          ? { authorizationUrl: 'https://signin.example.test/person-a' }
          : {
              ownership: 'principal',
              connectedAs:
                authority.scope.authorityKey === 'person-a' ? 'you' : null,
              project: {
                slug: 'research',
                connected: authority.scope.authorityKey === 'person-a',
              },
              shared: { usable: false, connected: false },
            },
      }),
    ),
  );
  const view = mount();
  await screen.findByText('Using your account');
  fireEvent.click(
    screen.getByRole('button', { name: 'Reconnect your account' }),
  );
  await screen.findByLabelText('Redirected URL');
  authority.scope = { ...authority.scope, authorityKey: 'person-b' };
  view.rerender(view.element());
  expect(screen.queryByLabelText('Redirected URL')).toBeNull();
  expect(screen.queryByText('Using your account')).toBeNull();
  await screen.findByText('Your account is not connected');
});

test('a shared remote account can start sign-in and complete authenticated paste-back', async () => {
  const requests: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ url, body });
      if (url.endsWith('/oauth/authorize'))
        return Response.json({
          success: true,
          data: { authorizationUrl: 'https://signin.example.test/consent' },
        });
      if (url.endsWith('/oauth/callback'))
        return Response.json({ success: true, data: {} });
      if (url.includes('/account'))
        return Response.json({
          success: true,
          data: {
            ownership: 'instance',
            connectedAs: null,
            shared: { usable: true, connected: false },
          },
        });
      throw new Error(`Unexpected shared account fixture request: ${url}`);
    }),
  );
  mount(true);
  fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
  expect(
    await screen.findByRole('button', { name: 'Open sign-in page' }),
  ).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Redirected URL'), {
    target: {
      value: 'http://127.0.0.1:43143/callback?code=fixture&state=issued',
    },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Finish sign-in' }));
  await waitFor(() =>
    expect(requests.some((r) => r.url.endsWith('/oauth/callback'))).toBe(true),
  );
  expect(
    screen.queryByRole('button', { name: 'Disconnect your account' }),
  ).toBeNull();
});
