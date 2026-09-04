import { createInMemorySnapshotStore } from '@kontourai/forage';
import { CURATED_MODEL_IDENTITIES } from '@kontourai/station-contracts/model-inventory';
import { describe, expect, test, vi } from 'vitest';
import { OpenRouterRoutePricing } from '../openrouter-route-pricing.js';
import REAL_ROW from './fixtures/openrouter-row.json' with { type: 'json' };

const ROW = 'anthropic/claude-sonnet-4.5';

/**
 * An OpenRouter /api/v1/models body with the rows the test wants.
 *
 * Rows are built from a REAL catalogue row captured from the live API
 * (`fixtures/openrouter-row.json`), not invented. Bearing validates the
 * envelope ("must contain exactly: data, links, total_count") AND every row
 * ("missing required fields: canonical_slug, architecture, top_provider,
 * supported_parameters, ..."). A hand-written row parses nowhere near the real
 * service, so every assertion here would have been meaningless against it --
 * which is exactly what happened before this fixture existed.
 */
function catalogue(
  rows: Array<{
    id: string;
    prompt?: string;
    completion?: string;
    /** Drop `pricing.overrides`, i.e. quote a flat schedule. */
    flat?: boolean;
    /** Replace `pricing.overrides` wholesale. */
    overrides?: unknown[];
  }>,
) {
  return JSON.stringify({
    data: rows.map((row) => {
      const { overrides, ...flatPricing } = REAL_ROW.pricing;
      return {
        ...REAL_ROW,
        id: row.id,
        canonical_slug: row.id,
        name: row.id,
        // `prompt` and `completion` are REQUIRED keys; OpenRouter expresses an
        // unavailable price with the sentinel "-1", which bearing maps to null.
        // Omitting the key is not a shape the source ever produces.
        pricing: {
          ...(row.flat ? flatPricing : REAL_ROW.pricing),
          ...(row.prompt !== undefined ? { prompt: row.prompt } : {}),
          ...(row.completion !== undefined
            ? { completion: row.completion }
            : {}),
          ...(row.overrides !== undefined ? { overrides: row.overrides } : {}),
        },
      };
    }),
    links: { next: null },
    total_count: rows.length,
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
    // The same curated identities carry anthropic/bedrock/claude routes, and
    // the family filter is the only reason none of them is here. Naming them
    // is what gives this power: `toEqual([ROW])` alone would still pass if the
    // filter were dropped and every sibling happened to share the row's id.
    const siblings = CURATED_MODEL_IDENTITIES.flatMap((identity) =>
      identity.routes.filter((route) => route.family !== 'openrouter'),
    );
    expect(siblings.length).toBeGreaterThan(0);
    for (const sibling of siblings) {
      expect(Object.keys(rows)).not.toContain(sibling.providerModel);
    }
  });

  test('prices a reviewed row per million tokens with its provenance attached', async () => {
    const { service } = pricing({
      fetch: fakeFetch(
        catalogue([{ id: ROW, prompt: '0.000003', completion: '0.000015' }]),
      ),
    });
    await service.refresh();
    const reference = service.priceFor(ROW);
    expect(reference).toEqual({
      source: 'openrouter',
      attributionUrl:
        'https://openrouter.ai/docs/api/reference/models/get-models',
      promptUsdPerMillionTokens: 3,
      completionUsdPerMillionTokens: 15,
      // The captured row's own `pricing.overrides` charges more above 200k
      // prompt tokens. Bearing drops that field, so without this the base
      // figure would be published as the whole schedule. The tier carries its
      // OWN rates: 2x prompt and 1.5x completion, derived rather than
      // described, so a discount would read as a discount.
      promptTokenTiers: [
        {
          abovePromptTokens: 200_000,
          promptUsdPerMillionTokens: 6,
          completionUsdPerMillionTokens: 22.5,
        },
      ],
      observedAt: expect.any(String),
      validUntil: expect.any(String),
    });
    // Both timestamps must be DERIVED, not stamped at read time: the source's
    // packaged manifest bounds this catalogue at 24h from when it was
    // fetched. `expect.any(String)` alone would pass for `new Date()` on
    // either field, which is the freshness lie this whole module refuses.
    expect(
      Date.parse(reference!.validUntil!) - Date.parse(reference!.observedAt),
    ).toBe(24 * 60 * 60 * 1000);
  });

  // "-1" is OpenRouter's unavailable sentinel, not a price of zero. A route
  // whose completion price the source declines to state must read as null;
  // rendering it as 0 would claim the model's output is free.
  test('an unavailable price reads as null, not zero', async () => {
    const { service } = pricing({
      fetch: fakeFetch(
        catalogue([{ id: ROW, prompt: '0.000003', completion: '-1' }]),
      ),
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

  // The shape the live source actually produces for an unpriced route: BOTH
  // required keys carry the sentinel. Five live rows do this today, including
  // `openrouter/auto`, OpenRouter's headline route -- so this is the case a
  // reviewer adding it to the curated table hits first, and until now the
  // suite only covered a one-sided sentinel the source has never emitted.
  test('a row the source prices on neither side is unpriced, not a reference of nulls', async () => {
    const { service } = pricing({
      fetch: fakeFetch(
        catalogue([{ id: ROW, prompt: '-1', completion: '-1' }]),
      ),
    });
    await service.refresh();
    expect(service.priceFor(ROW)).toBeUndefined();
  });

  // The other side of the same coin, and the reason the guard above cannot be
  // written as a falsiness check: a genuinely free route quotes "0", and 21
  // live rows do. Zero is a price the source stated; null is one it did not.
  test('a genuinely free reviewed route is priced at zero, not treated as unpriced', async () => {
    const { service } = pricing({
      fetch: fakeFetch(catalogue([{ id: ROW, prompt: '0', completion: '0' }])),
    });
    await service.refresh();
    expect(service.priceFor(ROW)?.promptUsdPerMillionTokens).toBe(0);
    expect(service.priceFor(ROW)?.completionUsdPerMillionTokens).toBe(0);
  });

  // A flat schedule must say so rather than leave the field to a default that
  // happens to be right: the tiers are read from the row, so dropping
  // `pricing.overrides` has to change them.
  test('a flat schedule reports no tier threshold', async () => {
    const { service } = pricing({
      fetch: fakeFetch(
        catalogue([
          { id: ROW, prompt: '0.000003', completion: '0.000015', flat: true },
        ]),
      ),
    });
    await service.refresh();
    expect(service.priceFor(ROW)?.promptTokenTiers).toEqual([]);
  });

  // Scaling an exact decimal to per-million by multiplication produces
  // 0.09999999999999999 for "0.0000001"; 143 values in the live catalogue do
  // this. Today's reviewed row scales cleanly to 3 and 15, which is exactly
  // why no other test can see the defect.
  test('a price that does not scale cleanly is published without float noise', async () => {
    const { service } = pricing({
      fetch: fakeFetch(
        catalogue([
          { id: ROW, prompt: '0.0000001', completion: '0.0000033462' },
        ]),
      ),
    });
    await service.refresh();
    expect(service.priceFor(ROW)?.promptUsdPerMillionTokens).toBe(0.1);
    expect(service.priceFor(ROW)?.completionUsdPerMillionTokens).toBe(3.3462);
  });

  // The store never prunes and throws permanently at its cap, so a refresh
  // that re-reads an unchanged catalogue must not spend a record on it.
  test('an unchanged catalogue is not written to the store a second time', async () => {
    const inner = createInMemorySnapshotStore();
    const put = vi.fn(inner.put.bind(inner));
    const body = catalogue([
      { id: ROW, prompt: '0.000003', completion: '0.000015' },
    ]);
    const { service } = pricing({
      store: { ...inner, put },
      fetch: fakeFetch(body),
    });
    await service.refresh();
    await service.refresh();
    expect(put).toHaveBeenCalledTimes(1);
  });

  // The finding that made the tiers carry their own rates rather than a
  // direction: a threshold is not always a surcharge. A volume DISCOUNT has
  // the identical shape, and a field asserting "charges more above N" would
  // have been true only by today's data -- a surface qualifying the base
  // figure with a warning would tell the user a cheaper turn costs extra.
  test('a volume discount reads as a discount, not as a surcharge', async () => {
    const { service } = pricing({
      fetch: fakeFetch(
        catalogue([
          {
            id: ROW,
            prompt: '0.000003',
            completion: '0.000015',
            overrides: [
              {
                min_prompt_tokens: 128_000,
                prompt: '0.0000015',
                completion: '0.0000075',
              },
            ],
          },
        ]),
      ),
    });
    await service.refresh();
    expect(service.priceFor(ROW)?.promptTokenTiers).toEqual([
      {
        abovePromptTokens: 128_000,
        promptUsdPerMillionTokens: 1.5,
        completionUsdPerMillionTokens: 7.5,
      },
    ]);
  });

  // Five live rows quote two thresholds. A single field could not have said
  // so; these must arrive in threshold order whatever order the source used.
  test('a multi-tier schedule keeps every tier, lowest threshold first', async () => {
    const { service } = pricing({
      fetch: fakeFetch(
        catalogue([
          {
            id: ROW,
            prompt: '0.000003',
            completion: '0.000015',
            overrides: [
              {
                min_prompt_tokens: 128_000,
                prompt: '0.0000075',
                completion: '0.00002',
              },
              {
                min_prompt_tokens: 32_000,
                prompt: '0.000006',
                completion: '0.0000175',
              },
            ],
          },
        ]),
      ),
    });
    await service.refresh();
    expect(
      service.priceFor(ROW)?.promptTokenTiers.map((t) => t.abovePromptTokens),
    ).toEqual([32_000, 128_000]);
  });

  // A tier whose rate the source declines to state must not read as free,
  // on exactly the same terms as the base figures.
  test("a tier's unavailable rate reads as null, not zero", async () => {
    const { service } = pricing({
      fetch: fakeFetch(
        catalogue([
          {
            id: ROW,
            prompt: '0.000003',
            completion: '0.000015',
            overrides: [
              {
                min_prompt_tokens: 200_000,
                prompt: '0.000006',
                completion: '-1',
              },
            ],
          },
        ]),
      ),
    });
    await service.refresh();
    expect(
      service.priceFor(ROW)?.promptTokenTiers[0]?.completionUsdPerMillionTokens,
    ).toBeNull();
  });

  // A corrupt record in the snapshot directory must not take pricing to zero.
  // The dedupe reads the store before writing, and the write it would skip is
  // the one that would add a good record -- so an unguarded read would make a
  // single bad file permanent.
  test('a snapshot store whose read throws still prices, and still writes', async () => {
    const inner = createInMemorySnapshotStore();
    const put = vi.fn(inner.put.bind(inner));
    const { service, logger } = pricing({
      store: {
        ...inner,
        put,
        latest: async () => {
          throw new Error('snapshotCorrupt');
        },
      },
      fetch: fakeFetch(
        catalogue([{ id: ROW, prompt: '0.000003', completion: '0.000015' }]),
      ),
    });
    await service.refresh();
    expect(service.priceFor(ROW)?.promptUsdPerMillionTokens).toBe(3);
    expect(put).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'OpenRouter snapshot store read failed; writing anyway',
      expect.anything(),
    );
  });

  // The condition the fixtures were hiding. bearing 0.2.0 rejects 17 of the
  // 427 live catalogue rows -- `alias_target`, a non-null `supported_voices`,
  // and time-of-day `pricing.overrides` -- and one bad row fails the WHOLE
  // document, so against the real API this service prices nothing today
  // (kontourai/bearing#41). What must hold regardless of that bug is the
  // fail-closed property: a catalogue Station cannot fully parse yields no
  // prices at all, never a partial or guessed one.
  test('a catalogue carrying a row bearing rejects prices nothing, and says why', async () => {
    const body = JSON.parse(
      catalogue([{ id: ROW, prompt: '0.000003', completion: '0.000015' }]),
    );
    body.data[0].alias_target = 'anthropic/claude-sonnet-4.5';
    const { service, logger } = pricing({
      fetch: fakeFetch(JSON.stringify(body)),
    });
    await service.refresh();
    expect(service.priceFor(ROW)).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      'OpenRouter route pricing refresh failed',
      expect.objectContaining({
        error: expect.stringContaining('alias_target'),
      }),
    );
  });

  test('with no read at all, every route is unpriced', () => {
    const { service } = pricing();
    expect(service.priceFor(ROW)).toBeUndefined();
  });
});
