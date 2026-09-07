/** @vitest-environment jsdom */

import {
  WORKSPACE_ACTIVITY_PANE_DESCRIPTOR,
  WORKSPACE_ACTIVITY_PANE_INSTANCE,
  WORKSPACE_ACTIVITY_PANE_RENDERER_NAME,
} from '@kontourai/station-contracts/workspace-activity-pane';
import { parseWorkspacePaneDescriptor } from '@kontourai/station-contracts/workspace-pane';
import { describe, expect, test } from 'vitest';
import {
  builtinWorkspacePaneRendererPresence,
  isCanonicalBuiltinActivityDescriptor,
} from '../builtinWorkspacePaneCanonical';
import { getBuiltinWorkspacePaneRenderer } from '../builtinWorkspacePaneRegistry';
import { isWorkspacePaneInstanceOwnedByProject } from '../workspacePaneHostAdmission';
import { selectClientWorkspacePaneRenderer } from '../workspacePaneRendererSelection';

describe('Activity is a Workspace Pane like any other', () => {
  test('the builtin registry resolves the canonical Activity descriptor', () => {
    // `ActivityRegionShell` mounts `ActivityWorkspacePane` directly rather
    // than through this lookup, to keep the registry's component table off
    // the eager chunk (Home's reasoning). This proves the registry resolves
    // Activity's canonical descriptor and nothing more.
    //
    // Say the gap plainly: NO Activity placement consults
    // `selectClientWorkspacePaneRenderer`. The retired `/activity` route was
    // the only one that did, and it refused to mount when selection declined.
    // Both surviving placements — this shell and the Developer archive embed
    // — mount the builtin unconditionally, so a plugin that overrode the
    // Activity descriptor would be ignored rather than honoured or refused.
    // Home keeps its equivalent gate (`HomeViewPaneSelection.test.tsx`);
    // Activity has none. Restoring it belongs at the placement, not here.
    expect(
      getBuiltinWorkspacePaneRenderer(WORKSPACE_ACTIVITY_PANE_DESCRIPTOR),
    ).not.toBeNull();
    expect(WORKSPACE_ACTIVITY_PANE_DESCRIPTOR.renderer).toMatchObject({
      kind: 'builtin-component',
      name: WORKSPACE_ACTIVITY_PANE_RENDERER_NAME,
    });
  });

  test('the shared selector admits the builtin Activity renderer', () => {
    expect(
      selectClientWorkspacePaneRenderer(WORKSPACE_ACTIVITY_PANE_DESCRIPTOR, {
        mcpAppsEnabled: true,
        instance: WORKSPACE_ACTIVITY_PANE_INSTANCE,
      }),
    ).toMatchObject({
      state: 'selected',
      candidate: {
        source: 'primary',
        renderer: { kind: 'builtin-component', name: 'workspace-activity' },
        contributorProvenance: { origin: 'builtin' },
      },
    });
  });

  test('no Project ever owns Activity’s occurrence', () => {
    // The admission every Project host runs before mounting an occurrence.
    // Activity binds no projectId, so the predicate is false for every
    // Project — the declaration excludes `primary`/`secondary` regions for
    // the same reason. Activity's own hosts (the route, the ambient dock)
    // admit it through the shared renderer selection plus the canonical
    // occurrence check.
    expect(
      isWorkspacePaneInstanceOwnedByProject(
        WORKSPACE_ACTIVITY_PANE_INSTANCE,
        'any-project',
      ),
    ).toBe(false);
    expect(
      isWorkspacePaneInstanceOwnedByProject(
        WORKSPACE_ACTIVITY_PANE_INSTANCE,
        undefined,
      ),
    ).toBe(false);
  });

  test('a plugin cannot reach the builtin Activity renderer by reusing its renderer name', () => {
    const impostor = parseWorkspacePaneDescriptor({
      ...WORKSPACE_ACTIVITY_PANE_DESCRIPTOR,
      id: 'pane:plugin%3Athird-party:activity',
      rendererId: 'renderer:plugin:third-party:activity',
      provenance: { origin: 'plugin', pluginId: 'third-party' },
    });
    if (!impostor) throw new Error('fixture descriptor did not parse');
    // The contract permits `plugin` provenance on a `builtin-component`
    // renderer, so this descriptor parses. What refuses it is the canonical
    // check: the builtin renderer is registered for exactly one declaration.
    expect(impostor.renderer).toMatchObject({ kind: 'builtin-component' });
    expect(isCanonicalBuiltinActivityDescriptor(impostor)).toBe(false);
    expect(builtinWorkspacePaneRendererPresence(impostor)).toBe('missing');
    expect(getBuiltinWorkspacePaneRenderer(impostor)).toBeNull();
  });
});
