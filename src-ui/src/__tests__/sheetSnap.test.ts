import { describe, expect, test } from 'vitest';
import {
  MOBILE_DOCK_COLLAPSE_FLING_VELOCITY,
  MOBILE_DOCK_FLING_VELOCITY,
} from '../components/chat-dock/dockSnap';
import {
  resolveSheetSnap,
  SHEET_MIN_EXPANSION,
  sheetCanExpand,
  sheetDragHeight,
} from '../components/sheetSnap';

const resting = { defaultHeight: 300, fullHeight: 800 };
const fromDefault = { ...resting, start: 'default' as const, startHeight: 300 };
const fromFull = { ...resting, start: 'full' as const, startHeight: 800 };

describe('resolveSheetSnap', () => {
  test('a slow release lands on the nearest resting state', () => {
    // Dragged up past the Default/Full midpoint (550px visible).
    expect(
      resolveSheetSnap({ ...fromDefault, deltaY: -260, velocityY: 0 }),
    ).toBe('full');
    // Dragged up, but nearer Default.
    expect(
      resolveSheetSnap({ ...fromDefault, deltaY: -240, velocityY: 0 }),
    ).toBe('default');
    // Dragged down less than half the sheet: it stays.
    expect(
      resolveSheetSnap({ ...fromDefault, deltaY: 140, velocityY: 0 }),
    ).toBe('default');
    // Dragged down more than half the sheet: it goes.
    expect(
      resolveSheetSnap({ ...fromDefault, deltaY: 160, velocityY: 0 }),
    ).toBe('dismiss');
    // From Full, a slow pull most of the way down rests on Default.
    expect(resolveSheetSnap({ ...fromFull, deltaY: 400, velocityY: 0 })).toBe(
      'default',
    );
  });

  test('an exact midpoint keeps the larger state, so the sheet stays open', () => {
    expect(
      resolveSheetSnap({ ...fromDefault, deltaY: -250, velocityY: 0 }),
    ).toBe('full');
    expect(
      resolveSheetSnap({ ...fromDefault, deltaY: 150, velocityY: 0 }),
    ).toBe('default');
  });

  test('flings follow their direction, and only a decisive one dismisses', () => {
    expect(
      resolveSheetSnap({
        ...fromDefault,
        deltaY: -20,
        velocityY: -MOBILE_DOCK_FLING_VELOCITY,
      }),
    ).toBe('full');
    // A moderate downward flick from Default is judged on position.
    expect(
      resolveSheetSnap({
        ...fromDefault,
        deltaY: 30,
        velocityY: MOBILE_DOCK_FLING_VELOCITY,
      }),
    ).toBe('default');
    expect(
      resolveSheetSnap({
        ...fromDefault,
        deltaY: 30,
        velocityY: MOBILE_DOCK_COLLAPSE_FLING_VELOCITY,
      }),
    ).toBe('dismiss');
    // Even a hard flick from Full only returns to Default.
    expect(
      resolveSheetSnap({
        ...fromFull,
        deltaY: 30,
        velocityY: MOBILE_DOCK_COLLAPSE_FLING_VELOCITY * 2,
      }),
    ).toBe('default');
  });

  test('a velocity against the travelled direction is not a fling', () => {
    // The finger went up overall but jerked down at release.
    expect(
      resolveSheetSnap({
        ...fromDefault,
        deltaY: -40,
        velocityY: MOBILE_DOCK_COLLAPSE_FLING_VELOCITY,
      }),
    ).toBe('default');
  });

  test('a sheet with no room to grow never offers Full', () => {
    const tall = { defaultHeight: 780, fullHeight: 800 };
    expect(sheetCanExpand(tall.defaultHeight, tall.fullHeight)).toBe(false);
    expect(
      sheetCanExpand(
        tall.defaultHeight,
        tall.defaultHeight + SHEET_MIN_EXPANSION,
      ),
    ).toBe(true);
    expect(
      resolveSheetSnap({
        ...tall,
        start: 'default',
        startHeight: 780,
        deltaY: -200,
        velocityY: -MOBILE_DOCK_FLING_VELOCITY,
      }),
    ).toBe('default');
    expect(
      resolveSheetSnap({
        ...tall,
        start: 'default',
        startHeight: 780,
        deltaY: 500,
        velocityY: 0,
      }),
    ).toBe('dismiss');
  });
});

test('sheetDragHeight follows the pointer between nothing and Full', () => {
  expect(sheetDragHeight(300, -100, 800)).toBe(400);
  expect(sheetDragHeight(300, -900, 800)).toBe(800);
  expect(sheetDragHeight(300, 500, 800)).toBe(0);
});
