import type { LaunchableModelInventory } from '@kontourai/station-contracts/model-inventory';
import { describe, expect, test, vi } from 'vitest';
import { resolveContextWindowTokensForStats } from '../runtime-routes.js';

function inventory(
  providerModel: string,
  effectiveContextTokens: number,
): LaunchableModelInventory {
  return {
    schemaVersion: 'station.model-inventory/v2',
    observedAt: '2026-08-16T00:00:00.000Z',
    diagnostics: [],
    models: [
      {
        id: `model:${providerModel}`,
        connectionId: 'connection-1',
        connectionKind: 'model',
        providerId: 'test',
        runtime: null,
        adapter: null,
        model: { id: providerModel, revision: null, quantization: null },
        providerModel,
        aliases: [`alias:${providerModel}`],
        displayName: providerModel,
        locality: 'remote',
        availability: 'available',
        freshness: 'live',
        observedAt: '2026-08-16T00:00:00.000Z',
        effectiveContextTokens,
        toolSurface: null,
        supportsVision: null,
      },
    ],
  };
}

describe('stats context-window inventory resolution', () => {
  test('resolves a cold known model through one compute-on-demand inventory refresh', async () => {
    const refreshed = inventory('known-model', 1_000_000);
    const source = {
      getCachedLaunchableModelInventory: vi.fn(() => null),
      listLaunchableModelInventory: vi.fn(async () => refreshed),
    };

    await expect(
      resolveContextWindowTokensForStats(source, 'known-model'),
    ).resolves.toBe(1_000_000);
    expect(source.listLaunchableModelInventory).toHaveBeenCalledTimes(1);
  });

  test('keeps a warm stats request on the cached fast path', async () => {
    const source = {
      getCachedLaunchableModelInventory: vi.fn(() =>
        inventory('known-model', 750_000),
      ),
      listLaunchableModelInventory: vi.fn(),
    };

    await expect(
      resolveContextWindowTokensForStats(source, 'alias:known-model'),
    ).resolves.toBe(750_000);
    expect(source.listLaunchableModelInventory).not.toHaveBeenCalled();
  });

  test('refreshes after cache invalidation and preserves explicit unknown', async () => {
    let cached: LaunchableModelInventory | null = inventory(
      'before-change',
      200_000,
    );
    const source = {
      getCachedLaunchableModelInventory: vi.fn(() => cached),
      listLaunchableModelInventory: vi.fn(async () => {
        cached = inventory('after-change', 400_000);
        return cached;
      }),
    };

    await expect(
      resolveContextWindowTokensForStats(source, 'before-change'),
    ).resolves.toBe(200_000);
    cached = null;
    await expect(
      resolveContextWindowTokensForStats(source, 'after-change'),
    ).resolves.toBe(400_000);
    await expect(
      resolveContextWindowTokensForStats(source, 'unknown-model'),
    ).resolves.toBeUndefined();
    expect(source.listLaunchableModelInventory).toHaveBeenCalledTimes(1);
  });

  test('concurrent cold stats requests share the source refresh generation', async () => {
    let cached: LaunchableModelInventory | null = null;
    let refresh: Promise<LaunchableModelInventory> | null = null;
    let refreshStarts = 0;
    const source = {
      getCachedLaunchableModelInventory: vi.fn(() => cached),
      listLaunchableModelInventory: vi.fn(() => {
        refresh ??= Promise.resolve().then(() => {
          refreshStarts += 1;
          cached = inventory('known-model', 1_000_000);
          return cached;
        });
        return refresh;
      }),
    };

    await expect(
      Promise.all([
        resolveContextWindowTokensForStats(source, 'known-model'),
        resolveContextWindowTokensForStats(source, 'known-model'),
      ]),
    ).resolves.toEqual([1_000_000, 1_000_000]);
    expect(source.listLaunchableModelInventory).toHaveBeenCalledTimes(2);
    expect(refreshStarts).toBe(1);
  });

  test('a failed cold refresh remains explicitly unresolved', async () => {
    const source = {
      getCachedLaunchableModelInventory: vi.fn(() => null),
      listLaunchableModelInventory: vi
        .fn()
        .mockRejectedValue(new Error('offline')),
    };

    await expect(
      resolveContextWindowTokensForStats(source, 'known-model'),
    ).resolves.toBeUndefined();
  });
});
