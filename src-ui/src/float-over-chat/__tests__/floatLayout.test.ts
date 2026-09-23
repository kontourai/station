import { describe, expect, test } from 'vitest';
import {
  clampFloatPosition,
  FLOAT_EDGE_GAP,
  FLOAT_KEYBOARD_STEP,
  type FloatFrame,
  type FloatObstacles,
  fitFloatWidth,
  nudgeFloatFrame,
  resizeFloatFrame,
  resolveFloatFrame,
} from '../floatLayout';

/** A 1280×800 page (16:10), the Browser pane's default desktop viewport. */
const DESKTOP = { width: 1280, height: 800 };
/** A phone-shaped viewport (9:19.5-ish). */
const PHONE = { width: 390, height: 844 };
const CHAT = { width: 900, height: 700 };
/** A composer spanning the chat's middle 500px, 120px tall at the bottom. */
const COMPOSER: FloatObstacles = {
  composer: { left: 200, right: 700, height: 120 },
};

function bottom(frame: FloatFrame) {
  return frame.y + frame.height;
}

describe('float-over-chat geometry (#90 D9)', () => {
  test('a fresh player is the default 320 box at the source aspect, top-right, 12px from the edges', () => {
    const wide = resolveFloatFrame({
      width: null,
      position: null,
      source: DESKTOP,
      container: CHAT,
    });
    expect(wide).toEqual({ x: 900 - 12 - 320, y: 12, width: 320, height: 200 });
    // A tall source would fit the box at ~148 wide, under the 240 minimum,
    // so the minimum sets its width and the aspect its height.
    const tall = resolveFloatFrame({
      width: null,
      position: null,
      source: PHONE,
      container: CHAT,
    });
    expect(tall.width).toBe(240);
    expect(tall.height).toBe(Math.round(240 / (390 / 844)));
    expect(tall.x + tall.width).toBe(CHAT.width - FLOAT_EDGE_GAP);
  });

  test('the minimum is 240 wide and 150 tall, but a tight chat wins over it', () => {
    expect(fitFloatWidth(10, DESKTOP, { width: 2000, height: 2000 })).toEqual({
      width: 240,
      height: 150,
    });
    // A very wide source reaches 150 tall before 240 wide: height governs.
    expect(
      fitFloatWidth(
        10,
        { width: 2000, height: 500 },
        { width: 5000, height: 5000 },
      ),
    ).toEqual({ width: 600, height: 150 });
    // No room for the minimum: the container decides.
    expect(fitFloatWidth(10, DESKTOP, { width: 200, height: 2000 })).toEqual({
      width: 200,
      height: 125,
    });
  });

  test('never grows past the source size (that would only upscale)', () => {
    expect(
      fitFloatWidth(
        5000,
        { width: 400, height: 300 },
        { width: 9999, height: 9999 },
      ),
    ).toEqual({ width: 400, height: 300 });
  });

  test('clamps inside the chat, 12px from every edge', () => {
    const player = { width: 320, height: 200 };
    expect(clampFloatPosition({ x: -500, y: -500 }, CHAT, player)).toEqual({
      x: 12,
      y: 12,
    });
    expect(clampFloatPosition({ x: 5000, y: 5000 }, CHAT, player)).toEqual({
      x: CHAT.width - 320 - 12,
      y: CHAT.height - 200 - 12,
    });
  });

  test('composer avoidance: a player dropped on the composer slides beside it when that is the shorter move', () => {
    const player = { width: 150, height: 100 };
    // Dropped at the bottom, mostly over the composer's right end.
    const moved = clampFloatPosition(
      { x: 690, y: 5000 },
      CHAT,
      player,
      COMPOSER,
    );
    // Beside the composer, not on it: to its right with the gap.
    expect(moved.x).toBe(700 + FLOAT_EDGE_GAP);
    expect(bottom({ ...moved, ...player })).toBe(CHAT.height - FLOAT_EDGE_GAP);
  });

  test('composer avoidance: with no room beside it the player sits above the composer', () => {
    const wideComposer: FloatObstacles = {
      composer: { left: 0, right: CHAT.width, height: 120 },
    };
    const player = { width: 320, height: 200 };
    const moved = clampFloatPosition(
      { x: 300, y: 5000 },
      CHAT,
      player,
      wideComposer,
    );
    expect(moved.y + player.height).toBe(CHAT.height - 120 - FLOAT_EDGE_GAP);
  });

  test('composer avoidance: a fresh player is sized to the rows above the composer', () => {
    const shortChat = { width: 900, height: 300 };
    const composer: FloatObstacles = {
      composer: { left: 0, right: 900, height: 150 },
    };
    const frame = resolveFloatFrame({
      width: null,
      position: null,
      source: PHONE,
      container: shortChat,
      obstacles: composer,
    });
    // 300 − 150 composer − 2 × 12 gap = 126 rows for the player.
    expect(bottom(frame)).toBeLessThanOrEqual(300 - 150 - FLOAT_EDGE_GAP);
  });

  test('resizing from any edge holds the aspect ratio and anchors the opposite edge', () => {
    const start = { x: 300, y: 100, width: 320, height: 200 };
    const east = resizeFloatFrame({
      start,
      direction: 'east',
      delta: { x: 80, y: 0 },
      source: DESKTOP,
      container: CHAT,
    });
    expect(east).toEqual({ x: 300, y: 100, width: 400, height: 250 });
    const northwest = resizeFloatFrame({
      start,
      direction: 'northwest',
      delta: { x: -80, y: -50 },
      source: DESKTOP,
      container: CHAT,
    });
    // The bottom-right corner stays put.
    expect(northwest.x + northwest.width).toBe(start.x + start.width);
    expect(bottom(northwest)).toBe(bottom(start));
    expect(northwest.width / northwest.height).toBeCloseTo(1280 / 800, 2);
  });

  test('resizing never goes below the minimum or into the composer', () => {
    const start = { x: 300, y: 300, width: 320, height: 200 };
    const shrunk = resizeFloatFrame({
      start,
      direction: 'southeast',
      delta: { x: -500, y: -500 },
      source: DESKTOP,
      container: CHAT,
    });
    expect(shrunk.width).toBe(240);
    const grown = resizeFloatFrame({
      start,
      direction: 'south',
      delta: { x: 0, y: 1000 },
      source: DESKTOP,
      container: CHAT,
      obstacles: COMPOSER,
    });
    // Its columns meet the composer: growth stops above it.
    expect(bottom(grown)).toBeLessThanOrEqual(
      CHAT.height - 120 - FLOAT_EDGE_GAP,
    );
  });

  test('the keyboard moves one step, clamped like a drag, and Shift resizes aspect-locked', () => {
    const frame = { x: 300, y: 100, width: 320, height: 200 };
    const moved = nudgeFloatFrame({
      frame,
      key: 'ArrowLeft',
      resize: false,
      source: DESKTOP,
      container: CHAT,
    });
    expect(moved).toEqual({ ...frame, x: 300 - FLOAT_KEYBOARD_STEP });
    const atEdge = nudgeFloatFrame({
      frame: { ...frame, y: 12 },
      key: 'ArrowUp',
      resize: false,
      source: DESKTOP,
      container: CHAT,
    });
    expect(atEdge.y).toBe(12);
    const grown = nudgeFloatFrame({
      frame,
      key: 'ArrowRight',
      resize: true,
      source: DESKTOP,
      container: CHAT,
    });
    expect(grown.width).toBe(320 + FLOAT_KEYBOARD_STEP);
    expect(grown.height).toBe(Math.round(grown.width / (1280 / 800)));
    expect({ x: grown.x, y: grown.y }).toEqual({ x: 300, y: 100 });
    // Down onto the composer: pushed off it, as a drag would be.
    const down = nudgeFloatFrame({
      frame: { x: 300, y: 700 - 120 - 12 - 200, width: 320, height: 200 },
      key: 'ArrowDown',
      resize: false,
      source: DESKTOP,
      container: CHAT,
      obstacles: COMPOSER,
    });
    // No room beside it at this width, so it stays above the composer.
    expect(bottom(down)).toBe(CHAT.height - 120 - FLOAT_EDGE_GAP);
  });
});
