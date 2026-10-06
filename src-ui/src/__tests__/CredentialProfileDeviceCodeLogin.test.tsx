// @vitest-environment jsdom
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import type { DeviceCodeLogin } from '@kontourai/station-sdk/device-code-login';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const scope = {
  apiBase: 'https://station.example.test',
  authorityKey: 'device-a',
  isCurrent: () => true,
};
vi.mock('../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => scope,
}));

import { CredentialProfileDeviceCodeLogin } from '../views/CredentialProfileDeviceCodeLogin';

let client: QueryClient;
let grantedScopes: string[];
let login: DeviceCodeLogin | null;
let loginPath: string;
let failStatusRead: boolean;
let releaseStart: (() => void) | undefined;
let holdStart: boolean;
let refusal: { outcome: string; status: number } | undefined;
const onCompleted = vi.fn();
const calls: Array<{ path: string; method: string }> = [];
const waitingLogin: DeviceCodeLogin = {
  engine: 'codex',
  phase: 'awaiting-approval',
  startedAt: '2026-09-29T12:00:00Z',
  expiresAt: '2026-09-29T12:15:00Z',
  verificationUri: 'https://auth.openai.com/codex/device',
  userCode: 'ABCD-1234',
};
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  grantedScopes = ['engine:login'];
  login = null;
  loginPath = '/api/connections/agent/codex/enrolment/work-account/device-code';
  failStatusRead = false;
  releaseStart = undefined;
  holdStart = false;
  refusal = undefined;
  calls.length = 0;
  onCompleted.mockClear();
  setClientCredentialResolver(() => ({
    origin: scope.apiBase,
    requestAuthority: scope,
    transport: async (url, init) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? 'GET';
      calls.push({ path, method });
      if (path === '/api/auth/authority')
        return response({
          schemaVersion: 'station.authority-observation/v1',
          environmentId: 'station-a',
          principal: { kind: 'human', id: 'human:local:operator' },
          grant: { kind: 'device', deviceId: 'device-a', grantedScopes },
        });
      if (path.endsWith('/device-code')) {
        if (method === 'GET' && failStatusRead)
          return response({ success: false, error: 'Temporary outage' }, 503);
        if (method === 'POST') {
          if (refusal)
            return response(
              {
                success: false,
                error: `Sign-in refused: ${refusal.outcome}`,
                data: { outcome: refusal.outcome },
              },
              refusal.status,
            );
          loginPath = path;
          login = { ...waitingLogin };
          if (holdStart)
            await new Promise<void>((resolve) => {
              releaseStart = resolve;
            });
        }
        if (method === 'DELETE' && login)
          login = { ...login, phase: 'cancelled' };
        return login && path === loginPath
          ? response({ success: true, data: { login } })
          : response(
              { success: false, error: 'No device login has been started.' },
              404,
            );
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    },
  }));
});
afterEach(() => {
  client.clear();
  setClientCredentialResolver(undefined);
});
function mount(profileRef = 'work-account') {
  return render(
    <QueryClientProvider client={client}>
      <CredentialProfileDeviceCodeLogin
        connectionId="codex"
        profileRef={profileRef}
        authState="unauthenticated"
        onCompleted={onCompleted}
      />
    </QueryClientProvider>,
  );
}

test('starts profile sign-in, shows the code and link, and polls until engine confirmation', async () => {
  mount('work / account');
  const button = await screen.findByRole('button', { name: 'Sign in' });
  await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
  fireEvent.click(button);
  expect(await screen.findByText('ABCD-1234')).toBeTruthy();
  expect(
    screen
      .getByRole('link', { name: 'Open verification page' })
      .getAttribute('href'),
  ).toBe(waitingLogin.verificationUri);
  expect(calls).toContainEqual({
    path: '/api/connections/agent/codex/enrolment/work%20%2F%20account/device-code',
    method: 'POST',
  });
  expect(onCompleted).not.toHaveBeenCalled();
  login = { ...waitingLogin, phase: 'completed' };
  expect(
    await screen.findByText('The engine confirmed you are signed in.'),
  ).toBeTruthy();
  expect(onCompleted).toHaveBeenCalledOnce();
  expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
});

