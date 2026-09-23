/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('../api', () => ({
  _getApiBase: vi.fn().mockResolvedValue('http://example.test'),
}));

import {
  useDismissPluginLifecycleProposalMutation,
  usePluginInstallMutation,
  usePluginRemoveMutation,
  usePluginUpdateMutation,
} from '../query-domains/plugin-mutations';

afterEach(() => vi.unstubAllGlobals());

/**
 * #2323 S5: a lifecycle change that completes a proposal says which one, and
 * refreshes the inbox the proposal was listed in. The plain name form every
 * existing caller uses sends exactly what it sent before.
 */
test('install, update and remove carry the proposal id; the plain forms do not', async () => {
  const fetchMock = vi.fn(async () => ({
    json: async () => ({ success: true }),
  }));
  vi.stubGlobal('fetch', fetchMock);
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const { result, unmount } = renderHook(
    () => ({
      install: usePluginInstallMutation(),
      update: usePluginUpdateMutation(),
      remove: usePluginRemoveMutation(),
      dismiss: useDismissPluginLifecycleProposalMutation(),
    }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  try {
    await act(async () => {
      await result.current.install.mutateAsync({
        source: '/plugin',
        consent: { permissions: [], contentDigest: 'sha256:x' },
        proposalId: 'p-install',
      });
      await result.current.update.mutateAsync({
        name: 'pulse',
        proposalId: 'p-update',
      });
      await result.current.remove.mutateAsync({
        name: 'pulse',
        proposalId: 'p-remove',
      });
      await result.current.update.mutateAsync('pulse');
      await result.current.remove.mutateAsync('pulse');
      await result.current.dismiss.mutateAsync('p-dismiss');
    });
    const calls = fetchMock.mock.calls as unknown as Array<
      [string, RequestInit]
    >;
    expect(JSON.parse(String(calls[0][1].body))).toMatchObject({
      source: '/plugin',
      proposalId: 'p-install',
    });
    expect(calls.slice(1).map(([url, init]) => [init.method, url])).toEqual([
      [
        'POST',
        'http://example.test/api/plugins/pulse/update?proposalId=p-update',
      ],
      ['DELETE', 'http://example.test/api/plugins/pulse?proposalId=p-remove'],
      ['POST', 'http://example.test/api/plugins/pulse/update'],
      ['DELETE', 'http://example.test/api/plugins/pulse'],
      ['POST', 'http://example.test/api/plugin-proposals/p-dismiss/dismiss'],
    ]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['attention'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['plugin-proposals'] });
  } finally {
    unmount();
    client.clear();
  }
});
