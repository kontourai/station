import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as basisPane from '@kontourai/station-basis-pane';
import * as boardPane from '@kontourai/station-board-pane/workspace-board-pane';
import * as contracts from '@kontourai/station-contracts';
import { WORKSPACE_ACTIVITY_PANE_DESCRIPTOR } from '@kontourai/station-contracts/workspace-activity-pane';
import { WORKSPACE_CHAT_PANE_DESCRIPTOR } from '@kontourai/station-contracts/workspace-chat-pane';
import type { WorkspacePaneDescriptor } from '@kontourai/station-contracts/workspace-pane';
import { paneAdaptationFromLayoutTab } from '@kontourai/station-contracts/workspace-pane-layout-adapter';
import { describe, expect, test } from 'vitest';
import { REGION_SURFACE_REGISTRY } from '../regions/region-model';
import { AMBIENT_DOCK_RENDERABLE_PANES } from '../workspace-panes/ambientDockOccupants';

/**
 * station#928: `docked` in `WORKSPACE_PANE_REGIONS` is a capability claim —
 * "a shell region may hold this pane" — and nothing at runtime reads it. The
 * shell decides what can occupy a region from two tables:
 * `REGION_SURFACE_REGISTRY` (registered surfaces) and
 * `AMBIENT_DOCK_RENDERABLE_PANES` (the legacy ambient occupant picker). A
 * declaration nothing derives drifts, so this test pins the claim to those
 * tables in both directions: every placeable built-in declares `docked`, and
 * no built-in that is not placeable does.
 */

/**
 * Every module that authors a built-in descriptor constant. The built-ins this
 * host admits are the constants `builtinWorkspacePaneCanonical.ts` compares
 * against, and each of those is exported from one of these modules under a
 * `WORKSPACE_*_DESCRIPTOR` name (board-pane's root barrel deliberately keeps
 * its descriptor on a subpath, so that subpath is scanned). Scanning modules
 * at runtime rather than typing an import list is what makes the enumeration
 * complete in one direction — a new constant in the contracts or basis barrel
 * is found without an edit here — and the pin against the host's own imports
 * below closes the other: a constant the host admits that this scan cannot
 * see fails the test.
 */
const BUILTIN_DESCRIPTOR_MODULES: Record<string, Record<string, unknown>> = {
  '@kontourai/station-contracts': contracts,
  '@kontourai/station-basis-pane': basisPane,
  '@kontourai/station-board-pane/workspace-board-pane': boardPane,
};

/** The host module whose imports are the admitted built-in descriptor set. */
const HOST_ADMISSION_MODULE =
  'src-ui/src/workspace-panes/builtinWorkspacePaneCanonical.ts';

/**
 * Exact set, never a floor: removing a name here reds the pin, and so does a
 * `WORKSPACE_*_DESCRIPTOR` export appearing in any barrel above.
 */
const EXPECTED_BUILTIN_DESCRIPTOR_EXPORTS = [
  '@kontourai/station-basis-pane:WORKSPACE_BASIS_PANE_DESCRIPTOR',
  '@kontourai/station-board-pane/workspace-board-pane:WORKSPACE_BOARD_PANE_DESCRIPTOR',
  '@kontourai/station-contracts:WORKSPACE_ACTIVITY_PANE_DESCRIPTOR',
  '@kontourai/station-contracts:WORKSPACE_BROWSER_PREVIEW_PANE_DESCRIPTOR',
  '@kontourai/station-contracts:WORKSPACE_CHAT_PANE_DESCRIPTOR',
  '@kontourai/station-contracts:WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR',
  '@kontourai/station-contracts:WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR',
  '@kontourai/station-contracts:WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR',
  '@kontourai/station-contracts:WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR',
  '@kontourai/station-contracts:WORKSPACE_HOME_PANE_DESCRIPTOR',
  '@kontourai/station-contracts:WORKSPACE_PLAN_PANE_DESCRIPTOR',
  '@kontourai/station-contracts:WORKSPACE_READINESS_PANE_DESCRIPTOR',
  '@kontourai/station-contracts:WORKSPACE_SPATIAL_BOARD_PANE_DESCRIPTOR',
  '@kontourai/station-contracts:WORKSPACE_TASK_ROOM_CHAT_DESCRIPTOR',
  '@kontourai/station-contracts:WORKSPACE_TASK_ROOM_EDITOR_DESCRIPTOR',
  '@kontourai/station-contracts:WORKSPACE_TRUST_PANE_DESCRIPTOR',
] as const;

/**
 * Registry ids are bare words (`chat`, `activity`); descriptor ids are
 * `pane:builtin:<word>`. The mapping is explicit so a surface registered
 * without a descriptor fails the test rather than silently mapping to nothing;
 * the spelling relationship is asserted separately below.
 */
const SURFACE_DESCRIPTORS: Record<string, WorkspacePaneDescriptor> = {
  chat: WORKSPACE_CHAT_PANE_DESCRIPTOR,
  activity: WORKSPACE_ACTIVITY_PANE_DESCRIPTOR,
};

