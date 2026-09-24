/** @vitest-environment jsdom */

import {
  WORKSPACE_DEVICE_PANE_DESCRIPTOR_ID,
  WORKSPACE_DEVICE_PANE_INSTANCE,
  WORKSPACE_DEVICE_PANE_INSTANCE_ID,
  WORKSPACE_DEVICE_PANE_SOURCE_ID,
} from '@kontourai/station-contracts/workspace-device-pane';
import {
  parseWorkspacePaneInstance,
  WORKSPACE_PANE_CONTRACT_VERSION,
} from '@kontourai/station-contracts/workspace-pane';
import { render, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { LazyBoundary } from '../../components/LazyBoundary';
import { INSTANCE_SURFACE_PREFIXES } from '../../regions/region-model';
import { createBrowserPreviewPaneInstance } from '../browserPreviewPaneInstance';
import { writeBrowserPreviewPaneState } from '../browserPreviewPaneStateStorage';
import {
  REGION_BUILTIN_DESCRIPTORS,
  RegionBuiltinPane,
} from '../RegionBuiltinPane';

// The Device pane's own render graph is not what is under test here — it
// reads the host authority from a provider this file does not mount — so the
// registry's lazy row resolves to a stand-in. What IS under test is that the
// region's built-in map admits the Device descriptor at all.
vi.mock('../DeviceWorkspacePane', () => ({
  DeviceWorkspacePane: () => <div>device pane mounted</div>,
}));
// Same reason for the Browser pane: its binding and its session reads are
// its own tests'; here it is enough that the region map reaches it.
vi.mock('../BrowserPreviewWorkspacePane', () => ({
  BrowserPreviewWorkspacePane: ({
    instance,
  }: {
    instance: { instanceId: string };
  }) => <div>browser pane mounted for {String(instance.instanceId)}</div>,
}));

/**
 * #2047: `RegionBuiltinPane` throws for an instance whose descriptor the
 * region's built-in map does not hold, rather than rendering nothing — the
 * lazy boundary the host wraps it in reports it, the way an Activity pane
 * with no renderer does. Every input is a code-owned built-in, so a miss is
 * a build defect and must be visible.
 *
 * Mounted through the same `LazyBoundary` the host wraps it in
 * (`RegionPaneHost.tsx`), so the assertion is over what that boundary
 * actually renders. The module is resolved here rather than imported inside
 * the factory: the host's chunk boundary is not what is under test, and
 * racing the real dynamic import is the known mount-under-load flake.
 * Reverting the throw to `return null` fails this at the boundary text.
 */
test('a descriptor the region built-in map lacks is reported by the boundary', async () => {
  const instance = parseWorkspacePaneInstance({
    version: '1.0',
    descriptorId: 'pane:builtin:not-a-region-builtin',
    instanceId: 'region-builtin-unknown',
    stateKey: 'region-builtin-unknown',
  });
  if (!instance) throw new Error('fixture must parse');

  // React logs the boundary-caught error; the assertion below is the report.
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    render(
      <LazyBoundary
        load={() => Promise.resolve({ default: RegionBuiltinPane })}
        componentProps={{ instance }}
        pending={<span>Loading pane</span>}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(
        'Unable to load this part of Station.',
      ),
    );
  } finally {
    errors.mockRestore();
  }
});

/**
 * #1969: the Device pane reaches a renderer through the same map. Removing
 * `WORKSPACE_DEVICE_PANE_DESCRIPTOR` from `REGION_BUILTIN_DESCRIPTORS` reds
 * the first case at the boundary text. The second is the impostor control:
 * the DESCRIPTOR admission cannot see an occurrence's bound context, so the
 * refusal lives in the registry entry itself — dropping
 * `isCanonicalWorkspaceDevicePaneInstance` from `DeviceWorkspacePaneEntry`
 * makes a project-bound occurrence render the real pane, which reds the last
 * two assertions.
 */
test('the Device occurrence resolves to a renderer and an impostor does not', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const { unmount } = render(
      <LazyBoundary
        load={() => Promise.resolve({ default: RegionBuiltinPane })}
        componentProps={{ instance: WORKSPACE_DEVICE_PANE_INSTANCE }}
        pending={<span>Loading pane</span>}
      />,
    );
    // It gets past the map and into the registry's own lazy renderer, so the
    // boundary reports nothing.
    await waitFor(() =>
      expect(screen.getByText('device pane mounted')).toBeTruthy(),
    );
    expect(screen.queryByRole('alert')).toBeNull();
    unmount();

    const impostor = parseWorkspacePaneInstance({
      version: WORKSPACE_PANE_CONTRACT_VERSION,
      descriptorId: WORKSPACE_DEVICE_PANE_DESCRIPTOR_ID,
      instanceId: WORKSPACE_DEVICE_PANE_INSTANCE_ID,
      stateKey: WORKSPACE_DEVICE_PANE_INSTANCE_ID,
      boundContext: {
        sourceId: WORKSPACE_DEVICE_PANE_SOURCE_ID,
        projectId: 'project-uuid',
      },
    });
    if (!impostor) throw new Error('fixture must parse');
    render(
      <LazyBoundary
        load={() => Promise.resolve({ default: RegionBuiltinPane })}
        componentProps={{ instance: impostor }}
        pending={<span>Loading pane</span>}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(
        'This pane isn\u2019t set up as the Device snapshot view.',
      ),
    );
    expect(screen.queryByText('device pane mounted')).toBeNull();
  } finally {
    errors.mockRestore();
  }
});

/**
 * #90 D9 B1: a Browser pane placed in a region (the float-over-chat's "Open
 * in right panel") reaches its renderer. Without the Browser descriptor in
 * `REGION_BUILTIN_DESCRIPTORS` this renders the boundary's "Unable to load"
 * — what the live verify saw, and what survived a reload.
 */
test('a Browser occurrence placed in a region resolves to its renderer', async () => {
  const state = {
    version: '2.0' as const,
    projectId: 'project-uuid',
    browserSessionId: 'bs_00000000-0000-4000-8000-000000000001',
    updatedAt: '2026-09-22T00:00:00.000Z',
  };
  const instance = createBrowserPreviewPaneInstance(
    state,
    'project-uuid',
    'c'.repeat(32),
  );
  if (!instance) throw new Error('fixture must mint');
  writeBrowserPreviewPaneState(window.localStorage, instance.stateKey, state);
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    render(
      <LazyBoundary
        load={() => Promise.resolve({ default: RegionBuiltinPane })}
        componentProps={{ instance }}
        pending={<span>Loading pane</span>}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByText(`browser pane mounted for ${instance.instanceId}`),
      ).toBeTruthy(),
    );
    expect(screen.queryByRole('alert')).toBeNull();
  } finally {
    errors.mockRestore();
    window.localStorage.clear();
  }
});

/**
 * The class B1 belonged to: every instance family a region can hold (the
 * entry chunk's `INSTANCE_SURFACE_PREFIXES`) must have a region renderer. A
 * family added without one reds here, not in a user's dock.
 */
test('every instance family a region can hold has a region renderer', () => {
  for (const family of INSTANCE_SURFACE_PREFIXES)
    expect(
      REGION_BUILTIN_DESCRIPTORS.has(family.descriptorId),
      family.prefix,
    ).toBe(true);
});
