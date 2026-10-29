/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  animateScrollToBottom,
  prefersInstantScroll,
  SCROLL_TO_BOTTOM_DURATION_MS,
} from '../components/chat/animateScrollToBottom';

/** A scroller whose geometry the test owns, with a manual frame clock. */
function harness(geometry: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}) {
  const element = geometry as unknown as HTMLElement;
  let now = 0;
  let frames: FrameRequestCallback[] = [];
  let timer: (() => void) | null = null;
  const writes: number[] = [];
  const finished: boolean[] = [];
  const seams = {
    write: (top: number) => {
      // The browser clamps a write to the scroll range.
      geometry.scrollTop = Math.min(
        top,
        geometry.scrollHeight - geometry.clientHeight,
      );
      writes.push(top);
    },
    onFinish: (completed: boolean) => finished.push(completed),
    now: () => now,
    requestFrame: (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    },
    cancelFrame: () => {
      frames = [];
    },
    setTimer: (callback: () => void) => {
      timer = callback;
      return 1;
    },
    clearTimer: () => {
      timer = null;
    },
    reducedMotion: false,
  };
  return {
    element,
    seams,
    writes,
    finished,
    frame(ms = 16) {
      now += ms;
      const pending = frames;
      frames = [];
      for (const callback of pending) callback(now);
    },
    pendingFrames: () => frames.length,
    fireTimer: () => timer?.(),
  };
}

describe('animateScrollToBottom', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('glides over several frames, never stepping back, and lands on the end', () => {
    const geometry = { scrollTop: 600, scrollHeight: 1_200, clientHeight: 400 };
    const h = harness(geometry);
    animateScrollToBottom(h.element, h.seams);
    const tops: number[] = [];
    while (h.pendingFrames() > 0) {
      h.frame();
      tops.push(geometry.scrollTop);
    }
    const moving = tops.filter((top) => top > 600 && top < 800);
    expect(moving.length, 'intermediate positions').toBeGreaterThan(5);
    for (let index = 1; index < tops.length; index += 1)
      expect(tops[index]).toBeGreaterThanOrEqual(tops[index - 1]);
    // Lands by writing scrollHeight, which the browser clamps to the end.
    expect(h.writes.at(-1)).toBe(1_200);
    expect(geometry.scrollTop).toBe(800);
    expect(h.finished).toEqual([true]);
  });

  test('follows content that grows while it glides', () => {
    const geometry = { scrollTop: 600, scrollHeight: 1_200, clientHeight: 400 };
    const h = harness(geometry);
    animateScrollToBottom(h.element, h.seams);
    h.frame(SCROLL_TO_BOTTOM_DURATION_MS / 2);
    const halfway = geometry.scrollTop;
    // A streamed answer grows the transcript mid-glide.
    geometry.scrollHeight = 1_700;
    h.frame(SCROLL_TO_BOTTOM_DURATION_MS / 4);
    expect(geometry.scrollTop).toBeGreaterThan(800);
    expect(geometry.scrollTop).toBeGreaterThan(halfway);
    while (h.pendingFrames() > 0) h.frame();
    expect(geometry.scrollTop).toBe(1_300);
    expect(h.finished).toEqual([true]);
  });

  test('a long way back jumps to within one viewport, then glides', () => {
    const geometry = { scrollTop: 0, scrollHeight: 5_000, clientHeight: 400 };
    const h = harness(geometry);
    animateScrollToBottom(h.element, h.seams);
    expect(h.writes[0]).toBe(4_600 - 400);
    h.frame();
    expect(geometry.scrollTop).toBeGreaterThan(4_200);
    expect(geometry.scrollTop).toBeLessThan(4_600);
  });

  test('reduced motion lands at once', () => {
    const geometry = { scrollTop: 600, scrollHeight: 1_200, clientHeight: 400 };
    const h = harness(geometry);
    animateScrollToBottom(h.element, { ...h.seams, reducedMotion: true });
    expect(h.writes).toEqual([1_200]);
    expect(h.finished).toEqual([true]);
    expect(h.pendingFrames()).toBe(0);
  });

  test('a cancel stops where it is and reports it', () => {
    const geometry = { scrollTop: 600, scrollHeight: 1_200, clientHeight: 400 };
    const h = harness(geometry);
    const animation = animateScrollToBottom(h.element, h.seams);
    h.frame();
    const stopped = geometry.scrollTop;
    animation.cancel();
    h.frame();
    h.fireTimer();
    expect(geometry.scrollTop).toBe(stopped);
    expect(h.finished).toEqual([false]);
  });

  test('a paused frame loop still ends on the ceiling timer', () => {
    const geometry = { scrollTop: 600, scrollHeight: 1_200, clientHeight: 400 };
    const h = harness(geometry);
    animateScrollToBottom(h.element, h.seams);
    // No frames run (a backgrounded tab): the timer lands it.
    h.fireTimer();
    expect(geometry.scrollTop).toBe(800);
    expect(h.finished).toEqual([true]);
  });

  test('motion follows the reader preference, and is off when it cannot be asked', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(prefersInstantScroll()).toBe(true);
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({ matches: false, media: query })),
    );
    expect(prefersInstantScroll()).toBe(false);
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query === '(prefers-reduced-motion: reduce)',
        media: query,
      })),
    );
    expect(prefersInstantScroll()).toBe(true);
  });
});
