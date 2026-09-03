import { createInMemorySnapshotStore } from '@kontourai/forage';
import { describe, expect, test, vi } from 'vitest';
import { OpenRouterRoutePricing } from '../openrouter-route-pricing.js';

const ROW = 'anthropic/claude-sonnet-4.5';

/** An OpenRouter /api/v1/models body with the rows the test wants. */
function catalogue(
  rows: Array<{ id: string; prompt?: string; completion?: string }>,
) {
  return JSON.stringify({
    data: rows.map((row) => ({
      id: row.id,
      name: row.id,
      context_length: 200_000,
      pricing: {
        ...(row.prompt !== undefined ? { prompt: row.prompt } : {}),
        ...(row.completion !== undefined ? { completion: row.completion } : {}),
      },
    })),
  });
}

/** forage asks robots.txt first, then the entrypoint; answer both. */
function fakeFetch(body: string, status = 200) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/robots.txt')) return new Response('', { status: 404 });
    return new Response(body, {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

function pricing(
  overrides: Partial<
    ConstructorParameters<typeof OpenRouterRoutePricing>[0]
  > = {},
) {
  const logger = { warn: vi.fn() };
  const service = new OpenRouterRoutePricing({
    homeDir: '/unused-in-tests',
    store: createInMemorySnapshotStore(),
    // A fake fetch has no destination address for guarded egress to classify.
    egress: { guarded: false },
    now: () => new Date('2026-09-03T12:00:00.000Z'),
    logger,
    ...overrides,
  });
  return { service, logger };
}

describe('OpenRouterRoutePricing', () => {
  test('reads the reviewed OpenRouter rows from the curated identity table', () => {
    const rows = OpenRouterRoutePricing.reviewedRows();
    expect(Object.keys(rows)).toEqual([ROW]);
    expect(rows[ROW]?.model.id).toBe(ROW);
  });

  test('prices a reviewed row per million tokens with its provenance attached', async () => {
    const { service } = pricing({
      fetch: fakeFetch(
        catalogue([{ id: ROW, prompt: '0.000003', completion: '0.000015' }]),
      ),
    });
    await service.refresh();
    expect(service.priceFor(ROW)).toEqual({
      source: 'openrouter',
      attributionUrl:
        'https://openrouter.ai/docs/api/reference/models/get-models',
      promptUsdPerMillionTokens: 3,
      completionUsdPerMillionTokens: 15,
      observedAt: expect.any(String),
      validUntil: expect.any(String),
    });
  });

  test('a stated-absent price is null, not zero', async () => {
    const { service } = pricing({
      fetch: fakeFetch(catalogue([{ id: ROW, prompt: '0.000003' }])),
    });
    await service.refresh();
    expect(service.priceFor(ROW)?.completionUsdPerMillionTokens).toBeNull();
    expect(service.priceFor(ROW)?.promptUsdPerMillionTokens).toBe(3);
  });

  // The fabrication this exists to refuse: a row the reviewed data never
  // named is present in the live catalogue with a price. It must not be
  // priced, and nothing may be matched to it by name.
  test('prices nothing the reviewed data did not name', async () => {
    const { service, logger } = pricing({
      fetch: fakeFetch(
        catalogue([
          {
            id: 'anthropic/claude-sonnet-4.5:free',
            prompt: '0',
            completion: '0',
          },
          { id: 'openai/gpt-5.6', prompt: '0.00001', completion: '0.00003' },
        ]),
      ),
    });
    await service.refresh();
    expect(
      service.priceFor('anthropic/claude-sonnet-4.5:free'),
    ).toBeUndefined();
    expect(service.priceFor('openai/gpt-5.6')).toBeUndefined();
    expect(service.priceFor(ROW)).toBeUndefined();
    // bearing reports the reviewed row's absence; it is not guessed around.
    expect(logger.warn).toHaveBeenCalledWith(
      'OpenRouter route pricing diagnostic',
      expect.objectContaining({ code: 'configured-model-missing' }),
    );
  });

  test('a price past its validity is withheld rather than shown stale', async () => {
    let clock = new Date('2026-09-03T12:00:00.000Z');
    const { service } = pricing({
      fetch: fakeFetch(
        catalogue([{ id: ROW, prompt: '0.000003', completion: '0.000015' }]),
      ),
      now: () => clock,
    });
    await service.refresh();
    const reference = service.priceFor(ROW);
    expect(reference).toBeDefined();
    clock = new Date(Date.parse(reference!.validUntil!) + 1);
    expect(service.priceFor(ROW)).toBeUndefined();
  });

  test('an acquisition failure leaves the previous read in place and never throws', async () => {
    const good = fakeFetch(
      catalogue([{ id: ROW, prompt: '0.000003', completion: '0.000015' }]),
    );
    const bad = fakeFetch('upstream exploded', 503);
    let current = good;
    const { service, logger } = pricing({
      fetch: ((...args: Parameters<typeof fetch>) =>
        current(...args)) as typeof fetch,
    });
    await service.refresh();
    expect(service.priceFor(ROW)?.promptUsdPerMillionTokens).toBe(3);
    current = bad;
    await expect(service.refresh()).resolves.toBeUndefined();
    expect(service.priceFor(ROW)?.promptUsdPerMillionTokens).toBe(3);
    expect(logger.warn).toHaveBeenCalledWith(
      'OpenRouter route pricing refresh failed',
      expect.anything(),
    );
  });

  test('with no read at all, every route is unpriced', () => {
    const { service } = pricing();
    expect(service.priceFor(ROW)).toBeUndefined();
  });
});
