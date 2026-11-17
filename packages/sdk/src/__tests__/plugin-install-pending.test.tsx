/** @vitest-environment jsdom */
import { pluginLifecyclePending } from '@kontourai/station-contracts/plugin';
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

test('an install accepted with activation pending resolves as pending, not as "Install failed"', async () => {
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
    expect(pluginLifecyclePending(installed)).toEqual({
      kind: 'activation',
      reason: PENDING_BODY.configurationActivation.reason,
    });
    expect(installed).toMatchObject({ plugin: { name: 'slow-activation' } });
    // The plugin's row now exists (Activation pending), so the list refreshes.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['plugins'] });
  } finally {
    unmount();
    client.clear();
  }
});

test('a refusal is still a failure, including a 202 that does not say pending', async () => {
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

test('the registry install reads the same pending response the same way', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(PENDING_BODY, { status: 202 })),
  );
  const installed = await requestPluginRegistryInstallAction(
    'slow-activation',
    'install',
    { consent },
  );
  expect(pluginLifecyclePending(installed)?.kind).toBe('activation');
});
