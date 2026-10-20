/**
 * Glides a transcript scroller to its newest content.
 *
 * Native `scrollTo({ behavior: 'smooth' })` cannot be used here: its frames
 * are indistinguishable from reader movement to the transcript's scroll
 * handler, and its fixed target goes stale while a live turn keeps growing
 * the content. This animator instead writes every frame through the caller's
 * `write` (so the transcript records each write as its own echo) and aims
 * every frame at the CURRENT end, so content that grows mid-animation is
 * followed rather than overshot or undershot.
 *
 * The caller owns intent: it keeps the transcript out of tail-follow while
 * the animation runs and hands back to follow in `onFinish`.
 */

export interface ScrollToBottomAnimation {
  /** Stops the animation where it is; `onFinish` reports `false`. */
  cancel(): void;
}

export interface AnimateScrollToBottomOptions {
  /** Writes one programmatic scroll position. */
  write: (top: number) => void;
  /** Called exactly once: `true` when it reached the end, `false` if cancelled. */
  onFinish?: (completed: boolean) => void;
  durationMs?: number;
  /** Hard ceiling, enforced by a timer so a paused frame loop still ends. */
  maxDurationMs?: number;
  /** A distance above this many viewports first jumps to one viewport away. */
  jumpViewports?: number;
  /** Test seams; default to the window's clock, frames and timers. */
  now?: () => number;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Defaults to the reader's `prefers-reduced-motion` preference. */
  reducedMotion?: boolean;
}

export const SCROLL_TO_BOTTOM_DURATION_MS = 300;
const SCROLL_TO_BOTTOM_MAX_DURATION_MS = 450;
const SCROLL_TO_BOTTOM_JUMP_VIEWPORTS = 1.5;

/**
 * Motion is opt-in by capability: an environment that cannot answer the
 * reduced-motion query (no `matchMedia`) gets the instant jump.
 */
export function prefersInstantScroll(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function')
    return true;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function easeOutCubic(progress: number) {
  return 1 - (1 - progress) ** 3;
}

export function animateScrollToBottom(
  element: HTMLElement,
  {
    write,
    onFinish,
    durationMs = SCROLL_TO_BOTTOM_DURATION_MS,
    maxDurationMs = SCROLL_TO_BOTTOM_MAX_DURATION_MS,
    jumpViewports = SCROLL_TO_BOTTOM_JUMP_VIEWPORTS,
    now = () => performance.now(),
    requestFrame = (callback) => requestAnimationFrame(callback),
    cancelFrame = (handle) => cancelAnimationFrame(handle),
    setTimer = (callback, ms) => setTimeout(callback, ms),
    clearTimer = (handle) => clearTimeout(handle as number),
    reducedMotion = prefersInstantScroll(),
  }: AnimateScrollToBottomOptions,
): ScrollToBottomAnimation {
  const end = () => Math.max(0, element.scrollHeight - element.clientHeight);
  let finished = false;
  let frame: number | undefined;
  let timer: unknown;
  const finish = (completed: boolean) => {
    if (finished) return;
    finished = true;
    if (frame !== undefined) cancelFrame(frame);
    if (timer !== undefined) clearTimer(timer);
    // Land on scrollHeight, not the computed end: the browser clamps it, so a
    // sub-pixel end can never leave the reader a pixel short of the newest row.
    if (completed) write(element.scrollHeight);
    onFinish?.(completed);
  };
  const controller = { cancel: () => finish(false) };

  if (reducedMotion || end() - element.scrollTop <= 1) {
    finish(true);
    return controller;
  }
  // A long way back reads as a slow scroll through history. Jump to within
  // one viewport of the end and glide only the last stretch.
  if (end() - element.scrollTop > jumpViewports * element.clientHeight) {
    write(end() - element.clientHeight);
  }
  const from = element.scrollTop;
  const startedAt = now();
  let reached = from;
  const step = () => {
    frame = undefined;
    if (finished) return;
    const progress = Math.min(1, (now() - startedAt) / durationMs);
    if (progress >= 1) return finish(true);
    // Aim at the end as it is NOW, and never step backwards when content
    // shrank under the animation.
    const target = end();
    const top = Math.min(
      target,
      Math.max(reached, from + (target - from) * easeOutCubic(progress)),
    );
    reached = top;
    write(top);
    frame = requestFrame(step);
  };
  timer = setTimer(() => finish(true), maxDurationMs);
  frame = requestFrame(step);
  return controller;
}
