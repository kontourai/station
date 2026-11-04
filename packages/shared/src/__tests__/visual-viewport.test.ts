import { describe, expect, test, vi } from 'vitest';
import {
  ANDROID_INSETS_EVENT,
  readVisualViewportMetrics,
  visualViewportStore,
} from '../visual-viewport';

describe('mobile chat visual viewport', () => {
  test('uses the visual viewport instead of layout viewport while the keyboard is open', () => {
    const target = {
      innerHeight: 844,
      visualViewport: { height: 493, offsetTop: 8 },
    } as unknown as Window;
    expect(readVisualViewportMetrics(target)).toEqual({
      height: 493,
      offsetTop: 8,
      bottomInset: 343,
    });
  });

  test('falls back to the layout viewport', () => {
    expect(
      readVisualViewportMetrics({ innerHeight: 568 } as unknown as Window),
    ).toEqual({ height: 568, offsetTop: 0, bottomInset: 0 });
  });

  test.each([
    {
      innerHeight: 915,
      viewportHeight: 915,
      visibleHeight: 578,
      expectedHeight: 578,
      inset: 337,
    },
    {
      innerHeight: 578,
      viewportHeight: 578,
      visibleHeight: 578,
      expectedHeight: 578,
      inset: 0,
    },
    {
      innerHeight: 915,
      viewportHeight: 915,
      visibleHeight: 915,
      expectedHeight: 915,
      inset: 0,
    },
  ])(
    'intersects native visible bounds without double keyboard subtraction: $inset',
    ({ innerHeight, viewportHeight, visibleHeight, expectedHeight, inset }) => {
      const target = {
        innerWidth: 412,
        innerHeight,
        visualViewport: { height: innerHeight, offsetTop: 0 },
        StationAndroidInsets: {
          safeArea: () =>
            JSON.stringify({
              viewportWidth: 412,
              viewportHeight,
              visibleHeight,
            }),
        },
      } as unknown as Window;
      expect(readVisualViewportMetrics(target)).toEqual({
        height: expectedHeight,
        offsetTop: 0,
        bottomInset: inset,
      });
    },
  );

  test('native dimensions scale to CSS pixels and honor a panned visual viewport', () => {
    const target = {
      innerWidth: 412,
      innerHeight: 915,
      visualViewport: { height: 500, offsetTop: 8 },
      StationAndroidInsets: {
        safeArea: () =>
          JSON.stringify({
            viewportWidth: 824,
            viewportHeight: 1830,
            visibleHeight: 1000,
          }),
      },
    } as unknown as Window;
    // 1000 device px at 2x is 500 CSS px of glass below the WebView's top
    // edge. The 8px pan moves which page rows fill that glass, not how much of
    // it is visible, so the height is 500, not 500 - 8.
    expect(readVisualViewportMetrics(target)).toEqual({
      height: 500,
      offsetTop: 8,
      bottomInset: 407,
    });
  });

  test('a keyboard pan over an unresized WebView leaves the dock flush with the keyboard', () => {
    // The phone case: the WebView keeps its full 915px layout, the IME covers
    // 337px, and the visual viewport (578px) pans 300px down the page to
    // bring the composer into view. The dock must span exactly the 578px of
    // glass above the keyboard; the old reader subtracted the pan again
    // (278px) and left a 300px band of page between dock and keyboard.
    const target = {
      innerWidth: 412,
      innerHeight: 915,
      visualViewport: { height: 578, offsetTop: 300 },
      StationAndroidInsets: {
        safeArea: () =>
          JSON.stringify({
            viewportWidth: 412,
            viewportHeight: 915,
            visibleHeight: 578,
          }),
      },
    } as unknown as Window;
    expect(readVisualViewportMetrics(target)).toEqual({
      height: 578,
      offsetTop: 300,
      bottomInset: 37,
    });
  });

  test.each([
    '{}',
    'bad json',
    '{"viewportWidth":0,"viewportHeight":915,"visibleHeight":400}',
    '{"viewportWidth":412,"viewportHeight":915,"visibleHeight":-1}',
    '{"viewportWidth":412,"viewportHeight":915,"visibleHeight":916}',
  ])('ignores invalid or legacy native geometry: %s', (json) => {
    expect(
      readVisualViewportMetrics({
        innerWidth: 412,
        innerHeight: 915,
        StationAndroidInsets: { safeArea: () => json },
      } as unknown as Window),
    ).toEqual({ height: 915, offsetTop: 0, bottomInset: 0 });
  });
});

