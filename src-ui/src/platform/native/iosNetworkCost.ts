import { hasTauriRuntime } from './index';
import { invokeTauri, listenTauri } from './tauriInvoke';

interface PathSnapshot {
  revision: number;
  constrained: boolean;
  expensive: boolean;
}

let snapshot: PathSnapshot | undefined;
const listeners = new Set<() => void>();
let stop: (() => void) | undefined;

export function iosNetworkConstrained(): boolean {
  return snapshot?.constrained === true || snapshot?.expensive === true;
}

function observe(changed: () => void): () => void {
  let disposed = false;
  let unlisten: (() => void) | undefined;
  const accept = (value: unknown) => {
    if (disposed || value === null || typeof value !== 'object') return;
    const path = value as Partial<PathSnapshot>;
    if (
      !Number.isSafeInteger(path.revision) ||
      typeof path.revision !== 'number' ||
      path.revision < 1 ||
      typeof path.constrained !== 'boolean' ||
      typeof path.expensive !== 'boolean' ||
      (snapshot !== undefined && path.revision <= snapshot.revision)
    )
      return;
    snapshot = {
      revision: path.revision,
      constrained: path.constrained,
      expensive: path.expensive,
    };
    changed();
  };
  // Listen before reading: a delayed command reply cannot overwrite a newer
  // event. The host retains the first observation before the WebView subscribes.
  void listenTauri<unknown>('station://network-path', accept)
    .then(async (registered) => {
      if (disposed) {
        registered();
        return;
      }
      unlisten = registered;
      accept(await invokeTauri<unknown>('station_native_network_path'));
    })
    .catch(() => {
      // Missing observation leaves the existing optional-polling policy intact.
    });
  return () => {
    disposed = true;
    unlisten?.();
  };
}

export function subscribeIosNetworkCost(changed: () => void): () => void {
  listeners.add(changed);
  if (listeners.size === 1 && hasTauriRuntime()) {
    stop = observe(() => {
      for (const listener of listeners) listener();
    });
  }
  return () => {
    listeners.delete(changed);
    if (listeners.size === 0) {
      stop?.();
      stop = undefined;
      snapshot = undefined;
    }
  };
}
