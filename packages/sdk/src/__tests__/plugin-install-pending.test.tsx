/** @vitest-environment jsdom */
import { pluginLifecycleUnapplied } from '@kontourai/station-contracts/plugin';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('../api', () => ({
  _getApiBase: vi.fn().mockResolvedValue('http://example.test'),
}));

import {
  requestPluginRegistryInstallAction,
  usePluginInstallMutation,
  usePluginRemoveMutation,
  usePluginUpdateMutation,
} from '../query-domains/plugin-mutations';

afterEach(() => vi.unstubAllGlobals());

/**
 * The body `POST /api/plugins/install` sent when activation outran its
 * deadline, as captured from the real route
 * (src-server/routes/plugins/__tests__/plugin-install-activation-pending.test.ts).
 */
const PENDING_BODY = {
  success: false,
  lifecycle: {
    selected: {
      scope: '463708ec-c341-435f-9e54-8e3864cdcb30',
      installation: 'slow-activation',
      generation: '566b3d1b-dfb8-4720-8fe2-3abc3f9c288c',
      artifact: {
        digest:
          'sha256:f5709e7923831bd3f6bdfe866efd210e44bce1c055cfb30d34fef9aa93745b53',
      },
      materialization: '3f76549b-0bf7-46cd-af6c-984701da448e',
      dataScope: 'c39b116a-6b43-4bb7-b73e-f7ceb9a34396',
      origin:
        'a43482bbcb409d2a886e2027a51b6971ab6043a2db9f3fbf8dcac79113ee911b',
    },
    previous: null,
    retainedPrevious: false,
    data: 'new',
  },
  plugin: {
    name: 'slow-activation',
    version: '1.0.0',
    hasBundle: false,
    agents: [],
  },
  tools: [],
  dependencies: [],
  permissions: {
    autoGranted: [],
    consentGranted: [],
    pendingConsent: [{ permission: 'plugin.server', tier: 'trusted' }],
    dependencies: [],
    withdrawn: [],
  },
  configurationActivation: {
    status: 'pending',
    reason:
      'Configuration was saved, but runtime activation did not finish within its deadline and is continuing in the background.',
  },
};

const consent = {
  permissions: ['plugin.server'],
  contentDigest: 'sha256:reviewed',
  dependencies: [],
};

function renderInstall() {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const hook = renderHook(() => usePluginInstallMutation(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  return { ...hook, client, invalidate };
}

test('an install saved without completing its activation resolves as saved, not as "Install failed"', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(PENDING_BODY, { status: 202 })),
  );
  const { result, unmount, client, invalidate } = renderInstall();
  try {
    let installed: unknown;
    await act(async () => {
      installed = await result.current.mutateAsync({
        source: '/plugin',
        consent,
      });
    });
    expect(pluginLifecycleUnapplied(installed)).toEqual({
      kind: 'activation',
      reason: PENDING_BODY.configurationActivation.reason,
    });
    expect(installed).toMatchObject({ plugin: { name: 'slow-activation' } });
    // The plugin's row now exists (Needs recovery), so the list refreshes.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['plugins'] });
  } finally {
    unmount();
    client.clear();
  }
});

test('a refusal is still a failure, including a 202 that does not say it was saved', async () => {
  const { result, unmount, client } = renderInstall();
  try {
    for (const [status, body, message] of [
      [
        400,
        { success: false, error: 'Consent did not cover it' },
        'Consent did not cover it',
      ],
      [202, { success: false }, 'Install failed'],
      [
        200,
        { ...PENDING_BODY, configurationActivation: undefined },
        'Install failed',
      ],
    ] as const) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json(body, { status })),
      );
      await act(async () => {
        await expect(
          result.current.mutateAsync({ source: '/plugin', consent }),
        ).rejects.toThrow(message);
      });
    }
  } finally {
    unmount();
    client.clear();
  }
});

test('the registry install reads the same saved response the same way', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(PENDING_BODY, { status: 202 })),
  );
  const installed = await requestPluginRegistryInstallAction(
    'slow-activation',
    'install',
    { consent },
  );
  expect(pluginLifecycleUnapplied(installed)?.kind).toBe('activation');
});

/**
 * Update and remove answer the same designed `202` (lifecycle routes in
 * src-server/routes/plugins/plugin-lifecycle-routes.ts): saved, not applied.
 */
test.each([
  ['update', 'Update failed'],
  ['remove', 'Remove failed'],
] as const)(
  'a saved %s resolves instead of reporting "%s"',
  async (kind, failure) => {
    const body = {
      success: false,
      plugin: { name: 'slow-activation', version: '1.1.0' },
      configurationActivation: { status: 'pending', reason: 'saved' },
    };
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result: hooks, unmount } = renderHook(
      () => ({
        update: usePluginUpdateMutation(),
        remove: usePluginRemoveMutation(),
      }),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      },
    );
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json(body, { status: 202 })),
      );
      let settled: unknown;
      await act(async () => {
        settled = await hooks.current[kind].mutateAsync('slow-activation');
      });
      expect(pluginLifecycleUnapplied(settled)?.kind).toBe('activation');
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['plugins'] });
      // Without the saved marker the same 202 is still the failure it was.
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json({ success: false }, { status: 202 })),
      );
      await act(async () => {
        await expect(
          hooks.current[kind].mutateAsync('slow-activation'),
        ).rejects.toThrow(failure);
      });
    } finally {
      unmount();
      client.clear();
    }
  },
);
