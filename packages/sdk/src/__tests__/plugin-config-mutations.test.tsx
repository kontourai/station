/** @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('../api', () => ({
  _getApiBase: async () => 'https://station.example',
}));

import {
  usePluginProviderToggleMutation,
  usePluginSettingsMutation,
} from '../query-domains/plugin-mutations';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test.each(['settings', 'providers'] as const)(
  '%s refusal is not retried under custom mutation defaults and refreshes current state',
  async (kind) => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json(
        {
          success: false,
          error: 'Settings may have been saved. Refresh before retrying.',
        },
        { status: 409 },
      ),
    );
    vi.stubGlobal('fetch', fetch);
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: 3, retryDelay: 0 } },
    });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    if (kind === 'settings') {
      const hook = renderHook(() => usePluginSettingsMutation(), { wrapper });
      await act(async () => {
        await expect(
          hook.result.current.mutateAsync({
            name: 'fixture',
            settings: { label: 'next' },
          }),
        ).rejects.toThrow('may have been saved');
      });
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ['plugin-settings', 'fixture'],
      });
    } else {
      const hook = renderHook(() => usePluginProviderToggleMutation(), {
        wrapper,
      });
      await act(async () => {
        await expect(
          hook.result.current.mutateAsync({
            pluginName: 'fixture',
            disabled: ['branding'],
          }),
        ).rejects.toThrow('may have been saved');
      });
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ['plugin-providers', 'fixture'],
      });
    }
    expect(fetch).toHaveBeenCalledOnce();
    client.clear();
  },
);
