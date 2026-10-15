/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { _setApiBase } from '../api';
import {
  useFinishIntegrationOAuthMutation,
  useIntegrationAccountQuery,
  useStartIntegrationOAuthMutation,
} from '../query-domains/catalog';

afterEach(() => vi.unstubAllGlobals());

test('remote sign-in keeps project scope and removes callback variables after its observer leaves', async () => {
  _setApiBase('http://station.test');
  const fetch = vi.fn().mockImplementation(async (url: string) =>
    Response.json({
      success: true,
      data: url.includes('/account')
        ? { connectedAs: 'you-in-project' }
        : { authorizationUrl: 'https://signin.example.test/authorize' },
    }),
  );
  vi.stubGlobal('fetch', fetch);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    () => ({
      account: useIntegrationAccountQuery('reports', 'my project'),
      start: useStartIntegrationOAuthMutation(),
      finish: useFinishIntegrationOAuthMutation(),
    }),
    { wrapper },
  );
  await waitFor(() =>
    expect(hook.result.current.account.data?.connectedAs).toBe(
      'you-in-project',
    ),
  );
  await act(async () => {
    await hook.result.current.start.mutateAsync({
      id: 'reports',
      projectSlug: 'my project',
    });
    await hook.result.current.finish.mutateAsync({
      id: 'reports',
      projectSlug: 'my project',
      callbackUrl: 'http://localhost/callback?code=private-code',
    });
  });
  expect(
    fetch.mock.calls.some(([url]) =>
      url.endsWith('/reports/account?projectSlug=my%20project'),
    ),
  ).toBe(true);
  const authorize = fetch.mock.calls.find(([url]) =>
    url.endsWith('/reports/oauth/authorize'),
  );
  expect(JSON.parse(authorize?.[1].body)).toEqual({
    mode: 'remote',
    projectSlug: 'my project',
  });
  const callback = fetch.mock.calls.find(([url]) =>
    url.endsWith('/reports/oauth/callback'),
  );
  expect(JSON.parse(callback?.[1].body)).toEqual({
    projectSlug: 'my project',
    callbackUrl: 'http://localhost/callback?code=private-code',
  });
  hook.unmount();
  await waitFor(() =>
    expect(
      client
        .getMutationCache()
        .getAll()
        .some((mutation) =>
          JSON.stringify(mutation.state.variables).includes('private-code'),
        ),
    ).toBe(false),
  );
  client.clear();
});
