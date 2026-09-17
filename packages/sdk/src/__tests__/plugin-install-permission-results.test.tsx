/** @vitest-environment jsdom */
import type { InstallResult } from '@kontourai/station-contracts/catalog';
import type { PluginInstallResult } from '@kontourai/station-contracts/plugin';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, expectTypeOf, test, vi } from 'vitest';

vi.mock('../api', () => ({
  _getApiBase: vi.fn().mockResolvedValue('http://example.test'),
}));

import { requestRegistryCatalogAction } from '../query-domains/catalogRequests';
import {
  requestPluginRegistryInstallAction,
  usePluginInstallMutation,
  usePluginRegistryInstallMutation,
} from '../query-domains/plugin-mutations';

afterEach(() => vi.unstubAllGlobals());

test('direct and registry SDK mutations expose current dependency permission status without casts', async () => {
  const payload = {
    success: true,
    permissions: {
      autoGranted: [],
      pendingConsent: [],
      dependencies: [
        {
          id: 'dependency',
          pendingConsent: [
            { permission: 'providers.register', tier: 'trusted' },
          ],
        },
      ],
    },
  } satisfies PluginInstallResult;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ json: async () => payload })),
  );
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const { result, unmount } = renderHook(
    () => ({
      direct: usePluginInstallMutation(),
      registry: usePluginRegistryInstallMutation(),
    }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  expectTypeOf(result.current.direct.data).toEqualTypeOf<
    PluginInstallResult | undefined
  >();
  expectTypeOf(result.current.registry.data).toEqualTypeOf<
    PluginInstallResult | undefined
  >();
  try {
    await act(async () => {
      const direct = await result.current.direct.mutateAsync({
        source: '/plugin',
        consent: {
          permissions: [],
          contentDigest: 'sha256:reviewed',
          dependencies: [],
        },
      });
      const registry = await result.current.registry.mutateAsync({
        id: 'plugin',
        action: 'install',
      });
      expect(direct.permissions?.dependencies).toEqual(
        payload.permissions.dependencies,
      );
      expect(registry.permissions?.dependencies).toEqual(
        payload.permissions.dependencies,
      );
    });
    const catalog = await requestRegistryCatalogAction('plugins', {
      id: 'plugin',
      action: 'install',
    });
    expectTypeOf(catalog).toEqualTypeOf<PluginInstallResult>();
    expect(catalog.permissions?.dependencies).toEqual(
      payload.permissions.dependencies,
    );
    const directRegistry = await requestPluginRegistryInstallAction(
      'plugin',
      'install',
    );
    expectTypeOf(directRegistry).toEqualTypeOf<PluginInstallResult>();
    expect(directRegistry.permissions?.dependencies).toEqual(
      payload.permissions.dependencies,
    );
  } finally {
    unmount();
    client.clear();
  }
});

test('older plugin responses retain unknown status and non-plugin catalogs keep InstallResult', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      json: async () => ({ success: true, message: 'installed' }),
    })),
  );
  const plugin = await requestRegistryCatalogAction('plugins', {
    id: 'plugin',
    action: 'install',
  });
  expect(plugin.permissions?.dependencies).toBeUndefined();
  const integration = await requestRegistryCatalogAction('integrations', {
    id: 'integration',
    action: 'install',
  });
  expectTypeOf(integration).toEqualTypeOf<InstallResult>();
  expect(integration).toEqual({ success: true, message: 'installed' });
});
