import { existsSync, readFileSync } from 'node:fs';
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

  test('page renderers cannot restore a surface-owned placement control', () => {
    const retiredAction = resolve(
      process.cwd(),
      'src-ui/src/workspace-panes/WorkspacePaneDockAction.tsx',
    );
    expect(existsSync(retiredAction)).toBe(false);

    for (const sourceFile of [
      'src-ui/src/views/home/HomeWorkspacePane.tsx',
      'src-ui/src/views/activity/ActivityWorkspacePane.tsx',
    ]) {
      const source = readFileSync(resolve(process.cwd(), sourceFile), 'utf8');
      expect(source, sourceFile).not.toMatch(
        /WorkspacePaneDockAction|Dock this pane|useWorkspacePaneDockAction/,
      );
    }
  });
});
