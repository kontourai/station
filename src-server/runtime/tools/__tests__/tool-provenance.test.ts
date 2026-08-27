import { describe, expect, test } from 'vitest';
import {
  isTrustedNativeStationControlTool,
  markTrustedNativeStationControlTool,
} from '../tool-provenance.js';

describe('native station-control provenance', () => {
  test('survives the object-spread wrappers used by runtime tool gates', () => {
    const marked = markTrustedNativeStationControlTool({
      name: 'stationControl_updateSkill',
      execute: async () => undefined,
    });

    expect(isTrustedNativeStationControlTool({ ...marked })).toBe(true);
  });

  test('does not trust an attacker-controlled station-control name', () => {
    expect(
      isTrustedNativeStationControlTool({
        name: 'station-control_update_skill',
      }),
    ).toBe(false);
  });
});
