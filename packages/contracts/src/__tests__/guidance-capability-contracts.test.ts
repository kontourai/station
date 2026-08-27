import { describe, expect, test } from 'vitest';
import type {
  GuidanceAssetReference,
  ProviderCapabilityInventory,
  Skill,
} from '../catalog.js';

describe('guidance capability contracts', () => {
  test('skill provenance can reference a source guidance asset', () => {
    const source: GuidanceAssetReference = {
      kind: 'provider-capability',
      id: 'codex:review',
      name: 'review',
      owner: 'provider',
      providerId: 'codex',
    };
    const skill: Skill = {
      id: 'review-skill',
      name: 'Review Skill',
      installed: true,
      provenance: {
        createdFrom: {
          kind: 'asset',
          action: 'provider-capability-to-skill',
          convertedAt: '2026-04-25T00:00:00.000Z',
          asset: source,
        },
      },
    };

    expect(skill.provenance?.createdFrom?.asset).toEqual(source);
  });

  test('provider capability inventory is keyed to provider connection truth', () => {
    const inventory: ProviderCapabilityInventory = {
      providerId: 'codex',
      connectionId: 'runtime-codex',
      displayName: 'Codex CLI',
      status: 'ready',
      authStatus: 'authenticated',
      version: '1.0.0',
      checkedAt: '2026-04-25T00:00:00.000Z',
      freshness: 'live',
      source: 'provider',
      models: [{ id: 'gpt-5.5', name: 'GPT-5.5' }],
      skills: [
        {
          id: 'codex:review',
          name: 'review',
          enabled: true,
          provenance: {
            kind: 'provider-capability',
            id: 'codex:review',
            name: 'review',
            owner: 'provider',
            providerId: 'codex',
            connectionId: 'runtime-codex',
          },
        },
      ],
      slashCommands: [],
    };

    expect(inventory.connectionId).toBe('runtime-codex');
    expect(inventory.skills[0].provenance.owner).toBe('provider');
  });
});
