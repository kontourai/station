import { beforeEach, describe, expect, test, vi } from 'vitest';
import { resolveExactModelSelector } from '../model-catalog.js';
import { OpenAICompatLLMProvider } from '../openai-compat-provider.js';

/*
 * archive#3653 delta review HIGH-1, at the seam that matters: a REAL
 * `OpenAICompatLLMProvider` built for two different endpoints. The class is
 * the same, so anything that reads the class rather than the instance cannot
 * tell these two cases apart — and one of them is an OpenAI account whose
 * last entitlement was revoked.
 */
describe('OpenAI-compatible empty catalogue authority (station#3653)', () => {
  const emptyCatalogue = () =>
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ object: 'list', data: [] }),
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ object: 'list', data: [] }),
    })) as unknown as typeof fetch;

  beforeEach(() => {
    vi.stubGlobal('fetch', emptyCatalogue());
  });

  test('a named cloud service keeps its empty list authoritative', async () => {
    const provider = new OpenAICompatLLMProvider({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
    });
    expect(provider.emptyCatalogMeaning).toBe('no-models');

    await expect(
      resolveExactModelSelector(provider, 'gpt-4.1', [
        { id: 'gpt-4.1', name: 'gpt-4.1' },
      ]),
    ).rejects.toThrow("Model selector 'gpt-4.1' is not launchable");
  });

  test('a self-hosted endpoint substitutes the configured selector', async () => {
    const provider = new OpenAICompatLLMProvider({
      baseUrl: 'http://127.0.0.1:4601/v1',
    });
    expect(provider.emptyCatalogMeaning).toBe('no-catalog');

    await expect(
      resolveExactModelSelector(provider, 'local-model', [
        { id: 'local-model', name: 'local-model' },
      ]),
    ).resolves.toBe('local-model');
  });

  test('the two differ only by endpoint, on the same adapter class', () => {
    const cloud = new OpenAICompatLLMProvider({
      baseUrl: 'https://api.groq.com/openai/v1',
    });
    const local = new OpenAICompatLLMProvider({
      baseUrl: 'http://localhost:1234/v1',
    });
    expect(cloud.constructor).toBe(local.constructor);
    expect(cloud.emptyCatalogMeaning).not.toBe(local.emptyCatalogMeaning);
  });
});
