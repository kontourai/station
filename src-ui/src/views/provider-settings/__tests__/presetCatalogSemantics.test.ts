import { openAICompatCatalogSemantics } from '@kontourai/station-contracts/openai-compat-catalog-semantics';
import { describe, expect, test } from 'vitest';
import { PROVIDER_PRESETS } from '../providerCatalog';

/*
 * archive#3653 — the drift trip-wire.
 *
 * Every one of these presets reaches the same `OpenAICompatLLMProvider`, and
 * what its empty `GET /models` MEANS now comes from the endpoint, not the
 * class. Adding a named cloud service here without adding its host to
 * `ENUMERATING_OPENAI_COMPAT_HOSTS` would silently make that service's
 * revoked-entitlement `[]` non-authoritative, and the stale configured
 * selector launchable. This test is the only thing that would notice.
 */

/** Presets that deliberately point at a local or operator-supplied endpoint. */
const OPERATOR_SUPPLIED_PRESET_IDS = new Set([
  'lmstudio',
  'litellm',
// Azure AI Foundry ships with an EMPTY base URL: the resource endpoint is
// per-account and Station cannot know it, which is the definition of an
// endpoint it has no catalogue knowledge of.
  'azure-foundry',
]);

describe('provider presets vs catalogue authority', () => {
  const openAICompatPresets = PROVIDER_PRESETS.filter(
    (preset) => preset.type === 'openai-compat',
  );

  test('there are OpenAI-compatible presets to check', () => {
    expect(openAICompatPresets.length).toBeGreaterThan(5);
  });

  test('every named cloud preset enumerates authoritatively', () => {
    const misdeclared = openAICompatPresets
      .filter((preset) => !OPERATOR_SUPPLIED_PRESET_IDS.has(preset.id))
      .filter(
        (preset) =>
          openAICompatCatalogSemantics(preset.config.baseUrl) !== 'no-models',
      )
      .map((preset) => `${preset.id} (${preset.config.baseUrl})`);

    expect(misdeclared).toEqual([]);
  });

  test('operator-supplied endpoints carry no catalogue statement', () => {
    for (const preset of openAICompatPresets.filter((candidate) =>
      OPERATOR_SUPPLIED_PRESET_IDS.has(candidate.id),
    )) {
      expect(openAICompatCatalogSemantics(preset.config.baseUrl)).toBe(
        'no-catalog',
      );
    }
  });
});
