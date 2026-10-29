import {
  LIVE_SURFACE_DEFAULT_STREAM_PARAMS,
  type LiveSurfaceStreamParams,
} from '@kontourai/station-contracts/live-surface';
import { type RefObject, useLayoutEffect, useState } from 'react';

/**
 * What a live surface asks the host for, fitted to the device showing it.
 *
 * A pane asked for its fixed default (up to 1600px at 15 fps for a device) on
 * every screen and connection. A phone's pane is about 1200 device pixels
 * wide, so most of each frame was decoded only to be scaled down, and on a
 * metered or data-saving connection it streamed at full rate regardless.
 */

/** Pixel budgets move in these steps, so a resize reconnects the stream only
 * when it crosses one (a rotation, a pane opening beside it), never per frame. */
export const LIVE_SURFACE_PIXEL_STEP = 320;

/** On a metered or data-saving connection: a third of the frames, at lower quality. */
const CONSTRAINED = { maxFps: 5, quality: 50, maxWidth: 960, maxHeight: 960 };

export interface LiveSurfacePixelBox {
  readonly width: number;
  readonly height: number;
}

export function liveSurfaceStreamBudget(
  requested: Partial<LiveSurfaceStreamParams> | undefined,
  options: { constrained: boolean; pixels: LiveSurfacePixelBox | null },
): Partial<LiveSurfaceStreamParams> | undefined {
  if (!options.constrained && !options.pixels) return requested;
  const wanted = { ...LIVE_SURFACE_DEFAULT_STREAM_PARAMS, ...requested };
  const ceiling = options.constrained
    ? CONSTRAINED
    : { maxFps: wanted.maxFps, quality: wanted.quality };
  return {
    ...requested,
    maxFps: Math.min(wanted.maxFps, ceiling.maxFps),
    quality: Math.min(wanted.quality, ceiling.quality),
    maxWidth: Math.min(
      wanted.maxWidth,
      options.pixels?.width ?? Infinity,
      options.constrained ? CONSTRAINED.maxWidth : Infinity,
    ),
    maxHeight: Math.min(
      wanted.maxHeight,
      options.pixels?.height ?? Infinity,
      options.constrained ? CONSTRAINED.maxHeight : Infinity,
    ),
  };
}

function stepUp(cssPixels: number, ratio: number): number {
  return (
    Math.ceil((cssPixels * ratio) / LIVE_SURFACE_PIXEL_STEP) *
    LIVE_SURFACE_PIXEL_STEP
  );
}

/**
 * The element's size in device pixels, rounded up to the step. `measured`
 * turns true at mount (before paint) so a stream can wait for it and open
 * once at the fitted size; `box` stays null where nothing can be measured (a
 * pane with no layout yet, or no ResizeObserver), which asks for the default.
 */
export function useSteppedPixelBox(ref: RefObject<Element | null>): {
  measured: boolean;
  box: LiveSurfacePixelBox | null;
} {
  const [state, setState] = useState(() => ({
    measured: typeof ResizeObserver === 'undefined',
    box: null as LiveSurfacePixelBox | null,
  }));
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') {
      setState((current) =>
        current.measured ? current : { measured: true, box: null },
      );
      return;
    }
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      const box =
        width > 0 && height > 0
          ? { width: stepUp(width, ratio), height: stepUp(height, ratio) }
          : null;
      // A hidden pane measures nothing: keep the size it last had.
      setState((current) => {
        if (!box)
          return current.measured ? current : { ...current, measured: true };
        return current.measured &&
          current.box?.width === box.width &&
          current.box.height === box.height
          ? current
          : { measured: true, box };
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [ref]);
  return state;
}
