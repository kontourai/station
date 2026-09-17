import { describe, expect, test } from 'vitest';
import {
  isCanonicalWorkspaceHomePaneInstance,
  WORKSPACE_HOME_PANE_DESCRIPTOR,
  WORKSPACE_HOME_PANE_DESCRIPTOR_ID,
  WORKSPACE_HOME_PANE_INSTANCE,
  WORKSPACE_HOME_PANE_RENDERER_ID,
  WORKSPACE_HOME_PANE_RENDERER_NAME,
  WORKSPACE_HOME_PANE_SOURCE_ID,
} from '../workspace-home-pane.js';
import {
  parseWorkspacePaneDescriptor,
  parseWorkspacePaneInstance,
  type WorkspacePaneInstance,
} from '../workspace-pane.js';

describe('Home Workspace Pane descriptor', () => {
  test('declares no context requirement, because Home binds no Project', () => {
    // Every other builtin declares `project: true`. Home aggregates all
    // Projects and is shown outside every one of them, so requiring a Project
    // would make it permanently unavailable on the only route it appears on.
    expect(WORKSPACE_HOME_PANE_DESCRIPTOR.modes).toEqual([{ id: 'default' }]);
  });

  test('is placed standalone (preferred) or docked, never inside a Layout', () => {
    // `standalone` is the `/` route placement; `docked` is the capability
    // claim that a shell region may hold this pane — Home is in the ambient
    // dock's render table, and docked-capability-derivation.test.ts pins the
    // claim to that table. The region set states both facts and no others.
    // `primary`/`secondary` stay
    // excluded: a Project host must not place a Project-less aggregate of
    // every Project beside the work it is scoped to.
    expect(WORKSPACE_HOME_PANE_DESCRIPTOR.placement).toEqual({
      supportedRegions: ['standalone', 'docked'],
      preferredRegion: 'standalone',
    });
  });

  test('carries builtin provenance and a builtin renderer', () => {
    expect(WORKSPACE_HOME_PANE_DESCRIPTOR.provenance).toEqual({
      origin: 'builtin',
    });
    expect(WORKSPACE_HOME_PANE_DESCRIPTOR.renderer).toEqual({
      kind: 'builtin-component',
      name: WORKSPACE_HOME_PANE_RENDERER_NAME,
    });
    expect(WORKSPACE_HOME_PANE_DESCRIPTOR.rendererId).toBe(
      WORKSPACE_HOME_PANE_RENDERER_ID,
    );
    expect(WORKSPACE_HOME_PANE_DESCRIPTOR.id).toBe(
      WORKSPACE_HOME_PANE_DESCRIPTOR_ID,
    );
  });

  test('declares no alternative renderer yet', () => {
    // The degradation rung belongs to the Home role (station#3122 stage 3),
    // which decides which trust tiers may hold it. Declaring one here would
    // ship a fallback nothing has decided the shape of.
    expect(WORKSPACE_HOME_PANE_DESCRIPTOR.alternativeRenderer).toBeUndefined();
  });

  test('the parser refuses a Home-shaped descriptor that claims builtin provenance with a pluginId', () => {
    expect(
      parseWorkspacePaneDescriptor({
        ...WORKSPACE_HOME_PANE_DESCRIPTOR,
        provenance: { origin: 'builtin', pluginId: 'impostor' },
      }),
    ).toBeNull();
  });
});

describe('Home Workspace Pane instance', () => {
  test('binds a source and nothing else', () => {
    expect(WORKSPACE_HOME_PANE_INSTANCE.boundContext).toEqual({
      sourceId: WORKSPACE_HOME_PANE_SOURCE_ID,
    });
    expect(
      isCanonicalWorkspaceHomePaneInstance(WORKSPACE_HOME_PANE_INSTANCE),
    ).toBe(true);
  });

  test('refuses an occurrence that smuggles a bound Project or contribution', () => {
    const withProject = parseWorkspacePaneInstance({
      ...WORKSPACE_HOME_PANE_INSTANCE,
      boundContext: {
        sourceId: WORKSPACE_HOME_PANE_SOURCE_ID,
        projectId: 'station',
      },
    }) as WorkspacePaneInstance;
    expect(isCanonicalWorkspaceHomePaneInstance(withProject)).toBe(false);

    const withContribution = parseWorkspacePaneInstance({
      ...WORKSPACE_HOME_PANE_INSTANCE,
      boundContext: {
        sourceId: WORKSPACE_HOME_PANE_SOURCE_ID,
        contribution: {
          id: 'plugin:impostor:home',
          version: '1.0.0',
          sourceIdentity: {
            id: 'impostor',
            kind: 'local',
            source: 'plugins/impostor',
          },
          provenance: { origin: 'plugin', pluginId: 'impostor' },
        },
      },
    }) as WorkspacePaneInstance;
    expect(isCanonicalWorkspaceHomePaneInstance(withContribution)).toBe(false);
  });

  test('refuses an occurrence of a different descriptor', () => {
    const other = parseWorkspacePaneInstance({
      ...WORKSPACE_HOME_PANE_INSTANCE,
      descriptorId: 'pane:plugin%3Aimpostor:home',
    }) as WorkspacePaneInstance;
    expect(isCanonicalWorkspaceHomePaneInstance(other)).toBe(false);
  });
});
