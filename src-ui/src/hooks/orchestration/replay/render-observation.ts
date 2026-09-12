/** Browser observation is distinct from the synchronous event fold. */
export interface ReplayRenderMeasurement {
  phase: 'not-mounted' | 'observed' | 'observation-timeout';
  waitMs: number;
  domMutations: number;
  mountedRows: number;
}

export async function waitForReplayRender(
  element: () => HTMLElement | null,
): Promise<ReplayRenderMeasurement> {
  const start = performance.now();
  let mutations = 0;
  let observer: MutationObserver | undefined;
  let observedElement: HTMLElement | null = null;
  let lastMutation = start;
  const observe = () => {
    const next = element();
    if (next === observedElement) return;
    observer?.disconnect();
    observedElement = next;
    if (next && typeof MutationObserver !== 'undefined') {
      observer = new MutationObserver((records) => {
        mutations += records.length;
        lastMutation = performance.now();
      });
      observer.observe(next, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
    }
  };
  // Live text batching is 80 ms. Observe beyond that flush, then allow two
  // quiet observation intervals. This measures the mounted result, not React CPU duration.
  const deadline = start + 1_500;
  let quietFrames = 0;
  try {
    while (performance.now() < deadline && quietFrames < 2) {
      observe();
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      const now = performance.now();
      const animating =
        element()
          ?.getAnimations?.({ subtree: true })
          .some(
            (animation) =>
              animation.playState === 'running' &&
              Number.isFinite(animation.effect?.getComputedTiming().endTime),
          ) ?? false;
      quietFrames =
        observedElement &&
        !animating &&
        now - start >= 120 &&
        now - lastMutation >= 40
          ? quietFrames + 1
          : 0;
    }
    observe();
    const renderedElement = element();
    return {
      phase: !renderedElement
        ? 'not-mounted'
        : quietFrames < 2
          ? 'observation-timeout'
          : 'observed',
      waitMs: performance.now() - start,
      domMutations: mutations,
      mountedRows:
        renderedElement?.querySelectorAll('[data-chat-message-key]').length ??
        0,
    };
  } finally {
    observer?.disconnect();
  }
}