test('cancels an existing login after remount through the profile DELETE route', async () => {
  login = { ...waitingLogin };
  mount();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Cancel sign-in' }),
  );
  expect(await screen.findByText('Sign-in cancelled.')).toBeTruthy();
  expect(calls).toContainEqual({
    path: '/api/connections/agent/codex/enrolment/work-account/device-code',
    method: 'DELETE',
  });
  expect(onCompleted).not.toHaveBeenCalled();
});

test('withholds sign-in and explains the required grant when this device lacks it', async () => {
  grantedScopes = [];
  mount();
  expect(await screen.findByText('Start engine sign-in')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
  expect(calls.some((call) => call.path.endsWith('/device-code'))).toBe(false);
});

test.each([
  ['unsupported', 409],
  ['busy', 429],
  ['closed', 503],
  ['already-signed-in', 409],
  ['sign-in-state-unknown', 409],
  ['cancelled', 409],
] as const)(
  'shows the %s refusal without claiming a login started',
  async (outcome, status) => {
    refusal = { outcome, status };
    mount();
    const button = await screen.findByRole('button', { name: 'Sign in' });
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
    fireEvent.click(button);
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      `Sign-in refused: ${outcome}`,
    );
    expect(screen.queryByRole('button', { name: 'Cancel sign-in' })).toBeNull();
    expect(onCompleted).not.toHaveBeenCalled();
  },
);

test('refuses an unsafe verification link and keeps it out of the UI', async () => {
  login = { ...waitingLogin, verificationUri: 'javascript:alert(1)' };
  mount();
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.queryByRole('link')).toBeNull();
});

test('a polling failure preserves the running login and an explicit check recovers it', async () => {
  login = { ...waitingLogin };
  mount();
  expect(await screen.findByText('ABCD-1234')).toBeTruthy();
  failStatusRead = true;
  expect(
    await screen.findByText(
      'Could not refresh sign-in status. The login may still be running.',
    ),
  ).toBeTruthy();
  expect(screen.getByText('ABCD-1234')).toBeTruthy();
  expect(onCompleted).not.toHaveBeenCalled();
  failStatusRead = false;
  login = { ...waitingLogin, phase: 'completed' };
  fireEvent.click(screen.getByRole('button', { name: 'Check sign-in status' }));
  expect(
    await screen.findByText('The engine confirmed you are signed in.'),
  ).toBeTruthy();
  expect(onCompleted).toHaveBeenCalledOnce();
});

test('a delayed start reply remains in the old profile cache after switching profiles', async () => {
  holdStart = true;
  const view = mount();
  const button = await screen.findByRole('button', { name: 'Sign in' });
  await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
  fireEvent.click(button);
  await waitFor(() => expect(releaseStart).toBeDefined());
  view.rerender(
    <QueryClientProvider client={client}>
      <CredentialProfileDeviceCodeLogin
        connectionId="codex"
        profileRef="another-account"
        authState="unauthenticated"
        onCompleted={onCompleted}
      />
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Sign in' }).hasAttribute('disabled'),
    ).toBe(false),
  );
  releaseStart?.();
  await waitFor(() =>
    expect(
      client.getQueryData([
        'device-code-login',
        scope.apiBase,
        scope.authorityKey,
        'codex',
        'work-account',
      ]),
    ).toMatchObject({ phase: 'awaiting-approval' }),
  );
  expect(
    client.getQueryData([
      'device-code-login',
      scope.apiBase,
      scope.authorityKey,
      'codex',
      'another-account',
    ]),
  ).toBeNull();
  expect(screen.queryByText('ABCD-1234')).toBeNull();
  expect(onCompleted).not.toHaveBeenCalled();
});
