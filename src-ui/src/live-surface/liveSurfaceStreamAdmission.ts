/**
 * Frame-stream admission per Station origin (#2760, ADR 0018).
 *
 * Every visible live surface holds one long-lived frame stream. A browser
 * speaking HTTP/1.1 gives an origin about six connections, and the two
 * always-on event streams already hold two. Unbounded, four visible
 * surfaces would fill the pool, and a human's input or lease POST would
 * queue behind streams that never end: the pointer goes dead exactly when
 * someone reaches in to stop an agent.
 *
 * So an origin admits at most `LIVE_SURFACE_FRAME_STREAMS_PER_ORIGIN` frame
 * streams at once. With the two always-on streams that leaves two
 * connections: one for input and lease requests, and one for a view-scoped
 * event stream. A surface past the cap waits, shown as `queued`, and is
 * admitted in arrival order when another stream ends (hidden, unmounted,
 * closed, or between reconnect attempts). Nothing polls; a waiter is woken
 * by a release.
 *
 * Origins are counted apart. Admission only counts streams; it never shares
 * or reuses one, so nothing crosses a credential or Project context. A
 * transport that does not use the browser's pool (a native or relay
 * transport) is capped too; that costs at most a queued third surface,
 * never input.
 */

/** Frame streams one origin may hold at once. */
export const LIVE_SURFACE_FRAME_STREAMS_PER_ORIGIN = 2;

export interface LiveSurfaceStreamAdmission {
  /**
   * Wait for a frame-stream slot on `url`'s origin. Resolves a release
   * function (call it when the stream ends; later calls are no-ops), or
   * null when `signal` aborted first; an aborted waiter never takes a slot.
   * `onQueued` runs when no slot is free at once.
   */
  admit(
    url: string,
    signal: AbortSignal,
    onQueued?: () => void,
  ): Promise<(() => void) | null>;
}

interface OriginSlots {
  active: number;
  waiting: (() => void)[];
}

export function createLiveSurfaceStreamAdmission(
  limit = LIVE_SURFACE_FRAME_STREAMS_PER_ORIGIN,
): LiveSurfaceStreamAdmission {
  const origins = new Map<string, OriginSlots>();
  const keyOf = (url: string) => {
    try {
      return new URL(url, globalThis.location?.href).origin;
    } catch {
      return url;
    }
  };
  return {
    admit(url, signal, onQueued) {
      const key = keyOf(url);
      let slots = origins.get(key);
      if (!slots) {
        slots = { active: 0, waiting: [] };
        origins.set(key, slots);
      }
      const own = slots;
      const release = () => {
        let released = false;
        return () => {
          if (released) return;
          released = true;
          own.active -= 1;
          own.waiting.shift()?.();
          if (own.active === 0 && own.waiting.length === 0) origins.delete(key);
        };
      };
      if (signal.aborted) return Promise.resolve(null);
      if (own.active < limit) {
        own.active += 1;
        return Promise.resolve(release());
      }
      return new Promise((resolve) => {
        const wake = () => {
          signal.removeEventListener('abort', onAbort);
          own.active += 1;
          resolve(release());
        };
        const onAbort = () => {
          const at = own.waiting.indexOf(wake);
          if (at >= 0) own.waiting.splice(at, 1);
          if (own.active === 0 && own.waiting.length === 0) origins.delete(key);
          resolve(null);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        own.waiting.push(wake);
        onQueued?.();
      });
    },
  };
}

/** The page-wide admission every live surface shares. */
export const liveSurfaceStreamAdmission = createLiveSurfaceStreamAdmission();
