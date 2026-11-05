// @vitest-environment jsdom

/**
 * "Rotate picture to fit": a landscape display on a portrait screen is drawn
 * turned a quarter, in a portrait box, and a touch on the turned picture
 * still reaches the display point under it.
 */

import type { LiveSurfaceFold } from '@kontourai/station-contracts/live-surface';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DEVICE_FOLD_TURN_KEY, useDeviceFold } from '../DeviceFoldView';
import { turnQuarter, unturnQuarter } from '../deviceFold';

const OPEN: LiveSurfaceFold = {
  activeDisplay: 'inner',
  hingeAngle: 180,
  posture: 'open',
  postures: ['closed', 'open', 'book', 'laptop', 'tent'],
  angleControl: true,
};
/** The inner display as shown upright: landscape. */
const SHOWN = { width: 2854, height: 2008 };

beforeEach(() => {
  // A portrait phone.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('orientation: portrait'),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

test('the quarter turn and its inverse undo each other', () => {
  const box = { width: 300, height: 426 };
  for (const point of [
    { x: 0, y: 0 },
    { x: 12, y: 400 },
    { x: 299, y: 3 },
  ]) {
    const unturned = unturnQuarter(point, box);
    expect(turnQuarter(unturned, box)).toEqual(point);
  }
});

test('turned to fit: a portrait box, and a touch maps through the turn', () => {
  const { result } = renderHook(() => useDeviceFold());
  act(() => result.current.report(OPEN));
  // Offered on a portrait screen, off until chosen.
  expect(result.current.controls.turnToFitOffered).toBe(true);
  expect(result.current.projection?.fitAspect?.(SHOWN)).toBeCloseTo(
    SHOWN.width / SHOWN.height,
  );
  act(() => result.current.controls.onTurnToFit(true));
  expect(localStorage.getItem(DEVICE_FOLD_TURN_KEY)).toBe('1');
  const projection = result.current.projection!;
  const aspect = projection.fitAspect!(SHOWN);
  expect(aspect).toBeCloseTo(SHOWN.height / SHOWN.width);
  // The portrait box the canvas fits at that aspect.
  const box = { left: 10, top: 20, width: 300, height: 300 / aspect };
  // The display's top-left corner is drawn at the box's top-RIGHT (turned
  // clockwise); its bottom-right at the box's bottom-left.
  const topLeft = projection.toFrame(
    { x: box.left + box.width - 0.5, y: box.top + 0.5 },
    box,
    SHOWN,
  );
  expect(topLeft!.x).toBeLessThan(10);
  expect(topLeft!.y).toBeLessThan(10);
  const bottomRight = projection.toFrame(
    { x: box.left + 0.5, y: box.top + box.height - 0.5 },
    box,
    SHOWN,
  );
  expect(bottomRight!.x).toBeGreaterThan(SHOWN.width - 10);
  expect(bottomRight!.y).toBeGreaterThan(SHOWN.height - 10);
});

test('a portrait display is never turned', () => {
  localStorage.setItem(DEVICE_FOLD_TURN_KEY, '1');
  const { result } = renderHook(() => useDeviceFold());
  act(() => result.current.report(OPEN));
  const tall = { width: 2008, height: 2854 };
  expect(result.current.projection?.fitAspect?.(tall)).toBeCloseTo(
    tall.width / tall.height,
  );
});
