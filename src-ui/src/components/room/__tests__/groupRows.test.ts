import { describe, expect, test } from 'vitest';
import { groupRows, ROOM_GROUP_WINDOW_MS } from '../groupRows';

// Local wall-clock instants, so day boundaries hold in any time zone.
const at = (day: number, hour: number, minute: number, second = 0) =>
  new Date(2026, 10, day, hour, minute, second).toISOString();
const message = (authorId: string, time: string, reply = false) => ({
  kind: 'message' as const,
  authorId,
  at: time,
  reply,
});

describe('groupRows', () => {
  test('the window under test is five minutes', () => {
    expect(ROOM_GROUP_WINDOW_MS).toBe(300_000);
  });

  test('one author within five minutes on one day forms a group', () => {
    const placed = groupRows([
      message('ana', at(3, 9, 0)),
      message('ana', at(3, 9, 2)),
      message('ana', at(3, 9, 7)),
    ]);
    expect(placed.map((row) => [row.stackPrevious, row.stackNext])).toEqual([
      [false, true],
      [true, true],
      [true, false],
    ]);
  });

  test('five minutes still groups; one second more starts a new group', () => {
    const placed = groupRows([
      message('ana', at(3, 9, 0)),
      message('ana', at(3, 9, 5)),
      message('ana', at(3, 9, 10, 1)),
    ]);
    expect(placed.map((row) => row.stackPrevious)).toEqual([
      false,
      true,
      false,
    ]);
  });

  test('another author breaks the group', () => {
    const placed = groupRows([
      message('ana', at(3, 9, 0)),
      message('ben', at(3, 9, 1)),
      message('ana', at(3, 9, 2)),
    ]);
    expect(placed.map((row) => row.stackPrevious)).toEqual([
      false,
      false,
      false,
    ]);
  });

  test('midnight breaks a group even within five minutes and starts a new day', () => {
    const placed = groupRows([
      message('ana', at(3, 23, 58)),
      message('ana', at(4, 0, 1)),
    ]);
    expect(placed[1]).toEqual({
      stackPrevious: false,
      stackNext: false,
      newDay: true,
    });
    expect(placed[0]?.stackNext).toBe(false);
  });

  test('system rows and replies always start a new group', () => {
    const placed = groupRows([
      message('ana', at(3, 9, 0)),
      { kind: 'system', authorId: 'ana', at: at(3, 9, 1) },
      message('ana', at(3, 9, 2)),
      message('ana', at(3, 9, 3), true),
      message('ana', at(3, 9, 4)),
    ]);
    expect(placed.map((row) => row.stackPrevious)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(placed.map((row) => row.stackNext)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  test('a day divider opens the first row and each new day, never a same-day row', () => {
    const placed = groupRows([
      message('ana', at(2, 15, 0)),
      message('ben', at(2, 18, 0)),
      { kind: 'system', at: undefined },
      message('ana', at(3, 9, 0)),
      message('ben', at(3, 9, 30)),
    ]);
    expect(placed.map((row) => row.newDay)).toEqual([
      true,
      false,
      false,
      true,
      false,
    ]);
  });

  test('rows without a usable time never group', () => {
    const placed = groupRows([
      message('ana', 'not a time'),
      message('ana', 'not a time'),
    ]);
    expect(placed.map((row) => row.stackPrevious)).toEqual([false, false]);
  });
});
