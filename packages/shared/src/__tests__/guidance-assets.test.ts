import type { Skill } from '@kontourai/station-contracts/catalog';
import { describe, expect, test } from 'vitest';
import { skillToGuidanceAsset } from '../guidance-assets';

describe('guidance asset adapters', () => {
  test('maps installed skills into normalized guidance assets', () => {
    const skill: Skill = {
      id: 'skill-one',
      name: 'skill-one',
      description: 'Installed skill',
      installed: true,
      installedVersion: '1.2.3',
      version: '1.2.3',
      path: '/tmp/skills/skill-one',
      source: 'local',
      body: 'Skill body',
      resources: [{ name: 'Guide', path: 'references/guide.md' }],
    };

    expect(skillToGuidanceAsset(skill)).toEqual(
      expect.objectContaining({
        id: 'skill-one',
        kind: 'skill',
        name: 'skill-one',
        body: 'Skill body',
        storageMode: 'skill-package',
        runtimeMode: 'skill-catalog',
        packaging: expect.objectContaining({
          installable: true,
          installed: true,
          installedVersion: '1.2.3',
          path: '/tmp/skills/skill-one',
          resources: [{ name: 'Guide', path: 'references/guide.md' }],
        }),
      }),
    );
  });
});
