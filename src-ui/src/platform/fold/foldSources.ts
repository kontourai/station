import { hasTauriRuntime } from '../native/index';
import { invokeTauri, listenTauriPlugin } from '../native/tauriInvoke';
import {
  type FoldRect,
  geometryFromNativeSnapshot,
  geometryFromViewportSegments,
  isDefinitiveNativeSnapshot,
  type NativeFoldSnapshot,
  parseNativeFoldSnapshot,
} from './foldGeometry';
import { publishFoldGeometry } from './foldStore';

/** The CSS Viewport Segments and Device Posture APIs, where an engine has them. */
interface FoldWindow {
  innerWidth: number;
  innerHeight: number;
  viewport?: { segments?: readonly FoldRect[] | null };
  addEventListener(type: 'resize', listener: () => void): void;
  removeEventListener(type: 'resize', listener: () => void): void;
}

interface DevicePosture extends EventTarget {
  type?: string;
}

export interface FoldSourceEnvironment {
  window: FoldWindow;
  devicePosture?: DevicePosture | null;
  document?: Pick<Document, 'visibilityState'> & EventTarget;
  hasTauri: () => boolean;
  readNative: () => Promise<unknown>;
  listenNative: (changed: () => void) => Promise<() => void>;
  publish: typeof publishFoldGeometry;
  /** Timers for the follow-up reads; the page's own by default. */
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * When to ask again after install, until a definitive reply arrives (ms after
 * install). A cold launch on an already-folded device answers its first read
 * before UIKit's first hinge update; the plugin pushes the next reading, but
 * a page whose subscription is still registering, or failed, would otherwise
 * keep that first, empty answer for the life of the page. Bounded: four reads
 * over eight seconds, then only events, resizes and visibility.
 */
export const FOLD_FOLLOW_UP_READS_MS = [250, 1000, 3000, 8000] as const;

/**
 * Tauri's rejection when the running shell does not register `station-fold`
 * (desktop, Android, or an iOS build without it): exact messages, not a
 * substring, so a transient plugin error keeps the shell asking.
 */
export function isFoldPluginMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : error;
  return (
    message === 'plugin station-fold not found' ||
    message === 'Command plugin:station-fold|state not found'
  );
}

function defaultEnvironment(): FoldSourceEnvironment {
  return {
    window: window as unknown as FoldWindow,
    devicePosture: (navigator as Navigator & { devicePosture?: DevicePosture })
      .devicePosture,
    document,
    hasTauri: hasTauriRuntime,
    readNative: () => invokeTauri<unknown>('plugin:station-fold|state'),
    listenNative: (changed) =>
      listenTauriPlugin('station-fold', 'change', changed),
    publish: publishFoldGeometry,
  };
}

/**
 * Starts publishing the crease. The native shell wins whenever it answers:
 * once `station-fold` has replied, its reading (including "no crease") is the
 * truth and Viewport Segments are ignored, so the two sources never disagree
 * on screen. Without a native answer (a browser, desktop or Android shell)
 * the segments API decides, and an engine without one publishes nothing.
 */
export function installFoldGeometry(
  environment: FoldSourceEnvironment = defaultEnvironment(),
): () => void {
  const { window: win, devicePosture, document: doc } = environment;
  let native: NativeFoldSnapshot | null = null;
  let disposed = false;
  let unlisten: (() => void) | undefined;
  const setTimer =
    environment.setTimer ?? ((run, ms) => globalThis.setTimeout(run, ms));
  const clearTimer =
    environment.clearTimer ??
    ((handle) =>
      globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
  let followUps: unknown[] = [];
  const stopFollowUps = () => {
    for (const handle of followUps) clearTimer(handle);
    followUps = [];
  };

  const recompute = () => {
    if (disposed) return;
    environment.publish(
      native
        ? geometryFromNativeSnapshot(native, win.innerWidth)
        : geometryFromViewportSegments(
            win.viewport?.segments,
            devicePosture?.type,
          ),
    );
  };

  const accept = (value: unknown) => {
    if (disposed) return;
    const snapshot = parseNativeFoldSnapshot(value);
    // A delayed reply cannot overwrite a newer pushed reading. The same
    // revision is still recomputed: the page's own size may have settled
    // since it was last evaluated (publishing an unchanged crease is a no-op).
    if (!snapshot || (native && snapshot.revision < native.revision)) return;
    native = snapshot;
    if (isDefinitiveNativeSnapshot(snapshot)) stopFollowUps();
    recompute();
  };

  // One native read at a time: a burst of resizes or events collapses into
  // the read in flight plus one trailing read. A shell without the plugin
  // (desktop, Android) answers that definitively, so it is asked no more.
  let reading = false;
  let readAgain = false;
  let unavailable = false;
  const refresh = () => {
    if (disposed || unavailable) return;
    if (reading) {
      readAgain = true;
      return;
    }
    reading = true;
    environment
      .readNative()
      .then(accept, (error: unknown) => {
        // Not the iOS shell: segments decide. Any other failure is transient
        // and the next event, resize or follow-up asks again.
        if (isFoldPluginMissing(error)) {
          unavailable = true;
          stopFollowUps();
        }
      })
      .finally(() => {
        reading = false;
        if (readAgain && !disposed && !unavailable) {
          readAgain = false;
          refresh();
        }
      });
  };

  const visible = () => {
    if (doc?.visibilityState === 'visible') refresh();
  };

  // A resize can move the crease (rotation, a move between displays): read
  // it again in the shell, and recompute either way.
  const resized = () => {
    recompute();
    if (environment.hasTauri()) refresh();
  };

  win.addEventListener('resize', resized);
  devicePosture?.addEventListener('change', recompute);
  if (environment.hasTauri()) {
    doc?.addEventListener('visibilitychange', visible);
    followUps = FOLD_FOLLOW_UP_READS_MS.map((ms) =>
      setTimer(() => {
        if (!disposed) refresh();
      }, ms),
    );
    // Listen before reading, so a change between the two is not lost.
    environment
      .listenNative(refresh)
      .then((registered) => {
        if (disposed) registered();
        else unlisten = registered;
      })
      .catch(() => {})
      .finally(() => {
        if (!disposed) refresh();
      });
  }
  recompute();

  return () => {
    disposed = true;
    stopFollowUps();
    win.removeEventListener('resize', resized);
    devicePosture?.removeEventListener('change', recompute);
    doc?.removeEventListener('visibilitychange', visible);
    unlisten?.();
  };
}
