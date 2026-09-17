import { describe, expect, test, vi } from 'vitest';
import {
  clearAll,
  disposePreparedPluginProviders,
  disposeRetainedPreparedPluginProviders,
  pluginProviderSourceGeneration,
  replacePluginProvidersForSourceGeneration,
  retirePluginProvidersForSourceGeneration,
} from '../../../providers/registries/registry.js';
import { withPluginContentLock } from '../plugin-content-integrity.js';
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
    settleProviderAdapters: vi.fn(async (_pluginName: string) => {
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

test('a caller holding a content guard gets winding-down before independently owned activation can enter', async () => {
  const state = harness({
    installed: true,
    installationGeneration: 'sha256:generation-1',
    providerGeneration: 1,
    grants: ['providers.register'],
  });
  const original = state.adapters.activateProviders;
  let entered = false;
  state.adapters.activateProviders = (name, expected, current) =>
    withPluginContentLock('/plugins', name, async () => {
      entered = true;
      return original(name, expected, current);
    });
  const service = createPluginGrantReconciliationService(state.adapters);
  await withPluginContentLock('/plugins', 'guarded', async () => {
    const result = await service.reconcile({
      pluginName: 'guarded',
      permissions: ['providers.register'],
    });
    expect(result.status).toBe('winding-down');
    expect(entered).toBe(false);
  });
  await vi.waitFor(() =>
    expect(service.inspect('guarded')?.status).toBe('completed'),
  );
  expect(entered).toBe(true);
});

test('an expired inherited content token does not force winding-down for fast work', async () => {
  const state = harness();
  const service = createPluginGrantReconciliationService(state.adapters);
  let start!: () => void;
  const gate = new Promise<void>((resolve) => {
    start = resolve;
  });
  let work!: ReturnType<typeof service.reconcile>;
  await withPluginContentLock('/plugins', 'expired', async () => {
    work = gate.then(() =>
      service.reconcile({
        pluginName: 'expired',
        permissions: ['providers.register'],
      }),
    );
  });
  start();
  await expect(work).resolves.toMatchObject({ status: 'completed' });
});

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

  test('refuses new capacity instead of discarding incomplete cleanup and its permission vector', async () => {
    const fixture = harness();
    let retirementFails = true;
    vi.mocked(fixture.adapters.retireProviders).mockImplementation(
      async (_pluginName, expectedGeneration) => {
        if (retirementFails) throw new Error('forced retirement failure');
        fixture.setSnapshot({
          installed: true,
          installationGeneration: 'sha256:generation-1',
          providerGeneration: expectedGeneration + 1,
          grants: [],
        });
        return 'retired';
      },
    );
    const service = createPluginGrantReconciliationService(fixture.adapters);

    for (let index = 0; index < 256; index += 1) {
      await expect(
        service.reconcile({
          pluginName: `provider-plugin-${index}`,
          permissions: ['providers.register'],
        }),
      ).resolves.toMatchObject({
        status: 'incomplete',
        failures: ['provider-retirement'],
      });
    }
    const retained = service.inspect('provider-plugin-0');

    await expect(
      service.reconcile({
        pluginName: 'provider-plugin-over-capacity',
        permissions: ['providers.register'],
      }),
    ).resolves.toMatchObject({
      status: 'incomplete',
      generation: 0,
      failures: ['capacity'],
    });
    expect(service.inspect('provider-plugin-0')).toEqual(retained);

    retirementFails = false;
    await expect(
      service.reconcile({
        pluginName: 'provider-plugin-0',
        permissions: ['plugin.server'],
      }),
    ).resolves.toMatchObject({ status: 'completed' });
    expect(fixture.adapters.retireProviders).toHaveBeenLastCalledWith(
      'provider-plugin-0',
      1,
    );
    expect(fixture.adapters.quiesceModule).toHaveBeenCalledOnce();
  });

  test('a winning revoke joins timed-out staged cleanup until the original stopAll settles', async () => {
    vi.useFakeTimers();
    const pluginName = 'pending-staged-cleanup';
    let releaseCleanup!: () => void;
    let originalSettled = false;
    const original = new Promise<void>((resolve) => {
      releaseCleanup = () => {
        originalSettled = true;
        resolve();
      };
    });
    const stopAll = vi
      .fn()
      .mockReturnValueOnce(original)
      .mockResolvedValue(undefined);
    const fixture = harness();
    fixture.adapters.settleProviderAdapters = (source) =>
      disposeRetainedPreparedPluginProviders(source);
    const service = createPluginGrantReconciliationService(fixture.adapters, {
      responseDeadlineMs: 100,
    });
    try {
      const initial = disposePreparedPluginProviders([
        {
          type: 'providerAdapter',
          source: pluginName,
          provider: { provider: 'probe', stopAll },
        },
      ]);
      const timedOut = expect(initial).rejects.toThrow(
        'Prepared plugin provider cleanup failed',
      );
      await vi.advanceTimersByTimeAsync(2_001);
      await timedOut;

      const revoke = service.reconcile({
        pluginName,
        permissions: ['providers.register'],
      });
      await vi.advanceTimersByTimeAsync(101);
      await expect(revoke).resolves.toMatchObject({ status: 'winding-down' });
      expect(stopAll).toHaveBeenCalledOnce();
      expect(originalSettled).toBe(false);
      expect(service.inspect(pluginName)).toBeUndefined();

      releaseCleanup();
      await vi.advanceTimersByTimeAsync(0);
      expect(service.inspect(pluginName)).toMatchObject({
        status: 'completed',
      });
      expect(stopAll).toHaveBeenCalledOnce();
    } finally {
      releaseCleanup();
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
    }
  });

  test('a winning revoke retries source-bound staged adapter disposal before completing', async () => {
    clearAll();
    const pluginName = 'staged-cleanup-plugin';
    let grants = ['providers.register'];
    let releaseDisplaced!: () => void;
    const displacedCleanup = new Promise<void>((resolve) => {
      releaseDisplaced = resolve;
    });
    let markDisplacedCleanupStarted!: () => void;
    const displacedCleanupStarted = new Promise<void>((resolve) => {
      markDisplacedCleanupStarted = resolve;
    });
    const displacedAdapter = {
      provider: 'probe',
      stopAll: vi.fn(async () => {
        markDisplacedCleanupStarted();
        await displacedCleanup;
      }),
    };
    let activeCleanupAttempts = 0;
    const settlementGrantSnapshots: string[][] = [];
    const activeAdapter = {
      provider: 'probe',
      stopAll: vi.fn(async () => {
        activeCleanupAttempts += 1;
        if (activeCleanupAttempts === 1) {
          throw new Error('first staged cleanup failed');
        }
      }),
    };
    const adapters: PluginGrantReconciliationAdapters = {
      snapshot: async () => ({
        installed: true,
        installationGeneration: 'sha256:generation-1',
        providerGeneration: pluginProviderSourceGeneration(pluginName),
        grants,
      }),
      quiesceModule: async () => ({ release() {} }),
      quiesceSubscriptions: async () => ({ release() {} }),
      retireProviders: (source, generation) =>
        retirePluginProvidersForSourceGeneration(source, generation),
      activateProviders: (source, expected, isCurrent) =>
        replacePluginProvidersForSourceGeneration(
          source,
          expected.providerGeneration,
          [
            {
              type: 'providerAdapter',
              provider: displacedAdapter as any,
              source,
            },
            {
              type: 'providerAdapter',
              provider: activeAdapter as any,
              source,
            },
          ],
          isCurrent,
        ),
      settleProviderAdapters: async (source) => {
        settlementGrantSnapshots.push([...grants]);
        await disposeRetainedPreparedPluginProviders(source);
      },
      removeEngineConnections: async () => 'removed',
      reconcileEngineConnections: async () => {},
      reconcileSubscriptions: async () => ({ kind: 'applied' }),
    };
    const service = createPluginGrantReconciliationService(adapters, {
      responseDeadlineMs: 1_000,
    });

    try {
      const regrant = service.reconcile({
        pluginName,
        permissions: ['providers.register'],
      });
      await displacedCleanupStarted;
      grants = [];
      const revoke = service.reconcile({
        pluginName,
        permissions: ['providers.register'],
      });
      releaseDisplaced();

      await expect(regrant).resolves.toMatchObject({ status: 'superseded' });
      await expect(revoke).resolves.toMatchObject({ status: 'completed' });
      expect(activeCleanupAttempts).toBe(2);
      expect(settlementGrantSnapshots).toEqual([[]]);
      await disposeRetainedPreparedPluginProviders(pluginName);
      expect(activeCleanupAttempts).toBe(2);
    } finally {
      releaseDisplaced();
      await disposeRetainedPreparedPluginProviders().catch(() => undefined);
      clearAll();
    }
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
      expect.any(Function),
    );
    expect(fixture.adapters.reconcileEngineConnections).not.toHaveBeenCalled();
  });

  test('prevents retained activation publication after a newer revoke generation wins', async () => {
    const fixture = harness({
      installed: true,
      installationGeneration: 'sha256:generation-1',
      providerGeneration: 4,
      grants: ['providers.register'],
    });
    let releaseActivation!: () => void;
    const activationGate = new Promise<void>((resolve) => {
      releaseActivation = resolve;
    });
    let publishAttempts = 0;
    vi.mocked(fixture.adapters.activateProviders).mockImplementation(
      async (_pluginName, _expected, isCurrent) => {
        fixture.order.push('activate-start');
        await activationGate;
        if (!isCurrent()) return 'superseded';
        publishAttempts += 1;
        return 'activated';
      },
    );
    const service = createPluginGrantReconciliationService(fixture.adapters, {
      responseDeadlineMs: 1_000,
    });
    const regrant = service.reconcile({
      pluginName: 'provider-plugin',
      permissions: ['providers.register'],
    });
    await vi.waitFor(() => expect(fixture.order).toContain('activate-start'));
    fixture.setSnapshot({
      installed: true,
      installationGeneration: 'sha256:generation-1',
      providerGeneration: 4,
      grants: [],
    });
    const revoke = service.reconcile({
      pluginName: 'provider-plugin',
      permissions: ['providers.register'],
    });
    releaseActivation();

    await expect(regrant).resolves.toMatchObject({ status: 'superseded' });
    await expect(revoke).resolves.toMatchObject({ status: 'completed' });
    expect(publishAttempts).toBe(0);
    expect(fixture.adapters.retireProviders).toHaveBeenCalledOnce();
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
