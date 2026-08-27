import { describe, expect, it } from 'vitest';
import { PROVIDER_PRESETS } from '../providerCatalog';
import { filterProviderChoices } from '../providerChoiceSearch';

const textOf = (preset: { name: string; desc: string }) => [
  preset.name,
  preset.desc,
];

describe('filterProviderChoices', () => {
  it('returns catalog order untouched for an empty query', () => {
    expect(filterProviderChoices('', PROVIDER_PRESETS, textOf)).toEqual(
      PROVIDER_PRESETS,
    );
    expect(filterProviderChoices('   ', PROVIDER_PRESETS, textOf)).toEqual(
      PROVIDER_PRESETS,
    );
  });

  it('drops non-matches and ranks a name prefix first', () => {
    const names = filterProviderChoices('fire', PROVIDER_PRESETS, textOf).map(
      (preset) => preset.name,
    );
    expect(names[0]).toBe('Fireworks AI');
    // Power comes from naming presets that ARE in this list and must NOT
    // survive the query: 'fire' has no subsequence in either of these.
    expect(names).not.toContain('OpenAI');
    expect(names).not.toContain('LM Studio');
    expect(names.length).toBeLessThan(PROVIDER_PRESETS.length);
  });

  it('matches fuzzily on subsequences and on descriptions', () => {
    const bySubsequence = filterProviderChoices(
      'vrcl',
      PROVIDER_PRESETS,
      textOf,
    );
    expect(bySubsequence.map((preset) => preset.name)).toContain(
      'Vercel AI Gateway',
    );
    const byDesc = filterProviderChoices('grok', PROVIDER_PRESETS, textOf);
    expect(byDesc.map((preset) => preset.name)).toContain('xAI');
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterProviderChoices('zzzzzz', PROVIDER_PRESETS, textOf)).toEqual(
      [],
    );
  });
});
