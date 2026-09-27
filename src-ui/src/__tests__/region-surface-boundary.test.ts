// @vitest-environment jsdom

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { REGION_SURFACE_SHELLS } from '../app-shell/RegionShells';
import {
  DOCK_REGION_IDS,
  REGION_SURFACE_REGISTRY,
} from '../regions/region-model';
import {
  REGION_SURFACE_PANES,
  REGION_SURFACE_SOURCE_FILES,
} from '../regions/region-surface-panes';

describe('registered surface region boundary', () => {
  /**
   * Two renderer families since #2045, each derived from the regions a
   * surface declares: `main` renders its occupant through a shell
   * (`REGION_SURFACE_SHELLS`), a dock region renders its occupant as a pane
   * of the region's host (`REGION_SURFACE_PANES`). A surface must have the
   * renderer for every family it declares and none for a family it does
   * not, or a placement the toolbar offers renders nothing.
   */
  test('every registered surface has a renderer for exactly the region families it declares', () => {
    const surfaces = [...REGION_SURFACE_REGISTRY.values()];
    const declaringMain = surfaces
      .filter((surface) => surface.regions.includes('main'))
      .map((surface) => surface.id)
      .sort();
    const declaringDock = surfaces
      .filter((surface) =>
        surface.regions.some((region) =>
          (DOCK_REGION_IDS as readonly string[]).includes(region),
        ),
      )
      .map((surface) => surface.id)
      .sort();
    // Which surfaces declare which regions is pinned by region-model.test.ts;
    // this test owns only the renderer tables matching those declarations.
    expect(declaringMain.length).toBeGreaterThan(0);
    expect(declaringDock.length).toBeGreaterThan(0);
    expect([...REGION_SURFACE_SHELLS.keys()].sort()).toEqual(declaringMain);
    expect([...REGION_SURFACE_PANES.keys()].sort()).toEqual(declaringDock);
    expect([...new Set([...declaringMain, ...declaringDock])].sort()).toEqual(
      [...REGION_SURFACE_REGISTRY.keys()].sort(),
    );
  });
  test('registered surface renderers never read region state directly', () => {
    // Renderers must not read region state; the state-free useShowSurface command hook is permitted.
    // Every registered surface names its renderer, and no source names a
    // surface that is gone (the table lives outside the entry-chunk
    // registry, #90 D9, so the two are pinned to each other here).
    expect(Object.keys(REGION_SURFACE_SOURCE_FILES).sort()).toEqual(
      [...REGION_SURFACE_REGISTRY.keys()].sort(),
    );
    for (const surface of REGION_SURFACE_REGISTRY.values()) {
      const sourceFile = REGION_SURFACE_SOURCE_FILES[surface.id];
      if (!sourceFile) throw new Error(`${surface.id} names no renderer`);
      const source = readFileSync(resolve(process.cwd(), sourceFile), 'utf8');
      expect(source, surface.id).not.toMatch(
        /from ['"][^'"]*(?:RegionModelContext|regions\/region-model)['"]|useRegionModel(?:Optional)?\s*\(/,
      );
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

/**
 * Every identifier the legacy docked-Home path's files (#1384 C1, #928
 * C2a/C2b) exported or every string they rendered: the placement control and
 * its context, the away state and its derivation, the occupant table and
 * picker, the mobile occupant-switch seams. Bare
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
