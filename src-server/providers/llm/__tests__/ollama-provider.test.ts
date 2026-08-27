import { ReadableStream } from 'node:stream/web';
import { describe, expect, test, vi } from 'vitest';
import { MODEL_CATALOG_TIMEOUT_MS } from '../model-catalog.js';
import { OllamaLLMProvider } from '../ollama-provider.js';

function sseStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${line}\n\n`));
      }
      controller.close();
    },
  });
}

describe('OllamaLLMProvider', () => {
  test('requires locality to be declared independently from the Ollama endpoint', () => {
    const provider = new OllamaLLMProvider({ locality: 'local' });

    expect(provider.execution).toEqual({
      runtime: { id: 'ollama', version: null },
      adapter: { id: 'station-ollama', version: null },
      locality: 'local',
    });
    expect(
      new OllamaLLMProvider({ baseUrl: 'http://remote.example' }).execution
        .locality,
    ).toBe('unknown');
  });

  test('streams chat through the OpenAI-compatible /v1 endpoint', async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/v1/chat/completions')) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'text/event-stream' }),
          body: sseStream([
            `data: ${JSON.stringify({
              choices: [{ delta: { content: 'hello' } }],
            })}`,
            `data: ${JSON.stringify({
              choices: [
                { delta: { content: ' there' }, finish_reason: 'stop' },
              ],
            })}`,
            'data: [DONE]',
          ]),
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch to ${url}`);
    });

    const originalFetch = global.fetch;
    global.fetch = fetchMock as unknown as typeof fetch;

    try {
      const provider = new OllamaLLMProvider({ baseUrl: 'http://ollama.test' });
      const chunks: string[] = [];
      for await (const chunk of provider.createStream({
        model: 'llama3.2',
        messages: [{ role: 'user', content: 'hi' }],
      })) {
        if (chunk.type === 'text-delta' && chunk.content) {
          chunks.push(chunk.content);
        }
      }

      expect(chunks.join('')).toBe('hello there');
      const url = String(fetchMock.mock.calls[0]?.[0]);
      expect(url).toBe('http://ollama.test/v1/chat/completions');
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('terminates gracefully without throwing when the upstream request fails', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      headers: new Headers(),
      text: async () => `{"error":"model 'missing-model' not found"}`,
      json: async () => ({ error: "model 'missing-model' not found" }),
    }));

    const originalFetch = global.fetch;
    global.fetch = fetchMock as unknown as typeof fetch;

    try {
      const provider = new OllamaLLMProvider({ baseUrl: 'http://ollama.test' });
      const types: string[] = [];
      // The shared ai-sdk base surfaces failures as a terminal chunk rather than
      // throwing, so iterating must complete cleanly.
      await expect(
        (async () => {
          for await (const chunk of provider.createStream({
            model: 'missing-model',
            messages: [{ role: 'user', content: 'hello' }],
          })) {
            types.push(chunk.type);
          }
        })(),
      ).resolves.toBeUndefined();
      expect(types[types.length - 1]).toMatch(/finish|error/);
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('lists models from the native /api/tags endpoint', async () => {
    const fetchMock = vi.fn<
      (...args: Parameters<typeof fetch>) => Promise<any>
    >(
      async () =>
        new Response(
          JSON.stringify({
            models: [{ name: 'llama3.2' }, { name: 'qwen' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const originalFetch = global.fetch;
    global.fetch = fetchMock as unknown as typeof fetch;
    try {
      const provider = new OllamaLLMProvider({ baseUrl: 'http://ollama.test' });
      const models = await provider.listModels();
      expect(models).toEqual([
        { id: 'llama3.2', name: 'llama3.2' },
        { id: 'qwen', name: 'qwen' },
      ]);
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
        'http://ollama.test/api/tags',
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  // station#1430: Ollama's /api/show reports a real `capabilities` array
  // (ollama/ollama#10066) — the one provider in this repo whose API
  // genuinely says whether a model supports tool calling.
  test('populates supportsTools:true from a live /api/show capabilities array containing "tools"', async () => {
    const fetchMock = vi.fn<
      (...args: Parameters<typeof fetch>) => Promise<any>
    >(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/tags')) {
        return new Response(
          JSON.stringify({ models: [{ name: 'qwen3:30b' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.endsWith('/api/show')) {
        const body = JSON.parse(String(init?.body));
        expect(body).toEqual({ model: 'qwen3:30b' });
        return new Response(
          JSON.stringify({ capabilities: ['completion', 'tools'] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`unexpected fetch to ${url}`);
    });
    const originalFetch = global.fetch;
    global.fetch = fetchMock as unknown as typeof fetch;
    try {
      const provider = new OllamaLLMProvider({ baseUrl: 'http://ollama.test' });
      const models = await provider.listModels();
      expect(models).toEqual([
        { id: 'qwen3:30b', name: 'qwen3:30b', supportsTools: true },
      ]);
    } finally {
      global.fetch = originalFetch;
    }
  });

  // The honesty pin: a model that genuinely reports capabilities WITHOUT
  // "tools" must record a real `false`, not merely omit the field — the
  // distinction between "known: no tool support" (`[]`/`false`) and
  // "unknown" (field absent) is exactly what `launchable-model-inventory.ts`'s
  // `unanimous()` depends on downstream. If the adapter regressed to
  // asserting `true` for every model regardless of what /api/show reported,
  // this would go red.
  test('populates supportsTools:false from a live /api/show capabilities array without "tools"', async () => {
    const fetchMock = vi.fn<
      (...args: Parameters<typeof fetch>) => Promise<any>
    >(async (input) => {
      const url = String(input);
      if (url.endsWith('/api/tags')) {
        return new Response(JSON.stringify({ models: [{ name: 'llava' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/api/show')) {
        return new Response(
          JSON.stringify({ capabilities: ['completion', 'vision'] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`unexpected fetch to ${url}`);
    });
    const originalFetch = global.fetch;
    global.fetch = fetchMock as unknown as typeof fetch;
    try {
      const provider = new OllamaLLMProvider({ baseUrl: 'http://ollama.test' });
      const models = await provider.listModels();
      expect(models).toEqual([
        { id: 'llava', name: 'llava', supportsTools: false },
      ]);
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('leaves supportsTools unset (unknown) when /api/show fails, never falls back to a guess', async () => {
    const fetchMock = vi.fn<
      (...args: Parameters<typeof fetch>) => Promise<any>
    >(async (input) => {
      const url = String(input);
      if (url.endsWith('/api/tags')) {
        return new Response(
          JSON.stringify({ models: [{ name: 'broken-model' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.endsWith('/api/show')) {
        return new Response('not found', { status: 404 });
      }
      throw new Error(`unexpected fetch to ${url}`);
    });
    const originalFetch = global.fetch;
    global.fetch = fetchMock as unknown as typeof fetch;
    try {
      const provider = new OllamaLLMProvider({ baseUrl: 'http://ollama.test' });
      const models = await provider.listModels();
      expect(models).toEqual([{ id: 'broken-model', name: 'broken-model' }]);
      expect(models[0]).not.toHaveProperty('supportsTools');
    } finally {
      global.fetch = originalFetch;
    }
  });

  // station#1430 review, H-2: the opt-out that keeps a caller that only
  // needs ids/names (e.g. `OllamaAdapter.resolveModelId`) from paying for
  // capability lookups it will never read.
  test('skipCapabilityEnrichment performs zero /api/show calls and returns the base listing unmodified', async () => {
    const fetchMock = vi.fn<
      (...args: Parameters<typeof fetch>) => Promise<any>
    >(async (input) => {
      const url = String(input);
      if (url.endsWith('/api/tags')) {
        return new Response(
          JSON.stringify({ models: [{ name: 'llama3.2' }, { name: 'qwen' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(
        `unexpected fetch to ${url} — enrichment should be skipped`,
      );
    });
    const originalFetch = global.fetch;
    global.fetch = fetchMock as unknown as typeof fetch;
    try {
      const provider = new OllamaLLMProvider({ baseUrl: 'http://ollama.test' });
      const catalog = await provider.listModelCatalog({
        skipCapabilityEnrichment: true,
      });
      expect(catalog.models).toEqual([
        { id: 'llama3.2', name: 'llama3.2' },
        { id: 'qwen', name: 'qwen' },
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      global.fetch = originalFetch;
    }
  });

  // station#1430 review, L-3: the ONE timing test proving the H-1 invariant
  // holds — this is the assertion that was previously missing, and it fails
  // under the original 900ms-budget/800ms-timeout pair (see the fault
  // injection in the delivery report). Every requested model's /api/show
  // call hangs until aborted (never resolves on its own), and there are more
  // models than the enrichment concurrency, so — under the original
  // arithmetic — successive waves would push total enrichment time past
  // `MODEL_CATALOG_TIMEOUT_MS` (the outer budget `safeListModelCatalog`
  // wraps every `listModelCatalog` call in). Under the fixed arithmetic,
  // `listModelCatalog` must still resolve comfortably inside that budget,
  // with the base listing intact (none of the hung lookups ever completed,
  // so `supportsTools` stays unset — honestly unknown, not a guess).
  test('L-3: listModelCatalog with hung /api/show calls returns inside the outer catalog budget with the base listing intact', async () => {
    vi.useFakeTimers();
    try {
      const modelCount = 10; // > OLLAMA_CAPABILITY_CONCURRENCY (6)
      const tags = Array.from({ length: modelCount }, (_, index) => ({
        name: `model-${index}`,
      }));
      const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/api/tags')) {
          return new Response(JSON.stringify({ models: tags }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.endsWith('/api/show')) {
          // Hangs forever on its own — only ever settles via its own abort
          // signal, exactly like a real fetch against a stuck daemon.
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(new Error('aborted')),
              { once: true },
            );
          });
        }
        throw new Error(`unexpected fetch to ${url}`);
      });
      const originalFetch = global.fetch;
      global.fetch = fetchMock as unknown as typeof fetch;

      try {
        const provider = new OllamaLLMProvider({
          baseUrl: 'http://ollama.test',
        });
        let resolved = false;
        let value: Awaited<ReturnType<typeof provider.listModelCatalog>>;
        void provider.listModelCatalog().then((v) => {
          resolved = true;
          value = v;
          return v;
        });

        // Advance to just under the outer budget every real caller wraps
        // this in (safeListModelCatalog's withCatalogTimeout). If this is
        // still unresolved at this point, the outer race would have already
        // discarded the whole catalog in production.
        await vi.advanceTimersByTimeAsync(MODEL_CATALOG_TIMEOUT_MS - 50);

        expect(resolved).toBe(true);
        expect(value!.source).toBe('live');
        expect(value!.models).toHaveLength(modelCount);
        // Every /api/show call was cut short before completing, so none of
        // the base models were ever truthfully enriched.
        expect(
          value!.models.every((model) => !('supportsTools' in model)),
        ).toBe(true);
      } finally {
        global.fetch = originalFetch;
      }
    } finally {
      vi.useRealTimers();
    }
  });

  // station#1430 review, H-1 residual: the previous L-3 test alone couldn't
  // distinguish "deadline anchored to catalog start" from "deadline anchored
  // to enrichment start," because its own `/api/tags` mock resolved
  // instantly (T_tags ~= 0) — both anchors land at the same instant when
  // tags is fast. This is the discriminating case: a SLOW `/api/tags`
  // (1000ms — comfortably more than `OLLAMA_TAGS_ALLOWANCE_MS` (400), the
  // "loaded daemon" scenario the bound exists for) plus hung `/api/show`
  // calls, with enough models (10, > the 6-wide concurrency) to accumulate
  // multiple enrichment waves.
  //
  // Anchored-to-catalog-start (the fix): `deadline = 0 + 1100 = 1100`. By
  // the time tags returns at t=1000, only ~100ms of budget remains — less
  // than one lookup's `OLLAMA_CAPABILITY_TIMEOUT_MS` (400), so enrichment
  // never even starts. Total resolution ~= 1000ms (comfortably under the
  // outer 1500ms).
  //
  // Anchored-to-enrichment-start (the pre-residual-fix bug): enrichment
  // computes a FRESH `deadline = 1000 + 1100 = 2100` starting only after the
  // 1000ms tags delay. Wave 1 (6 models) starts at 1000, its lookups get cut
  // by their own per-call timeout at 1000+400=1400. Wave 2 (the remaining 4)
  // starts at 1400 (1400 <= 2100-400, still "enough time left" by the
  // faulty deadline), cut at 1400+400=1800. Total resolution ~= 1800ms —
  // past the outer 1500ms budget, reproducing the original H-1 consequence
  // one condition later (see the fault injection in the delivery report).
  test('H-1 residual: listModelCatalog with a SLOW /api/tags plus hung /api/show calls still returns inside the outer catalog budget', async () => {
    vi.useFakeTimers();
    try {
      const modelCount = 10; // > OLLAMA_CAPABILITY_CONCURRENCY (6)
      const tags = Array.from({ length: modelCount }, (_, index) => ({
        name: `model-${index}`,
      }));
      const TAGS_DELAY_MS = 1000; // >> OLLAMA_TAGS_ALLOWANCE_MS (400)
      const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/api/tags')) {
          return new Promise<Response>((resolve) => {
            setTimeout(
              () =>
                resolve(
                  new Response(JSON.stringify({ models: tags }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                  }),
                ),
              TAGS_DELAY_MS,
            );
          });
        }
        if (url.endsWith('/api/show')) {
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(new Error('aborted')),
              { once: true },
            );
          });
        }
        throw new Error(`unexpected fetch to ${url}`);
      });
      const originalFetch = global.fetch;
      global.fetch = fetchMock as unknown as typeof fetch;

      try {
        const provider = new OllamaLLMProvider({
          baseUrl: 'http://ollama.test',
        });
        let resolved = false;
        let value: Awaited<ReturnType<typeof provider.listModelCatalog>>;
        void provider.listModelCatalog().then((v) => {
          resolved = true;
          value = v;
          return v;
        });

        await vi.advanceTimersByTimeAsync(MODEL_CATALOG_TIMEOUT_MS - 50);

        expect(resolved).toBe(true);
        expect(value!.source).toBe('live');
        expect(value!.models).toHaveLength(modelCount);
        expect(
          value!.models.every((model) => !('supportsTools' in model)),
        ).toBe(true);
      } finally {
        global.fetch = originalFetch;
      }
    } finally {
      vi.useRealTimers();
    }
  });

  test('propagates catalog cancellation through health and prerequisites', async () => {
    const controller = new AbortController();
    controller.abort(new Error('catalog cancelled'));
    const provider = new OllamaLLMProvider({ baseUrl: 'http://ollama.test' });

    await expect(
      provider.healthCheck({ signal: controller.signal }),
    ).rejects.toThrow('catalog cancelled');
    await expect(
      provider.getPrerequisites({ signal: controller.signal }),
    ).rejects.toThrow('catalog cancelled');
  });
});
