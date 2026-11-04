import type { LiveSurfaceFold } from '@kontourai/station-contracts/live-surface';
import { describe, expect, test } from 'vitest';
import {
  foldPresentation,
  projectFoldPoint,
  snapHingeAngle,
  unprojectFoldPoint,
} from '../deviceFold';

const FOLD: LiveSurfaceFold = {
  activeDisplay: 'inner',
  hingeAngle: 90,
  posture: 'book',
  postures: ['closed', 'open', 'book', 'laptop', 'tent'],
  angleControl: true,
};
const WIDE = { width: 2200, height: 1920 };
const TALL = { width: 1920, height: 2200 };
const BOX = { width: 440, height: 384 };

describe('foldPresentation', () => {
  test('no fold, or the cover display lit, is drawn flat', () => {
    expect(foldPresentation(undefined, WIDE).crease).toBeNull();
    expect(
      foldPresentation({ ...FOLD, activeDisplay: 'cover' }, WIDE).crease,
    ).toBeNull();
  });

  test('the crease splits the longer side, whichever way the device is turned', () => {
    expect(foldPresentation(FOLD, WIDE).crease).toBe('vertical');
    expect(foldPresentation(FOLD, TALL).crease).toBe('horizontal');
  });

  test('each stand has its own shape; a dragged hinge bends symmetrically', () => {
    expect(foldPresentation(FOLD, WIDE).turns).toEqual([45, 45]);
    expect(
      foldPresentation({ ...FOLD, posture: 'laptop' }, TALL).turns,
    ).toEqual([0, 80]);
    expect(
      foldPresentation({ ...FOLD, posture: 'tent', hingeAngle: 80 }, WIDE)
        .turns,
    ).toEqual([-50, -50]);
    expect(
      foldPresentation({ ...FOLD, posture: 'open', hingeAngle: 180 }, WIDE)
        .turns,
    ).toEqual([0, 0]);
    expect(
      foldPresentation({ ...FOLD, posture: 'laptop' }, TALL, 120).turns,
    ).toEqual([30, 30]);
  });

  test('a stand reported without an angle is drawn at that stand', () => {
    expect(
      foldPresentation({ ...FOLD, hingeAngle: null, posture: 'book' }, WIDE)
        .turns,
    ).toEqual([45, 45]);
  });
});

describe('unprojectFoldPoint inverts the drawing', () => {
  test.each([
    ['book', { ...FOLD }],
    ['laptop', { ...FOLD, posture: 'laptop' as const }],
    ['tent', { ...FOLD, posture: 'tent' as const, hingeAngle: 80 }],
    ['nearly flat', { ...FOLD, posture: null, hingeAngle: 170 }],
  ])('%s', (_name, fold) => {
    for (const shown of [WIDE, TALL]) {
      const box = shown === WIDE ? BOX : { width: 384, height: 440 };
      const presentation = foldPresentation(fold, shown);
      for (const point of [
        { x: 10, y: 10 },
        { x: box.width - 10, y: box.height - 10 },
        { x: box.width * 0.6, y: box.height * 0.3 },
        { x: box.width * 0.25, y: box.height * 0.8 },
      ]) {
        const drawn = projectFoldPoint(point, box, presentation);
        const back = unprojectFoldPoint(drawn, box, presentation);
        expect(back?.x).toBeCloseTo(point.x, 6);
        expect(back?.y).toBeCloseTo(point.y, 6);
      }
    }
  });

  test('a point beyond the drawn halves is not on the display', () => {
    const presentation = foldPresentation(FOLD, WIDE);
    expect(
      unprojectFoldPoint({ x: 438, y: 192 }, BOX, presentation),
    ).toBeNull();
    expect(unprojectFoldPoint({ x: 2, y: 192 }, BOX, presentation)).toBeNull();
  });

  test('flat: only points inside the box', () => {
    const flat = foldPresentation(undefined, WIDE);
    expect(unprojectFoldPoint({ x: 5, y: 6 }, BOX, flat)).toEqual({
      x: 5,
      y: 6,
    });
    expect(unprojectFoldPoint({ x: -1, y: 6 }, BOX, flat)).toBeNull();
  });
});

describe('snapHingeAngle', () => {
  test('settles near a stand, otherwise the whole degree', () => {
    const all = FOLD.postures;
    expect(snapHingeAngle(86, all)).toBe(90);
    expect(snapHingeAngle(78.4, all)).toBe(80);
    expect(snapHingeAngle(4, all)).toBe(0);
    expect(snapHingeAngle(133.4, all)).toBe(133);
    expect(snapHingeAngle(200, all)).toBe(180);
    // Only the device's own stands attract the hinge.
    expect(snapHingeAngle(86, ['closed', 'open'])).toBe(86);
  });
});
