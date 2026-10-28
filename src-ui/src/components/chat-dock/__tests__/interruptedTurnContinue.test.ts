import { describe, expect, test } from 'vitest';
import { continuableInterruptedBoundary } from '../interruptedTurnContinue';

const idle = { turnInFlight: false, pendingSends: 0 };
const notice = { interruptedTurnBoundaryId: 'turn-boundary:1' };

describe('continuableInterruptedBoundary', () => {
  test('offers the boundary of the latest row', () => {
    expect(continuableInterruptedBoundary([{}, notice], 1, idle)).toBe(
      'turn-boundary:1',
    );
  });

  test("this window's own ephemeral notices after it do not supersede it", () => {
    expect(
      continuableInterruptedBoundary(
        [notice, { ephemeral: true }, { ephemeral: true }],
        0,
        idle,
      ),
    ).toBe('turn-boundary:1');
  });

  test('a later conversation row supersedes it', () => {
    expect(
      continuableInterruptedBoundary(
        [notice, {}, { ephemeral: true }],
        0,
        idle,
      ),
    ).toBeUndefined();
  });

  test('a running turn, a pending send or a replay withholds it', () => {
    expect(
      continuableInterruptedBoundary([notice], 0, {
        ...idle,
        turnInFlight: true,
      }),
    ).toBeUndefined();
    expect(
      continuableInterruptedBoundary([notice], 0, { ...idle, pendingSends: 1 }),
    ).toBeUndefined();
    expect(
      continuableInterruptedBoundary([notice], 0, { ...idle, replay: true }),
    ).toBeUndefined();
  });

  test('a row that names no interruption offers nothing', () => {
    expect(continuableInterruptedBoundary([{}], 0, idle)).toBeUndefined();
  });
});
