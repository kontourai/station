import { hasTauriRuntime } from '../native/index';
import { invokeTauri, listenTauriPlugin } from '../native/tauriInvoke';
import {
  type FoldRect,
  geometryFromNativeSnapshot,
  geometryFromViewportSegments,
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

  const recompute = () => {
    if (disposed) return;
    environment.publish(
      native
        ? geometryFromNativeSnapshot(native, win.innerWidth, win.innerHeight)
        : geometryFromViewportSegments(
            win.viewport?.segments,
            devicePosture?.type,
          ),
    );
  };

  const accept = (value: unknown) => {
    if (disposed) return;
    const snapshot = parseNativeFoldSnapshot(value);
    // A delayed reply cannot overwrite a newer pushed reading.
    if (!snapshot || (native && snapshot.revision <= native.revision)) return;
    native = snapshot;
    recompute();
  };

  const refresh = () => {
    environment.readNative().then(accept, () => {
      // Not the iOS shell (or a shell without the plugin): segments decide.
    });
  };

  const visible = () => {
    if (doc?.visibilityState === 'visible') refresh();
  };

  win.addEventListener('resize', recompute);
  devicePosture?.addEventListener('change', recompute);
  if (environment.hasTauri()) {
    doc?.addEventListener('visibilitychange', visible);
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
    win.removeEventListener('resize', recompute);
    devicePosture?.removeEventListener('change', recompute);
    doc?.removeEventListener('visibilitychange', visible);
    unlisten?.();
  };
}
