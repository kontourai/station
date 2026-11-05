import { hasTauriRuntime, nativePlatformPromise } from '../native/index';
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
  /**
   * Whether this shell registers `station-fold` (only the iOS app does).
   * Desktop and Android refuse the command at the ACL before any plugin runs,
   * so they are never asked.
   */
  nativeFoldSupported: () => Promise<boolean>;
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

/** The iOS app is the one shell with `station-fold`, per its capability report. */
export async function iosShell(): Promise<boolean> {
  if (!hasTauriRuntime()) return false;
  try {
    const adapter = await nativePlatformPromise;
    if (adapter.platform !== 'tauri') return false;
    const report = await adapter.getCapabilityReport();
    return report.status === 'ok' && report.value.platform === 'ios';
  } catch {
    return false;
  }
}

function defaultEnvironment(): FoldSourceEnvironment {
  return {
    window: window as unknown as FoldWindow,
    devicePosture: (navigator as Navigator & { devicePosture?: DevicePosture })
      .devicePosture,
    document,
    nativeFoldSupported: iosShell,
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
  let nativeActive = false;
  const refresh = () => {
    if (disposed || !nativeActive) return;
    if (reading) {
      readAgain = true;
      return;
    }
    reading = true;
    environment
      .readNative()
      .then(accept, () => {
        // Transient (the iOS plugin still initializing): the next event,
        // resize or follow-up asks again.
      })
      .finally(() => {
        reading = false;
        if (readAgain && !disposed) {
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
    refresh();
  };

  win.addEventListener('resize', resized);
  devicePosture?.addEventListener('change', recompute);
  const startNative = () => {
    if (disposed) return;
    nativeActive = true;
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
  };
  void environment
    .nativeFoldSupported()
    .then((supported) => {
      if (supported) startNative();
    })
    .catch(() => {});
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
