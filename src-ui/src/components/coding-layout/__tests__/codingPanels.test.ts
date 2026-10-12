/** @vitest-environment jsdom */

import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { describe, expect, test, vi } from 'vitest';
import {
  CODING_FOLD_HYSTERESIS,
  CODING_FOLD_SETTLE_MS,
  CODING_LOWER_MIN_HEIGHT,
  CODING_SIDE_DEFAULT_WIDTH,
  CODING_SIDE_MIN_WIDTH,
  CODING_TRANSCRIPT_MIN_WIDTH,
  clampCodingLowerHeight,
  clampCodingSideWidth,
  codingLowerDefaultHeight,
  codingLowerMaxHeight,
  codingSideMaxWidth,
  codingTranscriptWidth,
  hostRendersCodingPane,
  resizeCodingPanelFromKeyboard,
  useCodingWide,
} from '../codingPanels';

describe('codingPanels — the wide fold and the panels’ bounds (#3040)', () => {
  test('the fold is 1280px: Chat and a tool at their floors, the separator, the rail and the sidebar', () => {
    // The derivation the fold is justified by, pinned so a floor cannot
    // move without the fold being reconsidered: Chat 480 + tool 320 + the
    // 8px separator + the 44px rail + the 240px sidebar = 1092, and 1280
    // is the next conventional step. Chat's floor is read through the
    // clamp: a 1440px room leaves the tool 1440 - 44 - 8 - 480.
    expect(CODING_SIDE_MIN_WIDTH).toBe(320);
    expect(codingSideMaxWidth(1440)).toBe(908);
    expect(480 + CODING_SIDE_MIN_WIDTH + 8 + 44 + 240).toBe(1092);
  });

  test('useCodingWide follows the 1280px media query', () => {
    const listeners = new Set<() => void>();
    let matches = false;
    const matchMedia = vi.fn((query: string) => ({
      get matches() {
        return query === '(min-width: 1280px)' && matches;
      },
      addEventListener: (_type: string, listener: () => void) =>
        listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) =>
        listeners.delete(listener),
    }));
    vi.stubGlobal('matchMedia', matchMedia);
    try {
      const { result, unmount } = renderHook(() => useCodingWide());
      expect(matchMedia).toHaveBeenCalledWith('(min-width: 1280px)');
      expect(result.current).toBe(false);
      act(() => {
        matches = true;
        for (const listener of listeners) listener();
      });
      expect(result.current).toBe(true);
      unmount();
      expect(listeners.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('the side panel never drops Chat below its floor, and never itself below a tool’s', () => {
    // Room 1440 wide: 1440 - 44 (rail) - 8 (separator) - 480 (Chat) = 908.
    expect(codingSideMaxWidth(1440)).toBe(908);
    expect(clampCodingSideWidth(2000, 1440)).toBe(908);
    expect(clampCodingSideWidth(100, 1440)).toBe(CODING_SIDE_MIN_WIDTH);
    expect(clampCodingSideWidth(CODING_SIDE_DEFAULT_WIDTH, 1440)).toBe(
      CODING_SIDE_DEFAULT_WIDTH,
    );
    // A room too small for both floors: the tool's floor wins (Chat's own
    // min-width keeps the row from folding).
    expect(codingSideMaxWidth(700)).toBe(CODING_SIDE_MIN_WIDTH);
    expect(clampCodingSideWidth(500, 700)).toBe(CODING_SIDE_MIN_WIDTH);
  });

  test('the lower panel leaves Chat its minimum height', () => {
    // Room 800 tall: 800 - 8 - 240 = 552.
    expect(codingLowerMaxHeight(800)).toBe(552);
    expect(clampCodingLowerHeight(2000, 800)).toBe(552);
    expect(clampCodingLowerHeight(10, 800)).toBe(CODING_LOWER_MIN_HEIGHT);
    expect(codingLowerMaxHeight(300)).toBe(CODING_LOWER_MIN_HEIGHT);
  });

  test('the lower panel opens at three tenths of the room, within its floor and Chat’s', () => {
    // The fraction beside its literal: 860px tall opens 258px (eleven or so
    // terminal rows under the head and the strip) and leaves the transcript
    // seventy percent.
    expect(codingLowerDefaultHeight(860)).toBe(258);
    expect(codingLowerDefaultHeight(1000)).toBe(300);
    expect(codingLowerDefaultHeight(400)).toBe(CODING_LOWER_MIN_HEIGHT);
    // A room where three tenths would crowd Chat stops at Chat's floor.
    expect(codingLowerDefaultHeight(380)).toBe(codingLowerMaxHeight(380));
  });

  test('the transcript keeps 640px beside a tool, counting the inbox as measured or by its own rule', () => {
    // The floor beside its derivation (`codingPanels.ts`): the column's
    // two 20px gutters, then the bubble's 80% of the row and its 48px of
    // padding, leave 432px of text — the ~60-character measure.
    expect(CODING_TRANSCRIPT_MIN_WIDTH).toBe(640);
    expect((CODING_TRANSCRIPT_MIN_WIDTH - 2 * 20) * 0.8 - 48).toBe(432);
    // So at 1440 with the inbox at its 24vw (346) and a 440 tool, the
    // transcript (1440 - 44 - 8 - 440 - 346 = 602) is under the floor and
    // the inbox folds; at 1920 (1920 - 52 - 440 - 360 = 1068) it stays.
    expect(codingTranscriptWidth(1440, 440, 346)).toBeLessThan(
      CODING_TRANSCRIPT_MIN_WIDTH,
    );
    expect(codingTranscriptWidth(1920, 440, null)).toBeGreaterThan(
      CODING_TRANSCRIPT_MIN_WIDTH,
    );
    // 1440 room, 440 tool, inbox measured 345: 1440 - 44 - 8 - 440 - 345.
    expect(codingTranscriptWidth(1440, 440, 345)).toBe(603);
    // Unmeasured inbox: clamp(240, 24% of 1440 = 345.6, 360).
    expect(codingTranscriptWidth(1440, 440, null)).toBeCloseTo(602.4);
    expect(codingTranscriptWidth(1000, 320, null)).toBe(1000 - 52 - 320 - 240);
    expect(codingTranscriptWidth(2000, 320, null)).toBe(2000 - 52 - 320 - 360);
  });

  test('the keyboard nudges along the separator’s axis, Shift coarsely, Home/End to the bounds, Enter to the default', () => {
    const bounds = { min: 320, max: 900, reset: 440 };
    const vertical = (current: number, key: string, shiftKey = false) =>
      resizeCodingPanelFromKeyboard('vertical', current, key, {
        ...bounds,
        shiftKey,
      });
    expect(vertical(440, 'ArrowLeft')).toBe(456);
    expect(vertical(440, 'ArrowRight')).toBe(424);
    expect(vertical(440, 'ArrowLeft', true)).toBe(504);
    expect(vertical(890, 'ArrowLeft', true)).toBe(900);
    expect(vertical(330, 'ArrowRight')).toBe(320);
    expect(vertical(500, 'Home')).toBe(320);
    expect(vertical(500, 'End')).toBe(900);
    expect(vertical(500, 'Enter')).toBe(440);
    expect(vertical(500, 'ArrowUp')).toBeNull();
    expect(vertical(500, 'a')).toBeNull();

    const horizontal = (current: number, key: string) =>
      resizeCodingPanelFromKeyboard('horizontal', current, key, {
        min: 160,
        max: 520,
        reset: 280,
      });
    expect(horizontal(280, 'ArrowUp')).toBe(296);
    expect(horizontal(280, 'ArrowDown')).toBe(264);
    expect(horizontal(280, 'ArrowLeft')).toBeNull();
    // A default outside the bounds lands on them, never outside.
    expect(
      resizeCodingPanelFromKeyboard('horizontal', 200, 'Enter', {
        min: 160,
        max: 200,
        reset: 280,
      }),
    ).toBe(200);
  });
});

describe('codingPanels — the fold’s settle and hysteresis, and who draws the Terminal', () => {
  test('a resized room rests 150ms before the fold is judged, and an unfold waits for 24px of room past the floor', () => {
    // Literals beside the constants: zeroing either changes the behaviour
    // the workbench tests prove (a fold per frame; a width on the line
    // flapping), so it changes these too.
    expect(CODING_FOLD_SETTLE_MS).toBe(150);
    expect(CODING_FOLD_HYSTERESIS).toBe(24);
  });

  test('the pane host draws every pane once drilled in, except the Terminal past the fold', () => {
    expect(hostRendersCodingPane(false, true, 'terminal', 'terminal')).toBe(
      true,
    );
    expect(hostRendersCodingPane(true, true, 'diff', 'terminal')).toBe(true);
    expect(hostRendersCodingPane(true, true, 'terminal', 'terminal')).toBe(
      false,
    );
    expect(hostRendersCodingPane(true, true, 'terminal', null)).toBe(true);
    expect(hostRendersCodingPane(true, false, 'diff', 'terminal')).toBe(false);
  });
});
