import { describe, expect, test, vi } from 'vitest';
import {
  ModelCatalogHttpError,
  ModelCatalogShapeError,
} from '../../registries/catalog-http.js';
import {
  classifyCatalogFailure,
  MODEL_CATALOG_MAX_ENTRIES,
  resolveExactModelSelector,
  safeListModelCatalog,
} from '../model-catalog.js';

/*
 * Delta review H1 — the whole fix turns on this split. A catalog route that
 * 404s is an endpoint with no catalog (plenty of OpenAI-compatible servers
 * serve chat and no `/models`); a 401 is a connection that does not work.
 * Treating them alike marked working connections permanently broken.
 */
describe('classifyCatalogFailure', () => {
  test('401 and 403 are refusals', () => {
    expect(classifyCatalogFailure(new ModelCatalogHttpError(401))).toBe(
      'refused',
    );
    expect(classifyCatalogFailure(new ModelCatalogHttpError(403))).toBe(
      'refused',
    );
  });

  test('404, 405 and 501 mean the endpoint has no catalog route', () => {
    for (const status of [404, 405, 501]) {
      expect(classifyCatalogFailure(new ModelCatalogHttpError(status))).toBe(
        'no-catalog',
      );
    }
  });

  test('other error statuses are refusals', () => {
    expect(classifyCatalogFailure(new ModelCatalogHttpError(429))).toBe(
      'refused',
    );
    expect(classifyCatalogFailure(new ModelCatalogHttpError(500))).toBe(
      'refused',
    );
  });

  test('a body that is not a catalog means no catalog, not a refusal', () => {
    expect(
      classifyCatalogFailure(new ModelCatalogShapeError('not a catalog')),
    ).toBe('no-catalog');
  });

  test('anything else is a transport failure', () => {
    expect(classifyCatalogFailure(new Error('getaddrinfo ENOTFOUND'))).toBe(
      'unreachable',
    );
  });
});

describe('safeListModelCatalog — failure classification', () => {
  test('carries the classification of a thrown catalog error', async () => {
    await expect(
      safeListModelCatalog({
        id: 'test',
        displayName: 'Test',
        listModels: vi.fn(async () => {
          throw new ModelCatalogHttpError(404);
        }),
        createStream: vi.fn() as any,
      }),
    ).resolves.toEqual({
      source: 'unavailable',
      models: [],
      reason: 'Model catalog request failed with HTTP 404.',
      reasonKind: 'no-catalog',
    });
  });

  test('an abort carries no classification, because the provider never answered', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      safeListModelCatalog(
        {
          id: 'test',
          displayName: 'Test',
          listModels: vi.fn(async () => {
            throw new ModelCatalogHttpError(404);
          }),
          createStream: vi.fn() as any,
        },
        [],
        undefined,
        controller.signal,
      ),
    ).resolves.toEqual({ source: 'unavailable', models: [] });
  });
});

