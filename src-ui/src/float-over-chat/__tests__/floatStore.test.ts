// @vitest-environment jsdom

/**
 * #90 D9: the float-over-chat's per-device memory is a convenience. A
 * storage that throws (private window, blocked site data) or holds a record
 * that is not JSON must never break the floater: it falls back to the
 * default placement and to this session's memory, and says nothing false.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  dismissFloat,
  getFloatPlacement,
  isFloatDismissed,
  resetFloatStoreForTests,
  setFloatPlacement,
} from '../floatStore';

const FRAME = 'station:float-over-chat:frame:v1';
const DISMISSED = 'station:float-over-chat:dismissed:v1';

beforeEach(() => {
  window.localStorage.clear();
  resetFloatStoreForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('float-over-chat storage', () => {
  test('a record that is not JSON reads as nothing remembered, and the next write replaces it', () => {
    window.localStorage.setItem(FRAME, '{not json');
    window.localStorage.setItem(DISMISSED, '[[[');
    expect(getFloatPlacement()).toEqual({ position: null, width: null });
    expect(isFloatDismissed('conversation-1', 'browser:x')).toBe(false);
    dismissFloat('conversation-1', 'browser:x');
    expect(isFloatDismissed('conversation-1', 'browser:x')).toBe(true);
    expect(
      JSON.parse(window.localStorage.getItem(DISMISSED) ?? 'null'),
    ).toEqual({ 'conversation-1': ['browser:x'] });
    setFloatPlacement(
      { position: { x: 20, y: 30 }, width: 300 },
      { persist: true },
    );
    expect(JSON.parse(window.localStorage.getItem(FRAME) ?? 'null')).toEqual({
      position: { x: 20, y: 30 },
      width: 300,
    });
  });

  test('well-formed JSON of the wrong shape is ignored field by field', () => {
    window.localStorage.setItem(
      FRAME,
      JSON.stringify({ position: { x: 'left', y: 4 }, width: -5 }),
    );
    window.localStorage.setItem(
      DISMISSED,
      JSON.stringify({ 'conversation-1': [7, 'browser:y'], other: 'nope' }),
    );
    expect(getFloatPlacement()).toEqual({ position: null, width: null });
    expect(isFloatDismissed('conversation-1', 'browser:y')).toBe(true);
    expect(isFloatDismissed('other', 'nope')).toBe(false);
  });

  test('a storage that throws on every call leaves the floater working from memory', () => {
    const boom = () => {
      throw new DOMException('blocked', 'SecurityError');
    };
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(boom);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(boom);
    expect(getFloatPlacement()).toEqual({ position: null, width: null });
    expect(() =>
      setFloatPlacement(
        { position: { x: 1, y: 2 }, width: 280 },
        { persist: true },
      ),
    ).not.toThrow();
    // Not written anywhere, but this session still has it.
    expect(getFloatPlacement()).toEqual({
      position: { x: 1, y: 2 },
      width: 280,
    });
    expect(() => dismissFloat('conversation-1', 'browser:x')).not.toThrow();
    expect(isFloatDismissed('conversation-1', 'browser:x')).toBe(true);
  });

  test('a localStorage whose very accessor throws is treated as absent', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(getFloatPlacement()).toEqual({ position: null, width: null });
    expect(() => dismissFloat('conversation-1', 'browser:x')).not.toThrow();
    expect(isFloatDismissed('conversation-1', 'browser:x')).toBe(true);
  });
});
