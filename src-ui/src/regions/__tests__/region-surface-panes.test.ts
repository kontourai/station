// @vitest-environment node

import { parseWorkspacePaneInstance } from '@kontourai/station-contracts/workspace-pane';
import { describe, expect, test } from 'vitest';
import { DOCK_REGION_IDS, REGION_SURFACE_REGISTRY } from '../region-model';
import {
  REGION_SURFACE_PANES,
  regionSurfaceOfPane,
  regionSurfacePane,
} from '../region-surface-panes';

/**
 * #2045: the inventory is the join between region surfaces and the panes a
 * region host renders them as. Pinned in both directions to the registry's
 * dock-capable surfaces, so a surface that gains a dock placement without a
 * pane (the toolbar would offer a region that renders nothing) and a pane
 * for a surface that declares no dock region (a label no host reads) both
 * fail here rather than at a user's click.
 */
describe('region surface panes (#2045)', () => {
  test('exactly the surfaces declaring a dock region have a pane', () => {
    const dockCapable = [...REGION_SURFACE_REGISTRY.values()]
      .filter((surface) =>
        surface.regions.some((region) =>
          (DOCK_REGION_IDS as readonly string[]).includes(region),
        ),
      )
      .map((surface) => surface.id)
      .sort();
    expect(dockCapable).toEqual(['activity', 'chat']);
    expect([...REGION_SURFACE_PANES.keys()].sort()).toEqual(dockCapable);
  });

  test("each entry's instance is canonical by its own predicate and resolves back to its surface", () => {
    for (const [surfaceId, pane] of REGION_SURFACE_PANES) {
      expect(pane.surfaceId).toBe(surfaceId);
      expect(pane.isCanonical(pane.instance), surfaceId).toBe(true);
      expect(regionSurfaceOfPane(pane.instance)).toBe(surfaceId);
      expect(regionSurfacePane(surfaceId)).toBe(pane);
    }
  });

  test('a same-shaped impostor and a pane no surface owns resolve to no surface', () => {
    const impostorActivity = parseWorkspacePaneInstance({
      version: '1.0',
      descriptorId: 'pane:builtin:activity',
      instanceId: 'workspace-activity-impostor',
      stateKey: 'workspace-activity-impostor',
      boundContext: { sourceId: 'builtin:workspace-activity' },
    });
    const home = parseWorkspacePaneInstance({
      version: '1.0',
      descriptorId: 'pane:builtin:home',
      instanceId: 'workspace-home',
      stateKey: 'workspace-home',
      boundContext: { sourceId: 'builtin:workspace-home' },
    });
    if (!impostorActivity || !home) throw new Error('fixtures must parse');
    expect(regionSurfaceOfPane(impostorActivity)).toBeNull();
    expect(regionSurfaceOfPane(home)).toBeNull();
    expect(regionSurfacePane('home')).toBeUndefined();
  });
});
