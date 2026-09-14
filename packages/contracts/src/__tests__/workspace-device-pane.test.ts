import { describe, expect, test } from 'vitest';
import {
  isCanonicalWorkspaceDevicePaneInstance,
  parseWorkspaceDevicePaneState,
  WORKSPACE_DEVICE_PANE_DESCRIPTOR,
  WORKSPACE_DEVICE_PANE_DESCRIPTOR_ID,
  WORKSPACE_DEVICE_PANE_INSTANCE,
  WORKSPACE_DEVICE_PANE_INSTANCE_ID,
  WORKSPACE_DEVICE_PANE_RENDERER_NAME,
  WORKSPACE_DEVICE_PANE_SOURCE_ID,
  WORKSPACE_DEVICE_PANE_STATE_VERSION,
} from '../workspace-device-pane.js';
import {
  parseWorkspacePaneInstance,
  WORKSPACE_PANE_CONTRACT_VERSION,
} from '../workspace-pane.js';
import { BUILTIN_WORKSPACE_PANE_RENDERER_NAMES } from '../workspace-pane-builtin-renderers.js';

describe('the Device pane descriptor (#1969)', () => {
  /**
   * Reverting the descriptor's `supportedRegions` to anything but exactly
   * `['docked']` — adding `standalone`, say — reds the first two assertions;
   * renaming the id off the `pane:builtin:<surface>` spelling reds the third,
   * which is also what `docked-capability-derivation.test.ts` derives the
   * registry mapping from.
   */
  test('is a dock-only built-in whose id is the surface spelling', () => {
    expect(WORKSPACE_DEVICE_PANE_DESCRIPTOR.placement.supportedRegions).toEqual(
      ['docked'],
    );
    expect(WORKSPACE_DEVICE_PANE_DESCRIPTOR.placement.preferredRegion).toBe(
      'docked',
    );
    expect(WORKSPACE_DEVICE_PANE_DESCRIPTOR.id).toBe('pane:builtin:device');
    expect(WORKSPACE_DEVICE_PANE_DESCRIPTOR.renderer).toEqual({
      kind: 'builtin-component',
      name: WORKSPACE_DEVICE_PANE_RENDERER_NAME,
    });
    expect(WORKSPACE_DEVICE_PANE_DESCRIPTOR.provenance).toEqual({
      origin: 'builtin',
    });
    expect(
      BUILTIN_WORKSPACE_PANE_RENDERER_NAMES as readonly string[],
    ).toContain(WORKSPACE_DEVICE_PANE_RENDERER_NAME);
  });

  /**
   * The acceptance's "do not gate viewing on a desktop capability" as an
   * assertion: adding `requirements: { hostCapabilities: [...] }` to the
   * descriptor — the shape Browser Preview's server declaration carries —
   * reds this, and so does giving the default mode a context requirement.
   */
  test('requires no host capability and no context', () => {
    expect(WORKSPACE_DEVICE_PANE_DESCRIPTOR.requirements).toBeUndefined();
    expect(WORKSPACE_DEVICE_PANE_DESCRIPTOR.modes).toEqual([{ id: 'default' }]);
    for (const mode of WORKSPACE_DEVICE_PANE_DESCRIPTOR.modes)
      expect(mode.contextRequirement).toBeUndefined();
  });

  /**
   * The singleton claim. Relaxing the
   * `Object.keys(boundContext).length === 1` check, or dropping any of the
   * `=== undefined` clauses, lets a project-bound or task-bound impostor
   * through and reds the second half.
   */
  test('the canonical occurrence binds only its source, and an impostor is refused', () => {
    expect(
      isCanonicalWorkspaceDevicePaneInstance(WORKSPACE_DEVICE_PANE_INSTANCE),
    ).toBe(true);
    expect(WORKSPACE_DEVICE_PANE_INSTANCE.boundContext).toEqual({
      sourceId: WORKSPACE_DEVICE_PANE_SOURCE_ID,
    });

    const projectBound = parseWorkspacePaneInstance({
      version: WORKSPACE_PANE_CONTRACT_VERSION,
      descriptorId: WORKSPACE_DEVICE_PANE_DESCRIPTOR_ID,
      instanceId: WORKSPACE_DEVICE_PANE_INSTANCE_ID,
      stateKey: WORKSPACE_DEVICE_PANE_INSTANCE_ID,
      boundContext: {
        sourceId: WORKSPACE_DEVICE_PANE_SOURCE_ID,
        projectId: 'project-uuid',
      },
    });
    expect(projectBound).not.toBeNull();
    if (projectBound)
      expect(isCanonicalWorkspaceDevicePaneInstance(projectBound)).toBe(false);

    const otherInstanceId = parseWorkspacePaneInstance({
      version: WORKSPACE_PANE_CONTRACT_VERSION,
      descriptorId: WORKSPACE_DEVICE_PANE_DESCRIPTOR_ID,
      instanceId: 'workspace-device-2',
      stateKey: 'workspace-device-2',
      boundContext: { sourceId: WORKSPACE_DEVICE_PANE_SOURCE_ID },
    });
    expect(otherInstanceId).not.toBeNull();
    if (otherInstanceId)
      expect(isCanonicalWorkspaceDevicePaneInstance(otherInstanceId)).toBe(
        false,
      );
  });
});

describe('the Device pane state parser (#1969)', () => {
  const valid = {
    version: WORKSPACE_DEVICE_PANE_STATE_VERSION,
    hostId: 'local',
    platform: 'ios',
    deviceId: '6E8C08FA-3A81-4347-90B9-AD41B7FAE876',
  };

  test('accepts exactly a descriptive target', () => {
    expect(parseWorkspaceDevicePaneState(valid)).toEqual(valid);
    expect(
      parseWorkspaceDevicePaneState({
        ...valid,
        platform: 'android',
        deviceId: 'emulator-5584',
      }),
    ).toEqual({ ...valid, platform: 'android', deviceId: 'emulator-5584' });
  });

  /**
   * The load-bearing one: dropping the unknown-key clause from the parser
   * lets a persisted `pngBase64` survive a round trip, which is the exact
   * thing the pane is forbidden to store. Reverting that clause reds the
   * first assertion.
   */
  test('refuses an unknown key, a foreign host, a bad platform and an over-long id', () => {
    expect(
      parseWorkspaceDevicePaneState({
        ...valid,
        pngBase64: 'iVBORw0KGgo=',
      }),
    ).toBeNull();
    expect(parseWorkspaceDevicePaneState({ ...valid, hostId: 'remote' })).toBe(
      null,
    );
    expect(
      parseWorkspaceDevicePaneState({ ...valid, platform: 'web' }),
    ).toBeNull();
    expect(
      parseWorkspaceDevicePaneState({ ...valid, deviceId: 'a'.repeat(257) }),
    ).toBeNull();
    expect(
      parseWorkspaceDevicePaneState({
        ...valid,
        // Written by code point: biome rewrites a unicode escape to the raw
        // byte, which is invisible in a diff and easy to delete by accident.
        deviceId: `bad${String.fromCharCode(7)}id`,
      }),
    ).toBeNull();
    expect(
      parseWorkspaceDevicePaneState({ ...valid, deviceId: '' }),
    ).toBeNull();
    expect(parseWorkspaceDevicePaneState({ ...valid, version: '2.0' })).toBe(
      null,
    );
    expect(parseWorkspaceDevicePaneState([valid])).toBeNull();
    expect(parseWorkspaceDevicePaneState(null)).toBeNull();
  });
});
