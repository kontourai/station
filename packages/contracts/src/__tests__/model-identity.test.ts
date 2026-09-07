import { describe, expect, test } from 'vitest';
import {
  CURATED_MODEL_IDENTITIES,
  curatedModelIdentityFor,
  modelRouteFamilyFor,
} from '../model-inventory.js';

describe('curated model identity', () => {
  test('recognises each reviewed (family, id) route exactly', () => {
    const known = CURATED_MODEL_IDENTITIES[0]!;
    for (const route of known.routes) {
      expect(curatedModelIdentityFor(route)?.canonicalId).toBe(
        known.canonicalId,
      );
    }
    expect(
      curatedModelIdentityFor({
        family: 'anthropic',
        providerModel: 'claude-sonnet-4-5-v2',
      }),
    ).toBeUndefined();
    expect(
      curatedModelIdentityFor({
        family: 'openrouter',
        providerModel: 'anthropic/claude-sonnet-4.5:free',
      }),
    ).toBeUndefined();
  });

  // #1208 review: `sonnet` is Claude Sonnet 4.5 on the Claude Code engine and
  // nothing in particular anywhere else. The same id from another family --
  // an OpenAI-compatible endpoint exposing a model called "sonnet" -- must not
  // inherit the identity, or two unrelated models render as one.
  test('the same id in a different family carries no identity', () => {
    expect(
      curatedModelIdentityFor({ family: 'claude', providerModel: 'sonnet' })
        ?.canonicalId,
    ).toBe('anthropic:claude-sonnet-4-5');
    expect(
      curatedModelIdentityFor({ family: 'anthropic', providerModel: 'sonnet' }),
    ).toBeUndefined();
    expect(
      curatedModelIdentityFor({
        family: 'openrouter',
        providerModel: 'sonnet',
      }),
    ).toBeUndefined();
    expect(
      curatedModelIdentityFor({ family: undefined, providerModel: 'sonnet' }),
    ).toBeUndefined();
  });

  test('exposes the verification anchor for recognised data', () => {
    expect(
      curatedModelIdentityFor({
        family: 'anthropic',
        providerModel: 'claude-sonnet-4-5',
      }),
    ).toEqual({
      canonicalId: 'anthropic:claude-sonnet-4-5',
      verifiedAgainst: 'Anthropic model documentation, reviewed 2026-08-31',
    });
  });
});

describe('modelRouteFamilyFor', () => {
  test('names the family from the connection, never from a model', () => {
    expect(modelRouteFamilyFor({ type: 'bedrock' })).toBe('bedrock');
    expect(modelRouteFamilyFor({ type: 'anthropic' })).toBe('anthropic');
    expect(modelRouteFamilyFor({ type: 'claude' })).toBe('claude');
    expect(modelRouteFamilyFor({ type: 'ollama' })).toBeUndefined();
    expect(modelRouteFamilyFor({ type: 'codex' })).toBeUndefined();
  });

  test('an OpenAI-compatible endpoint is openrouter only at that exact origin', () => {
    expect(
      modelRouteFamilyFor({
        type: 'openai-compat',
        config: { baseUrl: 'https://openrouter.ai/api/v1' },
      }),
    ).toBe('openrouter');
    for (const baseUrl of [
      'https://api.openai.com/v1',
      'https://openrouter.ai.evil.example/api/v1',
      'https://user@openrouter.ai/api/v1',
      'http://openrouter.ai/api/v1',
      'not a url',
    ]) {
      expect(
        modelRouteFamilyFor({ type: 'openai-compat', config: { baseUrl } }),
        baseUrl,
      ).toBeUndefined();
    }
    expect(modelRouteFamilyFor({ type: 'openai-compat' })).toBeUndefined();
  });
});
