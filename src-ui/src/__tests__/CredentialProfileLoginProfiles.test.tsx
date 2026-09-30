// @vitest-environment jsdom
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

const scope = {
  apiBase: 'https://login.example.test',
  authorityKey: 'login-device',
  isCurrent: () => true,
};
vi.mock('../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => scope,
}));

import { CredentialProfileAccess } from '../views/CredentialProfileLoginProfiles';

afterEach(() => setClientCredentialResolver(undefined));

test('a login-only device signs in through the safe profile projection without mounting management', async () => {
  const calls: string[] = [];
  let completed = false;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const management = vi.fn(() => <p>Management mounted</p>);
  setClientCredentialResolver(() => ({
    origin: scope.apiBase,
    requestAuthority: scope,
    transport: async (url, init) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${path}`);
      const reply = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });
      if (path === '/api/auth/authority')
        return reply({
          schemaVersion: 'station.authority-observation/v1',
          environmentId: 'smoke-host',
          principal: { kind: 'human', id: 'human:device:login-device' },
          grant: {
            kind: 'device',
            deviceId: 'login-device',
            grantedScopes: ['engine:login'],
          },
        });
      if (path.endsWith('/device-code-profiles'))
        return reply({
          success: true,
          data: {
            profiles: [
              {
                ref: 'smoke-profile',
                label: 'Smoke profile',
                authState: completed ? 'authenticated' : 'unauthenticated',
                mechanisms: ['device-code'],
              },
            ],
          },
        });
      if (path.endsWith('/device-code')) {
        if (method === 'POST') completed = true;
        if (!completed)
          return reply(
            { success: false, error: 'No sign-in is running.' },
            404,
          );
        return reply({
          success: true,
          data: {
            login: {
              engine: 'codex',
              phase: 'completed',
              startedAt: '2026-09-30T00:00:00Z',
              expiresAt: '2026-09-30T00:15:00Z',
            },
          },
        });
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    },
  }));
  const Management = management;
  const view = () => (
    <QueryClientProvider client={client}>
      <CredentialProfileAccess connectionId="codex">
        <Management />
      </CredentialProfileAccess>
    </QueryClientProvider>
  );
  const mounted = render(view());
  await screen.findByText('Smoke profile');
  const signIn = await screen.findByRole('button', { name: 'Sign in' });
  await waitFor(() => expect(signIn).toHaveProperty('disabled', false));
  fireEvent.click(signIn);
  await waitFor(() =>
    expect(screen.getAllByText('Signed in').length).toBeGreaterThan(0),
  );
  mounted.rerender(view());
  expect(management).not.toHaveBeenCalled();
  expect(calls).toContain(
    'POST /api/connections/agent/codex/enrolment/smoke-profile/device-code',
  );
  expect(
    calls.filter(
      (path) =>
        path.includes('credential-recovery') ||
        /enrolment\/smoke-profile$/.test(path),
    ),
  ).toEqual([]);
  expect(
    calls.filter((path) => path.endsWith('/device-code-profiles')).length,
  ).toBeGreaterThan(1);
  expect(screen.queryByText('Show sign-in command')).toBeNull();
});
