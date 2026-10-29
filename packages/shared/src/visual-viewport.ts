/**
 * The visual viewport as one shared subscription per window.
 *
 * The chat dock, composer, dialogs, launchers and the document-scoped inset all
 * position against the same geometry. Each used to attach its own `resize` and
 * `scroll` listeners and read the viewport in its own animation frame, so
 * every keyboard animation frame on a phone ran one read, and on Android one
 * synchronous `StationAndroidInsets` bridge call, per mounted surface. This
 * store reads once per frame and hands every subscriber the same snapshot.
 *
 * It lives here rather than in the app because `@kontourai/station-sdk` and
 * `@kontourai/station-connect` render modals against the same CSS variables
 * and cannot import from the app; their copies had already stopped reading the
 * Android visible height. `return-focus.ts` is the precedent for a
 * dependency-free browser module in this package.
 */

export interface VisualViewportMetrics {
  readonly height: number;
  readonly offsetTop: number;
  readonly bottomInset: number;
}

interface StationAndroidInsetsReader {
  safeArea(): string;
}

/** Fired by the Android shell whenever its WindowInsets change. */
export const ANDROID_INSETS_EVENT = 'station-android-insets';

/** The geometry before any window exists (server render). */
export const EMPTY_VISUAL_VIEWPORT: VisualViewportMetrics = Object.freeze({
  height: 0,
  offsetTop: 0,
  bottomInset: 0,
});

/** The Android shell's WindowInsets report, or undefined off Android. */
export function readAndroidInsets(
  target: Window,
): Record<string, unknown> | undefined {
  const bridge = (
    target as Window & { StationAndroidInsets?: StationAndroidInsetsReader }
  ).StationAndroidInsets;
  if (!bridge) return undefined;
  try {
    const value: unknown = JSON.parse(bridge.safeArea());
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Visible height in CSS pixels, measured down from the WebView's top edge on
 * screen — where the visual viewport begins, whatever its page `offsetTop`.
 * An already resized WebView reports its smaller bounds, so callers take the
 * intersection with VisualViewport rather than subtracting IME height twice. */
export function readAndroidVisibleHeight(target: Window): number | undefined {
  const value = readAndroidInsets(target);
  if (!value) return undefined;
  const { viewportWidth, viewportHeight, visibleHeight } = value;
  if (
    [viewportWidth, viewportHeight, visibleHeight].some(
      (n) => typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 16384,
    )
  )
    return undefined;
  const width = viewportWidth as number;
  const height = viewportHeight as number;
  const visible = visibleHeight as number;
  if (width <= 0 || height <= 0 || visible > height || target.innerWidth <= 0)
    return undefined;
  return (visible * target.innerWidth) / width;
}

export function readVisualViewportMetrics(
  target: Window,
): VisualViewportMetrics {
  const viewport = target.visualViewport;
  const offsetTop = Math.max(0, viewport?.offsetTop ?? 0);
  // The native figure is measured from the WebView's top edge ON SCREEN, and
  // the visual viewport always starts at that edge — `offsetTop` places it in
  // the page, not on the glass. Subtracting the pan again counted it twice:
  // with the keyboard open and the page panned to the composer, the chat dock
  // ended a pan's height above the keyboard with the page showing through.
  const nativeVisibleHeight = readAndroidVisibleHeight(target);
  const height = Math.max(
    0,
    Math.min(
      viewport?.height ?? target.innerHeight,
      nativeVisibleHeight ?? Infinity,
    ),
  );
  return {
    height,
    offsetTop,
    // Fixed bottom sheets are positioned against the layout viewport. The
    // visual viewport may end above Android system chrome or the software
    // keyboard, so expose that gap as an explicit inset instead of leaving
    // the dock's controls underneath it.
    bottomInset: Math.max(0, target.innerHeight - (offsetTop + height)),
  };
}

export interface VisualViewportStore {
  /** Calls `listener` after a frame in which the geometry changed. */
  subscribe(listener: () => void): () => void;
  /** The current geometry; the same object until it changes. */
  getSnapshot(): VisualViewportMetrics;
}

function sameMetrics(a: VisualViewportMetrics, b: VisualViewportMetrics) {
  return (
    a.height === b.height &&
    a.offsetTop === b.offsetTop &&
    a.bottomInset === b.bottomInset
  );
}

function createVisualViewportStore(target: Window): VisualViewportStore {
  const listeners = new Set<() => void>();
  let snapshot: VisualViewportMetrics | undefined;
  let pending = false;
  let frame = 0;
  let detach: (() => void) | undefined;

  const refresh = (): boolean => {
    const next = readVisualViewportMetrics(target);
    if (snapshot && sameMetrics(snapshot, next)) return false;
    snapshot = next;
    return true;
  };
  const flush = () => {
    pending = false;
    if (refresh()) for (const listener of [...listeners]) listener();
  };
  // One read per frame however many events (and subscribers) arrive in it.
  const schedule = () => {
    if (pending) return;
    pending = true;
    if (target.requestAnimationFrame)
      frame = target.requestAnimationFrame(flush);
    else flush();
  };
  const attach = () => {
    const viewport = target.visualViewport;
    const source: EventTarget = viewport ?? target;
    source.addEventListener('resize', schedule);
    viewport?.addEventListener('scroll', schedule);
    target.addEventListener(ANDROID_INSETS_EVENT, schedule);
    // Unwatched, the snapshot may be stale; the frame read settles anything
    // layout had still to apply when the first subscriber mounted.
    refresh();
    schedule();
    return () => {
      if (pending) target.cancelAnimationFrame?.(frame);
      pending = false;
      source.removeEventListener('resize', schedule);
      viewport?.removeEventListener('scroll', schedule);
      target.removeEventListener(ANDROID_INSETS_EVENT, schedule);
    };
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      detach ??= attach();
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        detach?.();
        detach = undefined;
      };
    },
    getSnapshot() {
      // A watched snapshot is kept current by events; an unwatched one is
      // read on demand, so a render never pays a bridge call it can skip.
      if (!snapshot || !detach) refresh();
      return snapshot as VisualViewportMetrics;
    },
  };
}

const stores = new WeakMap<Window, VisualViewportStore>();

export function visualViewportStore(target: Window): VisualViewportStore {
  let store = stores.get(target);
  if (!store) {
    store = createVisualViewportStore(target);
    stores.set(target, store);
  }
  return store;
}

/** `useSyncExternalStore` arguments for this window's geometry. */
export function subscribeVisualViewport(listener: () => void): () => void {
  return visualViewportStore(window).subscribe(listener);
}

export function visualViewportSnapshot(): VisualViewportMetrics {
  return visualViewportStore(window).getSnapshot();
}

export function serverVisualViewportSnapshot(): VisualViewportMetrics {
  return EMPTY_VISUAL_VIEWPORT;
}

/** The geometry as the `--responsive-visual-viewport-*` custom properties. */
export function responsiveVisualViewportStyle(
  metrics: VisualViewportMetrics,
): Record<string, string> {
  return {
    '--responsive-visual-viewport-height': `${metrics.height}px`,
    '--responsive-visual-viewport-top': `${metrics.offsetTop}px`,
    '--responsive-visual-viewport-bottom': `${metrics.bottomInset}px`,
  };
}
