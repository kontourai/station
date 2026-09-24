import { describe, expect, test } from 'vitest';
import {
  CANCEL_SLIDE_DISTANCE,
  cancelSlidePath,
  deviceButtonCommand,
  frameRotationFor,
  hidStrokeForCharacter,
  surfacePointToRawUnit,
} from '../device-input-mapping.js';

describe('surface point → raw unit square', () => {
  const raw = { width: 400, height: 800 };

  test('an unrotated frame normalizes by its own size', () => {
    expect(surfacePointToRawUnit({ x: 100, y: 200 }, raw, 0)).toEqual({
      x: 0.25,
      y: 0.25,
    });
  });

  test('clamps to the unit square', () => {
    expect(surfacePointToRawUnit({ x: 9999, y: 0 }, raw, 0)).toEqual({
      x: 1,
      y: 0,
    });
  });

  /**
   * The shown frame is the raw one turned clockwise. For a quarter turn the
   * shown size is 800 x 400, and each corner of the SHOWN frame must land on
   * the raw corner it was turned from.
   */
  test.each([
    // [rotation, shown point, raw unit]
    [90, { x: 0, y: 0 }, { x: 0, y: 1 }],
    [90, { x: 800, y: 0 }, { x: 0, y: 0 }],
    [90, { x: 200, y: 100 }, { x: 0.25, y: 0.75 }],
    [270, { x: 0, y: 0 }, { x: 1, y: 0 }],
    [270, { x: 200, y: 100 }, { x: 0.75, y: 0.25 }],
    [180, { x: 100, y: 200 }, { x: 0.75, y: 0.75 }],
  ] as const)('rotation %i maps %o to %o', (rotation, point, expected) => {
    expect(surfacePointToRawUnit(point, raw, rotation)).toEqual(expected);
  });

  test('frameRotationFor: only an iOS portrait framebuffer held sideways turns', () => {
    const portrait = { width: 400, height: 800 };
    const landscape = { width: 800, height: 400 };
    expect(frameRotationFor('ios', 'landscape-left', portrait)).toBe(90);
    expect(frameRotationFor('ios', 'landscape-right', portrait)).toBe(270);
    expect(frameRotationFor('ios', 'portrait-upside-down', portrait)).toBe(180);
    expect(frameRotationFor('ios', 'landscape-left', landscape)).toBe(0);
    expect(frameRotationFor('ios', undefined, portrait)).toBe(0);
    expect(frameRotationFor('android', 'landscape-left', portrait)).toBe(0);
  });
});

describe('hardware button whitelist', () => {
  test('iOS names map to the helper vocabulary', () => {
    expect(deviceButtonCommand('ios', 'home')).toEqual({
      platform: 'ios',
      button: 'home',
    });
    expect(deviceButtonCommand('ios', 'power')).toEqual({
      platform: 'ios',
      button: 'lock',
    });
    expect(deviceButtonCommand('ios', 'recents')).toEqual({
      platform: 'ios',
      button: 'app_switcher',
    });
  });

  test('Android names pass through', () => {
    for (const button of ['home', 'back', 'recents', 'power'] as const)
      expect(deviceButtonCommand('android', button)).toEqual({
        platform: 'android',
        type: button,
      });
  });

  test.each([
    ['ios', 'back'],
    ['ios', 'toString'],
    ['android', 'constructor'],
    ['android', '__proto__'],
    ['android', 'shell'],
    ['ios', 'reboot'],
    ['android', 42],
  ] as const)('refuses %s %s', (platform, button) => {
    expect(deviceButtonCommand(platform, button)).toBeNull();
  });
});

describe('typing on iOS', () => {
  test('letters, shifted letters, digits and punctuation', () => {
    expect(hidStrokeForCharacter('a')).toEqual({ usage: 0x04, shift: false });
    expect(hidStrokeForCharacter('Z')).toEqual({ usage: 0x1d, shift: true });
    expect(hidStrokeForCharacter('0')).toEqual({ usage: 0x27, shift: false });
    expect(hidStrokeForCharacter('!')).toEqual({ usage: 0x1e, shift: true });
    expect(hidStrokeForCharacter(' ')).toEqual({ usage: 0x2c, shift: false });
    expect(hidStrokeForCharacter('é')).toBeNull();
  });
});

describe('the cancel slide', () => {
  test.each([
    // [press, axis that moves, direction]
    [{ x: 0.02, y: 0.5 }, 'y', 'toward more room'],
    [{ x: 0.98, y: 0.8 }, 'y', 'toward more room'],
    [{ x: 0.5, y: 0.99 }, 'x', 'toward more room'],
    [{ x: 0.3, y: 0.01 }, 'x', 'toward more room'],
    // A corner is a tie: it breaks toward top/bottom, so the slide is
    // horizontal.
    [{ x: 0.02, y: 0.02 }, 'x', 'corner tie'],
    [{ x: 0.98, y: 0.98 }, 'x', 'corner tie'],
  ] as Array<[{ x: number; y: number }, 'x' | 'y', string]>)(
    'near an edge %o it slides parallel to that edge',
    (press, axis) => {
      const path = cancelSlidePath(press);
      expect(path.length).toBeGreaterThan(1);
      const still = axis === 'y' ? 'x' : 'y';
      for (const point of path) expect(point[still]).toBe(press[still]);
      const last = path.at(-1)!;
      expect(Math.abs(last[axis] - press[axis])).toBeCloseTo(
        CANCEL_SLIDE_DISTANCE,
      );
      // Small steps, never one jump.
      let previous = press[axis];
      for (const point of path) {
        expect(Math.abs(point[axis] - previous)).toBeLessThan(
          CANCEL_SLIDE_DISTANCE / 2,
        );
        previous = point[axis];
      }
      for (const point of path) {
        expect(point.x).toBeGreaterThanOrEqual(0);
        expect(point.x).toBeLessThanOrEqual(1);
        expect(point.y).toBeGreaterThanOrEqual(0);
        expect(point.y).toBeLessThanOrEqual(1);
      }
    },
  );
});
