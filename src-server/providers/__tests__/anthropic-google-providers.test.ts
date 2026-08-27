import { afterEach, describe, expect, test, vi } from 'vitest';
import { AnthropicLLMProvider } from '../llm/anthropic-llm-provider.js';
import { GoogleLLMProvider } from '../llm/google-llm-provider.js';

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockFetch(handler: (url: string) => { ok: boolean; json: unknown }) {
  const fn = vi.fn<typeof fetch>(async (input, _init) => {
    const url = String(input);
    const { ok, json } = handler(url);
    return new Response(JSON.stringify(json), {
      status: ok ? 200 : 500,
      headers: { 'content-type': 'application/json' },
    });
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe('AnthropicLLMProvider', () => {
  test('listModels parses { data: [{ id, display_name }] }', async () => {
    const fn = mockFetch(() => ({
      ok: true,
      json: {
        data: [
          {
            id: 'claude-3-5-sonnet-20241022',
            display_name: 'Claude 3.5 Sonnet',
          },
          { id: 'claude-3-haiku-20240307' },
        ],
      },
    }));
    const provider = new AnthropicLLMProvider({ apiKey: 'sk-ant-test' });
    const models = await provider.listModels();
    expect(models).toEqual([
      { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet' },
      { id: 'claude-3-haiku-20240307', name: 'claude-3-haiku-20240307' },
    ]);
    const [url, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('https://api.anthropic.com/v1/models');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe(
      'sk-ant-test',
    );
    expect((init.headers as Record<string, string>)['anthropic-version']).toBe(
      '2023-06-01',
    );
  });

  test('listModels returns [] without an api key (no fetch)', async () => {
    const fn = mockFetch(() => ({ ok: true, json: { data: [] } }));
    const provider = new AnthropicLLMProvider({});
    expect(await provider.listModels()).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  test('listModels returns [] when fetch throws', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const provider = new AnthropicLLMProvider({ apiKey: 'sk-ant-test' });
    expect(await provider.listModels()).toEqual([]);
    // RT-06: the reason is carried so a redacting consumer can say WHY the
    // connection failed. Discarding it is what left "Connection failed" with
    // no reason and no HTTP code anywhere in the product.
    expect(await provider.listModelCatalog()).toEqual({
      source: 'unavailable',
      models: [],
      reason: 'network down',
      // Delta review H1: a transport failure is not a catalog-less endpoint.
      reasonKind: 'unreachable',
    });
  });

  test('distinguishes a successful empty catalog from unavailable discovery', async () => {
    mockFetch(() => ({ ok: true, json: { data: [] } }));

    await expect(
      new AnthropicLLMProvider({
        apiKey: 'sk-ant-test',
      }).listModelCatalog(),
    ).resolves.toEqual({ source: 'live', models: [] });
  });

  test('follows pagination cursors until the requested model limit', async () => {
    const fn = mockFetch((url) => {
      if (url.includes('after_id=claude-1')) {
        return {
          ok: true,
          json: {
            data: [{ id: 'claude-2', display_name: 'Claude 2' }],
            has_more: false,
          },
        };
      }
      return {
        ok: true,
        json: {
          data: [{ id: 'claude-1', display_name: 'Claude 1' }],
          has_more: true,
          last_id: 'claude-1',
        },
      };
    });

    await expect(
      new AnthropicLLMProvider({ apiKey: 'sk-ant-test' }).listModels({
        maxEntries: 2,
      }),
    ).resolves.toEqual([
      { id: 'claude-1', name: 'Claude 1' },
      { id: 'claude-2', name: 'Claude 2' },
    ]);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('does not fetch another Anthropic page after reaching maxEntries', async () => {
    const fn = mockFetch(() => ({
      ok: true,
      json: {
        data: [{ id: 'claude-1' }],
        has_more: true,
        last_id: 'claude-1',
      },
    }));

    await expect(
      new AnthropicLLMProvider({ apiKey: 'sk-ant-test' }).listModelCatalog({
        maxEntries: 1,
      }),
    ).resolves.toEqual({
      source: 'live',
      models: [{ id: 'claude-1', name: 'claude-1' }],
      truncated: true,
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('rejects a non-advancing Anthropic cursor', async () => {
    const fn = mockFetch(() => ({
      ok: true,
      json: {
        data: [{ id: 'claude-1' }],
        has_more: true,
        last_id: 'repeated-cursor',
      },
    }));

    await expect(
      new AnthropicLLMProvider({
        apiKey: 'sk-ant-test',
      }).listModelCatalog(),
    ).resolves.toEqual({
      source: 'unavailable',
      models: [],
      reason: 'Anthropic returned a non-advancing model cursor.',
      // The route answered; the body just was not a usable catalog.
      reasonKind: 'no-catalog',
    });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('propagates catalog cancellation instead of reporting unavailable', async () => {
    const controller = new AbortController();
    global.fetch = vi.fn((_input, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(init.signal?.reason),
          { once: true },
        );
      });
    }) as unknown as typeof fetch;

    const pending = new AnthropicLLMProvider({
      apiKey: 'sk-ant-test',
    }).listModelCatalog({ signal: controller.signal });
    controller.abort(new Error('catalog cancelled'));

    await expect(pending).rejects.toThrow('catalog cancelled');
  });

  test('getPrerequisites is missing without a key and installed with one', async () => {
    const missing = await new AnthropicLLMProvider({}).getPrerequisites();
    expect(missing[0]?.id).toBe('anthropic-api-key');
    expect(missing[0]?.status).toBe('missing');
    const installed = await new AnthropicLLMProvider({
      apiKey: 'sk-ant-test',
    }).getPrerequisites();
    expect(installed[0]?.status).toBe('installed');
  });

  test('healthCheck reflects listModels result', async () => {
    mockFetch(() => ({ ok: true, json: { data: [{ id: 'm1' }] } }));
    expect(await new AnthropicLLMProvider({ apiKey: 'k' }).healthCheck()).toBe(
      true,
    );
    mockFetch(() => ({ ok: true, json: { data: [] } }));
    expect(await new AnthropicLLMProvider({ apiKey: 'k' }).healthCheck()).toBe(
      false,
    );
  });
});

describe('GoogleLLMProvider', () => {
  test('listModels parses { models: [{ name, displayName }] } and strips prefix', async () => {
    const fn = mockFetch(() => ({
      ok: true,
      json: {
        models: [
          {
            name: 'models/gemini-1.5-pro',
            displayName: 'Gemini 1.5 Pro',
            supportedGenerationMethods: ['generateContent'],
          },
          {
            name: 'models/text-embedding-004',
            displayName: 'Text Embedding',
            supportedGenerationMethods: ['embedContent'],
          },
          { name: 'models/gemini-2.0-flash' },
        ],
      },
    }));
    const provider = new GoogleLLMProvider({ apiKey: 'AIza-test' });
    const models = await provider.listModels();
    expect(models).toEqual([{ id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro' }]);
    const [url, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(
      'https://generativelanguage.googleapis.com/v1beta/models',
    );
    expect(url).not.toContain('AIza-test');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe(
      'AIza-test',
    );
  });

  test('listModels returns [] without an api key (no fetch)', async () => {
    const fn = mockFetch(() => ({ ok: true, json: { models: [] } }));
    const provider = new GoogleLLMProvider({});
    expect(await provider.listModels()).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  test('listModels returns [] when fetch throws', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    global.fetch = vi.fn(async () => {
      throw new Error('request failed: ?key=AIza-test');
    }) as unknown as typeof fetch;
    const provider = new GoogleLLMProvider({ apiKey: 'AIza-test' });
    expect(await provider.listModels()).toEqual([]);
    // The reason is CARRIED (a consumer redacts it against the connection's
    // own config before showing it) and still never LOGGED.
    expect(await provider.listModelCatalog()).toEqual({
      source: 'unavailable',
      models: [],
      reason: 'request failed: ?key=AIza-test',
      reasonKind: 'unreachable',
    });
    expect(JSON.stringify(debug.mock.calls)).not.toContain('AIza-test');
  });

  test('distinguishes a successful empty catalog from unavailable discovery', async () => {
    mockFetch(() => ({ ok: true, json: { models: [] } }));

    await expect(
      new GoogleLLMProvider({ apiKey: 'AIza-test' }).listModelCatalog(),
    ).resolves.toEqual({ source: 'live', models: [] });
  });

  test('follows Google page tokens until the requested model limit', async () => {
    const fn = mockFetch((url) => {
      if (url.includes('pageToken=page-2')) {
        return {
          ok: true,
          json: {
            models: [
              {
                name: 'models/gemini-2',
                displayName: 'Gemini 2',
                supportedGenerationMethods: ['generateContent'],
              },
            ],
          },
        };
      }
      return {
        ok: true,
        json: {
          models: [
            {
              name: 'models/gemini-1',
              displayName: 'Gemini 1',
              supportedGenerationMethods: ['generateContent'],
            },
          ],
          nextPageToken: 'page-2',
        },
      };
    });

    await expect(
      new GoogleLLMProvider({ apiKey: 'AIza-test' }).listModels({
        maxEntries: 2,
      }),
    ).resolves.toEqual([
      { id: 'gemini-1', name: 'Gemini 1' },
      { id: 'gemini-2', name: 'Gemini 2' },
    ]);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('does not fetch another Google page after reaching maxEntries', async () => {
    const fn = mockFetch(() => ({
      ok: true,
      json: {
        models: [
          {
            name: 'models/gemini-1',
            supportedGenerationMethods: ['generateContent'],
          },
        ],
        nextPageToken: 'page-2',
      },
    }));

    await expect(
      new GoogleLLMProvider({ apiKey: 'AIza-test' }).listModelCatalog({
        maxEntries: 1,
      }),
    ).resolves.toEqual({
      source: 'live',
      models: [{ id: 'gemini-1', name: 'gemini-1' }],
      truncated: true,
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('rejects a non-advancing Google page token without logging the key', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const fn = mockFetch(() => ({
      ok: true,
      json: {
        models: [
          {
            name: 'models/gemini-1',
            supportedGenerationMethods: ['generateContent'],
          },
        ],
        nextPageToken: 'repeated-token',
      },
    }));

    await expect(
      new GoogleLLMProvider({
        apiKey: 'AIza-test',
      }).listModelCatalog(),
    ).resolves.toEqual({
      source: 'unavailable',
      models: [],
      reason: 'Google returned a non-advancing model page token.',
      reasonKind: 'no-catalog',
    });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(debug.mock.calls)).not.toContain('AIza-test');
  });

  test('propagates catalog cancellation instead of reporting unavailable', async () => {
    const controller = new AbortController();
    global.fetch = vi.fn((_input, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(init.signal?.reason),
          { once: true },
        );
      });
    }) as unknown as typeof fetch;

    const pending = new GoogleLLMProvider({
      apiKey: 'AIza-test',
    }).listModelCatalog({ signal: controller.signal });
    controller.abort(new Error('catalog cancelled'));

    await expect(pending).rejects.toThrow('catalog cancelled');
  });

  test('getPrerequisites is missing without a key and installed with one', async () => {
    const missing = await new GoogleLLMProvider({}).getPrerequisites();
    expect(missing[0]?.id).toBe('google-api-key');
    expect(missing[0]?.status).toBe('missing');
    const installed = await new GoogleLLMProvider({
      apiKey: 'AIza-test',
    }).getPrerequisites();
    expect(installed[0]?.status).toBe('installed');
  });

  test('healthCheck reflects listModels result', async () => {
    mockFetch(() => ({
      ok: true,
      json: {
        models: [
          {
            name: 'models/gemini-1.5-pro',
            supportedGenerationMethods: ['generateContent'],
          },
        ],
      },
    }));
    expect(await new GoogleLLMProvider({ apiKey: 'k' }).healthCheck()).toBe(
      true,
    );
    mockFetch(() => ({ ok: true, json: { models: [] } }));
    expect(await new GoogleLLMProvider({ apiKey: 'k' }).healthCheck()).toBe(
      false,
    );
  });
});
