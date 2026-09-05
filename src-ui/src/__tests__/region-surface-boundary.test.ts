// @vitest-environment jsdom

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { REGION_SURFACE_SHELLS } from '../app-shell/RegionShells';
import { REGION_SURFACE_REGISTRY } from '../regions/region-model';

describe('registered surface region boundary', () => {
  test('every registered surface has exactly one region shell', () => {
    expect([...REGION_SURFACE_REGISTRY.keys()].sort()).toEqual(
      [...REGION_SURFACE_SHELLS.keys()].sort(),
    );
  });
  test('registered surface renderers never read region state directly', () => {
    // Renderers must not read region state; the state-free useShowSurface command hook is permitted.
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
    for (const retired of RETIRED_FILES) {
      expect(existsSync(resolve(process.cwd(), retired)), retired).toBe(false);
    }

    for (const sourceFile of [
      'src-ui/src/views/home/HomeWorkspacePane.tsx',
      'src-ui/src/views/activity/ActivityWorkspacePane.tsx',
    ]) {
      const source = readFileSync(resolve(process.cwd(), sourceFile), 'utf8');
      expect(source, sourceFile).not.toMatch(RETIRED_IDENTIFIERS);
    }
  });

  /**
   * #928 C2b: the whole legacy docked-Home path is gone, not just its
   * page-side controls. Every identifier it exported is scanned out of the
   * ENTIRE UI tree (source and tests alike, this file excepted — it is the
   * one place the names may appear), so a "helpful" re-introduction under any
   * directory reds by file and identifier rather than quietly re-growing the
   * second placement mechanism the region model replaced.
   */
  test('no UI source or test re-introduces a retired docked-Home identifier', () => {
    const offenders: string[] = [];
    const self = resolve(process.cwd(), THIS_FILE);
    for (const file of walk(resolve(process.cwd(), 'src-ui/src'))) {
      if (file === self) continue;
      const hit = RETIRED_IDENTIFIERS.exec(readFileSync(file, 'utf8'));
      if (hit) offenders.push(`${relative(process.cwd(), file)}: ${hit[0]}`);
    }
    expect(offenders).toEqual([]);
  });
});

const THIS_FILE = 'src-ui/src/__tests__/region-surface-boundary.test.ts';

/** The files the legacy docked-Home path lived in (#1384 C1, #928 C2a/C2b). */
const RETIRED_FILES = [
  'src-ui/src/workspace-panes/WorkspacePaneDockAction.tsx',
  'src-ui/src/workspace-panes/WorkspacePaneDockContext.tsx',
  'src-ui/src/workspace-panes/WorkspacePaneAwayState.tsx',
  'src-ui/src/workspace-panes/DockOccupantPicker.tsx',
  'src-ui/src/workspace-panes/ambientDockOccupants.ts',
];

/**
 * Every identifier those files exported or every string they rendered: the
 * placement control and its context, the away state and its derivation, the
 * occupant table and picker, the mobile occupant-switch seams. Bare
 * `occupant` is NOT here — it is the region model's own word for what a
 * region holds.
 */
const RETIRED_IDENTIFIERS =
  /WorkspacePaneDockAction|useWorkspacePaneDockAction|WorkspacePaneDockContext|Dock this pane|dockPaneAsOnlyContent|isAmbientDockOccupant|occupantInstanceId|undockOccupant|WorkspacePaneAwayState|Bring it back here|DockOccupantPicker|occupantPicker|Docked pane:|dock-occupant-|mobile-occupant-picker|AMBIENT_DOCK_RENDERABLE_PANES|ambientDockDescriptorFor|ambientDockOccupantChoices|ambientDockOccupantRouteViewType|chooseAmbientOccupant|onSwitchOccupant|useMobileDockOccupantPicker|MOBILE_DOCK_OCCUPANT_PICKER_QUERY|shouldMaximizeAfterDockingAsOnlyContent|shouldMaximizeOnOccupantChoice|AmbientDockShellApi/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = resolve(dir, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(?:ts|tsx|css)$/.test(entry) ? [path] : [];
  });
}
