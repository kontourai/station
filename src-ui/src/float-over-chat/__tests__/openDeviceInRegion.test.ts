// @vitest-environment jsdom

/**
 * #90 D9: a floated device's "Open in right panel" opens THE Device pane on
 * that device: the pane's stored selection is the device (host, platform,
 * id), a mounted pane is told to switch, and a refusal leaves the previous
 * selection exactly as it was. The model is a fake that records what it was
 * asked; the stored state is the real one the pane reads.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { openDeviceInRegion } from '../../contexts/useOpenDeviceInRegion';
import { onDevicePaneSelection } from '../../workspace-panes/device/devicePaneSelection';
import {
  readDevicePaneState,
  writeDevicePaneState,
} from '../../workspace-panes/devicePaneStateStorage';

const SCOPE = { apiBase: 'http://station.test', authorityKey: 'authority-1' };
const DEVICE = {
  hostId: 'ssh-0123456789ab',
  platform: 'ios' as const,
  deviceId: '5A1C2E3F-0B1D-4C6E-8F9A-0123456789AB',
};

function model(outcome: 'ok' | 'refuse') {
  return {
    openSurfaceInRegion: vi.fn((surfaceId: string, _options?: object) =>
      outcome === 'ok'
        ? {
            ok: true as const,
            region: 'right' as const,
            surfaceId,
            existing: false,
          }
        : { ok: false as const, reason: 'refused' as const },
    ),
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('openDeviceInRegion (#90 D9)', () => {
  test('stores the device as the pane’s selection, opens the Device pane, and tells a mounted pane', () => {
    const selections: unknown[] = [];
    const release = onDevicePaneSelection((selection) =>
      selections.push(selection),
    );
    const fake = model('ok');
    const outcome = openDeviceInRegion(fake, SCOPE, DEVICE, {
      region: 'right',
    });
    release();
    expect(outcome.ok).toBe(true);
    expect(fake.openSurfaceInRegion).toHaveBeenCalledWith('device', {
      region: 'right',
    });
    expect(readDevicePaneState(window.localStorage, SCOPE)).toMatchObject(
      DEVICE,
    );
    expect(selections).toEqual([DEVICE]);
  });

  test('a refusal restores the previous selection and tells no pane', () => {
    const previous = {
      hostId: 'local',
      platform: 'android' as const,
      deviceId: 'emulator-5554',
    };
    writeDevicePaneState(window.localStorage, SCOPE, previous);
    const selections: unknown[] = [];
    const release = onDevicePaneSelection((selection) =>
      selections.push(selection),
    );
    const outcome = openDeviceInRegion(model('refuse'), SCOPE, DEVICE);
    release();
    expect(outcome.ok).toBe(false);
    expect(readDevicePaneState(window.localStorage, SCOPE)).toMatchObject(
      previous,
    );
    expect(selections).toEqual([]);
  });
});
