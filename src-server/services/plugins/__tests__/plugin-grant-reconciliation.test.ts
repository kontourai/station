import { describe, expect, test, vi } from 'vitest';
import {
  createPluginGrantReconciliationService,
  type PluginGrantReconciliationAdapters,
  type PluginGrantRuntimeSnapshot,
} from '../plugin-grant-reconciliation.js';

function harness(
  initial: PluginGrantRuntimeSnapshot = {
    installed: true,
    installationGeneration: 'sha256:generation-1',
    providerGeneration: 1,
    grants: [],
  },
) {
  let snapshot = initial;
  const order: string[] = [];
  const adapters: PluginGrantReconciliationAdapters = {
    snapshot: vi.fn(async () => snapshot),
    quiesceModule: vi.fn(async () => ({
      release: () => order.push('release-module'),
    })),
    quiesceSubscriptions: vi.fn(async () => ({
      release: () => order.push('release-subscriptions'),
    })),
    retireProviders: vi.fn(async (_pluginName, expectedGeneration) => {
      order.push('retire-providers');
      if (snapshot.providerGeneration !== expectedGeneration)
        return 'superseded' as const;
      snapshot = {
        ...snapshot,
        providerGeneration: snapshot.providerGeneration + 1,
      };
      return 'retired' as const;
    }),
    activateProviders: vi.fn(async () => {
      order.push('activate-providers');
      snapshot = {
        ...snapshot,
        providerGeneration: snapshot.providerGeneration + 1,
      };
      return 'activated' as const;
    }),
    settleProviderAdapters: vi.fn(async () => {
      order.push('settle-adapters');
    }),
    removeEngineConnections: vi.fn(async () => {
      order.push('remove-connections');
      return 'removed' as const;
    }),
    reconcileEngineConnections: vi.fn(async () => {
      order.push('reconcile-connections');
    }),
    reconcileSubscriptions: vi.fn(async () => {
      order.push('reconcile-subscriptions');
      return { kind: 'applied' as const };
    }),
  };
  return {
    adapters,
    order,
    setSnapshot(next: PluginGrantRuntimeSnapshot) {
      snapshot = next;
    },
  };
}