/** A phone window whose frames run only when the test flushes them. */
function phoneWindow() {
  const listeners = new Map<string, Set<() => void>>();
  const eventTarget = () => ({
    addEventListener: (type: string, listener: () => void) => {
      const bucket = listeners.get(type) ?? new Set();
      bucket.add(listener);
      listeners.set(type, bucket);
    },
    removeEventListener: (type: string, listener: () => void) => {
      listeners.get(type)?.delete(listener);
    },
  });
  let frames = new Map<number, () => void>();
  let nextFrame = 1;
  const native = {
    viewportWidth: 412,
    viewportHeight: 915,
    visibleHeight: 915,
  };
  const safeArea = vi.fn(() => JSON.stringify(native));
  const target = {
    innerWidth: 412,
    innerHeight: 915,
    visualViewport: { height: 915, offsetTop: 0, ...eventTarget() },
    StationAndroidInsets: { safeArea },
    requestAnimationFrame: (callback: () => void) => {
      frames.set(nextFrame, callback);
      return nextFrame++;
    },
    cancelAnimationFrame: (frame: number) => {
      frames.delete(frame);
    },
    ...eventTarget(),
  };
  return {
    target: target as unknown as Window,
    native,
    safeArea,
    fire: (type: string) => {
      for (const listener of [...(listeners.get(type) ?? [])]) listener();
    },
    listenerCount: () =>
      [...listeners.values()].reduce((sum, bucket) => sum + bucket.size, 0),
    pendingFrames: () => frames.size,
    flushFrame: () => {
      const due = frames;
      frames = new Map();
      for (const callback of due.values()) callback();
    },
  };
}

describe('visualViewportStore', () => {
  test('reads once per frame for every subscriber and hands them one snapshot', () => {
    const phone = phoneWindow();
    const store = visualViewportStore(phone.target);
    const seen: unknown[] = [];
    const subscribers = Array.from({ length: 6 }, () => vi.fn());
    const unsubscribe = subscribers.map((listener) =>
      store.subscribe(() => {
        listener();
        seen.push(store.getSnapshot());
      }),
    );
    // One set of listeners for all six surfaces, not six.
    expect(phone.listenerCount()).toBe(3);
    phone.flushFrame();
    phone.safeArea.mockClear();

    // A keyboard animation frame delivers several events.
    phone.native.visibleHeight = 578;
    phone.fire('resize');
    phone.fire('scroll');
    phone.fire(ANDROID_INSETS_EVENT);
    expect(phone.pendingFrames()).toBe(1);
    phone.flushFrame();

    expect(phone.safeArea).toHaveBeenCalledTimes(1);
    for (const listener of subscribers) expect(listener).toHaveBeenCalledOnce();
    expect(new Set(seen).size).toBe(1);
    expect(store.getSnapshot()).toEqual({
      height: 578,
      offsetTop: 0,
      bottomInset: 337,
    });
    for (const stop of unsubscribe) stop();
  });

  test('keeps the same snapshot and stays quiet when a frame changes nothing', () => {
    const phone = phoneWindow();
    const store = visualViewportStore(phone.target);
    const listener = vi.fn();
    const stop = store.subscribe(listener);
    phone.flushFrame();
    const before = store.getSnapshot();
    listener.mockClear();

    phone.fire('scroll');
    phone.flushFrame();
    expect(listener).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toBe(before);
    // A watched render reads the cached snapshot, never the bridge.
    phone.safeArea.mockClear();
    store.getSnapshot();
    expect(phone.safeArea).not.toHaveBeenCalled();
    stop();
  });

  test('detaches with its last subscriber and reads on demand while unwatched', () => {
    const phone = phoneWindow();
    const store = visualViewportStore(phone.target);
    const first = store.subscribe(() => {});
    const second = store.subscribe(() => {});
    first();
    expect(phone.listenerCount()).toBe(3);
    second();
    expect(phone.listenerCount()).toBe(0);
    // The frame the first subscriber scheduled is cancelled, not left running.
    expect(phone.pendingFrames()).toBe(0);

    phone.native.visibleHeight = 600;
    expect(store.getSnapshot().height).toBe(600);
  });

  test('is one store per window', () => {
    const phone = phoneWindow();
    expect(visualViewportStore(phone.target)).toBe(
      visualViewportStore(phone.target),
    );
    expect(visualViewportStore(phone.target)).not.toBe(
      visualViewportStore(phoneWindow().target),
    );
  });
});
