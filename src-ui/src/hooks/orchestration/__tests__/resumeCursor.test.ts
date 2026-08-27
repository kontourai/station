import { describe, expect, test } from 'vitest';
import {
  createStreamCursorTracker,
  parseStreamSequence,
  shouldApplyStreamFrame,
} from '../resumeCursor';

describe('parseStreamSequence', () => {
  test('parses a finite numeric id', () => {
    expect(parseStreamSequence('42')).toBe(42);
    expect(parseStreamSequence('0')).toBe(0);
  });

  test('returns undefined for absent, empty, or non-numeric ids (pre-#1092 host)', () => {
    expect(parseStreamSequence(undefined)).toBeUndefined();
    expect(parseStreamSequence('')).toBeUndefined();
    expect(parseStreamSequence('not-a-number')).toBeUndefined();
  });
});

describe('shouldApplyStreamFrame', () => {
  test('a frame without a sequence always applies (graceful degradation)', () => {
    expect(shouldApplyStreamFrame(undefined, 5)).toBe(true);
  });

  test('a frame strictly ahead of the last applied sequence applies', () => {
    expect(shouldApplyStreamFrame(6, 5)).toBe(true);
  });

  test('a frame at or behind the last applied sequence is dropped (station#1092 AC3)', () => {
    expect(shouldApplyStreamFrame(5, 5)).toBe(false);
    expect(shouldApplyStreamFrame(4, 5)).toBe(false);
  });
});

describe('createStreamCursorTracker', () => {
  test('admits frames in increasing sequence order and advances the cursor', () => {
    const tracker = createStreamCursorTracker();
    expect(tracker.admit('1')).toBe(true);
    expect(tracker.admit('2')).toBe(true);
    expect(tracker.admit('3')).toBe(true);
  });

  test('drops an overlapping/duplicate replay frame — zero duplicate applications (AC3)', () => {
    const tracker = createStreamCursorTracker();
    expect(tracker.admit('1')).toBe(true);
    expect(tracker.admit('2')).toBe(true);
    // Reconnect replay re-delivers 1 and 2 before the client's true gap.
    expect(tracker.admit('1')).toBe(false);
    expect(tracker.admit('2')).toBe(false);
    // A genuinely new frame after the overlap still admits.
    expect(tracker.admit('3')).toBe(true);
  });

  test('admits every frame from a pre-#1092 host (no ids at all)', () => {
    const tracker = createStreamCursorTracker();
    expect(tracker.admit(undefined)).toBe(true);
    expect(tracker.admit(undefined)).toBe(true);
    expect(tracker.admit(undefined)).toBe(true);
  });

  test('adopt() sets the cursor unconditionally without requiring admit()', () => {
    const tracker = createStreamCursorTracker();
    tracker.adopt('100');
    // A frame at or below the adopted snapshot cursor is now stale.
    expect(tracker.admit('99')).toBe(false);
    expect(tracker.admit('100')).toBe(false);
    expect(tracker.admit('101')).toBe(true);
  });
});