describe('plugin grant reconciliation', () => {
  test('drains module/subscription work before retiring providers and connections', async () => {
    const fixture = harness();
    let releaseModule!: () => void;
    const moduleDrained = new Promise<void>((resolve) => {
      releaseModule = resolve;
    });
    vi.mocked(fixture.adapters.quiesceModule).mockImplementation(async () => {
      fixture.order.push('quiesce-module');
      await moduleDrained;
      return { release: () => fixture.order.push('release-module') };
    });
    vi.mocked(fixture.adapters.quiesceSubscriptions).mockImplementation(
      async () => {
        fixture.order.push('quiesce-subscriptions');
        return {
          release: () => fixture.order.push('release-subscriptions'),
        };
      },
    );
    const service = createPluginGrantReconciliationService(fixture.adapters, {
      responseDeadlineMs: 1_000,
    });

    const pending = service.reconcile({
      pluginName: 'provider-plugin',
      permissions: ['providers.register', 'plugin.server', 'events.subscribe'],
    });
    await vi.waitFor(() =>
      expect(fixture.order).toEqual([
        'quiesce-subscriptions',
        'quiesce-module',
      ]),
    );
    expect(fixture.adapters.retireProviders).not.toHaveBeenCalled();
    releaseModule();

    await expect(pending).resolves.toMatchObject({ status: 'completed' });
    expect(fixture.order).toEqual([
      'quiesce-subscriptions',
      'quiesce-module',
      'retire-providers',
      'settle-adapters',
      'remove-connections',
      'release-module',
      'release-subscriptions',
      'reconcile-subscriptions',
    ]);
  });

  test('supersedes a stale revocation and activates the regranted generation', async () => {
    const fixture = harness();
    let releaseModule!: () => void;
    const moduleDrained = new Promise<void>((resolve) => {
      releaseModule = resolve;
    });
    vi.mocked(fixture.adapters.quiesceModule).mockImplementation(async () => {
      await moduleDrained;
      return { release: vi.fn() };
    });
    const service = createPluginGrantReconciliationService(fixture.adapters, {
      responseDeadlineMs: 1_000,
    });
    const revoked = service.reconcile({
      pluginName: 'provider-plugin',
      permissions: ['plugin.server'],
    });
    await vi.waitFor(() =>
      expect(fixture.adapters.quiesceModule).toHaveBeenCalledOnce(),
    );
    fixture.setSnapshot({
      installed: true,
      installationGeneration: 'sha256:generation-1',
      providerGeneration: 1,
      grants: ['providers.register'],
    });
    const regranted = service.reconcile({
      pluginName: 'provider-plugin',
      permissions: ['providers.register'],
    });
    releaseModule();

    await expect(revoked).resolves.toMatchObject({ status: 'superseded' });
    await expect(regranted).resolves.toMatchObject({ status: 'completed' });
    expect(fixture.adapters.retireProviders).not.toHaveBeenCalled();
    expect(fixture.adapters.activateProviders).toHaveBeenCalledOnce();
    expect(fixture.adapters.reconcileEngineConnections).toHaveBeenCalledOnce();
  });

  test('inherits disjoint pending lifecycle permissions when a newer revoke supersedes cleanup', async () => {
    const fixture = harness();
    let releaseAdapterDrain!: () => void;
    const adapterDrain = new Promise<void>((resolve) => {
      releaseAdapterDrain = resolve;
    });
    vi.mocked(fixture.adapters.settleProviderAdapters).mockImplementationOnce(
      async () => {
        fixture.order.push('settle-adapters-blocked');
        await adapterDrain;
      },
    );
    const service = createPluginGrantReconciliationService(fixture.adapters, {
      responseDeadlineMs: 1_000,
    });
    const providerRevoke = service.reconcile({
      pluginName: 'provider-plugin',
      permissions: ['providers.register'],
    });
    await vi.waitFor(() =>
      expect(fixture.order).toContain('settle-adapters-blocked'),
    );
    const serverRevoke = service.reconcile({
      pluginName: 'provider-plugin',
      permissions: ['plugin.server'],
    });
    releaseAdapterDrain();

    await expect(providerRevoke).resolves.toMatchObject({
      status: 'superseded',
    });
    await expect(serverRevoke).resolves.toMatchObject({ status: 'completed' });
    expect(fixture.adapters.retireProviders).toHaveBeenCalledTimes(2);
    expect(fixture.adapters.removeEngineConnections).toHaveBeenCalledOnce();
    expect(fixture.adapters.quiesceModule).toHaveBeenCalledOnce();
  });

  test('passes the exact installation generation into retained provider activation and honors supersession', async () => {
    const fixture = harness({
      installed: true,
      installationGeneration: 'sha256:generation-1',
      providerGeneration: 4,
      grants: ['providers.register'],
    });
    vi.mocked(fixture.adapters.activateProviders).mockResolvedValueOnce(
      'superseded',
    );
    const service = createPluginGrantReconciliationService(fixture.adapters);

    await expect(
      service.reconcile({
        pluginName: 'provider-plugin',
        permissions: ['providers.register'],
      }),
    ).resolves.toMatchObject({ status: 'superseded' });
    expect(fixture.adapters.activateProviders).toHaveBeenCalledWith(
      'provider-plugin',
      {
        installed: true,
        installationGeneration: 'sha256:generation-1',
        providerGeneration: 4,
      },
    );
    expect(fixture.adapters.reconcileEngineConnections).not.toHaveBeenCalled();
  });

  test('refuses to retire a different installed generation', async () => {
    const fixture = harness();
    vi.mocked(fixture.adapters.quiesceModule).mockImplementation(async () => {
      fixture.setSnapshot({
        installed: true,
        installationGeneration: 'sha256:generation-2',
        providerGeneration: 1,
        grants: [],
      });
      return { release: vi.fn() };
    });
    const service = createPluginGrantReconciliationService(fixture.adapters);

    await expect(
      service.reconcile({
        pluginName: 'provider-plugin',
        permissions: ['plugin.server', 'providers.register'],
      }),
    ).resolves.toMatchObject({ status: 'superseded' });
    expect(fixture.adapters.retireProviders).not.toHaveBeenCalled();
  });

  test('does not remove connections from a provider generation published during adapter drain', async () => {
    const fixture = harness();
    vi.mocked(fixture.adapters.settleProviderAdapters).mockImplementation(
      async () => {
        fixture.setSnapshot({
          installed: true,
          installationGeneration: 'sha256:generation-1',
          providerGeneration: 3,
          grants: [],
        });
      },
    );
    const service = createPluginGrantReconciliationService(fixture.adapters);

    await expect(
      service.reconcile({
        pluginName: 'provider-plugin',
        permissions: ['providers.register'],
      }),
    ).resolves.toMatchObject({ status: 'superseded' });
    expect(fixture.adapters.removeEngineConnections).not.toHaveBeenCalled();
  });

  test('does not remove replacement connections when a regrant wins after the final snapshot but before deletion', async () => {
    const fixture = harness();
    let removed = false;
    vi.mocked(fixture.adapters.removeEngineConnections).mockImplementation(
      async (_pluginName, expected) => {
        fixture.setSnapshot({
          installed: true,
          installationGeneration: 'sha256:generation-2',
          providerGeneration: expected.providerGeneration + 1,
          grants: ['providers.register'],
        });
        if (
          expected.installationGeneration !== 'sha256:generation-2' ||
          expected.providerGeneration !== 3
        ) {
          return 'superseded';
        }
        removed = true;
        return 'removed';
      },
    );
    const service = createPluginGrantReconciliationService(fixture.adapters);

    await expect(
      service.reconcile({
        pluginName: 'provider-plugin',
        permissions: ['providers.register'],
      }),
    ).resolves.toMatchObject({ status: 'superseded' });
    expect(fixture.adapters.removeEngineConnections).toHaveBeenCalledWith(
      'provider-plugin',
      {
        installed: true,
        installationGeneration: 'sha256:generation-1',
        providerGeneration: 2,
      },
    );
    expect(removed).toBe(false);
  });

  test('reports winding-down while retaining ownership of a slow drain', async () => {
    const fixture = harness();
    let releaseDrain!: () => void;
    const drain = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    vi.mocked(fixture.adapters.quiesceModule).mockImplementation(async () => {
      await drain;
      return { release: vi.fn() };
    });
    const service = createPluginGrantReconciliationService(fixture.adapters, {
      responseDeadlineMs: 1,
    });

    const result = await service.reconcile({
      pluginName: 'provider-plugin',
      permissions: ['plugin.server'],
    });
    expect(result).toMatchObject({
      status: 'winding-down',
      operationId: expect.any(String),
      generation: 1,
    });
    releaseDrain();
    await vi.waitFor(() =>
      expect(service.inspect('provider-plugin')).toMatchObject({
        status: 'completed',
        operationId: result.operationId,
        generation: 1,
      }),
    );
  });

  test('continues independent cleanup and reports exact partial failures', async () => {
    const fixture = harness();
    vi.mocked(fixture.adapters.retireProviders).mockRejectedValue(
      new Error('registry unavailable'),
    );
    const service = createPluginGrantReconciliationService(fixture.adapters);

    await expect(
      service.reconcile({
        pluginName: 'provider-plugin',
        permissions: ['providers.register'],
      }),
    ).resolves.toMatchObject({
      status: 'incomplete',
      failures: ['provider-retirement'],
    });
    expect(fixture.adapters.settleProviderAdapters).toHaveBeenCalledOnce();
    expect(fixture.adapters.removeEngineConnections).toHaveBeenCalledOnce();
  });
});
