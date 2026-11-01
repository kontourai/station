import { describe, expect, test } from 'vitest';
import { continuableInterruptedBoundary } from '../interruptedTurnContinue';

const idle = { current: true, turnInFlight: false, pendingSends: 0 };
const notice = { interruptedTurnBoundaryId: 'turn-boundary:1' };

describe('continuableInterruptedBoundary', () => {
  test('offers the boundary of the latest row', () => {
    expect(continuableInterruptedBoundary([{}, notice], notice, idle)).toBe(
      'turn-boundary:1',
    );
  });

  test('matches the row by its boundary, not by object identity', () => {
    // The list can render an earlier, equivalent copy of the row.
    const earlierCopy = { interruptedTurnBoundaryId: 'turn-boundary:1' };
    expect(
      continuableInterruptedBoundary([{}, notice], earlierCopy, idle),
    ).toBe('turn-boundary:1');
  });

  test("this window's own ephemeral notices after it do not supersede it", () => {
    expect(
      continuableInterruptedBoundary(
        [notice, { ephemeral: true }, { ephemeral: true }],
        notice,
        idle,
      ),
    ).toBe('turn-boundary:1');
  });

  test('a later conversation row supersedes it', () => {
    expect(
      continuableInterruptedBoundary(
        [notice, {}, { ephemeral: true }],
        notice,
        idle,
      ),
    ).toBeUndefined();
  });

  test('a later interruption supersedes an earlier one', () => {
    expect(
      continuableInterruptedBoundary(
        [notice, { interruptedTurnBoundaryId: 'turn-boundary:2' }],
        notice,
        idle,
      ),
    ).toBeUndefined();
  });

  test('a transcript still catching up, or a conversation that cannot take a send, withholds it', () => {
    expect(
      continuableInterruptedBoundary([notice], notice, {
        ...idle,
        current: false,
      }),
    ).toBeUndefined();
  });

  test('a running turn, a pending send or a replay withholds it', () => {
    expect(
      continuableInterruptedBoundary([notice], notice, {
        ...idle,
        turnInFlight: true,
      }),
    ).toBeUndefined();
    expect(
      continuableInterruptedBoundary([notice], notice, {
        ...idle,
        pendingSends: 1,
      }),
    ).toBeUndefined();
    expect(
      continuableInterruptedBoundary([notice], notice, {
        ...idle,
        replay: true,
      }),
    ).toBeUndefined();
  });

  test('a row that names no interruption offers nothing', () => {
    expect(continuableInterruptedBoundary([{}], {}, idle)).toBeUndefined();
  });
});
