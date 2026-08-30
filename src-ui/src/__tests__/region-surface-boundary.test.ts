import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { REGION_SURFACE_REGISTRY } from '../regions/region-model';

describe('registered surface region boundary', () => {
  test('registered surface renderers never read region state directly', () => {
    for (const surface of REGION_SURFACE_REGISTRY.values()) {
      const source = readFileSync(
        resolve(process.cwd(), surface.sourceFile),
        'utf8',
      );
      expect(source, surface.id).not.toMatch(
        /from ['"][^'"]*(?:RegionModelContext|regions\/region-model)['"]|useRegionModel(?:Optional)?\s*\(/,
      );
    }
  });
});
