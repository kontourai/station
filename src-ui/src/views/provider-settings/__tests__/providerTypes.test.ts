import { describe, expect, it } from 'vitest';
import { PROVIDER_PRESETS, PROVIDER_TYPES } from '../providerCatalog';

describe('PROVIDER_PRESETS', () => {
  it('has unique, non-empty ids', () => {
    const ids = PROVIDER_PRESETS.map((preset) => preset.id);
    expect(ids.every((id) => id.trim().length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('resolves every preset to a registered primitive type', () => {
    const registeredTypes = new Set(
      PROVIDER_TYPES.map((option) => option.type),
    );
    for (const preset of PROVIDER_PRESETS) {
      expect(registeredTypes).toContain(preset.type);
    }
  });

  it('prefills a well-formed http(s) base URL, or leaves it deliberately blank', () => {
    for (const preset of PROVIDER_PRESETS) {
      // An empty baseUrl is the per-resource case (e.g. Azure AI Foundry):
      // the user pastes their own endpoint and prerequisites stay 'missing'
      // until they do. Anything non-empty must parse as http(s).
      if (preset.config.baseUrl === '') continue;
      const parsed = new URL(preset.config.baseUrl);
      expect(['http:', 'https:']).toContain(parsed.protocol);
    }
  });

  it('offers the hosted-router presets by id', () => {
    const ids = new Set(PROVIDER_PRESETS.map((preset) => preset.id));
    for (const expected of [
      'openai',
      'openrouter',
      'fireworks',
      'meta',
      'xai',
      'mistral',
      'deepseek',
      'together',
      'cerebras',
      'vercel-gateway',
      'azure-foundry',
    ])
      expect(ids).toContain(expected);
  });
});
