// @vitest-environment jsdom
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

const scope = {
  apiBase: 'https://accounts.example.test',
  authorityKey: 'operator-test',
  isCurrent: () => true,
};
vi.mock('../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => scope,
}));
const openLink = vi.fn();
vi.mock('../platform/openExternalLink', () => ({
  openExternalLink: (url: string) => openLink(url),
}));

import { EngineAccountOverview } from '../views/EngineAccountOverview';

afterEach(() => {
  setClientCredentialResolver(undefined);
  openLink.mockClear();
});

test.each([
  ['claude', true],
  ['codex', true],
  ['claude', false],
  ['codex', false],
] as const)(
  'the %s account page completes sign-in with management access=%s',
  async (engine, management) => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const calls: Array<{ path: string; method: string; body?: string }> = [];
    let started = false,
      done = false,
      refused = true,
      workExists = true;
    const reply = (data: unknown) =>
      new Response(JSON.stringify(data), {
        headers: { 'Content-Type': 'application/json' },
      });
    setClientCredentialResolver(() => ({
      origin: scope.apiBase,
      requestAuthority: scope,
      transport: async (url, init) => {
        const u = new URL(String(url));
        const method = init?.method ?? 'GET';
        calls.push({
          path: u.pathname + u.search,
          method,
          body: typeof init?.body === 'string' ? init.body : undefined,
        });
        if (u.pathname === '/api/auth/authority')
          return reply({
            schemaVersion: 'station.authority-observation/v1',
            environmentId: 'test',
            principal: { kind: 'human', id: 'human:local:operator' },
            grant: management
              ? { kind: 'operator' }
              : {
                  kind: 'device',
                  deviceId: 'login-device',
                  grantedScopes: ['orchestration:read', 'engine:login'],
                },
          });
        if (u.pathname.endsWith('/accounts'))
          return reply({
            success: true,
            data: {
              engine,
              activeProfileRef: null,
              accounts: [
                {
                  ref: null,
                  label: 'Default account',
                  authState: 'authenticated',
                  login: engine === 'claude' ? 'browser-code' : 'device-code',
                },
                {
                  ref: 'work',
                  label: 'Work',
                  authState: done ? 'authenticated' : 'unauthenticated',
                  login: engine === 'claude' ? 'browser-code' : 'device-code',
                },
              ].filter((account) => workExists || account.ref !== 'work'),
            },
          });
        if (u.pathname.endsWith('/account-usage'))
          return reply({
            success: true,
            data: {
              status: 'ok',
              fetchedAt: '2026-10-01T12:00:00Z',
              planLabel: 'Team',
              exhausted: false,
              windows: [
                {
                  id: 'five-hour',
                  label: '5 hour',
                  usedPercent: u.searchParams.has('profileRef') ? 80 : 20,
                  resetsAt: '2026-10-01T18:00:00Z',
                },
              ],
            },
          });
        if (u.pathname.endsWith('/account-login')) {
          if (method === 'POST' && refused) {
            refused = false;
            return new Response(
              JSON.stringify({
                success: false,
                error: 'Another sign-in is starting. Try again shortly.',
                data: { outcome: 'busy' },
              }),
              { status: 409, headers: { 'Content-Type': 'application/json' } },
            );
          }
          if (method === 'POST') {
            const body = JSON.parse(String(init?.body));
            started = true;
            if (engine === 'claude' && body.code === 'AUTH#STATE') done = true;
          }
          return reply({
            success: true,
            data: {
              login: !started
                ? null
                : {
                    engine,
                    mechanism:
                      engine === 'claude' ? 'browser-code' : 'device-code',
                    phase: done
                      ? 'completed'
                      : engine === 'claude'
                        ? 'awaiting-code'
                        : 'awaiting-approval',
                    startedAt: '2026-10-01T12:00:00Z',
                    expiresAt: '2026-10-01T12:15:00Z',
                    verificationUri:
                      'https://claude.com/cai/oauth/authorize?state=fixture',
                    ...(engine === 'codex' ? { userCode: 'ABCD-1234' } : {}),
                  },
            },
          });
        }
        if (u.pathname === '/api/analytics/usage-rollup') {
          expect(u.searchParams.get('provider')).toBe(engine);
          expect(u.searchParams.get('localOnly')).toBe('1');
          return reply({
            success: true,
            data: {
              window: { from: '2026-09-25', to: '2026-10-01' },
              coverage: [
                {
                  stationId: 'test',
                  state: 'partial',
                  window: { from: '2026-09-25', to: '2026-10-01' },
                },
              ],
              receipts: [],
              rows: [
                {
                  key: 'day1',
                  stationId: 'test',
                  provider: engine,
                  day: '2026-09-30',
                  inputTokens: 100,
                  outputTokens: 20,
                  ...(engine === 'claude'
                    ? { reportedCost: { amount: 2, currency: 'USD' } }
                    : { estimatedCost: { amount: 2, currency: 'USD' } }),
                  pricingStatus: 'unpriced',
                  receiptCount: 1,
                },
              ],
            },
          });
        }
        throw new Error(`Unexpected request ${method} ${u.pathname}`);
      },
    }));
    const mounted = render(
      <QueryClientProvider client={client}>
        <EngineAccountOverview engine={engine} connectionId={engine} />
      </QueryClientProvider>,
    );
    if (management) await screen.findByText('80% left');
    else
      await screen.findByText(
        'Limit access requires credential-management permission.',
      );
    fireEvent.change(screen.getByRole('combobox', { name: 'Account' }), {
      target: { value: 'work' },
    });
    if (management) await screen.findByText('20% left');
    const signIn = await screen.findByRole('button', { name: 'Sign in' });
    await waitFor(() => expect(signIn).toHaveProperty('disabled', false));
    fireEvent.click(signIn);
    await screen.findByText('Another sign-in is starting. Try again shortly.');
    fireEvent.click(screen.getByRole('button', { name: 'Check status' }));
    await waitFor(() => expect(signIn).toHaveProperty('disabled', false));
    fireEvent.click(signIn);
    await screen.findByRole('button', {
      name: `Open ${engine === 'claude' ? 'Claude' : 'OpenAI'} sign-in`,
    });
    if (engine === 'claude') {
      fireEvent.change(screen.getByLabelText('Code from Claude'), {
        target: { value: 'AUTH#STATE' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Finish sign-in' }));
      await waitFor(() =>
        expect(screen.getAllByText('Signed in').length).toBeGreaterThan(0),
      );
      expect(
        calls.some(
          (c) =>
            c.body?.includes('AUTH#STATE') &&
            c.path.includes('profileRef=work'),
        ),
      ).toBe(true);
      expect(window.localStorage.length).toBe(0);
    } else expect(await screen.findByText('ABCD-1234')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    if (management) {
      expect(await screen.findByText('$2.00')).toBeTruthy();
      expect(screen.getByTitle('2026-09-25: Not reported')).toBeTruthy();
      expect(
        screen.getByText(
          engine === 'claude' ? 'Daily reported cost' : 'Daily estimated cost',
        ),
      ).toBeTruthy();
    } else {
      expect(
        calls.filter((c) => c.path.includes('account-usage')),
      ).toHaveLength(0);
      expect(calls.filter((c) => c.path.includes('usage-rollup'))).toHaveLength(
        0,
      );
    }
    expect(
      screen.getByText('This Station · this engine · all accounts'),
    ).toBeTruthy();
    if (management)
      expect(screen.getByText('Some activity is missing.')).toBeTruthy();
    if (management) {
      workExists = false;
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
      await screen.findByText('80% left');
    }
    mounted.unmount();
    client.clear();
  },
);