describe('safeListModelCatalog', () => {
  test('preserves a successful empty live observation for removal convergence', async () => {
    const catalog = await safeListModelCatalog({
      id: 'test',
      displayName: 'Test',
      listModels: vi.fn(async () => []),
      createStream: vi.fn() as any,
    });

    expect(catalog).toEqual({ source: 'live', models: [] });
  });

  test('bounds untrusted provider catalogs and drops oversized identities', async () => {
    const models = Array.from(
      { length: MODEL_CATALOG_MAX_ENTRIES + 10 },
      (_, index) => ({ id: `model-${index}`, name: `Model ${index}` }),
    );
    models.unshift({ id: 'x'.repeat(513), name: 'oversized' });
    const catalog = await safeListModelCatalog({
      id: 'test',
      displayName: 'Test',
      listModels: vi.fn(async () => models),
      createStream: vi.fn() as any,
    });

    expect(catalog.source).toBe('live');
    expect(catalog.models).toHaveLength(MODEL_CATALOG_MAX_ENTRIES);
    expect(catalog.models[0]?.id).toBe('model-0');
  });

  test('uses an explicit configured selector when discovery times out', async () => {
    vi.useFakeTimers();
    try {
      const pending = safeListModelCatalog(
        {
          id: 'test',
          displayName: 'Test',
          listModels: vi.fn(() => new Promise<never>(() => {})),
          createStream: vi.fn() as any,
        },
        [{ id: 'configured/model', name: 'configured/model' }],
        25,
      );
      await vi.advanceTimersByTimeAsync(25);

      await expect(pending).resolves.toEqual({
        source: 'configured',
        models: [{ id: 'configured/model', name: 'configured/model' }],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test('does not invent a configured selector when the provider denies fallback', async () => {
    const catalog = await safeListModelCatalog(
      {
        id: 'evidence-only',
        displayName: 'Evidence only',
        configuredModelFallback: 'deny',
        listModels: vi.fn(async () => []),
        listModelCatalog: vi.fn(async () => ({
          source: 'unavailable' as const,
          models: [],
        })),
        createStream: vi.fn() as any,
      },
      [{ id: 'invented/model', name: 'invented/model' }],
    );

    expect(catalog).toEqual({ source: 'unavailable', models: [] });
  });

  test('aborts provider discovery when the catalog deadline expires', async () => {
    vi.useFakeTimers();
    const observedSignals: AbortSignal[] = [];
    try {
      const pending = safeListModelCatalog(
        {
          id: 'test',
          displayName: 'Test',
          listModels: vi.fn(({ signal } = {}) => {
            if (signal) observedSignals.push(signal);
            return new Promise<never>(() => {});
          }),
          createStream: vi.fn() as any,
        },
        [],
        25,
      );
      await vi.advanceTimersByTimeAsync(25);

      await expect(pending).resolves.toEqual({
        source: 'unavailable',
        models: [],
      });
      expect(observedSignals[0]?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test('awaits declared provider cleanup after catalog cancellation', async () => {
    let cleanupComplete = false;
    const catalog = await safeListModelCatalog(
      {
        id: 'settling-provider',
        displayName: 'Settling provider',
        abortSettlement: 'await',
        listModels: vi.fn(
          ({ signal } = {}) =>
            new Promise<never>((_resolve, reject) => {
              signal?.addEventListener(
                'abort',
                () => {
                  setTimeout(() => {
                    cleanupComplete = true;
                    reject(signal.reason);
                  }, 25);
                },
                { once: true },
              );
            }),
        ),
        createStream: vi.fn() as any,
      },
      [],
      5,
    );

    expect(catalog).toEqual({ source: 'unavailable', models: [] });
    expect(cleanupComplete).toBe(true);
  });

  test('bounds declared provider cleanup when cancellation never settles', async () => {
    vi.useFakeTimers();
    try {
      const pending = safeListModelCatalog(
        {
          id: 'stalled-provider',
          displayName: 'Stalled provider',
          abortSettlement: 'await',
          listModels: vi.fn(() => new Promise<never>(() => {})),
          createStream: vi.fn() as any,
        },
        [],
        5,
      );

      await vi.advanceTimersByTimeAsync(654);
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      await expect(pending).resolves.toEqual({
        source: 'unavailable',
        models: [],
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

/*
 * station#3653 — the launchability half of "usable". `probeModelConnection`
 * already reads an empty `GET /models` as "this endpoint does not enumerate"
 * and earns Ready from a real one-token chat turn against the connection's
 * configured `defaultModel`. This is the derivation that used to disagree
 * with it, and refuse that exact model.
 */
describe('resolveExactModelSelector (station#3653)', () => {
  // A provider INSTANCE that declares its empty list is not an enumeration —
  // what `OpenAICompatLLMProvider` derives for a self-hosted endpoint (delta
  // review HIGH-1; the class itself declares nothing, see
  // openai-compat-catalog-authority.test.ts). Without the declaration a
  // provider gets the default authoritative reading — the Anthropic-shaped
  // cases below.
  const emptyCatalogProvider = () =>
    ({
      id: 'openai-compat',
      displayName: 'OpenAI-Compatible',
      emptyCatalogMeaning: 'no-catalog',
      listModels: vi.fn(async () => []),
      createStream: vi.fn(),
    }) as any;

  test('an empty catalogue does not refute the configured selector', async () => {
    await expect(
      resolveExactModelSelector(emptyCatalogProvider(), 'local-model', [
        { id: 'local-model', name: 'local-model' },
      ]),
    ).resolves.toBe('local-model');
  });

  /*
   * Review HIGH-1: the exception belongs to adapters that DECLARED their
   * empty list is not an enumeration, not to emptiness. Anthropic pins the
   * opposite contract (`{source:'live', models: []}` is a real answer), so an
   * account whose last entitlement is revoked converges to `[]` and must not
   * keep launching the stale configured selector.
   */
  test('an undeclared provider keeps its empty enumeration authoritative', async () => {
    await expect(
      resolveExactModelSelector(
        {
          id: 'anthropic',
          displayName: 'Anthropic',
          listModels: vi.fn(async () => []),
          createStream: vi.fn(),
        } as any,
        'claude-sonnet-4',
        [{ id: 'claude-sonnet-4', name: 'claude-sonnet-4' }],
      ),
    ).rejects.toThrow("Model selector 'claude-sonnet-4' is not launchable");
  });

  test('model-removal convergence is not undone for an undeclared provider', async () => {
    const provider = {
      id: 'anthropic',
      displayName: 'Anthropic',
      listModels: vi
        .fn()
        .mockResolvedValueOnce([
          { id: 'claude-sonnet-4', name: 'claude-sonnet-4' },
        ])
        .mockResolvedValueOnce([]),
      createStream: vi.fn(),
    } as any;
    const configured = [{ id: 'claude-sonnet-4', name: 'claude-sonnet-4' }];

    // Entitled: the live catalogue carries it.
    await expect(
      resolveExactModelSelector(provider, 'claude-sonnet-4', configured),
    ).resolves.toBe('claude-sonnet-4');
    // Entitlement revoked: the empty answer is the provider's own statement.
    await expect(
      resolveExactModelSelector(provider, 'claude-sonnet-4', configured),
    ).rejects.toThrow('is not launchable for this provider');
  });

  test('an unreachable UNDECLARED provider still falls back (unchanged #2591 rule)', async () => {
    // Not a live enumeration at all — `safeListModelCatalog` already
    // substitutes configured selectors here, and this fix does not touch it.
    await expect(
      resolveExactModelSelector(
        {
          id: 'anthropic',
          displayName: 'Anthropic',
          listModels: vi.fn(async () => {
            throw new Error('network down');
          }),
          createStream: vi.fn(),
        } as any,
        'claude-sonnet-4',
        [{ id: 'claude-sonnet-4', name: 'claude-sonnet-4' }],
      ),
    ).resolves.toBe('claude-sonnet-4');
  });

  test('an empty catalogue still refuses a selector nobody configured', async () => {
    await expect(
      resolveExactModelSelector(emptyCatalogProvider(), 'some-other-model', [
        { id: 'local-model', name: 'local-model' },
      ]),
    ).rejects.toThrow("Model selector 'some-other-model' is not launchable");
  });

  test('a catalogue that DID enumerate stays authoritative over the configured selector', async () => {
    await expect(
      resolveExactModelSelector(
        {
          id: 'openai-compat',
          displayName: 'OpenAI-Compatible',
          listModels: vi.fn(async () => [{ id: 'gpt-4.1', name: 'GPT-4.1' }]),
          createStream: vi.fn(),
        } as any,
        'local-model',
        [{ id: 'local-model', name: 'local-model' }],
      ),
    ).rejects.toThrow("Model selector 'local-model' is not launchable");
  });

  test('a provider that denies configured fallback (Bedrock) is unchanged', async () => {
    await expect(
      resolveExactModelSelector(
        {
          id: 'bedrock',
          displayName: 'Amazon Bedrock',
          configuredModelFallback: 'deny',
          listModels: vi.fn(async () => []),
          createStream: vi.fn(),
        } as any,
        'local-model',
        [{ id: 'local-model', name: 'local-model' }],
      ),
    ).rejects.toThrow("Model selector 'local-model' is not launchable");
  });

  test('a configured selector too long to survive catalogue bounds is not admitted', async () => {
    const oversized = 'x'.repeat(513);
    await expect(
      resolveExactModelSelector(emptyCatalogProvider(), oversized, [
        { id: oversized, name: oversized },
      ]),
    ).rejects.toThrow('is not launchable for this provider');
  });

  test('an unreachable provider still resolves the configured selector (unchanged)', async () => {
    await expect(
      resolveExactModelSelector(
        {
          id: 'openai-compat',
          displayName: 'OpenAI-Compatible',
          listModels: vi.fn(async () => {
            throw new Error('connect ECONNREFUSED');
          }),
          createStream: vi.fn(),
        } as any,
        'local-model',
        [{ id: 'local-model', name: 'local-model' }],
      ),
    ).resolves.toBe('local-model');
  });
});
