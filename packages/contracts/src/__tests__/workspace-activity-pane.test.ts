import { describe, expect, test } from 'vitest';
import {
  isCanonicalWorkspaceActivityPaneInstance,
  WORKSPACE_ACTIVITY_PANE_DESCRIPTOR,
  WORKSPACE_ACTIVITY_PANE_DESCRIPTOR_ID,
  WORKSPACE_ACTIVITY_PANE_INSTANCE,
  WORKSPACE_ACTIVITY_PANE_RENDERER_ID,
  WORKSPACE_ACTIVITY_PANE_RENDERER_NAME,
  WORKSPACE_ACTIVITY_PANE_SOURCE_ID,
} from '../workspace-activity-pane.js';
import {
  parseWorkspacePaneDescriptor,
  parseWorkspacePaneInstance,
  type WorkspacePaneInstance,
} from '../workspace-pane.js';

describe('Activity Workspace Pane descriptor', () => {
  test('declares no context requirement, because the sessions list binds no Project', () => {
    // The list aggregates every Project's sessions (and projectless ones);
    // requiring a Project would make Activity permanently unavailable on the
    // only route it appears on. This is also what makes it
    // ambient-satisfiable — the deliberate dockable-set expansion pinned in
    // workspace-pane-modes.test.ts.
    expect(WORKSPACE_ACTIVITY_PANE_DESCRIPTOR.modes).toEqual([
      { id: 'default' },
    ]);
  });

  test('is placed standalone (preferred) or docked, never inside a Layout', () => {
    // `standalone` is the `/activity` route placement; `docked` is the
    // shell's ambient slot. `primary`/`secondary` stay excluded: a Project
    // host must not place a Project-less aggregate of every host session
    // beside the work it is scoped to.
    expect(WORKSPACE_ACTIVITY_PANE_DESCRIPTOR.placement).toEqual({
      supportedRegions: ['standalone', 'docked'],
      preferredRegion: 'standalone',
    });
  });

  test('carries builtin provenance and a builtin renderer', () => {
    expect(WORKSPACE_ACTIVITY_PANE_DESCRIPTOR.provenance).toEqual({
      origin: 'builtin',
    });
    expect(WORKSPACE_ACTIVITY_PANE_DESCRIPTOR.renderer).toEqual({
      kind: 'builtin-component',
      name: WORKSPACE_ACTIVITY_PANE_RENDERER_NAME,
    });
    expect(WORKSPACE_ACTIVITY_PANE_DESCRIPTOR.rendererId).toBe(
      WORKSPACE_ACTIVITY_PANE_RENDERER_ID,
    );
    expect(WORKSPACE_ACTIVITY_PANE_DESCRIPTOR.id).toBe(
      WORKSPACE_ACTIVITY_PANE_DESCRIPTOR_ID,
    );
  });

  test('the parser refuses an Activity-shaped descriptor that claims builtin provenance with a pluginId', () => {
    expect(
      parseWorkspacePaneDescriptor({
        ...WORKSPACE_ACTIVITY_PANE_DESCRIPTOR,
        provenance: { origin: 'builtin', pluginId: 'impostor' },
      }),
    ).toBeNull();
  });
});

describe('Activity Workspace Pane instance', () => {
  test('binds a source and nothing else', () => {
    expect(WORKSPACE_ACTIVITY_PANE_INSTANCE.boundContext).toEqual({
      sourceId: WORKSPACE_ACTIVITY_PANE_SOURCE_ID,
    });
    expect(
      isCanonicalWorkspaceActivityPaneInstance(
        WORKSPACE_ACTIVITY_PANE_INSTANCE,
      ),
    ).toBe(true);
  });

  test('refuses an occurrence that smuggles a bound Project or session', () => {
    const withProject = parseWorkspacePaneInstance({
      ...WORKSPACE_ACTIVITY_PANE_INSTANCE,
      boundContext: {
        sourceId: WORKSPACE_ACTIVITY_PANE_SOURCE_ID,
        projectId: 'station',
      },
    }) as WorkspacePaneInstance;
    expect(isCanonicalWorkspaceActivityPaneInstance(withProject)).toBe(false);

    // A routed session id is presentation state of the standalone placement,
    // never pane identity: an occurrence carrying one is not canonical.
    const withSession = parseWorkspacePaneInstance({
      ...WORKSPACE_ACTIVITY_PANE_INSTANCE,
      boundContext: {
        sourceId: WORKSPACE_ACTIVITY_PANE_SOURCE_ID,
        sessionId: 'thread-alpha',
      },
    }) as WorkspacePaneInstance;
    expect(isCanonicalWorkspaceActivityPaneInstance(withSession)).toBe(false);
  });

  test('refuses an occurrence of a different descriptor', () => {
    const other = parseWorkspacePaneInstance({
      ...WORKSPACE_ACTIVITY_PANE_INSTANCE,
      descriptorId: 'pane:plugin%3Aimpostor:activity',
    }) as WorkspacePaneInstance;
    expect(isCanonicalWorkspaceActivityPaneInstance(other)).toBe(false);
  });
});
