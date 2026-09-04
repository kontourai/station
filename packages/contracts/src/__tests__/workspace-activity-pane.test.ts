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
    // requiring a Project would make Activity permanently unavailable in
    // every host that places it. This is also what makes it
    // ambient-satisfiable — the deliberate dockable-set expansion pinned in
    // workspace-pane-modes.test.ts.
    expect(WORKSPACE_ACTIVITY_PANE_DESCRIPTOR.modes).toEqual([
      { id: 'default' },
    ]);
  });

  test('is placed docked only, never standalone and never inside a Layout', () => {
    // station#928 retired the `/activity` route, and with it Activity's
    // standalone placement — the shell's dock region is the only host that
    // places this pane, so `standalone` would name a placement no host in
    // this build supplies and `preferredRegion: 'standalone'` would prefer an
    // unreachable one. `primary`/`secondary` stay excluded for their own
    // reason: a Project host must not place a Project-less aggregate of every
    // host session beside the work it is scoped to.
    expect(WORKSPACE_ACTIVITY_PANE_DESCRIPTOR.placement).toEqual({
      supportedRegions: ['docked'],
      preferredRegion: 'docked',
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

    // A routed session id is presentation state of the placement that
    // delivered it, never pane identity: an occurrence carrying one is not
    // canonical.
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
