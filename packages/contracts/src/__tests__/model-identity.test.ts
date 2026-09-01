import { describe, expect, test } from 'vitest';
import {
  CURATED_MODEL_IDENTITIES,
  curatedModelIdentityFor,
} from '../model-inventory.js';

describe('curated model identity', () => {
  test('groups only the exact provider-native ids named by reviewed data', () => {
    const known = CURATED_MODEL_IDENTITIES[0]!;
    for (const providerModel of known.providerModels) {
      expect(curatedModelIdentityFor(providerModel)?.canonicalId).toBe(
        known.canonicalId,
      );
    }
    expect(curatedModelIdentityFor('claude-sonnet-4-5-v2')).toBeUndefined();
    expect(
      curatedModelIdentityFor('anthropic/claude-sonnet-4.5:free'),
    ).toBeUndefined();
  });

  test('exposes the verification anchor for recognised data', () => {
    expect(curatedModelIdentityFor('claude-sonnet-4-5')).toEqual({
      canonicalId: 'anthropic:claude-sonnet-4-5',
      verifiedAgainst: 'Anthropic model documentation, reviewed 2026-08-31',
    });
  });
});