function isDescriptorShaped(value: unknown): value is WorkspacePaneDescriptor {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as WorkspacePaneDescriptor).id === 'string' &&
    Array.isArray(
      (value as WorkspacePaneDescriptor).placement?.supportedRegions,
    )
  );
}

function exportedBuiltinDescriptors(): {
  name: string;
  descriptor: WorkspacePaneDescriptor;
}[] {
  return Object.entries(BUILTIN_DESCRIPTOR_MODULES).flatMap(([pkg, module]) =>
    Object.entries(module)
      .filter(
        ([exportName, value]) =>
          /^WORKSPACE_[A-Z0-9_]+_DESCRIPTOR$/.test(exportName) &&
          isDescriptorShaped(value),
      )
      .map(([exportName, value]) => ({
        name: `${pkg}:${exportName}`,
        descriptor: value as WorkspacePaneDescriptor,
      })),
  );
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

describe('docked is a derived capability, pinned to the shell surface registry', () => {
  test('the built-in descriptor enumeration is the exact set of module exports', () => {
    expect(
      sorted(exportedBuiltinDescriptors().map((entry) => entry.name)),
    ).toEqual(sorted(EXPECTED_BUILTIN_DESCRIPTOR_EXPORTS));
  });

  test('the enumeration covers every descriptor constant the host admission module imports', () => {
    // `builtinWorkspacePaneCanonical.ts` is where the host decides which
    // built-in descriptors it accepts, so the constants it names are the
    // complete admitted set. Exact equality in both directions: a constant the
    // host admits that the scan misses, or one the scan finds that the host
    // never admits, both fail here.
    const source = readFileSync(
      resolve(process.cwd(), HOST_ADMISSION_MODULE),
      'utf8',
    );
    const admitted = new Set(
      source.match(/\bWORKSPACE_[A-Z0-9_]+_DESCRIPTOR\b/g) ?? [],
    );
    expect(admitted.size).toBeGreaterThan(0);
    expect(sorted(admitted)).toEqual(
      sorted(
        new Set(
          exportedBuiltinDescriptors().map((entry) =>
            entry.name.slice(entry.name.lastIndexOf(':') + 1),
          ),
        ),
      ),
    );
  });

  test('every registered surface maps to a built-in descriptor whose id is pane:builtin:<surface id>', () => {
    expect(sorted(Object.keys(SURFACE_DESCRIPTORS))).toEqual(
      sorted(REGION_SURFACE_REGISTRY.keys()),
    );
    for (const [surfaceId, descriptor] of Object.entries(SURFACE_DESCRIPTORS)) {
      expect(descriptor.id, surfaceId).toBe(`pane:builtin:${surfaceId}`);
    }
  });

  test('the built-ins declaring docked are exactly the built-ins the shell can place', () => {
    const placeable = new Set<string>([
      ...Object.values(SURFACE_DESCRIPTORS).map((descriptor) => descriptor.id),
      ...AMBIENT_DOCK_RENDERABLE_PANES.map((pane) => pane.descriptor.id),
    ]);
    const declared = new Set<string>(
      exportedBuiltinDescriptors()
        .filter(({ descriptor }) =>
          descriptor.placement.supportedRegions.includes('docked'),
        )
        .map(({ descriptor }) => descriptor.id),
    );

    // One assertion, both directions, naming the id and the side it is
    // missing from: `declaredButNotPlaceable` is a descriptor claiming a
    // capability no shell table grants; `placeableButNotDeclared` is a shell
    // table placing a pane whose descriptor never claimed it.
    expect({
      declaredButNotPlaceable: sorted(
        [...declared].filter((id) => !placeable.has(id)),
      ),
      placeableButNotDeclared: sorted(
        [...placeable].filter((id) => !declared.has(id)),
      ),
    }).toEqual({ declaredButNotPlaceable: [], placeableButNotDeclared: [] });
    expect(sorted(declared)).toEqual(sorted(placeable));
  });

  test('host-derived built-ins (layout-tab adaptations) never claim docked', () => {
    // The Coding pane has no descriptor constant: `builtinWorkspacePaneCanonical`
    // derives it per layout through the adapter, so the barrel scan above
    // cannot see it. Its placement comes from the adapter's default region.
    const adaptation = paneAdaptationFromLayoutTab(
      {
        id: 'coding',
        label: 'Coding',
        component: { kind: 'builtin-component', name: 'coding' },
      },
      {
        layoutSlug: 'layout',
        instanceScope: 'project:project:source:builtin:coding',
        modeContextRequirement: { project: true, source: true },
        boundContext: { projectId: 'project', sourceId: 'builtin:coding' },
      },
    );
    expect(adaptation).not.toBeNull();
    expect(adaptation?.descriptor.placement.supportedRegions).not.toContain(
      'docked',
    );
  });
});
